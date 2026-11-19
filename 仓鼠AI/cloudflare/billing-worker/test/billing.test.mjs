import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {createTask,claimKey,finishFailure,settle,quote} from '../src/billing.mjs';
import {one,all,run,hash,units,crypt,signedUrl,authenticate} from '../src/common.mjs';
import {adminWrite} from '../src/admin.mjs';
import {applyUpstream,submitTask,validateReferences} from '../src/providers.mjs';
import {requestCode,verifyCode} from '../src/auth.mjs';
import {drainMail} from '../src/mail.mjs';

import {fixture} from './fixture.mjs';
test('D1 concurrent holds cannot overspend; same request reserves once',async t=>{
 const {env,user,payload}=await fixture(t,10000000);
 const outcomes=await Promise.allSettled(Array.from({length:20},(_,i)=>createTask(env,user,payload,'request-'+i)));
 assert.equal(outcomes.filter(x=>x.status==='fulfilled').length,3);const wallet=await one(env,"SELECT * FROM customers WHERE id='user'");assert.equal(wallet.held,8250000);assert.equal(wallet.balance,10000000);
 const first=outcomes.find(x=>x.status==='fulfilled').value;const repeat=await createTask(env,user,payload,first.request_id);assert.equal(first.id,repeat.id);
 await assert.rejects(()=>createTask(env,user,{...payload,prompt:'different'},first.request_id),/不能更换/);
});
test('confirmed failure releases once; unknown retains the hold',async t=>{
 const {env,user,payload}=await fixture(t);const task=await createTask(env,user,payload,'failure-request');await run(env,"UPDATE tasks SET state='unknown' WHERE id=?",task.id);
 assert.equal((await one(env,"SELECT held FROM customers WHERE id='user'")).held,2750000);
 await finishFailure(env,task.id,'failed');await finishFailure(env,task.id,'duplicate');assert.equal((await one(env,"SELECT held FROM customers WHERE id='user'")).held,0);
 assert.equal((await all(env,"SELECT * FROM ledger WHERE kind='release'")).length,1);
});
test('R2 delivery is required; duplicate success settles once and freezes are released',async t=>{
 const {env,user,payload}=await fixture(t);const task=await createTask(env,user,payload,'success-request');
 await assert.rejects(()=>settle(env,task.id,'result/missing'),/尚未/);
 await run(env,"UPDATE tasks SET state='transferring' WHERE id=?",task.id);await env.RESULTS.put('result/test',new Uint8Array([1,2,3]));
 await Promise.all([settle(env,task.id,'result/test'),settle(env,task.id,'result/test')]);
 const wallet=await one(env,"SELECT balance,held FROM customers WHERE id='user'");assert.deepEqual(wallet,{balance:97250000,held:0});assert.equal((await all(env,"SELECT * FROM ledger WHERE kind='settle'")).length,1);
 await adminWrite(env,'admin','refund',{id:task.id,reason:'测试退回钱包'});await adminWrite(env,'admin','refund',{id:task.id,reason:'重复操作测试'});
 assert.equal((await one(env,"SELECT balance FROM customers WHERE id='user'")).balance,100000000);assert.equal((await all(env,"SELECT * FROM ledger WHERE kind='refund'")).length,1);
});
test('one key never exceeds 100 leases and shared account cap applies across keys',async t=>{
 const {env,user,payload}=await fixture(t,1000000000);
 await run(env,'DELETE FROM provider_keys');
 await run(env,"INSERT INTO provider_accounts VALUES ('account','backup','shared',100)");
 for(const key of ['a','b'])await run(env,'INSERT INTO provider_keys(id,account_id,provider,name,encrypted_secret,fingerprint,preview,created_at) VALUES (?,?,?,?,?,?,?,0)',key,'account','backup',key,'unused',key,key);
 const tasks=[];for(let i=0;i<105;i++)tasks.push(await createTask(env,user,payload,'pool-request-'+i));
 await Promise.all(tasks.map(task=>claimKey(env,task.id)));const leases=await all(env,'SELECT * FROM key_leases');assert.equal(leases.length,100);for(const key of ['a','b'])assert.ok(leases.filter(l=>l.key_id===key).length<=100);
 const waiting=await all(env,"SELECT * FROM tasks WHERE state='queued'");assert.equal(waiting.length,5);await finishFailure(env,tasks[0].id,'done');assert.ok(await claimKey(env,waiting[0].id));
});
test('recharge review verifies amount and payment reference, never credits twice',async t=>{
 const {env}=await fixture(t,0);await run(env,"INSERT INTO recharges(id,user_id,email_snapshot,amount,request_id,created_at) VALUES ('r1','user','test@example.com',10000000,'r1-request',0)");
 await assert.rejects(()=>adminWrite(env,'admin','recharge-review',{id:'r1',approve:true,transaction_id:'payment123',confirmed_amount:'9',reason:'核对到账'}),/金额/);
 const p={id:'r1',approve:true,manual_confirmed:true,transaction_id:'payment123',confirmed_amount:'10',received_at:Date.now()-1000,reason:'核实支付宝到账'};await adminWrite(env,'admin','recharge-review',p);await adminWrite(env,'admin','recharge-review',p);
 assert.equal((await one(env,"SELECT balance FROM customers WHERE id='user'")).balance,10000000);
 await run(env,"INSERT INTO recharges(id,user_id,email_snapshot,amount,request_id,created_at) VALUES ('r2','user','test@example.com',10000000,'r2-request',0)");
 await assert.rejects(()=>adminWrite(env,'admin','recharge-review',{...p,id:'r2'}));assert.equal((await one(env,"SELECT balance FROM customers WHERE id='user'")).balance,10000000);
});
test('success without URL cannot charge; stale callback cannot overwrite settled state',async t=>{
 const {env,user,payload}=await fixture(t);const task=await createTask(env,user,payload,'url-request');await run(env,"UPDATE tasks SET state='processing',upstream_id='up1' WHERE id=?",task.id);
 await assert.rejects(()=>applyUpstream(env,task,{status:'success',id:'up1'}),/未返回结果/);assert.equal((await one(env,"SELECT held FROM customers WHERE id='user'")).held,2750000);
 await applyUpstream(env,task,{status:'success',id:'up1',result_url:'https://cdn.example.com/video.mp4'});await env.RESULTS.put('result/delivered','x');await settle(env,task.id,'result/delivered');await applyUpstream(env,task,{status:'failed',id:'up1'});
 assert.equal((await one(env,'SELECT state FROM tasks WHERE id=?',task.id)).state,'succeeded');
});
test('pricing uses confirmed wallet prices with no inherited markup',async t=>{
 const {env,payload}=await fixture(t);const video=await one(env,"SELECT * FROM models WHERE id='backup-video-480'");assert.equal(quote(video,payload).reserved,2750000);
 const image=await one(env,"SELECT * FROM models WHERE kind='image'");assert.equal(quote(image,{prompt:'image'}).reserved,100000);
 assert.equal(units('0.55'),550000);assert.throws(()=>units('-1'));assert.throws(()=>quote(video,{...payload,resolution:'720p'}));
 const snap=quote(video,payload);video.cost_rate=900000;assert.equal(snap.reserved,2750000);
 assert.throws(()=>quote(video,{...payload,price_version:video.version+1}),/售价已更新/);
 assert.equal(quote(video,{...payload,price_version:video.version}).reserved,2750000);
});

test('email-only accounts cannot obtain manually issued sessions or bypass verification',async t=>{
 const {env}=await fixture(t);
 const created=await adminWrite(env,'admin','customers',{email:'invited@example.com',name:'Invited',reason:'邀请客户'});
 assert.deepEqual(Object.keys(created),['user_id']);
 assert.equal((await all(env,'SELECT * FROM api_keys WHERE user_id=?',created.user_id)).length,0);
 await assert.rejects(()=>adminWrite(env,'admin','keys',{user_id:created.user_id,reason:'测试限制'}),/邮箱验证码/);
 await assert.rejects(()=>adminWrite(env,'admin','key-action',{id:'client',action:'rotate',reason:'测试限制'}),/重新验证邮箱/);
 await run(env,"UPDATE customers SET email_verified_at=NULL WHERE id='user'");
 await assert.rejects(()=>authenticate(new Request('https://fixture/v1/me',{headers:{Authorization:'Bearer ha_fixture'}}),env),/邮箱验证码/);
});
test('upstream submission ambiguity is not retried after a worker restart',async t=>{
 const {env,user,payload}=await fixture(t);await run(env,"INSERT INTO provider_accounts VALUES ('account','backup','shared',100)");
 await run(env,'DELETE FROM provider_keys');
 await run(env,'INSERT INTO provider_keys(id,account_id,provider,name,encrypted_secret,fingerprint,preview,created_at) VALUES (?,?,?,?,?,?,?,0)','a','account','backup','a',await crypt(env.KEY_ENCRYPTION_SECRET,'fake-upstream-key'),'unique','hidden');
 const task=await createTask(env,user,payload,'ambiguous-request');await claimKey(env,task.id);const original=globalThis.fetch;let calls=0;globalThis.fetch=async()=>{calls++;throw Error('network timeout');};
 try{await submitTask(env,task.id);await submitTask(env,task.id);}finally{globalThis.fetch=original;}
 assert.equal(calls,1);assert.equal((await one(env,'SELECT state FROM tasks WHERE id=?',task.id)).state,'unknown');assert.equal((await all(env,'SELECT * FROM key_leases')).length,1);
});
test('customer identity and references cannot cross tenants; paused Key loses access',async t=>{
 const {env,user}=await fixture(t),origin='https://billing.example.com';
 const request=new Request(origin+'/v1/me',{headers:{Authorization:'Bearer ha_fixture'}});assert.equal((await authenticate(request,env)).id,'user');
 await env.RESULTS.put('input/user/a.png','data',{httpMetadata:{contentType:'image/png'}});
 const own=await signedUrl(env,origin,'input/user/a.png');await validateReferences(env,user,{images:[own]},origin);
 const other=await signedUrl(env,origin,'input/other/a.png');await assert.rejects(()=>validateReferences(env,user,{images:[other]},origin),/当前客户/);
 await assert.rejects(()=>validateReferences(env,user,{videos:[own]},origin),/类型/);
 await run(env,"UPDATE api_keys SET status='paused' WHERE id='client'");await assert.rejects(()=>authenticate(request,env),/停用/);
});

async function challengeFor(env,email='test@example.com'){
 Object.assign(env,{RESEND_API_KEY:'fixture-resend',MAIL_FROM:'仓鼠AI <noreply@mail.hamsterai.cc>',MAIL_REPLY_TO:'reply@example.com'});
 let mail;const challenge=await requestCode(env,{email},'192.0.2.1',async(url,options)=>{assert.equal(url,'https://api.resend.com/emails');mail=JSON.parse(options.body);return Response.json({id:'fixture-mail'});});
 const code=mail.text.match(/验证码为：(\d{6})/)[1];return {email,challenge_id:challenge.challenge_id,code};
}
test('email verification preserves existing balance, creates zero-balance accounts, consumes code once and expires sessions',async t=>{
 const {env}=await fixture(t),p=await challengeFor(env);
 const stored=await one(env,'SELECT * FROM email_challenges WHERE id=?',p.challenge_id);assert.notEqual(stored.code_hash,p.code);assert.equal(stored.code_hash.length,64);
 const logins=await Promise.allSettled([verifyCode(env,p,'ip'),verifyCode(env,p,'ip')]);assert.equal(logins.filter(r=>r.status==='fulfilled').length,1);
 const login=logins.find(r=>r.status==='fulfilled').value;assert.equal(login.user_id,'user');assert.equal((await one(env,"SELECT balance FROM customers WHERE id='user'")).balance,100000000);
 const request=new Request('https://fixture/v1/me',{headers:{Authorization:'Bearer '+login.token}});assert.ok((await authenticate(request,env)).email_verified_at);
 await run(env,'UPDATE api_keys SET expires_at=1 WHERE token_hash=?',await hash(login.token));await assert.rejects(()=>authenticate(request,env),/过期/);
 const fresh=await verifyCode(env,await challengeFor(env,'new@example.com'),'ip');assert.equal((await one(env,'SELECT balance FROM customers WHERE id=?',fresh.user_id)).balance,0);
 await run(env,"UPDATE customers SET status='disabled' WHERE id='user'");await run(env,'DELETE FROM auth_limits');const disabled=await challengeFor(env);await assert.rejects(()=>verifyCode(env,disabled,'ip'),/停用/);
});
test('OTP cooldown, attempt cap, expiry and failed delivery are enforced',async t=>{
 const {env}=await fixture(t),p=await challengeFor(env);
 await assert.rejects(()=>requestCode(env,{email:p.email},'other-ip',async()=>{throw Error('must not send');}),/频繁/);
 const wrong={...p,code:p.code==='000000'?'111111':'000000'};for(let i=0;i<5;i++)await assert.rejects(()=>verifyCode(env,wrong,'ip'),/无效/);
 await assert.rejects(()=>verifyCode(env,p,'ip'),/无效/);
 const expired=await challengeFor(env,'expired@example.com');await run(env,'UPDATE email_challenges SET expires_at=1 WHERE id=?',expired.challenge_id);await assert.rejects(()=>verifyCode(env,expired,'ip'),/过期/);
 await assert.rejects(()=>requestCode(env,{email:'failure@example.com'},'ip',async()=>Response.json({secret:'never expose provider body'},{status:403})),/邮件服务暂不可用（403）/);
});
test('only manually confirmed recharge credit queues email; failures and repeated approval never double-credit',async t=>{
 const {env}=await fixture(t,0);Object.assign(env,{RESEND_API_KEY:'fixture',MAIL_FROM:'仓鼠AI <noreply@mail.hamsterai.cc>'});
 await run(env,"INSERT INTO recharges(id,user_id,email_snapshot,amount,request_id,created_at,payment_reference,payment_reported) VALUES ('mail-order','user','test@example.com',10000000,'mail-request',1,'R123',0)");
 const review={id:'mail-order',approve:true,transaction_id:'unique-payment',confirmed_amount:'10',received_at:Date.now()-1000,manual_confirmed:true,reason:'人工核实到账'};
 await assert.rejects(()=>adminWrite(env,'admin','recharge-review',review),/二次确认/);assert.equal((await all(env,'SELECT * FROM mail_outbox')).length,0);
 await run(env,"UPDATE recharges SET payment_reported=1 WHERE id='mail-order'");
 await assert.rejects(()=>adminWrite(env,'admin','recharge-review',{...review,manual_confirmed:false}),/二次确认/);
 let calls=0;await drainMail(env,async()=>{calls++;throw Error('must not send');});assert.equal(calls,0);
 await adminWrite(env,'admin','recharge-review',review);await adminWrite(env,'admin','recharge-review',review);
 assert.equal((await all(env,'SELECT * FROM mail_outbox')).length,1);assert.equal((await one(env,"SELECT balance FROM customers WHERE id='user'")).balance,10000000);
 const deliveries=[];await drainMail(env,async(url,options)=>{deliveries.push(options);throw Error('ambiguous network');});assert.equal((await one(env,'SELECT state FROM mail_outbox')).state,'retry');
 await run(env,'UPDATE mail_outbox SET next_attempt=0');await drainMail(env,async(url,options)=>{deliveries.push(options);return Response.json({id:'resend-fixture'});});
 assert.equal(deliveries[0].headers['Idempotency-Key'],deliveries[1].headers['Idempotency-Key']);assert.equal(deliveries[0].body,deliveries[1].body);assert.equal((await one(env,'SELECT state FROM mail_outbox')).state,'sent');
 assert.equal((await one(env,"SELECT balance FROM customers WHERE id='user'")).balance,10000000);
 await run(env,"INSERT INTO recharges(id,user_id,email_snapshot,amount,request_id,created_at) VALUES ('duplicate','user','test@example.com',10000000,'duplicate-request',1)");
 await assert.rejects(()=>adminWrite(env,'admin','recharge-review',{...review,id:'duplicate'}));assert.equal((await all(env,'SELECT * FROM mail_outbox')).length,1);
 await adminWrite(env,'admin','recharge-review',{id:'duplicate',approve:false,reason:'核实重复付款申请'});assert.equal((await all(env,'SELECT * FROM mail_outbox')).length,1);
});
test('outbox stops automatic retries before Resend deduplication expires',async t=>{
 const {env}=await fixture(t,0);await run(env,"INSERT INTO recharges(id,user_id,email_snapshot,amount,request_id,created_at) VALUES ('old-mail','user','test@example.com',1000000,'old-mail-request',1)");
 await adminWrite(env,'admin','recharge-review',{id:'old-mail',approve:true,manual_confirmed:true,transaction_id:'old-payment',confirmed_amount:'1',received_at:Date.now()-1000,reason:'人工核实到账'});
 await run(env,'UPDATE mail_outbox SET first_attempt=?',Date.now()-24*3600000);
 let calls=0;await drainMail(env,async()=>{calls++;});assert.equal(calls,0);assert.equal((await one(env,'SELECT state FROM mail_outbox')).state,'needs_review');assert.equal((await one(env,"SELECT balance FROM customers WHERE id='user'")).balance,1000000);
});
