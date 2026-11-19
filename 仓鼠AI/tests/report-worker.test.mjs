import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import fs from 'node:fs';
import worker,{readReport} from '../cloudflare/report-worker/src/worker.js';
function env(t){
  const db=new DatabaseSync(':memory:');db.exec(fs.readFileSync(new URL('../cloudflare/report-worker/schema.sql',import.meta.url),'utf8'));t.after(()=>db.close());
  const prepare=sql=>({bind(...args){const stmt=db.prepare(sql);return {run:async()=>stmt.run(...args)};}});
  return {DB:{prepare,batch:async queries=>Promise.all(queries.map(q=>q.run()))},RATE:{limit:async()=>({success:true})},GLOBAL_RATE:{limit:async()=>({success:true})},db};
}
const report={version:'1.7.39',module:'chat',code:'AUTH_FAILED',httpStatus:401};
const request=(value={id:crypto.randomUUID(),report})=>new Request('https://local.test/v1/reports',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(value)});
test('cloud boundary independently strips raw logs and rejects oversized bodies',async()=>{
  const safe=await readReport(request({id:crypto.randomUUID(),report:{...report,message:'sk-private',frames:[{file:'C:/secret/chat.py',line:1}]}}));
  assert.doesNotMatch(JSON.stringify(safe),/secret|private|message/);
  await assert.rejects(readReport(request({id:crypto.randomUUID(),report,raw:'x'.repeat(4096)})));
});
test('cloud account intake saves only allowed diagnostics in D1 without delivery bindings',async t=>{
  const e=env(t);
  const input={version:'1.7.54',module:'account',code:'ACCOUNT_KEY_CREATE_UNKNOWN',httpStatus:502,
    apiKey:'sk-private',token:'private',message:'customer private text',url:'https://private.test',paymentId:'private',
    frames:[{file:'account.mjs',line:35,stack:'private'},{file:'C:/customer/account.mjs',line:45}]};
  const response=await worker.fetch(request({id:crypto.randomUUID(),report:input}),e);
  assert.equal(response.status,202);
  assert.deepEqual(await response.json(),{accepted:true});
  const stored=JSON.parse(e.db.prepare('SELECT payload FROM incidents').get().payload);
  assert.equal(stored.code,'ACCOUNT_KEY_CREATE_UNKNOWN');assert.equal(stored.module,'account');assert.equal(stored.httpStatus,502);
  assert.deepEqual(stored.frames,[{file:'account.mjs',line:35}]);
  assert.doesNotMatch(JSON.stringify(stored),/private|customer|apiKey|token|paymentId|message|stack|url/);
});
test('D1 groups same-hour reports and keeps the original receipt on cross-hour retry',async t=>{
  const e=env(t),id=crypto.randomUUID();
  const hour=3600000,now=hour*500000;
  let currentTime=now;
  t.mock.method(Date,'now',()=>currentTime);
  assert.equal((await worker.fetch(request({id,report}),e)).status,202);
  assert.equal((await worker.fetch(request(),e)).status,202);
  currentTime+=hour;
  assert.equal((await worker.fetch(request({id,report}),e)).status,202);
  const counts=e.db.prepare('SELECT COUNT(*) AS total, COUNT(DISTINCT fingerprint) AS groups FROM receipts').get();
  assert.equal(counts.total,2);
  assert.equal(counts.groups,1);
  assert.equal(e.db.prepare('SELECT COUNT(*) AS total FROM incidents').get().total,1);
  assert.equal(e.db.prepare('SELECT updated FROM incidents').get().updated,currentTime);
});
test('scheduled cleanup expires old D1 data without processing recent pending reports',async t=>{
  const e=env(t),id=crypto.randomUUID();
  const day=86400000,now=day*25000;
  let currentTime=now-31*day;
  t.mock.method(Date,'now',()=>currentTime);
  assert.equal((await worker.fetch(request(),e)).status,202);
  currentTime=now;
  assert.equal((await worker.fetch(request({id,report}),e)).status,202);
  assert.equal(e.db.prepare('SELECT COUNT(*) AS total FROM incidents').get().total,2);
  await worker.scheduled({},e);
  assert.equal(e.db.prepare('SELECT id FROM receipts').get().id,id);
  const incidents=e.db.prepare('SELECT created, notified, attempts FROM incidents').all();
  assert.equal(incidents.length,1);
  assert.equal(incidents[0].created,now);
  assert.equal(incidents[0].notified,0);
  assert.equal(incidents[0].attempts,0);
  assert.equal(worker.queue,undefined);
});
test('rate limits and storage failures never disclose internals',async t=>{
  const e=env(t);e.RATE.limit=async()=>({success:false});assert.equal((await worker.fetch(request(),e)).status,429);
  e.RATE.limit=async()=>{throw Error('sk-secret upstream.example');};const response=await worker.fetch(request(),e);assert.equal(response.status,503);assert.doesNotMatch(await response.text(),/secret|upstream/);
  assert.equal((await worker.fetch(new Request('https://local.test/reports/secret'),e)).status,404);
});
