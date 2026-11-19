const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {Readable}=require('node:stream');
const {createPiknoBridge}=require('../pikno.cjs');
const {createApp}=require('../server.js');

const imageKey='sk-'+'a'.repeat(48),videoKey='sk-'+'b'.repeat(48),replacement='sk-'+'c'.repeat(48);
const fault=(statusCode,extra={})=>Object.assign(Error('synthetic private endpoint and credential must not escape'),{statusCode,...extra});
function fixture(initial={piknoUserId:7,piknoImageKey:imageKey,piknoVideoKey:videoKey}){
  let cfg={...initial},time=Date.parse('2026-10-22T08:00:00Z');
  const calls=[],client={context:async(value,kind)=>{calls.push(kind);return {user_id:7,group:kind+'-standard'};}};
  const keyStore={read:()=>({...cfg}),write:value=>{cfg={...value};},clear:()=>{cfg={};}};
  const bridge=createPiknoBridge({taskStore:()=>({}),client,keyStore,now:()=>time});
  return {bridge,client,keyStore,calls,advance:ms=>{time+=ms;},time:()=>time};
}
async function configure(bridge,body,route='/api/config'){
  const req=Readable.from([Buffer.from(JSON.stringify(body))]);
  req.method='POST';req.headers={host:'127.0.0.1:12345','content-type':'application/json'};
  const response={writeHead(status){this.status=status;},end(body){this.body=JSON.parse(body);}};
  await bridge.handle(req,response,new URL('http://127.0.0.1:12345'+route));
  return response;
}

test('video status checks only the video Key even when the configured image Key is rate limited',async()=>{
  const f=fixture();
  f.client.context=async(_cfg,kind)=>{f.calls.push(kind);if(kind==='image')throw fault(429);return {user_id:7};};
  const video=await f.bridge.check({kind:'video'});
  assert.equal(video.kind,'video');assert.equal(video.connected,true);assert.equal(video.state,'ready');
  assert.equal(video.httpStatus,200);assert.deepEqual(f.calls,['video']);
  const image=await f.bridge.check({kind:'image'});
  assert.equal(image.state,'rate_limited');assert.equal(image.httpStatus,429);assert.equal(image.connected,false);
  assert.deepEqual(f.calls,['video','image']);
});

test('missing kind retains the compatible priority and invalid or unconfigured kinds do not make remote requests',async()=>{
  const f=fixture();
  assert.equal((await f.bridge.check()).kind,'image');
  await assert.rejects(f.bridge.check({kind:'private/path'}),error=>error.statusCode===400);
  const tool=await f.bridge.check({kind:'tool'});
  assert.equal(tool.state,'unconfigured');assert.equal(tool.connected,false);assert.equal(tool.httpStatus,401);
  assert.deepEqual(f.calls,['image']);
});

test('same-kind checks share in-flight work and a successful result for fifteen seconds',async()=>{
  const f=fixture();let release;
  f.client.context=async()=>{f.calls.push('video');return new Promise(resolve=>release=resolve);};
  const first=f.bridge.check({kind:'video'}),second=f.bridge.check({kind:'video'});
  assert.equal(f.calls.length,1);release({user_id:7});
  const [a,b]=await Promise.all([first,second]);assert.deepEqual(a,b);
  assert.equal(a.checkedAt,new Date(f.time()).toISOString());assert.equal(a.lastSuccessAt,a.checkedAt);
  f.advance(14999);assert.deepEqual(await f.bridge.check({kind:'video'}),a);assert.equal(f.calls.length,1);
  f.advance(1);f.client.context=async()=>{f.calls.push('video');return {user_id:7};};
  assert.notEqual((await f.bridge.check({kind:'video'})).checkedAt,a.checkedAt);assert.equal(f.calls.length,2);
});

for(const [code,state] of [[401,'unauthorized'],[403,'forbidden'],[409,'account_mismatch'],[429,'rate_limited'],[500,'pending'],[503,'pending']]){
  test('status '+code+' is represented safely as '+state,async()=>{
    const f=fixture();f.client.context=async()=>{throw fault(code,{privateToken:imageKey,user_id:71});};
    const result=await f.bridge.check({kind:'video'});
    assert.equal(result.state,state);assert.equal(result.connected,false);assert.equal(result.retryAfterMs,10000);
    assert.equal(result.httpStatus,code>=500?503:code);
    assert.deepEqual(Object.keys(result).sort(),['checkedAt','connected','httpStatus','kind','retryAfterMs','state']);
    assert.doesNotMatch(JSON.stringify(result),/synthetic|endpoint|credential|private|sk-|user_id/);
  });
}

test('a mismatched account is confirmed without returning its identity',async()=>{
  const f=fixture();f.client.context=async()=>({user_id:8});
  const result=await f.bridge.check({kind:'video'});
  assert.equal(result.state,'account_mismatch');assert.equal(result.httpStatus,409);
  assert.doesNotMatch(JSON.stringify(result),/user_id|"8"/);
});

test('temporary errors preserve the last successful time and use bounded increasing retry delays',async()=>{
  const f=fixture();const ready=await f.bridge.check({kind:'video'});f.advance(15000);
  let failures=0;f.client.context=async()=>{failures++;throw Error('synthetic network timeout');};
  for(const delay of [10000,20000,40000,60000,60000]){
    const result=await f.bridge.check({kind:'video'});
    assert.equal(result.state,'pending');assert.equal(result.lastSuccessAt,ready.lastSuccessAt);assert.equal(result.retryAfterMs,delay);
    const before=failures;f.advance(delay-1);
    assert.equal((await f.bridge.check({kind:'video'})).retryAfterMs,1);assert.equal(failures,before);f.advance(1);
  }
  f.client.context=async()=>({user_id:7});const recovered=await f.bridge.check({kind:'video'});
  assert.equal(recovered.state,'ready');assert.equal(recovered.retryAfterMs,undefined);
  f.advance(15000);f.client.context=async()=>{throw fault(503);};
  assert.equal((await f.bridge.check({kind:'video'})).retryAfterMs,10000);
});

for(const [metadata,expected] of [[{retryAfterMs:120000},120000],[{retryMs:90000},90000],[{retryAfterMs:7200000},3600000],[{retryAfterMs:NaN,retryMs:-1},10000]]){
  test('service retry metadata is respected and clamped at '+expected+'ms',async()=>{
    const f=fixture();let calls=0;f.client.context=async()=>{calls++;throw fault(429,metadata);};
    assert.equal((await f.bridge.check({kind:'video'})).retryAfterMs,expected);
    f.advance(expected-1);assert.equal((await f.bridge.check({kind:'video'})).retryAfterMs,1);assert.equal(calls,1);
    f.advance(1);await f.bridge.check({kind:'video'});assert.equal(calls,2);
  });
}

test('replacing a same-account Key clears cached status and rejects a prior in-flight result',async()=>{
  const f=fixture({piknoUserId:7,piknoVideoKey:videoKey});let release;
  f.client.context=async(cfg,kind)=>{
    f.calls.push(cfg.piknoVideoKey===videoKey?'old':'new');
    if(cfg.piknoVideoKey===videoKey)return new Promise(resolve=>release=resolve);
    return {user_id:7,group:kind+'-standard'};
  };
  const pending=f.bridge.check({kind:'video'});const rejected=assert.rejects(pending,error=>error.statusCode===409);
  assert.equal((await configure(f.bridge,{piknoVideoKey:replacement})).status,200);
  const ready=await f.bridge.check({kind:'video'});assert.equal(ready.state,'ready');
  release({user_id:7});await rejected;
  assert.deepEqual(f.calls,['old','new','new']);assert.deepEqual(await f.bridge.check({kind:'video'}),ready);
});

test('saving configuration clears a previous successful status even for the same account',async()=>{
  const f=fixture({piknoUserId:7,piknoVideoKey:videoKey});
  await f.bridge.check({kind:'video'});assert.equal(f.calls.length,1);
  await configure(f.bridge,{piknoVideoKey:replacement});assert.equal(f.calls.length,2);
  await f.bridge.check({kind:'video'});assert.equal(f.calls.length,3);
});

test('a check started during configuration verification cannot cache the old Key after the write completes',async()=>{
  const f=fixture({piknoUserId:7,piknoVideoKey:videoKey});
  let verificationStarted,releaseVerification,releaseOld,firstNew=true;
  const entered=new Promise(resolve=>verificationStarted=resolve);
  f.client.context=async(cfg)=>{
    if(cfg.piknoVideoKey===videoKey)return new Promise(resolve=>releaseOld=resolve);
    if(firstNew){firstNew=false;verificationStarted();return new Promise(resolve=>releaseVerification=resolve);}
    return {user_id:7};
  };
  const saving=configure(f.bridge,{piknoVideoKey:replacement});await entered;
  const oldCheck=f.bridge.check({kind:'video'}),rejected=assert.rejects(oldCheck,error=>error.statusCode===409);
  releaseVerification({user_id:7});await saving;
  releaseOld({user_id:7});await rejected;
  assert.equal((await f.bridge.check({kind:'video'})).state,'ready');
});

test('disconnect rejects a pending check and does not restore its cached success',async()=>{
  const f=fixture();let release;
  f.client.context=async()=>new Promise(resolve=>release=resolve);
  const pending=f.bridge.check({kind:'video'}),rejected=assert.rejects(pending,error=>error.statusCode===409);
  await configure(f.bridge,{},'/api/relay/disconnect');
  assert.equal((await f.bridge.check({kind:'video'})).state,'unconfigured');
  release({user_id:7});await rejected;
  assert.equal((await f.bridge.check({kind:'video'})).state,'unconfigured');
});

test('a failed configuration verification also clears a previous cached success',async()=>{
  const f=fixture({piknoUserId:7,piknoVideoKey:videoKey});await f.bridge.check({kind:'video'});
  f.client.context=async()=>{throw fault(401);};
  await assert.rejects(configure(f.bridge,{piknoVideoKey:replacement}),error=>error.statusCode===401);
  assert.equal((await f.bridge.check({kind:'video'})).state,'unauthorized');
  assert.equal(f.keyStore.read().piknoVideoKey,videoKey);
});

async function serverFixture(t,options={}){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hamster-status-check-'));
  const f=fixture();
  const server=createApp({relayMode:true,relayClient:f.client,relayKeyStore:f.keyStore,configPath:path.join(dir,'config.json'),resultDir:path.join(dir,'results'),taskDir:path.join(dir,'tasks'),assetDir:path.join(dir,'assets'),smartVideoLauncher:{stop(){}},...options});
  for(;;){await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));if(server.address().port>10080)break;await new Promise(resolve=>server.close(resolve));}
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));fs.rmSync(dir,{recursive:true,force:true});});
  return {...f,base:'http://127.0.0.1:'+server.address().port};
}

test('HTTP status checks accept only fixed kinds and preserve structured state, status and retry headers',async t=>{
  const f=await serverFixture(t);
  f.client.context=async(_cfg,kind)=>{f.calls.push(kind);if(kind==='image')throw fault(429,{retryAfterMs:120123});return {user_id:7};};
  const response=await fetch(f.base+'/api/uploads/status?kind=video');assert.equal(response.status,200);
  assert.equal((await response.json()).state,'ready');assert.deepEqual(f.calls,['video']);
  const limited=await fetch(f.base+'/api/uploads/status?kind=image');assert.equal(limited.status,429);
  assert.equal(limited.headers.get('Retry-After'),'121');assert.equal(limited.headers.get('Cache-Control'),'no-store');
  const body=await limited.json();assert.equal(body.state,'rate_limited');assert.ok(body.retryAfterMs>0&&body.retryAfterMs<=120123);
  const invalid=await fetch(f.base+'/api/uploads/status?kind=https://private.invalid');assert.equal(invalid.status,400);
  assert.deepEqual(f.calls,['video','image']);
});

test('legacy boolean media checker keeps its original response semantics',async t=>{
  let connected=true;
  const f=await serverFixture(t,{relayMode:false,mediaChecker:async()=>({connected,service:'synthetic-media'})});
  const response=await fetch(f.base+'/api/uploads/status');assert.equal(response.status,200);
  assert.deepEqual(await response.json(),{connected:true,service:'synthetic-media'});
  connected=false;
  const failed=await fetch(f.base+'/api/uploads/status');assert.equal(failed.status,503);
  assert.deepEqual(await failed.json(),{connected:false,service:'synthetic-media'});
});
