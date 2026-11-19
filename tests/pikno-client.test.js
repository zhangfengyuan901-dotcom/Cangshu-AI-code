const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createPiknoClient,quoteParameters}=require('../pikno-client.cjs');
const endpoint='https://www.piknoai.com',id='a'.repeat(32),url=endpoint+'/media/v1/assets/'+id;
const cfg={piknoImageKey:'image-test-only',piknoVideoKey:'video-test-only'};
const video={id:'pikno-video-sb-sd2_9img_seconds_720p_real',kind:'video',name:'PIKNO 视频产品',provider:'sanbao',upstream_model:'sd2_private',cost_cny:'0.01',resolutions:['720p'],ratios:['16:9'],durations:[4],max_images:9,max_videos:3,max_audio:3,price:123};
const image={id:'pikno-image-flare',kind:'image',resolutions:['1024x1024'],max_images:5};
const json=value=>new Response(JSON.stringify(value),{headers:{'Content-Type':'application/json'}});
test('image quote canonical parameters match the Go guard: ratio is derived from size and omitted on the wire',()=>{
  const parameters=quoteParameters({...image,qualities:['auto','high']},{size:'1024x1024',quality:'high',aspect_ratio:'1:1',concurrency:2,media_counts:{images:1,videos:0,audios:0}});
  assert.deepEqual(parameters,{model:image.id,operation:'image_edit',resolution:'1024x1024',quality:'high',ratio:'',seconds:0,reference_images:1,reference_videos:0,reference_audio:0,quantity:2});
  assert.deepEqual(quoteParameters({...image,qualities:['auto','high']},{size:'1024x1024',quality:'high',aspect_ratio:'1:1',concurrency:2,images:[{url:url+'?ticket=read'}]},{actualMedia:true}),parameters);
});

test('relay catalogue intersects each Key permission, maps published names and strips private routing or untyped prices',async()=>{
  const calls=[];
  const client=createPiknoClient({fetchImpl:async(target,init)=>{
    calls.push({target,init});
    if(target.endsWith('/api/pikno/catalog'))return json({data:{models:[video,image,{...video,id:'closed-line'}]}});
    return json({data:[{id:new Headers(init.headers).get('authorization').includes('image-')?image.id:video.id}]});
  }});
  const data=await client.catalog(cfg);assert.equal(data.data.length,2);
  assert.equal(data.data[0].name,video.name);
  assert.doesNotMatch(JSON.stringify(data.data),/sanbao|sd2_|flare|"price":|123|image-test|video-test|cost_cny/);
  assert.equal(data.data.find(m=>m.type==='video').max_media_files,15);
  assert.deepEqual(data.data.find(m=>m.type==='image').aspect_ratios,['1:1']);
  assert.equal(data.resolve(data.data[0].id).id,video.id);
  assert.equal(new Headers(calls[0].init.headers).get('authorization'),null);
});
test('empty callable list never exposes cached or unauthorised lines',async()=>{
  const client=createPiknoClient({fetchImpl:async target=>json(target.endsWith('/v1/models')?{data:[]}:{data:{models:[video]}})});
  assert.deepEqual((await client.catalog({piknoVideoKey:cfg.piknoVideoKey})).data,[]);
});
test('one revoked Key leaves only the other Key callable lines; both failures reject without retry',async()=>{
  const calls=[];
  const client=createPiknoClient({fetchImpl:async(target,init)=>{
    calls.push(target);
    if(target.endsWith('/api/pikno/catalog'))return json({data:{models:[image,video]}});
    if(new Headers(init.headers).get('authorization')==='Bearer '+cfg.piknoVideoKey)return new Response('private upstream body',{status:401});
    return json({data:[{id:image.id}]});
  }});
  const models=await client.catalog(cfg);assert.equal(models.data.length,1);assert.equal(models.data[0].type,'image');
  assert.equal(models.resolve('tool-digital'),undefined);assert.equal(calls.length,3);
  await assert.rejects(client.catalog({piknoVideoKey:cfg.piknoVideoKey}),error=>error.statusCode===401&&!/private/.test(error.message));
  assert.equal(calls.length,4); // public capabilities were briefly reused; authorization was checked again
});
test('PIKNO account context enforces matching image/video group',async()=>{
  const client=createPiknoClient({fetchImpl:async()=>json({user_id:7,group:'video-standard',token_id:4})});
  assert.equal((await client.context(cfg,'video')).user_id,7);
  await assert.rejects(client.context(cfg,'image'),e=>e.statusCode===403);
});
test('video maps the desktop payload, uses video Key, submits exactly once',async()=>{
  const calls=[];
  const client=createPiknoClient({fetchImpl:async(target,init)=>{calls.push({target,init});return json({id:'task_1',status:'queued'});}});
  await client.submit(cfg,video,{duration:4,resolution:'720p',ratio:'16:9',prompt:'test',reference:'all',price_version:100,concurrency:4,images:[{url:url+'?ticket=read'}]});
  assert.equal(calls.length,1);assert.equal(calls[0].target,endpoint+'/v1/videos');
  const body=JSON.parse(calls[0].init.body);assert.equal(body.seconds,4);assert.equal(body.aspect_ratio,'16:9');
  assert.equal(body.model,video.id);assert.equal(body.image_urls.length,1);assert.equal(body.concurrency,undefined);assert.equal(body.price_version,undefined);
  assert.equal(new Headers(calls[0].init.headers).get('authorization'),'Bearer '+cfg.piknoVideoKey);
});
test('image synchronous generation/edit uses one image and exact declared size',async()=>{
  const calls=[];
  const client=createPiknoClient({fetchImpl:async(target,init)=>{calls.push({target,init});return json({data:[{url:'https://output.test/image.png'}]});}});
  await client.submit(cfg,image,{aspect_ratio:'1:1',prompt:'test'});
  await client.submit(cfg,image,{aspect_ratio:'1:1',images:[{url:url+'?ticket=read'}]});
  assert.equal(calls[0].target,endpoint+'/v1/images/generations');assert.equal(calls[1].target,endpoint+'/v1/images/edits');
  assert.equal(JSON.parse(calls[0].init.body).n,1);assert.equal(JSON.parse(calls[0].init.body).size,'1024x1024');
  assert.equal(new Headers(calls[0].init.headers).get('authorization'),'Bearer '+cfg.piknoImageKey);
  assert.throws(()=>client.submit(cfg,image,{aspect_ratio:'16:9'}),/不支持/);
});

test('declared image sizes and qualities reach the catalogue without widening legacy capabilities',async()=>{
  const advanced={...image,id:'pikno-image-new',resolutions:['auto','1024x1024','2048x2048','1536x864','2048x1152','3840x2160'],qualities:['auto','low','medium','high','secret-provider-quality']};
  const client=createPiknoClient({fetchImpl:async target=>json(target.endsWith('/v1/models')?{data:[{id:image.id},{id:advanced.id}]}:{data:{models:[image,advanced]}})});
  const {data}=await client.catalog({piknoImageKey:cfg.piknoImageKey});
  assert.deepEqual(data[0].size_options,['1024x1024']);
  assert.deepEqual(data[0].quality_options,['auto']);
  assert.deepEqual(data[1].size_options,advanced.resolutions);
  assert.deepEqual(data[1].aspect_ratios,['auto','1:1','16:9']);
  assert.deepEqual(data[1].quality_options,['auto','low','medium','high']);
  assert.doesNotMatch(JSON.stringify(data),/secret-provider|pikno-image|flare|"price":/);
});

test('image submissions preserve explicit same-ratio sizes, auto and quality for generation and edit',async()=>{
  const calls=[],line={...image,resolutions:['auto','1024x1024','2048x2048','1536x864','3840x2160'],qualities:['auto','low','medium','high']};
  const client=createPiknoClient({fetchImpl:async(target,init)=>{calls.push({target,body:JSON.parse(init.body)});return json({data:[]});}});
  await client.submit(cfg,line,{aspect_ratio:'1:1',size:'2048x2048',quality:'high'});
  await client.submit(cfg,line,{aspect_ratio:'16:9',size:'3840x2160',quality:'medium',images:[{url:url+'?ticket=read'}]});
  await client.submit(cfg,line,{aspect_ratio:'auto',size:'auto',quality:'low'});
  assert.deepEqual(calls.map(call=>[call.body.size,call.body.quality,call.body.n]),[['2048x2048','high',1],['3840x2160','medium',1],['auto','low',1]]);
  assert.equal(calls[0].target,endpoint+'/v1/images/generations');
  assert.equal(calls[1].target,endpoint+'/v1/images/edits');
  assert.deepEqual(calls[1].body.images,[url+'?ticket=read']);
});

test('unsupported image size, mismatched ratio and undeclared quality fail before a paid call',()=>{
  const client=createPiknoClient({fetchImpl:()=>assert.fail('must not fetch')});
  for(const payload of [{size:'2048x2048'},{size:'auto'},{size:'1024x1024',aspect_ratio:'16:9'},{quality:'high'},{quality:'secret'}])assert.throws(()=>client.submit(cfg,image,payload));
});
test('invalid specs, unsigned media, foreign media and unsupported reference are rejected before submission',()=>{
  const client=createPiknoClient({fetchImpl:()=>assert.fail('must not fetch')});
  const base={duration:4,resolution:'720p',ratio:'16:9'};
  for(const patch of [{duration:5},{reference:'startEnd'},{images:[{url:'https://evil.test/media'}]},{images:[{url}]},{images:Array(10).fill({url:url+'?ticket=read'})}])assert.throws(()=>client.submit(cfg,video,{...base,...patch}));
});
test('ambiguous failures are not retried and never expose provider body or credentials',async()=>{
  for(const status of [408,500,502]){
    let calls=0;
    const client=createPiknoClient({fetchImpl:async()=>{calls++;return new Response('sanbao sk-leaked https://provider.test/private',{status});}});
    await assert.rejects(client.submit(cfg,video,{duration:4,resolution:'720p',ratio:'16:9'}),e=>e.ambiguous&&!/sanbao|sk-|provider/.test(e.message));
    assert.equal(calls,1);
  }
});
test('malformed successful submission and network loss are ambiguous, not resubmitted',async()=>{
  for(const fetchImpl of [async()=>new Response('not-json'),async()=>{throw Error('sk-do-not-print');}]){
    const client=createPiknoClient({fetchImpl});
    await assert.rejects(client.submit(cfg,video,{duration:4,resolution:'720p',ratio:'16:9'}),e=>e.ambiguous&&!/sk-/.test(e.message));
  }
});
function uploadFixture(overrides={}){
  const calls=[],expires=Math.floor(Date.now()/1000)+600;
  const client=createPiknoClient({fetchImpl:async(target,init)=>{
    calls.push({target:String(target),init});
    if(String(target).endsWith('/v1/media/uploads'))return json({id,method:'PUT',upload_url:url,upload_ticket:'upload-only',headers:{Authorization:'Bearer upload-only','Content-Type':'image/png'},expires_at:expires,...overrides});
    if(String(target)===url)return new Response(null,{status:204});
    return json({id,status:'ready',url:url+'?ticket=read-only',expires_at:expires});
  }});
  return {client,calls};
}
test('upload has three steps; PUT receives upload ticket only, complete receives original customer Key',async()=>{
  const {client,calls}=uploadFixture();
  const ready=await client.upload(cfg,Buffer.alloc(16),{contentType:'image/png',kind:'video'});
  assert.equal(calls.length,3);assert.equal(ready.file.url,url+'?ticket=read-only');
  assert.equal(new Headers(calls[0].init.headers).get('authorization'),'Bearer '+cfg.piknoVideoKey);
  assert.equal(calls[1].init.headers.Authorization,'Bearer upload-only');assert.equal(calls[1].init.redirect,'error');
  assert.equal(new Headers(calls[2].init.headers).get('authorization'),'Bearer '+cfg.piknoVideoKey);
  assert.doesNotMatch(JSON.stringify(ready),/image-test|video-test|upload-only/);
});
test('upload refuses foreign URL, stale ticket, query and header substitution before PUT',async()=>{
  for(const overrides of [{upload_url:'https://evil.test/'+id},{expires_at:1},{upload_url:url+'?ticket=wrong'},{headers:{Authorization:'Bearer '+cfg.piknoImageKey,'Content-Type':'image/png'}}]){
    const {client,calls}=uploadFixture(overrides);
    await assert.rejects(client.upload(cfg,Buffer.alloc(16),{contentType:'image/png'}));assert.equal(calls.length,1);
  }
});
test('bad mime/size and missing Key fail before file transfer',async()=>{
  const client=createPiknoClient({fetchImpl:()=>assert.fail('must not fetch')});
  for(const metadata of [{contentType:'text/html'},{contentType:'image/png',contentLength:11},{contentType:'image/png',contentLength:31<<20}])await assert.rejects(client.upload(cfg,Buffer.alloc(16),metadata));
  await assert.rejects(client.upload({},Buffer.alloc(16),{contentType:'image/png'}),e=>e.statusCode===401);
});

test('tool submissions require exact reference types and bounded audio before a paid request',async()=>{
  const calls=[],ref={url:url+'?ticket=read'};
  const client=createPiknoClient({fetchImpl:async(target,init)=>{calls.push({target,init});return json({id:'task_tool',status:'queued'});}});
  const digital={id:'pikno-tool-digital',kind:'video',max_images:1,max_videos:0,max_audio:1},depth={id:'pikno-tool-depth',kind:'video',max_images:0,max_videos:1,max_audio:0};
  for(const body of [{images:[ref],audios:[ref]},{images:[ref],audios:[{...ref,durationSeconds:30.001}]},{images:[],audios:[{...ref,durationSeconds:1}]},{images:[ref],audios:[{...ref,durationSeconds:0}]}])assert.throws(()=>client.submit(cfg,digital,body));
  assert.throws(()=>client.submit(cfg,depth,{videos:[]}));assert.throws(()=>client.submit(cfg,{...depth,id:'pikno-tool-unknown'},{videos:[ref]}));assert.equal(calls.length,0);
  assert.throws(()=>client.submit(cfg,depth,{videos:[ref.url]}));
  const tools={...cfg,piknoToolKey:'tool-test-only'};
  await assert.rejects(client.submit(cfg,digital,{images:[ref],audios:[{...ref,durationSeconds:30}]}),error=>error.statusCode===401);
  await client.submit(tools,digital,{images:[ref],audios:[{...ref,durationSeconds:30}]});
  await client.submit(tools,depth,{videos:[ref]});
  assert.deepEqual(calls.map(call=>call.target),[endpoint+'/v1/tools/digital',endpoint+'/v1/tools/depth']);
  assert.ok(calls.every(call=>new Headers(call.init.headers).get('authorization')==='Bearer '+tools.piknoToolKey));
});
test('redirects and absolute request routes cannot leak customer credentials',async()=>{
  const client=createPiknoClient({fetchImpl:async(_target,init)=>{assert.equal(init.redirect,'error');throw Error('redirect');}});
  for(const route of ['https://evil.test/v1/models','//evil.test/v1/models','/\\evil.test/v1/models'])await assert.rejects(client.request(cfg,'video',route));
  await assert.rejects(client.request(cfg,'video','/v1/models'));
  assert.throws(()=>createPiknoClient({endpoint:'http://evil.test'}));
});
