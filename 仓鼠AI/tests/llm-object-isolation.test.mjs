import test from 'node:test';
import assert from 'node:assert/strict';
import worker,{createToken} from '../cloudflare/llm-worker/src/worker.js';
const env={LLM_BILLING_MODE:'legacy',ARK_API_KEY:'test-protected-key',LLM_ENDPOINTS:'ep-test-account-route',TOKEN_SIGNING_KEY:'offline-object-test-signing-secret-32bytes'};
const request=(token,path,method='GET',body)=>new Request('https://inference.test/api/v3/'+path,{method,headers:{authorization:'Bearer '+token,'x-hamster-client':'hamster-desktop-v1',...(body?{'content-type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});

test('file capabilities bind read, delete and response references to account uid across Key rotation',{concurrency:false},async t=>{
  const a=await createToken(env,'a'.repeat(64),7),b=await createToken(env,'b'.repeat(64),8),rotated=await createToken(env,'c'.repeat(64),7);
  const original=globalThis.fetch,calls=[];t.after(()=>{globalThis.fetch=original;});
  globalThis.fetch=async(url,options)=>{calls.push({url:String(url),method:options.method,body:options.body});return Response.json({id:'file-private-123',object:'file',status:'active'});};
  const uploaded=await(await worker.fetch(request(a,'files','POST',{}),env)).json();
  assert.match(uploaded.id,/^ho1_/);assert.doesNotMatch(uploaded.id,/private|123/);
  for(const method of ['GET','DELETE']) {
    const before=calls.length;
    assert.equal((await worker.fetch(request(b,'files/'+uploaded.id,method),env)).status,403);assert.equal(calls.length,before);
    assert.equal((await worker.fetch(request(rotated,'files/'+uploaded.id,method),env)).status,200);
    assert.equal(calls.at(-1).url,'https://ark.cn-beijing.volces.com/api/v3/files/file-private-123');
  }
  const body={input:[{role:'user',content:[{type:'input_file',file_id:uploaded.id}]}]};
  const before=calls.length;assert.equal((await worker.fetch(request(b,'responses','POST',body),env)).status,403);assert.equal(calls.length,before);
  globalThis.fetch=async(url,options)=>{calls.push({url:String(url),method:options.method,body:JSON.parse(options.body)});return Response.json({id:'resp-private-1',object:'response',status:'completed'});};
  assert.equal((await worker.fetch(request(rotated,'responses','POST',body),env)).status,200);
  assert.equal(calls.at(-1).body.input[0].content[0].file_id,'file-private-123');
});

test('stream response handles reject another account continuation before any upstream POST',{concurrency:false},async t=>{
  const a=await createToken(env,'a'.repeat(64),7),b=await createToken(env,'a'.repeat(64),8),rotated=await createToken(env,'c'.repeat(64),7);
  const original=globalThis.fetch,calls=[];t.after(()=>{globalThis.fetch=original;});
  globalThis.fetch=async(_url,options)=>{calls.push(JSON.parse(options.body));return new Response('event: response.created\ndata: {"type":"response.created","response":{"id":"resp-cloud-secret","model":"ep-test-account-route"}}\n\nevent: response.completed\ndata: {"type":"response.completed","response":{"id":"resp-cloud-secret","status":"completed"}}\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});};
  const response=await worker.fetch(request(a,'responses','POST',{input:'hello',stream:true}),env),text=await response.text();
  assert.doesNotMatch(text,/resp-cloud-secret|ep-test-account-route/);
  const handle=JSON.parse(text.split('\n').find(line=>line.startsWith('data: {')).slice(6)).response.id;
  const before=calls.length;
  assert.equal((await worker.fetch(request(b,'responses','POST',{previous_response_id:handle,input:'other'}),env)).status,403);assert.equal(calls.length,before);
  const same=await worker.fetch(request(rotated,'responses','POST',{previous_response_id:handle,input:'continue'}),env);await same.text();
  assert.equal(calls.at(-1).previous_response_id,'resp-cloud-secret');
});

test('forged, raw and wrong-kind object identifiers never reach upstream',{concurrency:false},async t=>{
  const token=await createToken(env,'d'.repeat(64),7),original=globalThis.fetch;let calls=0;t.after(()=>{globalThis.fetch=original;});
  globalThis.fetch=async()=>{calls++;return Response.json({id:'resp-raw',object:'response'});};
  const handle=(await(await worker.fetch(request(token,'responses','POST',{input:'hello'}),env)).json()).id;
  for(const file of ['file-raw',handle,handle.slice(0,-3)+'bad']) {
    const before=calls;assert.equal((await worker.fetch(request(token,'files/'+file),env)).status,400);assert.equal(calls,before);
  }
  for(const field of ['file_id','previous_response_id']) {
    const before=calls;const result=await worker.fetch(request(token,'responses','POST',{input:[{[field]:'raw-cloud-object'}]}),env);
    assert.equal(result.status,400);assert.equal(calls,before);assert.equal((await result.json()).error.param,field);
  }
});

test('legacy sessions retain isolated file ownership by credential digest',{concurrency:false},async t=>{
  const a=await createToken(env,'e'.repeat(64)),b=await createToken(env,'f'.repeat(64)),original=globalThis.fetch;let calls=0;t.after(()=>{globalThis.fetch=original;});
  globalThis.fetch=async()=>{calls++;return Response.json({id:'file-legacy',object:'file'});};
  const handle=(await(await worker.fetch(request(a,'files','POST',{}),env)).json()).id;
  assert.equal((await worker.fetch(request(b,'files/'+handle),env)).status,403);assert.equal(calls,1);
  assert.equal((await worker.fetch(request(a,'files/'+handle),env)).status,200);
});

test('unsupported object reference variants cannot bypass the account capability check',{concurrency:false},async t=>{
  const token=await createToken(env,'a'.repeat(64),7),original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});
  globalThis.fetch=()=>assert.fail('unsupported references must never reach inference');
  const variants=[{input:[{type:'item_reference',id:'message-of-other-account'}]},
    ...['id','file_url','file_data','image_url','video_url','audio_url','vector_store_ids'].map(key=>({input:[{type:'input_file',[key]:'other-cloud-object'}]})),
    {input:'hello',conversation:'other-conversation'},{input:'hello',prompt:{id:'shared-prompt'}},
    {input:'hello',tools:[{type:'knowledge_search',vector_store_ids:['other-store']}]}];
  for(const payload of variants)assert.equal((await worker.fetch(request(token,'responses','POST',payload),env)).status,400);
});

test('only definite structured reference rejections expose a safe rebuild signal',{concurrency:false},async t=>{
  const token=await createToken(env,'a'.repeat(64),7),original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});
  for(const param of ['previous_response_id','file_id'])for(const status of [400,404]){
    globalThis.fetch=async()=>Response.json({error:{param,message:'private-provider-body',extra:'secret'}},{status});
    const result=await worker.fetch(request(token,'responses','POST',{input:'hello'}),env),body=await result.json();
    assert.equal(result.status,status);assert.equal(body.error.param,param);assert.equal(body.error.submission_state,'not_submitted');
    assert.doesNotMatch(JSON.stringify(body),/private-provider|secret|extra/);
  }
  for(const [status,error] of [[502,{param:'previous_response_id'}],[503,{param:'file_id'}],[400,{param:'model',message:'private'}],
    [404,{param:'previous_response_id',submission_state:'accepted'}],[400,{param:'previous_response_id',response_id:'accepted-response'}]]){
    globalThis.fetch=async()=>Response.json({error},{status});
    const body=await(await worker.fetch(request(token,'responses','POST',{input:'hello'}),env)).json();
    assert.equal(body.error.param,undefined);assert.equal(body.error.submission_state,undefined);
  }
});

test('authorized empty file deletion returns 204 and another account still cannot delete',{concurrency:false},async t=>{
  const a=await createToken(env,'a'.repeat(64),7),b=await createToken(env,'b'.repeat(64),8),original=globalThis.fetch;let calls=0;t.after(()=>{globalThis.fetch=original;});
  globalThis.fetch=async()=>{calls++;return Response.json({id:'file-delete-fixture',object:'file'});};
  const handle=(await(await worker.fetch(request(a,'files','POST',{}),env)).json()).id;
  globalThis.fetch=async()=>{calls++;return new Response(null,{status:204});};
  const result=await worker.fetch(request(a,'files/'+handle,'DELETE'),env);assert.equal(result.status,204);assert.equal(await result.text(),'');
  assert.equal((await worker.fetch(request(b,'files/'+handle,'DELETE'),env)).status,403);assert.equal(calls,2);
});
