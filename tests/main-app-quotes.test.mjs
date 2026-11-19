import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {createQuoteController,quoteFingerprint} from '../public/quote-ui.mjs';
import {quoteValid,quoteSummary,catalogPriceText,formatMoney} from '../public/canvas-pricing.mjs';
import {buildVideoPayload,buildImagePayload,hamsterModelName,mediaLimitError,supportsImageMarks} from '../public/core.mjs';

import {toolAvailability,batchIsActive,batchProgressText} from '../public/relay-ui-state.mjs';

const source=fs.readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
const section=(start,end)=>{const first=source.indexOf(start),last=source.indexOf(end,first);assert.ok(first>=0&&last>first,start);return source.slice(first,last);};
const code=[section('function toolStatus(channel)','const toolUploadVersions'),section('// 报价只携带计费参数','/* ---- 数字人请求'),section('async function onSubmit(e)','// The UI reads the local journal'),section('function imageEditStatus(message','function imageEditOptions()'),section('async function submitImageEdit(event)','let historyFilter'),section('async function dhSubmit()','// ---- 工具箱：黑白深度视频'),section('async function depthSubmit()','function renderRhStatus()'),section('function taskModelLabel(task)','function taskCardHtml(t)')].join('\n');
const defer=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const flush=async()=>{for(let i=0;i<14;i++)await Promise.resolve();};
const operations={onSubmit:'generate',submitImageEdit:'imageEdit',dhSubmit:'digital',depthSubmit:'depth'};
function fixture({failure,result,deferUpload=false,imageLimit=2,marked=true}={}){
  const confirmation=defer(),upload=defer(),elements=new Map(),quotes=[],paid=[],toasts=[];let confirms=0,uploads=0;
  const element=selector=>{if(!elements.has(selector)){const node={value:'',disabled:false,textContent:'',open:true,hidden:false,dataset:{},style:{},setAttribute(){},querySelectorAll:()=>[],classList:{toggle(){}},close(){this.open=false;},querySelector:sub=>element(selector+' '+sub)};elements.set(selector,node);}return elements.get(selector);};
  element('#prompt').value='private prompt';element('#imageEditModel').value='main-image-1234abcd';element('#imageEditInstruction').value='modify local image';element('#imageEditSize').value='1024x1024';element('#imageEditRatio').value='1:1';element('#imageEditQuality').value='auto';
  const image={id:'main-image-1234abcd',name:'PIKNO 图片优选',type:'image',line_revision:1,max_images:imageLimit,max_media_total:20,billing_mode:'relay'},video={id:'main-video-5678abcd',name:'PIKNO 动态视频',type:'video',line_revision:1,max_images:30,max_videos:3,max_audios:3,max_media_total:20,billing_mode:'relay'};
  const state={relayMode:true,relayServerRevision:10,model:video,type:'video',models:[image,video],toolCatalogReady:true,toolChecking:false,toolConnection:{state:'ready'},toolModels:[{id:'tool-digital',name:'PIKNO 数字人',line_revision:1},{id:'tool-depth',name:'PIKNO 深度视频',line_revision:1}],options:{ratio:'16:9',resolution:'720p',duration:4,reference:'all'},concurrency:2,submitting:false,media:[{kind:'image',uiKey:'local-selection',url:'https://private-material.invalid/secret'}],pendingMedia:[],tasks:[],dh:{image:{fileName:'https://private-material.invalid/portrait'},audio:{fileName:'https://private-material.invalid/voice',duration:1}},depth:{video:{fileName:'https://private-material.invalid/video'}}};
  const imageEdit={blob:{local:true},loadId:1,strokes:marked?[{points:[1,2]}]:[],busy:false,loading:false,aborted:false};
  const context={state,imageEdit,relayConfigRevision:0,accountSessionRejected:false,activeFileBatches:{},QUALITY_LABEL:{auto:'自动'},$ :element,
    quoteValid,quoteSummary,catalogPriceText,formatMoney,quoteFingerprint,createQuoteController:opts=>createQuoteController({...opts,delay:0}),createQuoteConfirmation:()=>({confirm:async({isCurrent})=>{confirms++;return await confirmation.promise&&isCurrent();},cancel:()=>confirmation.resolve(false)}),
    imageModels:()=>[image],hasGenerationKey:()=>true,hasKey:()=>true,rhHasKey:()=>true,requireRhKey:()=>true,accountHint:()=> '请配置 PIKNO Key',mediaLimitError,supportsImageMarks,toolAvailability,batchIsActive,batchProgressText,pricingQuote:()=>({known:true}),publicText:value=>value,
    groupMedia:()=>({image:state.media.map(m=>({url:m.url})),video:[],audio:[]}),isVideoType:()=>true,buildVideoPayload,buildImagePayload,buildImageEditPrompt:v=>v,hamsterModelName,escapeHtml:value=>String(value),renderBatchControls(){},
    crypto:{randomUUID:()=> 'mock_request_1234'},extractTaskIds:()=>[],renderMediaLimits(){},dhSetHint(){},depthSetHint(){},renderAllTasks(){},syncTasks:async()=>{},switchView(){},
    imageEditFiles:async()=>imageEdit.strokes.length?[{name:'original.png'},{name:'marked.png'}]:[{name:'original.png'}],uploadFile:async()=>{uploads++;if(deferUpload)await upload.promise;return {url:'https://private-material.invalid/uploaded'};},
    requestOnce:async(path,options)=>{assert.equal(path,'/quotes');quotes.push(options);const p=options.json;return {revision:state.relayServerRevision,quote:{id:'opaque_quote_123',model:p.model,name:p.model.startsWith('tool-')?'PIKNO 工具':p.model.includes('image')?image.name:video.name,price_version:1,currency:'CNY',unit:p.model.includes('image')?'image':p.model.startsWith('tool-')?'request':'second',unit_price_cny:'0.10',units:p.duration||1,reference_surcharge_cny:'0.02',per_item_cny:'0.42',quantity:p.concurrency,total_cny:'0.84',expires_at:Math.floor(Date.now()/1000)+120}};},
    request:async(path,options)=>{paid.push({path,options});if(failure)throw failure;return result||{accepted:true,task:{key:'returned-task',relay:true,status:'queued',requestId:'mock_request_1234:0'}};},acceptLocalTask:created=>{const rows=created.tasks||[created.task].filter(Boolean);state.tasks.push(...rows);return rows.length>0;},
    releaseSubmittedMedia:()=>state.media=[],toast:text=>toasts.push(text),handleError:error=>toasts.push(error.message),
  };
  vm.createContext(context);vm.runInContext(code,context,{filename:'actual main app quote and submit functions'});
  return {context,state,imageEdit,element,quotes,paid,toasts,confirmation,upload,get confirms(){return confirms;},get uploads(){return uploads;},run:name=>context[name]({preventDefault(){}}),dispose:()=>vm.runInContext('quoteController.reset()',context)};
}
for(const [operation,key] of Object.entries(operations)){
  test(`${operation}: cancel confirms no paid request or editor upload`,async()=>{
    const f=fixture(),pending=f.run(operation);await flush();assert.equal(f.confirms,1);assert.equal(f.paid.length,0);assert.equal(f.uploads,0);f.confirmation.resolve(false);await pending;assert.equal(f.paid.length,0);assert.equal(f.uploads,0);f.dispose();
  });
  test(`${operation}: only explicit confirmation submits the original quote once`,async()=>{
    const f=fixture(),pending=f.run(operation);await flush();await f.run(operation);assert.equal(f.confirms,1);assert.equal(f.paid.length,0);f.confirmation.resolve(true);await pending;
    assert.equal(f.paid.length,1);assert.equal(f.paid[0].options.json.quote_id,'opaque_quote_123');assert.equal(f.paid[0].options.json.concurrency,key==='generate'?2:1);
    assert.equal('prompt' in f.quotes[0].json,false);assert.equal('images' in f.quotes[0].json,false);assert.doesNotMatch(JSON.stringify(f.quotes[0]),/private-material|private prompt/);f.dispose();
  });
  test(`${operation}: account switch while confirming prevents a paid request`,async()=>{
    const f=fixture(),pending=f.run(operation);await flush();f.state.relayServerRevision=11;f.confirmation.resolve(true);await pending;assert.equal(f.paid.length,0);assert.equal(f.uploads,0);f.dispose();
  });
  test(`${operation}: changed quote rejection requires another user confirmation and never retries`,async()=>{
    const f=fixture({failure:Object.assign(Error('safe price changed'),{status:409,code:'quote_changed'})}),pending=f.run(operation);await flush();f.confirmation.resolve(true);await pending;
    assert.equal(f.paid.length,1);assert.equal(f.quotes.length,1);assert.match(f.toasts.join(' '),/报价已失效/);assert.equal(vm.runInContext(`quoteController.state('${key}').status`,f.context),'expired');f.dispose();
  });
  test(`${operation}: ambiguous submission is blocked rather than re-quoted or resent`,async()=>{
    const f=fixture({failure:Object.assign(Error('synthetic unavailable'),{status:503})}),pending=f.run(operation);await flush();f.confirmation.resolve(true);await pending;
    await f.run(operation);assert.equal(f.paid.length,1);assert.equal(f.quotes.length,1);assert.equal(vm.runInContext(`pendingQuotedSubmissions.has('${key}')`,f.context),true);f.dispose();
  });
}
test('image editing quote includes original plus marked image, then rechecks after slow uploads',async()=>{
  const f=fixture({deferUpload:true}),pending=f.run('submitImageEdit');await flush();assert.equal(f.quotes[0].json.media_counts.images,2);f.confirmation.resolve(true);await flush();assert.equal(f.uploads,1);f.state.relayServerRevision=11;f.upload.resolve();await pending;assert.equal(f.paid.length,0);assert.match(f.element('#imageEditStatus').textContent,/报价已失效|参数已变化/);f.dispose();
});
test('partial batch preserves input and media and reports processed count',async()=>{
  const f=fixture({result:{accepted:true,tasks:[{key:'failed-attempt',status:'failed'}],stopped:{code:'submission_stopped',submitted:1,total:2}}}),pending=f.run('onSubmit');await flush();f.confirmation.resolve(true);await pending;
  assert.equal(f.element('#prompt').value,'private prompt');assert.equal(f.state.media.length,1);assert.match(f.toasts.at(-1),/已处理 1\/2 份.*剩余未提交/);assert.equal(f.paid.length,1);f.dispose();
});
test('unknown task response and zero-task active batch both block a new paid submission',async()=>{
  for(const result of [{accepted:true,task:{key:'uncertain',status:'unknown'}},{accepted:true,tasks:[],stopped:{submitted:0,total:2}}]){
    const f=fixture({result}),pending=f.run('onSubmit');await flush();f.confirmation.resolve(true);await pending;await f.run('onSubmit');assert.equal(f.paid.length,1);assert.equal(f.element('#prompt').value,'private prompt');assert.equal(f.quotes.length,1);f.dispose();
  }
});
test('new relay history uses its saved published name even for tools, and does not use a new catalog title',()=>{
  const f=fixture();assert.equal(f.context.taskModelLabel({relay:true,source:'digital',modelName:'历史批准名称',modelId:'tool-digital'}),'历史批准名称');assert.equal(f.context.taskModelLabel({source:'depth'}),'仓鼠黑白深度视频');f.dispose();
});
test('single-reference editing permits text edits with one upload, and rejects retained marks before quote or upload',async()=>{
  const marked=fixture({imageLimit:1});await marked.run('submitImageEdit');assert.equal(marked.quotes.length,0);assert.equal(marked.uploads,0);assert.equal(marked.paid.length,0);assert.match(marked.element('#imageEditStatus').textContent,/最多支持1个图片/);marked.dispose();
  const text=fixture({imageLimit:1,marked:false}),pending=text.run('submitImageEdit');await flush();assert.equal(text.quotes[0].json.media_counts.images,1);text.confirmation.resolve(true);await pending;assert.equal(text.uploads,1);assert.equal(text.paid.length,1);assert.equal(text.paid[0].options.json.images.length,1);assert.equal(text.element('#imageEditBrush').disabled,true);assert.match(text.element('#imageEditCapability').textContent,/圈选暂未适配/);text.dispose();
});
test('20 combined relay references can be quoted and 21 are rejected before quote or paid request',async()=>{
  for(const [count,allowed] of [[1,true],[20,true],[21,false]]){
    const f=fixture();f.state.media=Array.from({length:count},(_,index)=>({kind:'image',uiKey:'ref-'+index,url:'https://private-material.invalid/'+index}));
    const pending=f.run('onSubmit');await flush();assert.equal(f.quotes.length,allowed?1:0);assert.equal(f.uploads,0);f.confirmation.resolve(false);await pending;assert.equal(f.paid.length,0);if(!allowed)assert.match(f.toasts.at(-1),/素材总数最多20个/);f.dispose();
  }
});
test('fast batch acceptance preserves inputs until unsent items finish and blocks a second confirmation',async()=>{
  const batch={id:'b'.repeat(32),requestId:'mock_request_1234',status:'running',submitted:1,remaining:3,quantity:4};
  const f=fixture({result:{accepted:true,task:{key:'first',status:'submitting'},batch}}),pending=f.run('onSubmit');await flush();f.confirmation.resolve(true);await pending;
  assert.equal(f.state.batches[0].id,batch.id);assert.match(f.toasts.at(-1),/批次已受理/);assert.equal(f.element('#prompt').value,'private prompt');await f.run('onSubmit');assert.equal(f.paid.length,1);assert.equal(f.confirms,1);f.dispose();
});
