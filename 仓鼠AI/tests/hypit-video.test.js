const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {createHypitVideoBridge}=require('../hypit-video.cjs');
function fixture(t){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hamster-hypit-video-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  let context={owner:'pikno:synthetic-a',revision:1},calls=[],tasks=[],hold,release,taskMode='queued',quoteSequence=0,onUpload=async()=>{};
  const line={id:'main-video-synthetic',name:'已发布客户视频',type:'video',provider:'generate',ratios:['16:9'],resolutions:['720p'],durations:[4,8],max_images:3,max_videos:1,max_audios:1,max_media_total:4,line_revision:7};
  const assets=new Map([['a'.repeat(32),{id:'a'.repeat(32),kind:'image',size:10}]]);
  const fetchImpl=async(url,options)=>{
    const route=new URL(url).pathname,body=options.body?JSON.parse(options.body):undefined;calls.push({route,body,headers:options.headers});
    if(route==='/api/canvas/models')return Response.json({data:[line,{...line,id:'tool-digital',provider:'tool'}],revision:context.revision});
    if(route==='/api/quotes')return Response.json({revision:context.revision,quote:{id:'synthetic-quote-'+(++quoteSequence),model:body.model,name:line.name,price_version:7,currency:'CNY',unit:'second',unit_price_cny:'1.00',units:4,reference_surcharge_cny:'0',per_item_cny:'4',quantity:1,total_cny:'4',expires_at:Math.floor(Date.now()/1000)+300}});
    if(route==='/api/videos'){
      if(hold)await hold;
      if(taskMode==='network')throw Error('private-provider sk-secret https://private.invalid');
      if(taskMode==='already_submitted')return Response.json({code:'quote_already_submitted',error:'synthetic prior request'},{status:409});
      tasks.push({walletUser:context.owner,requestId:options.headers['Idempotency-Key']+':0',key:'b'.repeat(32),status:taskMode,result:null});
      return Response.json({task:tasks.at(-1)},{status:202});
    }
    throw Error('unexpected mock route');
  };
  const options={dir,baseUrl:()=> 'http://127.0.0.1:9999',getExecutionContext:()=>({...context}),getAssets:()=>({get:id=>{if(!assets.has(id))throw Error('private path');return assets.get(id);},upload:async id=>{calls.push({route:'upload',id});await onUpload();return {...assets.get(id),url:'https://synthetic.invalid/read?ticket=private'};}}),taskStore:()=>({list:()=>tasks.filter(task=>task.walletUser===context.owner),handle:async(req,res,url)=>{res.writeHead(200,{'Content-Type':'video/mp4'});res.end('synthetic file');}}),fetchImpl};
  let bridge=createHypitVideoBridge(options);
  const input={projectId:'synthetic-project',operationId:'stable-shot-1',revision:1,model:line.id,prompt:'Synthetic scene',options:{ratio:'16:9',resolution:'720p',duration:4},assetIds:[]};
  const quoted=()=>bridge.quote(input),approve=op=>bridge.confirm({requestId:op.requestId,quoteId:op.quote.id,revision:context.revision,confirmed:true});
  return {dir,input,line,assets,calls,tasks,quoted,approve,get bridge(){return bridge;},restart:()=>bridge=createHypitVideoBridge(options),switch:()=>context={owner:'pikno:synthetic-b',revision:2},revision:()=>context.revision++,mode:mode=>taskMode=mode,onUpload:fn=>onUpload=fn,hold:()=>{hold=new Promise(resolve=>release=resolve);},release:()=>release()};
}
test('quote is readonly and unconfirmed operations cannot upload or submit',async t=>{
  const f=fixture(t),op=await f.quoted();assert.equal(op.status,'awaiting_confirmation');assert.equal(op.quote.total_cny,'4');
  await assert.rejects(f.bridge.start({requestId:op.requestId,revision:1}),e=>e.code==='confirmation_required');
  assert.equal(f.calls.filter(c=>c.route==='upload'||c.route==='/api/videos').length,0);
  assert.deepEqual((await f.bridge.catalog()).models.map(m=>m.id),[f.line.id]);
});
test('a confirmed operation uses original quote and stable journal identity once across Builds',async t=>{
  const f=fixture(t),op=await f.quoted();await f.approve(op);
  const started=await f.bridge.start({requestId:op.requestId,revision:1});assert.equal(started.status,'queued');
  await f.bridge.start({requestId:op.requestId,revision:1});await f.quoted();f.restart();await f.quoted();
  const posts=f.calls.filter(c=>c.route==='/api/videos');assert.equal(posts.length,1);
  assert.equal(posts[0].headers['Idempotency-Key'],op.requestId);assert.equal(posts[0].body.quote_id,op.quote.id);
  await assert.rejects(f.bridge.quote({...f.input,prompt:'changed content'}),e=>e.code==='operation_locked');
});
test('unknown without a task id stays durable and cannot be charged by a new Build',async t=>{
  const f=fixture(t),op=await f.quoted();await f.approve(op);f.mode('network');
  assert.equal((await f.bridge.start({requestId:op.requestId})).status,'unknown');f.restart();
  assert.equal((await f.quoted()).status,'unknown');await f.bridge.start({requestId:op.requestId});
  assert.equal(f.calls.filter(c=>c.route==='/api/videos').length,1);
  assert.doesNotMatch(JSON.stringify(f.bridge.list()),/private-provider|sk-secret|private\.invalid|ticket=/);
});
test('a submitted operation survives a removed catalogue line and deleted input material',async t=>{
  const f=fixture(t),input={...f.input,assetIds:['a'.repeat(32)]},op=await f.bridge.quote(input);await f.approve(op);
  await f.bridge.start({requestId:op.requestId});f.assets.clear();f.line.durations=[];
  const calls=f.calls.length;assert.equal((await f.bridge.quote(input)).status,'queued');
  assert.equal(f.calls.length,calls,'recovery does not depend on a new catalogue or quote');
  assert.equal(f.calls.filter(c=>c.route==='/api/videos').length,1);
});
test('parameter, material or line changes require a new quote and user confirmation',async t=>{
  const f=fixture(t),op=await f.bridge.quote({...f.input,assetIds:['a'.repeat(32)]});
  f.assets.get('a'.repeat(32)).size=11;
  await assert.rejects(f.approve(op),e=>e.code==='parameters_changed');
  const next=await f.bridge.quote({...f.input,assetIds:['a'.repeat(32)]});await f.approve(next);f.line.line_revision++;
  await assert.rejects(f.bridge.start({requestId:next.requestId}),e=>e.code==='parameters_changed');
  assert.equal(f.calls.filter(c=>c.route==='upload'||c.route==='/api/videos').length,0);
});
test('expired quotes and restarted confirmations never authorize a generation',async t=>{
  const f=fixture(t),op=await f.quoted();await f.approve(op);f.restart();
  assert.equal(f.bridge.poll(op.requestId).status,'awaiting_confirmation');
  await assert.rejects(f.bridge.start({requestId:op.requestId}),e=>e.code==='confirmation_required');
  const next=await f.quoted();const original=Date.now;Date.now=()=>original()+360000;t.after(()=>Date.now=original);
  await assert.rejects(f.approve(next),e=>e.code==='quote_invalid');Date.now=original;
  assert.equal(f.calls.filter(c=>c.route==='/api/videos').length,0);
});
test('a quote expiring during material upload returns to confirmation before any paid-capable submit',async t=>{
  const f=fixture(t),original=Date.now;let now=original();Date.now=()=>now;t.after(()=>Date.now=original);
  const op=await f.bridge.quote({...f.input,assetIds:['a'.repeat(32)]});await f.approve(op);
  f.onUpload(async()=>{now=op.quote.expires_at*1000;});
  await assert.rejects(f.bridge.start({requestId:op.requestId}),e=>e.code==='quote_invalid');
  assert.equal(f.calls.filter(c=>c.route==='upload').length,1);assert.equal(f.calls.filter(c=>c.route==='/api/videos').length,0);
  const current=f.bridge.poll(op.requestId);assert.equal(current.status,'awaiting_confirmation');assert.equal(current.code,'quote_invalid');
  await assert.rejects(f.bridge.start({requestId:op.requestId}),e=>e.code==='confirmation_required');
  assert.equal(f.calls.filter(c=>c.route==='/api/videos').length,0);Date.now=original;
});
test('an already-submitted quote response remains unknown and cannot be reopened for charging',async t=>{
  const f=fixture(t),op=await f.quoted();await f.approve(op);f.mode('already_submitted');
  assert.equal((await f.bridge.start({requestId:op.requestId})).status,'unknown');f.restart();
  assert.equal((await f.quoted()).status,'unknown');await f.bridge.start({requestId:op.requestId});
  assert.equal(f.calls.filter(c=>c.route==='/api/videos').length,1);
});
test('concurrent starts cannot make a duplicate paid-capable call',async t=>{
  const f=fixture(t),op=await f.quoted();await f.approve(op);f.hold();
  const first=f.bridge.start({requestId:op.requestId});
  while(!f.calls.some(c=>c.route==='/api/videos'))await new Promise(resolve=>setTimeout(resolve,1));
  assert.equal((await f.bridge.start({requestId:op.requestId})).status,'submitting');f.release();await first;
  assert.equal(f.calls.filter(c=>c.route==='/api/videos').length,1);
});
test('account changes isolate operation lists, confirmations and original task files',async t=>{
  const f=fixture(t),op=await f.quoted();await f.approve(op);f.switch();assert.deepEqual(f.bridge.list(),[]);
  assert.throws(()=>f.bridge.poll(op.requestId),e=>e.status===404);
  await assert.rejects(f.bridge.start({requestId:op.requestId}),e=>e.status===404);
  const next=await f.bridge.quote({...f.input,revision:2});assert.notEqual(next.requestId,op.requestId);
  assert.equal(f.calls.filter(c=>c.route==='/api/videos').length,0);
});
test('stored errors, unsupported roles, arbitrary remote refs and tool lines are not exposed or accepted',async t=>{
  const f=fixture(t);
  for(const patch of [{firstFrame:'https://private.invalid/image'},{options:{...f.input.options,generateAudio:true}},{assetIds:['https://private.invalid']},{model:'tool-digital'}])await assert.rejects(f.bridge.quote({...f.input,...patch}));
  assert.equal(f.calls.filter(c=>c.route==='/api/videos').length,0);
});
test('corrupt receipt blocks the same operation instead of silently recreating paid identity',async t=>{
  const f=fixture(t),op=await f.quoted();fs.writeFileSync(path.join(f.dir,op.requestId+'.json'),'invalid synthetic json');f.restart();
  await assert.rejects(f.quoted(),e=>e.code==='receipt_invalid');
  assert.equal(f.calls.filter(c=>c.route==='/api/videos').length,0);
});
test('success exposes only the account-owned saved task file and reuses the existing file handler',async t=>{
  const f=fixture(t),op=await f.quoted();await f.approve(op);await f.bridge.start({requestId:op.requestId});
  f.tasks[0].status='succeeded';f.tasks[0].result={local_url:'/api/tasks/'+f.tasks[0].key+'/file',download_url:'https://private.invalid?sig=secret'};
  const result=f.bridge.poll(op.requestId);assert.match(result.result.url,/^\/api\/hypit\/video\/operations\/hypit-[a-f0-9]{64}\/file$/);assert.doesNotMatch(JSON.stringify(result),/private.invalid|sig=secret/);
  let response='';await f.bridge.handle({method:'GET'}, {writeHead:()=>{},end:value=>response=value},new URL(result.result.url,'http://127.0.0.1:9999'),{projectId:f.input.projectId});assert.equal(response,'synthetic file');
});
test('provider callers cannot approve their own fee or cross into another project',async t=>{
  const f=fixture(t),op=await f.quoted();
  await assert.rejects(f.bridge.handle({method:'POST'}, {},new URL('/api/hypit/video/confirm','http://127.0.0.1:9999'),{isProvider:true,projectId:f.input.projectId}),e=>e.status===403);
  await assert.rejects(f.bridge.handle({method:'GET'}, {},new URL('/api/hypit/video/operations/'+op.requestId,'http://127.0.0.1:9999'),{isProvider:true,projectId:'other-project'}),e=>e.status===404);
});
test('real PIKNO bridge and durable createTasks journal retain the Hypit identity and account',async t=>{
  const http=require('node:http'),{createTasks}=require('../tasks.cjs'),{createPiknoBridge}=require('../pikno.cjs'),{listen}=require('./support/listen.cjs');
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hamster-hypit-journal-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const cfg={piknoUserId:77,piknoVideoKey:'sk-'+'v'.repeat(48)},line={id:'pikno-video-synthetic',kind:'video',name:'已发布客户视频',resolutions:['720p'],ratios:['16:9'],durations:[4],line_revision:7,max_images:0,max_videos:0,max_audio:0,max_media_total:20};
  const model={id:'main-video-synthetic',name:line.name,type:'video',provider:'generate',resolutions:line.resolutions,ratios:line.ratios,durations:line.durations,line_revision:7,max_images:0,max_videos:0,max_audios:0,max_media_total:20,concurrency_options:[1]};
  let posts=0,relay,journal=createTasks({dir:path.join(dir,'tasks'),resultDir:path.join(dir,'results'),relayMode:true,walletUser:()=> 'pikno:77',walletQuery:async()=>({status:'queued'})});
  const client={catalog:async()=>({data:[model],resolve:id=>id===model.id?line:undefined}),quote:async()=>({quote_id:'synthetic-signed-only-on-server',name:line.name,line_revision:7,currency:'CNY',unit:'second',unit_price_cny:'1',units:4,reference_surcharge_cny:'0',per_item_cny:'4',quantity:1,total_cny:'4',expires_at:Math.floor(Date.now()/1000)+300}),submit:async()=>{posts++;return {id:'synthetic_remote_task',status:'queued'};}};
  relay=createPiknoBridge({client,keyStore:{read:()=>cfg},taskStore:()=>journal});
  const server=http.createServer((req,res)=>relay.handle(req,res,new URL(req.url,'http://'+req.headers.host)).catch(error=>{res.writeHead(error.statusCode||500,{'Content-Type':'application/json'});res.end(JSON.stringify({error:'synthetic local failure',code:error.code}));}));
  await listen(server);t.after(async()=>{await new Promise(resolve=>server.close(resolve));journal.stop();});
  const options={dir:path.join(dir,'hypit'),getAssets:()=>({get(){throw Error('no references');}}),taskStore:()=>journal,baseUrl:()=> 'http://127.0.0.1:'+server.address().port,getExecutionContext:()=>relay.executionContext()};
  let bridge=createHypitVideoBridge(options),op=await bridge.quote({projectId:'real-journal-project',operationId:'shot-stable',model:model.id,prompt:'Synthetic scene',options:{ratio:'16:9',resolution:'720p',duration:4},assetIds:[]});
  await bridge.confirm({requestId:op.requestId,quoteId:op.quote.id,confirmed:true,revision:relay.executionContext().revision});
  op=await bridge.start({requestId:op.requestId});assert.equal(op.status,'queued');assert.equal(posts,1);
  const [task]=journal.list();assert.equal(task.requestId,op.requestId+':0');assert.equal(task.walletUser,'pikno:77');assert.equal(task.id,'synthetic_remote_task');
  journal=createTasks({dir:path.join(dir,'tasks'),resultDir:path.join(dir,'results'),relayMode:true,walletUser:()=> 'pikno:77',walletQuery:async()=>({status:'queued'})});
  bridge=createHypitVideoBridge(options);assert.equal(bridge.poll(op.requestId).status,'queued');await bridge.start({requestId:op.requestId});assert.equal(posts,1);
  assert.doesNotMatch(JSON.stringify(bridge.list()),/synthetic-signed|sk-v/);
});
