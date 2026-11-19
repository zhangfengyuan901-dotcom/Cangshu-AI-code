import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import worker,{LlmExecutionGuard} from '../cloudflare/llm-worker/src/worker.js';

const enc=new TextEncoder(),alias='pikno-chat-standard';
const policy='pikno-text-three-actual-usage-v2';
const routes=[{endpoint:'ep-offline-primary',version:'260915'},{endpoint:'ep-offline-second',version:'260915'},{endpoint:'ep-offline-older',version:'260628'}];
const secret='offline-only-pikno-bridge-secret-32-bytes';
const b64=bytes=>Buffer.from(bytes).toString('base64url');
const hash=async bytes=>Buffer.from(await crypto.subtle.digest('SHA-256',bytes)).toString('hex');
const payload=(patch={})=>({model:alias,input:'Only reply OK',max_output_tokens:32,stream:false,...patch});
function namespace(beforeWrite){
  const objects=new Map(),values=[],storages=new Map();
  return {objects,values,storages,restart(){objects.clear();},idFromName:name=>name,get(name){
    if(!storages.has(name)){
      const stored=new Map();let tail=Promise.resolve();
      const txn={get:async key=>structuredClone(stored.get(key)),put:async(key,value)=>{await beforeWrite?.(value,values.length);stored.set(key,structuredClone(value));values.push({key,value:structuredClone(value)});}};
      const storage={transaction(fn){const result=tail.then(()=>fn(txn));tail=result.catch(()=>{});return result;}};
      storages.set(name,{storage,stored});
    }
    if(!objects.has(name))objects.set(name,new LlmExecutionGuard({storage:storages.get(name).storage}));
    return objects.get(name);
  }};
}
const environment=()=>({LLM_BILLING_MODE:'actual_usage_v1',PIKNO_LLM_MODEL_VERIFIED:'true',ARK_API_KEY:'offline-upstream-key',
  PIKNO_LLM_ROUTES:JSON.stringify(routes),
  TOKEN_SIGNING_KEY:'offline-object-envelope-signing-secret-32-bytes',PIKNO_ASSISTANT_BRIDGE_SECRET:secret,LLM_EXECUTIONS:namespace()});
async function ticket(body,patch={}){
  const now=Math.floor(Date.now()/1000),request_id='a'.repeat(32);
  const claims={v:2,aud:'pikno-llm-execute',billing_mode:'actual_usage_v1',uid:2,request_id,jti:request_id,body_sha256:await hash(enc.encode(body)),
    model_alias:alias,max_output_tokens:32,route_policy:policy,iat:now,exp:now+60,...patch};
  const encoded=b64(enc.encode(JSON.stringify(claims)));
  const key=await crypto.subtle.importKey('raw',enc.encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  return encoded+'.'+b64(await crypto.subtle.sign('HMAC',key,enc.encode(encoded)));
}
async function request(body=JSON.stringify(payload()),claims={},token,signal){
  return new Request('https://inference.test/internal/pikno/responses',{method:'POST',headers:{'content-type':'application/json',
    authorization:'Bearer '+(token??await ticket(body,claims))},body,signal});
}
async function rejected(response){
  assert.equal(response.status,429);assert.equal(response.headers.get('x-pikno-execution-state'),'rejected_before_execution');
  assert.equal(response.headers.get('x-pikno-submission-state'),null);
  assert.deepEqual(await response.json(),{error:{code:'llm_rejected_before_execution',submission_state:'rejected_before_execution',message:'对话请求在执行前被拒绝，请稍后重新确认'}});
}
const limit=(code='RateLimitExceeded.EndpointRPMExceeded',patch={})=>Response.json({error:{type:'TooManyRequests',code,message:'offline rejection',param:null,...patch}},{status:429});
const completed=()=>Response.json({object:'response',id:'resp-offline',status:'completed',model:'private-provider-model',usage:{input_tokens:2,output_tokens:3,total_tokens:5}});

test('failed paid dispatch records only fixed diagnostic categories without leaking provider or customer data',async t=>{
 const logs=[];t.mock.method(console,'warn',value=>logs.push(JSON.parse(value)));
 t.mock.method(globalThis,'fetch',async()=>Response.json({error:{code:'InvalidParameter.InvalidValue',param:'file_id',message:'Invalid file_id private-secret ep-sensitive-model file-private-reference user-private-prompt',request_id:'private-request'}},{status:400}));
 const response=await worker.fetch(await request(),environment());
 assert.equal(response.status,400);assert.equal((await response.json()).error.submission_state,'unknown');
 assert.deepEqual(logs,[{tag:'llm_diagnostic_v1',format:1,status:400,phase:'upstream_rejected',code:'InvalidParameter.InvalidValue',field:'file_id',body:'parsed',flags:['file','invalid'],reasons:['model','upstream_id']}]);
 assert.doesNotMatch(JSON.stringify(logs),/private|sensitive/);
});

test('file rejection reason categories distinguish state, project, format and unsupported references without text',async t=>{
 const logs=[];let calls=0;t.mock.method(console,'warn',value=>logs.push(JSON.parse(value)));
 const cases=[
  ['file_id file-private does not exist in the project',['not_exist','project','upstream_id']],
  ['file_id is not active: status processing',['not_active','status','processing']],
  ['file_id format is not supported by this model',['not_supported','format','model']],
  ['file_id type mismatch; hf1_private_reference',['type','mismatch','opaque_handle']],
 ];
 for(const [message,reasons] of cases){
  t.mock.method(globalThis,'fetch',async()=>{calls++;return Response.json({error:{code:'InvalidParameter',param:'file_id',message}},{status:400});});
  const response=await worker.fetch(await request(),environment());
  assert.equal(response.status,400);assert.equal((await response.json()).error.submission_state,'unknown');
  assert.deepEqual(logs.at(-1).reasons,reasons);
 }
 assert.equal(calls,cases.length);assert.doesNotMatch(JSON.stringify(logs),/private_reference|file-private/);
});

test('oversized and stalled rejection diagnostics remain bounded and never authorize another dispatch',async t=>{
 t.mock.method(console,'warn',()=>{});let calls=0,cancelled=false;
 for(const body of ['x'.repeat(16385),new ReadableStream({cancel(){cancelled=true;}})]){
  t.mock.method(globalThis,'fetch',async()=>{calls++;return new Response(body,{status:400,headers:{'content-type':'application/json'}});});
  const start=Date.now(),response=await worker.fetch(await request(),environment());
  assert.equal(response.status,400);assert.equal((await response.json()).error.submission_state,'unknown');assert(Date.now()-start<2500);
 }
 assert.equal(calls,2);assert.equal(cancelled,true);
});

test('network and durable claim failures have separate fixed diagnostic phases and preserve unknown',async t=>{
 const logs=[];t.mock.method(console,'warn',value=>logs.push(JSON.parse(value)));
 t.mock.method(globalThis,'fetch',async()=>{throw Error('private-endpoint-secret');});
 const failed=await worker.fetch(await request(),environment());assert.equal(failed.status,503);await failed.arrayBuffer();
 const env=environment();env.LLM_EXECUTIONS.get=()=>{throw Error('private-storage-detail');};
 const guard=await worker.fetch(await request(),env);assert.equal(guard.status,503);await guard.arrayBuffer();
 assert.deepEqual(logs.map(x=>x.phase),['upstream_fetch','guard_claim_failed']);assert.doesNotMatch(JSON.stringify(logs),/private/);
});
async function noSubmission(response,status){
  assert.equal(response.status,status);
  assert.equal(response.headers.get('x-pikno-submission-state'),'not_submitted');
  const body=await response.json();assert.equal(body.error.code,'llm_not_submitted');assert.equal(body.error.submission_state,'not_submitted');
  assert.doesNotMatch(JSON.stringify(body),/ep-offline|offline-upstream|bridge-secret/);
}

test('paid is the fail-closed default; legacy activation, direct inference and Files cannot bypass billing',async t=>{
  const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});
  globalThis.fetch=()=>assert.fail('disabled legacy routes must not call any service');
  for(const mode of [undefined,'paid','actual_usage_v1','typo',''])for(const path of ['/v1/activate','/internal/pikno/activate','/api/v3/responses','/api/v3/files','/api/v3/files/ho1_fake']){
    const env={...environment(),LLM_BILLING_MODE:mode};
    await noSubmission(await worker.fetch(new Request('https://inference.test'+path,{method:'POST',body:'{}'}),env),403);
    assert.equal(env.LLM_EXECUTIONS.values.length,0);
  }
});

test('paid dispatch remains disabled without verified model, three-route Secret, signing Secret or durable namespace',async t=>{
  const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});globalThis.fetch=()=>assert.fail('unverified model cannot be called');
  for(const patch of [{LLM_BILLING_MODE:undefined},{LLM_BILLING_MODE:'paid'},{LLM_BILLING_MODE:''},{LLM_BILLING_MODE:'legacy'},
    {PIKNO_LLM_MODEL_VERIFIED:undefined},{PIKNO_LLM_MODEL_VERIFIED:'false'},
    {PIKNO_LLM_ROUTES:undefined},{PIKNO_LLM_ROUTES:'https://untrusted.test'},
    {ARK_API_KEY:''},{TOKEN_SIGNING_KEY:'short'},{LLM_EXECUTIONS:undefined}]){
    const env={...environment(),...patch};await noSubmission(await worker.fetch(await request(),env),503);
  }
});

test('exact HMAC claims, uid, audience, lifetime, alias and raw bytes are required before durable claim',async t=>{
  const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});globalThis.fetch=()=>assert.fail('invalid tickets cannot dispatch');
  const now=Math.floor(Date.now()/1000);
  // Keep the +6s/+61s boundary cases invalid across ticket creation and
  // verification; wall-clock rollover must not turn them into valid claims.
  t.mock.method(Date,'now',()=>now*1000);
  for(const patch of [{v:1},{billing_mode:undefined},{billing_mode:'reserve_v1'},{aud:'hamster-pikno-activation'},{uid:0},{uid:'2'},{request_id:'raw'},
    {jti:'b'.repeat(32)},{body_sha256:'0'.repeat(64)},{model_alias:'other-model'},
    {max_output_tokens:0},{max_output_tokens:65537},{route_policy:undefined},{route_policy:'old-policy'},
    {input_token_bound:1},{input_token_bound:0},{input_token_bound:'1000'},{input_token_bound:1024001},
    {iat:now+6},{exp:now-1},{exp:now+61},{exp:now-5,iat:now-5}]){
    const env=environment();await noSubmission(await worker.fetch(await request(undefined,patch),env),401);assert.equal(env.LLM_EXECUTIONS.values.length,0);
  }
  const env=environment();
  await noSubmission(await worker.fetch(await request(undefined,{},'bad.token'),env),401);
  const body=JSON.stringify(payload()),signed=await ticket(body);
  await noSubmission(await worker.fetch(await request(body+' ',{},signed),env),401);
  assert.equal(env.LLM_EXECUTIONS.values.length,0);
});

test('previous prepaid execution tickets cannot authorize an actual-usage operation',async t=>{
  const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});globalThis.fetch=()=>assert.fail('old prepaid tickets cannot dispatch');
  const env=environment();
  await noSubmission(await worker.fetch(await request(undefined,{v:1,billing_mode:undefined,route_policy:'pikno-text-three-v1',input_token_bound:1000}),env),401);
  assert.equal(env.LLM_EXECUTIONS.values.length,0);
});

test('signed body accepts text only; arbitrary models, URLs, Files, tools and unsigned max outputs fail before dispatch',async t=>{
  const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});globalThis.fetch=()=>assert.fail('unverified capabilities cannot be called');
  const variants=[{model:'client-ep'},{max_output_tokens:33},{stream:'true'},{instructions:[]},{url:'https://other.test'},
    {previous_response_id:'raw-provider-id'},{tools:[{type:'web_search'}]},{store:true},{input:[{role:'user',content:[{type:'input_file',file_id:'other-file'}]}]},
    {input:[{role:'user',content:[{type:'input_image',image_url:'https://other.test'}]}]},{input:[{role:'user',content:'hello',id:'foreign-id'}]},
    {input:[]},{input:{text:'hello'}}];
  for(const patch of variants){const env=environment();await noSubmission(await worker.fetch(await request(JSON.stringify(payload(patch))),env),400);assert.equal(env.LLM_EXECUTIONS.values.length,0);}
});

test('durable dispatch is atomic for concurrent replay, survives worker reuse and stores no payload or credentials', {concurrency:false},async t=>{
  const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});let calls=0;
  globalThis.fetch=async(_url,options)=>{calls++;assert.equal(JSON.parse(options.body).model,routes[0].endpoint);return completed();};
  const env=environment(),body=JSON.stringify(payload());
  const results=await Promise.all(Array.from({length:12},async()=>worker.fetch(await request(body),env)));
  assert.equal(results.filter(r=>r.status===200).length,1);assert.equal(results.filter(r=>r.status===409).length,11);assert.equal(calls,1);
  assert.equal((await worker.fetch(await request(body),{...env})).status,409);assert.equal(calls,1);
  assert.equal(env.LLM_EXECUTIONS.values.length,3);
  assert.doesNotMatch(JSON.stringify(env.LLM_EXECUTIONS.values),/uid|Only reply|input|offline-upstream|ep-|request_id/);
  assert.equal([...env.LLM_EXECUTIONS.objects.keys()][0].length,64);
});

test('JSON execution uses one fixed endpoint, no client headers and retains usage without double charging reasoning', {concurrency:false},async t=>{
  const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});const calls=[];
  globalThis.fetch=async(url,options)=>{calls.push({url,options});return Response.json({object:'response',id:'resp-private',status:'completed',model:'private-provider-model',
    output:[{type:'message',role:'assistant',id:'msg-private',content:[{type:'output_text',text:'OK ep-offline-primary ep-offline-second ep-offline-older offline-upstream-key'}]}],
    usage:{input_tokens:88,output_tokens:230,total_tokens:318,input_tokens_details:{cached_tokens:12},output_tokens_details:{reasoning_tokens:211}},
    private_provider_url:'https://ark.cn-beijing.volces.com',metadata:{key:'offline-upstream-key'}});};
  const env=environment(),result=await worker.fetch(await request(JSON.stringify(payload({input:[{role:'user',content:[{type:'input_text',text:'hello'}]}]}))),env);
  const body=await result.json();assert.equal(result.status,200);assert.equal(calls.length,1);
  assert.equal(calls[0].url,'https://ark.cn-beijing.volces.com/api/v3/responses');
  const sent=JSON.parse(calls[0].options.body);assert.equal(sent.model,routes[0].endpoint);assert.equal(sent.store,false);assert.equal(sent.service_tier,'default');
  assert.deepEqual(Object.keys(calls[0].options.headers).sort(),['authorization','content-type']);
  assert.equal(calls[0].options.headers.authorization,'Bearer offline-upstream-key');
  assert.equal(body.model,alias);assert.match(body.id,/^ho1_/);assert.equal(body.usage.output_tokens,230);assert.equal(body.usage.output_tokens_details.reasoning_tokens,211);
  assert.equal(body.usage.total_tokens,318);assert.equal(body.usage.input_tokens_details.cached_tokens,12);
  assert.doesNotMatch(JSON.stringify(body),/private-provider-model|resp-private|msg-private|ep-offline|offline-upstream|metadata|volces/);
});

test('SSE text and terminal usage remain accurate and provider errors/headers are not exposed', {concurrency:false},async t=>{
  const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});
  globalThis.fetch=async()=>new Response('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"OK","item_id":"msg-private","provider_key":"offline-upstream-key"}\n\nevent: response.completed\ndata: {"type":"response.completed","response":{"id":"resp-private","object":"response","status":"completed","model":"secret-provider-model","usage":{"input_tokens":42,"output_tokens":846,"total_tokens":888,"output_tokens_details":{"reasoning_tokens":408}}}}\n\ndata: [DONE]\n\n',
    {headers:{'content-type':'text/event-stream','x-provider-secret':'offline-upstream-key'}});
  const result=await worker.fetch(await request(JSON.stringify(payload({stream:true}))),environment()),body=await result.text();
  assert.match(body,/response\.completed/);assert.match(body,/"output_tokens":846/);assert.match(body,/"reasoning_tokens":408/);assert.match(body,/"total_tokens":888/);
  assert.match(body,/'?\[DONE\]/);assert.equal(result.headers.get('x-provider-secret'),null);
  assert.doesNotMatch(body,/secret-provider-model|resp-private|msg-private|provider_key|offline-upstream/);
});

test('network failures, upstream errors and ambiguous durable replies never fail over or authorize replay', {concurrency:false},async t=>{
  const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});
  for(const status of [0,400,401,429,500,502,503]){
    const env=environment();let calls=0;
    globalThis.fetch=async()=>{calls++;if(status===0)throw new Error('offline-upstream-key ep-offline-verified-primary');return Response.json({error:'offline-upstream-key ep-offline-verified-primary'},{status});};
    const result=await worker.fetch(await request(),env);assert.equal(result.headers.get('x-pikno-submission-state'),null);
    assert.equal((await result.json()).error.submission_state,'unknown');assert.equal(calls,1);
    assert.equal((await worker.fetch(await request(),env)).status,409);assert.equal(calls,1);
  }
  const env=environment();let calls=0;globalThis.fetch=async()=>{calls++;return Response.json({});};
  env.LLM_EXECUTIONS={idFromName:name=>name,get:()=>({fetch:async()=>{throw new Error('uncertain durable reply');}})};
  const result=await worker.fetch(await request(),env);assert.equal((await result.json()).error.submission_state,'unknown');assert.equal(calls,0);
});

test('missing usage is not invented, and a terminal failure retains its actual usage without provider errors', {concurrency:false},async t=>{
  const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});
  globalThis.fetch=async()=>Response.json({object:'response',id:'resp-no-usage',status:'completed',output:[]});
  const missing=await(await worker.fetch(await request(),environment())).json();assert.equal(missing.usage,undefined);
  globalThis.fetch=async()=>Response.json({object:'response',id:'resp-failed',status:'failed',usage:{input_tokens:9,output_tokens:7,total_tokens:16},
    error:{code:'private-provider-code',message:'offline-upstream-key ep-offline-verified-primary'},incomplete_details:{reason:'private-provider-reason'}});
  const failed=await(await worker.fetch(await request(),environment())).json();
  assert.deepEqual(failed.usage,{input_tokens:9,output_tokens:7,total_tokens:16});assert.equal(failed.status,'failed');
  assert.equal(failed.incomplete_details.reason,'unknown');assert.doesNotMatch(JSON.stringify(failed),/private-provider|offline-upstream|ep-offline/);
});

test('durable marker survives actor recreation, and claim routes are not a public inference API',async()=>{
  const stored=new Map(),storage={transaction:fn=>fn({get:async key=>stored.get(key),put:async(key,value)=>stored.set(key,value)})};
  const request=()=>new Request('https://execution.internal/claim',{method:'POST',body:JSON.stringify({route_policy:policy})});
  assert.equal((await new LlmExecutionGuard({storage}).fetch(request())).status,200);
  assert.equal((await new LlmExecutionGuard({storage}).fetch(request())).status,409);
  assert.equal((await new LlmExecutionGuard({storage}).fetch(new Request('https://execution.internal/api/v3/responses',{method:'POST'}))).status,404);
});

test('same request id is independent by authenticated uid, but a changed body for one uid cannot resubmit', {concurrency:false},async t=>{
  const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});let calls=0;globalThis.fetch=async()=>{calls++;return Response.json({object:'response',id:'resp-safe',status:'completed'});};
  const env=environment();assert.equal((await worker.fetch(await request(),env)).status,200);
  assert.equal((await worker.fetch(await request(JSON.stringify(payload({input:'different text'}))),env)).status,409);
  assert.equal((await worker.fetch(await request(undefined,{uid:3}),env)).status,200);assert.equal(calls,2);
});

test('local actual-usage deploy config defaults unverified and provides durable migration without any secret values',()=>{
  const config=JSON.parse(readFileSync(new URL('../cloudflare/llm-worker/wrangler.jsonc',import.meta.url),'utf8'));
  assert.equal(config.vars.LLM_BILLING_MODE,'actual_usage_v1');assert.equal(config.vars.PIKNO_LLM_MODEL_VERIFIED,'false');
  assert.deepEqual(config.durable_objects.bindings,[{name:'LLM_EXECUTIONS',class_name:'LlmExecutionGuard'}]);
  assert.ok(config.migrations.some(m=>m.new_sqlite_classes.includes('LlmExecutionGuard')));
  assert.ok(config.secrets.required.includes('PIKNO_LLM_ROUTES'));
  assert.ok(!config.secrets.required.includes('PIKNO_LLM_PRIMARY_ENDPOINT'));
  assert.ok(config.secrets.required.includes('PIKNO_ASSISTANT_BRIDGE_SECRET'));
  assert.doesNotMatch(JSON.stringify(config.vars),/ARK_API_KEY|LLM_ENDPOINTS|ep-|PIKNO_LLM_ROUTES|PIKNO_LLM_PRIMARY_ENDPOINT/);
});

test('route Secret requires exactly three unique endpoints with fixed version order and no additional fields',async t=>{
  const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});globalThis.fetch=()=>assert.fail('invalid route profile must fail before claim');
  for(const value of [[],routes.slice(0,2),[...routes,routes[0]],[routes[0],routes[0],routes[2]],
    [routes[2],routes[1],routes[0]],[{...routes[0],version:260915},...routes.slice(1)],
    [{...routes[0],endpoint:'https://untrusted.test'},...routes.slice(1)],[{...routes[0],endpoint:[routes[0].endpoint]},...routes.slice(1)],
    [{...routes[0],context:9999999},...routes.slice(1)],{},null]){
    const env={...environment(),PIKNO_LLM_ROUTES:JSON.stringify(value)};
    await noSubmission(await worker.fetch(await request(),env),503);assert.equal(env.LLM_EXECUTIONS.values.length,0);
  }
});

test('only exact native endpoint RPM/TPM 429 advances the same operation in ordered slots', {concurrency:false},async t=>{
  const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});const calls=[],env=environment();
  globalThis.fetch=async(_url,options)=>{
    const body=JSON.parse(options.body),intent=env.LLM_EXECUTIONS.values.at(-1).value;
    assert.equal(intent.state,'intent');assert.equal(intent.next,calls.length);assert.equal(intent.attempts.at(-1).state,'intent');
    calls.push(body);return calls.length===1?limit():completed();
  };
  const originalInput=[{role:'system',content:'keep all context'},{role:'user',content:[{type:'input_text',text:'Only reply OK'}]}];
  const response=await worker.fetch(await request(JSON.stringify(payload({input:originalInput,instructions:'do not truncate'}))),env);
  assert.equal(response.status,200);assert.deepEqual(calls.map(body=>body.model),routes.slice(0,2).map(route=>route.endpoint));
  for(const body of calls){assert.deepEqual(body.input,originalInput);assert.equal(body.instructions,'do not truncate');assert.equal(body.max_output_tokens,32);assert.equal(body.store,false);assert.equal(body.service_tier,'default');}
  const journal=env.LLM_EXECUTIONS.values.at(-1).value;
  assert.equal(journal.state,'accepted');assert.deepEqual(journal.attempts.map(item=>item.state),['endpoint_limit','accepted']);
  assert.equal((await worker.fetch(await request(),env)).status,409);assert.equal(calls.length,2);
  assert.doesNotMatch(JSON.stringify(env.LLM_EXECUTIONS.values),/ep-|upstream|Only reply|instructions|keep all context|input|uid|request_id/);
});

test('two proven endpoint admission rejections skip the configured older route and produce the rejection receipt', {concurrency:false},async t=>{
  const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});let calls=0;const env=environment();
  globalThis.fetch=async()=>{calls++;return limit();};
  await rejected(await worker.fetch(await request(),env));assert.equal(calls,2);
  assert.equal(env.LLM_EXECUTIONS.values.at(-1).value.state,'rejected');
  assert.deepEqual(env.LLM_EXECUTIONS.values.at(-1).value.attempts.map(item=>item.state),['endpoint_limit','endpoint_limit','skipped']);
  env.LLM_EXECUTIONS.restart();assert.equal((await worker.fetch(await request(),{...env})).status,409);assert.equal(calls,2);
});

test('shared model/API RPM/TPM admission limits stop without testing a second endpoint', {concurrency:false},async t=>{
  const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});
  for(const code of ['ModelAccountRpmRateLimitExceeded','ModelAccountTpmRateLimitExceeded','APIAccountRpmRateLimitExceeded']){
    const env=environment();let calls=0;globalThis.fetch=async()=>{calls++;return limit(code);};
    await rejected(await worker.fetch(await request(),env));assert.equal(calls,1);assert.equal(env.LLM_EXECUTIONS.values.at(-1).value.attempts[0].state,'shared_limit');
  }
});

test('unknown 429 code/type/envelope, acceptance evidence, invalid JSON or oversized errors cannot authorize failover or a refund receipt', {concurrency:false},async t=>{
  const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});
  const rejectedCode='RateLimitExceeded.EndpointRPMExceeded';
  const bodies=[
    ()=>limit('ServerOverloaded'),()=>limit('RequestBurstTooFast'),()=>limit('QuotaExceeded'),()=>limit('ModelAccountTpdRateLimitExceeded'),
    ()=>limit('APIAccountTpmRateLimitExceeded'),()=>limit(rejectedCode,{type:'Other'}),()=>limit(rejectedCode,{usage:{input_tokens:0}}),
    ()=>Response.json({error:{code:rejectedCode,type:'TooManyRequests'},usage:{input_tokens:1}},{status:429}),
    ()=>Response.json({error:{code:rejectedCode,type:'TooManyRequests'},id:'resp-accepted'},{status:429}),
    ()=>Response.json({error:{code:rejectedCode,type:'TooManyRequests'},output:[]},{status:429}),
    ()=>Response.json({error:{code:rejectedCode,type:'TooManyRequests'},status:'in_progress'},{status:429}),
    ()=>new Response('{"error":{"code":"'+rejectedCode+'","type":"TooManyRequests"}} trailing',{status:429,headers:{'content-type':'application/json'}}),
    ()=>new Response('{"error":{"code":"Other","code":"'+rejectedCode+'","type":"TooManyRequests"}}',{status:429,headers:{'content-type':'application/json'}}),
    ()=>new Response('{"error":{"type":"TooManyRequests","code":"InternalServiceError","co\\u0064e":"'+rejectedCode+'"}}',{status:429,headers:{'content-type':'application/json'}}),
    ()=>new Response('{"\\u0065rror":{"usage":{}},"error":{"code":"'+rejectedCode+'","type":"TooManyRequests"}}',{status:429,headers:{'content-type':'application/json'}}),
    ()=>new Response('{"error":{"code":"'+rejectedCode+'","type":"TooManyRequests"}}',{status:429,headers:{'content-type':'text/event-stream'}}),
    ()=>limit(rejectedCode,{message:'x'.repeat(17000)}),
    ()=>new Response(new Uint8Array([255,254,123]),{status:429,headers:{'content-type':'application/json'}}),
  ];
  for(const make of bodies){let calls=0;const env=environment();globalThis.fetch=async()=>{calls++;return make();};
    const response=await worker.fetch(await request(),env);assert.equal((await response.json()).error.submission_state,'unknown');
    assert.equal(response.headers.get('x-pikno-execution-state'),null);assert.equal(response.headers.get('x-pikno-submission-state'),null);assert.equal(calls,1);
  }
});

test('ordinary Unicode escapes inside the native error message do not count as escaped field names', {concurrency:false},async t=>{
  const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});let calls=0;
  globalThis.fetch=async()=>{calls++;return new Response('{"error":{"type":"TooManyRequests","code":"APIAccountRpmRateLimitExceeded","message":"\\u8bf7\\u7a0d\\u540e"}}',{status:429,headers:{'content-type':'application/json'}});};
  await rejected(await worker.fetch(await request(),environment()));assert.equal(calls,1);
});

test('unknown errors on a later slot stop there; previous rejected attempts do not turn an ambiguous result into free execution', {concurrency:false},async t=>{
  const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});
  for(const status of [0,400,404,499,500,503]){let calls=0;globalThis.fetch=async()=>{calls++;if(calls===1)return limit();if(!status)throw Error('network');return Response.json({error:{code:'unknown'}},{status});};
    const response=await worker.fetch(await request(),environment());assert.equal((await response.json()).error.submission_state,'unknown');assert.equal(calls,2);assert.equal(response.headers.get('x-pikno-execution-state'),null);
  }
});

test('actual-usage has no pretend input bound; technical body/message limits reject before claim', {concurrency:false},async t=>{
  const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});globalThis.fetch=()=>assert.fail('oversized requests cannot dispatch');
  for(const [input,status] of [['x'.repeat(2*1024*1024),413],[Array.from({length:201},()=>({role:'user',content:'hello'})),400]]){
    const env=environment();await noSubmission(await worker.fetch(await request(JSON.stringify(payload({input}))),env),status);
    assert.equal(env.LLM_EXECUTIONS.values.length,0);
  }
});

test('2xx acceptance permanently closes failover even for malformed JSON or a later SSE error', {concurrency:false},async t=>{
  const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});
  for(const make of [()=>new Response('invalid JSON',{headers:{'content-type':'application/json'}}),
    ()=>new Response('event: response.failed\ndata: {"type":"response.failed","error":{"code":"RateLimitExceeded.EndpointRPMExceeded"}}\n\n',{headers:{'content-type':'text/event-stream'}}),
    ()=>new Response(new ReadableStream({start(controller){controller.enqueue(enc.encode('data: {"type":"response.output_text.delta","delta":"partial"}\n\n'));controller.error(Error('stream interrupted'));}}),{headers:{'content-type':'text/event-stream'}})]){
    let calls=0;const env=environment();globalThis.fetch=async()=>{calls++;return make();};const response=await worker.fetch(await request(),env);
    try{await response.text();}catch{}
    assert.equal(calls,1);assert.equal(env.LLM_EXECUTIONS.values.at(-1).value.state,'accepted');
    env.LLM_EXECUTIONS.restart();assert.equal((await worker.fetch(await request(),env)).status,409);assert.equal(calls,1);
  }
});

test('journal intent, rejection and accepted acknowledgement failures never cause another provider dispatch', {concurrency:false},async t=>{
  const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});
  for(const failAt of [0,1,2]){
    let calls=0;const env=environment();env.LLM_EXECUTIONS=namespace((_value,index)=>{if(index===failAt)throw Error('storage unavailable');});
    globalThis.fetch=async()=>{calls++;return limit();};const response=await worker.fetch(await request(),env);
    assert.equal((await response.json()).error.submission_state,'unknown');assert.equal(calls,failAt<2?0:1);
  }
  for(const path of ['/intent','/rejected','/accepted']){
    let calls=0,cancelled=false;const env=environment(),get=env.LLM_EXECUTIONS.get.bind(env.LLM_EXECUTIONS);
    env.LLM_EXECUTIONS.get=name=>({async fetch(request){const result=await get(name).fetch(request);if(new URL(request.url).pathname===path)throw Error('lost acknowledgement');return result;}});
    globalThis.fetch=async()=>{calls++;return path==='/accepted'?new Response(new ReadableStream({cancel(){cancelled=true;}}),{headers:{'content-type':'application/json'}}):limit();};
    const response=await worker.fetch(await request(),env);assert.equal((await response.json()).error.submission_state,'unknown');assert.equal(calls,path==='/intent'?0:1);
    if(path==='/accepted')assert.equal(cancelled,true);
    env.LLM_EXECUTIONS.restart();assert.equal((await worker.fetch(await request(),env)).status,409);
  }
});

test('original v1 marker and v2 in-flight journal survive actor recreation and cannot resume or obtain another owner', {concurrency:false},async t=>{
  const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});let calls=0;globalThis.fetch=async()=>{calls++;throw Error('provider unavailable');};
  const env=environment(),name=await hash(enc.encode('pikno-llm-execute-v1\0'+'2\0'+'a'.repeat(32)));
  env.LLM_EXECUTIONS.get(name);env.LLM_EXECUTIONS.storages.get(name).stored.set('dispatched',{v:1,claimed_at:1});env.LLM_EXECUTIONS.restart();
  assert.equal((await worker.fetch(await request(),env)).status,409);assert.equal(calls,0);
  const fresh=environment();assert.equal((await(await worker.fetch(await request(),fresh)).json()).error.submission_state,'unknown');assert.equal(calls,1);
  fresh.LLM_EXECUTIONS.restart();assert.equal((await worker.fetch(await request(),{...fresh})).status,409);assert.equal(calls,1);
});

test('actual-usage policy upgrade cannot reclaim a previous prepaid v2 journal or owner',async t=>{
  const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});globalThis.fetch=()=>assert.fail('previous journals cannot be reclaimed');
  const env=environment(),name=await hash(enc.encode('pikno-llm-execute-v1\0'+'2\0'+'a'.repeat(32)));
  const owner='p'.repeat(43),previousPolicy='pikno-text-three-v1';
  env.LLM_EXECUTIONS.get(name);
  env.LLM_EXECUTIONS.storages.get(name).stored.set('dispatched',{v:2,policy_sha256:await hash(enc.encode(previousPolicy)),
    owner_sha256:await hash(enc.encode(owner)),next:1,state:'ready',attempts:[{slot:0,state:'endpoint_limit'}]});
  env.LLM_EXECUTIONS.restart();
  assert.equal((await worker.fetch(await request(),env)).status,409);
  const transition=new Request('https://execution.internal/intent',{method:'POST',headers:{authorization:'Bearer '+owner},
    body:JSON.stringify({route_policy:policy,slot:1})});
  assert.equal((await env.LLM_EXECUTIONS.get(name).fetch(transition)).status,409);
  assert.equal(env.LLM_EXECUTIONS.values.length,0);
});

test('journal owner capability is returned once, only its digest persists, and wrong owner/out-of-order transitions fail',async()=>{
  const env=environment(),guard=env.LLM_EXECUTIONS.get('offline-operation');
  const control=(path,body={},owner)=>new Request('https://execution.internal/'+path,{method:'POST',headers:{'content-type':'application/json',...(owner?{authorization:'Bearer '+owner}:{})},body:JSON.stringify({route_policy:policy,...body})});
  const first=await guard.fetch(control('claim')),claim=await first.json();assert.match(claim.owner,/^[A-Za-z0-9_-]{43}$/);
  assert.doesNotMatch(JSON.stringify(env.LLM_EXECUTIONS.values),new RegExp(claim.owner));
  assert.equal((await guard.fetch(control('claim'))).status,409);
  assert.equal((await guard.fetch(control('intent',{slot:0},'x'.repeat(43)))).status,409);
  assert.equal((await guard.fetch(control('intent',{slot:1},claim.owner))).status,409);
  assert.equal((await guard.fetch(control('rejected',{slot:0,outcome:'endpoint_limit'},claim.owner))).status,409);
  assert.equal((await guard.fetch(control('intent',{slot:0},claim.owner))).status,200);
  assert.equal((await guard.fetch(control('intent',{slot:0},claim.owner))).status,409);
  assert.equal((await guard.fetch(control('rejected',{slot:0,outcome:'network'},claim.owner))).status,409);
  assert.equal((await guard.fetch(control('rejected',{slot:0,outcome:'endpoint_limit'},claim.owner))).status,200);
  assert.equal((await guard.fetch(control('intent',{slot:1},claim.owner))).status,200);
});

test('incoming cancellation and overall ticket deadline are checked before advancing to another route', {concurrency:false},async t=>{
  const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});
  let calls=0;const controller=new AbortController(),env=environment(),get=env.LLM_EXECUTIONS.get.bind(env.LLM_EXECUTIONS);
  env.LLM_EXECUTIONS.get=name=>({async fetch(request){const response=await get(name).fetch(request);if(new URL(request.url).pathname==='/rejected')controller.abort();return response;}});
  globalThis.fetch=async()=>{calls++;return limit();};await rejected(await worker.fetch(await request(undefined,{},undefined,controller.signal),env));assert.equal(calls,1);
  const now=Date.now();let clock=now;t.mock.method(Date,'now',()=>clock);
  const timed=environment(),timedGet=timed.LLM_EXECUTIONS.get.bind(timed.LLM_EXECUTIONS);calls=0;
  timed.LLM_EXECUTIONS.get=name=>({async fetch(request){const response=await timedGet(name).fetch(request);if(new URL(request.url).pathname==='/rejected')clock=now+61000;return response;}});
  await rejected(await worker.fetch(await request(),timed));assert.equal(calls,1);
});
