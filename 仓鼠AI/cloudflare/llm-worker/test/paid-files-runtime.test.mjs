// Real workerd execution with synthetic Files/Responses only. Unexpected
// outbound URLs fail the test before any network access.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFile} from 'node:fs/promises';
const require=createRequire(new URL('../../billing-worker/package.json',import.meta.url));
const {Miniflare,convertV4MiniflareOptions}=require('miniflare');
const source=await readFile(new URL('../src/worker.js',import.meta.url),'utf8');
const encoder=new TextEncoder(),secret='workerd-files-bridge-secret-not-a-real-key';
const hash=async bytes=>Buffer.from(await crypto.subtle.digest('SHA-256',bytes)).toString('hex');
async function signed(claims){
  const data=Buffer.from(JSON.stringify(claims)).toString('base64url');
  const key=await crypto.subtle.importKey('raw',encoder.encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  return data+'.'+Buffer.from(await crypto.subtle.sign('HMAC',key,encoder.encode(data))).toString('base64url');
}
async function fileOptions(method,path,body=Buffer.alloc(0),type='',uid=2){
  const now=Math.floor(Date.now()/1000),token=await signed({v:2,aud:'pikno-llm-file',uid,method,path,content_type:type,body_sha256:await hash(body),iat:now,exp:now+60});
  return {method,headers:{authorization:'Bearer '+token,...(type?{'content-type':type}:{})},...(['GET','HEAD'].includes(method)?{}:{body})};
}
async function runtime(t,handler){
  const mf=new Miniflare(convertV4MiniflareOptions({name:'llm-files-isolated-runtime',modules:true,script:source,
    compatibilityDate:'2026-09-28',compatibilityFlags:['nodejs_compat'],telemetry:{enabled:false},
    durableObjects:{LLM_EXECUTIONS:{className:'LlmExecutionGuard',useSQLite:true}},
    bindings:{LLM_BILLING_MODE:'actual_usage_v1',PIKNO_LLM_MODEL_VERIFIED:'true',PIKNO_LLM_FILES_ENABLED:'true',ARK_API_KEY:'runtime-files-provider-secret',
      TOKEN_SIGNING_KEY:'runtime-files-envelope-secret-over-32-bytes',PIKNO_ASSISTANT_BRIDGE_SECRET:secret,
      PIKNO_LLM_ROUTES:JSON.stringify([{endpoint:'ep-runtime-primary',version:'260915'},{endpoint:'ep-runtime-second',version:'260915'},{endpoint:'ep-runtime-third',version:'260628'}])},
    outboundService:async request=>{
      const url=new URL(request.url);assert.equal(url.origin,'https://ark.cn-beijing.volces.com');
      assert.ok(['/api/v3/files','/api/v3/files/file-runtime-only','/api/v3/responses'].includes(url.pathname));
      return handler(request);
    }}));
  t.after(()=>mf.dispose());return mf;
}
function fileObject(size){const now=Math.floor(Date.now()/1000);return Response.json({id:'file-runtime-only',object:'file',purpose:'user_data',created_at:now,expire_at:now+3600,bytes:size,filename:'hidden-provider-name',status:'active'});}

test('workerd processes the exact signed multipart, encrypted handle and paid media reference through real durable guard',async t=>{
  const calls=[],size=1024*1024,bytes=Buffer.alloc(size);Buffer.from([137,80,78,71,13,10,26,10]).copy(bytes);
  const form=new FormData();form.set('purpose','user_data');form.set('expire_at',String(Math.floor(Date.now()/1000)+3600));form.set('file',new Blob([bytes],{type:'image/png'}),'runtime.png');
  const upload=new Request('https://test.invalid',{method:'POST',body:form}),body=Buffer.from(await upload.arrayBuffer()),type=upload.headers.get('content-type');
  const mf=await runtime(t,async request=>{
    calls.push(request.method+' '+new URL(request.url).pathname);
    if(request.url.endsWith('/responses')){
      const payload=await request.json();assert.equal(payload.input[0].content[0].file_id,'file-runtime-only');
      assert.equal(payload.model,'ep-runtime-primary');assert.equal(payload.store,false);
      assert.equal(payload.expire_at,data.expire_at-60);assert(payload.expire_at>Math.floor(Date.now()/1000)+60);
      return Response.json({object:'response',id:'response-runtime',status:'completed',usage:{input_tokens:27,output_tokens:2,total_tokens:29}});
    }
    if(request.method==='POST'){assert.equal(request.headers.get('content-type'),type);assert.equal(await hash(await request.arrayBuffer()),await hash(body));}
    if(request.method==='DELETE')return new Response(null,{status:204});
    return fileObject(size);
  });
  const path='/internal/pikno/files',created=await mf.dispatchFetch('https://inference.test'+path,await fileOptions('POST',path,body,type));
  assert.equal(created.status,200);const data=await created.json();assert.match(data.id,/^hf1_/);assert.ok(data.id.length<=1800);assert.doesNotMatch(JSON.stringify(data),/file-runtime-only|hidden-provider-name|secret/);
  const filePath=path+'/'+data.id;
  const queried=await mf.dispatchFetch('https://inference.test'+filePath,await fileOptions('GET',filePath));assert.equal(queried.status,200);assert.equal((await queried.json()).id,data.id);
  const foreign=await mf.dispatchFetch('https://inference.test'+filePath,await fileOptions('GET',filePath,Buffer.alloc(0),'',3));assert.equal(foreign.status,403);await foreign.arrayBuffer();
  const payload=JSON.stringify({model:'pikno-chat-standard',input:[{role:'user',content:[{type:'input_image',file_id:data.id}]}],max_output_tokens:32,stream:false}),now=Math.floor(Date.now()/1000),id='a'.repeat(32);
  const token=await signed({v:2,aud:'pikno-llm-execute',billing_mode:'actual_usage_v1',uid:2,request_id:id,jti:id,body_sha256:await hash(encoder.encode(payload)),model_alias:'pikno-chat-standard',route_policy:'pikno-text-three-actual-usage-v2',max_output_tokens:32,iat:now,exp:now+60});
  const options={method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+token},body:payload};
  const answer=await mf.dispatchFetch('https://inference.test/internal/pikno/responses',options);assert.equal(answer.status,200);assert.equal((await answer.json()).usage.input_tokens,27);
  const replay=await mf.dispatchFetch('https://inference.test/internal/pikno/responses',options);assert.equal(replay.status,409);await replay.arrayBuffer();
  const removed=await mf.dispatchFetch('https://inference.test'+filePath,await fileOptions('DELETE',filePath));assert.deepEqual(await removed.json(),{object:'file',id:data.id,deleted:true});
  assert.deepEqual(calls,['POST /api/v3/files','GET /api/v3/files/file-runtime-only','POST /api/v3/responses','DELETE /api/v3/files/file-runtime-only']);
});

test('workerd enforces the actual 50 MiB file boundary, not only a Content-Length claim',async t=>{
  let calls=0;const mf=await runtime(t,async request=>{calls++;const data=await request.formData();assert.equal(data.get('file').size,50*1024*1024);return fileObject(50*1024*1024);});
  for(const extra of [0,1]){
    const bytes=Buffer.alloc(50*1024*1024+extra);Buffer.from([137,80,78,71,13,10,26,10]).copy(bytes);
    const form=new FormData();form.set('purpose','user_data');form.set('expire_at',String(Math.floor(Date.now()/1000)+3600));form.set('file',new Blob([bytes],{type:'image/png'}),'boundary.png');
    const request=new Request('https://test.invalid',{method:'POST',body:form}),body=Buffer.from(await request.arrayBuffer()),path='/internal/pikno/files';
    const response=await mf.dispatchFetch('https://inference.test'+path,await fileOptions('POST',path,body,request.headers.get('content-type')));
    assert.equal(response.status,extra?413:200);await response.arrayBuffer();
  }
  assert.equal(calls,1);
});

test('workerd shortens signed desktop-clock expiry at 50 MiB without changing file content or retrying',async t=>{
  const size=50*1024*1024,bytes=Buffer.alloc(size);Buffer.from([137,80,78,71,13,10,26,10]).copy(bytes);
  const expectedFileHash=await hash(bytes),requestedExpiry=Math.floor(Date.now()/1000)+3*86400+300;
  const form=new FormData();form.set('purpose','user_data');form.set('expire_at',String(requestedExpiry));form.set('file',new Blob([bytes],{type:'image/png'}),'clock-boundary.png');
  const upload=new Request('https://test.invalid',{method:'POST',body:form}),body=Buffer.from(await upload.arrayBuffer()),type=upload.headers.get('content-type');
  let calls=0,effectiveExpiry;
  const mf=await runtime(t,async request=>{
    calls++;assert.equal(request.method,'POST');assert.equal(request.headers.get('content-type'),type);
    const forwarded=Buffer.from(await request.arrayBuffer());assert.equal(forwarded.length,body.length);
    const data=await new Response(forwarded,{headers:{'content-type':type}}).formData(),file=data.get('file');
    assert.equal(file.size,size);assert.equal(file.type,'image/png');assert.equal(await hash(await file.arrayBuffer()),expectedFileHash);
    effectiveExpiry=Number(data.get('expire_at'));const now=Math.floor(Date.now()/1000);
    assert(effectiveExpiry<=now+3*86400-60);assert(effectiveExpiry>=now+3*86400-65);assert(effectiveExpiry<requestedExpiry);
    const changed=[];for(let i=0;i<body.length;i++)if(body[i]!==forwarded[i])changed.push(i);
    assert(changed.length>0&&changed.length<=String(requestedExpiry).length,'only the ASCII expiry field changes');
    const expires=Buffer.from(String(effectiveExpiry));assert(forwarded.includes(expires));
    return Response.json({id:'file-runtime-only',object:'file',purpose:'user_data',created_at:now,expire_at:effectiveExpiry,bytes:size,filename:'synthetic',status:'active'});
  });
  const path='/internal/pikno/files',response=await mf.dispatchFetch('https://inference.test'+path,await fileOptions('POST',path,body,type));
  assert.equal(response.status,200);assert.equal((await response.json()).expire_at,effectiveExpiry);assert.equal(calls,1);
});

test('workerd concurrent 50 MiB uploads remain bounded while a completed upload releases capacity',async t=>{
  let calls=0,release,entered;
  const blocked=new Promise(resolve=>{release=resolve;}),started=new Promise(resolve=>{entered=resolve;});
  const mf=await runtime(t,async request=>{
    calls++;await request.arrayBuffer();if(calls===1){entered();await blocked;}return fileObject(50*1024*1024);
  });
  const bytes=Buffer.alloc(50*1024*1024);Buffer.from([137,80,78,71,13,10,26,10]).copy(bytes);
  const form=new FormData();form.set('purpose','user_data');form.set('expire_at',String(Math.floor(Date.now()/1000)+3600));form.set('file',new Blob([bytes],{type:'image/png'}),'concurrent.png');
  const request=new Request('https://test.invalid',{method:'POST',body:form}),body=Buffer.from(await request.arrayBuffer()),path='/internal/pikno/files',type=request.headers.get('content-type');
  const first=mf.dispatchFetch('https://inference.test'+path,await fileOptions('POST',path,body,type));
  try{
    await started;
    const second=await mf.dispatchFetch('https://inference.test'+path,await fileOptions('POST',path,body,type));
    assert.equal(second.status,429);await second.arrayBuffer();assert.equal(calls,1);
  }finally{release();await (await first).arrayBuffer();}
  const serial=await mf.dispatchFetch('https://inference.test'+path,await fileOptions('POST',path,body,type));assert.equal(serial.status,200);await serial.arrayBuffer();assert.equal(calls,2);
});
