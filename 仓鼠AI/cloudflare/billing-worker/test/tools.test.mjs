import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {fixture} from './fixture.mjs';
import {one,all,run,crypt,signedUrl} from '../src/common.mjs';
import {quote,publicModel,createTask,claimKey,settle,finishFailure} from '../src/billing.mjs';
import {submitTask,pollTask,transferTask} from '../src/providers.mjs';
import {adminRead,adminWrite} from '../src/admin.mjs';

test('free depth works at zero balance and produces a zero ledger, never a refund simulation',async t=>{
 const {env,user}=await fixture(t,0),model=await one(env,"SELECT * FROM models WHERE id='tool-depth'");
 assert.equal(publicModel(model).free,true);assert.equal(publicModel(model).provider,'tool');
 const payload={model:model.id,prompt:'黑白深度',videos:[{url:'https://fixture.test/file.mp4'}]};
 assert.equal(quote(model,payload).reserved,0);
 const task=await createTask(env,user,payload,'free-depth-request');
 await run(env,"UPDATE tasks SET state='transferring' WHERE id=?",task.id);
 await env.RESULTS.put('result/free','video');await settle(env,task.id,'result/free');await settle(env,task.id,'result/free');
 assert.deepEqual(await one(env,"SELECT balance,held FROM customers WHERE id='user'"),{balance:0,held:0});
 const ledger=await all(env,'SELECT * FROM ledger');assert.equal(ledger.length,2);assert.ok(ledger.every(r=>r.amount===0&&r.balance_delta===0&&r.held_delta===0));
 assert.throws(()=>quote({...model,id:'main-image-a'},payload),/价格未发布/);
});
test('missing or paused channel keys reject before reserve; service activation requires both video channels',async t=>{
 const {env,user,payload}=await fixture(t);
 await run(env,'DELETE FROM provider_keys');
 await assert.rejects(()=>createTask(env,user,payload,'missing-key-request'),/未配置/);
 assert.equal((await all(env,'SELECT * FROM tasks')).length,0);assert.equal((await all(env,'SELECT * FROM ledger')).length,0);
 await assert.rejects(()=>adminWrite(env,'admin','generation-switch',{enabled:true,reason:'测试启用'}),/主线路和官方备选线路/);
 await adminWrite(env,'admin','pool',{account_id:'default-backup',name:'test',secret:'fixture-backup-secret',reason:'测试添加'});
 const pool=await adminRead(env,'pool');assert.doesNotMatch(JSON.stringify(pool),/fixture-backup-secret|encrypted_secret/);
 await run(env,"UPDATE provider_keys SET status='paused'");
 await assert.rejects(()=>createTask(env,user,payload,'paused-key-request'),/停用/);
});
test('schema migration preserves active task quotes, leases, customer balance and ledger',async t=>{
 const {env,user,payload}=await fixture(t,100000000,3);
 const task=await createTask(env,user,payload,'before-migration');await claimKey(env,task.id);
 const before=await one(env,"SELECT balance,held FROM customers WHERE id='user'"),oldQuote=task.quote_json;
 const sql=fs.readFileSync(new URL('../migrations/0004_confirmed_tool_prices.sql',import.meta.url),'utf8');
 await env.DB.batch(sql.split(/(?=^(?:CREATE|INSERT|PRAGMA|ALTER|DROP|UPDATE) )/m).filter(s=>s.trim()).map(s=>env.DB.prepare(s.trim())));
 assert.deepEqual(await one(env,"SELECT balance,held FROM customers WHERE id='user'"),before);
 assert.equal((await one(env,'SELECT * FROM tasks WHERE id=?',task.id)).quote_json,oldQuote);
 assert.equal((await all(env,'SELECT * FROM key_leases')).length,1);assert.equal((await all(env,'PRAGMA foreign_key_check')).length,0);
 await finishFailure(env,task.id,'confirmed failure');assert.equal((await one(env,"SELECT held FROM customers WHERE id='user'")).held,0);
});
test('digital is exactly five yuan and cloud tool upload, polling, R2 delivery settle once',async t=>{
 const {env,user}=await fixture(t),origin='https://billing.example.com';
 // The Node-to-Miniflare RPC bridge cannot preserve a Response body's known length.
 // Convert only at the fixture boundary; production streams the upstream Response into R2.
 const bucket=env.RESULTS;env.RESULTS={head:bucket.head.bind(bucket),get:bucket.get.bind(bucket),put:async(key,data,options)=>bucket.put(key,data?.getReader?await new Response(data).arrayBuffer():data,options)};
 for(const [key,type]of [['person.png','image/png'],['voice.wav','audio/wav']])await env.RESULTS.put('input/user/'+key,'fixture',{httpMetadata:{contentType:type}});
 const payload={model:'tool-digital',prompt:'数字人视频',images:[{url:await signedUrl(env,origin,'input/user/person.png')}],audios:[{url:await signedUrl(env,origin,'input/user/voice.wav'),durationSeconds:12}]};
 const model=await one(env,"SELECT * FROM models WHERE id='tool-digital'");assert.equal(quote(model,payload).reserved,5000000);
 assert.throws(()=>quote(model,{...payload,audios:[{...payload.audios[0],durationSeconds:31}]}),/30秒/);
 await run(env,"UPDATE provider_keys SET encrypted_secret=? WHERE provider='tool'",await crypt(env.KEY_ENCRYPTION_SECRET,'fixture-tool-secret'));
 const task=await createTask(env,user,payload,'tool-e2e-request');await claimKey(env,task.id);
 const original=globalThis.fetch,calls=[];globalThis.fetch=async(url,o={})=>{
 calls.push({url:String(url),o});
 if(String(url).endsWith('/media/upload/binary')){assert.ok(o.body.getReader);const bytes=await new Response(o.body).arrayBuffer();assert.equal(bytes.byteLength,Number(o.headers['Content-Length']));assert.match(new TextDecoder().decode(bytes),/name="file"/);return Response.json({code:0,data:{fileName:'file-'+calls.length}});}
 if(String(url).includes('/run/ai-app/')){assert.deepEqual(JSON.parse(o.body).nodeInfoList.map(n=>n.nodeId),['133','125']);return Response.json({taskId:'tool-job',status:'QUEUED',errorCode:0});}
 if(String(url).endsWith('/query'))return Response.json({taskId:'tool-job',status:'SUCCESS',results:[{url:'https://cdn.example.com/result.mp4'}]});
 if(String(url)==='https://cdn.example.com/result.mp4'){assert.equal(o.headers.Authorization,undefined);return new Response('fixture-video',{headers:{'content-type':'video/mp4'}});}
 throw Error('unexpected fixture request');};
 try{await submitTask(env,task.id);await submitTask(env,task.id);await pollTask(env,task.id);assert.equal((await one(env,'SELECT charged FROM tasks WHERE id=?',task.id)).charged,0);await transferTask(env,task.id);await transferTask(env,task.id);}finally{globalThis.fetch=original;}
 assert.equal(calls.filter(c=>c.url.includes('/run/ai-app/')).length,1);
 assert.equal((await one(env,'SELECT charged FROM tasks WHERE id=?',task.id)).charged,5000000);
 assert.equal((await one(env,"SELECT balance FROM customers WHERE id='user'")).balance,95000000);
});
