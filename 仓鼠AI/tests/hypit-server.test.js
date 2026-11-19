const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {createApp}=require('../server.js');
const {localRequest}=require('../hypit.cjs');

async function fixture(t,{enabled=true}={}){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hamster-hypit-http-')),calls=[];
  const runtime={status:()=>({state:'ready'}),listProjects:()=>[{id:'project-a',label:'测试项目'}],projectDirectory:id=>{assert.equal(id,'project-a');return path.join(dir,id);},
    prepareProject:async({label})=>{calls.push('create');return {projectId:'project-a',label};},startStudio:async()=>{calls.push('open');return {projectId:'project-a',url:'http://127.0.0.1:52109/'};},stop:()=>calls.push('stop'),dispose:()=>calls.push('dispose')};
  const video={catalog:async()=>({data:[],revision:2}),list:async()=>[],quote:async body=>{calls.push('quote');return {requestId:'receipt-a',...body};},confirm:async body=>{calls.push('confirm');return body;},start:async body=>{calls.push('start');return body;},poll:async requestId=>({requestId,state:'unknown'})};
  const app=createApp({relayMode:true,configPath:path.join(dir,'config.json'),taskDir:path.join(dir,'tasks'),assetDir:path.join(dir,'assets'),resultDir:path.join(dir,'results'),diagnosticsDir:path.join(dir,'diagnostics'),smartVideoLauncher:{stop(){}},hypitOptions:{enabled,runtime,video}});
  await new Promise(resolve=>app.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${app.address().port}`;
  t.after(async()=>{app.closeAllConnections?.();await new Promise(resolve=>app.close(resolve));fs.rmSync(dir,{recursive:true,force:true});});
  const api=(route,body,headers={})=>fetch(base+'/api/hypit'+route,{method:body===undefined?'GET':'POST',headers:{...(body===undefined?{}:{'Content-Type':'application/json',Origin:base}),...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});
  return {api,calls,dir,base};
}
test('Hypit is a separate internal module; status is read-only and GPT stays gated',async t=>{
  const f=await fixture(t),data=await(await f.api('/status')).json();
  assert.equal(data.enabled,true);assert.equal(data.internalOnly,true);assert.equal(data.account.loginAvailable,false);assert.equal(data.agent.available,false);
  assert.equal(data.projects[0].name,'测试项目');assert.deepEqual(f.calls,[]);assert.equal(fs.existsSync(path.join(f.dir,'tasks')),false);
  assert.equal((await f.api('/account/login',{})).status,409);assert.deepEqual(f.calls,[]);
});
test('public build disables Hypit without loading a runtime or exposing hidden operations',async t=>{
  const f=await fixture(t,{enabled:false});assert.deepEqual(await(await f.api('/status')).json(),{enabled:false,internalOnly:true});
  assert.equal((await f.api('/projects',{name:'public'})).status,404);assert.equal((await f.api('/video/models')).status,404);assert.deepEqual(f.calls,[]);
  const {builder}=require('../release/current.json');assert.ok(!builder.files.some(name=>name.startsWith('hypit')));assert.ok(!builder.extraResources.some(item=>JSON.stringify(item).includes('hypit')));
});
test('local UI writes require exact origin; cross-site status and provider attempts to confirm fail',async t=>{
  const f=await fixture(t);
  assert.equal((await f.api('/status',undefined,{Origin:'https://evil.test'})).status,403);
  assert.equal((await f.api('/projects',{name:'x'},{'Sec-Fetch-Site':'cross-site'})).status,403);
  assert.equal((await fetch(f.base+'/api/hypit/projects',{method:'POST',headers:{'Content-Type':'application/json'},body:'{"name":"x"}'})).status,403);
  assert.equal(localRequest({headers:{host:'evil.test',origin:'http://evil.test'}}),false);
  assert.equal((await f.api('/projects',{name:'x'})).status,201);assert.deepEqual(f.calls,['create']);
});
test('opening Studio never confirms or starts video; video quote and confirmation remain separate',async t=>{
  const f=await fixture(t);assert.equal((await f.api('/studio/open',{projectId:'project-a'})).status,200);assert.deepEqual(f.calls,['open']);
  await f.api('/video/quote',{projectId:'project-a',operationId:'shot-one'});assert.deepEqual(f.calls,['open','quote']);
  await f.api('/video/confirm',{requestId:'receipt-a',confirmed:true});assert.deepEqual(f.calls,['open','quote','confirm']);
  assert.equal((await f.api('/video/operations/receipt-a')).status,200);assert.deepEqual(f.calls,['open','quote','confirm']);
});
test('malformed JSON, invalid project and excessive input fail before project or video writes',async t=>{
  const f=await fixture(t);
  assert.equal((await f.api('/projects',{name:''})).status,400);
  const bad=await fetch(f.base+'/api/hypit/projects',{method:'POST',headers:{Origin:f.base,'Content-Type':'application/json'},body:'['});assert.equal(bad.status,400);
  const large=await f.api('/projects',{name:'x'.repeat(70000)});assert.equal(large.status,413);assert.deepEqual(f.calls,[]);
});
