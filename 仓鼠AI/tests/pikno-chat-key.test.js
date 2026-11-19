const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http');
const {createPiknoBridge}=require('../pikno.cjs');
const {createPiknoClient}=require('../pikno-client.cjs');
const {createPiknoKeyStore}=require('../pikno-key-store.cjs');
const keys={image:'sk-'+'i'.repeat(48),video:'sk-'+'v'.repeat(48),tool:'sk-'+'t'.repeat(48),chat:'sk-'+'c'.repeat(48)};
const fields={image:'piknoImageKey',video:'piknoVideoKey',tool:'piknoToolKey',chat:'piknoChatKey'};
const activation=()=>({authorized:true,enabled:true,available:true,balance_sufficient:true,model:'pikno-chat-standard',billing_mode:'actual_usage_v1',billing:{allow_debt:true,one_inflight_per_user:true},price_version:'chat-cny-9-45-actual-v2',pricing:{currency:'CNY',input_cny_per_million:9,output_cny_per_million:45},capabilities:{text:true,image:false,pdf:false,video:false,files:false,tools:false,sse:true,verified:true},limits:{max_output_tokens:4000}});
const json=value=>new Response(JSON.stringify(value),{headers:{'Content-Type':'application/json'}});
async function fixture(t){
  const store=createPiknoKeyStore(),calls=[];
  const client={invalidate(){},context:async(cfg,kind)=>{calls.push(['context',kind]);return {user_id:7,group:kind+'-standard'};},catalog:async cfg=>{assert.equal(cfg.piknoChatKey,undefined);calls.push(['catalog']);return {data:[]};},activateChat:async cfg=>{assert.equal(cfg.piknoChatKey,keys.chat);calls.push(['activate']);return activation();}};
  const bridge=createPiknoBridge({keyStore:store,client,taskStore:()=>({})});
  const server=http.createServer((req,res)=>bridge.handle(req,res,new URL(req.url,'http://'+req.headers.host)).catch(error=>{res.writeHead(error.statusCode||500,{'Content-Type':'application/json'});res.end(JSON.stringify({error:error.message}));}));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeIdleConnections?.();}));
  const base='http://127.0.0.1:'+server.address().port;
  const call=(route,body)=>fetch(base+route,{method:body?'POST':'GET',headers:{'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
  return {store,client,calls,bridge,call};
}
test('media Keys never grant chat activation or inference, including legacy persisted configurations',async t=>{
  const f=await fixture(t);
  for(const kind of ['image','video','tool']){
    f.store.write({piknoUserId:7,[fields[kind]]:keys[kind]});
    assert.equal(f.bridge.status().llmConfigured,false);assert.equal(f.bridge.status().chatConfigured,false);
    assert.throws(()=>f.bridge.inferenceKey(),error=>error.statusCode===401);
  }
  assert.deepEqual(f.calls,[]);
});
test('chat-only configuration activates freely without requesting any media catalogue',async t=>{
  const f=await fixture(t),saved=await f.call('/api/config',{piknoChatKey:keys.chat});assert.equal(saved.status,200);
  const status=await saved.json();assert.equal(status.chatConfigured,true);assert.equal(status.llmConfigured,true);
  assert.equal(status.configured,false);assert.equal(status.videoConfigured,false);assert.equal(status.toolConfigured,false);
  assert.equal(f.bridge.inferenceKey(),keys.chat);f.calls.length=0;
  const result=await(await f.call('/api/relay/connection')).json();
  assert.equal(result.chat.state,'ready');assert.equal(result.chat.authorized,true);assert.equal(result.chat.connected,true);
  assert.equal(result.chat.pricing.input_cny_per_million,9);assert.equal(result.chat.pricing.output_cny_per_million,45);
  assert.deepEqual(f.calls,[['context','chat'],['activate']]);
  assert.doesNotMatch(JSON.stringify(result),/sk-|piknoChatKey|user_id|"token"|ark|endpoint/i);
});
test('four Keys remain same-account and chat removal cannot erase media Keys or scope',async t=>{
  const f=await fixture(t),body=Object.fromEntries(Object.entries(fields).map(([kind,field])=>[field,keys[kind]]));
  assert.equal((await f.call('/api/config',body)).status,200);const before=f.store.read();
  const previous=f.client.context;f.client.context=async(cfg,kind)=>kind==='chat'?{user_id:8,group:'chat-standard'}:previous(cfg,kind);
  assert.equal((await f.call('/api/config',{})).status,409);assert.deepEqual(f.store.read(),before);
  assert.equal((await f.call('/api/config',{remove_chat:true})).status,200);
  assert.equal(f.store.read().piknoChatKey,undefined);assert.equal(f.store.read().piknoExecutionScope,before.piknoExecutionScope);
  for(const kind of ['image','video','tool'])assert.equal(f.store.read()[fields[kind]],keys[kind]);
  assert.equal(f.bridge.status().llmConfigured,false);assert.throws(()=>f.bridge.inferenceKey(),error=>error.statusCode===401);
});
test('disabled and insufficient-balance chat checks retain authorization without reporting live inference success',async t=>{
  for(const [patch,state] of [[{enabled:false,available:false},'unavailable'],[{balance_sufficient:false},'insufficient_balance']]){
    const f=await fixture(t);await f.call('/api/config',{piknoChatKey:keys.chat});
    f.client.activateChat=async()=>({...activation(),...patch});
    const {chat}=await(await f.call('/api/relay/connection')).json();assert.equal(chat.authorized,true);assert.equal(chat.state,state);assert.equal(chat.connected,false);
    assert.doesNotMatch(chat.message,/真实推理.*通过|生成成功|上游/);
  }
});
test('chat activation drops a stale account response after explicit removal',async t=>{
  const f=await fixture(t);await f.call('/api/config',{piknoChatKey:keys.chat});
  let release,entered;const gate=new Promise(resolve=>release=resolve),started=new Promise(resolve=>entered=resolve);
  f.client.activateChat=async()=>{entered();await gate;return activation();};
  const pending=f.call('/api/relay/connection');await started;await f.call('/api/config',{remove_chat:true});release();assert.equal((await pending).status,409);
});
test('client chat context requires the dedicated group and never widens media catalogue authorization',async()=>{
  const seen=[],client=createPiknoClient({fetchImpl:async(target,init)=>{seen.push([target,new Headers(init.headers).get('authorization')]);return json({user_id:7,group:'chat-standard'});}});
  const cfg={piknoChatKey:keys.chat};assert.equal((await client.context(cfg,'chat')).user_id,7);
  await assert.rejects(client.context(cfg,'video'),error=>[401,403].includes(error.statusCode));
  await assert.rejects(client.catalog(cfg),error=>error.statusCode===401);
  assert.equal(seen.length,1);assert.equal(seen[0][1],'Bearer '+keys.chat);
});
test('free v2 activation exposes only validated customer capability and pricing fields, never secret extras',async()=>{
  const calls=[],client=createPiknoClient({fetchImpl:async(target,init)=>{calls.push({target,init});return json({...activation(),token:'private-session',api_key:'private-key',upstream_model:'ep-private',pricing:{...activation().pricing,cost:6},limits:{...activation().limits,provider_id:'private'}});}});
  const safe=await client.activateChat({piknoChatKey:keys.chat});assert.deepEqual(safe,activation());
  assert.equal(calls.length,1);assert.equal(calls[0].target,'https://www.piknoai.com/assistant/v2/activate');assert.equal(calls[0].init.method,'POST');
  assert.equal(new Headers(calls[0].init.headers).get('authorization'),'Bearer '+keys.chat);assert.equal(calls[0].init.body,undefined);
  assert.doesNotMatch(JSON.stringify(safe),/private|cost|api_key|"token"|upstream/);
});
test('invalid free-activation metadata fails closed and upstream errors remain sanitized',async()=>{
  for(const patch of [{authorized:false},{model:'ep-private'},{billing_mode:undefined},{billing_mode:'prepaid'},{billing:{allow_debt:false,one_inflight_per_user:true}},{billing:{allow_debt:true,one_inflight_per_user:false}},{price_version:'<private>'},{pricing:{currency:'CNY',input_cny_per_million:-1,output_cny_per_million:45}},{limits:{max_output_tokens:Infinity}},{capabilities:{...activation().capabilities,text:'yes'}}]){
    const client=createPiknoClient({fetchImpl:async()=>json({...activation(),...patch})});await assert.rejects(client.activateChat({piknoChatKey:keys.chat}),error=>error.statusCode===502&&!/private/.test(error.message));
  }
  for(const status of [401,402,403,429,503]){
    let calls=0;const client=createPiknoClient({fetchImpl:async()=>{calls++;return new Response('ark private sk-secret',{status});}});
    await assert.rejects(client.activateChat({piknoChatKey:keys.chat}),error=>error.statusCode===status&&!/ark|private|sk-/.test(error.message));assert.equal(calls,1);
  }
});
