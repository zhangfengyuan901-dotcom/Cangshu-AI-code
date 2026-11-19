import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {fixture} from './fixture.mjs';
import {run,one,all} from '../src/common.mjs';
import {reportPayment} from '../src/recharges.mjs';
import {adminRead,adminWrite} from '../src/admin.mjs';

const verified={id:'user',email_verified_at:1};
const approve=id=>({id,approve:true,manual_confirmed:true,transaction_id:'receipt-'+id,confirmed_amount:'10',received_at:Date.now()-1000,reason:'核实真实到账'});
const reject=id=>({id,approve:false,reason:'未核实到账，不通过'});
async function order(env,id,reported=1){await run(env,'INSERT INTO recharges(id,user_id,email_snapshot,amount,request_id,created_at,payment_reported) VALUES (?,\'user\',\'test@example.com\',10000000,?,1,?)',id,'request-'+id,reported);}
test('only customer-confirmed orders enter review and pending count; confirmation time is server-owned and stable',async t=>{
 const {env}=await fixture(t,0);await order(env,'unpaid',0);
 assert.equal((await adminRead(env,'recharges')).length,0);assert.equal((await adminRead(env,'overview')).recharges.count,0);
 await assert.rejects(()=>adminWrite(env,'admin','recharge-review',reject('unpaid')),/已付款/);
 await assert.rejects(()=>reportPayment(env,{id:'user'},'unpaid',{payment_confirmed:true}),/验证/);
 await assert.rejects(()=>reportPayment(env,{...verified,id:'other'},'unpaid',{payment_confirmed:true}),/不存在/);
 await assert.rejects(()=>reportPayment(env,verified,'unpaid',{}),/确认/);
 const first=await reportPayment(env,verified,'unpaid',{payment_confirmed:true,payment_reported_at:1});
 assert.ok(first.payment_reported_at>1);assert.equal((await adminRead(env,'recharges')).length,1);assert.equal((await adminRead(env,'overview')).recharges.count,1);
 assert.equal((await reportPayment(env,verified,'unpaid',{payment_confirmed:true})).payment_reported_at,first.payment_reported_at);
 assert.equal((await one(env,"SELECT balance FROM customers WHERE id='user'")).balance,0);
});
test('rejection physically deletes only the unpaid ledger-free application, leaving no email or wallet mutation',async t=>{
 const {env}=await fixture(t,0);await order(env,'reject');
 assert.equal((await adminWrite(env,'admin','recharge-review',reject('reject'))).state,'deleted');
 assert.equal(await one(env,"SELECT * FROM recharges WHERE id='reject'"),null);
 for(const table of ['recharges','ledger','mail_outbox'])assert.equal((await all(env,'SELECT * FROM '+table)).length,0);
 const events=await all(env,'SELECT * FROM audit');assert.equal(events.length,1);assert.equal(events[0].action,'recharge.deleted');
 await assert.rejects(()=>adminWrite(env,'admin','recharge-review',reject('reject')),/不存在/);
 await assert.rejects(()=>reportPayment(env,verified,'reject',{payment_confirmed:true}),/不存在/);
 assert.equal((await adminRead(env,'overview')).recharges.count,0);
 assert.equal((await one(env,"SELECT balance FROM customers WHERE id='user'")).balance,0);
});
test('approval requires receipt time and remains idempotent; credited orders cannot be deleted even directly',async t=>{
 const {env}=await fixture(t,0);await order(env,'approved');const p=approve('approved');
 for(const received_at of [undefined,0,-1,Date.now()+3600000,'bad'])await assert.rejects(()=>adminWrite(env,'admin','recharge-review',{...p,received_at}),/到账时间/);
 await adminWrite(env,'admin','recharge-review',p);await adminWrite(env,'admin','recharge-review',p);
 await assert.rejects(()=>adminWrite(env,'admin','recharge-review',reject('approved')),/不能删除/);
 await assert.rejects(()=>run(env,"DELETE FROM recharges WHERE id='approved'"),/CANNOT_DELETE/);
 assert.equal((await all(env,'SELECT * FROM ledger')).length,1);assert.equal((await all(env,'SELECT * FROM audit')).length,1);
 assert.equal((await all(env,'SELECT * FROM mail_outbox')).length,1);assert.equal((await one(env,'SELECT received_at FROM recharges')).received_at,p.received_at);
 assert.equal((await adminRead(env,'overview')).recharges.count,0);assert.equal((await adminRead(env,'recharges')).length,1);
});
test('concurrent approval/rejection has one winner and no false audit or double credit',async t=>{
 const {env}=await fixture(t,0);await order(env,'race');
 await Promise.allSettled([adminWrite(env,'admin-a','recharge-review',approve('race')),adminWrite(env,'admin-b','recharge-review',reject('race'))]);
 const saved=await one(env,"SELECT * FROM recharges WHERE id='race'"),credited=saved?.state==='approved';
 assert.equal((await all(env,'SELECT * FROM audit')).length,1);
 assert.equal((await all(env,'SELECT * FROM ledger')).length,credited?1:0);
 assert.equal((await all(env,'SELECT * FROM mail_outbox')).length,credited?1:0);
 assert.equal((await one(env,"SELECT balance FROM customers WHERE id='user'")).balance,credited?10000000:0);
});
test('migration purges historical rejected orders, preserves pending/approved balances and unknown timestamps',async t=>{
 const {env}=await fixture(t,0,5);for(const id of ['old-rejected','old-approved','old-pending'])await order(env,id);
 await run(env,"UPDATE recharges SET state='rejected' WHERE id='old-rejected'");
 await run(env,"UPDATE recharges SET state='approved',transaction_id='old-receipt',reviewed_at=2 WHERE id='old-approved'");
 const sql=fs.readFileSync(new URL('../migrations/0006_recharge_review.sql',import.meta.url),'utf8');
 await env.DB.batch(sql.split(/(?=^(?:CREATE|INSERT|ALTER|DELETE) )/m).filter(x=>x.trim()).map(x=>env.DB.prepare(x.trim())));
 assert.equal(await one(env,"SELECT * FROM recharges WHERE id='old-rejected'"),null);
 assert.equal((await all(env,'SELECT * FROM recharges')).length,2);assert.equal((await one(env,"SELECT balance FROM customers WHERE id='user'")).balance,10000000);
 assert.equal((await one(env,"SELECT payment_reported_at FROM recharges WHERE id='old-pending'")).payment_reported_at,null);
 assert.equal((await all(env,'SELECT * FROM mail_outbox')).length,1);
});
