// Real desktop HTTP routes + private PIKNO transport + durable result journal.
// The relay is isolated and every credential, material and output is synthetic.
const {test}=require('node:test'),assert=require('node:assert/strict');
const http=require('node:http'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createApp}=require('../server.js');
const {createPiknoClient}=require('../pikno-client.cjs');
const {createPiknoKeyStore}=require('../pikno-key-store.cjs');
const {syntheticQuote,withQuotedApi}=require('./support/relay-quote.cjs');
const imageKey='sk-'+'a'.repeat(48),videoKey='sk-'+'b'.repeat(48),toolKey='sk-'+'c'.repeat(48);
const digital={id:'pikno-tool-digital',kind:'video',resolutions:[],ratios:[],durations:[],max_images:1,max_videos:0,max_audio:1};
const depth={...digital,id:'pikno-tool-depth',max_images:0,max_videos:1,max_audio:0};
const listen=server=>new Promise(resolve=>server.listen(0,'127.0.0.1',()=>resolve('http://127.0.0.1:'+server.address().port)));
const close=server=>new Promise(resolve=>{server.close(resolve);server.closeIdleConnections?.();});
const json=(res,value,status=200)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(value));};
async function until(condition){const end=Date.now()+5000;while(Date.now()<end){const value=await condition();if(value)return value;await new Promise(resolve=>setTimeout(resolve,15));}throw Error('isolated tool lifecycle timed out');}
async function fixture(t,{initial='queued',queryStatuses=['in_progress','completed'],artifactFailure=false}={}){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hamster-tools-contract-')),keyStore=createPiknoKeyStore(),calls=[],jobs=new Map();
  let relayUrl,assetNumber=0,artifactCalls=0;
  const relay=http.createServer(async(req,res)=>{
    const chunks=[];for await(const chunk of req)chunks.push(chunk);
    const bytes=Buffer.concat(chunks),body=bytes.length&&String(req.headers['content-type']).startsWith('application/json')?JSON.parse(bytes):null;
    calls.push({method:req.method,url:req.url,auth:req.headers.authorization,body});
    if(req.url==='/v1/client/context')return json(res,{user_id:7,group:req.headers.authorization==='Bearer '+imageKey?'image-standard':req.headers.authorization==='Bearer '+toolKey?'tool-standard':'video-standard'});
    if(req.url==='/api/pikno/catalog')return json(res,{data:{models:[digital,depth]}});
    if(req.url==='/v1/models')return json(res,{data:req.headers.authorization==='Bearer '+toolKey?[{id:digital.id},{id:depth.id}]:[]});
    if(req.url==='/v1/client/quote')return json(res,{data:syntheticQuote(body)});
    if(req.url==='/v1/media/direct-uploads'){
      const id=(++assetNumber).toString(16).padStart(32,'0'),expires_at=Math.floor(Date.now()/1000)+600;
      const claims={v:1,aud:'pikno-tool-input',uid:7,id,mime:req.headers['content-type'],size:bytes.length,exp:expires_at};
      const ticket=Buffer.from(JSON.stringify(claims)).toString('base64url')+'.synthetic';
      return json(res,{url:relayUrl+'/media/v1/tool-inputs/'+id+'?ticket='+ticket,expires_at},201);
    }
    if(req.url==='/v1/media/uploads'){
      const id=(++assetNumber).toString(16).padStart(32,'0'),expires_at=Math.floor(Date.now()/1000)+600;
      return json(res,{id,method:'PUT',upload_url:relayUrl+'/media/v1/assets/'+id,upload_ticket:'put-'+id,headers:{Authorization:'Bearer put-'+id,'Content-Type':body.content_type},expires_at});
    }
    if(req.method==='PUT'&&req.url.startsWith('/media/v1/assets/'))return res.writeHead(204).end();
    if(req.url==='/v1/media/complete'){
      const id=body.upload_ticket.slice(4);return json(res,{id,status:'ready',url:relayUrl+'/media/v1/assets/'+id+'?ticket=read-only',expires_at:Math.floor(Date.now()/1000)+600});
    }
    if(req.method==='POST'&&req.url.startsWith('/v1/tools/')){
      const kind=req.url.split('/').pop(),id='task_'+kind;jobs.set(id,{polls:0,kind});return json(res,{id,status:initial},202);
    }
    if(req.method==='GET'&&req.url.startsWith('/v1/videos/')){
      const id=req.url.split('/').pop(),job=jobs.get(id),status=queryStatuses[Math.min(job.polls++,queryStatuses.length-1)];
      return json(res,{id,status,error:status==='failed'?'runninghub private token sk-do-not-expose':undefined,outputs:status==='completed'?[{type:'video',url:'https://rh-comfyui01.tos-cn-beijing.volces.com/v1/tasks/'+id+'/artifacts/video/content?access=opaque-read'}]:[]});
    }
    if(req.url.includes('/artifacts/video/content?access=opaque-read')){
      artifactCalls++;if(artifactFailure&&artifactCalls===1)return json(res,{error:'expired'},403);
      res.writeHead(200,{'Content-Type':'video/mp4'});return res.end(Buffer.from('00000018667479706d703432000000006d70343269736f6d','hex'));
    }
    return json(res,{error:'unexpected mock route'},404);
  });
  relayUrl=await listen(relay);
  const client=createPiknoClient({endpoint:relayUrl});
  let app,base;
  const start=async()=>{
    app=createApp({relayMode:true,relayClient:client,relayKeyStore:keyStore,mediaMetadataReader:async()=>({durationSeconds:30}),configPath:path.join(dir,'config.json'),resultDir:path.join(dir,'results'),taskDir:path.join(dir,'tasks'),assetDir:path.join(dir,'assets'),smartVideoLauncher:{stop(){}},taskOptions:{tickMs:10,interval:25,fetchImpl:(target,options)=>{const url=new URL(target);assert.equal(url.origin,'https://rh-comfyui01.tos-cn-beijing.volces.com');assert.equal(options.redirect,'manual');return fetch(relayUrl+url.pathname+url.search,options);}}});
    base=await listen(app);
  };
  await start();
  t.after(async()=>{await close(app);await close(relay);fs.rmSync(dir,{recursive:true,force:true});});
  const raw=(route,body,headers={})=>fetch(base+route,{method:body?'POST':'GET',headers:{'Content-Type':'application/json',...headers},...(body?{body:JSON.stringify(body)}:{})});
  const request=withQuotedApi(raw);
  assert.equal((await request('/api/config',{piknoImageKey:imageKey,piknoVideoKey:videoKey,piknoToolKey:toolKey})).status,200);
  const upload=async(mime)=>{
    const response=await fetch(base+'/api/uploads/raw?use=tool',{method:'POST',headers:{'Content-Type':mime},body:Buffer.alloc(16)});assert.equal(response.status,201);return (await response.json()).file.url;
  };
  return {dir,calls,jobs,request,upload,list:async()=>(await(await request('/api/tasks')).json()).tasks,restart:async()=>{await close(app);await start();},get base(){return base;},get artifactCalls(){return artifactCalls;}};
}

for(const kind of ['digital','depth'])test(`${kind}: exact tool request, tool-scoped upload, result artifact, local playback and restart match PIKNO`,async t=>{
  const f=await fixture(t,{artifactFailure:true});
  const payload=kind==='digital'?{model:'tool-digital',images:[{url:await f.upload('image/png')}],audios:[{url:await f.upload('audio/wav'),durationSeconds:30}],concurrency:1}:{model:'tool-depth',videos:[{url:await f.upload('video/mp4')}],concurrency:1};
  const header={'Idempotency-Key':'contract-'+kind};
  const response=await f.request('/api/tools/'+kind,payload,header);assert.equal(response.status,202);
  const task=(await response.json()).task;assert.equal(task.id,'task_'+kind);assert.equal(task.source,kind);assert.equal(task.type,'video');
  await f.request('/api/tools/'+kind,payload,header);
  const complete=await until(async()=>{const [item]=await f.list();return item?.result?.local_url&&item;});
  assert.equal(complete.status,'succeeded');assert.equal(complete.source,kind);assert.doesNotMatch(JSON.stringify(complete),/estimatedCost|chargedCost|billingStatus|read-only|opaque-read|runninghub|sk-/);
  assert.equal(Buffer.from(await(await fetch(f.base+complete.result.local_url)).arrayBuffer()).toString('hex'),'00000018667479706d703432000000006d70343269736f6d');
  const submit=f.calls.filter(call=>call.method==='POST'&&call.url==='/v1/tools/'+kind);assert.equal(submit.length,1);assert.equal(submit[0].auth,'Bearer '+toolKey);
  assert.deepEqual(Object.keys(submit[0].body).sort(),['audios','images','model','videos']);assert.equal(submit[0].body.model,'pikno-tool-'+kind);
  for(const call of f.calls.filter(call=>['/v1/media/direct-uploads'].includes(call.url)))assert.equal(call.auth,'Bearer '+toolKey);
  for(const call of f.calls.filter(call=>call.url.includes('/artifacts/')))assert.equal(call.auth,undefined);
  const before=f.calls.length;await f.restart();await new Promise(resolve=>setTimeout(resolve,60));
  assert.equal(f.calls.length,before);assert.equal((await f.list())[0].result.local_url,complete.result.local_url);
});

test('tool UNKNOWN with a confirmed ID keeps querying that ID and never resubmits',async t=>{
  const f=await fixture(t,{initial:'unknown',queryStatuses:['unknown','completed']});
  const payload={model:'tool-depth',videos:[{url:await f.upload('video/mp4')}],concurrency:1};
  const response=await f.request('/api/tools/depth',payload,{'Idempotency-Key':'contract-unknown'});
  const pending=(await response.json()).task;assert.equal(pending.status,'unknown');assert.equal(pending.id,'task_depth');assert.match(pending.poll_error,/原任务|勿重复提交/);
  const complete=await until(async()=>{const [item]=await f.list();return item?.result?.local_url&&item;});assert.equal(complete.status,'succeeded');
  assert.equal(f.calls.filter(call=>call.method==='POST'&&call.url==='/v1/tools/depth').length,1);
  assert.ok(f.calls.filter(call=>call.method==='GET'&&call.url==='/v1/videos/task_depth').length>=2);
});

test('tool confirmed failure is not downloaded, does not resubmit and is safe for the customer',async t=>{
  const f=await fixture(t,{queryStatuses:['failed']});
  await f.request('/api/tools/depth',{model:'tool-depth',videos:[{url:await f.upload('video/mp4')}],concurrency:1},{'Idempotency-Key':'contract-failed'});
  const failed=await until(async()=>{const [item]=await f.list();return item?.status==='failed'&&item;});
  assert.match(failed.error,/PIKNO/);assert.doesNotMatch(JSON.stringify(failed),/runninghub|sk-|private|estimatedCost|chargedCost/);assert.equal(f.artifactCalls,0);
  assert.equal(f.calls.filter(call=>call.method==='POST'&&call.url==='/v1/tools/depth').length,1);
});
