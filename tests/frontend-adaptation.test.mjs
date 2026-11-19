import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {mediaCapabilities,modelMediaSummary,mediaLimitError,supportsImageMarks} from '../public/core.mjs';
import {canvasMediaError} from '../public/canvas-core.mjs';
import {toolAvailability,batchIsActive,batchProgressText} from '../public/relay-ui-state.mjs';

const model={id:'main-video-valid',name:'批准的线路名称',type:'video',billing_mode:'relay',max_images:30,max_videos:3,max_audios:3,max_media_total:20};
const media=(images,videos=0,audios=0)=>[['image',images],['video',videos],['audio',audios]].flatMap(([kind,count])=>Array.from({length:count},()=>({kind})));
test('declared 30 images remains usable while shared effective cap stays at 20, including legacy catalogues',()=>{
  for(const line of [model,{...model,max_media_total:undefined},{...model,max_media_files:20}]){
    assert.equal(mediaCapabilities(line).image,30);assert.equal(mediaCapabilities(line).total,20);
    assert.equal(mediaLimitError(line,media(1)),'');assert.equal(mediaLimitError(line,media(20)),'');
    assert.match(mediaLimitError(line,media(21)),/素材总数最多20个/);
    assert.equal(mediaLimitError(line,media(17,2,1)),'');assert.match(mediaLimitError(line,media(18,2,1)),/素材总数最多20个/);
    assert.match(modelMediaSummary(line),/^20图.*合计最多 20 个/);
    for(const count of [1,20,21])assert.equal(canvasMediaError(line,media(count).map(asset=>({asset}))),mediaLimitError(line,media(count)));
  }
});
test('all eight anonymous published catalogue samples share main/canvas effective count rules',()=>{
  const sample=JSON.parse(fs.readFileSync(new URL('./fixtures/pikno-public-catalog-20261018.json',import.meta.url),'utf8'));
  assert.equal(sample.internal_fixture,true);assert.equal(sample.models.length,8);
  for(const raw of sample.models){
    const line={...raw,id:'main-'+raw.kind+'-sample',type:raw.kind,billing_mode:'relay',max_audios:raw.max_audio};
    for(const refs of [media(0),media(1),media(20),media(21),media(1,1,1),media(15,5,1)])assert.equal(canvasMediaError(line,refs.map(asset=>({asset}))),mediaLimitError(line,refs));
    if(raw.max_images===30){assert.equal(mediaLimitError(line,media(1)),'');assert.equal(mediaLimitError(line,media(20)),'');assert.match(mediaLimitError(line,media(21)),/素材总数最多20个/);}
  }
});
test('single-image capability disables marks without disabling one-image text editing',()=>{
  const line={...model,type:'image',max_images:1};assert.equal(supportsImageMarks(line),false);
  assert.equal(mediaLimitError(line,media(1)),'');assert.match(mediaLimitError(line,media(2)),/最多支持1个图片/);
  assert.equal(supportsImageMarks({...line,max_images:2}),true);
});
test('tool preflight exposes distinct safe states shared by canvas and main',()=>{
  const ready={configured:true,catalogReady:true,connection:{state:'ready'},model:{id:'tool-digital'}};
  for(const [options,state] of [[{configured:false},'unconfigured'],[{checking:true},'checking'],[{lineState:'forbidden'},'forbidden'],[{lineState:'unpublished'},'unpublished'],[{connection:{state:'error'}},'error'],[{},'ready']]){
    const result=toolAvailability({...ready,...options});assert.equal(result.state,state);assert.doesNotMatch(result.message,/https?:|sk-|\/v1\//);
  }
});

const source=fs.readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
const first=source.indexOf('let syncingBatches='),last=source.indexOf('// The UI reads the local journal',first);
function batchFixture(){
  const id='b'.repeat(32),calls=[],toasts=[],panel={hidden:true,innerHTML:'',querySelectorAll:()=>[]},state={relayMode:true,batches:[]};
  let batch={id,requestId:'original-local-request',status:'running',quantity:4,submitted:1,remaining:3},stopFails=false;
  const context={state,relayConfigRevision:1,batchIsActive,batchProgressText,escapeHtml:value=>String(value),$ :()=>panel,settleQuotedSubmissions(){},refreshQuoteAvailability(){},syncTasks:async()=>{},toast:value=>toasts.push(value),request:async(path,options={})=>{calls.push({path,options});if(options.method==='POST'){if(stopFails)throw Error('synthetic');batch={...batch,status:'stopped',stopped:{submitted:1,total:4}};return {batch};}return {batches:[batch]};}};
  vm.createContext(context);vm.runInContext(source.slice(first,last),context);return {id,context,calls,toasts,state,panel,failStop:()=>{stopFails=true;}};
}
test('refresh recovers active batch using GET only; explicit stop uses only its control endpoint',async()=>{
  const f=batchFixture();await f.context.syncRelayBatches();assert.equal(f.calls[0].options.method,undefined);assert.equal(f.panel.hidden,false);assert.match(f.panel.innerHTML,/停止剩余份数/);
  await f.context.stopRelayBatch(f.id);assert.deepEqual(f.calls.map(c=>c.path),['/relay/batches',`/relay/batches/${f.id}/stop`]);assert.equal(batchIsActive(f.state.batches[0]),false);assert.match(f.toasts.at(-1),/已发送任务继续查询原结果/);assert.doesNotMatch(f.toasts.at(-1),/取消|退款/);
  await f.context.syncRelayBatches();assert.equal(f.calls.filter(c=>c.options.method==='POST').length,1);assert.ok(f.calls.every(c=>!['/images','/videos'].includes(c.path)));
});
test('unknown stop result preserves batch and instructs querying original instead of resending generation',async()=>{
  const f=batchFixture();await f.context.syncRelayBatches();f.failStop();await f.context.stopRelayBatch(f.id);assert.equal(batchIsActive(f.state.batches[0]),true);assert.match(f.toasts.at(-1),/重新查询原批次，勿再次生成/);assert.equal(f.calls.length,2);
});
test('all active batches retain stop controls even when more than six batches exist',()=>{
  const f=batchFixture();f.state.batches=Array.from({length:8},(_,index)=>({id:String(index).repeat(32),status:'running',quantity:4,submitted:1,remaining:3}));f.context.renderBatchControls();assert.equal((f.panel.innerHTML.match(/data-stop-relay-batch/g)||[]).length,8);
});
test('single-reference image editor ignores pointer drawing before any stroke is created',()=>{
  const begin=source.indexOf('function imageEditPointerDown(event)'),end=source.indexOf('function imageEditPointerMove(event)',begin),imageEdit={blob:{},active:null,busy:false};
  const context={imageEdit,supportsImageMarks,imageModels:()=>[{id:'single',type:'image',max_images:1,billing_mode:'relay'}],$:()=>({value:'single'})};vm.createContext(context);vm.runInContext(source.slice(begin,end),context);
  context.imageEditPointerDown({preventDefault(){assert.fail('unsupported drawing must not start');}});assert.equal(imageEdit.active,null);
});
