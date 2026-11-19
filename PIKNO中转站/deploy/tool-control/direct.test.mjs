import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {loadRuntime} from './runtime.mjs';
import {createControlServer} from './server.mjs';

const bridge='B'.repeat(40),admin='A'.repeat(40),ticketKey='T'.repeat(40);
const bindings={CONTROL_OWNER:'ecs',TOOL_STORE_SECRET:'S'.repeat(40),TOOLS_ENABLED:'true',TOOLS_BRIDGE_SECRET:bridge,TOOLS_ADMIN_SECRET:admin,TICKET_KEY:ticketKey,RH_CONFIG_ENCRYPTION_KEY:'a'.repeat(64)};
const base='https://www.piknoai.com';
const png=Buffer.from('89504e470d0a1a0a0000000049484452','hex');
const video=Buffer.from('000000186674797069736f6d0000000069736f6d6d703432','hex');
const sign=claims=>{const value=Buffer.from(JSON.stringify(claims)).toString('base64url');return value+'.'+createHmac('sha256',ticketKey).update(value).digest('base64url');};
const request=(suffix,body,secret=bridge)=>new Request(base+'/media/v1/tools'+suffix,{method:body===undefined?'GET':'POST',headers:{authorization:'Bearer '+secret,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});

function store(){
  const values=new Map(),writes=[];
  let revision=0;
  const view=item=>item&&({...item,size:item.bytes.length,body:new Response(item.bytes).body,arrayBuffer:async()=>new Response(item.bytes).arrayBuffer(),json:async()=>JSON.parse(Buffer.from(item.bytes).toString()),text:async()=>Buffer.from(item.bytes).toString()});
  return {values,writes,
    async put(key,value,options={}){
      assert.match(key,/^(tool-config|tool-jobs|tool-polls)\//,'media bytes cannot enter R2');
      const current=values.get(key);
      if(options.onlyIf?.etagDoesNotMatch==='*'&&current||options.onlyIf?.etagMatches&&options.onlyIf.etagMatches!==current?.etag)return null;
      writes.push(key);
      const item={bytes:Buffer.from(value),etag:String(++revision),httpMetadata:options.httpMetadata,customMetadata:options.customMetadata};values.set(key,item);return view(item);
    },
    async get(key){assert.doesNotMatch(key,/^input\//);return view(values.get(key));},
    async head(key){assert.doesNotMatch(key,/^input\//);return view(values.get(key));},
    async delete(key){values.delete(key);},
  };
}

async function fixture({run,query,download}={}){
  const media=store(),calls={uploads:0,runs:0,queries:0,downloads:0,uploadBodies:[],credentials:[]};
  const runtime=await loadRuntime({fetchImpl:async(target,init)=>{
    const url=String(target);
    if(url.endsWith('/accountStatus'))return Response.json({code:0,data:{}});
    if(url.endsWith('/media/upload/binary')){
      calls.uploads++;
      const bytes=Buffer.from(await new Response(init.body).arrayBuffer());
      assert.equal(Number(init.headers.get('content-length')),bytes.length);
      assert.match(bytes.toString('latin1'),/name="file"; filename="reference\./);
      calls.uploadBodies.push(bytes);
      return Response.json({code:0,data:{fileName:'openapi/reference-'+calls.uploads+'.bin'}});
    }
    if(url.includes('/run/ai-app/')){calls.runs++;calls.credentials.push(init.headers.get('authorization'));return run?run():Response.json({taskId:'provider-original',status:'QUEUED'});}
    if(url.endsWith('/query')){calls.queries++;return query?query():Response.json({status:'SUCCESS',results:[{outputType:'video',url:'https://rh-comfyui01.tos-cn-beijing.volces.com/output.mp4'}]});}
    if(url==='https://rh-comfyui01.tos-cn-beijing.volces.com/output.mp4'){calls.downloads++;return download?download(init):new Response(video,{headers:{'content-length':String(video.length)}});}
    throw Error('external network blocked');
  }});
  const env={...bindings,MEDIA:media};
  const configured=await runtime.fetch(request('/config',{api_key:'K'.repeat(32),expected_version:''},admin),env);
  assert.equal(configured.status,200);
  const version=(await configured.json()).version;
  async function upload(bytes=video,mime='video/mp4',uid=7){
    const response=await runtime.fetch(new Request(base+'/media/v1/tools/uploads',{method:'POST',headers:{authorization:'Bearer '+bridge,'x-pikno-user':String(uid),'content-type':mime,'content-length':String(bytes.length)},body:bytes}),env);
    return response;
  }
  return {runtime,env,calls,media,version,upload};
}

test('direct upload and workflow use original bytes once and return output without media storage',async()=>{
  const f=await fixture();
  const uploaded=await f.upload();assert.equal(uploaded.status,200);
  const data=await uploaded.json(),url=new URL(data.url),[payload,signature]=url.searchParams.get('ticket').split('.');
  assert.equal(signature,createHmac('sha256',ticketKey).update(payload).digest('base64url'));
  const claim=JSON.parse(Buffer.from(payload,'base64url'));
  assert.equal(claim.aud,'pikno-tool-input');assert.equal(claim.uid,7);assert.equal(claim.size,video.length);assert.equal(claim.credential_version,f.version);assert.equal(claim.exp-claim.iat,7200);
  assert.ok(f.calls.uploadBodies[0].includes(video));
  const input={kind:'depth',request_id:'task_direct_original',videos:[{url:data.url}]};
  const submitted=await f.runtime.fetch(request('',input),f.env);assert.equal(submitted.status,200);assert.equal((await submitted.json()).status,'queued');
  assert.equal(f.calls.uploads,1);assert.equal(f.calls.runs,1);
  assert.equal((await f.runtime.fetch(request('',input),f.env)).status,200);assert.equal(f.calls.runs,1);
  const completed=await f.runtime.fetch(request('/task_direct_original'),f.env);assert.equal(completed.status,200);
  const result=await completed.json();assert.equal(result.status,'completed');assert.equal(result.outputs[0].url,'https://rh-comfyui01.tos-cn-beijing.volces.com/output.mp4');
  assert.equal(f.calls.downloads,0);
  const content=await f.runtime.fetch(request('/task_direct_original/content'),f.env);assert.equal(content.status,200);assert.deepEqual(Buffer.from(await content.arrayBuffer()),video);
  assert.equal(f.calls.downloads,1);
  assert.equal(f.media.writes.some(key=>key.startsWith('input/')),false);
});

test('direct references reject foreign owners, expiry, credential mixtures and unsafe names before run',async()=>{
  const f=await fixture(),now=Math.floor(Date.now()/1000);
  const claims={v:1,aud:'pikno-tool-input',uid:7,id:'a'.repeat(32),iat:now,exp:now+120,mime:'image/png',size:png.length,filename:'openapi/photo.png',credential_version:f.version};
  const ref=value=>({url:base+'/media/v1/tool-inputs/'+value.id+'?ticket='+sign(value)});
  const audio={...claims,id:'b'.repeat(32),mime:'audio/wav',filename:'openapi/voice.wav'};
  for(const altered of [{...audio,uid:8},{...audio,exp:now-1},{...audio,credential_version:'c'.repeat(32)},{...audio,filename:'../private'},{...audio,filename:'openapi//private'}]){
    const response=await f.runtime.fetch(request('',{kind:'digital',request_id:'task_rejected',images:[ref(claims)],audios:[{...ref(altered),durationSeconds:1}]}),f.env);
    assert.ok([403,409].includes(response.status));
  }
  assert.equal(f.calls.runs,0);assert.equal(f.calls.uploads,0);
});

test('invalid upload headers, signature, and authentication never create usable reference',async()=>{
  const f=await fixture();
  const bad=await f.upload(Buffer.alloc(24),'video/mp4');assert.equal(bad.status,415);
  const denied=await f.runtime.fetch(new Request(base+'/media/v1/tools/uploads',{method:'POST',headers:{authorization:'Bearer wrong','x-pikno-user':'7','content-type':'image/png','content-length':String(png.length)},body:png}),f.env);assert.equal(denied.status,401);
  const user=await f.upload(png,'image/png',0);assert.equal(user.status,400);
  const huge=await f.runtime.fetch(new Request(base+'/media/v1/tools/uploads',{method:'POST',headers:{authorization:'Bearer '+bridge,'x-pikno-user':'7','content-type':'image/png','content-length':String((30<<20)+1)},body:png}),f.env);assert.equal(huge.status,400);
  assert.equal(f.calls.uploads,0);
  assert.equal(f.calls.runs,0);
});

test('unknown dispatch stays unknown and duplicate requests never rerun the provider',async()=>{
  const f=await fixture({run(){throw Error('response lost');}});
  const uploaded=await f.upload(),data=await uploaded.json(),body={kind:'depth',request_id:'task_unknown_original',videos:[{url:data.url}]};
  assert.equal((await (await f.runtime.fetch(request('',body),f.env)).json()).status,'unknown');
  assert.equal((await (await f.runtime.fetch(request('',body),f.env)).json()).status,'unknown');
  assert.equal(f.calls.runs,1);
  assert.equal((await (await f.runtime.fetch(request('/task_unknown_original'),f.env)).json()).status,'unknown');
  assert.equal(f.calls.queries,0);
});

test('HTTP control accepts direct uploads over old 64KiB boundary with uid and stream length',async t=>{
  const f=await fixture(),control=createControlServer({runtime:f.runtime,env:f.env,media:f.media});
  await new Promise(resolve=>control.server.listen(0,'127.0.0.1',resolve));
  t.after(()=>control.close());
  const body=Buffer.alloc(128<<10);video.copy(body);
  const response=await fetch('http://127.0.0.1:'+control.server.address().port+'/media/v1/tools/uploads',{method:'POST',headers:{authorization:'Bearer '+bridge,'x-pikno-user':'7','content-type':'video/mp4','content-length':String(body.length)},body});
  assert.equal(response.status,200);assert.equal((await response.json()).expires_at>0,true);
  assert.ok(f.calls.uploadBodies[0].includes(body));
  assert.equal(f.calls.runs,0);
});

test('chunked result proxy preserves bytes without fabricating a zero content length',async t=>{
  const f=await fixture({download(){return new Response(new ReadableStream({start(controller){controller.enqueue(video.subarray(0,12));controller.enqueue(video.subarray(12));controller.close();}}));}});
  await f.media.put('tool-jobs/task_chunked',JSON.stringify({id:'task_chunked',uid:7,status:'completed',direct_media:true,output:{url:'https://rh-comfyui01.tos-cn-beijing.volces.com/output.mp4'}}));
  const control=createControlServer({runtime:f.runtime,env:f.env,media:f.media});
  await new Promise(resolve=>control.server.listen(0,'127.0.0.1',resolve));
  t.after(()=>control.close());
  const response=await fetch('http://127.0.0.1:'+control.server.address().port+'/media/v1/tools/task_chunked/content',{headers:{authorization:'Bearer '+bridge}});
  assert.equal(response.status,200);
  assert.equal(response.headers.get('content-length'),null);
  assert.equal(response.headers.get('transfer-encoding'),'chunked');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()),video);
});

test('result proxy interrupts oversized streams and mismatched declared lengths',async()=>{
  const chunk=new Uint8Array(1<<20);
  for(const [name,download] of [
    ['oversized',()=>{let sent=0;return new Response(new ReadableStream({pull(controller){if(sent++<51)controller.enqueue(chunk);else controller.close();}}));}],
    ['longer',()=>new Response(video,{headers:{'content-length':String(video.length-1)}})],
    ['shorter',()=>new Response(video,{headers:{'content-length':String(video.length+1)}})],
  ]){
    const f=await fixture({download});
    await f.media.put('tool-jobs/task_'+name,JSON.stringify({id:'task_'+name,uid:7,status:'completed',direct_media:true,output:{url:'https://rh-comfyui01.tos-cn-beijing.volces.com/output.mp4'}}));
    const response=await f.runtime.fetch(request('/task_'+name+'/content'),f.env);
    assert.equal(response.status,200);
    await assert.rejects(response.arrayBuffer(),/Tool result transfer interrupted/);
  }
});

test('result proxy validates partial range metadata and returns empty safe 416 responses',async()=>{
  for(const [status,range,contentRange,length,expected] of [
    [206,'bytes=0-3','bytes 0-3/24',null,206],
    [206,'bytes=0-3','bytes 1-4/24',null,502],
    [206,'bytes=0-3','bytes 0-3/24','3',502],
    [206,'bytes=0-3','bytes 0-3/*',null,502],
    [200,null,'bytes 0-3/24',null,502],
    [416,'bytes=99-','bytes */24',null,416],
    [416,'bytes=99-',null,null,502],
  ]){
    const f=await fixture({download(){return new Response(video.subarray(0,4),{status,headers:{...(contentRange?{'content-range':contentRange}:{}),...(length!==null?{'content-length':length}:{})}});}});
    await f.media.put('tool-jobs/task_range',JSON.stringify({id:'task_range',uid:7,status:'completed',direct_media:true,output:{url:'https://rh-comfyui01.tos-cn-beijing.volces.com/output.mp4'}}));
    const input=request('/task_range/content');if(range)input.headers.set('Range',range);
    const response=await f.runtime.fetch(input,f.env);assert.equal(response.status,expected);
    if(expected===206){assert.equal(response.headers.get('content-length'),null);assert.deepEqual(Buffer.from(await response.arrayBuffer()),video.subarray(0,4));}
    if(expected===416){assert.equal(response.headers.get('content-length'),'0');assert.equal((await response.arrayBuffer()).byteLength,0);}
  }
});
