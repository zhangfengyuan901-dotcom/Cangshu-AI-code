const {settleBatch}=require('./support/batch.cjs');
// Independent offline audit of concurrency and persisted batch stopping.
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createApp}=require('../server.js'),{createPiknoClient}=require('../pikno-client.cjs'),{createPiknoKeyStore}=require('../pikno-key-store.cjs');
async function fixture(t){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hamster-quote-audit-')),keyStore=createPiknoKeyStore(),submits=[],quoteReads=[];
  const line={id:'pikno-audit-private-video',name:'已发布审计视频线路',kind:'video',line_revision:3,resolutions:['720p'],ratios:['16:9'],durations:[4],max_images:0,max_videos:0,max_audio:0,prices:[{resolution:'720p',unit:'second',retail_cny:'0.10'}]};
  let mode='success',entered,release,gate;
  const client=createPiknoClient({fetchImpl:async(target,init)=>{
    const route=new URL(target).pathname;
    if(route==='/v1/client/context')return Response.json({user_id:7,group:'video-standard'});
    if(route==='/api/pikno/catalog')return Response.json({data:{models:[line]}});
    if(route==='/v1/models')return Response.json({data:[{id:line.id}]});
    if(route==='/v1/client/quote'){quoteReads.push(JSON.parse(init.body));return Response.json({success:true,data:{quote_id:'opaque-signed-synthetic-audit-context',name:line.name,line_revision:3,currency:'CNY',unit:'second',unit_price_cny:'0.10',units:4,reference_surcharge_cny:'0',per_item_cny:'0.40',quantity:4,total_cny:'1.60',expires_at:Math.floor(Date.now()/1000)+300}});}
    if(route==='/v1/videos'){
      submits.push({index:new Headers(init.headers).get('X-PIKNO-Quote-Index'),signed:new Headers(init.headers).get('X-PIKNO-Quote')});
      if(mode==='hold'&&submits.length===1){entered();await gate;}
      if(mode==='unknown')throw Error('synthetic upstream connection lost');
      return Response.json({id:'audit_task_'+submits.length,status:'queued'});
    }
    throw Error('offline audit unexpected route');
  }});
  const appOptions={relayMode:true,relayClient:client,relayKeyStore:keyStore,openBrowserImpl:()=>{},configPath:path.join(dir,'config.json'),resultDir:path.join(dir,'results'),taskDir:path.join(dir,'tasks'),assetDir:path.join(dir,'assets'),smartVideoLauncher:{stop(){}},taskOptions:{tickMs:600000}};
  let app,base;
  const start=async()=>{app=createApp(appOptions);await new Promise(resolve=>app.listen(0,'127.0.0.1',resolve));base='http://127.0.0.1:'+app.address().port;};
  const stop=async()=>{if(app){await new Promise(resolve=>app.close(resolve));app=null;}};
  t.after(async()=>{await stop();fs.rmSync(dir,{recursive:true,force:true});});await start();
  const api=(route,body,key)=>fetch(base+route,{method:body?'POST':'GET',headers:{'Content-Type':'application/json',...(key?{'Idempotency-Key':key}:{})},...(body?{body:JSON.stringify(body)}:{})});
  assert.equal((await api('/api/config',{piknoVideoKey:'sk-'+'v'.repeat(48)})).status,200);
  const models=(await(await api('/api/models')).json()).data,payload={model:models[0].id,prompt:'synthetic test',duration:4,resolution:'720p',ratio:'16:9',concurrency:4,images:[],videos:[],audios:[]};
  const quote=(await(await api('/api/quotes',payload)).json()).quote;
  return {dir,api,submits,quoteReads,body:{...payload,quote_id:quote.id},restart:async()=>{await stop();await start();},mode:value=>mode=value,hold:()=>{mode='hold';gate=new Promise(resolve=>release=resolve);return new Promise(resolve=>entered=resolve);},release:()=>release()};
}
test('concurrent copies of one confirmed batch use each paid slot at most once',async t=>{
  const f=await fixture(t),entered=f.hold(),first=f.api('/api/videos',f.body,'audit-same-request');await entered;
  const second=await f.api('/api/videos',f.body,'audit-same-request');assert.equal(second.status,202);const pending=await second.json();assert.equal(pending.tasks.length,1);assert.equal(pending.batch.status,'running');assert.equal(f.submits.length,1);
  f.release();const completed=await first;assert.equal(completed.status,202);assert.equal((await settleBatch(f.api,completed)).tasks.length,4);assert.deepEqual(f.submits.map(s=>s.index),['0','1','2','3']);assert.equal(f.quoteReads.length,1);
  assert.equal((await f.api('/api/videos',f.body,'audit-same-request')).status,202);assert.equal(f.submits.length,4);
});
test('recreated bridge loads the durable stopped batch and never resumes unknown remaining slots',async t=>{
  const f=await fixture(t);f.mode('unknown');const first=await settleBatch(f.api,await f.api('/api/videos',f.body,'audit-stopped-request'));assert.equal(first.tasks.length,1);assert.equal(first.task.status,'unknown');assert.equal(f.submits.length,1);
  const persisted=fs.readdirSync(path.join(f.dir,'tasks')).filter(file=>file.endsWith('.json')).map(file=>fs.readFileSync(path.join(f.dir,'tasks',file),'utf8')).join('\n');assert.match(persisted,/relayBatchStopped/);assert.doesNotMatch(persisted,/opaque-signed-synthetic|sk-v{48}/);
  f.mode('success');await f.restart();const again=await f.api('/api/videos',f.body,'audit-stopped-request');assert.equal(again.status,202);const result=await again.json();assert.equal(result.tasks.length,1);assert.equal(result.task.status,'unknown');assert.ok(result.stopped);assert.equal(f.submits.length,1);assert.equal(f.quoteReads.length,1);assert.doesNotMatch(JSON.stringify(result),/opaque-signed-synthetic|sk-v{48}/);
});
test('clear, restart and a fresh quote cannot erase a no-ID unknown receipt or submit it again',async t=>{
  const f=await fixture(t);f.mode('unknown');
  const first=await settleBatch(f.api,await f.api('/api/videos',f.body,'uncertain-clear-request'));
  assert.equal(first.task.status,'unknown');assert.equal(first.task.id,'');
  const cleared=await f.api('/api/tasks',undefined);assert.equal((await cleared.json()).tasks.length,1);
  // Call DELETE explicitly; normal API helper only selects GET/POST.
  const files=fs.readdirSync(path.join(f.dir,'tasks')).filter(name=>name.endsWith('.json'));assert.equal(files.length,1);
  const {createTasks}=require('../tasks.cjs');
  const journal=createTasks({dir:path.join(f.dir,'tasks'),resultDir:path.join(f.dir,'results'),walletUser:()=> 'pikno:7',relayMode:true});
  const req={method:'DELETE'},res={writeHead(){},end(){}};
  await journal.handle(req,res,new URL('http://127.0.0.1/api/tasks'));
  assert.equal(journal.list().length,1);assert.equal(journal.list()[0].status,'unknown');
  f.mode('success');await f.restart();
  const payload={...f.body};delete payload.quote_id;
  const quote=(await(await f.api('/api/quotes',payload)).json()).quote;
  assert.equal((await f.api('/api/videos',{...payload,quote_id:quote.id},'uncertain-clear-request')).status,409);
  const restored=await(await f.api('/api/videos',f.body,'uncertain-clear-request')).json();assert.equal(restored.task.status,'unknown');assert.equal(f.submits.length,1);
});
test('a four-slot batch is accepted before its first response; durable stop prevents every unsent POST',async t=>{
  const f=await fixture(t),entered=f.hold();
  const first=await Promise.race([f.api('/api/videos',f.body,'explicit-stop-request'),new Promise((_,reject)=>setTimeout(()=>reject(Error('local acceptance was blocked')),800))]);
  assert.equal(first.status,202);const accepted=await first.json();await entered;
  assert.equal(accepted.task.status,'submitting');assert.equal(accepted.batch.quantity,4);
  const stopped=await f.api('/api/relay/batches/'+accepted.batch.id+'/stop',{});assert.equal(stopped.status,200);assert.equal((await stopped.json()).batch.status,'stopped');
  f.release();
  const {until}=require('./support/batch.cjs');
  await until(async()=>{const data=await(await f.api('/api/tasks')).json();return data.tasks[0]?.id==='audit_task_1';});
  assert.equal(f.submits.length,1);
  await f.restart();const replay=await(await f.api('/api/videos',f.body,'explicit-stop-request')).json();
  assert.equal(replay.batch.status,'stopped');assert.equal(replay.tasks.length,1);assert.equal(f.submits.length,1);
  const saved=fs.readdirSync(path.join(f.dir,'tasks','batches')).map(name=>fs.readFileSync(path.join(f.dir,'tasks','batches',name),'utf8')).join('');
  assert.doesNotMatch(saved,/opaque-signed|sk-v{48}|synthetic test/);
});
