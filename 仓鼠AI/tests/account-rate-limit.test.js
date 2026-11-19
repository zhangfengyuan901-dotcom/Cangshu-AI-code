const {test}=require('node:test'),assert=require('node:assert/strict');
const {createPiknoClient}=require('../pikno-client.cjs');
const {createPiknoBridge}=require('../pikno.cjs');
const fields={image:'piknoImageKey',video:'piknoVideoKey',tool:'piknoToolKey',chat:'piknoChatKey'};
const keys=Object.fromEntries(Object.entries(fields).map(([kind,field])=>[field,'sk-'+kind[0].repeat(32)]));
const json=value=>new Response(JSON.stringify(value),{headers:{'Content-Type':'application/json'}});
const activation={authorized:true,enabled:true,available:true,balance_sufficient:true,model:'pikno-chat-standard',billing_mode:'actual_usage_v1',billing:{allow_debt:true,one_inflight_per_user:true},price_version:'chat-cny-9-45-actual-v2',pricing:{currency:'CNY',input_cny_per_million:9,output_cny_per_million:45},capabilities:{text:true,image:false,pdf:false,video:false,files:false,tools:false,sse:true,verified:true},limits:{max_output_tokens:8000}};

test('display identity is single flight and expires after fifteen seconds; authorization always verifies freshly',async()=>{
  let time=0,calls=0,release;const client=createPiknoClient({now:()=>time,fetchImpl:async()=>{calls++;if(calls===1)await new Promise(resolve=>release=resolve);return json({user_id:7,group:'image-standard'});}});
  const a=client.context(keys,'image',{fresh:false}),b=client.context(keys,'image',{fresh:false});assert.equal(calls,1);release();await Promise.all([a,b]);
  time=14999;await client.context(keys,'image',{fresh:false});assert.equal(calls,1);
  await client.context(keys,'image');assert.equal(calls,2,'default authorization must ignore a display cache');
  time=29999;await client.context(keys,'image',{fresh:false});assert.equal(calls,3);
  client.invalidate();await client.context(keys,'image',{fresh:false});assert.equal(calls,4);
  await client.context({...keys,piknoImageKey:'sk-'+'n'.repeat(32)},'image',{fresh:false});assert.equal(calls,5);
});

test('account-wide 429 cooldown covers context and activation across four keys without replay',async()=>{
  let time=0,calls=0,limited=true;const client=createPiknoClient({now:()=>time,fetchImpl:async(target,init)=>{
    calls++;if(limited)return new Response('{}',{status:429,headers:{'Retry-After':'120'}});
    if(target.endsWith('/activate'))return json(activation);
    const kind=Object.entries(fields).find(([,field])=>new Headers(init.headers).get('authorization')==='Bearer '+keys[field])[0];return json({user_id:7,group:kind+'-standard'});
  }}),cfg={...keys,piknoUserId:7};
  await assert.rejects(client.context(cfg,'image'),e=>e.statusCode===429&&e.retryAfterMs===120000);
  for(const kind of ['video','tool','chat'])await assert.rejects(client.context(cfg,kind),e=>e.statusCode===429&&e.retryAfterMs===120000);
  await assert.rejects(client.activateChat(cfg),e=>e.statusCode===429);assert.equal(calls,1);
  client.invalidate();time=119999;await assert.rejects(client.context(cfg,'image'),e=>e.retryAfterMs===1);assert.equal(calls,1);
  time=120000;limited=false;await client.context(cfg,'video');assert.equal(calls,2);
  await client.activateChat(cfg,{fresh:false});await client.activateChat(cfg,{fresh:false});assert.equal(calls,3);
  await client.activateChat(cfg);assert.equal(calls,4,'a fresh activation cannot use cached display authorization');
});

test('missing Retry-After cools free reads for one minute while other accounts remain independent',async()=>{
  let calls=0;const client=createPiknoClient({now:()=>0,fetchImpl:async()=>{calls++;return new Response('{}',{status:429});}});
  await assert.rejects(client.context({...keys,piknoUserId:7},'image'),e=>e.statusCode===429);
  await assert.rejects(client.context({...keys,piknoUserId:7},'video'),e=>e.retryAfterMs===60000);assert.equal(calls,1);
  await assert.rejects(client.context({...keys,piknoUserId:8},'video'),e=>e.statusCode===429);assert.equal(calls,2);
});

function bridgeFixture(){
  let time=0,stored={...keys,piknoUserId:7};const calls=[];
  const client={context:async(cfg,kind,options)=>{calls.push(['context',kind,options]);return {user_id:7};},catalog:async cfg=>{const kind=Object.entries(fields).find(([,field])=>cfg[field])[0];calls.push(['catalog',kind]);return {data:[{id:kind,type:kind,provider:kind==='tool'?'tool':'generate'}]};},activateChat:async()=>{calls.push(['activate','chat']);return activation;},invalidate(){}};
  const keyStore={persistent:true,read:()=>({...stored}),write:value=>{stored={...value};},clear:()=>{stored={};}};
  return {bridge:createPiknoBridge({client,keyStore,now:()=>time}),client,calls,store:()=>stored,advance:value=>{time+=value;}};
}

test('native selected-kind checks only that key; subsequent full connection shares its short result',async()=>{
  const f=bridgeFixture();const selected=await f.bridge.connection({kind:'image'});assert.equal(selected.image.state,'ready');assert.deepEqual(f.calls.map(value=>value.slice(0,2)),[['context','image'],['catalog','image']]);
  const [a,b]=await Promise.all([f.bridge.connection(),f.bridge.connection()]);assert.deepEqual({...a,checkedAt:undefined},{...b,checkedAt:undefined});assert.equal(a.chat.state,'ready');
  assert.equal(f.calls.filter(value=>value[0]==='context').length,4);assert.equal(f.calls.filter(value=>value[0]==='activate').length,1);
  await f.bridge.connection();assert.equal(f.calls.length,8);f.advance(15000);await f.bridge.connection();assert.equal(f.calls.length,16);
});

test('a failed fresh Key save preserves all existing values and cannot be authorized by a cached display result',async()=>{
  const f=bridgeFixture();await f.bridge.connection();const before={...f.store()};
  f.client.context=async(_cfg,_kind,options)=>{assert.equal(options.fresh,true);throw Object.assign(Error('private'),{statusCode:429,retryAfterMs:120000});};
  await assert.rejects(f.bridge.configure({piknoImageKey:'sk-'+'n'.repeat(32)},{expectedUserId:7,requireProtected:true}),e=>e.statusCode===429);
  assert.deepEqual(f.store(),before);
});

test('cached connection expires, returns bounded 429 state and configuration changes invalidate pending results',async()=>{
  const f=bridgeFixture();await f.bridge.connection({kind:'image'});f.advance(15000);
  f.client.context=async()=>{throw Object.assign(Error('private key and endpoint'),{statusCode:429,retryAfterMs:120000});};
  let value=await f.bridge.connection({kind:'image'});assert.equal(value.image.state,'rate_limited');assert.equal(value.image.retryAfterMs,120000);assert.equal(value.image.httpStatus,429);assert.doesNotMatch(JSON.stringify(value),/private key|endpoint|sk-/);
  f.advance(119999);value=await f.bridge.connection({kind:'image'});assert.equal(value.image.retryAfterMs,1);
  f.advance(1);let release;f.client.context=async()=>new Promise(resolve=>release=resolve);const pending=f.bridge.connection({kind:'image'}),rejected=assert.rejects(pending,e=>e.statusCode===409);
  f.client.context=async()=>({user_id:7});await f.bridge.configure({piknoImageKey:'sk-'+'n'.repeat(32)});release({user_id:7});await rejected;
});
