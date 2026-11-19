// Three-Key authorization contracts across real desktop HTTP and an isolated relay.
// All accounts, Keys, uploads and tasks are synthetic; no paid or notification endpoint.
const {test}=require('node:test'),assert=require('node:assert/strict');
const http=require('node:http'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),vm=require('node:vm');
const {createApp}=require('../server.js');
const {createPiknoClient}=require('../pikno-client.cjs');
const {createPiknoKeyStore}=require('../pikno-key-store.cjs');
const {syntheticQuote,withQuotedApi}=require('./support/relay-quote.cjs');
const imageKey='sk-'+'a'.repeat(48),videoKey='sk-'+'b'.repeat(48),toolKey='sk-'+'c'.repeat(48),newToolKey='sk-'+'d'.repeat(48);
const otherImageKey='sk-'+'e'.repeat(48),otherVideoKey='sk-'+'f'.repeat(48),otherToolKey='sk-'+'g'.repeat(48);
const allKeys={piknoImageKey:imageKey,piknoVideoKey:videoKey,piknoToolKey:toolKey};
const image={id:'pikno-image-contract',kind:'image',resolutions:['1024x1024'],qualities:['auto'],max_images:2,max_videos:0,max_audio:0};
const video={id:'pikno-video-contract',kind:'video',resolutions:['720p'],ratios:['16:9'],durations:[5],max_images:1,max_videos:1,max_audio:1};
const digital={id:'pikno-tool-digital',kind:'video',resolutions:[],ratios:[],durations:[],max_images:1,max_videos:0,max_audio:1};
const depth={...digital,id:'pikno-tool-depth',max_images:0,max_videos:1,max_audio:0};
const blocked=new Set([1,7,9,11,13,15,17,19,20,21,22,23,25,37,42,43,53,69,77,79,87,95,101,102,103,104,109,110,111,113,115,117,119,123,135,137,139,143,161,179,389,427,465,512,513,514,515,526,530,531,532,540,548,554,556,563,587,601,636,989,990,993,995,1719,1720,1723,2049,3659,4045,5060,5061,6000,6566,6665,6666,6667,6668,6669,6697,10080]);
async function listen(server){for(;;){await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));if(!blocked.has(server.address().port))return 'http://127.0.0.1:'+server.address().port;await close(server);}}
const close=server=>new Promise(resolve=>{server.close(resolve);server.closeIdleConnections?.();});
const json=(res,value,status=200)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(value));};
async function until(condition){const deadline=Date.now()+3000;while(Date.now()<deadline){const value=condition();if(value)return value;await new Promise(resolve=>setTimeout(resolve,10));}throw Error('isolated relay observation timed out');}

async function fixture(t,{legacyTask=false,initialKeys}={}){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hamster-three-key-contract-')),calls=[],keyStore=createPiknoKeyStore(),gates=[];
  const identities=new Map([[imageKey,{user_id:7,group:'image-standard'}],[videoKey,{user_id:7,group:'video-standard'}],
    [toolKey,{user_id:7,group:'tool-standard'}],[newToolKey,{user_id:7,group:'tool-standard'}],
    [otherImageKey,{user_id:8,group:'image-standard'}],[otherVideoKey,{user_id:8,group:'video-standard'}],[otherToolKey,{user_id:8,group:'tool-standard'}]]);
  let relayUrl,assetIndex=0,jobIndex=0;
  const relay=http.createServer(async(req,res)=>{
    try{
      const chunks=[];for await(const chunk of req)chunks.push(chunk);
      const bytes=Buffer.concat(chunks),body=bytes.length&&String(req.headers['content-type']).startsWith('application/json')?JSON.parse(bytes):undefined;
      const call={method:req.method,url:req.url,auth:req.headers.authorization,body,size:bytes.length,mime:req.headers['content-type']};calls.push(call);
      const gate=gates.find(item=>!item.entered&&item.predicate(call));
      if(gate){gate.entered=true;gate.start();await gate.wait;}
      const key=String(req.headers.authorization||'').replace(/^Bearer /,''),identity=identities.get(key);
      if(req.url==='/api/pikno/catalog')return json(res,{data:{models:[image,video,digital,depth]}});
      if(req.method==='PUT'&&req.url.startsWith('/media/v1/assets/'))return res.writeHead(204).end();
      if(!identity)return json(res,{error:'synthetic unauthorized'},401);
      if(req.url==='/v1/client/context')return json(res,identity);
      if(req.url==='/v1/models')return json(res,{data:(identity.group==='image-standard'?[image]:identity.group==='video-standard'?[video,digital,depth]:[digital,depth]).map(line=>({id:line.id}))});
      if(req.url==='/v1/client/quote')return json(res,{data:syntheticQuote(body)});
      if(req.url==='/v1/media/direct-uploads'){
        const id=(++assetIndex).toString(16).padStart(32,'0'),expires_at=Math.floor(Date.now()/1000)+600;
        const claims={v:1,aud:'pikno-tool-input',uid:identity.user_id,id,mime:req.headers['content-type'],size:bytes.length,exp:expires_at};
        const ticket=Buffer.from(JSON.stringify(claims)).toString('base64url')+'.synthetic';
        return json(res,{url:relayUrl+'/media/v1/tool-inputs/'+id+'?ticket='+ticket,expires_at},201);
      }
      if(req.url==='/v1/media/uploads'){
        const id=(++assetIndex).toString(16).padStart(32,'0');
        return json(res,{id,method:'PUT',upload_url:relayUrl+'/media/v1/assets/'+id,upload_ticket:'put-'+id,
          headers:{Authorization:'Bearer put-'+id,'Content-Type':body.content_type},expires_at:Math.floor(Date.now()/1000)+600});
      }
      if(req.url==='/v1/media/complete'){
        const id=body.upload_ticket.slice(4);return json(res,{id,status:'ready',url:relayUrl+'/media/v1/assets/'+id+'?ticket=synthetic-read',expires_at:Math.floor(Date.now()/1000)+600});
      }
      if(req.method==='POST'&&req.url.startsWith('/v1/tools/')){
        if(identity.group!=='tool-standard')return json(res,{error:'synthetic wrong group'},403);
        return json(res,{id:'tool_job_'+(++jobIndex),status:'queued'},202);
      }
      if(req.method==='POST'&&req.url==='/v1/videos')return json(res,{id:'video_job_'+(++jobIndex),status:'queued'},202);
      if(req.method==='GET'&&req.url.startsWith('/v1/videos/'))return json(res,{id:req.url.split('/').pop(),status:'in_progress'});
      return json(res,{error:'unexpected synthetic route'},404);
    }catch(error){json(res,{error:'synthetic fixture failure'},500);}
  });
  relayUrl=await listen(relay);
  const legacyKey='1'.repeat(32);
  if(initialKeys)keyStore.write({...initialKeys,piknoUserId:7});
  if(legacyTask){
    keyStore.write({piknoUserId:7,piknoVideoKey:videoKey});
    fs.mkdirSync(path.join(dir,'tasks'));
    fs.writeFileSync(path.join(dir,'tasks',legacyKey+'.json'),JSON.stringify({key:legacyKey,id:'legacy_depth',walletUser:'pikno:7',relay:true,
      source:'depth',provider:'tool',type:'video',modelId:'tool-depth',modelName:'仓鼠黑白深度视频',status:'queued',createdAt:new Date().toISOString(),result:null}));
  }
  const inferenceKeys=[];
  let app,base;
  const start=async()=>{app=createApp({relayMode:true,relayClient:createPiknoClient({endpoint:relayUrl}),relayKeyStore:keyStore,mediaMetadataReader:async()=>({durationSeconds:20}),
    configPath:path.join(dir,'config.json'),resultDir:path.join(dir,'results'),taskDir:path.join(dir,'tasks'),assetDir:path.join(dir,'assets'),
    diagnosticsDir:path.join(dir,'diagnostics'),smartVideoLauncher:{stop(){}},taskOptions:{tickMs:60000,interval:60000},
    inferenceGateway:{handle:async(req,res,url,key)=>{inferenceKeys.push(key);json(res,{configured:Boolean(key)},key?200:401);}}});
    base=await listen(app);};
  await start();
  t.after(async()=>{for(const gate of gates)gate.release();await close(app);await close(relay);fs.rmSync(dir,{recursive:true,force:true});});
  const raw=(route,body,headers={})=>fetch(base+route,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json',...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const api=withQuotedApi(raw,{canQuote:route=>Boolean(keyStore.read()[route.startsWith('/api/tools/')?'piknoToolKey':route==='/api/images'?'piknoImageKey':'piknoVideoKey'])});
  const hold=predicate=>{let start,release;const entered=new Promise(resolve=>start=resolve),wait=new Promise(resolve=>release=resolve);const gate={predicate,start,release,wait,entered:false};gates.push(gate);return {entered,release};};
  const upload=async(mime,{use='tool',revision}={})=>{
    const response=await fetch(base+'/api/uploads/raw?use='+use,{method:'POST',headers:{'Content-Type':mime,...(revision===undefined?{}:{'X-Hamster-Config-Revision':String(revision)})},body:Buffer.alloc(16)});
    assert.equal(response.status,201);return (await response.json()).file.url;
  };
  return {dir,get base(){return base;},calls,keyStore,inferenceKeys,legacyKey,api,hold,upload,
    restart:async()=>{await close(app);await start();},state:async()=>(await api('/api/relay/state')).json()};
}

test('three Keys must have the correct groups and one account; failed saves preserve the entire prior configuration',async t=>{
  const f=await fixture(t);
  assert.equal((await f.api('/api/config',allKeys)).status,200);
  const original=f.keyStore.read();assert.match(original.piknoExecutionScope,/^[a-f0-9]{64}$/);assert.deepEqual(original,{...allKeys,piknoUserId:7,piknoExecutionScope:original.piknoExecutionScope});
  for(const [input,status] of [[{piknoToolKey:imageKey},403],[{piknoImageKey:toolKey},403],[{piknoVideoKey:toolKey},403],
    [{piknoToolKey:otherToolKey},409],[{piknoImageKey:otherImageKey},409],[{piknoVideoKey:otherVideoKey},409]]){
    assert.equal((await f.api('/api/config',input)).status,status);
    assert.deepEqual(f.keyStore.read(),original);
  }
  assert.equal((await f.api('/api/config',{piknoImageKey:otherImageKey,piknoVideoKey:otherVideoKey,piknoToolKey:otherToolKey})).status,200);
  assert.equal(f.keyStore.read().piknoUserId,8);
});

test('blank and whitespace-only fields retain every saved Key; saving one Key preserves the other two',async t=>{
  const f=await fixture(t);await f.api('/api/config',allKeys);
  for(const blank of ['', '   ']){
    assert.equal((await f.api('/api/config',{piknoImageKey:blank,piknoVideoKey:blank,piknoToolKey:blank})).status,200);
    assert.deepEqual(f.keyStore.read(),{...allKeys,piknoUserId:7,piknoExecutionScope:f.keyStore.read().piknoExecutionScope});
  }
  assert.equal((await f.api('/api/config',{piknoToolKey:newToolKey})).status,200);
  assert.deepEqual(f.keyStore.read(),{...allKeys,piknoToolKey:newToolKey,piknoUserId:7,piknoExecutionScope:f.keyStore.read().piknoExecutionScope});
});

test('a slower concurrent save cannot overwrite the latest validated three-Key configuration',async t=>{
  const f=await fixture(t);await f.api('/api/config',allKeys);
  const gate=f.hold(call=>call.url==='/v1/client/context'&&call.auth==='Bearer '+newToolKey);
  const oldSave=f.api('/api/config',{piknoToolKey:newToolKey});await gate.entered;
  assert.equal((await f.api('/api/config',allKeys)).status,200);gate.release();
  assert.equal((await oldSave).status,409);
  assert.deepEqual(f.keyStore.read(),{...allKeys,piknoUserId:7,piknoExecutionScope:f.keyStore.read().piknoExecutionScope});
});

test('only a tool Key enables both tools while leaving image, video and chat authorization disabled',async t=>{
  const f=await fixture(t);assert.equal((await f.api('/api/config',{piknoToolKey:toolKey})).status,200);
  const state=await f.state();
  assert.equal(state.toolConfigured,true);assert.equal(state.rhConfigured,undefined);
  assert.equal(state.configured,false);assert.equal(state.videoConfigured,false);assert.equal(state.llmConfigured,false);
  const connection=await (await f.api('/api/relay/connection')).json();
  assert.equal(connection.tool.state,'ready');assert.equal(connection.tool.modelCount,2);
  assert.deepEqual(connection.tools,{digital:true,depth:true});
  const models=await (await f.api('/api/models')).json();assert.deepEqual(models.data.map(model=>model.id),['tool-digital','tool-depth']);
  assert.equal((await f.api('/api/inference/status')).status,401);assert.deepEqual(f.inferenceKeys,[]);
  assert.equal(f.calls.filter(call=>call.method==='POST'&&!call.url.startsWith('/v1/client/')).length,0);
});

test('a video Key cannot expose or submit new tool work even when legacy model permissions contain tool IDs',async t=>{
  const f=await fixture(t);await f.api('/api/config',{piknoVideoKey:videoKey});
  const models=(await (await f.api('/api/models')).json()).data;
  assert.equal(models.length,1);assert.equal(models[0].provider,'generate');
  for(const kind of ['digital','depth'])assert.equal((await f.api('/api/tools/'+kind,{model:'tool-'+kind,concurrency:1},{'Idempotency-Key':'video-only-'+kind})).status,401);
  assert.equal(f.calls.filter(call=>call.method==='POST'&&call.url.startsWith('/v1/tools/')).length,0);
  assert.equal(fs.existsSync(path.join(f.dir,'tasks')),false);
});

test('tool-only image, audio and video uploads, both submissions and task queries use the tool Key',async t=>{
  const f=await fixture(t);await f.api('/api/config',{piknoToolKey:toolKey});
  const picture=await f.upload('image/png'),audio=await f.upload('audio/wav'),clip=await f.upload('video/mp4');
  const revision=(await f.state()).revision;
  const inputs={digital:{model:'tool-digital',images:[{url:picture}],audios:[{url:audio,durationSeconds:20}],concurrency:1},depth:{model:'tool-depth',videos:[{url:clip}],concurrency:1}};
  for(const kind of ['digital','depth']){
    const response=await f.api('/api/tools/'+kind,inputs[kind],{'Idempotency-Key':'three-key-'+kind,'X-Hamster-Config-Revision':String(revision)});
    assert.equal(response.status,202);const task=(await response.json()).task;
    assert.equal(task.source,kind);
    assert.equal((await f.api('/api/tasks/'+task.key+'/retry',{})).status,200);
    await until(()=>f.calls.find(call=>call.url==='/v1/videos/'+task.id));
  }
  for(const call of f.calls.filter(call=>['/v1/media/direct-uploads','/v1/tools/digital','/v1/tools/depth'].includes(call.url)||call.url.startsWith('/v1/videos/')))assert.equal(call.auth,'Bearer '+toolKey);
  assert.deepEqual(f.calls.filter(call=>call.url==='/v1/media/direct-uploads').map(call=>call.mime),['image/png','audio/wav','video/mp4']);
  assert.equal(f.calls.filter(call=>call.method==='POST'&&call.url.startsWith('/v1/tools/')).length,2);
});

test('an existing same-account tool task remains queryable with its original video Key without permitting a new tool submission',async t=>{
  const f=await fixture(t,{legacyTask:true});await f.api('/api/config',{piknoVideoKey:videoKey});
  const listed=(await (await f.api('/api/tasks')).json()).tasks;assert.equal(listed[0].id,'legacy_depth');
  const query=await until(()=>f.calls.find(call=>call.url==='/v1/videos/legacy_depth'));assert.equal(query.auth,'Bearer '+videoKey);
  assert.equal((await f.api('/api/tools/depth',{model:'tool-depth',concurrency:1},{'Idempotency-Key':'legacy-cannot-submit'})).status,401);
  assert.equal(f.calls.filter(call=>call.method==='POST'&&call.url.startsWith('/v1/tools/')).length,0);
});

test('a stale configuration revision rejects image, video, both tools and uploads before any upstream request',async t=>{
  const f=await fixture(t);await f.api('/api/config',allKeys);const old=(await f.state()).revision;
  await f.api('/api/config',{piknoToolKey:newToolKey});f.calls.length=0;
  for(const route of ['/api/images','/api/videos','/api/tools/digital','/api/tools/depth']){
    const response=await f.api(route,{model:'irrelevant',concurrency:1},{'Idempotency-Key':'stale-revision-request','X-Hamster-Config-Revision':String(old)});
    assert.equal(response.status,409,route);
  }
  const upload=await fetch(f.base+'/api/uploads/raw?use=tool',{method:'POST',headers:{'Content-Type':'image/png','X-Hamster-Config-Revision':String(old)},body:Buffer.alloc(16)});
  assert.equal(upload.status,409);assert.equal(f.calls.length,0);assert.equal(fs.existsSync(path.join(f.dir,'tasks')),false);
});

test('stale stored image uploads and direct uploads are rejected before authorizing any upstream upload',async t=>{
  const f=await fixture(t);await f.api('/api/config',allKeys);
  const image=fs.readFileSync(path.join(__dirname,'../public/hamster-logo.png'));
  const imported=await fetch(f.base+'/api/assets/import?category=scene&name=synthetic-review.png',{method:'POST',headers:{'Content-Type':'image/png'},body:image});
  assert.equal(imported.status,201);const asset=await imported.json(),old=(await f.state()).revision;
  await f.api('/api/config',{piknoToolKey:newToolKey});f.calls.length=0;
  for(const route of ['/upload?use=tool','/upload?use=video','/upload-direct?use=image']){
    const response=await f.api('/api/assets/'+asset.id+route,{}, {'X-Hamster-Config-Revision':String(old)});
    assert.equal(response.status,409,route);
    assert.equal(f.calls.length,0,route);
  }
});

test('an old canvas page cannot authorize the new account after a process restart resets execution state',async t=>{
  const f=await fixture(t,{initialKeys:allKeys}),old=(await f.state()).revision;
  const model=(await(await f.api('/api/canvas/models')).json()).data.find(model=>model.type==='video'&&model.provider==='generate');
  const created=await f.api('/api/canvas/projects',{title:'synthetic restart review',nodes:[{id:'run',type:'generation',position:{x:0,y:0},
    data:{channel:'main',model:model.id,prompt:'synthetic review',options:{ratio:'16:9',resolution:'720p',duration:5}}}],edges:[]});
  assert.equal(created.status,201);const project=await created.json();
  assert.equal((await f.api('/api/config',{piknoImageKey:otherImageKey,piknoVideoKey:otherVideoKey,piknoToolKey:otherToolKey})).status,200);
  await f.restart();f.calls.length=0;
  const execute=await f.api('/api/canvas/projects/'+project.id+'/execute',{nodeId:'run',requestId:'restart-stale-request-id',revision:old});
  assert.equal(execute.status,409);
  assert.equal(f.calls.length,0);
  assert.equal(fs.existsSync(path.join(f.dir,'tasks')),false);
  const unchanged=await(await f.api('/api/canvas/projects/'+project.id)).json();assert.equal(unchanged.runs.length,0);
});

test('a late catalog or a submission waiting for that catalog becomes 409 after a Key revision change',async t=>{
  const f=await fixture(t);await f.api('/api/config',allKeys);
  for(const route of ['/api/models','/api/canvas/models','/api/tools/depth']){
    const gate=f.hold(call=>call.url==='/api/pikno/catalog');
    const pending=route.includes('/tools/')?f.api(route,{model:'tool-depth',concurrency:1},{'Idempotency-Key':'late-directory-request'}):f.api(route);
    await gate.entered;await f.api('/api/config',allKeys);gate.release();
    const response=await pending;assert.equal(response.status,409,route);assert.doesNotMatch(await response.text(),/main-image|main-video|tool-depth/);
  }
  assert.equal(f.calls.filter(call=>call.method==='POST'&&call.url.startsWith('/v1/tools/')).length,0);
  assert.equal(fs.existsSync(path.join(f.dir,'tasks')),false);
});

test('configuration, state, connection and directory responses never echo Keys, account identifiers or internal config fields',async t=>{
  const f=await fixture(t);const saved=await f.api('/api/config',allKeys);assert.doesNotMatch(await saved.text(),/sk-|user_id|piknoUserId|pikno(?:Image|Video|Tool)Key/);
  for(const route of ['/api/config','/api/relay/state','/api/relay/connection','/api/models','/api/canvas/models']){
    const response=await f.api(route);assert.equal(response.status,200);assert.doesNotMatch(await response.text(),/sk-|user_id|piknoUserId|pikno(?:Image|Video|Tool)Key|image-standard|video-standard|tool-standard/);
  }
  assert.equal(fs.existsSync(path.join(f.dir,'config.json')),false);
});

test('the account page clears all four Key inputs and never writes a Key to browser storage',async()=>{
  const source=fs.readFileSync(path.join(__dirname,'../public/account.mjs'),'utf8'),elements=new Map(),sent=[],events=[];
  const element=id=>{if(!elements.has(id))elements.set(id,{value:'',textContent:'',innerHTML:'',dataset:{},disabled:false,hidden:false,setAttribute(){},remove(){}});return elements.get(id);};
  const initial={relayMode:true,configured:false,videoConfigured:false,toolConfigured:false,keyStorage:'protected'};
  const ready={configured:true,state:'ready',connected:true,modelCount:2};
  const response=value=>Response.json(value);
  const context={document:{getElementById:element,querySelector:selector=>selector==='.account-dashboard'?element('dashboard'):null},
    fetch:async(route,options={})=>{if(route==='/api/config'&&!options.method)return response(initial);if(route==='/api/config'){sent.push(JSON.parse(options.body));return response({...initial,ok:true,configured:true,videoConfigured:true,toolConfigured:true});}return response({image:ready,video:ready,tool:ready,tools:{digital:true,depth:true}});},
    Event:class{constructor(type){this.type=type;}},window:{addEventListener(){},dispatchEvent:event=>events.push({type:event.type,values:['relayImageKey','relayVideoKey','relayToolKey','relayChatKey'].map(id=>element(id).value)})},
    localStorage:{setItem:()=>assert.fail('browser storage must not receive Keys'),removeItem(){}},sessionStorage:{setItem:()=>assert.fail('session storage must not receive Keys')},confirm:()=>true};
  const faultSource=fs.readFileSync(path.join(__dirname,'../public/fault-events.mjs'),'utf8').replace(/^export /gm,'');
  const executable=source.replace("import {mountNativeAuth,mountNativePayment} from './account-native.mjs';",'').replace("import {keyDisplayName} from './account-display.mjs';",'').replace("import {reportAccountFailure} from './fault-events.mjs';",`const {reportAccountFailure}=(()=>{${faultSource}\nreturn {reportAccountFailure};})();`);
  await vm.runInNewContext(`(async()=>{${executable}\n})()`,context);
  element('relayImageKey').value=imageKey;element('relayVideoKey').value=videoKey;element('relayToolKey').value=toolKey;
  await element('relayKeyForm').onsubmit({preventDefault(){}});
  assert.deepEqual(sent,[{...allKeys,piknoChatKey:''}]);assert.deepEqual(events[0].values,['','','','']);
  for(const item of elements.values()){assert.equal(item.value,'');assert.doesNotMatch(item.textContent+item.innerHTML,/sk-/);}
  assert.equal(element('startRelay').disabled,false);
});
