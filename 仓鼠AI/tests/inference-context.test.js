const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {createApp}=require('../server.js');
const {createPiknoKeyStore}=require('../pikno-key-store.cjs');
const first='sk-'+'a'.repeat(48),second='sk-'+'b'.repeat(48);
async function fixture(t,gateway) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hamster-inference-scope-')),store=createPiknoKeyStore();
  const app=createApp({relayMode:true,relayKeyStore:store,relayClient:{context:async()=>({user_id:7,group:'chat-standard'}),catalog:async()=>({data:[]})},inferenceGateway:gateway,
    configPath:path.join(dir,'config.json'),resultDir:path.join(dir,'results'),taskDir:path.join(dir,'tasks'),assetDir:path.join(dir,'assets'),smartVideoLauncher:{stop(){}}});
  await new Promise(resolve=>app.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{await new Promise(resolve=>app.close(resolve));fs.rmSync(dir,{recursive:true,force:true});});
  const base='http://127.0.0.1:'+app.address().port;
  const call=(route,body,headers={})=>fetch(base+route,{method:body?'POST':'GET',headers:{'content-type':'application/json',...headers},...(body?{body:JSON.stringify(body)}:{})});
  await call('/api/config',{piknoChatKey:first});
  return {call};
}
test('local context exposes only opaque scope and revision; stale and missing scope cannot infer',async t=>{
  const calls=[],f=await fixture(t,{handle:async(req,res,url,key,options)=>{options.assertCurrent();calls.push(key);res.end('{}');}});
  const context=await(await f.call('/api/inference/context')).json();
  assert.deepEqual(Object.keys(context).sort(),['configured','revision','scope']);assert.match(context.scope,/^[a-f0-9]{64}$/);assert.equal(context.configured,true);
  const headers={'X-Hamster-Execution-Scope':context.scope,'X-Hamster-Config-Revision':String(context.revision)};
  assert.equal((await f.call('/api/inference/api/v3/responses',{})).status,409);
  assert.equal((await f.call('/api/inference/api/v3/responses',{},headers)).status,200);assert.deepEqual(calls,[first]);
  await f.call('/api/config',{piknoChatKey:second});
  const next=await(await f.call('/api/inference/context')).json();assert.equal(next.scope,context.scope);assert.notEqual(next.revision,context.revision);
  assert.equal((await f.call('/api/inference/api/v3/responses',{},headers)).status,409);assert.equal(calls.length,1);
  assert.equal((await f.call('/api/inference/context',undefined,{Origin:'https://foreign.test'})).status,403);
});
test('an in-flight local inference request keeps its original Key and fails after configuration change',async t=>{
  let entered,release;const ready=new Promise(r=>entered=r),gate=new Promise(r=>release=r),keys=[];
  const f=await fixture(t,{handle:async(req,res,url,key,options)=>{keys.push(key);entered();await gate;options.assertCurrent();res.end('{}');}});
  const context=await(await f.call('/api/inference/context')).json();
  const pending=f.call('/api/inference/api/v3/files',{}, {'X-Hamster-Execution-Scope':context.scope,'X-Hamster-Config-Revision':String(context.revision)});
  await ready;await f.call('/api/config',{piknoChatKey:second});release();assert.equal((await pending).status,409);assert.deepEqual(keys,[first]);
});
test('only an exact local broker code-state pair exposes rejected-before-execution to the SDK',async t=>{
 let patch={code:'llm_rejected_before_execution',submissionState:'rejected_before_execution'};
 const f=await fixture(t,{handle:async(req,res,url,key,options)=>{options.assertCurrent();throw Object.assign(Error('safe local message'),{statusCode:503,...patch});}});
 const context=await(await f.call('/api/inference/context')).json();
 const headers={'X-Hamster-Execution-Scope':context.scope,'X-Hamster-Config-Revision':String(context.revision)};
 const response=await f.call('/api/inference/api/v3/responses',{},headers);assert.equal(response.status,503);
 const body=await response.json();assert.equal(body.code,'llm_rejected_before_execution');assert.equal(body.submission_state,'rejected_before_execution');
 for(const value of [{code:'llm_rejected_before_execution'},{submissionState:'rejected_before_execution'},{code:'llm_unknown',submissionState:'rejected_before_execution'}]){
  patch=value;const result=await(await f.call('/api/inference/api/v3/responses',{},headers)).json();assert.notEqual(result.submission_state,'rejected_before_execution');assert.notEqual(result.code,'llm_rejected_before_execution');
 }
});
