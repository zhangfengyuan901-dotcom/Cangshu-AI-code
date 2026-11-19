const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createApp}=require('../server.js');
const fields={image:'piknoImageKey',video:'piknoVideoKey',tool:'piknoToolKey',chat:'piknoChatKey'};
async function fixture(t,{protectedStore=true}={}){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'hamster-native-server-')),calls=[];let stored={};
  const store={persistent:protectedStore,read:()=>({...stored}),write:value=>{stored={...value};},clear:()=>{stored={};}};
  const client={context:async(cfg,kind)=>{calls.push('context');const key=cfg[fields[kind]];return {user_id:key.includes('other')?13:12,group:kind+'-standard'};},catalog:async()=>{calls.push('catalog');return {data:[]};},subscribeCatalog:()=>()=>{}};
  const server=createApp({relayMode:true,relayClient:client,relayKeyStore:store,configPath:path.join(root,'config.json'),resultDir:path.join(root,'results'),taskDir:path.join(root,'tasks'),assetDir:path.join(root,'assets'),diagnosticsDir:path.join(root,'diagnostics'),diagnosticExportDir:path.join(root,'exports'),smartVideoLauncher:{stop(){}},hypitOptions:{enabled:false},chatcutOptions:{enabled:false}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>{server.closeAllConnections();server.close();fs.rmSync(root,{recursive:true,force:true});});
  return {server,client,calls,store,stored:()=>stored,base:'http://127.0.0.1:'+server.address().port};
}
const input=(kind='image',key=kind)=>({group:kind+'-standard',userId:12,key:'sk-'+key.padEnd(32,'a')});
test('native-only configuration merges keys and returns only flags through local HTTP',async t=>{
  const f=await fixture(t);
  assert.equal(f.server.getConnectedRelayAccountId(),null);
  for(const kind of ['image','video','tool'])assert.deepEqual(await f.server.connectCreatedRelayKey(input(kind),{assertCurrent:()=>true}),{ok:true,code:'SAVED_CHECK_PENDING',connected:false});
  assert.equal(Object.keys(f.stored()).filter(key=>Object.values(fields).includes(key)).length,3);
  assert.equal(f.stored().piknoUserId,12);
  assert.equal(f.server.getConnectedRelayAccountId(),12);
  const state=await(await fetch(f.base+'/api/config')).json();
  assert.equal(state.configured,true);assert.equal(state.videoConfigured,true);assert.equal(state.toolConfigured,true);
  assert.doesNotMatch(JSON.stringify(state),/sk-|piknoUserId/);
  assert.ok(f.calls.every(value=>['context','catalog'].includes(value)));
});
test('native handoff refuses unprotected mode, cross-account identity and invalidated contexts',async t=>{
  const memory=await fixture(t,{protectedStore:false});assert.equal((await memory.server.connectCreatedRelayKey(input())).code,'KEY_STORAGE_UNAVAILABLE');assert.deepEqual(memory.stored(),{});
  const f=await fixture(t);
  assert.equal((await f.server.connectCreatedRelayKey(input('image','other'))).code,'ACCOUNT_MISMATCH');assert.deepEqual(f.stored(),{});
  assert.equal((await f.server.connectCreatedRelayKey(input(),{assertCurrent:()=>false})).code,'ACCOUNT_CHANGED');assert.deepEqual(f.stored(),{});
});

test('native 429 distinguishes unsaved Key from saved pending detection and never replaces old config on rejection',async t=>{
  const f=await fixture(t);await f.server.connectCreatedRelayKey(input());const before={...f.stored()};
  const context=f.client.context;f.client.context=async()=>{throw Object.assign(Error('private'),{statusCode:429,retryAfterMs:120000});};
  assert.deepEqual(await f.server.connectCreatedRelayKey(input('video')),{ok:false,code:'RATE_LIMITED',httpStatus:429,retryAfterMs:120000});assert.deepEqual(f.stored(),before);
  const response=await fetch(f.base+'/api/config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({piknoVideoKey:input('video').key})});
  assert.equal(response.status,429);assert.equal(response.headers.get('retry-after'),'120');assert.equal((await response.json()).retryAfterMs,120000);assert.deepEqual(f.stored(),before);
  f.client.context=context;f.client.catalog=async()=>{throw Object.assign(Error('private'),{statusCode:429,retryAfterMs:120000});};
  const started=Date.now(),pending=await f.server.connectCreatedRelayKey(input('video'));assert.deepEqual({...pending,retryAfterMs:120000},{ok:true,code:'SAVED_CHECK_PENDING',connected:false,httpStatus:429,retryAfterMs:120000});assert.ok(pending.retryAfterMs<=120000&&pending.retryAfterMs>=120000-(Date.now()-started)-10);assert.equal(f.stored().piknoVideoKey,input('video').key);
});

test('native verification failures preserve HTTP status and old Keys without mistaking network failures for protected storage',async t=>{
  const f=await fixture(t);await f.server.connectCreatedRelayKey(input());const before={...f.stored()};
  for(const [httpStatus,code] of [[401,'KEY_INVALID'],[403,'KEY_FORBIDDEN'],[409,'ACCOUNT_MISMATCH'],[502,'CONNECT_FAILED'],[503,'CONNECT_FAILED']]){
    f.client.context=async()=>{throw Object.assign(Error('private customer sk-secret C:/private/keys.bin'),{statusCode:httpStatus});};
    const result=await f.server.connectCreatedRelayKey(input('video'));
    assert.deepEqual(result,{ok:false,code,httpStatus});assert.deepEqual(f.stored(),before);
    assert.doesNotMatch(JSON.stringify(result),/private|customer|sk-secret|keys\.bin/);
  }
  f.client.context=async()=>({user_id:12,group:'video-standard'});
  f.store.write=()=>{throw Object.assign(Error('private storage path'),{statusCode:503,code:'KEY_STORAGE_UNAVAILABLE'});};
  assert.deepEqual(await f.server.connectCreatedRelayKey(input('video')),{ok:false,code:'KEY_STORAGE_UNAVAILABLE',httpStatus:503});
  assert.deepEqual(f.stored(),before);
});

test('native verification accepts only bounded integer status and safely handles unknown throws',async t=>{
  const f=await fixture(t);await f.server.connectCreatedRelayKey(input());const before={...f.stored()};
  for(const failure of [null,undefined,'private customer sk-secret',{statusCode:'503'},{statusCode:99},{statusCode:600},{statusCode:503.5},{statusCode:Infinity},{statusCode:NaN}]){
    f.client.context=async()=>{throw failure;};
    assert.deepEqual(await f.server.connectCreatedRelayKey(input('video')),{ok:false,code:'CONNECT_FAILED'});
    assert.deepEqual(f.stored(),before);
  }
  f.client.context=async()=>{throw {status:503,details:'private'};};
  assert.deepEqual(await f.server.connectCreatedRelayKey(input('video')),{ok:false,code:'CONNECT_FAILED',httpStatus:503});
});
