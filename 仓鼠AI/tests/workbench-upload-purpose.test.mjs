// Synthetic browser-to-local-server upload contract. No paid endpoint is called.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import vm from 'node:vm';
import {File} from 'node:buffer';
import {webcrypto} from 'node:crypto';
import {createRequire} from 'node:module';
import {fileURLToPath,pathToFileURL} from 'node:url';

const appRoot=path.resolve(process.env.HAMSTER_TEST_APP_ROOT||fileURLToPath(new URL('../',import.meta.url)));
const requireApp=createRequire(path.join(appRoot,'package.json'));
const {createApp}=requireApp('./server.js');
const {createPiknoClient}=requireApp('./pikno-client.cjs');
const {createPiknoKeyStore}=requireApp('./pikno-key-store.cjs');
const {localMediaID}=requireApp('./direct-media.cjs');
const media=await import(pathToFileURL(path.join(appRoot,'public/media-upload-state.mjs')));
const {mediaLimitError}=await import(pathToFileURL(path.join(appRoot,'public/core.mjs')));
const source=fs.readFileSync(path.join(appRoot,'public/app.js'),'utf8');
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/S9sAAAAASUVORK5CYII=','base64');
const imageKey='sk-'+'a'.repeat(48),videoKey='sk-'+'b'.repeat(48);
const videoLine={id:'pikno-video-synthetic',kind:'video',max_images:2,max_videos:1,max_audio:1};
const imageLine={id:'pikno-image-synthetic',kind:'image',max_images:2};
const deferred=()=>{let resolve;const promise=new Promise(done=>resolve=done);return {promise,resolve};};
function section(start,end){
  const first=source.indexOf(start),last=source.indexOf(end,first);
  assert.equal(first>=0&&last>first,true,'required workbench source section exists');
  return source.slice(first,last);
}
function request(base,route,{method='GET',headers={},body}={}){
  return new Promise((resolve,reject)=>{
    const target=new URL(route,base);
    const req=http.request(target,{method,headers},res=>{
      const chunks=[];res.on('data',chunk=>chunks.push(chunk));
      res.on('end',()=>resolve({status:res.statusCode,text:Buffer.concat(chunks).toString('utf8')}));
    });
    req.on('error',()=>reject(Error('isolated local request failed')));req.end(body);
  });
}

async function fixture(t,{type='video',holdResponse=false}={}){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hamster-workbench-upload-'));
  const calls=[],browserCalls=[],errors=[],responseReady=deferred(),releaseResponse=deferred();
  let index=0,failUpload=false,putStatus=204,completeStatus=200;
  const keyStore=createPiknoKeyStore();keyStore.write({piknoUserId:7,piknoImageKey:imageKey,piknoVideoKey:videoKey});
  const client=createPiknoClient({endpoint:'https://synthetic-relay.invalid',fetchImpl:async(target,options={})=>{
    const url=new URL(target),method=options.method||'GET';
    if(url.origin!=='https://synthetic-relay.invalid')throw Error('unexpected synthetic origin');
    const authorization=new Headers(options.headers).get('authorization');
    const keyKind=authorization==='Bearer '+videoKey?'video':authorization==='Bearer '+imageKey?'image':'ticket';
    const mediaUpload=/^\/media\/v1\/assets\/[a-f0-9]{32}(\/presign)?$/.exec(url.pathname);
    const route=url.pathname==='/v1/media/uploads'?'prepare':url.pathname==='/v1/media/complete'?'complete':
      mediaUpload?(mediaUpload[1]?'presign':'put'):'forbidden';
    const call={route,method,keyKind};
    calls.push(call);
    if(route==='prepare'){
      if(failUpload)return Response.json({error:{code:'synthetic_upload_failure'}},{status:503});
      const payload=JSON.parse(options.body),id=(++index).toString(16).padStart(32,'0');
      return Response.json({id,method:'PUT',upload_url:url.origin+'/media/v1/assets/'+id,upload_ticket:'synthetic-'+id,
        headers:{Authorization:'Bearer synthetic-'+id,'Content-Type':payload.content_type},expires_at:Math.floor(Date.now()/1000)+600});
    }
    if(route==='presign')return new Response(null,{status:404});
    if(route==='put'){
      call.bytes=options.body;
      if(putStatus==='disconnect')throw Error('synthetic dropped acknowledgement');
      return new Response(null,{status:putStatus});
    }
    if(route==='complete'){
      if(completeStatus!==200)return Response.json({error:'synthetic upstream detail'},{status:completeStatus});
      const id=JSON.parse(options.body).upload_ticket.slice('synthetic-'.length);
      return Response.json({id,status:'ready',url:url.origin+'/media/v1/assets/'+id+'?ticket=synthetic-read',expires_at:Math.floor(Date.now()/1000)+600});
    }
    throw Error('unexpected synthetic route; generation is forbidden');
  }});
  const app=createApp({relayMode:true,relayClient:client,relayKeyStore:keyStore,
    configPath:path.join(dir,'config.json'),resultDir:path.join(dir,'results'),taskDir:path.join(dir,'tasks'),assetDir:path.join(dir,'assets'),
    diagnosticsDir:path.join(dir,'diagnostics'),diagnosticExportDir:path.join(dir,'exports'),smartVideoLauncher:{stop(){}},
    inferenceGateway:{handle:()=>{throw Error('synthetic fixture forbids inference');}}});
  t.after(async()=>{
    releaseResponse.resolve();
    await new Promise(resolve=>{app.close(resolve);app.closeIdleConnections?.();});
    fs.rmSync(dir,{recursive:true,force:true});
  });
  await new Promise(resolve=>app.listen(0,'127.0.0.1',resolve));
  const base='http://127.0.0.1:'+app.address().port;
  const config=JSON.parse((await request(base,'/api/config')).text);
  assert.equal(Number.isSafeInteger(config.revision),true,'isolated relay exposes configuration revision');
  class LocalXMLHttpRequest{
    constructor(){this.headers={};this.upload={};}
    open(method,route){this.method=method;this.route=route;}
    setRequestHeader(name,value){this.headers[name]=value;}
    send(file){
      void (async()=>{
        try{
          const bytes=Buffer.from(await file.arrayBuffer()),url=new URL(this.route,base);
          const result=await request(base,this.route,{method:this.method,headers:{...this.headers,'Content-Length':String(bytes.length)},body:bytes});
          browserCalls.push({route:url.pathname.endsWith('/direct')?'direct':'raw',use:url.searchParams.get('use')||'',status:result.status});
          this.status=result.status;this.responseText=result.text;
          this.upload.onprogress?.({loaded:bytes.length,total:bytes.length,lengthComputable:true});
          responseReady.resolve();if(holdResponse)await releaseResponse.promise;
          this.onload?.();
        }catch{this.onerror?.();}
      })();
    }
  }
  class BrowserURL extends URL{
    static createObjectURL(){return 'blob:synthetic-preview';}
    static revokeObjectURL(){}
  }
  const state={type,relayMode:true,relayServerRevision:config.revision,model:{id:'synthetic-'+type,type,max_images:2,max_videos:1,max_audios:1},
    media:[],pendingMedia:[],tagCounters:{},apiKey:''};
  const elements=new Map(['#typeLabel','#referencePill','#durationPill','#concurrencyPill'].map(id=>[id,{style:{}}]));
  const context=vm.createContext({state,relayConfigRevision:0,modelLoadRevision:0,API_BASE:'/api',
    ...media,mediaLimitError,XMLHttpRequest:LocalXMLHttpRequest,URL:BrowserURL,crypto:webcrypto,performance,
    KIND_LABEL:{image:'图片',video:'视频',audio:'音频'},hasGenerationKey:()=>true,accountHint:()=>'',
    $:selector=>elements.get(selector)||null,$$:()=>[],isVideoType:()=>state.type!=='image',
    pickDefaultModel:()=>{state.model={...state.model,id:'synthetic-'+state.type,type:state.type};},
    renderMedia(){},queueMediaProgress(){},renderMediaLimits(){},renderComposer(){},syncStorageStatusKind(){},toast:()=>{},setTimeout:()=>0,
    handleError:error=>errors.push({status:error.status||0,message:error.message,code:error.code})});
  vm.runInContext([
    section('function mimeFor(',"let activeView="),
    section('async function handleFiles(', 'async function handleDroppedFiles('),
    section('async function refreshGenerationMedia(', 'async function onSubmit('),
    section('function setType(', 'function setModel('),
  ].join('\n'),context,{filename:'synthetic-workbench.js'});
  const file=()=>new File([png],'synthetic.png',{type:'image/png'});
  const validate=(line,items)=>{
    // The reference validator is real. Convert failures to a fixed assertion to keep logs free of reference URLs.
    let valid=true;try{client.validateReferences(line,{images:items},{cfg:keyStore.read(),revision:config.revision});}catch{valid=false;}
    assert.equal(valid,true,'uploaded references are accepted by the selected generation function');
  };
  return {state,context,calls,browserCalls,errors,file,validate,responseReady,releaseResponse,
    setFailUpload:value=>failUpload=value,revision:config.revision,
    setResponses:(put,complete=200)=>{putStatus=put;completeStatus=complete;},
    assertNoGeneration:()=>{
      assert.equal(calls.some(call=>call.route==='forbidden'),false,'no generation or unexpected upstream operation');
      for(const call of calls.filter(call=>call.route==='put'))assert.deepEqual(call.bytes,png,'synthetic upload preserves complete PNG bytes');
    }};
}

test('workbench image-to-video initial File upload uses the video media channel with both Keys configured',async t=>{
  const f=await fixture(t);await f.context.handleFiles([f.file()],'image');
  assert.equal(f.errors.length,0,'initial upload succeeds');assert.equal(f.state.media.length,1);
  f.validate(videoLine,f.state.media);
  assert.equal(f.browserCalls[0].use,'video','raw upload declares video use');
  assert.deepEqual(f.calls.map(({route,method,keyKind})=>[route,method,keyKind]),[
    ['prepare','POST','video'],['presign','POST','ticket'],['put','PUT','ticket'],['complete','POST','video'],
  ]);
  f.assertNoGeneration();
});

test('workbench expired image-to-video File reference refresh retains the video media channel',async t=>{
  const f=await fixture(t),file=f.file();
  f.state.media.push({kind:'image',tag:'图片1',file,fingerprint:await media.fileFingerprint(file),direct:false,
    url:'https://synthetic-relay.invalid/media/v1/assets/'+'0'.repeat(32)+'?ticket=synthetic-expired',expires_at:1});
  assert.equal(await f.context.refreshGenerationMedia(0),true);
  f.validate(videoLine,f.state.media);
  assert.equal(f.browserCalls.length,1);assert.equal(f.browserCalls[0].use,'video','File refresh declares video use');
  assert.equal(f.calls.filter(call=>call.keyKind==='video').length,2);assert.equal(f.state.media[0].file===file,true);
  f.assertNoGeneration();
});

test('workbench image generation continues to stage reference PNG locally without remote upload',async t=>{
  const f=await fixture(t,{type:'image'});await f.context.handleFiles([f.file()],'image');
  assert.equal(f.errors.length,0);assert.equal(f.state.media.length,1);
  assert.equal(Boolean(localMediaID(f.state.media[0].url)),true,'image reference remains local');
  f.validate(imageLine,f.state.media);assert.equal(f.browserCalls[0].route,'direct');assert.equal(f.calls.length,0);
  f.assertNoGeneration();
});

test('workbench stale configuration revision rejects the File upload before upstream authorization',async t=>{
  const f=await fixture(t);f.state.relayServerRevision=f.revision+1;
  await f.context.handleFiles([f.file()],'image');
  assert.equal(f.state.media.length,0);assert.equal(f.state.pendingMedia.length,0);assert.equal(f.calls.length,0);
  assert.equal(f.errors.length,1);assert.equal(f.errors[0].status,409);f.assertNoGeneration();
});

test('workbench configuration change during upload discards the old acceptance and releases pending selection',async t=>{
  const f=await fixture(t,{holdResponse:true});
  const pending=f.context.handleFiles([f.file()],'image');await f.responseReady.promise;
  f.context.relayConfigRevision++;f.releaseResponse.resolve();await pending;
  assert.equal(f.state.media.length,0);assert.equal(f.state.pendingMedia.length,0);assert.equal(f.errors.length,0);
  f.assertNoGeneration();
});

test('workbench failed video upload releases the File reservation so a later explicit retry can succeed',async t=>{
  const f=await fixture(t);f.setFailUpload(true);await f.context.handleFiles([f.file()],'image');
  assert.equal(f.state.media.length,0,'failed upload cannot become a selected reference');assert.equal(f.state.pendingMedia.length,0);
  assert.equal(f.errors.length,1);assert.equal(f.errors[0].status,503);
  assert.equal(f.errors[0].code,'media_upload_ticket');assert.match(f.errors[0].message,/上传凭证/);
  f.setFailUpload(false);await f.context.handleFiles([f.file()],'image');
  assert.equal(f.state.media.length,1,'explicit retry can select the reference');f.validate(videoLine,f.state.media);f.assertNoGeneration();
});

test('file PUT failures retain their stage and status up to the workbench toast',async t=>{
  const f=await fixture(t);
  for(const [put,complete,expected,code,pattern] of [
    [415,200,415,'media_upload_transfer',/文件内容/],[429,200,429,'media_upload_transfer',/频繁/],
    [403,200,403,'media_upload_transfer',/被拒绝/],[503,409,503,'media_upload_transfer',/传输失败/],
    [204,502,502,'media_upload_confirm',/确认素材/],
  ]){
    f.setResponses(put,complete);await f.context.handleFiles([f.file()],'image');
    const error=f.errors.at(-1);assert.equal(error.status,expected);assert.equal(error.code,code);assert.match(error.message,pattern);
    const messages=[];vm.runInNewContext(section('function handleError(', 'function hasKey(')+';handleError(error)',{error,toast:message=>messages.push(message),state:{relayMode:true}});
    assert.deepEqual(messages,[error.message]);assert.equal(f.state.media.length,0);f.assertNoGeneration();
  }
  assert.equal(f.calls.filter(x=>x.route==='complete').length,2);
});

test('lost PUT acknowledgement is recovered by checking the same ticket without retransmission',async t=>{
  const f=await fixture(t);f.setResponses('disconnect');
  await f.context.handleFiles([f.file()],'image');
  assert.equal(f.errors.length,0);assert.equal(f.state.media.length,1);f.validate(videoLine,f.state.media);
  assert.deepEqual(f.calls.map(x=>x.route),['prepare','presign','put','complete']);f.assertNoGeneration();
});

test('Windows audio aliases and extension-only MOV/AAC produce a supported upload content type',async t=>{
  const {context}=await fixture(t);
  for(const [name,declared,expected] of [['clip.mov','','video/quicktime'],['tone.aac','application/octet-stream','audio/aac'],['tone.wav','audio/x-wav','audio/wav'],['tone.m4a','audio/x-m4a','audio/mp4'],['file.png','text/html','text/html']]){
    assert.equal(context.mimeFor(name,declared),expected);
  }
});

for(const [from,to] of [['image','video'],['video','image']])test(`workbench ${from}-to-${to} switch reauthorizes an unexpired image reference and retains its original File`,async t=>{
  const f=await fixture(t,{type:from}),file=f.file();await f.context.handleFiles([file],'image');
  assert.equal(f.state.media.length,1);assert.equal(f.errors.length,0);
  assert.equal(f.state.media[0].expires_at>Date.now()/1000+60,true,'selected reference starts unexpired');
  f.context.setType(to);
  assert.equal(f.state.media[0].direct,to==='image','selected reference adopts the destination upload channel');
  assert.equal(await f.context.refreshGenerationMedia(0),true);
  assert.equal(f.state.media[0].file===file,true,'switch keeps original local File');
  assert.equal(f.browserCalls.length,2,'switch prepares a new reference for the destination function');
  assert.equal(Boolean(localMediaID(f.state.media[0].url)),to==='image','destination receives its required reference type');
  f.validate(to==='image'?imageLine:videoLine,f.state.media);f.assertNoGeneration();
});
