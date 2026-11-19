import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import fs from 'node:fs';
import worker,{readReport,receive,deliver} from '../cloudflare/report-worker/src/worker.js';
function env(t){
  const db=new DatabaseSync(':memory:');db.exec(fs.readFileSync(new URL('../cloudflare/report-worker/schema.sql',import.meta.url),'utf8'));t.after(()=>db.close());
  const prepare=sql=>({bind(...args){const stmt=db.prepare(sql);return {first:async()=>stmt.get(...args),all:async()=>({results:stmt.all(...args)}),run:async()=>stmt.run(...args)};}});
  const objects=new Map(),messages=[];
  return {DB:{prepare,batch:async queries=>Promise.all(queries.map(q=>q.run()))},REPORTS:{put:async(k,v)=>objects.set(k,v)},MAIL_QUEUE:{send:async v=>messages.push(v)},RATE:{limit:async()=>({success:true})},GLOBAL_RATE:{limit:async()=>({success:true})},MAIL_API_KEY:'fake-key',objects,messages,db};
}
const report={version:'1.7.39',module:'chat',code:'AUTH_FAILED',httpStatus:401};
const request=(value={id:crypto.randomUUID(),report})=>new Request('https://local.test/v1/reports',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(value)});
test('cloud boundary independently strips raw logs and rejects oversized bodies',async()=>{
  const safe=await readReport(request({id:crypto.randomUUID(),report:{...report,message:'sk-private',frames:[{file:'C:/secret/chat.py',line:1}]}}));
  assert.doesNotMatch(JSON.stringify(safe),/secret|private|message/);
  await assert.rejects(readReport(request({id:crypto.randomUUID(),report,raw:'x'.repeat(4096)})));
});
test('storage precedes email, duplicate retries are idempotent, mail bodies stay stable',async t=>{
  const e=env(t),id=crypto.randomUUID();
  assert.equal((await receive(request({id,report}),e)).status,202);
  await receive(request({id,report}),e);assert.equal(e.db.prepare('SELECT COUNT(*) AS n FROM receipts').get().n,1);
  const fp=e.messages[0].fingerprint,mails=[];
  const fail=async(_url,init)=>{assert.equal(e.objects.size,1);mails.push(init);return new Response('{}',{status:500});};
  await assert.rejects(deliver(fp,e,fail));
  await receive(request(),e);
  await deliver(fp,e,async(url,init)=>{mails.push(init);assert.equal(url,'https://api.resend.com/emails');return new Response('{}',{status:200});});
  assert.equal(mails[0].body,mails[1].body);assert.equal(mails[0].headers['Idempotency-Key'],mails[1].headers['Idempotency-Key']);
  assert.deepEqual(JSON.parse(mails[1].body).to,['1060761161@qq.com']);
  await deliver(fp,e,()=>{throw Error('duplicate email');});
  assert.equal(JSON.parse([...e.objects.values()][0]).reports,2);
  assert.equal(e.db.prepare('SELECT notified FROM incidents').get().notified,1);
});
test('global durable email quota caps arbitrary variants without dropping private storage',async t=>{
  const e=env(t);let sent=0;
  for(let i=0;i<23;i++){
    await receive(request({id:crypto.randomUUID(),report:{...report,httpStatus:400+i}}),e);
    await deliver(e.messages.at(-1).fingerprint,e,async()=>{sent++;return new Response('{}');});
  }
  assert.equal(sent,20);assert.equal(e.objects.size,23);
});
test('rate limits and storage failures never disclose internals',async t=>{
  const e=env(t);e.RATE.limit=async()=>({success:false});assert.equal((await worker.fetch(request(),e)).status,429);
  e.RATE.limit=async()=>{throw Error('sk-secret upstream.example');};const response=await worker.fetch(request(),e);assert.equal(response.status,503);assert.doesNotMatch(await response.text(),/secret|upstream/);
  assert.equal((await worker.fetch(new Request('https://local.test/reports/secret'),e)).status,404);
});
