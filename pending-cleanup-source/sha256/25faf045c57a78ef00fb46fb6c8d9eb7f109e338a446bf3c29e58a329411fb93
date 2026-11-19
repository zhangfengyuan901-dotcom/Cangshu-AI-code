// Isolated contracts; all keys, identities and media URLs below are synthetic.
const {test}=require('node:test'),assert=require('node:assert/strict');
const {createPiknoClient,quoteParameters,validateRemoteQuote}=require('../pikno-client.cjs');
const line={id:'pikno-test-video',kind:'video',name:'已发布视频',max_images:30,max_videos:10,max_audio:10,resolutions:['720p'],ratios:['16:9'],durations:[4]};
const params={duration:4,resolution:'720p',ratio:'16:9',concurrency:1};
const media='https://www.piknoai.com/media/v1/assets/'+'a'.repeat(32)+'?ticket=synthetic';
test('declared 30-image capability preserves one reference but effective total rejects 21 or mixed overflow',async()=>{
  const calls=[],client=createPiknoClient({fetchImpl:async(url,init)=>{calls.push({url,init});if(url.endsWith('/api/pikno/catalog'))return Response.json({data:{models:[line]}});if(url.endsWith('/v1/models'))return Response.json({data:[{id:line.id}]});return Response.json({id:'test_task',status:'queued'});}});
  const cfg={piknoVideoKey:'synthetic'};
  const model=(await client.catalog(cfg)).data[0];assert.equal(model.max_images,30);assert.equal(model.max_media_total,20);assert.equal(model.max_media_files,20);
  assert.equal(quoteParameters(line,{...params,media_counts:{images:1,videos:0,audios:0}}).reference_images,1);
  assert.equal(quoteParameters(line,{...params,media_counts:{images:20,videos:0,audios:0}}).reference_images,20);
  for(const counts of [{images:21,videos:0,audios:0},{images:15,videos:5,audios:1}])assert.throws(()=>quoteParameters(line,{...params,media_counts:counts}),/总数最多20/);
  await client.submit(cfg,line,{...params,images:Array(20).fill({url:media})});
  const before=calls.length;
  for(const input of [{images:Array(21).fill({url:media})},{images:Array(15).fill({url:media}),videos:Array(5).fill({url:media}),audios:[{url:media}]}])assert.throws(()=>client.submit(cfg,line,{...params,...input}),/总数最多20/);
  assert.equal(calls.length,before);
  assert.throws(()=>quoteParameters({...line,max_media_total:4},{...params,media_counts:{images:5,videos:0,audios:0}}),/最多4/);
});
test('quote semantics reject a valid arithmetic result with the wrong meter or operation',()=>{
  const p=quoteParameters(line,params),q={quote_id:'opaque-synthetic-quote',name:'已发布视频',line_revision:1,currency:'CNY',unit:'second',unit_price_cny:'1',units:4,per_item_cny:'4',reference_surcharge_cny:'0',quantity:1,total_cny:'4',expires_at:Math.floor(Date.now()/1000)+300};
  assert.equal(validateRemoteQuote(q,p),q);
  for(const patch of [{unit:'image'},{units:3,per_item_cny:'3',total_cny:'3'},{operation:'depth'}])assert.throws(()=>validateRemoteQuote({...q,...patch},p),/计费规则/);
  const image={...p,operation:'image',seconds:0};assert.throws(()=>validateRemoteQuote({...q,unit:'image'},image),/计费规则/);
  const tool={...p,operation:'digital',seconds:0};assert.throws(()=>validateRemoteQuote({...q,unit:'request'},tool),/计费规则/);
});
test('historical tool GET may use another independently verified same-account Key; new tools never use it',async()=>{
  const calls=[],cfg={piknoUserId:7,piknoToolKey:'tool',piknoVideoKey:'video'};
  const client=createPiknoClient({fetchImpl:async(url,init)=>{
    const key=new Headers(init.headers).get('authorization').slice(7);calls.push({url,key,method:init.method||'GET'});
    if(url.endsWith('/v1/client/context'))return Response.json({user_id:7,group:key+'-standard'});
    if(key==='tool')return Response.json({error:'synthetic permission denied'},{status:403});
    return Response.json({id:'old_tool',status:'in_progress'});
  }});
  assert.equal((await client.query(cfg,{walletUser:'pikno:7',source:'depth',type:'video',id:'old_tool'})).id,'old_tool');
  assert.deepEqual(calls.map(c=>[new URL(c.url).pathname,c.key]),[['/v1/client/context','tool'],['/v1/videos/old_tool','tool'],['/v1/client/context','video'],['/v1/videos/old_tool','video']]);
  assert.ok(calls.every(c=>c.method==='GET'));
  await assert.rejects(client.query(cfg,{walletUser:'pikno:8',id:'old_tool'}),e=>e.statusCode===401);assert.equal(calls.length,4);
  assert.throws(()=>client.submit({piknoVideoKey:'video'},{id:'pikno-tool-depth',kind:'video',max_videos:1},{videos:[]}),/完整素材/);
});
test('history cannot use a foreign identity or bypass all explicit denials',async()=>{
  for(const foreign of [true,false]){
    const calls=[],client=createPiknoClient({fetchImpl:async(url,init)=>{calls.push(url);return url.endsWith('/context')?Response.json({user_id:foreign?8:7,group:new Headers(init.headers).get('authorization').includes('tool')?'tool-standard':'video-standard'}):Response.json({error:'denied'},{status:403});}});
    await assert.rejects(client.query({piknoUserId:7,piknoToolKey:'tool',piknoVideoKey:'video'},{walletUser:'pikno:7',source:'depth',id:'old'}),e=>e.statusCode===(foreign?409:403));
    assert.equal(calls.filter(c=>c.includes('/v1/videos/')).length,foreign?0:2);
  }
});
test('in-flight catalog reads coalesce without caching permission decisions; invalidate removes capability cache',async()=>{
  const calls=[],cfg={piknoImageKey:'image',piknoVideoKey:'video',piknoToolKey:'tool'};let allowed=true;
  const client=createPiknoClient({fetchImpl:async(url,init)=>{calls.push({url,auth:new Headers(init.headers).get('authorization')});await new Promise(resolve=>setTimeout(resolve,10));return url.endsWith('/catalog')?Response.json({data:{models:[line]}}):Response.json({data:allowed?[{id:line.id}]:[]});}});
  await Promise.all([client.catalog(cfg),client.catalog(cfg),client.catalog(cfg)]);
  assert.equal(calls.filter(c=>c.url.endsWith('/catalog')).length,1);assert.equal(calls.filter(c=>c.url.endsWith('/models')).length,3);
  allowed=false;assert.equal((await client.catalog(cfg)).data.length,0);assert.equal(calls.filter(c=>c.url.endsWith('/models')).length,6);
  client.invalidate();await client.catalog(cfg);assert.equal(calls.filter(c=>c.url.endsWith('/catalog')).length,2);
});
test('tool preflight distinguishes a published but forbidden product from an unpublished product without uploads',async()=>{
  const calls=[],depth={...line,id:'pikno-tool-depth'},client=createPiknoClient({fetchImpl:async(url,init)=>{calls.push({url,method:init.method||'GET'});return url.endsWith('/catalog')?Response.json({data:{models:[depth]}}):Response.json({data:[]});}});
  const catalog=await client.catalog({piknoToolKey:'synthetic-tool'});
  assert.deepEqual(catalog.toolStates,{digital:'unpublished',depth:'forbidden'});assert.deepEqual(catalog.data,[]);assert.ok(calls.every(c=>c.method==='GET'));
});
