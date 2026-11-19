import test from 'node:test';
import assert from 'node:assert/strict';
import worker,{LlmExecutionGuard} from '../cloudflare/llm-worker/src/worker.js';
import {execFileSync,spawnSync} from 'node:child_process';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,resolve} from 'node:path';

const encoder=new TextEncoder(),secret='offline-files-bridge-secret-with-32-bytes';
const routes=[{endpoint:'ep-files-primary',version:'260915'},{endpoint:'ep-files-second',version:'260915'},{endpoint:'ep-files-third',version:'260628'}];
const hash=async bytes=>Buffer.from(await crypto.subtle.digest('SHA-256',bytes)).toString('hex');
const now=()=>Math.floor(Date.now()/1000);
const png=Buffer.from([137,80,78,71,13,10,26,10,0,0,0,0]);
const jpeg=Buffer.from([255,216,255,224,0,0]);
const webp=Buffer.from('RIFF0000WEBPVP8 ');
const pdf=Buffer.from('%PDF-1.7\nfixture');
const box=(name,body)=>{const header=Buffer.alloc(8);header.writeUInt32BE(body.length+8);header.write(name,4);return Buffer.concat([header,body]);};
const container=handler=>Buffer.concat([box('ftyp',Buffer.from('isom0000isom')),box('moov',box('trak',box('mdia',box('hdlr',Buffer.concat([Buffer.alloc(8),Buffer.from(handler)])))))]);
const video=container('vide');
function environment(patch={}){
  const values=new Map(),objects=new Map(),calls=[];
  return {LLM_BILLING_MODE:'actual_usage_v1',PIKNO_LLM_MODEL_VERIFIED:'true',PIKNO_LLM_FILES_ENABLED:'true',ARK_API_KEY:'synthetic-provider-secret',
    TOKEN_SIGNING_KEY:'synthetic-file-envelope-secret-over-32-bytes',PIKNO_ASSISTANT_BRIDGE_SECRET:secret,PIKNO_LLM_ROUTES:JSON.stringify(routes),
    LLM_EXECUTIONS:{calls,idFromName:name=>name,get(name){calls.push(name);if(!objects.has(name))objects.set(name,new LlmExecutionGuard({storage:{transaction:async fn=>fn({get:async key=>values.get(name+key),put:async(key,value)=>values.set(name+key,value)})}}));return objects.get(name);}},...patch};
}
async function sign(claims){
  const payload=Buffer.from(JSON.stringify(claims)).toString('base64url');
  const key=await crypto.subtle.importKey('raw',encoder.encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  return payload+'.'+Buffer.from(await crypto.subtle.sign('HMAC',key,encoder.encode(payload))).toString('base64url');
}
async function fileRequest(method='POST',path='/internal/pikno/files',body=Buffer.alloc(0),type='',patch={},headers={}){
  const claims={v:2,aud:'pikno-llm-file',uid:2,method,path,content_type:type,body_sha256:await hash(body),iat:now(),exp:now()+60,...patch};
  return new Request('https://inference.test'+path,{method,headers:{authorization:'Bearer '+await sign(claims),...(type?{'content-type':type}:{}),...headers},...(['GET','HEAD'].includes(method)?{}:{body})});
}
function form({bytes=png,type='image/png',name='fixture.png',expiry=now()+3600,purpose='user_data',fps,extra=[],duplicate=false}={}){
  const boundary='hamster-offline-boundary',chunks=[];
  const field=(key,value)=>chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`));
  field('purpose',purpose);field('expire_at',expiry);if(fps!==undefined)field('preprocess_configs[video][fps]',fps);for(const [key,value] of extra)field(key,value);if(duplicate)field('purpose',purpose);
  chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: ${type}\r\n\r\n`),bytes,Buffer.from(`\r\n--${boundary}--\r\n`));
  return {body:Buffer.concat(chunks),type:'multipart/form-data; boundary='+boundary,bytes:bytes.length};
}
async function upload(env,options={},patch={}){const f=form(options);return worker.fetch(await fileRequest('POST','/internal/pikno/files',f.body,f.type,patch),env);}
function fileResult(id,bytes,status='active',patch={}){return Response.json({object:'file',id,status,bytes,created_at:now(),expire_at:now()+3600,purpose:'user_data',filename:'provider-private',tos:{object_key:'private-key'},url:'https://private.invalid',...patch});}
async function execute(env,input,patch={},payloadPatch={}){
  const body=JSON.stringify({model:'pikno-chat-standard',input,max_output_tokens:32,stream:false,...payloadPatch}),id='f'.repeat(32);
  const ticket=await sign({v:2,aud:'pikno-llm-execute',billing_mode:'actual_usage_v1',uid:2,request_id:id,jti:id,body_sha256:await hash(encoder.encode(body)),model_alias:'pikno-chat-standard',route_policy:'pikno-text-three-actual-usage-v2',max_output_tokens:32,iat:now(),exp:now()+60,...patch});
  return worker.fetch(new Request('https://inference.test/internal/pikno/responses',{method:'POST',headers:{authorization:'Bearer '+ticket,'content-type':'application/json'},body}),env);
}
function mockFetch(t,callback){const original=globalThis.fetch;globalThis.fetch=callback;t.after(()=>{globalThis.fetch=original;});}

test('response expiry stays below fresh and reused file expiry without enabling storage or replay',async t=>{
  const uploadedAt=1800000000,fileExpiry=uploadedAt+3*86400-60;
  let clock=uploadedAt,calls=0;const sent=[];
  t.mock.method(Date,'now',()=>clock*1000);
  mockFetch(t,(url,options)=>{
    calls++;
    if(String(url).endsWith('/files'))return fileResult('file-expiry',png.length,'active',{expire_at:fileExpiry});
    sent.push(JSON.parse(options.body));
    return Response.json({object:'response',id:'resp-expiry',status:'completed',usage:{input_tokens:2,output_tokens:3}});
  });
  for(const age of [0,1502]){
    clock=uploadedAt;const env=environment(),file=await (await upload(env,{expiry:uploadedAt+3*86400})).json();
    clock+=age;const input=[{role:'user',content:[{type:'input_image',file_id:file.id}]}];
    assert.equal((await execute(env,input)).status,200);
    const outgoing=sent.at(-1);assert.equal(outgoing.expire_at,file.expire_at-60);assert(outgoing.expire_at>now()+60);
    assert(outgoing.expire_at<now()+3*86400);assert.equal(outgoing.store,false);
    assert.equal(outgoing.input[0].content[0].file_id,'file-expiry');
    const before=calls;assert.equal((await execute(env,input)).status,409);assert.equal(calls,before);
  }
  assert.equal(calls,4);assert.equal(sent.length,2);
});

test('response expiry uses the earliest authenticated file across history, kinds and repeated references',async t=>{
  const timestamp=1800000000;t.mock.method(Date,'now',()=>timestamp*1000);
  const specs=[{kind:'image',bytes:png,type:'image/png',name:'image.png',requested:3600,actual:3600},
    {kind:'file',bytes:pdf,type:'application/pdf',name:'document.pdf',requested:7200,actual:1800},
    {kind:'video',bytes:video,type:'video/mp4',name:'video.mp4',fps:2,requested:5400,actual:5400}];
  let uploaded=0;const sent=[];
  mockFetch(t,(url,options)=>{
    if(String(url).endsWith('/files')){const spec=specs[uploaded++];return fileResult('file-'+spec.kind,spec.bytes.length,'active',{expire_at:timestamp+spec.actual});}
    sent.push(JSON.parse(options.body));return Response.json({object:'response',id:'resp-multiple',status:'completed',usage:{input_tokens:1,output_tokens:1}});
  });
  const env=environment(),parts=[];
  for(const spec of specs){const file=await (await upload(env,{...spec,expiry:timestamp+spec.requested})).json();parts.push({type:'input_'+spec.kind,file_id:file.id});}
  const input=[{role:'user',content:[{type:'input_text',text:'first'},parts[0],parts[1]]},{role:'assistant',content:'previous'},
    {role:'user',content:[parts[2],parts[0],{type:'input_text',text:'next'}]}];
  assert.equal((await execute(env,input)).status,200);assert.equal(sent.length,1);
  assert.equal(sent[0].expire_at,timestamp+1800-60);assert.equal(sent[0].store,false);
  assert.deepEqual(sent[0].input,[{role:'user',content:[{type:'input_text',text:'first'},{type:'input_image',file_id:'file-image'},{type:'input_file',file_id:'file-file'}]},
    {role:'assistant',content:'previous'},{role:'user',content:[{type:'input_video',file_id:'file-video'},{type:'input_image',file_id:'file-image'},{type:'input_text',text:'next'}]}]);
});

test('response expiry must cover the signed submission window before claiming or calling the provider',async t=>{
  const timestamp=1800000000,fileExpiry=timestamp+3600;let clock=timestamp,dispatches=0;
  t.mock.method(Date,'now',()=>clock*1000);
  mockFetch(t,(url,options)=>{
    if(String(url).endsWith('/files'))return fileResult('file-near-expiry',png.length,'active',{expire_at:fileExpiry});
    dispatches++;assert.equal(JSON.parse(options.body).expire_at,fileExpiry-60);
    return Response.json({object:'response',id:'resp-near-expiry',status:'completed',usage:{input_tokens:1,output_tokens:1}});
  });
  for(const remaining of [0,1,59,60,61,119,120,121]){
    clock=timestamp;const env=environment(),file=await (await upload(env)).json();clock=fileExpiry-remaining;
    const before=dispatches,response=await execute(env,[{role:'user',content:[{type:'input_image',file_id:file.id}]}]);
    if(remaining<=120){assert.equal(response.status,400,String(remaining));assert.equal((await response.json()).error.submission_state,'not_submitted');
      assert.equal(env.LLM_EXECUTIONS.calls.length,0);assert.equal(dispatches,before);}
    else{assert.equal(response.status,200);assert.equal(env.LLM_EXECUTIONS.calls.length,1);assert.equal(dispatches,before+1);}
  }
});

test('text-only responses keep their existing body and cannot accept a client-supplied expiry',async t=>{
  const sent=[];mockFetch(t,(_url,options)=>{sent.push(JSON.parse(options.body));return Response.json({object:'response',id:'resp-text',status:'completed',usage:{input_tokens:1,output_tokens:1}});});
  for(const input of ['plain text',[{role:'user',content:'plain text'}],[{role:'user',content:[{type:'input_text',text:'plain text'}]}]]){
    assert.equal((await execute(environment(),input)).status,200);assert.equal(Object.hasOwn(sent.at(-1),'expire_at'),false);
    assert.deepEqual(sent.at(-1).input,input);assert.equal(sent.at(-1).store,false);
  }
  const before=sent.length,env=environment();
  assert.equal((await execute(env,'plain text',{}, {expire_at:now()+3600})).status,400);
  assert.equal(sent.length,before);assert.equal(env.LLM_EXECUTIONS.calls.length,0);
});

test('an unknown file rejection still blocks replay after response expiry is aligned',async t=>{
  let dispatches=0;const sent=[];t.mock.method(console,'log',()=>{});t.mock.method(console,'warn',()=>{});
  mockFetch(t,(url,options)=>{
    if(String(url).endsWith('/files'))return fileResult('file-unknown',png.length);
    dispatches++;sent.push(JSON.parse(options.body));
    return Response.json({error:{code:'InvalidParameter',param:'file_id',message:'file-synthetic expired'}},{status:400});
  });
  const env=environment(),file=await (await upload(env)).json(),input=[{role:'user',content:[{type:'input_image',file_id:file.id}]}];
  const failed=await execute(env,input);assert.equal(failed.status,400);assert.equal((await failed.json()).error.submission_state,'unknown');
  assert.equal(sent[0].expire_at,file.expire_at-60);
  const replay=await execute(env,input);assert.equal(replay.status,409);assert.equal((await replay.json()).error.submission_state,'unknown');assert.equal(dispatches,1);
});

test('paid files upload, poll, delete and media execution preserve owner-scoped opaque references',async t=>{
  const env=environment(),seen=[];let currentSize=png.length;
  mockFetch(t,async(url,options)=>{
    seen.push([String(url),options.method]);assert.equal(options.headers.authorization,'Bearer synthetic-provider-secret');assert.equal(options.redirect,'manual');
    if(String(url).endsWith('/responses')){
      const body=JSON.parse(options.body);assert.equal(body.input[0].content[1].file_id,'file-private-id');assert.equal(body.model,routes[0].endpoint);
      assert.equal(body.store,false);assert.equal(body.service_tier,'default');
      return Response.json({object:'response',id:'resp-private',model:'private-model',status:'completed',usage:{input_tokens:100,output_tokens:2,total_tokens:102}});
    }
    if(options.method==='DELETE')return Response.json({object:'file',id:'file-private-id',deleted:true,url:'private'});
    return fileResult('file-private-id',currentSize,options.method==='POST'?'processing':'active');
  });
  const created=await upload(env),data=await created.json();assert.equal(created.status,200);assert.match(data.id,/^hf1_/);assert.equal(data.status,'processing');
  assert.equal(data.filename,'attachment');assert.doesNotMatch(JSON.stringify(data),/file-private|private|synthetic|ep-files|tos|https:/);
  const path='/internal/pikno/files/'+data.id;
  const polled=await worker.fetch(await fileRequest('GET',path),env);assert.equal(polled.status,200);assert.equal((await polled.json()).id,data.id);
  const answer=await execute(env,[{role:'user',content:[{type:'input_text',text:'describe'},{type:'input_image',file_id:data.id}]}]);
  assert.equal(answer.status,200);assert.equal((await answer.json()).usage.input_tokens,100);assert.equal(env.LLM_EXECUTIONS.calls.length,1);
  const removed=await worker.fetch(await fileRequest('DELETE',path),env);assert.deepEqual(await removed.json(),{object:'file',id:data.id,deleted:true});
  assert.deepEqual(seen.map(row=>row[1]),['POST','GET','POST','DELETE']);
});

test('PNG JPEG WebP PDF MP4 MOV use the SDK form and only matching input types',async t=>{
  let sequence=0,size=0;
  mockFetch(t,async(url,options)=>String(url).endsWith('/files')?fileResult('file-'+sequence,size):Response.json({object:'response',id:'resp-fixture',status:'completed',usage:{input_tokens:1,output_tokens:1}}));
  for(const [bytes,type,name,kind] of [[png,'image/png','图.png','image'],[jpeg,'image/jpeg','图.jpg','image'],[webp,'image/webp','图.webp','image'],[pdf,'application/pdf','文档.pdf','file'],[video,'video/mp4','片段.mp4','video'],[video,'video/quicktime','片段.mov','video']]){
    const env=environment();sequence++;size=bytes.length;
    const response=await upload(env,{bytes,type,name,...(kind==='video'?{fps:2}:{})});assert.equal(response.status,200);const data=await response.json();
    const result=await execute(env,[{role:'user',content:[{type:'input_'+kind,file_id:data.id}]}]);assert.equal(result.status,200);
  }
});

test('actual FFmpeg MP4/MOV and fragmented/faststart video containers pass while audio-only MP4 is rejected',async t=>{
  const ffmpeg=process.env.HAMSTER_FFMPEG||'ffmpeg';
  if(spawnSync(ffmpeg,['-version'],{windowsHide:true,timeout:5000}).status!==0){
    t.skip('Set HAMSTER_FFMPEG or install FFmpeg for the generated video fixtures');
    return;
  }
  const root=resolve(tmpdir()),folder=mkdtempSync(resolve(root,'hamster-paid-files-video-'));
  t.after(()=>{assert.equal(dirname(resolve(folder)),root);rmSync(folder,{recursive:true,force:true});});
  let size=0;
  mockFetch(t,()=>fileResult('file-real-container',size));
  for(const [name,flags] of [['tail.mp4',[]],['fast.mp4',['-movflags','+faststart']],['fragmented.mp4',['-movflags','+frag_keyframe+empty_moov']],['quicktime.mov',[]]]){
    const file=resolve(folder,name);
    execFileSync(ffmpeg,['-hide_banner','-loglevel','error','-f','lavfi','-i','color=c=black:s=32x32:d=0.1','-an','-c:v','libx264','-pix_fmt','yuv420p',...flags,file],{windowsHide:true,timeout:15000});
    const bytes=readFileSync(file);size=bytes.length;
    assert.equal((await upload(environment(),{bytes,type:name.endsWith('.mov')?'video/quicktime':'video/mp4',name,fps:2})).status,200,name);
  }
  const audio=resolve(folder,'audio.mp4');execFileSync(ffmpeg,['-hide_banner','-loglevel','error','-f','lavfi','-i','anullsrc=r=8000:cl=mono','-t','0.1','-c:a','aac',audio],{windowsHide:true,timeout:15000});
  assert.equal((await upload(environment(),{bytes:readFileSync(audio),type:'video/mp4',name:'audio.mp4',fps:2})).status,400);
  const ordinary=container('vide'),ftyp=ordinary.subarray(0,20),moov=ordinary.subarray(20),wide=Buffer.alloc(16);
  wide.writeUInt32BE(1);wide.write('moov',4);wide.writeBigUInt64BE(BigInt(moov.length+8),8);
  const extended=Buffer.concat([ftyp,wide,moov.subarray(8)]);size=extended.length;
  assert.equal((await upload(environment(),{bytes:extended,type:'video/mp4',name:'extended.mp4',fps:2})).status,200);
  const zero=Buffer.from(ordinary);zero.writeUInt32BE(0,20);size=zero.length;
  assert.equal((await upload(environment(),{bytes:zero,type:'video/mp4',name:'zero.mp4',fps:2})).status,200);
});

test('file tickets bind audience, user, method, path, content type, bytes and 60-second validity',async t=>{
  mockFetch(t,()=>assert.fail('invalid ticket cannot contact provider'));
  const f=form(),timestamp=now();t.mock.method(Date,'now',()=>timestamp*1000);
  for(const patch of [{v:1},{aud:'pikno-llm-execute'},{uid:0},{uid:'2'},{method:'GET'},{path:'/api/v3/files'},{content_type:'text/plain'},{body_sha256:'0'.repeat(64)},{iat:timestamp+6},{exp:timestamp},{exp:timestamp+61}]){
    const response=await worker.fetch(await fileRequest('POST','/internal/pikno/files',f.body,f.type,patch),environment());assert.equal(response.status,401);
    assert.doesNotMatch(await response.text(),/synthetic|private|ep-files/);
  }
});

test('file configuration is fail closed and direct provider paths remain disabled',async t=>{
  mockFetch(t,()=>assert.fail('closed routes cannot contact provider'));
  for(const patch of [{PIKNO_LLM_FILES_ENABLED:undefined},{PIKNO_LLM_FILES_ENABLED:'false'},{PIKNO_LLM_FILES_ENABLED:'TRUE'},{LLM_BILLING_MODE:'legacy'},{LLM_BILLING_MODE:'paid'},{PIKNO_LLM_MODEL_VERIFIED:'false'},{ARK_API_KEY:''},{TOKEN_SIGNING_KEY:'short'},{PIKNO_LLM_ROUTES:'[]'}])assert.equal((await upload(environment(patch))).status,503);
  for(const path of ['/api/v3/files','/api/v3/files/hf1_fake'])assert.equal((await worker.fetch(new Request('https://inference.test'+path,{method:'POST'}),environment())).status,403);
});

test('unsupported, duplicate, oversized and disguised multipart fields are rejected before upload',async t=>{
  mockFetch(t,()=>assert.fail('invalid upload cannot contact provider'));
  for(const options of [{purpose:'agent'},{expiry:now()-1},{expiry:now()+3*86400+301},{fps:2},{extra:[['url','https://private.invalid']]},{extra:[['tos[bucket]','bucket']]},{duplicate:true},{type:'audio/mpeg',name:'audio.mp3'},
    {bytes:Buffer.from('not png')},{name:'../fixture.png'},{type:'application/octet-stream'},{name:'fixture.exe'},{bytes:video,type:'video/mp4',name:'video.mp4'},
    {bytes:video,type:'video/mp4',name:'video.mp4',fps:1},{bytes:container('soun'),type:'video/mp4',name:'disguised.mp4',fps:2},{bytes:Buffer.alloc(0)}])assert.equal((await upload(environment(),options)).status,400,JSON.stringify({...options,bytes:undefined}));
  const f=form();assert.equal((await worker.fetch(await fileRequest('POST','/internal/pikno/files',f.body,f.type,{}, {'content-length':String(50*1024*1024+65537)}),environment())).status,413);
  const malformed=Buffer.from(f.body.toString().replace('--hamster-offline-boundary--','--hamster-offline-boundary--junk'));
  assert.equal((await worker.fetch(await fileRequest('POST','/internal/pikno/files',malformed,f.type),environment())).status,400);
  assert.equal((await worker.fetch(await fileRequest('POST','/internal/pikno/files?url=bad',f.body,f.type),environment())).status,400);
});

test('desktop clock skew is bounded and expiry is shortened after signed-body verification without changing file bytes',async t=>{
  const serverNow=1800000000;t.mock.method(Date,'now',()=>serverNow*1000);
  let calls=0,forwardedExpiry,expectedWidth=10;
  mockFetch(t,async(_url,options)=>{
    calls++;
    const body=Buffer.from(options.body),data=await new Response(body,{headers:{'content-type':options.headers['content-type']}}).formData();
    const file=data.get('file');assert.equal(await hash(await file.arrayBuffer()),await hash(png));
    assert.equal(data.get('expire_at').length,expectedWidth);
    forwardedExpiry=Number(data.get('expire_at'));assert.equal(forwardedExpiry,serverNow+3*86400-60);
    return fileResult('file-clock',png.length,'active',{created_at:serverNow,expire_at:forwardedExpiry});
  });
  for(const skew of [0,1,6,300]){
    const value=form({expiry:serverNow+3*86400+skew}),before=Buffer.from(value.body),response=await worker.fetch(await fileRequest('POST','/internal/pikno/files',value.body,value.type),environment());
    assert.equal(response.status,200);assert.equal((await response.json()).expire_at,forwardedExpiry);
    assert.deepEqual(value.body,before,'caller-side request bytes are unchanged');
  }
  assert.equal(calls,4);
  for(const width of [11,12]){
    expectedWidth=width;
    const response=await upload(environment(),{expiry:String(serverNow+3*86400+6).padStart(width,'0')});
    assert.equal(response.status,200);assert.equal((await response.json()).expire_at,serverNow+3*86400-60);
  }
  assert.equal(calls,6);
  for(const expiry of [serverNow-1,serverNow,serverNow+3*86400+301,serverNow+3*86400+86400])assert.equal((await upload(environment(),{expiry})).status,400);
  assert.equal(calls,6);
  const tampered=form({expiry:serverNow+3*86400+6}),request=await fileRequest('POST','/internal/pikno/files',tampered.body,tampered.type,{body_sha256:'f'.repeat(64)});
  assert.equal((await worker.fetch(request,environment())).status,401);
  const malformed=form({expiry:'invalid'}),invalidDigest=await fileRequest('POST','/internal/pikno/files',malformed.body,malformed.type,{body_sha256:'f'.repeat(64)});
  assert.equal((await worker.fetch(invalidDigest,environment())).status,401,'body digest precedes multipart parsing or expiry writes');assert.equal(calls,6);
});

test('unauthorized upload is rejected before its body is read; boundary-like binary bytes are preserved',async t=>{
  const env=environment();let read=false;
  const request=new Request('https://inference.test/internal/pikno/files',{method:'POST',headers:{'content-type':'multipart/form-data; boundary=offline',authorization:'Bearer invalid.token'},body:'untouched'});
  Object.defineProperty(request,'body',{get(){read=true;throw new Error('must not read');}});
  assert.equal((await worker.fetch(request,env)).status,401);assert.equal(read,false);
  const bytes=Buffer.concat([png,Buffer.from('\r\n--hamster-offline-boundaryX\r\n--hamster-offline-boundary--not-the-end\r\nbytes')]);
  mockFetch(t,(_url,options)=>{assert.ok(Buffer.from(options.body).includes(bytes));return fileResult('file-binary-boundary',bytes.length);});
  assert.equal((await upload(env,{bytes})).status,200);
});

test('foreign, tampered, expired, legacy, raw and wrong-kind references never reach provider or durable claim',async t=>{
  let calls=0;mockFetch(t,()=>{calls++;return fileResult('file-hidden',png.length);});
  const env=environment(),created=await (await upload(env)).json(),count=calls,path='/internal/pikno/files/'+created.id;
  assert.equal((await worker.fetch(await fileRequest('GET',path,Buffer.alloc(0),'',{uid:3}),env)).status,403);
  for(const id of ['file-hidden','ho1_old',created.id.slice(0,-5)+'zzzzz'])assert.equal((await worker.fetch(await fileRequest('GET','/internal/pikno/files/'+id),env)).status,400);
  for(const part of [{type:'input_video',file_id:created.id},{type:'input_file',file_id:created.id},{type:'input_audio',file_id:created.id},{type:'input_image',image_url:'https://private.invalid'},{type:'input_image',file_id:'file-hidden'}])assert.equal((await execute(env,[{role:'user',content:[part]}])).status,400);
  assert.equal((await execute(env,[{role:'assistant',content:[{type:'input_image',file_id:created.id}]}])).status,400);
  assert.equal((await execute(env,[{role:'user',content:[{type:'input_image',file_id:created.id}]}],{uid:3})).status,403);
  assert.equal((await execute({...env,PIKNO_LLM_FILES_ENABLED:'false'},[{role:'user',content:[{type:'input_image',file_id:created.id}]}])).status,400);
  const later=now()+3601;t.mock.method(Date,'now',()=>later*1000);
  assert.equal((await worker.fetch(await fileRequest('GET',path),env)).status,400);
  assert.equal((await execute(env,[{role:'user',content:[{type:'input_image',file_id:created.id}]}])).status,400);
  assert.equal(calls,count);assert.equal(env.LLM_EXECUTIONS.calls.length,0);
});

test('attachment counts use distinct handles: six per message and twelve in history',async t=>{
  let counter=0,requests=0;
  mockFetch(t,(url)=>{if(String(url).endsWith('/files'))return fileResult('file-'+(++counter),png.length);requests++;return Response.json({object:'response',id:'resp-count',usage:{input_tokens:1,output_tokens:1}});});
  const env=environment(),ids=[];for(let i=0;i<13;i++)ids.push((await (await upload(env)).json()).id);
  const message=list=>({role:'user',content:list.map(file_id=>({type:'input_image',file_id}))});
  assert.equal((await execute(env,[message(ids.slice(0,7))])).status,400);
  assert.equal((await execute(env,[message(ids.slice(0,6)),message(ids.slice(6,12)),message(ids.slice(12))])).status,400);
  assert.equal(requests,0);assert.equal(env.LLM_EXECUTIONS.calls.length,0);
  assert.equal((await execute(env,[message([...ids.slice(0,6),ids[0]]),message(ids.slice(6,12))])).status,200);assert.equal(requests,1);
});

test('provider redirects, invalid metadata and raw error details fail closed without retries',async t=>{
  let result,calls=0;mockFetch(t,()=>{calls++;return result();});
  for(const response of [()=>new Response('secret ep-private https://private.invalid',{status:302,headers:{location:'https://private.invalid'}}),()=>Response.json({error:{message:'secret ep-private'}},{status:429}),()=>fileResult('file-private',png.length,'unexpected'),()=>fileResult('file-private',png.length,'active',{expire_at:now()-1}),()=>fileResult('file-private',png.length,'active',{bytes:50*1024*1024+1}),()=>fileResult('invalid/secret',png.length)]){
    result=response;const before=calls,reply=await upload(environment());assert.ok(reply.status>=400);assert.equal(calls,before+1);assert.doesNotMatch(await reply.text(),/secret|ep-private|https:/);
  }
});
