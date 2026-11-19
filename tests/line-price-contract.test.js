const {settleBatch}=require('./support/batch.cjs');
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createApp}=require('../server.js'),{createPiknoClient}=require('../pikno-client.cjs'),{createPiknoKeyStore}=require('../pikno-key-store.cjs');
const imageKey='sk-'+'i'.repeat(48),videoKey='sk-'+'v'.repeat(48),toolKey='sk-'+'t'.repeat(48);
const line={id:'pikno-video-private-id',name:'PIKNO 已发布视频产品',kind:'video',line_revision:7,resolutions:['720p'],ratios:['16:9'],durations:[4,8],max_images:2,max_videos:1,max_audio:1,prices:[{resolution:'720p',unit:'second',retail_cny:'0.125',cost_cny:'0.001'}],reference_surcharge_cny:'0.05',provider:'private-vendor',channel_id:99};
const digital={id:'pikno-tool-digital',name:'PIKNO 口播产品',kind:'video',line_revision:7,resolutions:['default'],ratios:[],durations:[],max_images:1,max_videos:0,max_audio:1};
const asset='https://www.piknoai.com/media/v1/assets/'+'a'.repeat(32)+'?ticket=synthetic-read-only';
const money=n=>(n/1000000).toFixed(6).replace(/0+$/,'').replace(/\.$/,'');
async function fixture(t){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hamster-quote-')),keyStore=createPiknoKeyStore(),quotes=[],submits=[];
  const lines=[structuredClone(line),structuredClone(digital)];let mode='ok',pendingQuote,releaseQuote,pendingSubmit,releaseSubmit;
  const client=createPiknoClient({fetchImpl:async(target,init)=>{
    const route=new URL(target).pathname,auth=new Headers(init.headers).get('authorization');
    if(route==='/v1/client/context')return Response.json({user_id:7,group:auth.includes(toolKey)?'tool-standard':auth.includes(imageKey)?'image-standard':'video-standard'});
    if(route==='/api/pikno/catalog')return Response.json({data:{models:lines}});
    if(route==='/v1/models')return Response.json({data:[{id:auth.includes(toolKey)?digital.id:line.id}]});
    if(route==='/v1/client/quote'){
      const p=JSON.parse(init.body);quotes.push({p,auth});
      if(pendingQuote)await pendingQuote;
      const m=lines.find(m=>m.id===p.model),units=p.operation==='video'?p.seconds:1,unit=p.operation==='video'?'second':'request',unitPrice=p.operation==='video'?125000:5000000,surcharge=p.reference_images&&p.operation==='video'?50000:0;
      return Response.json({success:true,data:{quote_id:'signed-synthetic-quote-'+quotes.length,name:m.name,line_revision:m.line_revision,currency:'CNY',unit,unit_price_cny:money(unitPrice),units,reference_surcharge_cny:money(surcharge),per_item_cny:money(unitPrice*units+surcharge),quantity:p.quantity,total_cny:money((unitPrice*units+surcharge)*p.quantity),expires_at:Math.floor(Date.now()/1000)+300}});
    }
    if(route==='/v1/videos'||route==='/v1/tools/digital'){
      const headers=new Headers(init.headers);submits.push({body:JSON.parse(init.body),quote:headers.get('X-PIKNO-Quote'),index:headers.get('X-PIKNO-Quote-Index'),auth});
      if(pendingSubmit)await pendingSubmit;
      if(mode==='changed'||mode==='changed-second'&&submits.length===2)return Response.json({error:{code:'quote_changed',message:'private body never shown'}},{status:409});
      if(mode==='unknown')throw Error('private network detail');
      if(mode==='body-unknown'||mode==='body-failed')return Response.json({id:'synthetic_task_'+submits.length,status:mode==='body-unknown'?'unknown':'failed'});
      return Response.json({id:'synthetic_task_'+submits.length,status:'queued'});
    }
    throw Error('Unexpected offline fixture request');
  }});
  let app,base;
  const start=async()=>{app=createApp({relayMode:true,relayClient:client,relayKeyStore:keyStore,configPath:path.join(dir,'config.json'),resultDir:path.join(dir,'results'),taskDir:path.join(dir,'tasks'),assetDir:path.join(dir,'assets'),smartVideoLauncher:{stop(){}},taskOptions:{tickMs:600000}});await new Promise(resolve=>app.listen(0,'127.0.0.1',resolve));base='http://127.0.0.1:'+app.address().port;};
  await start();
  t.after(async()=>{await new Promise(resolve=>app.close(resolve));fs.rmSync(dir,{recursive:true,force:true});});
  const api=(route,body,headers={})=>fetch(base+route,{method:body?'POST':'GET',headers:{'Content-Type':'application/json',...headers},...(body?{body:JSON.stringify(body)}:{})});
  const config=await api('/api/config',{piknoVideoKey:videoKey,piknoToolKey:toolKey});assert.equal(config.status,200);
  const models=(await(await api('/api/models')).json()).data,model=models.find(m=>m.provider==='generate');
  const payload={model:model.id,duration:4,resolution:'720p',ratio:'16:9',prompt:'synthetic private prompt',concurrency:1,images:[],videos:[],audios:[]};
  const quote=async(p=payload)=>{const r=await api('/api/quotes',p);assert.equal(r.status,200);return (await r.json()).quote;};
  return {api,quotes,submits,lines,models,payload,quote,mode:value=>mode=value,hold:()=>{pendingQuote=new Promise(resolve=>releaseQuote=resolve);},release:()=>releaseQuote(),holdSubmit:()=>{pendingSubmit=new Promise(resolve=>releaseSubmit=resolve);},releaseSubmit:()=>releaseSubmit(),restart:async()=>{await new Promise(resolve=>app.close(resolve));await start();}};
}
test('published names and retail fields pass through while private routing and cost remain absent',async t=>{
  const f=await fixture(t),m=f.models.find(m=>m.provider==='generate');
  assert.equal(m.name,line.name);assert.deepEqual(m.prices,[{resolution:'720p',unit:'second',retail_cny:'0.125'}]);assert.equal(m.line_revision,7);
  assert.doesNotMatch(JSON.stringify(f.models),/private-vendor|private-id|channel_id|cost_cny|0\.001|sk-/);
});
test('readonly quote uses only measurements, exact batch total, and never exposes signed credentials',async t=>{
  const f=await fixture(t),q=await f.quote({...f.payload,concurrency:4,media_counts:{images:1,videos:0,audios:0}});
  assert.equal(f.submits.length,0);assert.equal((await(await f.api('/api/tasks')).json()).tasks.length,0);
  assert.equal(q.total_cny,'2.2');assert.equal(q.per_item_cny,'0.55');assert.equal(q.quantity,4);assert.equal(q.name,line.name);
  assert.doesNotMatch(JSON.stringify(q),/signed-synthetic|sk-|private-id|prompt|ticket|channel|cost/);
  assert.equal(f.quotes[0].p.reference_images,1);assert.equal(f.quotes[0].p.prompt,undefined);assert.equal(f.quotes[0].p.images,undefined);
});
test('missing quote, changed duration, changed quantity and changed media counts fail before generation',async t=>{
  const f=await fixture(t),q=await f.quote();
  assert.equal((await f.api('/api/videos',f.payload,{'Idempotency-Key':'no-quote'})).status,428);
  for(const patch of [{duration:8},{concurrency:2},{images:[{url:asset}]}]){
    const r=await f.api('/api/videos',{...f.payload,quote_id:q.id,...patch},{'Idempotency-Key':'changed-parameter-'+JSON.stringify(patch).length});
    assert.equal(r.status,409);assert.equal((await r.json()).code,'quote_parameters_changed');
  }
  assert.equal(f.submits.length,0);
});
test('one confirmed quote sends the signed context and each slot once; repeated request returns original tasks',async t=>{
  const f=await fixture(t),p={...f.payload,concurrency:4},q=await f.quote(p),body={...p,quote_id:q.id},headers={'Idempotency-Key':'batch-identity'};
  const a=await f.api('/api/videos',body,headers);assert.equal(a.status,202);const first=await settleBatch(f.api,a);assert.equal(first.tasks.length,4);
  assert.deepEqual(f.submits.map(s=>s.index),['0','1','2','3']);assert.ok(f.submits.every(s=>s.quote==='signed-synthetic-quote-1'));
  const b=await(await f.api('/api/videos',body,headers)).json();assert.deepEqual(b.tasks.map(t=>t.id),first.tasks.map(t=>t.id));assert.equal(f.submits.length,4);
  assert.equal(first.tasks[0].modelName,line.name);assert.equal(first.tasks[0].priceSnapshot.total_cny,'2');
  assert.doesNotMatch(JSON.stringify(first),/signed-synthetic|sk-/);
  const reused=await f.api('/api/videos',body,{'Idempotency-Key':'new-identity'});assert.equal(reused.status,409);assert.equal(f.submits.length,4);
});
test('directory reprice or expiry cannot charge an already confirmed old quote',async t=>{
  const f=await fixture(t),q=await f.quote();f.lines[0].line_revision++;
  const changed=await f.api('/api/videos',{...f.payload,quote_id:q.id},{'Idempotency-Key':'directory-changed'});assert.equal(changed.status,409);assert.equal((await changed.json()).code,'quote_changed');assert.equal(f.submits.length,0);
  const current=await f.quote(),now=Date.now;t.after(()=>Date.now=now);Date.now=()=>now()+360000;
  const expired=await f.api('/api/videos',{...f.payload,quote_id:current.id},{'Idempotency-Key':'expired-quote'});Date.now=now;
  assert.equal(expired.status,409);assert.equal((await expired.json()).code,'quote_expired');assert.equal(f.submits.length,0);
});
test('a configuration change invalidates both a saved quote and an in-flight readonly quote',async t=>{
  const f=await fixture(t),q=await f.quote();f.hold();const pending=f.api('/api/quotes',f.payload);
  while(f.quotes.length<2)await new Promise(resolve=>setTimeout(resolve,1));
  await f.api('/api/config',{piknoVideoKey:videoKey});f.release();assert.equal((await pending).status,409);
  const result=await f.api('/api/videos',{...f.payload,quote_id:q.id},{'Idempotency-Key':'old-account-quote'});assert.equal(result.status,428);assert.equal(f.submits.length,0);
});
test('server-side reprice stops the rest of a batch and never automatically requotes or resubmits',async t=>{
  const f=await fixture(t),p={...f.payload,concurrency:4},q=await f.quote(p);f.mode('changed-second');
  const r=await f.api('/api/videos',{...p,quote_id:q.id},{'Idempotency-Key':'reprice-mid-batch'});assert.equal(r.status,202);
  const data=await settleBatch(f.api,r);assert.equal(data.stopped.code,'quote_changed');assert.equal(f.submits.length,2);assert.equal(f.quotes.length,1);
  assert.doesNotMatch(JSON.stringify(data),/private body/);
});
test('a first-slot quote rejection durably stops the same batch identity even after service recovery',async t=>{
  const f=await fixture(t),p={...f.payload,concurrency:4},q=await f.quote(p),body={...p,quote_id:q.id},headers={'Idempotency-Key':'first-slot-reprice'};f.mode('changed');
  const first=await f.api('/api/videos',body,headers);assert.equal(first.status,202);assert.equal((await settleBatch(f.api,first)).stopped.code,'quote_changed');assert.equal(f.submits.length,1);
  f.mode('ok');const again=await f.api('/api/videos',body,headers);assert.equal(again.status,202);assert.equal((await again.json()).stopped.code,'quote_changed');assert.equal(f.submits.length,1);
});
test('an unknown paid response stops the batch and the same identity only queries original records',async t=>{
  const f=await fixture(t),p={...f.payload,concurrency:4},q=await f.quote(p),body={...p,quote_id:q.id};f.mode('unknown');
  const data=await settleBatch(f.api,await f.api('/api/videos',body,{'Idempotency-Key':'unknown-batch'}));assert.equal(data.task.status,'unknown');assert.equal(f.submits.length,1);
  const retry=await f.api('/api/videos',body,{'Idempotency-Key':'unknown-batch'});assert.equal(retry.status,202);assert.equal(f.submits.length,1);
});
test('a fresh bridge and task journal reload the stopped batch without submitting its remaining slots',async t=>{
  const f=await fixture(t),p={...f.payload,concurrency:4},q=await f.quote(p),body={...p,quote_id:q.id},headers={'Idempotency-Key':'restart-unknown-batch'};f.mode('unknown');
  await settleBatch(f.api,await f.api('/api/videos',body,headers));assert.equal(f.submits.length,1);await f.restart();f.mode('ok');
  const restored=await f.api('/api/videos',body,headers);assert.equal(restored.status,202);const data=await restored.json();assert.equal(data.task.status,'unknown');assert.ok(data.stopped);assert.equal(f.submits.length,1);assert.equal(data.tasks.length,1);
});
test('concurrent confirmations of the same batch identity cannot start another paid slot',async t=>{
  const f=await fixture(t),p={...f.payload,concurrency:4},q=await f.quote(p),body={...p,quote_id:q.id},headers={'Idempotency-Key':'concurrent-confirmation'};f.holdSubmit();
  const first=f.api('/api/videos',body,headers);while(f.submits.length<1)await new Promise(resolve=>setTimeout(resolve,1));
  const duplicate=await f.api('/api/videos',body,headers);assert.equal(duplicate.status,202);assert.equal((await duplicate.json()).batch.status,'running');assert.equal(f.submits.length,1);
  f.releaseSubmit();assert.equal((await first).status,202);await settleBatch(f.api,await f.api('/api/videos',body,headers));assert.deepEqual(f.submits.map(s=>s.index),['0','1','2','3']);
});
for(const mode of ['body-unknown','body-failed'])test(`a successful HTTP response with ${mode} still stops and durably blocks the remaining batch`,async t=>{
  const f=await fixture(t),p={...f.payload,concurrency:4},q=await f.quote(p),body={...p,quote_id:q.id},headers={'Idempotency-Key':'body-status-batch'};f.mode(mode);
  const first=await settleBatch(f.api,await f.api('/api/videos',body,headers));assert.equal(first.tasks.length,1);assert.ok(first.stopped);assert.equal(f.submits.length,1);
  const again=await(await f.api('/api/videos',body,headers)).json();assert.equal(again.tasks.length,1);assert.equal(again.task.id,first.task.id);assert.equal(f.submits.length,1);
  const records=(await(await f.api('/api/tasks')).json()).tasks;assert.equal(records.length,1);assert.equal(records[0].status,mode==='body-unknown'?'unknown':'failed');
});
test('tools use the shared tool Key, retain PIKNO name, and bind exact reference types',async t=>{
  const f=await fixture(t),p={model:'tool-digital',concurrency:1,media_counts:{images:1,videos:0,audios:1}},q=await f.quote(p);
  const body={model:'tool-digital',quote_id:q.id,concurrency:1,images:[{url:asset}],audios:[{url:asset,durationSeconds:2}],videos:[]};
  const r=await f.api('/api/tools/digital',body,{'Idempotency-Key':'tool-confirmed'});assert.equal(r.status,202);assert.equal((await r.json()).task.modelName,digital.name);
  assert.equal(f.submits[0].auth,'Bearer '+toolKey);assert.equal(q.total_cny,'5');
});
