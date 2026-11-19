const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createApp}=require('../server');
const token='ha_'+'a'.repeat(64),user='user_'+'b'.repeat(32);
const model={id:'main-video-720',name:'主线路 · 标准720P',type:'video',provider:'generate',resolutions:['720p'],durations:[4],ratios:['16:9'],max_media_files:0,price_credits:15};
test('wallet journal hides legacy provider fields without rewriting the saved task',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hamster-legacy-view-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const journal=require('../tasks.cjs').createTasks({dir,resultDir:dir,walletQuery:async()=>{},getKey:()=>''});
 const item=journal.begin('/api/videos',{model:'sd_2_5_once_720p',prompt:'keep user prompt'},'','legacy-request');
 journal.annotate(item,{error:'VideoFee https://supplier.example/internal',result:{download_url:'https://supplier.example/result',save_error:'raw provider text'}});
 const visible=journal.list()[0];assert.equal(visible.modelId,'legacy-video');assert.equal(visible.prompt,'keep user prompt');
 assert.doesNotMatch(JSON.stringify(visible),/sd_2_5|VideoFee|supplier\.example|raw provider/);
 const saved=JSON.parse(fs.readFileSync(path.join(dir,item.key+'.json')));assert.equal(saved.modelId,'sd_2_5_once_720p');assert.equal(saved.result.download_url,'https://supplier.example/result');
});
async function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hamster-wallet-test-')),configPath=path.join(dir,'config.json'),calls=[];
 const client={request:async(cfg,route,options={})=>{
  calls.push({cfg,route,options});
  if(route==='/v1/auth/code')return {challenge_id:'otp_test',expires_in:600};
  if(route==='/v1/auth/verify')return {token,user_id:user,email:'fixture@example.com'};
  if(route==='/v1/auth/logout')return {ok:true};
  if(route==='/v1/models')return {data:[model,{id:'tool-depth',name:'黑白深度',type:'video',provider:'tool',free:true,price_credits:0},{id:'tool-digital',name:'数字人',type:'video',provider:'tool',price_credits:5}]};
  if(route==='/v1/tasks')return {id:'task_123',status:'queued',estimated_cost:15,cost:0};
  if(route.startsWith('/v1/tasks/'))return {id:'task_123',status:'processing',estimated_cost:15,cost:0};
  if(route==='/v1/me')return {email:'fixture@example.com',email_verified:true,balance:10};
  throw Error('Unexpected route '+route);
 },upload:async()=>({file:{url:'https://fixture.example/input'}})};
 const app=createApp({walletMode:true,walletClient:client,configPath,resultDir:path.join(dir,'results'),assetDir:path.join(dir,'assets'),taskDir:path.join(dir,'tasks'),smartVideoLauncher:{stop(){}},taskOptions:{tickMs:60000},inferenceGateway:{handle:async(req,res,url,key)=>{assert.equal(key,token);res.setHeader('Content-Type','application/json');res.end('{"configured":true}');}}});
 await new Promise(r=>app.listen(0,'127.0.0.1',r));t.after(async()=>{await new Promise(r=>app.close(r));fs.rmSync(dir,{recursive:true,force:true});});
 const base='http://127.0.0.1:'+app.address().port;
 const api=(p,body,headers={})=>fetch(base+p,{method:body?'POST':'GET',headers:{'Content-Type':'application/json',...headers},...(body?{body:JSON.stringify(body)}:{})});
 return {api,calls,configPath,client,async login(){return api('/api/billing/auth/verify',{email:'fixture@example.com',code:'123456'});}};
}
test('email bridge keeps bearer on local backend, denies cross-origin, and logs out without deleting old data',async t=>{
 const f=await fixture(t);fs.writeFileSync(f.configPath,JSON.stringify({apiKey:'legacy-preserved'}));
 const denied=await f.api('/api/billing/auth/verify',{}, {Origin:'https://foreign.example'});assert.equal(denied.status,403);
 const login=await f.login();assert.equal(login.status,200);assert.doesNotMatch(await login.text(),/ha_|token|user_id/);
 assert.equal(JSON.parse(fs.readFileSync(f.configPath)).billingApiKey,token);
 assert.equal((await(await f.api('/api/config')).json()).billingConfigured,true);
 assert.equal((await f.api('/api/config',{apiKey:'forbidden'})).status,405);
 assert.equal((await f.api('/api/me')).status,404);
 assert.equal((await f.api('/api/inference/status')).status,200);
 await f.api('/api/billing/auth/logout',{});const cfg=JSON.parse(fs.readFileSync(f.configPath));assert.equal(cfg.apiKey,'legacy-preserved');assert.equal(cfg.billingApiKey,undefined);
 assert.equal((await f.api('/api/models')).status,401);
});
test('wallet submit is idempotent locally, rejects changed payload, never exposes account bearer',async t=>{
 const f=await fixture(t);await f.login();const payload={model:model.id,prompt:'hello',duration:4,resolution:'720p',ratio:'16:9'},headers={'Idempotency-Key':'same-request'};
 const response=await f.api('/api/videos',payload,headers);assert.equal(response.status,202);const accepted=await response.json();assert.equal(accepted.accepted,true);const task=accepted.task;assert.equal(task.modelName,model.name);
 await f.api('/api/videos',payload,headers);assert.equal(f.calls.filter(c=>c.route==='/v1/tasks').length,1);
 assert.equal((await f.api('/api/videos',{...payload,prompt:'changed'},headers)).status,409);
 const tasks=await(await f.api('/api/tasks')).text();assert.doesNotMatch(tasks,/ha_[a-f0-9]|legacy-preserved/);
 await f.api('/api/billing/auth/logout',{});assert.deepEqual((await(await f.api('/api/tasks')).json()).tasks,[]);
 assert.equal((await f.api('/api/tasks/'+task.key+'/file')).status,404);
});
test('ambiguous submission is looked up by request without sending a new chargeable request',async t=>{
 const f=await fixture(t);await f.login();const original=f.client.request;f.client.request=async(cfg,p,o)=>{if(p==='/v1/tasks'){f.calls.push({route:p});throw Object.assign(Error('unknown'),{statusCode:503});}return original(cfg,p,o);};
 const body={model:model.id,prompt:'hello'},headers={'Idempotency-Key':'uncertain-request'};
 const data=await(await f.api('/api/videos',body,headers)).json();assert.match(data.task.id,/^pending_/);
 await f.api('/api/videos',body,headers);assert.equal(f.calls.filter(c=>c.route==='/v1/tasks').length,1);
});

test('tool wallet routes require login, keep aliases and source, and cannot use ordinary video routes',async t=>{
 const f=await fixture(t),body={model:'tool-depth',prompt:'黑白深度',videos:[{url:'https://fixture.test/input.mp4'}]},headers={'Idempotency-Key':'tool-depth-request'};
 assert.equal((await f.api('/api/tools/depth',body,headers)).status,401);await f.login();
 assert.equal((await f.api('/api/videos',body,headers)).status,400);
 assert.equal((await f.api('/api/tools/digital',body,headers)).status,400);
 const task=(await(await f.api('/api/tools/depth',body,headers)).json()).task;
 assert.equal(task.modelId,'tool-depth');assert.equal(task.source,'depth');assert.equal(task.provider,'tool');
 await f.api('/api/tools/depth',body,headers);assert.equal(f.calls.filter(c=>c.route==='/v1/tasks').length,1);
 const old=await f.api('/rh/run/ai-app/legacy',{},headers);assert.equal(old.status,410);
});
