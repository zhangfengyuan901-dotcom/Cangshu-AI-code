import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {normalizeAccountFailure,normalizeReport,framesFromStack,ACCOUNT_CODES}=require('../report-schema.cjs');
const {createReporter}=require('../reporter.cjs');
const tick=()=>new Promise(resolve=>setImmediate(resolve));

test('remote account failure contract accepts only fixed codes and bounded numeric status',()=>{
  for(const code of ACCOUNT_CODES){
    assert.deepEqual(normalizeAccountFailure({code,httpStatus:503,key:'sk-private',token:'private',url:'https://private.test',paymentId:'private',message:'customer text',stack:'private'}),{code,httpStatus:503});
  }
  for(const value of [null,undefined,{},'ACCOUNT_CONNECT_FAILED',{code:'AUTH_FAILED'},{code:'ACCOUNT_CONNECT_FAILED sk-private'}])assert.equal(normalizeAccountFailure(value),null);
  for(const httpStatus of [-1,1,99,600,503.5,'503',null,{},Infinity])assert.deepEqual(normalizeAccountFailure({code:'ACCOUNT_CONNECT_FAILED',httpStatus}),{code:'ACCOUNT_CONNECT_FAILED',httpStatus:0});
  assert.equal(normalizeAccountFailure({code:'ACCOUNT_CONNECT_FAILED',httpStatus:100}).httpStatus,100);
  assert.equal(normalizeAccountFailure({code:'ACCOUNT_CONNECT_FAILED',httpStatus:599}).httpStatus,599);
});

test('account stack extraction keeps only exact code basenames and line numbers',()=>{
  const frames=framesFromStack('Error: customer text sk-private\n at connect (C:\\Users\\customer\\account-view.cjs:45:9)\n at send (https://private.test/account.mjs:35:3)\n at fetch (C:\\Users\\customer\\private-sdk.js:99:1)');
  assert.deepEqual(frames,[{file:'account-view.cjs',line:45},{file:'account.mjs',line:35}]);
  const safe=normalizeReport({module:'account',code:'ACCOUNT_KEY_IMPORT_FAILED',frames:[...frames,{file:'C:/private/account.mjs',line:45},{file:'client.mjs',line:12,url:'https://private.test'}],apiKey:'sk-private',message:'customer text'});
  assert.deepEqual(safe.frames,[...frames,{file:'client.mjs',line:12}]);
  assert.doesNotMatch(JSON.stringify(safe),/customer|private|message|url|apiKey/);
});

test('account reports persist and retry safe metadata without affecting customer operation',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hamster-account-report-'));
  const sent=[];
  const reporter=createReporter({dir,version:'1.7.54',fetchImpl:async(_url,init)=>{sent.push(JSON.parse(init.body));throw Error('offline private upstream');}});
  t.after(()=>{reporter.close();fs.rmSync(dir,{recursive:true,force:true});});
  assert.doesNotThrow(()=>reporter.capture('account',new Error('private key customer text'),{...normalizeAccountFailure({code:'ACCOUNT_PAYMENT_UNKNOWN',httpStatus:502}),paymentId:'private',apiKey:'private',rawStack:'private'}));
  await tick();
  assert.equal(sent.length,1);assert.equal(reporter.pendingCount(),1);
  const saved=JSON.parse(fs.readFileSync(path.join(dir,'pending-reports.json'),'utf8'));
  assert.equal(saved.pending[0].report.module,'account');assert.equal(saved.pending[0].report.code,'ACCOUNT_PAYMENT_UNKNOWN');
  assert.equal(saved.pending[0].report.httpStatus,502);
  assert.doesNotMatch(JSON.stringify(saved),/private|customer|paymentId|apiKey|rawStack/);
  reporter.capture('account',{}, {code:'ACCOUNT_PAYMENT_UNKNOWN',httpStatus:502});
  await tick();assert.equal(sent.length,1);
});

let sequence=0;
async function browserReporter(t,fetchImpl){
  const previousFetch=globalThis.fetch,previousNow=Date.now;
  let now=1000;globalThis.fetch=fetchImpl;Date.now=()=>now;
  t.after(()=>{globalThis.fetch=previousFetch;Date.now=previousNow;});
  const {reportAccountFailure}=await import(`../public/fault-events.mjs?account-test=${sequence++}`);
  return {reportAccountFailure,setNow:value=>{now=value;}};
}

test('browser account feedback strips all free text and throttles each fixed failure type',async t=>{
  const sent=[];
  const {reportAccountFailure,setNow}=await browserReporter(t,async(url,init)=>{sent.push({url,body:JSON.parse(init.body)});return new Response('{}',{status:202});});
  const payload={code:'ACCOUNT_KEY_IMPORT_FAILED',httpStatus:409,key:'sk-private',token:'private',message:'private customer text',url:'https://private.test',paymentId:'private'};
  reportAccountFailure(payload);reportAccountFailure(payload);
  reportAccountFailure({code:'ACCOUNT_CONNECT_FAILED',httpStatus:'503',stack:'private'});
  reportAccountFailure({code:'UNEXPECTED',httpStatus:500});
  assert.deepEqual(sent,[{url:'/api/error-report',body:{module:'account',code:'ACCOUNT_KEY_IMPORT_FAILED',httpStatus:409}},{url:'/api/error-report',body:{module:'account',code:'ACCOUNT_CONNECT_FAILED',httpStatus:0}}]);
  setNow(61000);reportAccountFailure(payload);assert.equal(sent.length,3);
  assert.doesNotMatch(JSON.stringify(sent),/private|customer|paymentId|token|stack/);
});

test('feedback transport sync throws and rejected promises never escape or recursively report',async t=>{
  let calls=0;
  const {reportAccountFailure}=await browserReporter(t,()=>{calls++;throw Error('private sync transport');});
  assert.doesNotThrow(()=>reportAccountFailure({code:'ACCOUNT_CONNECT_FAILED'}));
  globalThis.fetch=()=>{calls++;return Promise.reject(Error('private network failure'));};
  assert.doesNotThrow(()=>reportAccountFailure({code:'ACCOUNT_KEY_CREATE_UNKNOWN'}));
  await tick();assert.equal(calls,2);
});
