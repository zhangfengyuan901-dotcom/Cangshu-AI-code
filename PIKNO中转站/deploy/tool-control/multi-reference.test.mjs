import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHmac,createHash,randomBytes} from 'node:crypto';
import {Miniflare,convertV4MiniflareOptions} from '../../tools/relay-cli/node_modules/miniflare/dist/src/index.js';
import {loadRuntime,RELEASE_SHA256} from './runtime.mjs';
import {createStorageClient} from './storage-client.mjs';
import {createControlServer} from './server.mjs';

const ticketKey='ecs-multi-reference-fixture-ticket-key-1234567890';
const storeSecret='S'.repeat(40),bridge='B'.repeat(40),admin='A'.repeat(40);
const env={CONTROL_OWNER:'ecs',CONTROL_STORAGE_ENABLED:'true',TOOL_STORE_SECRET:storeSecret,TOOLS_ENABLED:'true',TOOLS_BRIDGE_SECRET:bridge,TOOLS_ADMIN_SECRET:admin,TICKET_KEY:ticketKey,RH_CONFIG_ENCRYPTION_KEY:'a'.repeat(64)};
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZCr8AAAAASUVORK5CYII=','base64');
const sign=claims=>{const raw=Buffer.from(JSON.stringify(claims)).toString('base64url');return raw+'.'+createHmac('sha256',ticketKey).update(raw).digest('base64url');};
const records=[];

async function fixture(run){
 const protocol=(await readFile(new URL('../../cloudflare/relay-media/control-migration/protocol.mjs',import.meta.url),'utf8')).replaceAll('export ','');
 const storage=(await readFile(new URL('../../cloudflare/relay-media/control-migration/storage.mjs',import.meta.url),'utf8')).replace(/^import .*\n/,'').replace('export async function storage','async function storage');
 const mf=new Miniflare(convertV4MiniflareOptions({modules:true,compatibilityDate:'2026-10-03',script:protocol+'\n'+storage+'\nexport default {fetch:storage};',r2Buckets:['MEDIA'],bindings:env}));
 let service;
 try{
  const bucket=await mf.getR2Bucket('MEDIA');
  const media=createStorageClient({origin:'https://store.test.invalid',secret:storeSecret,fetchImpl:(url,options)=>mf.dispatchFetch(String(url),options)});
  const sent=[];
  const runtime=await loadRuntime({fetchImpl:async(url,options)=>{
   assert.equal(String(url),'https://cf.api.fan/v1/images/edits');
   assert.equal(options.headers.get('authorization'),'Bearer sk-local-multi-reference');
   assert.equal(options.redirect,'manual');
   const raw=Buffer.from(await new Response(options.body).arrayBuffer());
   assert.equal(Number(options.headers.get('content-length')),raw.length,'Node adapter retains an exact streamed multipart content-length');
   const form=await new Response(raw,{headers:{'Content-Type':options.headers.get('content-type')}}).formData();
   const files=[];
   for(const [name,value] of form)if(typeof value!=='string')files.push({field:name,name:value.name,type:value.type,bytes:Buffer.from(await value.arrayBuffer())});
   sent.push({size:form.get('size'),n:form.get('n'),prompt:form.get('prompt'),files});
   if(form.get('prompt').startsWith('reject:'))return Response.json({error:{message:'fixture rejection'}},{status:Number(form.get('prompt').slice(7))});
   return Response.json({data:[{b64_json:png.toString('base64')}],usage:{total_tokens:sent.length}});
  }});
  service=createControlServer({runtime,env,media});
  await new Promise(resolve=>service.server.listen(0,'127.0.0.1',resolve));
  const origin='http://127.0.0.1:'+service.server.address().port;
  const now=Math.floor(Date.now()/1000);
  const references=[];
  for(let index=0;index<6;index++){
   const id=(index+1).toString(16).padStart(32,'0'),bytes=Buffer.concat([png,Buffer.from([index])]);
   await bucket.put('input/7/'+id,bytes,{httpMetadata:{contentType:'image/png'},customMetadata:{uid:'7',expires:String(now+86400)}});
   references.push({bytes,url:'https://www.piknoai.com/media/v1/assets/'+id+'?ticket='+sign({v:1,aud:'pikno-relay-media',uid:7,id,op:'read',iat:now,exp:now+3600,mime:'image/png',size:bytes.length})});
  }
  const send=(body,{id=randomBytes(16).toString('hex')}={})=>{
   const raw=JSON.stringify(body),ticket=sign({v:1,aud:'pikno-packy-edge',uid:7,id,path:'/v1/images/edits',iat:now,exp:now+60,sha256:createHash('sha256').update(raw).digest('hex')});
   return fetch(origin+'/media/v1/packy',{method:'POST',headers:{Authorization:'Bearer sk-local-multi-reference','X-Pikno-Edge-Ticket':ticket,'Content-Type':'application/json'},body:raw});
  };
  await run({send,sent,references,media,bucket});
 }finally{if(service)await service.close();await mf.dispose();}
}

test('ECS real HTTP executor streams two/five references in order and passes both portrait/landscape sizes',async()=>fixture(async({send,sent,references})=>{
 for(const size of ['1536x1152','1152x1536'])for(const count of [2,5]){
  const body={model:'gpt-image-2',prompt:'synthetic multi-reference case',n:1,size,images:references.slice(0,count).map(x=>x.url)};
  const id=randomBytes(16).toString('hex');
  const response=await send(body,{id});assert.equal(response.status,200,await response.clone().text());
  const request=sent.at(-1);assert.equal(request.size,size);assert.equal(request.n,'1');
  assert.deepEqual(request.files,references.slice(0,count).map((ref,index)=>({field:'image[]',name:'reference-'+index+'.png',type:'image/png',bytes:ref.bytes})));
  const calls=sent.length;assert.equal((await send(body,{id})).status,409);assert.equal(sent.length,calls);
 }
 records.push({case:'node-http-r2-multipart-order-size-and-replay',passed:true,providerAttempts:sent.length,referenceCounts:[2,5],sizes:['1536x1152','1152x1536']});
}));

test('ECS real HTTP executor rejects six references and invalid final ownership before a claim or paid call',async()=>fixture(async({send,sent,references,bucket})=>{
 const body={model:'gpt-image-2',prompt:'synthetic limits',images:references.map(x=>x.url)},id=randomBytes(16).toString('hex');
 assert.equal((await send(body,{id})).status,400);assert.equal(sent.length,0);
 const valid={...body,images:body.images.slice(0,5)};
 const lastKey='input/7/'+'5'.padStart(32,'0');
 await bucket.put(lastKey,references[4].bytes,{httpMetadata:{contentType:'image/png'},customMetadata:{uid:'8',expires:String(Math.floor(Date.now()/1000)+86400)}});
 assert.equal((await send(valid,{id})).status,409);assert.equal(sent.length,0);
 await bucket.put(lastKey,references[4].bytes,{httpMetadata:{contentType:'image/png'},customMetadata:{uid:'7',expires:String(Math.floor(Date.now()/1000)+86400)}});
 assert.equal((await send(valid,{id})).status,200,'preflight failures do not consume the original operation');assert.equal(sent.length,1);
 records.push({case:'node-http-over-limit-and-last-object-owner-preflight',passed:true,providerAttempts:sent.length});
}));

test('ECS multi-reference explicit and uncertain provider failures never resubmit',async()=>fixture(async({send,sent,references})=>{
 let attempts=0;
 for(const status of [400,408,429,500,503]){
  const id=randomBytes(16).toString('hex'),body={model:'gpt-image-2',prompt:'reject:'+status,images:references.slice(0,5).map(x=>x.url)};
  assert.equal((await send(body,{id})).status,status<500&&status!==408?status:502);attempts++;
  assert.equal(sent.length,attempts);assert.equal((await send(body,{id})).status,409);assert.equal(sent.length,attempts);
 }
 records.push({case:'node-http-multi-reference-no-retry-after-failure',passed:true,providerAttempts:sent.length});
}));

test('all ECS multi-reference HTTP and storage scenarios complete',async()=>{
 assert.equal(records.length,3);
});
