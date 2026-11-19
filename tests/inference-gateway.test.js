const test = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough, Readable } = require('node:stream');
const { createInferenceGateway } = require('../inference.cjs');

test('cloud inference activation is cached in memory and never returns the main key', async () => {
  const calls=[];
  const gateway=createInferenceGateway({endpoint:'https://inference.example',fetchImpl:async(url,options)=>{
    calls.push({url:String(url),authorization:options.headers.Authorization});
    return Response.json({token:'short-lived-token',expiresAt:new Date(Date.now()+3600_000).toISOString()});
  }});
  assert.equal(await gateway.activate('main-customer-key'),'short-lived-token');
  assert.equal(await gateway.activate('main-customer-key'),'short-lived-token');
  assert.equal(calls.length,1);
  assert.equal(calls[0].url,'https://inference.example/v1/activate');
  assert.equal(calls[0].authorization,'Bearer main-customer-key');
  assert.doesNotMatch(JSON.stringify(await gateway.status('main-customer-key')),/main-customer-key|short-lived-token/);
});

test('local inference gateway forwards only the short-lived token to the cloud', async () => {
  const calls=[];
  const gateway=createInferenceGateway({endpoint:'https://inference.example',fetchImpl:async(url,options)=>{
    calls.push({url:String(url),authorization:options.headers.get?.('authorization') || options.headers.Authorization,body:options.body});
    if(String(url).endsWith('/v1/activate'))return Response.json({token:'cloud-session-token',expiresAt:new Date(Date.now()+3600_000).toISOString()});
    return new Response('{"ok":true}',{headers:{'content-type':'application/json'}});
  }});
  const req=Readable.from([Buffer.from('{"model":"hamster-auto"}')]);
  req.method='POST';req.headers={'content-type':'application/json','content-length':'24'};
  const chunks=[];
  const res=new PassThrough();
  res.writeHead=function(status,headers){this.status=status;this.headers=headers;};
  res.on('data',chunk=>chunks.push(Buffer.from(chunk)));
  await gateway.handle(req,res,new URL('http://localhost/api/inference/api/v3/responses'),'main-customer-key');
  assert.equal(calls.length,2);assert.equal(calls[1].authorization,'Bearer cloud-session-token');
  assert.doesNotMatch(calls[1].authorization,/main-customer-key/);
  assert.equal(calls[1].url,'https://inference.example/api/v3/responses');
});

test('status revalidates cloud connectivity and revocation clears the cached session', async () => {
  let calls=0, rejected=false;
  const gateway=createInferenceGateway({fetchImpl:async()=>{
    calls++;
    return rejected ? Response.json({error:'invalid'},{status:401})
      : Response.json({token:'session',expiresAt:new Date(Date.now()+3600_000).toISOString()});
  }});
  await gateway.activate('main');
  await gateway.status('main');
  assert.equal(calls,2,'status must contact cloud even with a cached token');
  rejected=true;
  await assert.rejects(gateway.status('main'),{statusCode:401});
  await assert.rejects(gateway.activate('main'),{statusCode:401});
  assert.equal(calls,4,'revoked cached session must not remain usable');
});

test('account changes during activation never submit with the replacement credential',async()=>{
  let release,started;const gate=new Promise(r=>release=r),ready=new Promise(r=>started=r),calls=[];let revision=1;
  const gateway=createInferenceGateway({fetchImpl:async(url,options)=>{calls.push(options.headers.Authorization);started();await gate;return Response.json({token:'old-account-token',expiresAt:new Date(Date.now()+3600000).toISOString()});}});
  const req=Readable.from(['{}']);req.method='POST';req.headers={};const res=new PassThrough();res.writeHead=()=>{};
  const pending=gateway.handle(req,res,new URL('http://localhost/api/inference/api/v3/responses'),'old-key',{assertCurrent(){if(revision!==1)throw Object.assign(Error('account changed'),{statusCode:409});}});
  await ready;revision=2;await assert.rejects(pending,{statusCode:409});release();assert.deepEqual(calls,['Bearer old-key']);
});

test('account changes during upload abort the original request without resolving a new key',async()=>{
  let started;const ready=new Promise(r=>started=r),calls=[];let revision=1;
  const gateway=createInferenceGateway({fetchImpl:async(url,options)=>{
    calls.push(String(url));if(String(url).endsWith('/v1/activate'))return Response.json({token:'old-session',expiresAt:new Date(Date.now()+3600000).toISOString()});
    started();return new Promise((_resolve,reject)=>options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true}));
  }});
  const req=Readable.from(['{}']);req.method='POST';req.headers={};const res=new PassThrough();res.writeHead=()=>{};
  const pending=gateway.handle(req,res,new URL('http://localhost/api/inference/api/v3/files'),'old-key',{assertCurrent(){if(revision!==1)throw Object.assign(Error('account changed'),{statusCode:409});}});
  await ready;revision=2;await assert.rejects(pending,{statusCode:409});assert.equal(calls.length,2);
});

test('account changes while streaming abort the old stream and never complete it for the new account',async()=>{
  let revision=1,streamController,started;const ready=new Promise(r=>started=r);let calls=0;
  const gateway=createInferenceGateway({fetchImpl:async(url)=>{
    calls++;if(String(url).endsWith('/v1/activate'))return Response.json({token:'old-session',expiresAt:new Date(Date.now()+3600000).toISOString()});
    return new Response(new ReadableStream({start(controller){streamController=controller;controller.enqueue(new TextEncoder().encode('data: old\n'));}}),{headers:{'content-type':'text/event-stream'}});
  }});
  const req=Readable.from(['{}']);req.method='POST';req.headers={};const res=new PassThrough();res.writeHead=()=>{};res.on('data',()=>started());res.on('error',()=>{});
  const pending=gateway.handle(req,res,new URL('http://localhost/api/inference/api/v3/responses'),'old-key',{assertCurrent(){if(revision!==1)throw Object.assign(Error('account changed'),{statusCode:409});}});
  await ready;revision=2;await assert.rejects(pending,{statusCode:409});assert.equal(calls,2);assert.equal(res.destroyed,true);
});
