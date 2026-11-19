const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const {createApp} = require('../server');

const listen = server => new Promise(resolve => server.listen(0,'127.0.0.1',()=>resolve(`http://127.0.0.1:${server.address().port}`)));
const close = server => new Promise(resolve => {server.close(resolve);server.closeIdleConnections?.();});
const json = (res,status,data,headers={}) => {res.writeHead(status,{'Content-Type':'application/json',...headers});res.end(JSON.stringify(data));};
const post = (url,data) => fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
async function until(fn) {
  const end = Date.now()+5000;
  while(Date.now()<end) { const value=await fn(); if(value)return value; await new Promise(r=>setTimeout(r,15)); }
  throw new Error('Timed out waiting for task condition');
}
async function setup(t, handler, appOptions={}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(),'hamster-task-test-'));
  const configPath=path.join(root,'config.json'), taskDir=path.join(root,'journal'), resultDir=path.join(root,'results');
  fs.writeFileSync(configPath,JSON.stringify({apiKey:'fixture-secret',videoApiKey:'fixture-video-secret',rhApiKey:'fixture-tool-secret'}));
  const requests=[];
  let upstream;
  const mock = http.createServer(async(req,res)=>{
    const chunks=[];for await(const c of req)chunks.push(c);
    requests.push({method:req.method,url:req.url,auth:req.headers.authorization,body:Buffer.concat(chunks).toString()});
    try {await handler(req,res,upstream,requests);} catch(error){json(res,500,{error:error.message});}
  });
  upstream=await listen(mock);
  let app, base;
  const start=async()=>{
    const {taskOptions={},...options}=appOptions;
    app=createApp({upstream,officialVideoUpstream:upstream,dhUpstream:upstream+'/openapi/v2',configPath,taskDir,resultDir,...options,
      taskOptions:{interval:20,tickMs:10,...taskOptions}});
    base=await listen(app);return base;
  };
  await start();
  t.after(async()=>{await close(app);await close(mock);fs.rmSync(root,{recursive:true,force:true});});
  return {root,taskDir,resultDir,configPath,requests,get base(){return base;},
    list:async()=>(await (await fetch(base+'/api/tasks')).json()).tasks,
    restart:async()=>{await close(app);return start();},
    create:async(type='videos',extra={})=>{const r=await post(base+'/api/'+type,{model:type==='videos'?'sd_2_5_once_720p':'image_2_5_flare',prompt:'persistent fixture',...extra});assert.ok(r.ok);return r.json();}
  };
}

test('deletes one shared R2 input batch only after every concurrent task is terminal',async t=>{
  const deleted=[];
  const h=await setup(t,(req,res)=>{
    if(req.method==='POST')return json(res,201,{tasks:[{task_id:'lease-a'},{task_id:'lease-b'}]});
    json(res,200,{data:{status:'succeeded',results:[{text:'done'}]}});
  },{mediaDeleter:async keys=>{deleted.push(keys);return {deleted:keys.length};}});
  const key='tmp/2026/09/16/123e4567-e89b-12d3-a456-426614174000.jpg';
  const signedUrl=`https://media.hamsterai.cc/${key}?exp=1&sig=x`;
  await h.create('videos',{images:[{tag:'图片1',url:signedUrl}]});
  await until(async()=>deleted.length===1);
  assert.deepEqual(deleted,[[signedUrl]]);
  assert.ok((await h.list()).every(item=>item.mediaCleanedAt && !item.mediaUrls.length));
});

test('official backup task polls its own endpoint and saves the returned video',async t=>{
  const h=await setup(t,(req,res,up)=>{
    if(req.method==='POST' && req.url==='/v1/video/generations')return json(res,201,{id:'vf-a',status:'queued'});
    if(req.url==='/v1/video/generations/vf-a')return json(res,200,{data:{task_id:'vf-a',status:'SUCCESS',progress:'100%',result_url:up+'/media/vf-a'}});
    if(req.url==='/media/vf-a'){res.writeHead(200,{'Content-Type':'video/mp4'});return res.end('official-video');}
    json(res,404,{error:'unexpected'});
  });
  const response=await post(h.base+'/api/official-videos',{model:'official_backup_480p',prompt:'official test',resolution:'480p',ratio:'16:9',duration:4,reference:'all'});
  assert.ok(response.ok);
  const item=await until(async()=>{const [task]=await h.list();return task?.result?.local_url && task;});
  assert.equal(item.provider,'official');assert.equal(item.modelName,'官方备选线路-480P');assert.equal(item.status,'succeeded');
  assert.equal(h.requests.find(request=>request.url==='/v1/video/generations')?.auth,'Bearer fixture-video-secret');
  assert.equal(h.requests.find(request=>request.url==='/v1/video/generations/vf-a')?.auth,'Bearer fixture-video-secret');
  assert.equal(await (await fetch(h.base+item.result.local_url)).text(),'official-video');
});

test('records every returned ID before replying; restart at a new port resumes without duplicate generation',async t=>{
  let complete=false;
  const h=await setup(t,(req,res,up)=>{
    if(req.method==='POST')return json(res,201,{tasks:[{task_id:'a',status:'preparing'},{taskId:'b',status:'queued'}]});
    if(req.url.startsWith('/media/')){res.writeHead(200,{'Content-Type':'video/mp4'});return res.end('0123456789');}
    json(res,200,{data:{status:complete?'succeeded':'processing',video_url:up+'/media/'+req.url.split('/').pop(),progress:complete?100:23}});
  });
  await h.create();
  const files=fs.readdirSync(h.taskDir).filter(x=>x.endsWith('.json'));
  assert.equal(files.length,2);
  assert.deepEqual((await h.list()).map(x=>x.id).sort(),['a','b']);
  for(const file of files)assert.ok(!fs.readFileSync(path.join(h.taskDir,file),'utf8').includes('fixture-secret'));
  const firstPort=h.base;
  complete=true;await h.restart();assert.notEqual(h.base,firstPort);
  const tasks=await until(async()=>{const a=await h.list();return a.length===2 && a.every(x=>x.result?.local_url) && a;});
  assert.equal(h.requests.filter(r=>r.method==='POST').length,1);
  const preview=await fetch(h.base+tasks[0].result.local_url,{headers:{Range:'bytes=2-5'}});
  assert.equal(preview.status,206);assert.equal(preview.headers.get('content-range'),'bytes 2-5/10');assert.equal(await preview.text(),'2345');
  const suffix=await fetch(h.base+tasks[0].result.local_url,{headers:{Range:'bytes=-2'}});assert.equal(await suffix.text(),'89');
  assert.equal((await fetch(h.base+tasks[0].result.local_url,{headers:{Range:'bytes=99-'}})).status,416);
  const download=await fetch(h.base+tasks[0].result.local_url+'?download=1');assert.match(download.headers.get('content-disposition'),/attachment/);
  const before=h.requests.length;await h.restart();await new Promise(r=>setTimeout(r,60));
  assert.equal(h.requests.length,before,'saved tasks must not query upstream on every restart');
  assert.equal(fs.readdirSync(h.resultDir).length,2);
});

test('download failure retains succeeded state, refreshes signed links and retries saving once',async t=>{
  let polls=0;
  const h=await setup(t,(req,res,up)=>{
    if(req.method==='POST')return json(res,201,{task_id:'image-a'});
    if(req.url==='/expired')return json(res,403,{error:'expired'});
    if(req.url==='/fresh'){res.writeHead(200,{'Content-Type':'image/png'});return res.end('imagebytes');}
    polls++;json(res,200,{data:{status:'succeeded',image_url:up+(polls===1?'/expired':'/fresh'),link_expires_in:60}});
  });
  await h.create('images');
  const retry=await until(async()=>{const [x]=await h.list();return x?.result?.save_error && x;});
  assert.equal(retry.status,'succeeded');assert.ok(!retry.result.local_url);
  const saved=await until(async()=>{const [x]=await h.list();return x?.result?.local_url && x;});
  assert.ok(polls>=2);assert.equal(saved.result.save_error,'');
  assert.equal(fs.readdirSync(h.resultDir).filter(x=>x.endsWith('.part')).length,0);
  assert.equal(await (await fetch(h.base+saved.result.local_url)).text(),'imagebytes');
  // External deletion is recoverable through the original ID.
  fs.unlinkSync(saved.result.local_path);
  await until(async()=>{const [x]=await h.list();return x?.result?.local_url;});
  assert.equal(h.requests.filter(r=>r.method==='POST').length,1);
});

test('query errors and rate limits do not turn generation into failed; manual resume queries only',async t=>{
  let code=429;
  const h=await setup(t,(req,res)=>{
    if(req.method==='POST')return json(res,201,{id:'retry-task'});
    if(code)return json(res,code,{},code===429?{'Retry-After':'2'}:{});
    json(res,200,{data:{status:'failed',error:'上游明确生成失败'}});
  });
  await h.create();
  let item=await until(async()=>{const [x]=await h.list();return x?.poll_error && x;});
  assert.notEqual(item.status,'failed');assert.ok(item.nextPollAt-Date.now()>1500);
  code=401;
  await post(h.base+`/api/tasks/${item.key}/retry`,{});
  item=await until(async()=>{const [x]=await h.list();return /鉴权/.test(x?.poll_error) && x;});
  assert.notEqual(item.status,'failed');
  code=0;await post(h.base+`/api/tasks/${item.key}/retry`,{});
  await until(async()=>{const [x]=await h.list();return x?.status==='failed';});
  assert.equal(h.requests.filter(r=>r.method==='POST').length,1);
  const count=h.requests.length;await new Promise(r=>setTimeout(r,70));assert.equal(h.requests.length,count);
});

test('tool tasks persist and use their own query API and key after restart',async t=>{
  const h=await setup(t,(req,res,up)=>{
    if(req.url.includes('/run/'))return json(res,200,{taskId:'tool-1',status:'RUNNING'});
    if(req.url==='/openapi/v2/query') {
      assert.equal(req.headers.authorization,'Bearer fixture-tool-secret');
      return json(res,200,{status:'SUCCESS',results:[{url:up+'/tool.mp4',outputType:'mp4'}]});
    }
    res.writeHead(200,{'Content-Type':'video/mp4'});res.end('toolbytes');
  });
  const response=await post(h.base+'/rh/run/ai-app/2089021172049596418',{nodeInfoList:[]});assert.equal(response.status,200);
  await h.restart();
  const done=await until(async()=>{const [x]=await h.list();return x?.result?.local_url && x;});
  assert.equal(done.source,'depth');
  assert.ok(h.requests.some(r=>r.url==='/openapi/v2/query' && JSON.parse(r.body).taskId==='tool-1'));
  assert.ok(!h.requests.some(r=>r.url.startsWith('/openapi/v1/videos/')));
});

test('changing key does not silently query an old task with the new account',async t=>{
  const h=await setup(t,(req,res)=>json(res,200,req.method==='POST'?{task_id:'old-account'}:{data:{status:'processing'}}));
  await h.create();fs.writeFileSync(h.configPath,JSON.stringify({apiKey:'different-account'}));
  await h.restart();
  const [item]=await h.list();await post(h.base+`/api/tasks/${item.key}/retry`,{});
  const waiting=await until(async()=>{const [x]=await h.list();return x?.poll_error && x;});
  assert.notEqual(waiting.status,'failed');
  // A request already sent before shutdown may arrive late; validate its actual
  // credentials instead of using timing-sensitive total request counts.
  assert.ok(h.requests.filter(r=>r.method==='GET').every(r=>r.auth==='Bearer fixture-secret'));
});

test('legacy migration is idempotent, local paths are constrained, clearing preserves active tasks and output files',async t=>{
  const h=await setup(t,(req,res)=>json(res,200,{data:{status:'processing'}}));
  fs.mkdirSync(h.resultDir);const file=path.join(h.resultDir,'old.png');fs.writeFileSync(file,'saved-image');
  const records=[{id:'saved',type:'image',status:'succeeded',result:{local_path:file,image_url:'https://expired.invalid/old.png'}},
    {id:'active',type:'video',status:'processing'},
    {id:'outside',type:'image',status:'failed',result:{local_path:h.configPath}}];
  for(let n=0;n<2;n++)assert.equal((await post(h.base+'/api/tasks/import',{tasks:records})).status,200);
  const items=await h.list();assert.equal(items.length,3);
  assert.ok(items.find(x=>x.id==='saved').result.local_url);
  assert.ok(!items.find(x=>x.id==='outside').result.local_url);
  const outside=items.find(x=>x.id==='outside');assert.equal((await fetch(h.base+`/api/tasks/${outside.key}/file`)).status,404);
  await fetch(h.base+'/api/tasks',{method:'DELETE'});
  assert.deepEqual((await h.list()).map(x=>x.id),['active']);assert.ok(fs.existsSync(file));
});

test('clearing failed tasks preserves successful and active records and output files',async t=>{
  const h=await setup(t,(req,res)=>json(res,200,{data:{status:'processing'}}));
  fs.mkdirSync(h.resultDir);const file=path.join(h.resultDir,'saved.png');fs.writeFileSync(file,'saved-image');
  const records=[{id:'saved',type:'image',status:'succeeded',result:{local_path:file}},
    {id:'active',type:'video',status:'processing'},
    {id:'failed-image',type:'image',status:'failed'},
    {id:'failed-video',type:'video',status:'failed'}];
  await post(h.base+'/api/tasks/import',{tasks:records});
  const invalid=await fetch(h.base+'/api/tasks?status=succeeded',{method:'DELETE'});
  assert.equal(invalid.status,400);assert.equal((await h.list()).length,4);
  const empty=await fetch(h.base+'/api/tasks?status=',{method:'DELETE'});
  assert.equal(empty.status,400);assert.equal((await h.list()).length,4);
  const cleared=await fetch(h.base+'/api/tasks?status=failed',{method:'DELETE'});
  assert.equal(cleared.status,200);
  assert.deepEqual((await h.list()).map(x=>x.id).sort(),['active','saved']);
  assert.ok(fs.existsSync(file));
});

test('uncertain submission stays visible across restarts and is never automatically resubmitted',async t=>{
  const h=await setup(t,(req,res)=>json(res,502,{error:'gateway timeout'}));
  const r=await post(h.base+'/api/videos',{model:'sd_2_5_once_720p',prompt:'uncertain'});assert.equal(r.status,502);
  const [unknown]=await h.list();assert.equal(unknown.status,'unknown');assert.equal(unknown.id,'');
  await h.restart();await new Promise(r=>setTimeout(r,60));
  assert.equal((await h.list())[0].status,'unknown');assert.equal(h.requests.length,1);
});

test('browser disconnect during submission still captures the returned upstream task ID',async t=>{
  let release, started;
  const began=new Promise(r=>started=r), gate=new Promise(r=>release=r);
  const h=await setup(t,async(req,res)=>{
    if(req.method==='POST'){started();await gate;return json(res,201,{task_id:'disconnected-client'});}
    json(res,200,{data:{status:'processing'}});
  });
  const controller=new AbortController();
  const request=fetch(h.base+'/api/videos',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({model:'sd_2_5_once_720p',prompt:'close browser'}),signal:controller.signal}).catch(()=>null);
  await began;controller.abort();release();await request;
  const item=await until(async()=>{const a=await h.list();return a.find(x=>x.id==='disconnected-client');});
  assert.ok(item.key);assert.equal(h.requests.filter(r=>r.method==='POST').length,1);
});

test('respond-async persists and returns a local task before slow upstream submission finishes',async t=>{
  let release;
  const gate=new Promise(resolve=>{release=resolve;});
  const h=await setup(t,async(req,res)=>{
    if(req.method==='POST'){
      const id='async-'+req.headers['idempotency-key'].replace('request-','');
      await gate;
      return json(res,201,{task_id:id});
    }
    json(res,200,{data:{status:'processing'}});
  });
  const submit=prompt=>fetch(h.base+'/api/videos',{
    method:'POST',
    headers:{'Content-Type':'application/json','Prefer':'respond-async','Idempotency-Key':'request-'+prompt},
    body:JSON.stringify({model:'sd_2_5_once_720p',prompt}),
  });
  const started=Date.now();
  const first=await Promise.race([submit('one'),new Promise((_,reject)=>setTimeout(()=>reject(new Error('local acceptance timed out')),500))]);
  assert.equal(first.status,202);
  const accepted=await first.json();
  assert.equal(accepted.accepted,true);
  assert.equal(accepted.task.status,'submitting');
  assert.ok(Date.now()-started<500);
  assert.equal((await h.list())[0].key,accepted.task.key);
  const second=await submit('two');
  assert.equal(second.status,202,'a slow upstream submission must not lock the next task');
  assert.equal((await h.list()).length,2);
  release();
  const captured=await until(async()=>{const items=await h.list();return items.length===2&&items.every(item=>item.id)&&items;});
  assert.deepEqual(captured.map(item=>item.id).sort(),['async-one','async-two']);
});
