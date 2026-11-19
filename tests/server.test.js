const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp: createServerApp, createSmartVideoLauncher, findSmartVideoDir } = require('../server.js');
// Never read or poll the user's durable tasks in proxy/unit tests.
const qaTaskRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hamster-proxy-tasks-'));
after(() => fs.rmSync(qaTaskRoot,{recursive:true,force:true}));
let qaTaskIndex = 0;
const createApp = options => createServerApp({taskDir:path.join(qaTaskRoot,String(++qaTaskIndex)),diagnosticsDir:path.join(qaTaskRoot,'diagnostics'),...options});

const RH_PATH = '/openapi/v2';

const FETCH_BLOCKED_PORTS = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79,
  87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137,
  139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532, 540,
  548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723, 2049,
  3659, 4045, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6697, 10080,
]);
function listen(server) {
  return new Promise((resolve, reject) => {
    const bind = () => server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      if (!FETCH_BLOCKED_PORTS.has(port)) return resolve(port);
      server.close(bind);
    });
    server.once('error', reject);
    bind();
  });
}
function readBody(req) {
  return new Promise((resolve) => {
    const c = [];
    req.on('data', (x) => c.push(x));
    req.on('end', () => resolve(Buffer.concat(c)));
  });
}
function postJson(url, payload) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const body = Buffer.from(JSON.stringify(payload));
    const req = http.request({
      hostname: target.hostname,
      port: target.port,
      path: target.pathname + target.search,
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': body.length },
    }, (res) => {
      readBody(res).then((data) => resolve({ status: res.statusCode, data: JSON.parse(data.toString('utf8')) }), reject);
    });
    req.on('error', reject);
    req.end(body);
  });
}
/* 启动一个回显上游，返回 {port, close} */
async function startEcho(handler) {
  const server = http.createServer(async (req, res) => {
    const body = await readBody(req);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(handler(req, body)));
  });
  const port = await listen(server);
  return { port, close: () => server.close() };
}
function tmpConfig(name) {
  const p = path.join(os.tmpdir(), `hamster-${name}-${process.pid}.json`);
  try { fs.unlinkSync(p); } catch { /* 不存在即可 */ }
  return p;
}
function cleanupFile(p) { try { fs.unlinkSync(p); } catch { /* 忽略 */ } }

/* ---------------- 静态托管 ---------------- */

test('serves / as index.html', async (t) => {
  const app = createApp();
  t.after(() => app.close());
  const port = await listen(app);
  const res = await fetch(`http://localhost:${port}/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
  const html = await res.text();
  assert.match(html, /<title>/);
  assert.match(html, /id="storageStatus"/);
  assert.doesNotMatch(html, /storageStatusText/);
});

test('all credit badges are removed and composer includes shared asset picker', async (t) => {
  const app = createApp();
  t.after(() => app.close());
  const port = await listen(app);
  const html = await (await fetch(`http://localhost:${port}/`)).text();
  const js = await (await fetch(`http://localhost:${port}/app.js`)).text();
  const uploadState = await (await fetch(`http://localhost:${port}/media-upload-state.mjs`)).text();
  const assetsJs = await (await fetch(`http://localhost:${port}/asset-library.mjs`)).text();
  const styles = await (await fetch(`http://localhost:${port}/styles.css`)).text();
  assert.match(html, /billingAvailable|余额/);
  assert.match(html, /视频生成（主线路）/);
  assert.match(html, /邮箱注册 \/ 登录/);
  assert.doesNotMatch(html, /apiKeyInput|videoApiKeyInput|rhKeyInput/);
  assert.doesNotMatch(html, /VideoFee|Seedance|三宝|sanbaobeauty|Cloudflare|\bR2\b|doubao-seedance/i);
  assert.match(js, /视频生成（主线路）/);
  assert.match(js, /官方视频生成（备选线路）/);
  assert.doesNotMatch(js, /VideoFee API Key|Seedance 2\.5 480P|X-VideoFee-Key/i);
  assert.doesNotMatch(js, /request\(['"]\/me['"]\)|loadAccount|extractCredits/);
  assert.doesNotMatch(html, /id="costPreview"/);
  assert.doesNotMatch(js, /costPreview|estimateCost/);
  assert.doesNotMatch(html, /dhCostPreview|depthCostPreview|data-lucide="zap"|digital-cost/);
  assert.doesNotMatch(js, /CostPreview|⚡/);
  assert.match(html, /id="assetTile"/);
  for(const id of ['dhImageAsset','dhAudioAsset','depthVideoAsset'])assert.match(html,new RegExp(`id="${id}"`));
  assert.match(js, /pickAsset\(\{category:'talent'\}\)/);
  assert.match(js, /\/upload\?use=video/);
  assert.doesNotMatch(html, /id="workbenchButton"[^>]*disabled/);
  assert.match(js, /requestIdleCallback\(prewarm,\{timeout:3000\}\)/);
  assert.match(js, /Promise\.allSettled\(startupLoads\)/);
  assert.match(js, /if\(!workbenchReady\)[\s\S]*await prepareWorkbench\(\)/);
  assert.doesNotMatch(html, /reverseCostPreview|data-view="reverse"/);
  assert.ok(html.indexOf('workbenchButton') < html.indexOf('data-view="digital"'));
  assert.doesNotMatch(html, /id="(?:smartVideoButton|creativeButton|chatButton)"/);
  assert.match(html, /验证并进入账户/);
  assert.match(js, /state\.type === 'image'[\s\S]*\/upload-direct/);
  assert.doesNotMatch(js, /await local\.blob\(\)/);
  assert.doesNotMatch(js, /const buf = await file\.arrayBuffer\(\)/);
  assert.match(js, /xhr\.upload\.onprogress/);
  assert.match(js, /xhr\.send\(file\)/);
  assert.match(js, /const uploadReuse = new Map\(\)/);
  assert.match(js, /uploadReuse\.get\(cacheKey\)/);
  assert.match(js, /createUploadGate/);
  assert.match(uploadState, /file\.arrayBuffer\(\)/);
  assert.match(js, /card\.replaceChildren\(\.\.\.next\.childNodes\)/);
  assert.doesNotMatch(js, /card\.replaceWith\(next\)/);
  assert.match(js, /data-copy-task-prompt/);
  assert.match(js, /copyTaskPrompt\(task\?\.prompt\)/);
  assert.match(js, /direct \? '\/uploads\/direct' : '\/uploads\/raw'/);
  assert.match(js, /Prefer: 'respond-async'/);
  assert.match(js, /acceptLocalTask\(created\)/);
  assert.match(js, /const HISTORY_BATCH_SIZE = 40/);
  assert.match(js, /const MODEL_CACHE_TTL = 6 \* 60 \* 60 \* 1000/);
  assert.match(js, /const inflightGets = new Map\(\)/);
  assert.match(js, /request\('\/startup'\)/);
  assert.doesNotMatch(js, /setInterval\(\(\) => void checkStorageStatus\(\), 60000\)/);
  assert.match(js, /connected \? 5\*60\*1000/);
  assert.match(js, /const taskFeedLimits = \{ generate: HISTORY_BATCH_SIZE/);
  assert.match(js, /new Map\(cards\.map/);
  assert.match(js, /data-task-more/);
  assert.match(js, /data-history-more/);
  assert.match(js, /data-media-key/);
  assert.doesNotMatch(js, /list\.innerHTML = uploaded \+ pending/);
  assert.match(html, /id="globalImageEdit"/);
  assert.match(html, /id="imageEditUpload"/);
  assert.match(js, /data-edit-media/);
  assert.match(js, /loadImageEditSource\(file\)/);
  assert.match(assetsJs, /onEdit && item\.kind === "image"/);
  assert.match(js, /preload="none"/);
  assert.match(assetsJs, /const ASSET_BATCH_SIZE = 48/);
  assert.match(assetsJs, /const ASSET_CACHE_TTL = 5 \* 60 \* 1000/);
  assert.match(assetsJs, /const assetInflight = new Map\(\)/);
  assert.match(assetsJs, /media\.preload = "none"/);
  assert.match(assetsJs, /audio\/mpeg,audio\/wav,audio\/mp4,audio\/aac/);
  assert.match(assetsJs, /new IntersectionObserver/);
  assert.match(assetsJs, /previewObserver\.observe\(media\)/);
  assert.match(assetsJs, /media\.fetchPriority = "low"/);
  assert.doesNotMatch(assetsJs, /grid\.replaceChildren\(\)/);
  assert.match(js, /card\.replaceChildren\(\.\.\.next\.childNodes\)/);
  assert.match(styles, /content-visibility: auto/);
});

test('startup combines safe config state with live asset counts', async (t) => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'hamster-startup-'));
  const configPath=path.join(root,'config.json'),assetDir=path.join(root,'assets'),resultDir=path.join(root,'results');
  fs.mkdirSync(resultDir);fs.writeFileSync(configPath,JSON.stringify({apiKey:'private-generation-key',llmApiKey:'legacy-model-key',llmEndpointId:'ep-legacy-test'}));
  const app=createApp({configPath,assetDir,resultDir});
  t.after(()=>{app.close();fs.rmSync(root,{recursive:true,force:true});});
  const base=`http://127.0.0.1:${await listen(app)}`;
  let response=await fetch(base+'/api/startup'),data=await response.json();
  assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');
  assert.deepEqual(data.config,{configured:true,videoConfigured:false,rhConfigured:false,llmConfigured:true,inferenceMode:'cloud-auto'});
  const migrated=JSON.parse(fs.readFileSync(configPath));
  assert.equal(migrated.apiKey,'private-generation-key');
  assert.equal(migrated.llmApiKey,undefined);assert.equal(migrated.llmEndpointId,undefined);
  assert.deepEqual(data.assets,{total:0,counts:{talent:0,product:0,scene:0}});
  assert.doesNotMatch(JSON.stringify(data),/private-/);
  const png=fs.readFileSync(path.join(__dirname,'../public/hamster-logo.png'));
  response=await fetch(base+'/api/assets/import?category=talent&name=talent.png',{method:'POST',body:png});assert.equal(response.status,201);
  data=await (await fetch(base+'/api/startup')).json();assert.deepEqual(data.assets,{total:1,counts:{talent:1,product:0,scene:0}});
  assert.equal((await fetch(base+'/api/startup',{method:'POST'})).status,405);
});

/* ---------------- 图片/视频 OpenAPI 代理 ---------------- */

test('image generation accepts all current image routes and preserves upstream payload', async (t) => {
  let hits=0;
  const up=await startEcho((req,body)=>{hits++;return {body:JSON.parse(body.toString())};});
  const app=createApp({upstream:`http://localhost:${up.port}`});
  t.after(()=>{app.close();up.close();});
  const port=await listen(app);
  for(const model of ['removed-image']) {
    const result=await fetch(`http://localhost:${port}/api/images`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({model})});
    assert.equal(result.status,400);
  }
  assert.equal(hits,0);
  for(const model of ['image_2_5_flare','image_2_5_sunburst','gpt-image2','gpt-image2-1K','gpt-image2-2K','gpt-image2-4K']) {
    const result=await fetch(`http://localhost:${port}/api/images`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({model,quality:'auto'})});
    assert.equal(result.status,200);
    assert.deepEqual((await result.json()).body,{model,quality:'auto'});
  }
});

test('proxies POST /api/videos to upstream /openapi/v1/videos with auth+body', async (t) => {
  const up = await startEcho((req, body) => ({
    method: req.method, url: req.url, auth: req.headers.authorization, body: body.toString(),
  }));
  const app = createApp({ upstream: `http://localhost:${up.port}` });
  t.after(() => { app.close(); up.close(); });
  const port = await listen(app);

  const res = await fetch(`http://localhost:${port}/api/videos`, {
    method: 'POST',
    headers: { authorization: 'Bearer sk_test', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'sd_2_5_once_720p', prompt: 'hi' }),
  });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.url, '/openapi/v1/videos');
  assert.equal(data.method, 'POST');
  assert.equal(data.auth, 'Bearer sk_test');
  assert.equal(data.body, '{"model":"sd_2_5_once_720p","prompt":"hi"}');
});

test('accepts both SD2.5 per-generation full-reference routes at their documented limits', async (t) => {
  const bodies=[];
  const up = await startEcho((req, raw) => { bodies.push(JSON.parse(raw.toString())); return { ok: true }; });
  const app = createApp({ upstream: `http://localhost:${up.port}` });
  t.after(() => { app.close(); up.close(); });
  const port = await listen(app);
  for (const model of ['sd_2_5_once_720p','sd_2_5_once_line3']) {
    const payload={model,resolution:'720p',ratio:'9:16',duration:30,
      images:Array(30).fill('image'),videos:Array(10).fill('video'),audios:Array(10).fill('audio')};
    assert.equal((await postJson(`http://localhost:${port}/api/videos`,payload)).status,200);
    assert.deepEqual(bodies.at(-1),payload);
  }
});

test('accepts the fixed 30-second image-only route and rejects incompatible options',async t=>{
  let calls=0;
  const up=await startEcho(()=>{calls++;return {ok:true};});
  const app=createApp({upstream:`http://localhost:${up.port}`});t.after(()=>{app.close();up.close();});
  const port=await listen(app),base={model:'sd_2_5_900_30s',resolution:'720p',ratio:'16:9',duration:30,images:Array(9).fill('image')};
  assert.equal((await postJson(`http://localhost:${port}/api/videos`,base)).status,200);
  for(const invalid of [{...base,duration:15},{...base,resolution:'480p'},{...base,videos:['video']},{...base,audios:['audio']},{...base,images:Array(10).fill('image')}])
    assert.equal((await postJson(`http://localhost:${port}/api/videos`,invalid)).status,400);
  assert.equal(calls,1);
});

test('official backup video generation maps the public route to the internal provider model', async (t) => {
  let received;
  const up=await startEcho((req,body)=>{
    received={method:req.method,url:req.url,auth:req.headers.authorization,idempotency:req.headers['idempotency-key'],body:JSON.parse(body.toString())};
    return {id:'vf-task-1',task_id:'vf-task-1',status:'queued'};
  });
  const app=createApp({officialVideoUpstream:`http://localhost:${up.port}`});
  t.after(()=>{app.close();up.close();});
  const port=await listen(app);
  const payload={model:'official_backup_480p',prompt:'官方线路测试',resolution:'480p',ratio:'9:16',duration:5,reference:'all',
    images:[{url:'https://r2.example/a.png'}],videos:[{url:'https://r2.example/b.mp4'}],audios:[{url:'https://r2.example/c.mp3'}]};
  const response=await fetch(`http://localhost:${port}/api/official-videos`,{method:'POST',headers:{'content-type':'application/json','x-hamster-official-key':'vf-secret','idempotency-key':'official-order-1'},body:JSON.stringify(payload)});
  assert.equal(response.status,200);
  assert.equal(received.method,'POST');assert.equal(received.url,'/v1/video/generations');
  assert.equal(received.auth,'Bearer vf-secret');assert.equal(received.idempotency,'official-order-1');
  assert.deepEqual(received.body,{model:'doubao-seedance-2-5',duration:5,resolution:'480p',ratio:'9:16',content:[
    {type:'text',text:'官方线路测试'},
    {type:'image_url',role:'reference_image',image_url:{url:'https://r2.example/a.png'}},
    {type:'video_url',role:'reference_video',video_url:{url:'https://r2.example/b.mp4'}},
    {type:'audio_url',role:'reference_audio',audio_url:{url:'https://r2.example/c.mp3'}},
  ]});
});

test('official video generation rejects other models, qualities and excess media locally',async t=>{
  let calls=0;
  const up=await startEcho(()=>{calls++;return {id:'unexpected'};});
  const app=createApp({officialVideoUpstream:`http://localhost:${up.port}`});
  t.after(()=>{app.close();up.close();});
  const port=await listen(app),base={model:'official_backup_480p',prompt:'test',resolution:'480p',ratio:'16:9',duration:4};
  for(const payload of [
    {...base,model:'removed-provider-route'},
    {...base,resolution:'720p'},
    {...base,duration:31},
    {...base,images:Array(10).fill({url:'https://r2.example/a.png'})},
    {...base,videos:Array(4).fill({url:'https://r2.example/a.mp4'})},
    {...base,audios:Array(4).fill({url:'https://r2.example/a.mp3'})},
    {...base,images:[{url:'file:///private/a.png'}]},
  ]) assert.equal((await postJson(`http://localhost:${port}/api/official-videos`,payload)).status,400);
  assert.equal(calls,0);
});

test('rejects removed video routes and excess media before reaching upstream', async (t) => {
  let calls = 0;
  const up = await startEcho(() => { calls++; return {}; });
  const app = createApp({ upstream: `http://localhost:${up.port}` });
  t.after(() => { app.close(); up.close(); });
  const port = await listen(app);
  for (const payload of [
    { model: 'sd2_9img_full' },
    { model: 'hailuo_h3_2k_line2' },
    { model: 'sd_2_5_once_720p', images: Array(31).fill('url') },
    { model: 'sd_2_5_once_720p', videos: Array(11).fill('url') },
    { model: 'sd_2_5_once_line3', audios: Array(11).fill('url') },
    { model: 'sd_2_5_once_720p', resolution: '480p' },
    { model: 'sd_2_5_once_line3', resolution: '1080p' },
    { model: 'sd_2_5_once_line3', ratio: 'adaptive' },
    { model: 'sd_2_5_once_line3', duration: 31 },
    { model: 'sd_2_5_once_line3', images: 'invalid' },
  ]) {
    const response = await postJson(`http://localhost:${port}/api/videos`, payload);
    assert.equal(response.status, 400);
  }
  assert.equal(calls, 0);
});

test('uploads material to the configured R2 bridge', async (t) => {
  let received;
  const app = createApp({ mediaUploader: async (body, metadata) => {
    const chunks=[];for await(const chunk of body)chunks.push(chunk);
    received = { body: Buffer.concat(chunks).toString('hex'), ...metadata };
    return { file: { url: 'https://media.example/media/test.jpg' } };
  } });
  t.after(() => { app.close(); });
  const port = await listen(app);

  const res = await fetch(`http://localhost:${port}/api/uploads/raw?kind=image&fileName=a.jpg`, {
    method: 'POST',
    headers: { authorization: 'Bearer sk_test', 'content-type': 'image/jpeg' },
    body: new Uint8Array([1, 2, 3]),
  });
  const data = await res.json();
  assert.equal(data.file.url, 'https://media.example/media/test.jpg');
  assert.deepEqual(received, { body: '010203', contentType: 'image/jpeg', contentLength:3, fileName: 'a.jpg' });
});

test('streams R2 material before the browser finishes sending', async (t) => {
  let firstChunk;
  const sawFirstChunk=new Promise(resolve=>{firstChunk=resolve;});
  const app=createApp({mediaUploader:async body=>{
    let size=0;
    for await(const chunk of body){size+=chunk.length;firstChunk();}
    return {file:{url:'https://media.example/tmp/stream.mp4'},size};
  }});
  t.after(()=>app.close());
  const port=await listen(app);
  const result=new Promise((resolve,reject)=>{
    const request=http.request({hostname:'127.0.0.1',port,path:'/api/uploads/raw?kind=video&fileName=stream.mp4',method:'POST',headers:{'content-type':'video/mp4','content-length':6}},response=>readBody(response).then(body=>resolve({status:response.statusCode,payload:JSON.parse(body)}),reject));
    request.on('error',reject);request.write(Buffer.from('abc'));
    sawFirstChunk.then(()=>request.end(Buffer.from('def')),reject);
  });
  const response=await result;
  assert.equal(response.status,200);assert.equal(response.payload.size,6);
});

test('image generation uploads reference images directly to Sanbao instead of R2', async (t) => {
  let r2Calls=0;
  const up=await startEcho((req,body)=>({
    url:req.url,
    auth:req.headers.authorization,
    xkey:req.headers['x-api-key'],
    contentType:req.headers['content-type'],
    body:[...body],
    file:{url:'https://sanbaobeauty.com/uploads/direct.jpg'},
  }));
  const app=createApp({
    upstream:`http://localhost:${up.port}`,
    mediaUploader:async()=>{r2Calls++;return {file:{url:'https://media.example/r2.jpg'}};},
  });
  t.after(()=>{app.close();up.close();});
  const port=await listen(app);
  const res=await fetch(`http://localhost:${port}/api/uploads/direct?kind=image&fileName=reference.jpg`,{
    method:'POST',
    headers:{authorization:'Bearer sk_direct','content-type':'image/jpeg'},
    body:new Uint8Array([7,8,9]),
  });
  assert.equal(res.status,200);
  const data=await res.json();
  assert.equal(data.url,'/openapi/v1/uploads/raw?kind=image&fileName=reference.jpg');
  assert.equal(data.auth,'Bearer sk_direct');
  assert.equal(data.xkey,'sk_direct');
  assert.equal(data.contentType,'image/jpeg');
  assert.deepEqual(data.body,[7,8,9]);
  assert.equal(r2Calls,0);
});

test('direct upload endpoint rejects non-image material before reaching upstream', async (t) => {
  let upstreamCalls=0;
  const up=await startEcho(()=>{upstreamCalls++;return {};});
  const app=createApp({upstream:`http://localhost:${up.port}`});
  t.after(()=>{app.close();up.close();});
  const port=await listen(app);
  const res=await fetch(`http://localhost:${port}/api/uploads/direct?kind=video&fileName=clip.mp4`,{
    method:'POST',headers:{'content-type':'video/mp4'},body:new Uint8Array([1]),
  });
  assert.equal(res.status,415);
  assert.equal(upstreamCalls,0);
});

test('streaming upload requires a trustworthy content length before contacting upstream', async (t) => {
  let upstreamCalls=0,r2Calls=0;
  const up=await startEcho(()=>{upstreamCalls++;return {};});
  const app=createApp({upstream:`http://localhost:${up.port}`,mediaUploader:async()=>{r2Calls++;return {};}});
  t.after(()=>{app.close();up.close();});
  const port=await listen(app);
  const send=path=>new Promise((resolve,reject)=>{
    const request=http.request({hostname:'127.0.0.1',port,path,method:'POST',headers:{'content-type':path.includes('direct')?'image/jpeg':'video/mp4','transfer-encoding':'chunked'}},response=>{response.resume();response.on('end',()=>resolve(response.statusCode));});
    request.on('error',reject);request.end(Buffer.from('abc'));
  });
  assert.equal(await send('/api/uploads/direct?kind=image&fileName=x.jpg'),411);
  assert.equal(await send('/api/uploads/raw?kind=video&fileName=x.mp4'),411);
  assert.equal(upstreamCalls,0);assert.equal(r2Calls,0);
});

test('reports the real object storage connection state for the title-bar indicator', async (t) => {
  const app = createApp({ mediaChecker: async () => ({ connected: true, service: 'fixture-r2' }) });
  t.after(() => { app.close(); });
  const port = await listen(app);
  const res = await fetch(`http://localhost:${port}/api/uploads/status`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { connected: true, service: 'fixture-r2' });
});

test('deletes unused R2 material through the configured bridge', async (t) => {
  let deleted;
  const app = createApp({ mediaDeleter: async (keys) => {
    deleted = keys;
    return { deleted: keys.length };
  } });
  t.after(() => { app.close(); });
  const port = await listen(app);
  const res = await fetch(`http://localhost:${port}/api/uploads/raw`, {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ keys: ['tmp/2026/09/16/test.jpg'] }),
  });
  assert.equal(res.status, 200);
  assert.deepEqual(deleted, ['tmp/2026/09/16/test.jpg']);
  assert.equal((await res.json()).deleted, 1);
});

test('accepts Expect on raw uploads and sends the complete body to R2', async (t) => {
  let size = 0;
  const app = createApp({ mediaUploader: async (body) => {
    for await(const chunk of body)size+=chunk.length;
    return { file: { url: 'https://media.example/media/expect.jpg' } };
  } });
  t.after(() => { app.close(); });
  const port = await listen(app);
  const body = Buffer.alloc(2048, 1);
  const data = await new Promise((resolve, reject) => {
    const req = http.request({
      hostname: 'localhost', port,
      path: '/api/uploads/raw?kind=image&fileName=expect.jpg',
      method: 'POST',
      headers: { 'content-type': 'image/jpeg', 'content-length': body.length, expect: '100-continue' },
    }, (res) => readBody(res).then((value) => resolve(JSON.parse(value.toString('utf8'))), reject));
    req.on('continue', () => req.end(body));
    req.on('error', reject);
    req.flushHeaders();
  });
  assert.equal(data.file.url, 'https://media.example/media/expect.jpg');
  assert.equal(size, body.length);
});

test('streams direct image upload upstream before the browser finishes sending', async (t) => {
  let firstChunk;
  const sawFirstChunk=new Promise(resolve=>{firstChunk=resolve;});
  const upstream=http.createServer((req,res)=>{
    const chunks=[];
    req.on('data',chunk=>{chunks.push(chunk);firstChunk();});
    req.on('end',()=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({file:{url:'https://sanbaobeauty.com/uploads/stream.jpg'},size:Buffer.concat(chunks).length}));});
  });
  const upstreamPort=await listen(upstream);
  const app=createApp({upstream:`http://127.0.0.1:${upstreamPort}`});
  t.after(()=>{app.close();upstream.close();});
  const port=await listen(app);
  const result=new Promise((resolve,reject)=>{
    const request=http.request({hostname:'127.0.0.1',port,path:'/api/uploads/direct?kind=image&fileName=stream.jpg',method:'POST',headers:{authorization:'Bearer sk_stream','content-type':'image/jpeg','content-length':6}},response=>readBody(response).then(body=>resolve({status:response.statusCode,payload:JSON.parse(body)}),reject));
    request.on('error',reject);request.write(Buffer.from('abc'));
    sawFirstChunk.then(()=>request.end(Buffer.from('def')),reject);
  });
  const response=await result;
  assert.equal(response.status,200);assert.equal(response.payload.size,6);
});

test('proxies /api/public-models to upstream public models endpoint', async (t) => {
  const up = await startEcho((req) => ({ url: req.url }));
  const app = createApp({ upstream: `http://localhost:${up.port}` });
  t.after(() => { app.close(); up.close(); });
  const port = await listen(app);

  const res = await fetch(`http://localhost:${port}/api/public-models`);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.url, '/api/public/openapi-models');
});

test('proxy falls back to config.json apiKey when no auth header', async (t) => {
  const cfg = tmpConfig('config');
  fs.writeFileSync(cfg, JSON.stringify({ apiKey: 'sk_from_config' }));
  const up = await startEcho((req) => ({ auth: req.headers.authorization, xkey: req.headers['x-api-key'] }));
  const app = createApp({ upstream: `http://localhost:${up.port}`, configPath: cfg });
  t.after(() => { app.close(); up.close(); cleanupFile(cfg); });
  const port = await listen(app);

  const data = await (await fetch(`http://localhost:${port}/api/models`)).json();
  assert.equal(data.auth, 'Bearer sk_from_config');
  assert.equal(data.xkey, 'sk_from_config', '图片/视频兼容 X-API-Key 头');
});

test('downloads generated result into configured local result directory', async (t) => {
  const bytes = Buffer.from([137, 80, 78, 71, 1, 2, 3]);
  const resultUpstream = http.createServer((req, res) => {
    res.setHeader('content-type', 'image/png');
    res.end(bytes);
  });
  const resultPort = await listen(resultUpstream);
  const resultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hamster-results-'));
  const app = createApp({ resultDir });
  t.after(() => {
    app.close();
    resultUpstream.close();
    fs.rmSync(resultDir, { recursive: true, force: true });
  });
  const port = await listen(app);

  const res = await postJson(`http://localhost:${port}/api/save-result`, {
    url: `http://localhost:${resultPort}/generated`,
    outputType: 'png',
    taskId: 'task_123',
  });
  assert.equal(res.status, 200);
  const data = res.data;
  assert.equal(data.ok, true);
  assert.match(data.fileName, /^仓鼠-\d+-task_123\.png$/);
  assert.equal(path.dirname(data.localPath), resultDir);
  assert.deepEqual(fs.readFileSync(data.localPath), bytes);
});

/* ---------------- 智能成片本地服务 ---------------- */

test('finds the bundled smart video workflow without environment setup', () => {
  const workflowDir = path.join(__dirname, '..', 'smart-video-agent');
  assert.equal(findSmartVideoDir(workflowDir), workflowDir);
});

test('uses the bundled uv launcher when the workflow virtual environment is absent', async () => {
  const workflowDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hamster-smart-video-'));
  fs.writeFileSync(path.join(workflowDir, 'web.py'), '');
  fs.writeFileSync(path.join(workflowDir, 'studio.py'), '');
  fs.writeFileSync(path.join(workflowDir, 'pyproject.toml'), '');
  fs.mkdirSync(path.join(workflowDir, 'bin'));
  const bundledUv = path.join(workflowDir, 'bin', 'uv.exe');
  fs.writeFileSync(bundledUv, '');
  let spawned;
  const child = new (require('node:events').EventEmitter)();
  child.exitCode = null;
  const launcher = createSmartVideoLauncher({
    workflowDir,
    fetchImpl: async () => { throw new Error('not ready'); },
    portProbe:async()=>({state:'available',port:8000}),
    spawnImpl: (command, args, options) => {
      spawned = { command, args, options };
      return child;
    },
  });

  assert.equal((await launcher.open()).status, 'starting');
  assert.equal(spawned.command, bundledUv);
  assert.deepEqual(spawned.args, ['run', 'python', 'web.py', '--port', '8000']);
  assert.equal(spawned.options.cwd, workflowDir);
  assert.equal(spawned.options.env.PYTHONPATH.split(path.delimiter)[0], workflowDir);
  fs.rmSync(workflowDir, { recursive: true, force: true });
});

test('opens the retained chat page while the creative capability is retired', async () => {
  let openedUrl = '';
  const launcher = createSmartVideoLauncher({
    fetchImpl: async () => ({ status: 200, json: async () => ({ app: 'hamster-smart-video', version:26, chat: true, creative:false }) }),
    openExternal: (url) => { openedUrl = url; },
  });

  const result = await launcher.open();
  assert.equal(result.status, 'ready');
  assert.equal(result.url, 'http://127.0.0.1:8000/chat/');
  assert.equal(openedUrl, result.url);
});

test('does not treat an unrelated or legacy local server as the studio', async () => {
  const launcher = createSmartVideoLauncher({
    fetchImpl: async () => ({ status: 200, json: async () => ['app', 'bin'] }),
  });

  assert.equal((await launcher.status()).status, 'stopped');
});

test('chat launcher requires the chat capability without requiring creative', async () => {
  let opened = '';
  let supported = true;
  const launcher = createSmartVideoLauncher({
    fetchImpl: async () => ({status:200,json:async()=>({app:'hamster-smart-video',version:26,creative:false,chat:supported})}),
    openExternal: url => {opened=url;},
  });
  assert.equal((await launcher.open('chat')).status,'ready');
  assert.equal(opened,'http://127.0.0.1:8000/chat/');
  supported=false; opened='';
  assert.equal((await launcher.open('chat')).status,'error');
  assert.equal(opened,'');
});

test('retired creative launcher target does not check health, spawn a service or open a browser', async () => {
  const launcher = createSmartVideoLauncher({
    fetchImpl: async () => assert.fail('retired target must not request service health'),
    spawnImpl: () => assert.fail('retired target must not spawn a service'),
    openExternal: () => assert.fail('retired target must not open a browser'),
  });
  const result = await launcher.open(true);
  assert.equal(result.status, 'error');
  assert.match(result.message, /已停用/);
});

test('retired creative HTTP endpoints cannot invoke a launcher, create tasks or proxy upstream', async t => {
  const taskDir = path.join(qaTaskRoot, 'retired-creative');
  const configPath = tmpConfig('retired-creative');
  let proxied = 0;
  const upstream = await startEcho(() => { proxied++; return {}; });
  t.after(() => upstream.close());
  const unavailable = async () => assert.fail('retired API must not invoke the chat launcher');
  const app = createApp({configPath, taskDir, upstream:`http://127.0.0.1:${upstream.port}`,
    smartVideoLauncher:{open:unavailable, status:unavailable, prepare:unavailable}});
  t.after(() => {app.close();cleanupFile(configPath);});
  const port = await listen(app);
  assert.equal(fs.existsSync(taskDir), false);
  for (const route of ['/api/creative/open', '/api/creative/status']) {
    for (const method of ['GET','POST']) {
      const response = await fetch(`http://127.0.0.1:${port}${route}`, {method});
      assert.equal(response.status, 410);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.match((await response.json()).error, /已停用/);
    }
  }
  assert.equal(proxied, 0);
  assert.equal(fs.existsSync(taskDir), false);
  assert.deepEqual((await (await fetch(`http://127.0.0.1:${port}/api/tasks`)).json()).tasks, []);
});

test('removed smart video endpoints are unavailable', async (t) => {
  let opened = 0;
  const smartVideoLauncher = {
    open: async () => { opened += 1; return { status: 'ready', url: 'http://127.0.0.1:8000/' }; },
    status: async () => ({ status: 'ready', url: 'http://127.0.0.1:8000/' }),
  };
  const app = createApp({ smartVideoLauncher });
  t.after(() => app.close());
  const port = await listen(app);

  assert.equal((await fetch(`http://localhost:${port}/api/smart-video/open`, { method: 'POST' })).status, 404);
  assert.equal((await fetch(`http://localhost:${port}/api/smart-video/status`)).status, 404);
  assert.equal(opened, 0);
});

test('chat uses its dedicated launcher target and does not proxy to generation upstream', async (t) => {
  let target;
  const smartVideoLauncher = {open:async value => {target=value;return {status:'ready',url:'http://127.0.0.1:8000/chat/'};}, status:async()=>({status:'ready'})};
  const app=createApp({smartVideoLauncher});t.after(()=>app.close());const port=await listen(app);
  assert.equal((await fetch(`http://localhost:${port}/api/chat/open`)).status,405);
  const response=await fetch(`http://localhost:${port}/api/chat/open`,{method:'POST'});
  assert.equal(response.status,200);assert.equal(target,'chat');assert.match((await response.json()).url,/\/chat\/$/);
  assert.equal((await fetch(`http://localhost:${port}/api/chat/status`)).status,200);
  assert.match(await (await fetch(`http://localhost:${port}/`)).text(),/id="workbenchButton"/);
});

test('workbench preparation is POST-only and does not invoke browser open', async t=>{
  let prepares=0,opens=0;
  const app=createApp({smartVideoLauncher:{prepare:async()=>{prepares++;return {status:'starting',progress:{percent:20,stage:'释放内置环境'}};},open:async()=>{opens++;}}});
  t.after(()=>app.close());const port=await listen(app);
  const url=`http://localhost:${port}/api/workbench/prepare`;
  assert.equal((await fetch(url)).status,405);
  const response=await fetch(url,{method:'POST'});
  assert.equal(response.status,200);assert.equal((await response.json()).progress.percent,20);
  assert.equal(prepares,1);assert.equal(opens,0);
});

/* ---------------- 数字人 ---------------- */

test('proxies /rh/run/ai-app/* to 数字人上游 /openapi/v2/run/ai-app/* with x-rh-key auth', async (t) => {
  const up = await startEcho((req, body) => ({
    url: req.url, method: req.method, auth: req.headers.authorization, body: body.toString(),
  }));
  const app = createApp({ dhUpstream: `http://localhost:${up.port}${RH_PATH}`, configPath: '/nonexistent-config.json' });
  t.after(() => { app.close(); up.close(); });
  const port = await listen(app);

  const res = await fetch(`http://localhost:${port}/rh/run/ai-app/2087890031699648513`, {
    method: 'POST',
    headers: { 'x-rh-key': 'rh_test_key', 'content-type': 'application/json' },
    body: JSON.stringify({ nodeInfoList: [] }),
  });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.url, `${RH_PATH}/run/ai-app/2087890031699648513`);
  assert.equal(data.method, 'POST');
  assert.equal(data.auth, 'Bearer rh_test_key');
  assert.equal(data.body, '{"nodeInfoList":[]}');
});

test('proxies /rh/query and preserves query string', async (t) => {
  const up = await startEcho((req) => ({ url: req.url }));
  const app = createApp({ dhUpstream: `http://localhost:${up.port}${RH_PATH}`, configPath: '/nonexistent-config.json' });
  t.after(() => { app.close(); up.close(); });
  const port = await listen(app);

  const res = await fetch(`http://localhost:${port}/rh/query?t=1`, {
    method: 'POST',
    headers: { 'x-rh-key': 'k', 'content-type': 'application/json' },
    body: JSON.stringify({ taskId: 'abc' }),
  });
  const data = await res.json();
  assert.equal(data.url, `${RH_PATH}/query?t=1`);
});

test('passes multipart upload body and content-type through to 数字人上游', async (t) => {
  const up = await startEcho((req, body) => {
    const ct = req.headers['content-type'] || '';
    const text = body.toString('latin1');
    const boundary = (ct.match(/boundary=(.+)$/) || [])[1];
    return {
      url: req.url,
      ct,
      len: body.length,
      // body 必须真的带上 content-type 里声明的那条 boundary，否则上游无法解析
      boundaryInBody: Boolean(boundary) && text.includes(boundary),
      hasFileField: text.includes('name="file"'),
      hasFilename: text.includes('filename="a.png"'),
      payloadBytes: [...body].filter((b) => [1, 2, 3, 4].includes(b)).length,
    };
  });
  const app = createApp({ dhUpstream: `http://localhost:${up.port}${RH_PATH}`, configPath: '/nonexistent-config.json' });
  t.after(() => { app.close(); up.close(); });
  const port = await listen(app);

  const fd = new FormData();
  fd.append('file', new Blob([new Uint8Array([1, 2, 3, 4])]), 'a.png');
  const res = await fetch(`http://localhost:${port}/rh/media/upload/binary`, {
    method: 'POST', headers: { 'x-rh-key': 'k' }, body: fd,
  });
  const data = await res.json();
  assert.equal(data.url, `${RH_PATH}/media/upload/binary`);
  assert.match(data.ct, /^multipart\/form-data; boundary=/);
  assert.ok(data.len > 0, 'multipart body 应该被透传');
  assert.equal(data.boundaryInBody, true, 'body 应含 content-type 声明的 boundary');
  assert.equal(data.hasFileField, true, '应保留 file 字段名');
  assert.equal(data.hasFilename, true, '应保留原始文件名');
  assert.ok(data.payloadBytes >= 4, '文件二进制内容应完整透传');
});

test('rh key falls back to config.json rhApiKey and omits X-API-Key', async (t) => {
  const cfg = tmpConfig('rhconfig');
  fs.writeFileSync(cfg, JSON.stringify({ rhApiKey: 'rh_from_config' }));
  const up = await startEcho((req) => ({ auth: req.headers.authorization, xapi: req.headers['x-api-key'] }));
  const app = createApp({ dhUpstream: `http://localhost:${up.port}${RH_PATH}`, configPath: cfg });
  t.after(() => { app.close(); up.close(); cleanupFile(cfg); });
  const port = await listen(app);

  const res = await fetch(`http://localhost:${port}/rh/query`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  });
  const data = await res.json();
  assert.equal(data.auth, 'Bearer rh_from_config');
  assert.equal(data.xapi, undefined, '数字人上游不应带 X-API-Key 头');
});

test('rh key defaults to empty when nothing configured', async (t) => {
  const up = await startEcho((req) => ({ auth: req.headers.authorization ?? null }));
  const app = createApp({ dhUpstream: `http://localhost:${up.port}${RH_PATH}`, configPath: '/nonexistent-config.json' });
  t.after(() => { app.close(); up.close(); });
  const port = await listen(app);

  const data = await (await fetch(`http://localhost:${port}/rh/query`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).json();
  assert.equal(data.auth, null, '未配置 Key 时不注入 Authorization');
});

/* ---------------- /api/config ---------------- */

test('/api/config stores and reports generation keys independently', async (t) => {
  const cfg = tmpConfig('cfg');
  const app = createApp({ configPath: cfg });
  t.after(() => { app.close(); cleanupFile(cfg); });
  const port = await listen(app);
  const base = `http://localhost:${port}/api/config`;

  let data = await (await fetch(base)).json();
  assert.equal(data.configured, false);
  assert.equal(data.videoConfigured, false);
  assert.equal(data.rhConfigured, false);
  assert.equal(data.llmConfigured, false);

  data = await (await fetch(base, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ rhApiKey: 'rh_saved' }),
  })).json();
  assert.equal(data.rhConfigured, true);
  assert.equal(data.configured, false, '保存数字人 Key 不应影响图片/视频 Key 状态');

  data = await (await fetch(base, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ apiKey: 'sk_saved' }),
  })).json();
  assert.equal(data.configured, true);
  assert.equal(data.llmConfigured, true, '主线路保存后自动启用云端推理');
  assert.equal(data.rhConfigured, true, '两个 Key 独立保存');

  data = await (await fetch(base, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ videoApiKey: 'vf_saved' }),
  })).json();
  assert.equal(data.videoConfigured, true);
  assert.equal(data.configured, true, '保存官方备选线路 Key 不应覆盖主线路 Key');

  data = await (await fetch(base)).json();
  assert.equal(data.configured, true);
  assert.equal(data.videoConfigured, true);
  assert.equal(data.rhConfigured, true);
  assert.equal(data.llmConfigured, true);
});

test('saving config purges legacy local inference secrets and exposes only automatic mode', async (t) => {
  const cfg=tmpConfig('creative-endpoint'), app=createApp({configPath:cfg});
  t.after(()=>{app.close();cleanupFile(cfg);});
  const base=`http://localhost:${await listen(app)}/api/config`;
  const save=value=>fetch(base,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(value)});
  fs.writeFileSync(cfg, JSON.stringify({llmApiKey:'private-key',creativeEndpointId:'ep-test-endpoint'}));
  let data=await (await fetch(base)).json();
  assert.equal(data.llmConfigured,false);assert.equal(data.inferenceMode,'cloud-auto');
  assert.ok(!JSON.stringify(data).includes('private-key'));
  assert.equal((await save({apiKey:'main-key',llmApiKey:'must-not-save',llmEndpointId:'ep-must-not-save'})).status,200);
  data=await (await fetch(base)).json();assert.equal(data.llmConfigured,true);assert.equal(data.inferenceMode,'cloud-auto');
  const saved=JSON.parse(fs.readFileSync(cfg));
  assert.equal(saved.apiKey,'main-key');assert.equal(saved.llmApiKey,undefined);assert.equal(saved.llmEndpointId,undefined);assert.equal(saved.creativeEndpointId,undefined);
});

test('local inference route uses only the saved main key', async (t) => {
  const cfg=tmpConfig('inference-route');
  fs.writeFileSync(cfg,JSON.stringify({apiKey:'saved-main-key'}));
  const calls=[];
  const gateway={handle:async(req,res,url,key)=>{
    calls.push({authorization:req.headers.authorization,url:url.pathname,key});
    res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({configured:true}));
  }};
  const app=createApp({configPath:cfg,inferenceGateway:gateway});
  t.after(()=>{app.close();cleanupFile(cfg);});
  const port=await listen(app);
  const response=await fetch(`http://localhost:${port}/api/inference/status`,{headers:{authorization:'Bearer caller-supplied-key'}});
  assert.equal(response.status,200);assert.equal(calls.length,1);
  assert.equal(calls[0].key,'saved-main-key');
  assert.equal(calls[0].authorization,'Bearer caller-supplied-key');
});
