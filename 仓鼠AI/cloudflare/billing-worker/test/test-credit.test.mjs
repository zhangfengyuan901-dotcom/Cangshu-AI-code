import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {fixture} from './fixture.mjs';
import {adminRead,adminWrite} from '../src/admin.mjs';
import {createTask,finishFailure} from '../src/billing.mjs';
import {one,all,run,hash} from '../src/common.mjs';

test('internal test credit is separate from receipts and real customer totals',async t=>{
 const {env,payload}=await fixture(t,0);
 const created=await adminWrite(env,'admin','customers',{email:'qa@example.com',name:'QA',is_test:true,reason:'创建内部测试账户'});
 const qa=created.user_id;
 await adminWrite(env,'admin','test-credit',{id:qa,reason:'全链路生成验收'});
 assert.equal((await one(env,'SELECT balance FROM customers WHERE id=?',qa)).balance,22300000);
 assert.equal((await one(env,"SELECT COUNT(*) AS n FROM ledger WHERE user_id=? AND kind='test_credit'",qa)).n,1);
 assert.equal((await one(env,'SELECT COUNT(*) AS n FROM recharges WHERE user_id=?',qa)).n,0);
 assert.deepEqual((await adminRead(env,'overview')).customers,{count:1,balance:0,held:0});
 await assert.rejects(()=>adminWrite(env,'admin','test-credit',{id:qa,reason:'重复发放'}),/TEST_CREDIT_ALREADY_ISSUED|UNIQUE/);
 await assert.rejects(()=>adminWrite(env,'admin','test-credit',{id:'user',reason:'误发正式客户'}),/仅内部测试账户/);
 await assert.rejects(()=>run(env,"INSERT INTO recharges(id,user_id,email_snapshot,amount,request_id,created_at) VALUES ('qa-recharge',?,?,?,?,0)",qa,'qa@example.com',1000000,'qa-request'),/TEST_ACCOUNT_CANNOT_RECHARGE/);
 await run(env,"INSERT INTO api_keys(id,user_id,name,token_hash,preview,created_at) VALUES ('qa-key',?,'QA',?,'hidden',0)",qa,await hash('qa-session'));
 const task=await createTask(env,{id:qa,key_id:'qa-key'},payload,'qa-video-test');
 assert.equal((await one(env,'SELECT held FROM customers WHERE id=?',qa)).held,2750000);
 await finishFailure(env,task.id,'test-failure');
 assert.deepEqual(await one(env,'SELECT balance,held FROM customers WHERE id=?',qa),{balance:22300000,held:0});
 assert.equal((await all(env,"SELECT * FROM audit WHERE action='test.credit' AND target=?",qa)).length,1);
});

test('test-credit migration preserves existing wallet entries and billing triggers',async t=>{
 const {env}=await fixture(t,0,6);
 await run(env,"INSERT INTO ledger VALUES ('existing-credit','user','recharge',1000000,0,1000000,'existing','fixture',1)");
 const sql=fs.readFileSync(new URL('../migrations/0007_internal_test_credit.sql',import.meta.url),'utf8');
 await env.DB.batch(sql.split(/(?=^(?:CREATE|INSERT|PRAGMA|ALTER|DROP|UPDATE|DELETE) )/m).filter(x=>x.trim()).map(x=>env.DB.prepare(x.trim())));
 assert.deepEqual(await one(env,"SELECT balance,held,is_test FROM customers WHERE id='user'"),{balance:1000000,held:0,is_test:0});
 assert.equal((await all(env,'PRAGMA foreign_key_check')).length,0);
 await run(env,"INSERT INTO recharges(id,user_id,email_snapshot,amount,request_id,created_at) VALUES ('after-migration','user','test@example.com',1000000,'migration-request',1)");
 await run(env,"UPDATE recharges SET state='approved',transaction_id='migration123',reviewed_at=2 WHERE id='after-migration'");
 assert.equal((await one(env,"SELECT balance FROM customers WHERE id='user'")).balance,2000000);
});
