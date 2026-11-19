const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const http=require('node:http');
const crypto=require('node:crypto');
const {createCanvas,directorDocument,validateDocument}=require('../canvas.cjs');
const {createAssets}=require('../assets.cjs');
const {createCanvasLauncher}=require('../canvas-launcher.cjs');
const {createPiknoClient}=require('../pikno-client.cjs');
const png=Buffer.from('89504e470d0a1a0a0000000d49484452','hex');
const wav=Buffer.from('524946462400000057415645','hex');
const video=Buffer.from('000000186674797069736f6d00000000','hex');
const node=(id,type,data)=>({id,type,position:{x:0,y:0},data:type==='generation'?{...data,options:{...(data.channel==='image'?{aspect_ratio:'1:1',size:'1024x1024',quality:'medium'}:{ratio:'16:9',resolution:'720p',duration:5}),...data.options}}:data});
async function fixture(t,overrides={}){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hamster-canvas-'));
  const calls=[],uploads=[],records=[];let responseError=false,slow,uploadError=false,quoteExpires;
  fs.mkdirSync(path.join(dir,'results'));
  const assets=createAssets(path.join(dir,'assets'),path.join(dir,'results'),async(stream,meta)=>{for await(const _ of stream){}if(uploadError)throw Error('R2 offline');uploads.push(meta);return {url:'https://r2.test/result/'+uploads.length+'.mp4'};});
  const img=assets.add('scene','person.png',png,'png');const audio=assets.add('scene','voice.wav',wav,'wav',{durationSeconds:12});const vid=assets.add('scene','source.mp4',video,'mp4',{durationSeconds:5});
  const fakeFetch=async(url,opts={})=>{
    calls.push({url:String(url),opts});if(slow)await slow;
    if(String(url).includes('/models'))return Response.json({data:[{id:'image-model',type:'image',max_images:1,aspect_ratios:['1:1'],size_options:['1024x1024','2048x2048'],quality_options:['medium','high']},{id:'video-model',type:'video',max_images:9,max_videos:3,max_audios:3,ratios:['16:9'],resolutions:['720p'],durations:[4,5]},{id:'tool-digital',type:'video',provider:'tool',max_images:1,max_audios:1},{id:'tool-depth',type:'video',provider:'tool',max_videos:1}]});
    if(String(url).endsWith('/api/quotes')){const body=JSON.parse(opts.body);return Response.json({revision:overrides.getExecutionContext?.().revision??0,quote:{id:crypto.randomUUID(),model:body.model,name:'已发布客户线路',price_version:8,currency:'CNY',unit:body.model==='image-model'?'image':body.model.startsWith('tool-')?'request':'second',unit_price_cny:'0.10',units:body.duration||1,reference_surcharge_cny:'0.02',per_item_cny:'0.12',quantity:1,total_cny:'0.12',expires_at:quoteExpires??Math.floor(Date.now()/1000)+120}});}
    if(String(url).startsWith('https://r2.test'))return new Response(video,{headers:{'content-type':'video/mp4'}});
    if(String(url).endsWith('/media/upload/binary'))return Response.json({code:0,data:{fileName:'rh-file-'+calls.length}});
    if(responseError)throw Error('connection reset');
    const task={key:crypto.randomBytes(16).toString('hex'),requestId:opts.headers['Idempotency-Key']+(String(url).includes('/rh/')?'':':0'),status:'queued'};records.push(task);
    return Response.json({accepted:true,task});
  };
  const options={dir:path.join(dir,'canvas'),getAssets:()=>assets,taskStore:()=>({list:()=>records}),baseUrl:()=> 'http://127.0.0.1:4444',dhUpstream:'https://rh.test',getRhKey:()=> 'rh-secret',fetchImpl:fakeFetch,...overrides};
  const canvas=createCanvas(options);
  const server=http.createServer((req,res)=>{if(req.url==='/api/uploads/status'||req.url==='/api/relay/state'||req.url==='/api/relay/connection'){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({connected:true,relayMode:true,revision:1}));return;}canvas.handle(req,res,new URL(req.url,'http://local')).catch(e=>{res.writeHead(e.status||500,{'content-type':'application/json'});res.end(JSON.stringify({error:e.message}));});});
  await require('./support/listen.cjs').listen(server);const base='http://127.0.0.1:'+server.address().port;
  t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));fs.rmSync(dir,{recursive:true,force:true});});
  return {dir,canvas,options,assets,img,audio,vid,calls,uploads,records,base,setError:()=>responseError=true,setUploadError:value=>uploadError=value,setSlow:p=>slow=p,setQuoteExpires:value=>quoteExpires=value,
    request:(route,data,method='POST')=>fetch(base+'/api/canvas'+route,{method,headers:{'content-type':'application/json'},body:data===undefined?undefined:JSON.stringify(data)})};
}
test('wallet tools cannot read legacy credentials or upload to a direct provider',async t=>{
  const f=await fixture(t);let reads=0;
  const canvas=createCanvas({...f.options,walletMode:true,getRhKey:()=>{reads++;return 'legacy';}});
  const doc=canvas.create({nodes:[node('tool','generation',{channel:'depth',model:'tool',prompt:''})],edges:[]});
  await assert.rejects(()=>canvas.execute(doc.id,'tool',crypto.randomUUID()),/需要一个视频/);
  assert.equal(reads,0);assert.equal(f.calls.length,0);assert.equal(f.uploads.length,0);
});

test('PIKNO mode keeps backup canvas nodes and routes them through the same relay task API',async t=>{
 const f=await fixture(t),canvas=createCanvas({...f.options,walletMode:true,relayMode:true,getRhKey:()=>assert.fail('no legacy credential')});
 const doc=canvas.create({nodes:[node('run','generation',{channel:'backup',model:'video-model',prompt:'A cup',options:{duration:4,reference:'all'}})],edges:[]});
 const id=crypto.randomUUID();await canvas.execute(doc.id,'run',id);await canvas.execute(doc.id,'run',id);
 assert.equal(f.calls.filter(call=>call.url.endsWith('/api/videos')).length,1);
 assert.equal(f.calls.some(call=>call.url.includes('/api/official-videos')||call.url.startsWith('https://rh.test')),false);
});

for(const size of ['1024x1024','2048x2048'])test('PIKNO canvas preserves and submits exact image size '+size,async t=>{
 const f=await fixture(t),canvas=createCanvas({...f.options,walletMode:true,relayMode:true,getRhKey:()=>assert.fail('no legacy credential')});
 const doc=canvas.create({nodes:[node('input','asset',{assetId:f.img.id}),node('run','generation',{channel:'image',model:'image-model',prompt:'A cup',options:{aspect_ratio:'1:1',size,quality:'medium',apiKey:'must-not-store'}})],edges:[{source:'input',target:'run'}]});
 const restored=createCanvas({...f.options,walletMode:true,relayMode:true});
 assert.equal(restored.load(doc.id).nodes[1].data.options.size,size);
 assert.doesNotMatch(JSON.stringify(restored.load(doc.id)),/must-not-store/);
 const edited={...restored.load(doc.id),title:'Exact output size'};
 assert.equal((await f.request('/projects/'+doc.id,edited,'PUT')).status,200);
 await restored.execute(doc.id,'run',crypto.randomUUID());
 const sent=f.calls.find(call=>call.url.endsWith('/api/images')),body=JSON.parse(sent.opts.body);
 assert.equal(body.size,size);assert.equal(body.aspect_ratio,'1:1');assert.equal(body.quality,'medium');
 assert.equal(body.images.length,1);assert.equal(body.images[0].url,'https://r2.test/result/1.mp4');
 assert.equal(f.calls.some(call=>call.url.startsWith('https://rh.test')),false);
});

for(const channel of ['digital','depth'])test('wallet '+channel+' uses cloud tools without reading any legacy key',async t=>{
 const f=await fixture(t),canvas=createCanvas({...f.options,walletMode:true,getRhKey:()=>{throw Error('must not read local key');}});
 const inputs=channel==='digital'?[f.img,f.audio]:[f.vid],nodes=[...inputs.map(a=>node(a.id,'asset',{assetId:a.id})),node('run','generation',{channel,prompt:''})];
 const doc=canvas.create({nodes,edges:inputs.map(a=>({source:a.id,target:'run'}))}),id=crypto.randomUUID();
 await canvas.execute(doc.id,'run',id);await canvas.execute(doc.id,'run',id);
 assert.equal(f.calls.length,1);assert.equal(f.calls[0].url,'http://127.0.0.1:4444/api/tools/'+channel);
 const payload=JSON.parse(f.calls[0].opts.body);assert.equal(payload.model,'tool-'+channel);assert.equal(f.uploads.length,inputs.length);
 assert.doesNotMatch(JSON.stringify(payload),/nodeInfoList|208789|208902|rh-secret/);
 if(channel==='digital')assert.equal(payload.audios[0].durationSeconds,12);
});

test('PIKNO canvas digital image upload uses the tool Key when the image Key is revoked',async t=>{
 const f=await fixture(t),calls=[],cfg={piknoImageKey:'revoked-image-test',piknoVideoKey:'valid-video-test',piknoToolKey:'valid-tool-test'},id='a'.repeat(32),url='https://www.piknoai.com/media/v1/assets/'+id,expires=Math.floor(Date.now()/1000)+600;
 const client=createPiknoClient({fetchImpl:async(target,init)=>{
  const auth=new Headers(init.headers).get('authorization');calls.push({target:String(target),method:init.method,auth});
  if(auth==='Bearer '+cfg.piknoImageKey)return new Response('revoked',{status:401});
  if(String(target).endsWith('/v1/media/uploads')){
    assert.equal(auth,'Bearer '+cfg.piknoToolKey);
   const mime=JSON.parse(init.body).content_type;
   return Response.json({id,method:'PUT',upload_url:url,upload_ticket:'upload-only',headers:{Authorization:'Bearer upload-only','Content-Type':mime},expires_at:expires});
  }
  if(init.method==='PUT'){assert.equal(auth,'Bearer upload-only');for await(const _ of init.body){}return new Response(null,{status:204});}
  assert.equal(auth,'Bearer '+cfg.piknoToolKey);return Response.json({id,status:'ready',url:url+'?ticket=read-only',expires_at:expires});
 }});
 const assets=createAssets(path.join(f.dir,'keyed-assets'),path.join(f.dir,'results'),(data,metadata)=>client.upload(cfg,data,metadata));
 const img=assets.add('scene','person.png',png,'png'),audio=assets.add('scene','voice.wav',wav,'wav',{durationSeconds:12});
 const canvas=createCanvas({...f.options,getAssets:()=>assets,walletMode:true,relayMode:true,getRhKey:()=>assert.fail('must not read legacy key')});
 const inputs=[img,audio],doc=canvas.create({nodes:[...inputs.map(a=>node(a.id,'asset',{assetId:a.id})),node('run','generation',{channel:'digital',prompt:''})],edges:inputs.map(a=>({source:a.id,target:'run'}))});
 await canvas.execute(doc.id,'run',crypto.randomUUID());
 assert.equal(calls.length,6);assert.ok(calls.filter(call=>call.method!=='PUT').every(call=>call.auth==='Bearer '+cfg.piknoToolKey));
 assert.equal(f.calls.at(-1).url,'http://127.0.0.1:4444/api/tools/digital');
 assert.equal(assets.get(img.id).kind,'image');assert.equal(assets.get(audio.id).kind,'audio');
});

for(const channel of ['image','main','backup'])test('PIKNO canvas '+channel+' selects upload authorization from the execution line',async t=>{
 const f=await fixture(t),canvas=createCanvas({...f.options,walletMode:true,relayMode:true});
 const doc=canvas.create({nodes:[node('input','asset',{assetId:f.img.id}),node('run','generation',{channel,model:channel==='image'?'image-model':'video-model',prompt:'reference'})],edges:[{source:'input',target:'run'}]});
 await canvas.execute(doc.id,'run',crypto.randomUUID());
 assert.equal(f.uploads[0].kind,channel==='image'?'image':'video');assert.equal(f.assets.get(f.img.id).kind,'image');
});

for(const seconds of [30,30.01])test('PIKNO digital audio duration boundary '+seconds+' seconds',async t=>{
 const f=await fixture(t),canvas=createCanvas({...f.options,walletMode:true,relayMode:true,getRhKey:()=>assert.fail('must not read legacy key')});
 f.assets.setDuration(f.audio.id,seconds);
 const inputs=[f.img,f.audio],doc=canvas.create({nodes:[...inputs.map(a=>node(a.id,'asset',{assetId:a.id})),node('run','generation',{channel:'digital',prompt:''})],edges:inputs.map(a=>({source:a.id,target:'run'}))});
 if(seconds===30){
  await canvas.execute(doc.id,'run',crypto.randomUUID());
   assert.equal(f.calls.length,2);assert.equal(f.calls.at(-1).url,'http://127.0.0.1:4444/api/tools/digital');
   assert.equal(f.uploads.length,2);assert.equal(JSON.parse(f.calls.at(-1).opts.body).audios[0].durationSeconds,30);
 }else{
  await assert.rejects(canvas.execute(doc.id,'run',crypto.randomUUID()),/不超过30秒/);
  assert.equal(f.calls.length,0);assert.equal(f.uploads.length,0);
 }
});

test('director import is idempotent and contains only unconnected plain text',async t=>{
  const f=await fixture(t);const plan={title:'产品短片',direction_summary:'说明',anchor_library:[{anchor_id:'A00',prompt:'图片提示词'}],production_segments:[{segment_id:'S01',model_neutral_prompt:'视频提示词',provider:'secret-provider',model_id:'secret-model',human_action:'no',cost_reference:{min:5}}]};
  const a=await (await f.request('/director-import',{planId:'plan-1',plan})).json();const b=await (await f.request('/director-import',{planId:'plan-1',plan})).json();
  assert.equal(a.id,b.id);assert.equal(a.nodes.length,3);assert.deepEqual(a.edges,[]);assert.ok(a.nodes.every(n=>n.type==='text'));
  assert.doesNotMatch(JSON.stringify(a),/secret-provider|secret-model|cost_reference|human_action/);assert.equal(f.calls.length,0);
  assert.equal(createCanvas(f.options).load(a.id).nodes[1].data.text,'图片提示词');
});
test('project revisions prevent stale writes and credentials are excluded from stored node data',async t=>{
  const f=await fixture(t);const doc=f.canvas.create({title:'test',nodes:[node('text','text',{text:'original',apiKey:'no-store'})],edges:[]});
  assert.doesNotMatch(JSON.stringify(doc),/no-store/);
  const a=await f.request('/projects/'+doc.id,{...doc,title:'new'},'PUT');assert.equal(a.status,200);
  assert.equal((await f.request('/projects/'+doc.id,{...doc,title:'stale'},'PUT')).status,409);
  assert.equal(f.canvas.load(doc.id).title,'new');
  assert.equal((await fetch(f.base+'/api/canvas/projects',{method:'POST',headers:{origin:'https://foreign.test','content-type':'application/json'},body:JSON.stringify(doc)})).status,403);
});
for(const channel of ['image','backup','main','digital','depth'])test(channel+' node maps references and uses shared task API exactly once',async t=>{
  const f=await fixture(t);const inputs=channel==='digital'?[f.img,f.audio]:channel==='depth'?[f.vid]:[f.img];
  const nodes=[node('prompt','text',{text:'connected prompt'}),...inputs.map(a=>node(a.id,'asset',{assetId:a.id})),node('run','generation',{channel,model:channel==='image'?'image-model':'video-model',prompt:'local prompt',options:{duration:5,ratio:'16:9',resolution:'720p'}})];
  const doc=f.canvas.create({title:channel,nodes,edges:nodes.slice(0,-1).map(n=>({source:n.id,target:'run'}))});
  const requestId=crypto.randomUUID();await f.canvas.execute(doc.id,'run',requestId);await f.canvas.execute(doc.id,'run',requestId);
  const sent=f.calls.filter(c=>c.opts.headers?.['Idempotency-Key']);assert.equal(sent.length,1);const body=JSON.parse(sent[0].opts.body);
  assert.equal(f.uploads.length,inputs.length);assert.ok(f.uploads.every(u=>u.retention==='result'));
  if(channel==='digital'||channel==='depth'){
    assert.equal(body.nodeInfoList.length,inputs.length);assert.equal(sent[0].url.endsWith(channel==='digital'?'2087890031699648513':'2089021172049596418'),true);
    assert.deepEqual(body.nodeInfoList.map(n=>n.nodeId).sort(),channel==='digital'?['125','133']:['183']);
    assert.ok(f.calls.filter(c=>c.url.endsWith('/media/upload/binary')).every(c=>c.opts.headers.Authorization==='Bearer rh-secret'));
  }else{assert.equal(body.prompt,'connected prompt\n\nlocal prompt');assert.match(body.images[0].url,/^https:\/\/r2.test/);assert.equal(sent[0].url.endsWith(channel==='image'?'/api/images':channel==='main'?'/api/videos':'/api/official-videos'),true);}
  await assert.rejects(f.canvas.execute(doc.id,'run',crypto.randomUUID()),/未完成/);
  await f.request('/projects/'+doc.id+'/sync',{});
  assert.equal(f.canvas.load(doc.id).runs[0].status,'queued');
  await assert.rejects(f.canvas.execute(doc.id,'run',crypto.randomUUID()),/未完成/);
});
test('ambiguous submission is never automatically retried',async t=>{
  const f=await fixture(t);f.setError();const d=f.canvas.create({nodes:[node('run','generation',{channel:'image',model:'image-model',prompt:'hello'})],edges:[]});
  await assert.rejects(f.canvas.execute(d.id,'run',crypto.randomUUID()),/connection reset/);
  assert.equal(f.canvas.load(d.id).runs[0].status,'unknown');
  await assert.rejects(f.canvas.execute(d.id,'run',crypto.randomUUID()),/未完成/);
});
test('invalid RH input does not upload or submit',async t=>{
  const f=await fixture(t);const d=f.canvas.create({nodes:[node('run','generation',{channel:'digital'})],edges:[]});
  await assert.rejects(f.canvas.execute(d.id,'run',crypto.randomUUID()),/一张人物图片/);assert.equal(f.calls.length,0);assert.equal(f.uploads.length,0);
});
test('successful output registers once in shared assets and survives restart',async t=>{
  const f=await fixture(t);const d=f.canvas.create({nodes:[node('run','generation',{channel:'image',model:'image-model',prompt:'hi'})],edges:[]});
  await f.canvas.execute(d.id,'run',crypto.randomUUID());const task=f.records[0];task.status='succeeded';task.modelName='generated';task.result={local_path:path.join(f.dir,'results','test.png')};fs.writeFileSync(task.result.local_path,png);
  const a=await (await f.request('/projects/'+d.id+'/sync',{})).json();const b=await (await f.request('/projects/'+d.id+'/sync',{})).json();
  assert.equal(a.nodes.length,2);assert.equal(b.nodes.length,2);assert.equal(f.assets.entries(true).filter(a=>a.taskKey===task.key).length,1);
  assert.equal(createCanvas(f.options).load(d.id).nodes[1].data.assetId,a.runs[0].assetId);
  assert.equal(a.nodes[1].type,'output');
  const removed={...b,nodes:b.nodes.filter(n=>n.type!=='output'),edges:[]};
  assert.equal((await f.request('/projects/'+d.id,removed,'PUT')).status,200);
  assert.equal((await (await f.request('/projects/'+d.id+'/sync',{})).json()).nodes.length,1);
});
test('upload cards persist while empty, import locally, and sync R2 without duplicate assets',async t=>{
  const f=await fixture(t);const doc=f.canvas.create({nodes:[node('upload','upload',{label:'素材上传'}),node('run','generation',{channel:'backup',model:'video-model',prompt:'hello'})],edges:[{source:'upload',target:'run'}]});
  await assert.rejects(f.canvas.execute(doc.id,'run',crypto.randomUUID()),/完成.*上传/);
  const response=await fetch(f.base+'/api/canvas/assets/import?name=card.png',{method:'POST',body:png});assert.equal(response.status,201);
  const item=await response.json();assert.equal(f.uploads.length,0);
  const current=f.canvas.load(doc.id);current.nodes[0].data.assetId=item.id;
  assert.equal((await f.request('/projects/'+doc.id,current,'PUT')).status,200);
  assert.equal((await f.request('/assets/'+item.id+'/upload',{})).status,200);
  assert.equal((await f.request('/assets/'+item.id+'/upload',{})).status,200);
  assert.equal(f.assets.entries(true).filter(a=>a.id===item.id).length,1);
  await f.canvas.execute(doc.id,'run',crypto.randomUUID());
  assert.equal(JSON.parse(f.calls.find(c=>c.opts.headers?.['Idempotency-Key']).opts.body).images[0].tag,'@图片1');
});
test('references map per media kind and invalid mentions cannot reach paid submission',async t=>{
  const f=await fixture(t);const {referenceInputs,insertMention,validConnection}=await import('../public/canvas-core.mjs');
  const doc=f.canvas.create({nodes:[node('image','upload',{assetId:f.img.id}),node('video','asset',{assetId:f.vid.id}),node('audio','asset',{assetId:f.audio.id}),node('run','generation',{channel:'main',model:'video-model',prompt:'用 @图片1，参考 @视频1 和 @音频1'})],edges:['image','video','audio'].map(source=>({source,target:'run'}))});
  assert.deepEqual(referenceInputs(doc,'run',f.assets.entries()).map(r=>r.tag),['@图片1','@视频1','@音频1']);
  assert.deepEqual(insertMention('hello @图 world',8,8,'@图片1'),{text:'hello @图片1  world',caret:11});
  assert.equal(validConnection({source:'image',target:'run'},doc.nodes),true);
  assert.equal(validConnection({source:'run',target:'image'},doc.nodes),false);
  await f.canvas.execute(doc.id,'run',crypto.randomUUID());
  const body=JSON.parse(f.calls.find(c=>c.opts.headers?.['Idempotency-Key']).opts.body);
  assert.equal(body.prompt,doc.nodes[3].data.prompt);assert.equal(body.videos[0].tag,'@视频1');assert.equal(body.audios[0].tag,'@音频1');
  const invalid=f.canvas.create({nodes:[node('run','generation',{channel:'backup',model:'video-model',prompt:'参考 @图片2'})],edges:[]});
  const before=f.calls.length;await assert.rejects(f.canvas.execute(invalid.id,'run',crypto.randomUUID()),/未连接的素材引用/);assert.equal(f.calls.length,before);
});
test('deleting or reordering a mentioned source is rejected until the prompt is updated',async t=>{
  const f=await fixture(t);const doc=f.canvas.create({nodes:[node('a','asset',{assetId:f.img.id}),node('b','upload',{assetId:f.img.id}),node('run','generation',{channel:'backup',model:'video-model',prompt:'参考 @图片1'})],edges:[{source:'a',target:'run'},{source:'b',target:'run'}]});
  assert.equal((await f.request('/projects/'+doc.id,{...doc,edges:[...doc.edges].reverse()},'PUT')).status,400);
  assert.equal((await f.request('/projects/'+doc.id,{...doc,edges:doc.edges.slice(1)},'PUT')).status,400);
  assert.equal(f.canvas.load(doc.id).revision,1);
  doc.nodes[2].data.prompt='不再引用素材';doc.edges=doc.edges.slice(1);
  assert.equal((await f.request('/projects/'+doc.id,doc,'PUT')).status,200);
});
for(const channel of ['backup','main'])test('image Output feeds '+channel+' only after explicit execution and R2 transfer',async t=>{
  const f=await fixture(t);const d=f.canvas.create({nodes:[node('image','generation',{channel:'image',model:'image-model',prompt:'photo'})],edges:[]});
  await f.canvas.execute(d.id,'image',crypto.randomUUID());
  const task=f.records[0];task.status='succeeded';task.result={local_path:path.join(f.dir,'results','output.png')};fs.writeFileSync(task.result.local_path,png);
  const result=await (await f.request('/projects/'+d.id+'/sync',{})).json();
  const output=result.nodes.find(n=>n.type==='output');assert.ok(output);assert.equal(output.dragHandle,'.node-drag-handle');assert.equal(result.runs[0].storageSynced,true);
  result.nodes.push(node('video','generation',{channel,model:'video-model',prompt:'让 @图片1 动起来'}));result.edges.push({source:output.id,target:'video'});
  const {validConnection,referenceInputs}=await import('../public/canvas-core.mjs');
  assert.equal(validConnection({source:output.id,target:'video'},result.nodes),true);
  assert.equal(referenceInputs(result,'video',f.assets.entries())[0].tag,'@图片1');
  assert.equal((await f.request('/projects/'+d.id,result,'PUT')).status,200);
  await f.request('/projects/'+d.id+'/sync',{});assert.equal(f.records.length,1,'connecting does not submit');
  const transfers=f.uploads.length;await f.canvas.execute(d.id,'video',crypto.randomUUID());
  assert.equal(f.uploads.length,transfers+1);assert.equal(f.records.length,2);
  const sent=f.calls.filter(c=>c.opts.headers?.['Idempotency-Key']).at(-1),body=JSON.parse(sent.opts.body);
  assert.match(body.images[0].url,/^https:\/\/r2.test\//);assert.equal(body.images[0].tag,'@图片1');assert.equal(body.prompt,'让 @图片1 动起来');
  const reloaded=createCanvas(f.options).load(d.id);assert.equal(reloaded.nodes.find(n=>n.id===output.id).type,'output');
});
test('Output remains visible locally when R2 fails, and retries without duplicating the result',async t=>{
  const f=await fixture(t);const d=f.canvas.create({nodes:[node('image','generation',{channel:'image',model:'image-model',prompt:'photo'})],edges:[]});
  await f.canvas.execute(d.id,'image',crypto.randomUUID());const task=f.records[0];task.status='succeeded';task.result={local_path:path.join(f.dir,'results','local.png')};fs.writeFileSync(task.result.local_path,png);f.setUploadError(true);
  const result=await (await f.request('/projects/'+d.id+'/sync',{})).json();const output=result.nodes.find(n=>n.type==='output');assert.ok(output);assert.match(result.runs[0].storageError,/R2/);
  result.nodes.push(node('video','generation',{channel:'backup',model:'video-model',prompt:'动起来'}));result.edges.push({source:output.id,target:'video'});await f.request('/projects/'+d.id,result,'PUT');
  await assert.rejects(f.canvas.execute(d.id,'video',crypto.randomUUID()),/R2 offline/);assert.equal(f.records.length,1);
  f.setUploadError(false);const recovered=await (await f.request('/projects/'+d.id+'/sync',{})).json();assert.equal(recovered.nodes.filter(n=>n.type==='output').length,1);assert.equal(recovered.runs[0].storageSynced,true);assert.equal(f.assets.entries(true).filter(a=>a.taskKey===task.key).length,1);
});
test('legacy output assets retain identity and links with header-only dragging',async t=>{
  const f=await fixture(t);const d=f.canvas.create({nodes:[node('output:old','asset',{assetId:f.img.id}),node('video','generation',{channel:'backup',prompt:'@图片1',model:'video-model'})],edges:[{source:'output:old',target:'video'}]});
  const loaded=createCanvas(f.options).load(d.id);assert.equal(loaded.nodes[0].type,'output');assert.equal(loaded.nodes[0].id,'output:old');assert.equal(loaded.edges[0].source,'output:old');assert.ok(loaded.nodes.every(n=>n.dragHandle==='.node-drag-handle'));
  const source=fs.readFileSync(path.join(__dirname,'../canvas/src/main.jsx'),'utf8');const card=source.slice(source.indexOf('function Card('),source.indexOf('function TextNode('));assert.doesNotMatch(card,/<input|ui.edit/);assert.match(card,/node-drag-handle/);
});
test('standalone Output persists empty, receives upstream results, and feeds video without duplicate cards',async t=>{
  const f=await fixture(t);
  const d=f.canvas.create({nodes:[node('image','generation',{channel:'image',model:'image-model',prompt:'photo'}),node('placed','output',{label:'Output'}),node('video','generation',{channel:'backup',model:'video-model',prompt:'animate'})],edges:[{source:'image',target:'placed'},{source:'placed',target:'video'}]});
  assert.equal(createCanvas(f.options).load(d.id).nodes[1].data.assetId,undefined);
  await assert.rejects(f.canvas.execute(d.id,'video',crypto.randomUUID()),/等待输出结果/);assert.equal(f.records.length,0);
  await f.canvas.execute(d.id,'image',crypto.randomUUID());
  const task=f.records[0];task.status='succeeded';task.result={local_path:path.join(f.dir,'results','placed.png')};fs.writeFileSync(task.result.local_path,png);
  let result=await (await f.request('/projects/'+d.id+'/sync',{})).json();
  assert.equal(result.nodes.length,3);assert.equal(result.nodes.filter(n=>n.type==='output').length,1);assert.equal(result.nodes[1].id,'placed');
  const {nodeAssetId,referenceInputs}=await import('../public/canvas-core.mjs');
  assert.equal(nodeAssetId(result,result.nodes[1]),result.runs[1].assetId);
  assert.equal(referenceInputs(result,'video',f.assets.entries())[0].tag,'@图片1');
  result.nodes[2].data.prompt='让 @图片1 动起来';
  assert.equal((await f.request('/projects/'+d.id,result,'PUT')).status,200);
  await f.canvas.execute(d.id,'video',crypto.randomUUID());assert.equal(f.records.length,2);assert.equal(f.uploads.length,2);
  const body=JSON.parse(f.calls.filter(c=>c.opts.headers?.['Idempotency-Key']).at(-1).opts.body);assert.match(body.images[0].url,/^https:\/\/r2.test\//);
  result=createCanvas(f.options).load(d.id);assert.equal(nodeAssetId(result,result.nodes[1]),result.runs[1].assetId);
  assert.equal((await f.request('/projects/'+d.id,{...result,title:'保存独立 Output'},'PUT')).status,200);
});
test('Output accepts one generation source and prevents cyclic connections',async t=>{
  const f=await fixture(t),{validConnection}=await import('../public/canvas-core.mjs');
  const nodes=[node('a','generation',{channel:'image'}),node('b','generation',{channel:'backup'}),node('out','output',{}),node('out2','output',{})];
  const edges=[{source:'a',target:'out'},{source:'out',target:'b'},{source:'b',target:'out2'}];
  assert.equal(validConnection({source:'a',target:'out'},nodes),true);
  assert.equal(validConnection({source:'b',target:'out'},nodes,edges),false);
  assert.equal(validConnection({source:'out2',target:'a'},nodes,edges),false);
  assert.throws(()=>f.canvas.create({nodes,edges:[...edges,{source:'out2',target:'a'}]}),/循环/);
  assert.throws(()=>f.canvas.create({nodes,edges:[...edges,{source:'b',target:'out'}]}),/一个生成节点/);
  assert.throws(()=>f.canvas.create({nodes,edges:[{source:'out2',target:'out'}]}),/一个生成节点/);
});
test('live node projection retains measurements and drag positions across save and polling replies',async()=>{
  const {reconcileViewNodes}=await import('../canvas/src/projection.mjs');
  const first={...node('a','text',{text:'hi'}),measured:{width:320,height:250},selected:true,dragging:true,position:{x:100,y:70}};
  const saved={...node('a','text',{text:'hi'}),position:{x:0,y:0}};
  assert.equal(reconcileViewNodes([saved],[first],true)[0],first);
  const stopped=reconcileViewNodes([{...saved,position:{x:100,y:70}}],[first])[0];
  assert.equal(stopped.measured,first.measured);assert.equal(stopped,first);
  const moved=reconcileViewNodes([saved],[first])[0];assert.deepEqual(moved.position,{x:0,y:0});assert.equal(moved.measured.width,320);
});
test('deleting one project archives only that document and cannot resurrect through stale writes or sync',async t=>{
  const f=await fixture(t);
  const a=f.canvas.create({title:'同名画布',nodes:[node('a','asset',{assetId:f.img.id})],edges:[]});
  const b=f.canvas.create({title:'同名画布',nodes:[],edges:[]});
  const resultFile=path.join(f.dir,'results','keep.png');fs.writeFileSync(resultFile,png);
  f.records.push({key:'keep',status:'succeeded'});
  const removed=await f.request('/projects/'+a.id,{revision:a.revision},'DELETE');assert.equal(removed.status,200);assert.equal((await removed.json()).recoverable,true);
  assert.deepEqual(f.canvas.list().map(p=>p.id),[b.id]);assert.equal(f.assets.get(f.img.id).id,f.img.id);assert.ok(fs.existsSync(resultFile));assert.equal(f.records.length,1);
  const archived=fs.readdirSync(path.join(f.options.dir,'deleted'));assert.equal(archived.length,1);assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.options.dir,'deleted',archived[0]))),a);
  for(const [method,body,suffix] of [['GET',undefined,''],['PUT',a,''],['POST',{},'/sync'],['DELETE',{revision:a.revision},'']])assert.equal((await f.request('/projects/'+a.id+suffix,body,method)).status,404);
  assert.equal((await f.request('/projects/'+b.id,{revision:b.revision},'DELETE')).status,200);assert.deepEqual(f.canvas.list(),[]);
  assert.equal(createCanvas(f.options).list().length,0);assert.equal(fs.readdirSync(path.join(f.options.dir,'deleted')).length,2);
});
test('project deletion requires a current revision and local origin',async t=>{
  const f=await fixture(t),doc=f.canvas.create({nodes:[],edges:[]});
  assert.equal((await f.request('/projects/'+doc.id,{},'DELETE')).status,409);
  await f.request('/projects/'+doc.id,{...doc,title:'updated'},'PUT');
  assert.equal((await f.request('/projects/'+doc.id,{revision:doc.revision},'DELETE')).status,409);
  const foreign=await fetch(f.base+'/api/canvas/projects/'+doc.id,{method:'DELETE',headers:{origin:'https://foreign.test','content-type':'application/json'},body:JSON.stringify({revision:2})});assert.equal(foreign.status,403);assert.equal(f.canvas.list().length,1);
});
test('project deletion protects in-flight and queued tasks while leaving completed task history intact',async t=>{
  const f=await fixture(t),doc=f.canvas.create({nodes:[node('run','generation',{channel:'image',model:'image-model',prompt:'test'})],edges:[]});
  let release;f.setSlow(new Promise(r=>release=r));const executing=f.canvas.execute(doc.id,'run',crypto.randomUUID());
  assert.equal((await f.request('/projects/'+doc.id,{revision:doc.revision},'DELETE')).status,409);
  release();await executing;
  assert.equal((await f.request('/projects/'+doc.id,{revision:doc.revision},'DELETE')).status,409);
  f.records[0].status='succeeded';assert.equal((await f.request('/projects/'+doc.id,{revision:doc.revision},'DELETE')).status,200);assert.equal(f.records.length,1);
});
test('repeated runs append immutable Outputs without replacing old previews or downstream references',async t=>{
  const f=await fixture(t),{nodeAssetId,referenceInputs,mergeOutputBindings}=await import('../public/canvas-core.mjs');
  const doc=f.canvas.create({nodes:[node('prompt','text',{text:'共享提示词'}),node('image','generation',{channel:'image',model:'image-model',prompt:'第一版'}),node('placed','output',{}),node('video','generation',{channel:'backup',model:'video-model',prompt:'animate'})],edges:[{source:'prompt',target:'image'},{source:'image',target:'placed'},{source:'placed',target:'video'}]});
  const finish=async()=>{const requestId=crypto.randomUUID();await f.canvas.execute(doc.id,'image',requestId);const task=f.records.at(-1);task.status='succeeded';task.result={local_path:path.join(f.dir,'results',requestId+'.png')};fs.writeFileSync(task.result.local_path,png);return (await f.request('/projects/'+doc.id+'/sync',{})).json();};
  const first=await finish(),assetId=nodeAssetId(first,first.nodes.find(n=>n.id==='placed'));
  assert.equal(first.runs[0].prompt,'共享提示词\n\n第一版');
  first.nodes.find(n=>n.id==='image').data.prompt='第二版';first.nodes.find(n=>n.id==='video').data.prompt='参考 @图片1';await f.request('/projects/'+doc.id,first,'PUT');
  const second=await finish(),third=await finish();
  assert.equal(second.nodes.filter(n=>n.type==='output').length,2);assert.equal(third.nodes.filter(n=>n.type==='output').length,3);
  assert.equal(nodeAssetId(third,third.nodes.find(n=>n.id==='placed')),assetId);assert.equal(referenceInputs(third,'video',f.assets.entries())[0].asset.id,assetId);
  assert.equal(third.runs[0].prompt,'共享提示词\n\n第一版');assert.equal(third.runs[1].prompt,'共享提示词\n\n第二版');
  assert.equal(new Set(third.nodes.filter(n=>n.type==='output').map(n=>n.position.y)).size,3);
  const stale=third.nodes.map(n=>n.id==='placed'?{...n,data:{label:'Output'},position:{x:80,y:90}}:n);
  assert.equal(mergeOutputBindings(stale,third).find(n=>n.id==='placed').data.assetId,assetId);
  assert.deepEqual(mergeOutputBindings(stale,third).find(n=>n.id==='placed').position,{x:80,y:90});
  assert.equal((await f.request('/projects/'+doc.id,{...third,nodes:stale},'PUT')).status,200);
  assert.equal(createCanvas(f.options).load(doc.id).nodes.find(n=>n.id==='placed').data.assetId,assetId);
  const again=await (await f.request('/projects/'+doc.id+'/sync',{})).json();assert.equal(again.nodes.filter(n=>n.type==='output').length,3);
});
test('legacy live Output migrates to the previously visible result and never follows later runs',async t=>{
  const f=await fixture(t);const d=f.canvas.create({nodes:[node('g','generation',{channel:'image'}),node('o','output',{})],edges:[{source:'g',target:'o'}]});
  delete d.outputVersion;d.runs=[{nodeId:'g',requestId:crypto.randomUUID(),assetId:f.img.id,outputCreated:true},{nodeId:'g',requestId:crypto.randomUUID(),assetId:f.vid.id,outputCreated:true}];fs.writeFileSync(path.join(f.options.dir,d.id+'.json'),JSON.stringify(d));
  const loaded=f.canvas.load(d.id);assert.equal(loaded.nodes[1].data.assetId,f.vid.id);assert.equal(loaded.nodes[1].data.requestId,d.runs[1].requestId);
  const {outputRun}=await import('../public/canvas-core.mjs');loaded.runs.push({nodeId:'g',requestId:crypto.randomUUID(),assetId:f.audio.id});assert.equal(outputRun(loaded,loaded.nodes[1]).assetId,f.vid.id);
});
test('bundled Node starts production service without PATH, pnpm or network install',async t=>{
  const f=await fixture(t);let link;
  const launch=createCanvasLauncher({resourcesDir:process.env.HAMSTER_TEST_RESOURCES,baseUrl:()=>f.base,openExternal:url=>link=url,spawnImpl:(command,args,options)=>require('node:child_process').spawn(command,args,{...options,env:{...options.env,PATH:''}})});t.after(()=>launch.stop());
  await launch.open();const auth=await fetch(link,{redirect:'manual'});assert.equal(auth.status,302);const cookie=auth.headers.get('set-cookie').split(';')[0];
  const base=new URL(link).origin;assert.equal((await fetch(base)).status,403);
  const page=await fetch(base,{headers:{cookie}});assert.equal(page.status,200);
  const html=await page.text();const script=html.match(/src="([^"]+\.js)"/);assert.ok(script);
  assert.equal((await fetch(base+script[1],{headers:{cookie}})).status,200);
  assert.equal((await fetch(base+'/api/config',{headers:{cookie}})).status,404);
  assert.equal((await (await fetch(base+'/api/uploads/status',{headers:{cookie}})).json()).connected,true);
  assert.equal((await fetch(base+'/api/uploads/status',{method:'POST',headers:{cookie}})).status,404);
  assert.equal((await fetch(base+'/api/canvas/projects',{headers:{cookie}})).status,200);
  assert.equal((await fetch(base+'/api/canvas/projects',{headers:{cookie,origin:'https://foreign.test'}})).status,403);
  assert.notEqual((await fetch(base+'/api/relay/state',{headers:{cookie}})).status,404);
  assert.equal((await fetch(base+'/api/relay/state',{method:'POST',headers:{cookie}})).status,404);
  assert.equal((await fetch(base+'/api/relay/connection',{headers:{cookie}})).status,200);
  assert.equal((await fetch(base+'/api/relay/connection',{method:'POST',headers:{cookie}})).status,404);
});

async function waitUntil(check){for(let i=0;i<500;i++){if(check())return;await new Promise(setImmediate);}assert.fail('background execution did not settle');}

test('canvas readonly quote carries only measurement data and no upload or task',async t=>{
  const f=await fixture(t,{relayMode:true,walletMode:true,getExecutionContext:()=>({owner:'pikno:7',revision:5})});
  const doc=f.canvas.create({nodes:[node('source','asset',{assetId:f.img.id}),node('run','generation',{channel:'image',model:'image-model',prompt:'private prompt'})],edges:[{source:'source',target:'run'}]});
  const r=await f.request('/projects/'+doc.id+'/quote',{nodeId:'run',revision:5});assert.equal(r.status,200);const result=await r.json();
  assert.equal(result.quote.name,'已发布客户线路');assert.equal(result.revision,5);assert.equal(f.canvas.load(doc.id).runs.length,0);assert.equal(f.records.length,0);assert.equal(f.uploads.length,0);
  const sent=JSON.parse(f.calls.find(c=>c.url.endsWith('/api/quotes')).opts.body);assert.deepEqual(sent.media_counts,{images:1,videos:0,audios:0});assert.equal(sent.concurrency,1);assert.equal(sent.prompt,undefined);assert.equal(sent.images,undefined);assert.doesNotMatch(JSON.stringify(sent),/private prompt|https:/);
});

test('canvas rejects missing confirmation and binds a quote to the exact node content',async t=>{
  const f=await fixture(t,{relayMode:true,walletMode:true,getExecutionContext:()=>({owner:'pikno:7',revision:5})});
  const doc=f.canvas.create({nodes:[node('run','generation',{channel:'image',model:'image-model',prompt:'first'})],edges:[]}),route='/projects/'+doc.id+'/execute',base={nodeId:'run',requestId:crypto.randomUUID(),revision:5};
  assert.equal((await f.request(route,base)).status,428);
  const {quote}=await f.canvas.quoteNode(doc.id,'run',5);assert.equal((await f.request(route,{...base,quote_id:quote.id,confirmed:'true'})).status,428);
  const changed=f.canvas.load(doc.id);changed.nodes[0].data.prompt='changed after confirmation';assert.equal((await f.request('/projects/'+doc.id,changed,'PUT')).status,200);
  assert.equal((await f.request(route,{...base,quote_id:quote.id,confirmed:true})).status,409);assert.equal(f.canvas.load(doc.id).runs.length,0);assert.equal(f.records.length,0);assert.equal(f.uploads.length,0);
});

test('canvas invalidates a late quote after either account or input content changes',async t=>{
  for(const change of ['account','content']){
    let current={owner:'pikno:7',revision:5};const f=await fixture(t,{relayMode:true,walletMode:true,getExecutionContext:()=>current});
    const doc=f.canvas.create({nodes:[node('run','generation',{channel:'image',model:'image-model',prompt:'first'})],edges:[]});
    let started,release;const entered=new Promise(resolve=>started=resolve),gate=new Promise(resolve=>release=resolve),original=f.options.fetchImpl;
    const canvas=createCanvas({...f.options,fetchImpl:async(url,opts)=>{if(String(url).endsWith('/api/quotes')){started();await gate;}return original(url,opts);}});
    const pending=canvas.quoteNode(doc.id,'run',5);await entered;
    if(change==='account')current={owner:'pikno:8',revision:6};else{const next=f.canvas.load(doc.id);next.nodes[0].data.prompt='changed';await f.request('/projects/'+doc.id,next,'PUT');}
    release();await assert.rejects(pending,e=>e.status===409);assert.equal(f.records.length,0);assert.equal(f.uploads.length,0);assert.equal(f.canvas.load(doc.id).runs.length,0);
  }
});

test('canvas rechecks quote expiry after preparing media and never submits an expired quote',async t=>{
  const f=await fixture(t,{relayMode:true,walletMode:true,getExecutionContext:()=>({owner:'pikno:7',revision:5})});
  const doc=f.canvas.create({nodes:[node('source','asset',{assetId:f.img.id}),node('run','generation',{channel:'image',model:'image-model',prompt:'photo'})],edges:[{source:'source',target:'run'}]});
  const {quote}=await f.canvas.quoteNode(doc.id,'run',5),upload=f.assets.upload,now=Date.now;
  t.after(()=>{Date.now=now;});f.assets.upload=async(...args)=>{const a=await upload(...args);Date.now=()=>quote.expires_at*1000+1;return a;};
  await assert.rejects(f.canvas.execute(doc.id,'run',crypto.randomUUID(),5,quote.id),e=>e.status===409);Date.now=now;
  assert.equal(f.uploads.length,1);assert.equal(f.records.length,0);assert.equal(f.calls.some(c=>c.url.endsWith('/api/images')),false);assert.equal(f.canvas.load(doc.id).runs[0].status,'failed');
});

test('canvas keeps the confirmed customer name and price snapshot and disallows quote reuse',async t=>{
  const f=await fixture(t,{relayMode:true,walletMode:true,getExecutionContext:()=>({owner:'pikno:7',revision:5})});
  const doc=f.canvas.create({nodes:[node('run','generation',{channel:'image',model:'image-model',prompt:'first'})],edges:[]}),{quote}=await f.canvas.quoteNode(doc.id,'run',5),requestId=crypto.randomUUID();
  await f.canvas.execute(doc.id,'run',requestId,5,quote.id);const sent=JSON.parse(f.calls.find(c=>c.url.endsWith('/api/images')).opts.body);assert.equal(sent.quote_id,quote.id);assert.equal(sent.price_version,8);
  const run=f.canvas.load(doc.id).runs[0];assert.equal(run.modelName,'已发布客户线路');assert.equal(run.priceSnapshot.total_cny,'0.12');assert.equal(run.priceSnapshot.id,undefined);
  f.records[0].status='succeeded';assert.equal((await f.request('/projects/'+doc.id+'/execute',{nodeId:'run',requestId:crypto.randomUUID(),revision:5,quote_id:quote.id,confirmed:true})).status,409);assert.equal(f.records.length,1);assert.equal(f.canvas.load(doc.id).runs.length,1);
  const again=await f.canvas.execute(doc.id,'run',requestId,5,quote.id);assert.equal(again.requestId,requestId);assert.equal(f.records.length,1);
});

test('a quote cannot authorize another canvas node or project',async t=>{
  const f=await fixture(t,{relayMode:true,walletMode:true,getExecutionContext:()=>({owner:'pikno:7',revision:5})}),generation=id=>node(id,'generation',{channel:'image',model:'image-model',prompt:'same billed inputs'});
  const a=f.canvas.create({nodes:[generation('first'),generation('second')],edges:[]}),b=f.canvas.create({nodes:[generation('first')],edges:[]}),{quote}=await f.canvas.quoteNode(a.id,'first',5);
  for(const [project,nodeId] of [[a.id,'second'],[b.id,'first']])assert.equal((await f.request('/projects/'+project+'/execute',{nodeId,requestId:crypto.randomUUID(),revision:5,quote_id:quote.id,confirmed:true})).status,428);
  assert.equal(f.records.length,0);assert.equal(f.uploads.length,0);assert.equal(f.canvas.load(a.id).runs.length,0);assert.equal(f.canvas.load(b.id).runs.length,0);
});

test('an already submitted upstream quote stays unknown and cannot trigger another canvas submission',async t=>{
  const f=await fixture(t,{relayMode:true,walletMode:true,getExecutionContext:()=>({owner:'pikno:7',revision:5})}),original=f.options.fetchImpl;
  const canvas=createCanvas({...f.options,fetchImpl:(url,opts)=>String(url).endsWith('/api/images')?Response.json({code:'quote_already_submitted',error:'此报价已提交，请查询原任务，勿重复提交'},{status:409}):original(url,opts)});
  const doc=canvas.create({nodes:[node('run','generation',{channel:'image',model:'image-model',prompt:'same'})],edges:[]}),{quote}=await canvas.quoteNode(doc.id,'run',5);
  await assert.rejects(canvas.execute(doc.id,'run',crypto.randomUUID(),5,quote.id),e=>e.status===409);assert.equal(canvas.load(doc.id).runs[0].status,'unknown');
  await assert.rejects(canvas.execute(doc.id,'run',crypto.randomUUID(),5),/待确认/);assert.equal(canvas.load(doc.id).runs.length,1);
});

test('canvas accepts a durable run before a slow generation finishes and never restarts it',async t=>{
  const f=await fixture(t,{relayMode:true,walletMode:true,getExecutionContext:()=>({owner:'pikno:7',revision:4})});
  const doc=f.canvas.create({nodes:[node('run','generation',{channel:'image',model:'image-model',prompt:'slow image'})],edges:[]}),requestId=crypto.randomUUID();
  const {quote}=await(await f.request('/projects/'+doc.id+'/quote',{nodeId:'run',revision:4})).json(),confirmed={nodeId:'run',requestId,revision:4,quote_id:quote.id,confirmed:true};
  let release;f.setSlow(new Promise(resolve=>release=resolve));
  const response=await f.request('/projects/'+doc.id+'/execute',confirmed);
  assert.equal(response.status,202);const accepted=await response.json();assert.equal(accepted.status,'preparing');assert.equal(accepted.owner,undefined);
  assert.equal(f.canvas.load(doc.id).runs[0].owner,'pikno:7');assert.equal(f.records.length,0);
  assert.equal((await f.request('/projects/'+doc.id+'/execute',confirmed)).status,202);
  release();await waitUntil(()=>Boolean(f.canvas.load(doc.id).runs[0].taskKey));
  assert.equal(f.records.length,1);assert.equal(f.calls.find(c=>c.url.endsWith('/api/images')).opts.headers['X-Hamster-Config-Revision'],'4');
  const restored=createCanvas(f.options).load(doc.id);assert.equal(restored.runs[0].taskKey,f.records[0].key);
  assert.equal((await f.request('/projects/'+doc.id+'/execute',confirmed)).status,202);assert.equal(f.records.length,1);
});

test('account change during catalogue preparation prevents material uploads and paid submission',async t=>{
  let current={owner:'pikno:7',revision:1};const f=await fixture(t,{relayMode:true,walletMode:true,getExecutionContext:()=>current});
  const doc=f.canvas.create({nodes:[node('image','asset',{assetId:f.img.id}),node('run','generation',{channel:'image',model:'image-model',prompt:'photo'})],edges:[{source:'image',target:'run'}]});
  let release;f.setSlow(new Promise(resolve=>release=resolve));const pending=f.canvas.execute(doc.id,'run',crypto.randomUUID());
  await waitUntil(()=>f.calls.length>0);current={owner:'pikno:8',revision:2};release();
  await assert.rejects(pending,e=>e.status===409);assert.equal(f.uploads.length,0);assert.equal(f.records.length,0);
  const run=f.canvas.load(doc.id).runs[0];assert.equal(run.owner,'pikno:7');assert.equal(run.status,'failed');
  assert.equal((await f.request('/projects/'+doc.id+'/execute',{nodeId:'run',requestId:crypto.randomUUID(),revision:1})).status,409);assert.equal(f.canvas.load(doc.id).runs.length,1);
});

test('account change during tool upload cannot submit the prepared tool task',async t=>{
  let current={owner:'pikno:7',revision:2};const f=await fixture(t,{relayMode:true,walletMode:true,getExecutionContext:()=>current});
  const doc=f.canvas.create({nodes:[node('video','asset',{assetId:f.vid.id}),node('run','generation',{channel:'depth'})],edges:[{source:'video',target:'run'}]});
  let entered,release;const started=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve),upload=f.assets.upload;
  f.assets.upload=async(id,metadata)=>{assert.equal(metadata.kind,'tool');assert.equal(metadata.revision,2);entered();await gate;return upload(id,metadata);};
  const pending=f.canvas.execute(doc.id,'run',crypto.randomUUID());await started;current={owner:'pikno:8',revision:3};release();
  await assert.rejects(pending,e=>e.status===409);assert.equal(f.records.length,0);assert.equal(f.calls.some(c=>c.url.endsWith('/api/tools/depth')),false);
});

test('relay results remain local until an explicit target authorizes a downstream upload',async t=>{
  const f=await fixture(t,{relayMode:true,walletMode:true,getExecutionContext:()=>({owner:'pikno:7',revision:1})});
  const doc=f.canvas.create({nodes:[node('run','generation',{channel:'image',model:'image-model',prompt:'photo'})],edges:[]});
  await f.canvas.execute(doc.id,'run',crypto.randomUUID());const task=f.records[0];task.status='succeeded';task.result={local_path:path.join(f.dir,'results','local-relay.png')};fs.writeFileSync(task.result.local_path,png);
  f.setUploadError(true);const result=await(await f.request('/projects/'+doc.id+'/sync',{})).json();
  assert.equal(result.nodes.filter(n=>n.type==='output').length,1);assert.equal(result.runs[0].localAvailable,true);assert.equal(result.runs[0].storageSynced,undefined);assert.equal(result.runs[0].storageError,undefined);assert.equal(f.uploads.length,0);
  f.setUploadError(false);const assetId=result.runs[0].assetId;
  assert.equal((await f.request('/assets/'+assetId+'/upload',{kind:'tool',revision:1})).status,200);assert.equal(f.uploads[0].kind,'tool');
  assert.equal((await f.request('/assets/'+assetId+'/upload',{kind:'tool',revision:0})).status,409);assert.equal(f.uploads.length,1);
  await f.request('/projects/'+doc.id+'/sync',{});assert.equal(f.uploads.length,1);assert.equal(f.assets.entries(true).filter(a=>a.taskKey===task.key).length,1);
});

test('legacy run inherits only its matching task owner and foreign runs remain intact',async t=>{
  let current={owner:'pikno:7',revision:1};const f=await fixture(t,{relayMode:true,walletMode:true,getExecutionContext:()=>current});
  const doc=f.canvas.create({nodes:[node('run','generation',{channel:'image',model:'image-model',prompt:'photo'})],edges:[]}),requestId=crypto.randomUUID();
  doc.runs=[{nodeId:'run',requestId,status:'queued'}];fs.writeFileSync(path.join(f.options.dir,doc.id+'.json'),JSON.stringify(doc));
  f.records.push({key:'legacy-task',walletUser:'pikno:7',requestId:requestId+':0',status:'processing'});
  await f.request('/projects/'+doc.id+'/sync',{});assert.equal(f.canvas.load(doc.id).runs[0].owner,'pikno:7');
  current={owner:'pikno:8',revision:2};const response=await(await f.request('/projects/'+doc.id,undefined,'GET')).json();
  assert.equal(response.runs[0].owner,undefined);assert.equal(response.runs[0].inactiveAccount,true);
  const before=f.canvas.load(doc.id).runs[0];await f.request('/projects/'+doc.id+'/sync',{});assert.deepEqual(f.canvas.load(doc.id).runs[0],before);
  await f.canvas.execute(doc.id,'run',crypto.randomUUID());assert.equal(f.canvas.load(doc.id).runs[1].owner,'pikno:8');assert.equal(f.records.length,2);
});

test('relay canvas rejects retired director imports without deleting historical text',async t=>{
  const f=await fixture(t,{relayMode:true,walletMode:true}),doc=f.canvas.create(directorDocument({title:'历史方案',direction_summary:'保留内容'}));
  assert.equal((await f.request('/director-import',{planId:'new',plan:{title:'new'}})).status,410);
  assert.equal(f.canvas.load(doc.id).nodes[0].data.text,'保留内容');assert.equal(f.canvas.list().length,1);
});

test('retired specifications cannot upload references or create paid tasks',async t=>{
  const f=await fixture(t,{relayMode:true,walletMode:true});
  for(const [channel,options] of [['image',{size:'999x999'}],['main',{duration:120}],['backup',{reference:'startEnd'}]]){
    const doc=f.canvas.create({nodes:[node('input','asset',{assetId:f.img.id}),node('run','generation',{channel,model:channel==='image'?'image-model':'video-model',prompt:'test',options})],edges:[{source:'input',target:'run'}]});
    await assert.rejects(f.canvas.execute(doc.id,'run',crypto.randomUUID()),/已不可用/);
  }
  assert.equal(f.records.length,0);assert.equal(f.uploads.length,0);
});
