import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { createToken, verifyToken } from '../cloudflare/llm-worker/src/worker.js';

const env={ARK_API_KEY:'server-only-secret',LLM_ENDPOINTS:'ep-route-a,ep-route-b,ep-route-c',TOKEN_SIGNING_KEY:'fixture-signing-key-with-at-least-32-bytes'};

test('wallet login activation verifies the customer over a service binding and never exposes bearer',async()=>{
 const bearer='ha_'+'1'.repeat(64);let calls=0;
 const request=()=>new Request('https://inference.example/v1/activate',{method:'POST',headers:{authorization:'Bearer '+bearer,'x-hamster-client':'hamster-desktop-v1'}});
 const binding={fetch:async r=>{calls++;assert.equal(r.headers.get('authorization'),'Bearer '+bearer);return Response.json({email_verified:true});}};
 const result=await worker.fetch(request(),{...env,BILLING:binding});assert.equal(result.status,200);const data=await result.json();assert.ok(await verifyToken(env,data.token));assert.equal(calls,1);assert.doesNotMatch(JSON.stringify(data),/ha_|server-only-secret|ep-route/);
 assert.equal((await worker.fetch(request(),{...env,BILLING:{fetch:async()=>Response.json({error:'revoked'},{status:401})}})).status,401);
 assert.equal((await worker.fetch(request(),env)).status,503);
});

test('activation validates a main key and returns only a signed short-lived token', {concurrency:false}, async t=>{
  const original=globalThis.fetch;
  globalThis.fetch=async(url,options)=>{
    assert.equal(String(url),'https://sanbaobeauty.com/openapi/v1/me');
    assert.equal(options.headers.Authorization,'Bearer valid-main-key');
    return Response.json({data:[]});
  };
  t.after(()=>{globalThis.fetch=original;});
  const response=await worker.fetch(new Request('https://inference.example/v1/activate',{method:'POST',headers:{authorization:'Bearer valid-main-key','x-hamster-client':'hamster-desktop-v1'}}),env);
  assert.equal(response.status,200);
  const payload=await response.json();
  assert.match(payload.token,/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/);
  assert.ok(await verifyToken(env,payload.token));
  assert.doesNotMatch(JSON.stringify(payload),/valid-main-key|server-only-secret|ep-route/);
});

test('responses retry the next endpoint on throttling and hide endpoint identifiers', {concurrency:false}, async t=>{
  const token=await createToken(env,'a'.repeat(64));
  const calls=[];
  const original=globalThis.fetch;
  globalThis.fetch=async(_url,options)=>{
    const payload=JSON.parse(options.body);calls.push({model:payload.model,authorization:options.headers.get('authorization')});
    if(calls.length===1)return Response.json({error:{message:'rate limit'}},{status:429});
    return new Response(`data: {"model":"${payload.model}","type":"response.completed"}\n\n`,{headers:{'content-type':'text/event-stream'}});
  };
  t.after(()=>{globalThis.fetch=original;});
  const request=new Request('https://inference.example/api/v3/responses',{method:'POST',headers:{authorization:`Bearer ${token}`,'x-hamster-client':'hamster-desktop-v1','content-type':'application/json'},body:JSON.stringify({model:'client-model',input:'hello',stream:true})});
  const response=await worker.fetch(request,env);
  assert.equal(response.status,200);assert.equal(calls.length,2);assert.notEqual(calls[0].model,calls[1].model);
  assert.ok(calls.every(call=>call.authorization==='Bearer server-only-secret'));
  const text=await response.text();
  assert.match(text,/hamster-auto/);assert.doesNotMatch(text,/ep-route|server-only-secret|client-model/);
});

test('invalid activation token is rejected before any provider request', async()=>{
  const response=await worker.fetch(new Request('https://inference.example/api/v3/responses',{method:'POST',headers:{authorization:'Bearer invalid','x-hamster-client':'hamster-desktop-v1'},body:'{}'}),env);
  assert.equal(response.status,401);assert.doesNotMatch(await response.text(),/server-only-secret|ep-route/);
});

test('gateway rejects unrelated provider routes and sanitizes file errors', {concurrency:false}, async t=>{
  const token=await createToken(env,'b'.repeat(64));
  const headers={authorization:`Bearer ${token}`,'x-hamster-client':'hamster-desktop-v1'};
  let calls=0;
  const original=globalThis.fetch;
  globalThis.fetch=async()=>{calls++;return Response.json({error:'ep-route-a rejected server-only-secret'},{status:400});};
  t.after(()=>{globalThis.fetch=original;});
  const unrelated=await worker.fetch(new Request('https://inference.example/api/v3/models',{headers}),env);
  assert.equal(unrelated.status,404);assert.equal(calls,0);
  const fileError=await worker.fetch(new Request('https://inference.example/api/v3/files/file-test',{headers}),env);
  assert.equal(fileError.status,400);assert.equal(calls,0,'unowned raw identifiers must not reach shared inference');
  assert.doesNotMatch(await fileError.text(),/ep-route|server-only-secret/);
});
