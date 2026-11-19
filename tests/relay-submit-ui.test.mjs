import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

import {supportsImageMarks} from '../public/core.mjs';
import {batchIsActive,batchProgressText} from '../public/relay-ui-state.mjs';

const source=fs.readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
function section(start,end){
  const first=source.indexOf(start),last=source.indexOf(end,first);
  assert.ok(first>=0&&last>first,`Missing real application section: ${start}`);
  return source.slice(first,last);
}
const functions=[
  section('async function onSubmit(e)','// The UI reads the local journal'),
  section('function acceptLocalTask(created)','function bindResultCopy(container)'),
  section('function imageEditStatus(message','function imageEditOptions()'),
  section('async function submitImageEdit(event)','let historyFilter'),
  section('function requireRhKey()','async function dhPickImage(file)'),
  section('async function dhSubmit()','// ---- 工具箱：黑白深度视频'),
  section('async function depthSubmit()','function renderRhStatus()'),
  section("window.addEventListener('hamster-relay-configured'","window.addEventListener('offline'"),
].join('\n');
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const flush=async()=>{for(let i=0;i<8;i++)await Promise.resolve();};
const operations=['onSubmit','submitImageEdit','dhSubmit','depthSubmit'];

function fixture({deferUpload=false}={}){
  const response=deferred(),entered=deferred(),upload=deferred(),uploadEntered=deferred();
  const elements=new Map(),events=new Map(),calls=[],toasts=[],errors=[];
  const counters={released:0,rendered:0,synced:0,closed:0,switched:0};
  let progress;
  const element=selector=>{
    if(!elements.has(selector))elements.set(selector,{value:'',disabled:false,textContent:'',open:false,style:{},setAttribute(){},querySelectorAll:()=>[],
      classList:{toggle(){},remove(){}},close(){this.open=false;counters.closed++;}});
    return elements.get(selector);
  };
  element('#prompt').value='old input';
  element('#imageEditModel').value='main-image-fixture';
  element('#imageEditInstruction').value='old image instruction';
  element('#imageEditRatio').value='1:1';element('#imageEditQuality').value='auto';
  element('#imageEditDialog').open=true;
  const image={id:'main-image-fixture',type:'image'},video={id:'main-video-fixture',type:'video'};
  const state={relayMode:true,model:video,models:[image,video],pendingMedia:[],media:[{url:'old-local-material'}],
    options:{},concurrency:1,type:'video',tasks:[],apiKey:'',videoApiKey:'',submitting:false,
    dh:{image:{fileName:'old-image'},audio:{fileName:'old-audio',duration:1}},depth:{video:{fileName:'old-video'}},
    toolModels:[{id:'tool-digital'},{id:'tool-depth'}]};
  const imageEdit={blob:{local:'original'},strokes:[{points:[1,2]}],active:null,busy:false,loading:false,aborted:false,loadId:0};
  const context={state,imageEdit,relayConfigRevision:0,toolUploadVersions:{image:0,audio:0,video:0},accountSessionRejected:false,
    storageStatusTimer:null,storageStatusPending:null,storageStatusKnown:false,storageStatusFailures:0,
    window:{addEventListener:(name,handler)=>events.set(name,handler)},clearTimeout,
    inflightGets:new Map(),uploadReuse:new Map(),inferenceIndicator:{reset(){},check(){}},
    $:element,crypto:{randomUUID:()=> 'mock-only-request'},
    hasGenerationKey:()=>true,hasKey:()=>true,hasVideoKey:()=>true,rhHasKey:()=>true,
    supportsImageMarks,batchIsActive,batchProgressText,requireToolReady:()=>true,
    accountHint:()=> '请先到「账户」页配置有效的 PIKNO Key',
    mediaLimitError:()=>'',groupMedia:()=>({image:[],video:[],audio:[]}),isVideoType:()=>true,
    buildVideoPayload:()=>({}),buildImagePayload:()=>({}),buildImageEditPrompt:value=>value,
    imageModels:()=>[image],pricingQuote:()=>({known:true}),extractTaskIds:()=>[],
    quoteSnapshot:()=>({revision:1,payload:{model:video.id,concurrency:1}}),confirmPaidSubmission:async()=>({id:'mock-quote'}),confirmedQuoteCurrent:()=>true,
    quoteController:{invalidate(){}},pendingQuotedSubmissions:new Map(),quoteSubmissionFailed:()=>false,noteQuotedResult(){},submissionMessage:()=> '已提交，任务将在后台继续',
    resetSurfaceQuotes(){},updateSurfaceQuote(){},refreshQuoteAvailability(){},publicText:value=>value,mediaLimitSignature:'',
    imageEditFiles:async()=>[{name:'local-original.png'}],
    uploadFile:async(_file,_kind,_direct,onProgress)=>{progress=onProgress;uploadEntered.resolve();return deferUpload?upload.promise:{url:'mock-upload'};},
    request:async(path,options)=>{calls.push({path,options});entered.resolve();return response.promise;},
    requestOnce:async()=>({relayMode:true,configured:true,videoConfigured:true,rhConfigured:true,llmConfigured:false}),
    loadModels:async()=>{state.models=[image,video];state.toolModels=[{id:'tool-digital'},{id:'tool-depth'}];state.model=video;},
    renderAllTasks:()=>{counters.rendered++;},syncTasks:async()=>{counters.synced++;},
    renderMediaLimits(){},renderComposer(){},renderRhStatus(){},renderStorageStatus(){},checkStorageStatus(){},
    dhSetHint(){},depthSetHint(){},switchView:()=>{counters.switched++;},
    toast:value=>toasts.push(value),handleError:error=>errors.push(error),
    releaseSubmittedMedia:()=>{counters.released++;state.media=[];},
  };
  vm.createContext(context);vm.runInContext(functions,context,{filename:'actual app.js submit sections'});
  return {context,state,imageEdit,element,counters,calls,toasts,errors,response,entered,upload,uploadEntered,
    progress:()=>progress,
    run:name=>context[name]({preventDefault(){}}),
    async changeConfiguration(){events.get('hamster-relay-configured')();await flush();},
  };
}

for(const operation of operations){
  for(const result of ['success','failure']){
    test(`${operation}: a late ${result} after changing Key cannot alter current customer UI`,async()=>{
      const app=fixture(),pending=app.run(operation);await app.entered.promise;
      const blob=app.imageEdit.blob,strokes=app.imageEdit.strokes;
      await app.changeConfiguration();
      assert.equal(app.state.submitting,false);assert.equal(app.imageEdit.busy,false);
      assert.equal(app.imageEdit.blob,blob);assert.equal(app.imageEdit.strokes,strokes);
      assert.equal(app.element('#imageEditDialog').open,true);
      assert.match(app.element('#imageEditStatus').textContent,/原图与笔画仍保留/);
      app.state.tasks=[{key:'new-account-task'}];
      app.element('#prompt').value='new unsent input';app.state.media=[{url:'new-local-material'}];
      app.state.submitting=true;app.imageEdit.busy=true;app.imageEdit.aborted=false;
      app.element('#dhSubmit').disabled=true;app.element('#depthSubmit').disabled=true;
      const counts={...app.counters},status=app.element('#imageEditStatus').textContent;
      if(result==='success')app.response.resolve({accepted:true,task:{key:'old-account-task',walletUser:'pikno:7'}});
      else app.response.reject(Error('late old customer error'));
      await pending;
      assert.deepEqual(app.state.tasks,[{key:'new-account-task'}]);
      assert.equal(app.element('#prompt').value,'new unsent input');
      assert.deepEqual(app.state.media,[{url:'new-local-material'}]);
      assert.equal(app.state.submitting,true);assert.equal(app.imageEdit.busy,true);
      assert.equal(app.imageEdit.aborted,false);assert.equal(app.element('#dhSubmit').disabled,true);
      assert.equal(app.element('#depthSubmit').disabled,true);
      assert.equal(app.element('#imageEditDialog').open,true);
      assert.equal(app.element('#imageEditStatus').textContent,status);
      assert.deepEqual(app.counters,counts);assert.equal(app.toasts.length,0);assert.equal(app.errors.length,0);
      assert.equal(app.calls.length,1);
    });
  }
  test(`${operation}: unchanged configuration still accepts successful task and unlocks controls`,async()=>{
    const app=fixture(),pending=app.run(operation);await app.entered.promise;
    app.response.resolve({accepted:true,task:{key:'current-account-task'}});await pending;
    assert.equal(app.state.tasks[0].key,'current-account-task');assert.equal(app.calls.length,1);
    assert.equal(app.toasts.length,1);assert.equal(app.errors.length,0);
    assert.equal(app.state.submitting,false);assert.equal(app.imageEdit.busy,false);
    if(operation==='onSubmit'){assert.equal(app.element('#prompt').value,'');assert.equal(app.counters.released,1);}
    else {assert.equal(app.element('#prompt').value,'old input');assert.equal(app.counters.released,0);}
    assert.equal(app.counters.closed,operation==='submitImageEdit'?1:0);
  });
  test(`${operation}: unchanged configuration still handles failure without accepting a task`,async()=>{
    const app=fixture(),pending=app.run(operation);await app.entered.promise;
    app.response.reject(Object.assign(Error('mock failure'),{status:400}));await pending;
    assert.equal(app.state.tasks.length,0);assert.equal(app.calls.length,1);
    assert.equal(app.element('#prompt').value,'old input');assert.equal(app.counters.released,0);
    assert.equal(app.counters.closed,0);assert.equal(app.state.submitting,false);assert.equal(app.imageEdit.busy,false);
    if(operation==='submitImageEdit'){assert.equal(app.imageEdit.aborted,false);assert.equal(app.element('#imageEditStatus').textContent,'mock failure');}
    else assert.equal(app.errors.length,1);
  });
}

test('changing Key preserves tool previews but invalidates previous account media authorization',async()=>{
  const app=fixture();app.state.dh.image.local='blob:portrait';app.state.depth.video.local='blob:video';
  await app.changeConfiguration();
  assert.equal(app.state.dh.image.fileName,'');assert.equal(app.state.dh.audio.fileName,'');assert.equal(app.state.depth.video.fileName,'');
  assert.equal(app.state.dh.image.local,'blob:portrait');assert.equal(app.state.depth.video.local,'blob:video');
  assert.equal(app.state.media[0].authorizationInvalid,true);
  await app.run('onSubmit');assert.equal(app.calls.length,0);assert.match(app.toasts.pop(),/当前账户/);
  await app.run('dhSubmit');await app.run('depthSubmit');assert.equal(app.calls.length,0);
  assert.equal(app.toasts.length,2);assert.ok(app.toasts.every(value=>value.includes('当前账户')));
});

for(const operation of ['dhSubmit','depthSubmit'])test(`${operation}: repeated UI events during an in-flight submit cannot create a second paid request`,async()=>{
  const app=fixture(),pending=app.run(operation);await app.entered.promise;
  await app.run(operation);assert.equal(app.calls.length,1);
  app.response.resolve({accepted:true,task:{key:'tool-current-task'}});await pending;
  assert.equal(app.state.tasks.length,1);assert.equal(operation==='dhSubmit'?app.state.dh.submitting:app.state.depth.submitting,false);
});

test('image edit preparation stops before paid POST when Key changes during an upload',async()=>{
  const app=fixture({deferUpload:true}),pending=app.run('submitImageEdit');await app.uploadEntered.promise;
  const blob=app.imageEdit.blob,strokes=app.imageEdit.strokes;
  await app.changeConfiguration();
  const status=app.element('#imageEditStatus').textContent;
  app.progress()(5,10);assert.equal(app.element('#imageEditStatus').textContent,status);
  app.upload.resolve({url:'old-upload-result'});await pending;
  assert.equal(app.calls.length,0);assert.equal(app.toasts.length,0);assert.equal(app.errors.length,0);
  assert.equal(app.imageEdit.blob,blob);assert.equal(app.imageEdit.strokes,strokes);
  assert.equal(app.element('#imageEditDialog').open,true);assert.equal(app.counters.closed,0);
});

test('tool entry without a Key uses the new PIKNO setup instruction',()=>{
  const app=fixture();app.context.rhHasKey=()=>false;
  assert.equal(app.context.requireRhKey(),false);
  assert.match(app.toasts[0],/PIKNO Key/);assert.doesNotMatch(app.toasts[0],/邮箱验证码/);
  assert.equal(app.counters.switched,1);assert.equal(app.calls.length,0);
});
