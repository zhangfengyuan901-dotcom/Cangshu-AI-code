import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {toolAvailability} from '../public/relay-ui-state.mjs';
import {mediaUploadMetadata} from '../public/media-upload-state.mjs';
const source=fs.readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
function section(start,end){const first=source.indexOf(start),last=source.indexOf(end,first);assert.ok(first>=0&&last>first);return source.slice(first,last);}
const functions=[section('function toolStatus(channel)','const toolUploadVersions'),section('async function rhUpload(file)','/* 读取音频时长'),section('async function dhPickImage(file)','async function dhSubmit()'),section('async function depthPickVideo(file)','async function depthSubmit()')].join('\n');
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const flush=async()=>{for(let i=0;i<8;i++)await Promise.resolve();};
function fixture({duration=1,checking=false,connection={state:'ready'},models=[{id:'tool-digital'},{id:'tool-depth'}],catalogReady=true}={}){
  const elements=new Map(),uploads=[],toasts=[],errors=[],revoked=[],counts={rendered:0};
  const element=selector=>{if(!elements.has(selector))elements.set(selector,{textContent:'',className:'',classList:{add(){},remove(){}}});return elements.get(selector);};
  const state={relayMode:true,toolModels:models,toolChecking:checking,toolConnection:connection,toolCatalogReady:catalogReady,dh:{image:{fileName:'current-image',local:'blob:current'},audio:{fileName:'current-audio',duration:1}},depth:{video:{fileName:'current-video',local:'blob:current-video'}}};
  const context={state,relayConfigRevision:0,toolUploadVersions:{image:0,audio:0,video:0},RH_MAX_AUDIO_SECONDS:30,$:element,mediaUploadMetadata,
    requireRhKey:()=>true,rhHasKey:()=>true,toolAvailability,fileFingerprint:async file=>file.name,
    uploadFile:async(...args)=>{const result=deferred();uploads.push({args,...result});return result.promise;},audioDuration:async()=>duration,
    URL:{createObjectURL:file=>'blob:'+file.name,revokeObjectURL:url=>revoked.push(url)},
    publicText:value=>value,toast:value=>toasts.push(value),handleError:error=>errors.push(error),renderDhSlots:()=>counts.rendered++,renderDepthSlot:()=>counts.rendered++,};
  vm.createContext(context);vm.runInContext(functions,context);
  return {context,state,uploads,toasts,errors,revoked,counts,element};
}
for(const [method,kind] of [['dhPickImage','image'],['dhPickAudio','audio'],['depthPickVideo','video']]){
  test(`${method}: tool upload always uses tool authorization and a stale account result cannot replace current material`,async()=>{
    const f=fixture(),file={name:'original-'+kind,type:kind+'/fixture'},pending=f.context[method](file);await flush();
    assert.equal(f.uploads.length,1);assert.equal(f.uploads[0].args[5],'tool');
    const current=kind==='image'?f.state.dh.image:kind==='audio'?f.state.dh.audio:f.state.depth.video;
    f.context.relayConfigRevision++;f.uploads[0].resolve({url:'old-account-signed-url'});await pending;
    assert.equal(kind==='image'?f.state.dh.image:kind==='audio'?f.state.dh.audio:f.state.depth.video,current);
    assert.equal(f.counts.rendered,0);assert.equal(f.errors.length,0);assert.equal(f.revoked.length,0);
  });
  test(`${method}: the latest picked file wins when upload responses arrive out of order`,async()=>{
    const f=fixture(),first=f.context[method]({name:'first',type:kind+'/fixture'});await flush();
    const second=f.context[method]({name:'second',type:kind+'/fixture'});await flush();
    f.uploads[1].resolve({url:'second-url'});await second;f.uploads[0].resolve({url:'first-url'});await first;
    const current=kind==='image'?f.state.dh.image:kind==='audio'?f.state.dh.audio:f.state.depth.video;
    assert.equal(current.fileName,'second-url');assert.equal(current.name,'second');assert.equal(f.counts.rendered,1);
  });
}
test('digital audio longer than exactly 30 seconds is refused before upload',async()=>{
  const f=fixture({duration:30.001});await f.context.dhPickAudio({name:'too-long.wav',type:'audio/wav'});
  assert.equal(f.uploads.length,0);assert.match(f.toasts[0],/30 秒上限/);assert.equal(f.state.dh.audio.fileName,'current-audio');
});
test('tool availability is checked before image, audio and video upload',async()=>{
  for(const options of [{checking:true},{connection:{state:'forbidden'}},{models:[]},{connection:{state:'error'}},{catalogReady:false}]){
    for(const [method,kind] of [['dhPickImage','image'],['dhPickAudio','audio'],['depthPickVideo','video']]){
      const f=fixture(options);await f.context[method]({name:'local.'+kind,type:kind+'/fixture'});assert.equal(f.uploads.length,0);assert.equal(f.counts.rendered,0);assert.equal(f.toasts.length,1);assert.doesNotMatch(f.toasts[0],/https:|sk-|\/v1\//);
    }
  }
});
