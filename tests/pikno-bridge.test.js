const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createApp}=require('../server.js');
const {createPiknoKeyStore}=require('../pikno-key-store.cjs');
const {quoteParameters}=require('../pikno-client.cjs');
const {syntheticQuote,withQuotedApi}=require('./support/relay-quote.cjs');
const imageKey='sk-'+'a'.repeat(48),videoKey='sk-'+'b'.repeat(48);
const image={id:'main-image-abc123',name:'主线路 · 图片',type:'image',provider:'generate',concurrency_options:[1,2,4],billing_mode:'relay'};
const video={id:'main-video-def456',name:'主线路 · 视频',type:'video',provider:'generate',concurrency_options:[1,2,4],billing_mode:'relay'};
async function fixture(t){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hamster-relay-test-')),keyStore=createPiknoKeyStore(),calls=[];
  const client={context:async(cfg,kind)=>({user_id:kind==='image'&&cfg.piknoImageKey===videoKey?8:7,group:kind+'-standard'}),
    catalog:async()=>({data:[image,video,{id:'tool-depth',name:'仓鼠黑白深度视频',type:'video',provider:'tool',concurrency_options:[1],billing_mode:'relay'}],resolve:id=>[image,video,{id:'tool-depth',type:'video'}].find(line=>line.id===id)&&{id,kind:id===image.id?'image':'video',resolutions:id===image.id?['1024x1024']:['720p'],qualities:['auto'],ratios:['16:9'],durations:[5],max_images:3,max_videos:3,max_audio:3}}),
    quote:async(cfg,line,payload)=>syntheticQuote(quoteParameters(line,payload),line.kind==='image'?image.name:video.name),
    submit:async(cfg,line,payload)=>{calls.push({cfg,line,payload});return line.kind==='image'?{data:[{url:'https://result.test/output.png'}]}:{id:'task_123',status:'queued'};},
    query:async()=>({id:'task_123',status:'in_progress'}),upload:async()=>({file:{url:'https://www.piknoai.com/media/v1/assets/test?ticket=read'}})};
  const app=createApp({relayMode:true,relayClient:client,relayKeyStore:keyStore,configPath:path.join(dir,'config.json'),resultDir:path.join(dir,'results'),taskDir:path.join(dir,'tasks'),assetDir:path.join(dir,'assets'),smartVideoLauncher:{stop(){}},taskOptions:{tickMs:60000},inferenceGateway:{handle:async(req,res,url,key)=>{assert.equal(key,videoKey);res.setHeader('Content-Type','application/json');res.end('{"configured":true}');}}});
  await new Promise(resolve=>app.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{await new Promise(resolve=>app.close(resolve));fs.rmSync(dir,{recursive:true,force:true});});
  const base='http://127.0.0.1:'+app.address().port;
  const raw=(p,body,headers={})=>fetch(base+p,{method:body?'POST':'GET',headers:{'Content-Type':'application/json',...headers},...(body?{body:JSON.stringify(body)}:{})});
  const api=withQuotedApi(raw,{canQuote:route=>Boolean(keyStore.read()[route.startsWith('/api/tools/')?'piknoToolKey':route==='/api/images'?'piknoImageKey':'piknoVideoKey'])});
  return {dir,base,api,client,calls,keyStore,configure:()=>api('/api/config',{piknoImageKey:imageKey,piknoVideoKey:videoKey})};
}
test('relay keys are verified, never echoed or written to legacy config; foreign origins are blocked',async t=>{
  const f=await fixture(t);
  assert.equal((await f.api('/api/config',{piknoImageKey:imageKey},{Origin:'https://foreign.test'})).status,403);
  assert.equal((await f.api('/api/config',{piknoImageKey:imageKey},{'Sec-Fetch-Site':'cross-site'})).status,403);
  const response=await f.configure();assert.equal(response.status,200);assert.doesNotMatch(await response.text(),/sk-|user_id/);
  assert.equal(fs.existsSync(path.join(f.dir,'config.json')),false);
  assert.equal((await(await f.api('/api/config')).json()).relayMode,true);
  assert.equal((await f.api('/api/inference/status')).status,200);
  assert.equal((await f.api('/api/inference/status',undefined,{Origin:'https://foreign.test'})).status,403);
  assert.equal((await f.api('/api/uploads/status',undefined,{'Sec-Fetch-Site':'cross-site'})).status,403);
});

test('tool upload uses requested video authorization and cannot return an old-account ticket after disconnect',async t=>{
  const f=await fixture(t);await f.configure();let release,started;
  const waiting=new Promise(resolve=>release=resolve),entered=new Promise(resolve=>started=resolve);
  f.client.upload=async(cfg,data,metadata)=>{assert.equal(cfg.piknoVideoKey,videoKey);assert.equal(metadata.kind,'video');started();await waiting;return {file:{url:'old-authorized-url'}};};
  const upload=fetch(f.base+'/api/uploads/raw?use=video',{method:'POST',headers:{'Content-Type':'image/png'},body:Buffer.alloc(16)});
  await entered;await f.api('/api/relay/disconnect',{});release();
  const response=await upload;assert.equal(response.status,409);assert.doesNotMatch(await response.text(),/old-authorized/);
});
test('stored image for video or tools bypasses a revoked image Key and uses video authorization',async t=>{
  const f=await fixture(t);await f.configure();const seen=[];
  f.client.upload=async(cfg,data,metadata)=>{
    for await(const _ of data){}
    seen.push(metadata.kind);
    if(metadata.kind!=='video')throw Object.assign(Error('图片 Key 已失效'),{statusCode:401,publicMessage:'图片 Key 已失效'});
    assert.equal(cfg.piknoVideoKey,videoKey);
    return {file:{url:'https://www.piknoai.com/media/v1/assets/video-authorized?ticket=read'}};
  };
  const png=fs.readFileSync(path.join(__dirname,'../public/hamster-logo.png'));
  const imported=await(await fetch(f.base+'/api/assets/import?category=talent&name=portrait.png',{method:'POST',body:png})).json();
  assert.equal((await fetch(f.base+`/api/assets/${imported.id}/upload`,{method:'POST'})).status,401);
  const response=await fetch(f.base+`/api/assets/${imported.id}/upload?use=video`,{method:'POST'});
  assert.equal(response.status,200);assert.match((await response.json()).url,/video-authorized/);
  assert.deepEqual(seen,[undefined,'video']);
});
test('stored tool asset cannot return an old-account URL after disconnect',async t=>{
  const f=await fixture(t);await f.configure();let release,started;
  const waiting=new Promise(resolve=>release=resolve),entered=new Promise(resolve=>started=resolve);
  f.client.upload=async(_cfg,data,metadata)=>{assert.equal(metadata.kind,'video');started();await waiting;for await(const _ of data){}return {file:{url:'https://old-account.test/private'}};};
  const png=fs.readFileSync(path.join(__dirname,'../public/hamster-logo.png'));
  const imported=await(await fetch(f.base+'/api/assets/import?category=talent&name=portrait.png',{method:'POST',body:png})).json();
  const upload=fetch(f.base+`/api/assets/${imported.id}/upload?use=video`,{method:'POST'});
  await entered;await f.api('/api/relay/disconnect',{});release();
  const response=await upload;assert.notEqual(response.status,200);assert.doesNotMatch(await response.text(),/old-account/);
});
test('different customers cannot be combined; failed verification keeps existing Keys',async t=>{
  const f=await fixture(t);await f.configure();
  assert.equal((await f.api('/api/config',{piknoImageKey:videoKey,piknoVideoKey:videoKey})).status,409);
  assert.equal(f.keyStore.read().piknoImageKey,imageKey);
  f.client.context=async()=>{throw Object.assign(Error('Key 无效'),{statusCode:401});};
  assert.equal((await f.api('/api/config',{piknoVideoKey:videoKey})).status,401);
  assert.equal(f.keyStore.read().piknoImageKey,imageKey);
});
test('updating one Key preserves the other and validates the final account pair',async t=>{
  const f=await fixture(t);await f.configure();
  const replacement='sk-'+'c'.repeat(48);
  assert.equal((await f.api('/api/config',{piknoImageKey:replacement,piknoVideoKey:''})).status,200);
  assert.equal(f.keyStore.read().piknoImageKey,replacement);
  assert.equal(f.keyStore.read().piknoVideoKey,videoKey);
  assert.equal((await f.api('/api/config',{})).status,200);
  assert.equal((await f.api('/api/config',{piknoImageKey:videoKey})).status,409);
  assert.equal(f.keyStore.read().piknoImageKey,replacement);
});
for(const revoked of ['image','video','tool'])test('an invalid '+revoked+' Key can be removed atomically while valid Keys and history remain',async t=>{
  const f=await fixture(t),keys={piknoImageKey:imageKey,piknoVideoKey:videoKey,piknoToolKey:'sk-'+'t'.repeat(48)};
  await f.api('/api/config',keys);const original=f.keyStore.read(),field={image:'piknoImageKey',video:'piknoVideoKey',tool:'piknoToolKey'}[revoked];
  const before=f.client.context;
  f.client.context=async(cfg,kind)=>{if(kind===revoked&&cfg[field]===keys[field])throw Object.assign(Error('synthetic revoked key'),{statusCode:401});return before(cfg,kind);};
  const unchanged=await f.api('/api/config',{});assert.equal(unchanged.status,401);assert.deepEqual(f.keyStore.read(),original);
  const response=await f.api('/api/config',{['remove_'+revoked]:true});assert.equal(response.status,200);
  const retained=f.keyStore.read();assert.equal(retained[field],undefined);assert.equal(retained.piknoExecutionScope,original.piknoExecutionScope);
  for(const name of Object.keys(keys).filter(k=>k!==field))assert.equal(retained[name],keys[name]);
  const replacement='sk-'+'n'.repeat(48);assert.equal((await f.api('/api/config',{[field]:replacement})).status,200);assert.equal(f.keyStore.read()[field],replacement);
  assert.equal((await f.api('/api/config',{[field]:replacement,['remove_'+revoked]:true})).status,400);assert.equal(f.keyStore.read()[field],replacement);
  assert.doesNotMatch(await(await f.api('/api/config')).text(),/sk-|piknoExecutionScope/);
});
test('individual removal can remove the final Key without clearing saved results or task journals',async t=>{
  const f=await fixture(t);await f.api('/api/config',{piknoVideoKey:videoKey});
  await f.api('/api/videos',{model:video.id},{'Idempotency-Key':'preserve-single-remove'});
  const before=fs.readdirSync(path.join(f.dir,'tasks')).filter(name=>name.endsWith('.json'));
  assert.equal((await f.api('/api/config',{remove_video:true})).status,200);assert.deepEqual(f.keyStore.read(),{});
  assert.deepEqual(fs.readdirSync(path.join(f.dir,'tasks')).filter(name=>name.endsWith('.json')),before);
  await f.api('/api/config',{piknoVideoKey:videoKey});assert.equal((await(await f.api('/api/tasks')).json()).tasks.length,1);
});
test('connection detection is read-only, per-Key and never returns credentials, identities or prices',async t=>{
  const f=await fixture(t);
  const empty=await(await f.api('/api/relay/connection')).json();
  assert.equal(empty.image.state,'unconfigured');assert.equal(empty.video.state,'unconfigured');
  await f.configure();
  const original=JSON.stringify(f.keyStore.read());
  f.client.catalog=async cfg=>({data:[...(cfg.piknoImageKey?[image]:[]),...(cfg.piknoVideoKey?[video,{id:'tool-depth',type:'video',provider:'tool'}]:[])]});
  const check=await(await f.api('/api/relay/connection')).json();
  assert.equal(check.image.state,'ready');assert.equal(check.image.modelCount,1);
  assert.equal(check.video.modelCount,1);assert.deepEqual(check.tools,{digital:false,depth:true});
  assert.doesNotMatch(JSON.stringify(check),/sk-|user_id|piknoUserId|price|main-image|main-video/);
  assert.equal(JSON.stringify(f.keyStore.read()),original);assert.equal(f.calls.length,0);
  assert.equal((await f.api('/api/relay/connection',{})).status,405);
  assert.equal((await f.api('/api/relay/connection',undefined,{Origin:'https://foreign.test'})).status,403);
});
test('empty catalog is not reported ready; one failed Key does not hide the other connection',async t=>{
  const f=await fixture(t);await f.configure();
  f.client.catalog=async()=>({data:[]});
  let check=await(await f.api('/api/relay/connection')).json();
  assert.equal(check.image.state,'unavailable');assert.equal(check.image.connected,true);
  f.client.context=async(_cfg,kind)=>{if(kind==='video')throw Object.assign(Error('sk-private provider domain'),{statusCode:401});return {user_id:7};};
  f.client.catalog=async()=>({data:[image]});
  check=await(await f.api('/api/relay/connection')).json();
  assert.equal(check.image.state,'ready');assert.equal(check.video.state,'error');
  assert.doesNotMatch(JSON.stringify(check),/sk-private|provider domain/);assert.equal(f.calls.length,0);
});
test('disconnect invalidates a pending save instead of restoring removed Keys',async t=>{
  const f=await fixture(t);await f.configure();
  let release,started;
  const entered=new Promise(resolve=>{started=resolve;});
  const waiting=new Promise(resolve=>{release=resolve;});
  f.client.context=async()=>{started();await waiting;return {user_id:7};};
  const save=f.api('/api/config',{piknoImageKey:imageKey});
  await entered;assert.equal((await f.api('/api/relay/disconnect',{})).status,200);
  release();assert.equal((await save).status,409);assert.deepEqual(f.keyStore.read(),{});
});
test('disconnect invalidates a pending connection result',async t=>{
  const f=await fixture(t);await f.configure();
  let release,started;
  const entered=new Promise(resolve=>{started=resolve;});
  const waiting=new Promise(resolve=>{release=resolve;});
  f.client.context=async()=>{started();await waiting;return {user_id:7};};
  const check=f.api('/api/relay/connection');await entered;
  await f.api('/api/relay/disconnect',{});release();assert.equal((await check).status,409);
  assert.equal(f.calls.length,0);
});
test('changing configuration while loading a generation catalog cannot submit with the old Key',async t=>{
  const f=await fixture(t);await f.configure();
  let release,started;
  const entered=new Promise(resolve=>{started=resolve;});
  const waiting=new Promise(resolve=>{release=resolve;});
  const catalog=f.client.catalog;
  f.client.catalog=async cfg=>{started();await waiting;return catalog(cfg);};
  const submit=f.api('/api/videos',{model:video.id},{'Idempotency-Key':'config-change-request'});
  await entered;await f.api('/api/relay/disconnect',{});release();
  assert.equal((await submit).status,409);assert.equal(f.calls.length,0);
});
test('disconnect during a batch keeps the first task with its owner and stops additional paid submissions',async t=>{
  const f=await fixture(t);await f.configure();
  let release,started;
  const entered=new Promise(resolve=>{started=resolve;});
  const waiting=new Promise(resolve=>{release=resolve;});
  f.client.submit=async()=>{f.calls.push('submit');started();await waiting;return {id:'first_task',status:'queued'};};
  const submit=f.api('/api/videos',{model:video.id,concurrency:4},{'Idempotency-Key':'batch-disconnect-request'});
  await entered;await f.api('/api/relay/disconnect',{});release();
  const response=await submit;assert.equal(response.status,202);assert.equal((await response.json()).batch.quantity,4); // local acceptance precedes account change
  await new Promise(resolve=>setTimeout(resolve,30));
  assert.equal(f.calls.length,1);
  const files=fs.readdirSync(path.join(f.dir,'tasks')).filter(file=>file.endsWith('.json'));
  assert.equal(files.length,1);assert.equal(JSON.parse(fs.readFileSync(path.join(f.dir,'tasks',files[0]),'utf8')).walletUser,'pikno:7');
});
test('relay journal deduplicates local submissions and forbids changed body, without wallet prices',async t=>{
  const f=await fixture(t);await f.configure();
  const body={model:video.id,prompt:'test'},headers={'Idempotency-Key':'relay-request'};
  const response=await f.api('/api/videos',body,headers);assert.equal(response.status,202);
  const task=(await response.json()).task;assert.equal(task.status,'queued');
  await f.api('/api/videos',body,headers);assert.equal(f.calls.length,1);
  assert.equal((await f.api('/api/videos',{...body,prompt:'changed'},headers)).status,409);
  assert.doesNotMatch(await(await f.api('/api/tasks')).text(),/sk-|estimatedCost|chargedCost|synthetic-signed/);
});
test('sync image result uses a local completed ID and no remote image query',async t=>{
  const f=await fixture(t);await f.configure();
  const task=(await(await f.api('/api/images',{model:image.id,prompt:'test'},{'Idempotency-Key':'image-request'})).json()).task;
  assert.equal(task.status,'succeeded');assert.match(task.id,/^local_image_/);
  assert.doesNotMatch(JSON.stringify(task),/result\.test|sk-/);
  const stored=JSON.parse(fs.readFileSync(path.join(f.dir,'tasks',task.key+'.json'),'utf8'));
  assert.equal(stored.result.image_url,'https://result.test/output.png');assert.equal(stored.relaySynchronous,true);
  await f.api('/api/images',{model:image.id,prompt:'test'},{'Idempotency-Key':'image-request'});assert.equal(f.calls.length,1);
});
test('missing task ID and submission timeout remain UNKNOWN; same request never resubmits',async t=>{
  const f=await fixture(t);await f.configure();
  for(const response of [{status:'queued'},null]){
    f.client.submit=async()=>{f.calls.push('submit');if(response)return response;throw Object.assign(Error('timeout'),{statusCode:503,ambiguous:true});};
    const headers={'Idempotency-Key':response?'missing-task-id':'timeout-request'},body={model:video.id};
    const before=f.calls.length;
    const task=(await(await f.api('/api/videos',body,headers)).json()).task;assert.equal(task.status,'unknown');assert.equal(task.id,'');
    await f.api('/api/videos',body,headers);assert.equal(f.calls.length,before+1);
  }
});
test('an explicit balance rejection points to PIKNO recharge and stops unsent batch slots',async t=>{
  const f=await fixture(t);await f.configure();
  f.client.submit=async()=>{f.calls.push('submit');throw Object.assign(Error('synthetic private error'),{statusCode:402,code:'insufficient_balance'});};
  const response=await f.api('/api/videos',{model:video.id,concurrency:4},{'Idempotency-Key':'insufficient-balance-request'});
  const {settleBatch}=require('./support/batch.cjs'),result=await settleBatch(f.api,response);
  assert.equal(f.calls.length,1);assert.equal(result.task.status,'failed');assert.match(result.task.error,/PIKNO.*充值/);assert.match(result.stopped.message,/PIKNO.*充值/);assert.doesNotMatch(JSON.stringify(result),/synthetic private/);
});
test('old wallet and direct-provider endpoints are closed in relay mode',async t=>{
  const f=await fixture(t);await f.configure();
  for(const route of ['/api/billing/me','/api/billing/recharges','/rh/query','/api/official-videos'])assert.equal((await f.api(route,{})).status,410);
  assert.equal((await f.api('/api/me')).status,404);
  assert.equal(f.calls.length,0);
});
test('disconnect hides account tasks and preserves all saved journal data',async t=>{
  const f=await fixture(t);await f.configure();
  await f.api('/api/videos',{model:video.id},{'Idempotency-Key':'retain-request'});
  await f.api('/api/relay/disconnect',{});
  assert.equal((await(await f.api('/api/tasks')).json()).tasks.length,0);
  assert.equal(fs.readdirSync(path.join(f.dir,'tasks')).filter(file=>file.endsWith('.json')).length,1);
  assert.equal((await f.api('/api/models')).status,401);
  await f.configure();assert.equal((await(await f.api('/api/tasks')).json()).tasks.length,1);
});
test('protected Key store never falls back to cleartext and decrypts only with system protection',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hamster-key-test-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const file=path.join(dir,'relay.keys'),cipher={isEncryptionAvailable:()=>true,encryptString:value=>Buffer.from(value).map(byte=>byte^0x5a),decryptString:value=>Buffer.from(value).map(byte=>byte^0x5a).toString()};
  const store=createPiknoKeyStore({file,cipher});store.write({piknoUserId:7,piknoImageKey:imageKey});
  assert.doesNotMatch(fs.readFileSync(file).toString(),/sk-/);
  assert.equal(createPiknoKeyStore({file,cipher}).read().piknoImageKey,imageKey);
  cipher.isEncryptionAvailable=()=>false;
  assert.throws(()=>store.write({piknoUserId:8,piknoVideoKey:videoKey}),/保护不可用/);
  assert.equal(store.read().piknoUserId,7);
  assert.deepEqual(createPiknoKeyStore({file,cipher}).read(),{});
  store.clear();assert.equal(fs.existsSync(file),false);
});
