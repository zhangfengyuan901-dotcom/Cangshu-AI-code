const {test}=require('node:test');
const assert=require('node:assert/strict');
const {Readable,PassThrough}=require('node:stream');
const {createInferenceGateway}=require('../inference.cjs');
const version='chat-cny-9-45-actual-v2',id='a'.repeat(32);
const activation=patch=>({authorized:true,enabled:true,available:true,balance_sufficient:true,model:'pikno-chat-standard',price_version:version,
  billing_mode:'actual_usage_v1',billing:{allow_debt:true,one_inflight_per_user:true},
  pricing:{currency:'CNY',input_cny_per_million:9,output_cny_per_million:45},
  capabilities:{text:true,image:false,pdf:false,video:false,files:false,tools:false,sse:true,verified:true},
  limits:{max_output_tokens:512},...patch});
function fixture(reply){const calls=[];const gateway=createInferenceGateway({endpoint:'https://relay.test',pathPrefix:'/assistant',fetchImpl:async(url,options)=>{calls.push({url:String(url),options});return reply(url,options);}});return {gateway,calls};}
async function run(gateway,{route='/api/inference/api/v3/responses',method='POST',headers={},body={model:'hamster-auto',input:'hello',max_output_tokens:128},assertCurrent=()=>{}}={}){
  const req=Readable.from(method==='GET'?[]:[JSON.stringify(body)]);req.method=method;req.headers={'content-type':'application/json','x-pikno-request-id':id,'x-pikno-price-version':version,...headers};
  const chunks=[],res=new PassThrough();res.writeHead=(status,headers)=>{res.status=status;res.headers=headers;};res.on('data',x=>chunks.push(x));
  await gateway.handle(req,res,new URL('http://localhost'+route),'private-customer-key',{assertCurrent});return {res,body:Buffer.concat(chunks).toString()};
}
test('paid activation is free metadata, never a reusable inference session',async()=>{
 const f=fixture(()=>Response.json(activation()));const result=await f.gateway.status('private-customer-key');
 assert.equal(result.configured,true);assert.equal(result.authorized,true);assert.equal(result.price_version,version);
 assert.equal(result.billing_mode,'actual_usage_v1');assert.equal(result.billing.allow_debt,true);assert.deepEqual(result.limits,{max_output_tokens:512});
 assert.equal(f.calls[0].url,'https://relay.test/assistant/v2/activate');assert.equal(f.calls[0].options.headers.Authorization,'Bearer private-customer-key');
 assert.doesNotMatch(JSON.stringify(result),/private-customer-key|"token"|ep-/i);
});
test('paid response authenticates with the captured customer Key and sends the accepted price and durable operation',async()=>{
 const f=fixture(url=>String(url).endsWith('/activate')?Response.json(activation()):new Response('{"ok":true}'));
 await run(f.gateway);const call=f.calls[1];assert.equal(call.url,'https://relay.test/assistant/v2/responses');
 assert.equal(call.options.headers.get('authorization'),'Bearer private-customer-key');assert.equal(call.options.headers.get('x-pikno-request-id'),id);
 assert.equal(call.options.headers.get('x-pikno-price-version'),version);assert.equal(JSON.parse(call.options.body).model,'pikno-chat-standard');
});
test('missing operation, changed price and unsupported files never dispatch a paid response',async()=>{
 for(const input of [{headers:{'x-pikno-request-id':''}},{headers:{'x-pikno-price-version':'chat-old-v1'}},{route:'/api/inference/api/v3/files'}]){
  const f=fixture(()=>Response.json(activation()));await assert.rejects(run(f.gateway,input));assert.equal(f.calls.filter(x=>x.url.endsWith('/responses')).length,0);
 }
});
test('disabled service and insufficient funds do not trigger model requests',async()=>{
 for(const patch of [{available:false,enabled:false},{balance_sufficient:false}]){
  const f=fixture(()=>Response.json(activation(patch)));await assert.rejects(run(f.gateway));assert.equal(f.calls.length,1);
 }
});
test('paid network uncertainty is dispatched once without fallback or retry',async()=>{
 const f=fixture(url=>{if(String(url).endsWith('/activate'))return Response.json(activation());throw Error('private upstream connection');});
 await assert.rejects(run(f.gateway),e=>e.code==='llm_unknown'&&!/upstream/.test(e.message));assert.equal(f.calls.length,2);
});
test('billing status is read-only and strips private fields',async()=>{
 const f=fixture(()=>Response.json({request_id:id,status:'settled',price_version:version,billing_mode:'actual_usage_v1',currency:'CNY',reserved_quota:0,charged_quota:54,
  usage:{input_tokens:1,output_tokens:1,cached_tokens:0},upstream_model:'private',cost:123}));
 const result=await run(f.gateway,{method:'GET',route:'/api/inference/requests/'+id});assert.equal(f.calls.length,1);
 assert.equal(f.calls[0].url,'https://relay.test/assistant/v2/requests/'+id);assert.doesNotMatch(result.body,/private|upstream|cost/);
 assert.equal(JSON.parse(result.body).billing_mode,'actual_usage_v1');assert.equal(JSON.parse(result.body).charged_quota,54);
});
test('actual usage metadata has no prepaid dependency and rejects a stale or incomplete billing contract',async()=>{
 for(const patch of [{billing_mode:undefined},{billing_mode:'prepaid'},{billing:{allow_debt:false,one_inflight_per_user:true}},{billing:{allow_debt:true,one_inflight_per_user:false}}]){
  const f=fixture(()=>Response.json(activation(patch)));await assert.rejects(run(f.gateway));assert.equal(f.calls.length,1);
 }
});
test('debt prevents new paid dispatch while final billed cost remains readable without a cap',async()=>{
 const final=25000000;
 const f=fixture(url=>String(url).endsWith('/activate')?Response.json(activation({balance_sufficient:false})):Response.json({request_id:id,status:'settled',billing_mode:'actual_usage_v1',price_version:version,currency:'CNY',reserved_quota:0,charged_quota:final}));
 await assert.rejects(run(f.gateway),e=>e.statusCode===402);assert.equal(f.calls.filter(call=>call.url.endsWith('/responses')).length,0);
 const result=await run(f.gateway,{method:'GET',route:'/api/inference/requests/'+id});assert.equal(JSON.parse(result.body).charged_quota,final);
});
test('locked SDK null options are absent capabilities while non-null unpriced options are rejected',async()=>{
 const body={model:'hamster-auto',input:[{role:'user',content:[{type:'input_text',text:'hello'}]}],max_output_tokens:128,stream:true,store:null,expire_at:null,tools:null,previous_response_id:null,service_tier:null};
 const f=fixture(url=>String(url).endsWith('/activate')?Response.json(activation()):new Response('{}'));
 await run(f.gateway,{body});const sent=JSON.parse(f.calls[1].options.body);assert.deepEqual(Object.keys(sent).sort(),['input','max_output_tokens','model','stream']);
 for(const patch of [{store:true},{service_tier:'priority'},{tools:[{type:'web_search'}]},{previous_response_id:'private-ref'}]){
  const blocked=fixture(()=>Response.json(activation()));await assert.rejects(run(blocked.gateway,{body:{...body,...patch}}));assert.equal(blocked.calls.length,0);
 }
});
test('dispatched bills remain readable without creating a new operation',async()=>{
 const f=fixture(()=>Response.json({request_id:id,status:'dispatched',price_version:version,currency:'CNY',reserved_quota:100,charged_quota:0}));
 const result=await run(f.gateway,{method:'GET',route:'/api/inference/requests/'+id});assert.equal(JSON.parse(result.body).status,'dispatched');assert.equal(f.calls.length,1);
});
test('desktop build includes the required paid broker and no provider configuration',()=>{
 const {builder}=require('../release/current.json');assert.ok(builder.files.includes('pikno-inference.cjs'));
 const fs=require('node:fs'),path=require('node:path');
 const source=fs.readFileSync(path.join(__dirname,'../pikno-inference.cjs'),'utf8');assert.doesNotMatch(source,/ep-2026|ARK_API_KEY|PIKNO_LLM_PRIMARY_ENDPOINT/);
});
test('only explicit relay rejection is returned as not submitted; transport failure remains unknown',async()=>{
 const rejected=fixture(url=>String(url).endsWith('/activate')?Response.json(activation()):Response.json({error:{code:'llm_invalid_request',submission_state:'not_submitted'}},{status:400}));
 await assert.rejects(run(rejected.gateway),e=>e.code==='llm_not_submitted'&&e.submissionState==='not_submitted');
 const unknown=fixture(url=>String(url).endsWith('/activate')?Response.json(activation()):Response.json({error:{code:'llm_outcome_unknown',submission_state:'unknown'}},{status:502}));
 await assert.rejects(run(unknown.gateway),e=>e.submissionState===undefined);
});
test('an exact trusted relay rejection pair has a separate no-execution state and is never automatically resent',async()=>{
 const f=fixture(url=>String(url).endsWith('/activate')?Response.json(activation()):Response.json({error:{code:'llm_rejected_before_execution',submission_state:'rejected_before_execution',message:'private upstream detail'}},{status:503}));
 await assert.rejects(run(f.gateway),e=>e.code==='llm_rejected_before_execution'&&e.submissionState==='rejected_before_execution'&&/未执行，未扣费/.test(e.message)&&!/private|upstream/.test(e.message));
 assert.equal(f.calls.filter(call=>call.url.endsWith('/responses')).length,1);
});
test('generic failures, mixed rejection fields or a Worker-style header never prove no execution',async()=>{
 const samples=[
  {error:{code:'llm_rejected_before_execution',submission_state:'unknown'}},
  {error:{code:'llm_rejected_before_execution',submission_state:'not_submitted'}},
  {error:{code:'llm_unknown',submission_state:'rejected_before_execution'}},
  {code:'llm_rejected_before_execution',error:{submission_state:'rejected_before_execution'}},
  {error:{code:'llm_rejected_before_execution'},submission_state:'rejected_before_execution'},
  {error:'未执行，未扣费'},
  {code:'llm_unknown',error:{code:'llm_rejected_before_execution',submission_state:'rejected_before_execution'}},
 ];
 for(const sample of samples){
  const f=fixture(url=>String(url).endsWith('/activate')?Response.json(activation()):Response.json(sample,{status:502,headers:{'X-PIKNO-Execution-State':'rejected_before_execution'}}));
  await assert.rejects(run(f.gateway),e=>e.submissionState===undefined&&e.code!=='llm_rejected_before_execution'&&!/未执行，未扣费/.test(e.message));
  assert.equal(f.calls.filter(call=>call.url.endsWith('/responses')).length,1);
 }
});
test('account revision changes cannot publish a trusted rejection for the new account',async()=>{
 let changed=false;
 const f=fixture(url=>{if(String(url).endsWith('/activate'))return Response.json(activation());changed=true;return Response.json({error:{code:'llm_rejected_before_execution',submission_state:'rejected_before_execution'}},{status:503});});
 await assert.rejects(run(f.gateway,{assertCurrent:()=>{if(changed)throw Object.assign(Error('账户配置已变化'),{statusCode:409});}}),e=>e.statusCode===409&&e.submissionState===undefined&&e.code!=='llm_rejected_before_execution');
 assert.equal(f.calls.filter(call=>call.url.endsWith('/responses')).length,1);
});
