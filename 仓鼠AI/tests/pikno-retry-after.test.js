const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createPiknoClient}=require('../pikno-client.cjs');
const cfg={piknoVideoKey:'fixture-video-key'};

async function failure(header,status=429){
  let calls=0;
  const client=createPiknoClient({fetchImpl:async()=>{
    calls++;
    return new Response(JSON.stringify({error:{message:'private upstream diagnostic'}}),{status,headers:header===undefined?{}:{'Retry-After':header}});
  }});
  let failure;
  await assert.rejects(client.context(cfg,'video'),error=>{failure=error;return error.statusCode===status;});
  assert.equal(calls,1,'transport must not retry the request');
  assert.doesNotMatch(failure.message,/private|fixture-video-key/);
  return failure;
}

test('rate-limit retry seconds are preserved without automatically repeating a request',async()=>{
  const error=await failure('120');
  assert.equal(error.retryAfterMs,120000);
  assert.equal(error.retryMs,120000);
});

test('retry dates and zero are retained while excessive delays are bounded',async()=>{
  const error=await failure(new Date(Date.now()+60000).toUTCString(),503);
  assert.ok(error.retryAfterMs>=57000&&error.retryAfterMs<=60000);
  assert.equal((await failure('0')).retryAfterMs,0);
  assert.equal((await failure('999999999999')).retryAfterMs,3600000);
});

test('invalid or missing retry headers do not invent a retry delay',async()=>{
  for(const value of [undefined,'invalid','-1','1.5',new Date(0).toUTCString()]){
    const error=await failure(value);
    assert.equal(error.retryAfterMs,undefined);
    assert.equal(error.retryMs,undefined);
  }
});

test('potentially paid submissions retain ambiguity and are never retried for Retry-After',async()=>{
  let calls=0;
  const client=createPiknoClient({fetchImpl:async()=>{calls++;return new Response('{}',{status:503,headers:{'Retry-After':'60'}});}});
  await assert.rejects(client.submit(cfg,{id:'fixture-video',kind:'video',durations:[4],resolutions:['720p'],ratios:['16:9']},{duration:4,resolution:'720p',ratio:'16:9'}),error=>error.ambiguous===true&&error.retryAfterMs===60000);
  assert.equal(calls,1);
});
