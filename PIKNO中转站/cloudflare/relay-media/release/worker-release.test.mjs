import {test} from 'node:test';
import assert from 'node:assert/strict';
import {runtimeSource} from './release-runtime-source.mjs';
import {createHmac,createHash,randomBytes} from 'node:crypto';
import {Miniflare,convertV4MiniflareOptions} from '../../../tools/relay-cli/node_modules/miniflare/dist/src/index.js';

test('Packy edge: streamed R2 multipart, billing metadata, replay prevention and output offload',async()=>{
 const secret='local-packy-runtime-only-secret-1234567890';
 let source=await runtimeSource();
 source=source.replace("fetch('https://cf.api.fan'+p.path,","mockUpstream('https://cf.api.fan'+p.path,");
 source=source.replace("'Image edge failed; inspect request history before retrying'","String(error.message)");
 source+=`
 async function mockUpstream(url,options){
  if(options.headers.Authorization!=='Bearer sk-test')throw new Error('wrong upstream key');
  let prompt,count=0;
  if(url.endsWith('/edits')){const form=await new Request(url,options).formData();if(form.has('response_format'))throw new Error('Packy rejects response_format');prompt=form.get('prompt');const files=[...form.getAll('image'),...form.getAll('image[]')];count=files.length;for(const file of files)if(file.size!==68)throw new Error('corrupt multipart');}
  else prompt=JSON.parse(options.body).prompt;
  if(prompt==='five'&&count!==5)throw new Error('missing references');
  return Response.json({created:1,data:[prompt==='base64'?{b64_json:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZCr8AAAAASUVORK5CYII='}:{url:'https://output.example/result.png'}],usage:{total_tokens:1}});
 }
 `;
 const mf=new Miniflare(convertV4MiniflareOptions({modules:true,compatibilityDate:'2026-10-03',script:source,r2Buckets:['MEDIA'],bindings:{TICKET_KEY:secret}}));
 const now=Math.floor(Date.now()/1000),id='a'.repeat(32);
 const sign=p=>{const s=Buffer.from(JSON.stringify(p)).toString('base64url');return s+'.'+createHmac('sha256',secret).update(s).digest('base64url')};
 const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZCr8AAAAASUVORK5CYII=','base64');
 const reference=uid=>'https://www.piknoai.com/media/v1/assets/'+id+'?ticket='+sign({v:1,aud:'pikno-relay-media',uid,id,op:'read',iat:now,exp:now+3600,mime:'image/png',size:png.length});
 const send=async(body,overrides={},ticketOverride)=>{const raw=JSON.stringify(body),claims={v:1,aud:'pikno-packy-edge',uid:7,id:randomBytes(16).toString('hex'),iat:now,exp:now+60,path:body.images?'/v1/images/edits':'/v1/images/generations',sha256:createHash('sha256').update(raw).digest('hex'),...overrides};return mf.dispatchFetch('https://www.piknoai.com/media/v1/packy',{method:'POST',headers:{Authorization:'Bearer sk-test','X-Pikno-Edge-Ticket':ticketOverride??sign(claims),'Content-Type':'application/json'},body:raw})};
 try{
  const bucket=await mf.getR2Bucket('MEDIA');await bucket.put('input/7/'+id,png,{httpMetadata:{contentType:'image/png'},customMetadata:{uid:'7',expires:String(now+86400)}});
  const base={model:'gpt-image-2.5-flare',prompt:'five',n:1,response_format:'url',images:Array(5).fill(reference(7))};
  let r=await send(base,{id:'b'.repeat(32)});assert.equal(r.status,200,await r.clone().text());assert.equal((await r.json()).usage.total_tokens,1);
  r=await send(base,{id:'b'.repeat(32)});assert.equal(r.status,409);
  assert.equal((await send({...base,images:[reference(8)]})).status,403);
  assert.equal((await send(base,{sha256:'0'.repeat(64)})).status,403);
  assert.equal((await send(base,{},'invalid.ticket')).status,401);
  assert.equal((await send({...base,images:Array(6).fill(reference(7))})).status,400);
  r=await send({model:base.model,prompt:'base64'});assert.equal(r.status,200,await r.clone().text());const result=await r.json();assert.equal(result.data[0].b64_json,undefined);
  r=await mf.dispatchFetch(result.data[0].url);assert.equal(r.status,200);assert.deepEqual(Buffer.from(await r.arrayBuffer()),png);
  r=await mf.dispatchFetch(reference(7),{headers:{Range:'bytes=-8'}});assert.equal(r.status,206);assert.deepEqual(Buffer.from(await r.arrayBuffer()),png.subarray(-8));
 }finally{await mf.dispose()}
});

// This fixture exercises the production Worker in workerd. Only the paid
// upstream/download fetches are replaced; signing, private R2 and multipart stay real.
async function withGpt2Runtime(run){
 const secret='local-gpt2-runtime-only-secret-1234567890';
 let source=(await runtimeSource()).replace("fetch('https://cf.api.fan'+p.path,","mockUpstream('https://cf.api.fan'+p.path,");
 source=source.replace('fetch(outputURL.href,','mockDownload(outputURL.href,');
 source=source.replace("    const origin = request.headers.get('origin');","    if(new URL(request.url).pathname==='/__test/observations')return Response.json({upstreamCalls,downloads,upstreamRequests});\n    const origin = request.headers.get('origin');");
 source+=`
 let upstreamCalls=0,downloads=[],upstreamRequests=[];
 async function mockUpstream(url,options){
  upstreamCalls++;
  if(options.headers.Authorization!=='Bearer sk-test')throw new Error('wrong upstream key');
  let fields,files=[];
  if(url.endsWith('/edits')){
   const form=await new Request(url,options).formData();fields={};
   for(const [name,value] of form){
    if(typeof value==='string')fields[name]=value;
    else files.push({field:name,name:value.name,type:value.type,bytes:Array.from(new Uint8Array(await value.arrayBuffer()))});
   }
  }else fields=JSON.parse(options.body);
  upstreamRequests.push({url,content_type:options.headers['Content-Type'],redirect:options.redirect,fields,files});
  if(Object.hasOwn(fields,'response_format'))return Response.json({error:{message:"Unknown parameter: 'response_format'"}},{status:400});
  if(fields.prompt.startsWith('error:'))return Response.json({error:{message:'rejected sk-do-not-expose https://provider.example/private'}},{status:Number(fields.prompt.slice(6))});
  const output=fields.prompt==='base64'?{b64_json:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZCr8AAAAASUVORK5CYII='}:{url:fields.prompt.startsWith('url:')?fields.prompt.slice(4):'https://external-resources.packyapi.ai/file_download/'+(fields.prompt.startsWith('download:')?fields.prompt.slice(9):'documented-output')};
  return Response.json({created:1,data:[output],usage:{total_tokens:upstreamCalls,input_tokens:1,output_tokens:2,input_tokens_details:{text_tokens:1,image_tokens:0}}});
 }
 async function mockDownload(url,options){
  downloads.push({url,method:options.method,redirect:options.redirect,authorization:new Headers(options.headers).get('Authorization')});
  if(options.method!=='GET' || options.redirect!=='manual' || new Headers(options.headers).has('Authorization'))throw new Error('unsafe output download');
  const kind=new URL(url).pathname.split('/').at(-1);
  if(kind==='redirect')return new Response(null,{status:302,headers:{Location:'https://provider.example/redirected'}});
  if(kind==='404')return new Response('not found',{status:404});
  if(kind==='network')throw new Error('private download error https://external-resources.packyapi.ai/file_download/secret');
  if(kind==='html')return new Response('<html>not an image</html>',{headers:{'Content-Type':'image/png'}});
  if(kind==='too-large')return new Response(new Uint8Array((16<<20)+1),{headers:{'Content-Type':'image/png'}});
  if(kind==='webp')return new Response(new Uint8Array([82,73,70,70,0,0,0,0,87,69,66,80]),{headers:{'Content-Type':'image/webp'}});
  if(kind==='jpeg')return new Response(new Uint8Array([255,216,255,224,0,16,74,70,73,70,0,1]),{headers:{'Content-Type':'image/jpeg'}});
  return new Response(Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZCr8AAAAASUVORK5CYII='),c=>c.charCodeAt(0)),{headers:{'Content-Type':'image/png'}});
 }
 `;
 const mf=new Miniflare(convertV4MiniflareOptions({modules:true,compatibilityDate:'2026-10-03',script:source,r2Buckets:['MEDIA'],bindings:{TICKET_KEY:secret}}));
 const now=Math.floor(Date.now()/1000),assetID='a'.repeat(32);
 const sign=p=>{const s=Buffer.from(JSON.stringify(p)).toString('base64url');return s+'.'+createHmac('sha256',secret).update(s).digest('base64url')};
 const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZCr8AAAAASUVORK5CYII=','base64');
 const reference='https://www.piknoai.com/media/v1/assets/'+assetID+'?ticket='+sign({v:1,aud:'pikno-relay-media',uid:7,id:assetID,op:'read',iat:now,exp:now+3600,mime:'image/png',size:png.length});
 const send=async(body,{id=randomBytes(16).toString('hex'),path=body.images?'/v1/images/edits':'/v1/images/generations'}={})=>{
  const raw=JSON.stringify(body),claims={v:1,aud:'pikno-packy-edge',uid:7,id,iat:now,exp:now+60,path,sha256:createHash('sha256').update(raw).digest('hex')};
  return mf.dispatchFetch('https://www.piknoai.com/media/v1/packy',{method:'POST',headers:{Authorization:'Bearer sk-test','X-Pikno-Edge-Ticket':sign(claims),'Content-Type':'application/json'},body:raw});
 };
 try{
  const bucket=await mf.getR2Bucket('MEDIA');await bucket.put('input/7/'+assetID,png,{httpMetadata:{contentType:'image/png'},customMetadata:{uid:'7',expires:String(now+86400)}});
  const addReference=async({index,uid=7,claim={},metadata={},store=true}={})=>{
   const id=Number(index+1).toString(16).padStart(32,'0');
   const bytes=Buffer.concat([png,Buffer.from([index])]);
   if(store)await bucket.put('input/'+uid+'/'+id,bytes,{httpMetadata:{contentType:'image/png'},customMetadata:{uid:String(uid),expires:String(now+86400),...metadata}});
   const claims={v:1,aud:'pikno-relay-media',uid,id,op:'read',iat:now,exp:now+3600,mime:'image/png',size:bytes.length,...claim};
   return {url:'https://www.piknoai.com/media/v1/assets/'+id+'?ticket='+sign(claims),bytes};
  };
  await run({send,reference,png,mf,addReference,observations:async()=>mf.dispatchFetch('https://www.piknoai.com/__test/observations').then(response=>response.json())});
 }finally{await mf.dispose()}
}

test('GPT Image 2: JSON generation and binary multipart editing preserve supported parameters',async()=>withGpt2Runtime(async({send,reference,png,observations})=>{
 const base={model:'gpt-image-2',prompt:'documented request',n:1,size:'3840x2160',quality:'high',response_format:'url',output_format:'jpeg',output_compression:85,background:'opaque',moderation:'auto',user:'local-test-only'};
 let response=await send(base);assert.equal(response.status,200,await response.clone().text());
 let sent=(await observations()).upstreamRequests.at(-1);
 assert.equal(sent.url,'https://cf.api.fan/v1/images/generations');
 assert.equal(sent.content_type,'application/json');assert.equal(sent.redirect,'manual');
 const {response_format,...generationFields}=base;
 assert.deepEqual(sent.fields,generationFields);assert.deepEqual(sent.files,[]);
 const edit={...base,size:'1024x1536',input_fidelity:'high',images:[reference]};
 response=await send(edit);assert.equal(response.status,200,await response.clone().text());
 sent=(await observations()).upstreamRequests.at(-1);
 assert.equal(sent.url,'https://cf.api.fan/v1/images/edits');assert.match(sent.content_type,/^multipart\/form-data; boundary=pikno[a-f0-9]{32}$/);
 const {images,response_format:editResponseFormat,...fields}=edit;
 assert.deepEqual(sent.fields,Object.fromEntries(Object.entries(fields).map(([key,value])=>[key,String(value)])));
 assert.deepEqual(sent.files,[{field:'image',name:'reference-0.png',type:'image/png',bytes:[...png]}]);
 response=await send({model:base.model,prompt:'defaults'});assert.equal(response.status,200);
 sent=(await observations()).upstreamRequests.at(-1);
 assert.deepEqual(sent.fields,{model:base.model,prompt:'defaults',n:1,output_format:'png'});
}));

test('Packy edge: omits unsupported response_format for both models and image operations',async()=>withGpt2Runtime(async({send,reference,png,mf,observations})=>{
 let expectedCalls=0;
 for(const model of ['gpt-image-2','gpt-image-2.5-flare']){
  for(const editing of [false,true]){
   const id=randomBytes(16).toString('hex');
   const body={model,prompt:'base64',n:1,response_format:'url',...(editing?{images:[reference]}:{})};
   const response=await send(body,{id});
   assert.equal(response.status,200,await response.clone().text());
   const result=await response.json(),observed=await observations();expectedCalls++;
   assert.equal(observed.upstreamCalls,expectedCalls,'one original POST, no format fallback or automatic retry');
   const sent=observed.upstreamRequests.at(-1);
   assert.equal(Object.hasOwn(sent.fields,'response_format'),false);
   assert.equal(sent.url,'https://cf.api.fan/v1/images/'+(editing?'edits':'generations'));
   assert.equal(sent.files.length,editing?1:0);
   assert.match(result.data[0].url,/^https:\/\/www\.piknoai\.com\/media\/v1\/assets\/[a-f0-9]{32}\?ticket=/);
   assert.equal(result.data[0].b64_json,undefined);
   assert.equal(result.usage.total_tokens,expectedCalls);
   const download=await mf.dispatchFetch(result.data[0].url);
   assert.equal(download.status,200);assert.deepEqual(Buffer.from(await download.arrayBuffer()),png);
   assert.equal((await send(body,{id})).status,409,'an explicit replay retains the submitted claim');
   assert.equal((await observations()).upstreamCalls,expectedCalls);
  }
 }
}));

test('GPT Image 2: URL and base64 results are privately stored and signed; usage remains intact',async()=>withGpt2Runtime(async({send,png,mf,observations})=>{
 const base={model:'gpt-image-2',n:1};
 for(const [prompt,mime,bytes] of [
  ['documented request','image/png',png],
  ['url:https://external-resources.packyapi.ai/file_download/signed-output?signature=test-only&expires=123','image/png',png],
  ['download:jpeg','image/jpeg',Buffer.from([255,216,255,224,0,16,74,70,73,70,0,1])],
  ['base64','image/png',png],
 ]){
  const response=await send({...base,prompt});assert.equal(response.status,200,await response.clone().text());
  const result=await response.json();
  assert.match(result.data[0].url,/^https:\/\/www\.piknoai\.com\/media\/v1\/assets\/[a-f0-9]{32}\?ticket=/);
  assert.doesNotMatch(JSON.stringify(result),/external-resources|file_download|signature=test-only|cf\.api\.fan|b64_json/);
  assert.equal(result.created,1);
  assert.deepEqual(result.usage,{total_tokens:(await observations()).upstreamCalls,input_tokens:1,output_tokens:2,input_tokens_details:{text_tokens:1,image_tokens:0}});
  const download=await mf.dispatchFetch(result.data[0].url);assert.equal(download.status,200);
  assert.equal(download.headers.get('Content-Type'),mime);assert.equal(download.headers.get('Cache-Control'),'private, no-store');
  assert.deepEqual(Buffer.from(await download.arrayBuffer()),bytes);
  const privateURL=new URL(result.data[0].url);privateURL.search='';
  assert.equal((await mf.dispatchFetch(privateURL.href)).status,401,'private results require a signed ticket');
 }
 const observed=await observations();assert.equal(observed.upstreamCalls,4);assert.equal(observed.downloads.length,3);
 assert.ok(observed.downloads.every(request=>request.method==='GET' && request.redirect==='manual' && request.authorization===null));
 assert.match(observed.downloads[1].url,/\?signature=test-only&expires=123$/,'signed download query is retained only server-side');
}));

test('GPT Image 2: invalid download URLs and failed delivery stay uncertain and never resubmit',async()=>withGpt2Runtime(async({send,observations})=>{
 const invalidURLs=[
  'http://external-resources.packyapi.ai/file_download/file',
  'https://output.example/result.png',
  'https://external-resources.packyapi.ai.evil.example/file_download/file',
  'https://user:password@external-resources.packyapi.ai/file_download/file',
  'https://external-resources.packyapi.ai:8443/file_download/file',
  'https://external-resources.packyapi.ai/other/file',
  'https://external-resources.packyapi.ai/file_download/',
  'https://external-resources.packyapi.ai/file_download/nested/file',
  'https://external-resources.packyapi.ai/file_download/file#fragment',
  'https://external-resources.packyapi.ai/file_download/%2Ffile',
  'not a URL',
 ];
 let expectedCalls=0;
 for(const prompt of [...invalidURLs.map(url=>'url:'+url),...['redirect','404','network','html','too-large','webp'].map(kind=>'download:'+kind)]){
  const id=randomBytes(16).toString('hex'),body={model:'gpt-image-2',prompt};
  const before=await observations();
  const response=await send(body,{id});expectedCalls++;
  assert.equal(response.status,502,prompt+': '+await response.clone().text());
  assert.doesNotMatch(await response.text(),/external-resources|file_download|output\.example|provider\.example|user:password/);
  assert.equal((await send(body,{id})).status,409,'a retry must retain the submitted lock');
  const after=await observations();
  assert.equal(after.upstreamCalls,expectedCalls,'one original POST, no automatic second submission');
  assert.equal(after.downloads.length,before.downloads.length+(prompt.startsWith('download:')?1:0),'untrusted URLs must never be fetched');
 }
}));

test('GPT Image 2: parameter and dimension boundaries reject before durable submission',async()=>withGpt2Runtime(async({send,reference,observations})=>{
 const base={model:'gpt-image-2',prompt:'size validation'};
 for(const size of ['auto','1024x1024','1536x1024','1024x1536','1536x864','2048x2048','2048x1152','3840x2160','2160x3840','1024x640','1536x512']){
  const response=await send({...base,size});assert.equal(response.status,200,size+': '+await response.clone().text());
  assert.equal((await observations()).upstreamRequests.at(-1).fields.size,size);
 }
 const invalid=[
  ...['1025x1024','3856x2160','1024x0','0x1024','800x800','2896x2896','3840x1264','-1024x1024','1024X1024','1024x1024junk','auto\n'].map(size=>({size})),
  {size:1024},{size:null},{quality:'standard'},{quality:null},{output_format:'webp'},
  {output_compression:85},{output_format:'png',output_compression:85},
  ...[-1,101,1.5,'85',null].map(output_compression=>({output_format:'jpeg',output_compression})),
  {background:'transparent'},{moderation:'off'},{input_fidelity:'high'},{user:123},
  {n:2},{n:'1'},{response_format:'b64_json'},{stream:false},{partial_images:1},{style:'vivid'},{mask:reference},
  {images:[]},{images:Array(6).fill(reference)},
 ];
 for(const options of invalid){
  const id=randomBytes(16).toString('hex');
  const response=await send({...base,...options},{id});assert.equal(response.status,400,JSON.stringify(options)+': '+await response.clone().text());
  // A rejected local request must not reserve an id or send a paid call.
  assert.equal((await send(base,{id})).status,200);
 }
 for(const quality of ['auto','low','medium','high'])assert.equal((await send({...base,quality})).status,200);
 for(const output_compression of [0,100])assert.equal((await send({...base,output_format:'jpeg',output_compression})).status,200);
 assert.equal((await send({...base,moderation:'low',background:'opaque'})).status,200);
 assert.equal((await send({...base,images:[reference],input_fidelity:'low'})).status,400);
 assert.equal((await send(base,{path:'/v1/images/edits'})).status,400);
 assert.equal((await send({...base,images:[reference]},{path:'/v1/images/generations'})).status,400);
}));

test('Packy edge: explicit rejections preserve 4xx; uncertain failures keep the one-submit lock',async()=>withGpt2Runtime(async({send})=>{
 const base={model:'gpt-image-2',prompt:'counter'};
 let calls=0;
 for(const status of [400,401,403,404,408,422,429,500,503]){
  const id=randomBytes(16).toString('hex'),body={...base,prompt:'error:'+status};
  const response=await send(body,{id});calls++;
  assert.equal(response.status,status<500 && status!==408?status:502);
  const error=await response.json();assert.match(error.error.message,new RegExp('HTTP '+status));
  assert.doesNotMatch(error.error.message,/sk-do-not-expose|provider\.example/);
  assert.equal((await send(body,{id})).status,409);
  const after=await send(base);calls++;assert.equal(after.status,200);
  assert.equal((await after.json()).usage.total_tokens,calls,'no automatic retry or replay upstream call');
 }
}));

test('GPT Image 2: two and five references retain exact binary order and 4:3 / 3:4 sizes',async()=>withGpt2Runtime(async({send,addReference,observations})=>{
 const references=await Promise.all(Array.from({length:5},(_,index)=>addReference({index})));
 let expectedCalls=0;
 for(const size of ['1536x1152','1152x1536'])for(const count of [2,5]){
  const body={model:'gpt-image-2',prompt:'multiple references',n:1,size,quality:'high',images:references.slice(0,count).map(item=>item.url)};
  const id=randomBytes(16).toString('hex');
  const response=await send(body,{id});assert.equal(response.status,200,await response.clone().text());
  const observed=await observations();expectedCalls++;
  assert.equal(observed.upstreamCalls,expectedCalls);
  const sent=observed.upstreamRequests.at(-1);
  assert.equal(sent.fields.size,size);
  assert.equal(sent.fields.n,'1');
  assert.deepEqual(sent.files,references.slice(0,count).map((item,index)=>({field:'image[]',name:'reference-'+index+'.png',type:'image/png',bytes:[...item.bytes]})));
  assert.equal((await send(body,{id})).status,409);
  assert.equal((await observations()).upstreamCalls,expectedCalls,'accepted multi-reference requests never resubmit');
 }
}));

test('GPT Image 2: six references reject before paid calls or durable claiming',async()=>withGpt2Runtime(async({send,addReference,observations})=>{
 const references=await Promise.all(Array.from({length:6},(_,index)=>addReference({index})));
 const id=randomBytes(16).toString('hex');
 const body={model:'gpt-image-2',prompt:'reference count boundary',images:references.map(item=>item.url)};
 assert.equal((await send(body,{id})).status,400);
 assert.equal((await observations()).upstreamCalls,0);
 assert.equal((await send({...body,images:body.images.slice(0,5)},{id})).status,200,'local rejection does not consume the original operation');
 assert.equal((await observations()).upstreamCalls,1);
}));

test('GPT Image 2: every reference must carry a valid same-account signature and matching live object',async()=>withGpt2Runtime(async({send,addReference,observations})=>{
 const references=await Promise.all(Array.from({length:5},(_,index)=>addReference({index})));
 const foreign=await addReference({index:8,uid:8});
 const missing=await addReference({index:9,store:false});
 const wrongOwner=await addReference({index:10,metadata:{uid:'8'}});
 const wrongSize=await addReference({index:11,claim:{size:70}});
 const expired=await addReference({index:12,metadata:{expires:'1'}});
 const wrongPurpose=await addReference({index:13,claim:{op:'upload'}});
 let successfulCalls=0;
 for(const [invalid,status] of [[foreign.url,403],[missing.url,404],[wrongOwner.url,409],[wrongSize.url,409],[expired.url,404],[wrongPurpose.url,403],[references[0].url.slice(0,-1)+'!',401]]){
  for(let index=0;index<5;index++){
   const images=references.map(item=>item.url);images[index]=invalid;
   const id=randomBytes(16).toString('hex'),body={model:'gpt-image-2',prompt:'validate every reference',images};
   assert.equal((await send(body,{id})).status,status,'invalid reference at index '+index);
   assert.equal((await observations()).upstreamCalls,successfulCalls,'all reference validation precedes a paid submission');
   assert.equal((await send({...body,images:references.map(item=>item.url)},{id})).status,200,'invalid references do not claim an operation');
   successfulCalls++;
  }
 }
}));

test('GPT Image 2: multi-reference upstream failures keep a single submission and replay lock',async()=>withGpt2Runtime(async({send,addReference,observations})=>{
 const references=await Promise.all(Array.from({length:5},(_,index)=>addReference({index})));
 let expectedCalls=0;
 for(const status of [400,408,429,500,503]){
  const id=randomBytes(16).toString('hex');
  const body={model:'gpt-image-2',prompt:'error:'+status,images:references.map(item=>item.url)};
  const response=await send(body,{id});expectedCalls++;
  assert.equal(response.status,status<500&&status!==408?status:502);
  assert.doesNotMatch(await response.text(),/sk-do-not-expose|provider\.example/);
  assert.equal((await send(body,{id})).status,409);
  assert.equal((await observations()).upstreamCalls,expectedCalls,'no retry after an explicit or uncertain multi-reference response');
 }
}));
