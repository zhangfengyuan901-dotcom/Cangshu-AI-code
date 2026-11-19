import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {Miniflare,convertV4MiniflareOptions} from '../../tools/relay-cli/node_modules/miniflare/dist/src/index.js';

test('exact tool candidate records private fixed result diagnostics without resubmitting',async()=>{
 const candidate=new URL('./release/worker-release.js',import.meta.url);
 let source=await readFile(candidate,'utf8');
 source=source.replace('fetch(RH + path,','mockProvider(RH + path,').replace('fetch(remote.href,','mockDownload(remote.href,');
 source=source.replace('job2.poll_diagnostic = { code, stage, ...diagnostic };',`job2.poll_diagnostic = { code, stage, ...diagnostic };
        if(mode==='slow-diagnostic'){diagnosticPending=true;await new Promise(resolve=>setTimeout(resolve,250));diagnosticPending=false;}`);
 source=source.replace('  async fetch(request, env) {',`  async fetch(request, env) {
    if(new URL(request.url).pathname==='/__test/state')return Response.json({queries,downloads,diagnosticPending});
    if(new URL(request.url).pathname==='/__test/mode'){mode=await request.text();return Response.json({queries,downloads});}`);
 source+=`
 let mode='success',queries=0,downloads=0,diagnosticPending=false;
 async function mockProvider(url,options){
  if(!url.endsWith('/query')||JSON.parse(options.body).taskId!=='synthetic-provider')throw Error('No submission is permitted');queries++;
  return Response.json({status:'SUCCESS',results:['missing','slow-diagnostic'].includes(mode)?[]:[{outputType:'mp4',url:mode==='new-host'?'https://rh-comfyui01.tos-cn-beijing.volces.com/raw-secret.mp4':mode==='suffix-host'?'https://rh-comfyui01.tos-cn-beijing.volces.com.evil.invalid/raw-secret':mode==='http-scheme'?'http://rh-comfyui01.tos-cn-beijing.volces.com/raw-secret':mode==='credential-url'?'https://private:secret@rh-comfyui01.tos-cn-beijing.volces.com/raw-secret':mode==='host'?'https://private.invalid/raw-secret':'https://rh-images-1252422369.cos.ap-beijing.myqcloud.com/raw-secret.mp4'}]});
 }
 async function mockDownload(){downloads++;
  if(mode==='http')return new Response(null,{status:403});
  if(mode==='large')return new Response(null,{headers:{'Content-Length':String((50<<20)+1)}});
  return new Response(new Uint8Array(mode==='format'?16:[0,0,0,16,102,116,121,112,109,112,52,50,0,0,0,0]),{headers:{'Content-Type':'video/mp4'}});
 }
 `;
 const bridge='synthetic-tool-bridge-123456789012345678901',mf=new Miniflare(convertV4MiniflareOptions({modules:true,compatibilityDate:'2026-10-03',script:source,r2Buckets:['MEDIA'],bindings:{TOOLS_ENABLED:'true',TOOLS_BRIDGE_SECRET:bridge,TOOLS_ADMIN_SECRET:'synthetic-tool-admin-123456789012345678901',RUNNINGHUB_API_KEY:'x'.repeat(32),TICKET_KEY:'synthetic-ticket-key-12345678901234567890'}}));
 try{
  const bucket=await mf.getR2Bucket('MEDIA');
  for(const [mode,code] of [['missing','OUTPUT_UNRECOGNIZED'],['host','OUTPUT_URL_REJECTED'],['http','DOWNLOAD_HTTP_REJECTED'],['large','OUTPUT_TOO_LARGE'],['format','OUTPUT_FORMAT_REJECTED'],['new-host',null],['suffix-host','OUTPUT_URL_REJECTED'],['http-scheme','OUTPUT_URL_REJECTED'],['credential-url','OUTPUT_URL_REJECTED'],['success',null]]){
   await mf.dispatchFetch('https://www.piknoai.com/__test/mode',{method:'POST',body:mode});
   const id='task_'+mode,key='tool-jobs/'+id;
   await bucket.put(key,JSON.stringify({id,uid:9,kind:'depth',status:'queued',provider_task_id:'synthetic-provider'}));
   const response=await mf.dispatchFetch('https://www.piknoai.com/media/v1/tools/'+id,{headers:{Authorization:'Bearer '+bridge}}),body=await response.json();
   assert.equal(response.status,200);assert.equal(body.status,code?'unknown':'completed');
   const stored=await(await bucket.get(key)).json();
   if(code){assert.equal(stored.poll_diagnostic.code,code);assert.equal(stored.status,'queued');assert.doesNotMatch(JSON.stringify(stored),/private\.invalid|raw-secret|https:|Bearer|synthetic-tool/);assert.deepEqual(Object.keys(body).sort(),['id','outputs','status']);}
   else {assert.equal(stored.poll_diagnostic,undefined);assert.equal(stored.status,'completed');}
  }
  const counts=await(await mf.dispatchFetch('https://www.piknoai.com/__test/mode',{method:'POST',body:'success'})).json();assert.equal(counts.queries,10);assert.equal(counts.downloads,5);
  await mf.dispatchFetch('https://www.piknoai.com/__test/mode',{method:'POST',body:'slow-diagnostic'});
  await bucket.put('tool-jobs/task_slow',JSON.stringify({id:'task_slow',uid:9,kind:'depth',status:'queued',provider_task_id:'synthetic-provider'}));
  const first=mf.dispatchFetch('https://www.piknoai.com/media/v1/tools/task_slow',{headers:{Authorization:'Bearer '+bridge}});
  for(let i=0;i<30;i++){const state=await(await mf.dispatchFetch('https://www.piknoai.com/__test/state')).json();if(state.diagnosticPending)break;await new Promise(resolve=>setTimeout(resolve,5));}
  const state=await(await mf.dispatchFetch('https://www.piknoai.com/__test/state')).json();assert.equal(state.diagnosticPending,true);
  const second=await mf.dispatchFetch('https://www.piknoai.com/media/v1/tools/task_slow',{headers:{Authorization:'Bearer '+bridge}});assert.equal((await second.json()).status,'processing');
  assert.equal((await(await mf.dispatchFetch('https://www.piknoai.com/__test/state')).json()).queries,11,'the first diagnostic must retain the query lease until its write completes');
  assert.equal((await(await first).json()).status,'unknown');assert.equal(await bucket.get('tool-polls/task_slow'),null);
 }finally{await mf.dispose();}
});
