const {test}=require('node:test');
const assert=require('node:assert/strict');
const {Readable,PassThrough}=require('node:stream');
const {createPiknoInferenceGateway}=require('../pikno-inference.cjs');
const {validateChatActivation}=require('../pikno-client.cjs');
const handle='hf1_'+'a'.repeat(16)+'_'+'b'.repeat(100);
const activation=()=>({authorized:true,enabled:true,available:true,balance_sufficient:true,model:'pikno-chat-standard',price_version:'chat-cny-9-45-actual-v2',billing_mode:'actual_usage_v1',billing:{allow_debt:true,one_inflight_per_user:true},pricing:{currency:'CNY',input_cny_per_million:9,output_cny_per_million:45},capabilities:{text:true,image:true,pdf:true,video:true,files:true,tools:false,sse:true,verified:true},limits:{max_output_tokens:512,max_file_bytes:50*1024*1024,max_attachments:6,max_history_attachments:12}});
function fixture(reply){const calls=[];const gateway=createPiknoInferenceGateway({endpoint:'https://relay.test',fetchImpl:async(url,options)=>{calls.push({url:String(url),options});return reply(url,options);}});return {calls,gateway};}
async function run(gateway,{method='POST',route='/api/inference/api/v3/files',body=Buffer.from('--boundary\r\nsynthetic\r\n--boundary--'),headers={'content-type':'multipart/form-data; boundary=boundary'},assertCurrent=()=>{}}={}){
 const req=Readable.from(body.length?[body]:[]);req.method=method;req.headers=headers;
 const chunks=[],res=new PassThrough();res.writeHead=(status,headers)=>{res.status=status;res.headers=headers;};res.on('data',chunk=>chunks.push(chunk));
 await gateway.handle(req,res,new URL('http://localhost'+route),'captured-chat-key',{assertCurrent});return JSON.parse(Buffer.concat(chunks));
}
test('file upload forwards exact multipart bytes with captured Key and no paid request ID',async()=>{
 const f=fixture(url=>String(url).endsWith('/activate')?Response.json(activation()):Response.json({id:handle,status:'active'}));
 const body=Buffer.from([45,45,98,13,10,0,255,128]);const result=await run(f.gateway,{body});assert.equal(result.id,handle);
 assert.equal(f.calls.length,2);const call=f.calls[1];assert.equal(call.url,'https://relay.test/assistant/v2/files');assert.deepEqual(call.options.body,body);
 assert.equal(call.options.headers.Authorization,'Bearer captured-chat-key');assert.equal(call.options.headers['X-PIKNO-Request-Id'],undefined);assert.equal(call.options.redirect,'error');
});
test('poll/delete use direct authenticated file route without repeated activation, preserving exhausted-key cleanup',async()=>{
 for(const method of ['GET','DELETE']){const f=fixture(()=>Response.json({id:handle,status:'active'}));await run(f.gateway,{method,route:'/api/inference/api/v3/files/'+handle,body:Buffer.alloc(0),headers:{}});assert.equal(f.calls.length,1);assert.equal(f.calls[0].options.body,undefined);assert.equal(f.calls[0].options.method,method);}
});
test('disabled files, missing limits, debt, query strings, raw IDs and unsupported methods are closed',async()=>{
 for(const mutate of [x=>x.capabilities.files=false,x=>delete x.limits.max_file_bytes,x=>x.balance_sufficient=false]){
  const value=activation();mutate(value);const f=fixture(()=>Response.json(value));await assert.rejects(run(f.gateway));assert.equal(f.calls.filter(x=>x.url.endsWith('/files')).length,0);
 }
 for(const args of [{route:'/api/inference/api/v3/files?url=https://foreign.test'},{route:'/api/inference/api/v3/files/raw-file',method:'GET',body:Buffer.alloc(0)},{method:'GET',body:Buffer.alloc(0)},{headers:{'content-type':'application/json'}}]){
  const f=fixture(()=>Response.json(activation()));await assert.rejects(run(f.gateway,args));assert.equal(f.calls.filter(x=>x.url.endsWith('/files')).length,0);
 }
});
test('file failure and account change cannot retry uploads or dispatch inference',async()=>{
 let changed=false;const f=fixture(url=>{if(String(url).endsWith('/activate'))return Response.json(activation());changed=true;return Response.json({id:handle});});
 await assert.rejects(run(f.gateway,{assertCurrent:()=>{if(changed)throw Object.assign(Error('changed'),{statusCode:409});}}),e=>e.statusCode===409);
 assert.equal(f.calls.length,2);
 const lost=fixture(url=>{if(String(url).endsWith('/activate'))return Response.json(activation());throw Error('private upstream details');});
 await assert.rejects(run(lost.gateway),e=>e.code==='llm_file_unavailable'&&e.submissionState==='not_submitted'&&!e.message.includes('private'));
 assert.equal(lost.calls.length,2);assert.equal(lost.calls.some(x=>x.url.endsWith('/responses')),false);
});
test('bundled SDK empty DELETE JSON is normalized; options and other bodies remain forbidden',async()=>{
 const f=fixture(()=>Response.json({id:handle,deleted:true}));
 await run(f.gateway,{method:'DELETE',route:'/api/inference/api/v3/files/'+handle,body:Buffer.from('{}'),headers:{'content-type':'application/json'}});
 assert.equal(f.calls[0].options.body,undefined);assert.equal(f.calls[0].options.headers['Content-Type'],undefined);
 for(const body of ['[]','null','{"delete_all":true}']){const blocked=fixture(()=>Response.json({}));await assert.rejects(run(blocked.gateway,{method:'DELETE',route:'/api/inference/api/v3/files/'+handle,body:Buffer.from(body),headers:{'content-type':'application/json'}}));assert.equal(blocked.calls.length,0);}
});
test('media capabilities require bounded limits, preserve old text servers and omit private extras',()=>{
 const value=activation();assert.equal(validateChatActivation(value).limits.max_history_attachments,12);
 for(const [key,bad] of [['max_file_bytes',50*1024*1024+1],['max_attachments',7],['max_history_attachments',13]]){const v=activation();v.limits[key]=bad;assert.throws(()=>validateChatActivation(v));}
 const old=activation();for(const key of ['files','image','video','pdf'])old.capabilities[key]=false;old.limits={max_output_tokens:512};assert.deepEqual(validateChatActivation(old).limits,old.limits);
});
