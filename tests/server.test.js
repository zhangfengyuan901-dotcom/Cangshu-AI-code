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
const createApp = options => createServerApp({taskDir:path.join(qaTaskRoot,String(++qaTaskIndex)),...options});

const RH_PATH = '/openapi/v2';

function listen(server) {
  return new Promise((resolve) => server.listen(0, () => resolve(server.address().port)));
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
  assert.match(await res.text(), /<title>/);
});

test('all credit badges are removed and composer includes shared asset picker', async (t) => {
  const app = createApp();
  t.after(() => app.close());
  const port = await listen(app);
  const html = await (await fetch(`http://localhost:${port}/`)).text();
  const js = await (await fetch(`http://localhost:${port}/app.js`)).text();
  assert.doesNotMatch(html, /creditButton|creditValue|accountBalance|余额/);
  assert.doesNotMatch(js, /request\(['"]\/me['"]\)|loadAccount|extractCredits/);
  assert.doesNotMatch(html, /id="costPreview"/);
  assert.doesNotMatch(js, /costPreview|estimateCost/);
  assert.doesNotMatch(html, /dhCostPreview|depthCostPreview|data-lucide="zap"|digital-cost/);
  assert.doesNotMatch(js, /CostPreview|⚡/);
  assert.match(html, /id="assetTile"/);
  assert.match(js, /pickAsset\(\{category:'talent'\}\)/);
  assert.doesNotMatch(html, /reverseCostPreview|data-view="reverse"/);
  assert.ok(html.indexOf('smartVideoButton') < html.indexOf('creativeButton'));
  assert.ok(html.indexOf('creativeButton') < html.indexOf('data-view="digital"'));
  assert.match(html, /保存配置/);
});

/* ---------------- 图片/视频 OpenAPI 代理 ---------------- */

test('image generation accepts Image 2.5 only and preserves upstream payload', async (t) => {
  let hits=0;
  const up=await startEcho((req,body)=>{hits++;return {body:JSON.parse(body.toString())};});
  const app=createApp({upstream:`http://localhost:${up.port}`});
  t.after(()=>{app.close();up.close();});
  const port=await listen(app);
  for(const model of ['gpt-image2','gpt-image2-2K','removed-image']) {
    const result=await fetch(`http://localhost:${port}/api/images`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({model})});
    assert.equal(result.status,400);
  }
  assert.equal(hits,0);
  for(const model of ['image_2_5_flare','image_2_5_sunburst']) {
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
    body: JSON.stringify({ model: 'hailuo_h3_2k_line2', prompt: 'hi' }),
  });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.url, '/openapi/v1/videos');
  assert.equal(data.method, 'POST');
  assert.equal(data.auth, 'Bearer sk_test');
  assert.equal(data.body, '{"model":"hailuo_h3_2k_line2","prompt":"hi"}');
});

test('rejects removed video routes and excess media before reaching upstream', async (t) => {
  let calls = 0;
  const up = await startEcho(() => { calls++; return {}; });
  const app = createApp({ upstream: `http://localhost:${up.port}` });
  t.after(() => { app.close(); up.close(); });
  const port = await listen(app);
  for (const payload of [
    { model: 'sd2_9img_full' },
    { model: 'hailuo_h3_2k_line2', images: Array(9).fill('url'), videos: Array(3).fill('url'), audios: ['url'] },
    { model: 'sd25_30img_special', videos: ['url'] },
    { model: 'sd25_30img_special', audios: ['url'] },
    { model: 'wan30_720p_real', resolution: '1080p' },
    { model: 'wan30_720p_real', images: 'invalid' },
  ]) {
    const response = await postJson(`http://localhost:${port}/api/videos`, payload);
    assert.equal(response.status, 400);
  }
  assert.equal(calls, 0);
});

test('proxies upload query string through to upstream', async (t) => {
  const up = await startEcho((req, body) => ({ url: req.url, ct: req.headers['content-type'], body: body.toString() }));
  const app = createApp({ upstream: `http://localhost:${up.port}` });
  t.after(() => { app.close(); up.close(); });
  const port = await listen(app);

  const res = await fetch(`http://localhost:${port}/api/uploads/raw?kind=image&fileName=a.jpg`, {
    method: 'POST',
    headers: { authorization: 'Bearer sk_test', 'content-type': 'image/jpeg' },
    body: new Uint8Array([1, 2, 3]),
  });
  const data = await res.json();
  assert.equal(data.url, '/openapi/v1/uploads/raw?kind=image&fileName=a.jpg');
  assert.equal(data.ct, 'image/jpeg');
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
  fs.writeFileSync(path.join(workflowDir, 'main.py'), '');
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

test('opens the discovered smart-video app directly instead of the empty ADK welcome page', async () => {
  let openedUrl = '';
  const launcher = createSmartVideoLauncher({
    fetchImpl: async () => ({ status: 200, json: async () => ({ app: 'hamster-smart-video' }) }),
    openExternal: (url) => { openedUrl = url; },
  });

  const result = await launcher.open();
  assert.equal(result.status, 'ready');
  assert.equal(result.url, 'http://127.0.0.1:8000/');
  assert.equal(openedUrl, result.url);
});

test('does not treat an unrelated or legacy local server as the studio', async () => {
  const launcher = createSmartVideoLauncher({
    fetchImpl: async () => ({ status: 200, json: async () => ['app', 'bin'] }),
  });

  assert.equal((await launcher.status()).status, 'stopped');
});

test('creative workbench shares launcher and requires current service capability', async () => {
  let opened = '';
  let supported = true;
  const launcher = createSmartVideoLauncher({
    fetchImpl: async () => ({status:200,json:async()=>({app:'hamster-smart-video',creative:supported})}),
    openExternal: url => {opened=url;},
  });
  assert.equal((await launcher.open(true)).status,'ready');
  assert.equal(opened,'http://127.0.0.1:8000/creative/');
  supported=false; opened='';
  assert.equal((await launcher.open(true)).status,'error');
  assert.equal(opened,'');
});

test('opens and reports smart video service through dedicated local endpoints', async (t) => {
  let opened = 0;
  const smartVideoLauncher = {
    open: async () => { opened += 1; return { status: 'ready', url: 'http://127.0.0.1:8000/' }; },
    status: async () => ({ status: 'ready', url: 'http://127.0.0.1:8000/' }),
  };
  const app = createApp({ smartVideoLauncher });
  t.after(() => app.close());
  const port = await listen(app);

  const openedResponse = await fetch(`http://localhost:${port}/api/smart-video/open`, { method: 'POST' });
  assert.equal(openedResponse.status, 200);
  assert.equal((await openedResponse.json()).status, 'ready');
  assert.equal(opened, 1);

  const statusResponse = await fetch(`http://localhost:${port}/api/smart-video/status`);
  assert.equal(statusResponse.status, 200);
  assert.equal((await statusResponse.json()).url, 'http://127.0.0.1:8000/');
});

test('returns a useful smart video setup error', async (t) => {
  const smartVideoLauncher = {
    open: async () => ({ status: 'error', message: '未找到智能成片工作流' }),
    status: async () => ({ status: 'stopped' }),
  };
  const app = createApp({ smartVideoLauncher });
  t.after(() => app.close());
  const port = await listen(app);

  const response = await fetch(`http://localhost:${port}/api/smart-video/open`, { method: 'POST' });
  assert.equal(response.status, 503);
  assert.match((await response.json()).message, /未找到智能成片工作流/);
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

test('/api/config stores and reports both keys independently', async (t) => {
  const cfg = tmpConfig('cfg');
  const app = createApp({ configPath: cfg });
  t.after(() => { app.close(); cleanupFile(cfg); });
  const port = await listen(app);
  const base = `http://localhost:${port}/api/config`;

  let data = await (await fetch(base)).json();
  assert.equal(data.configured, false);
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
  assert.equal(data.rhConfigured, true, '两个 Key 独立保存');

  data = await (await fetch(base, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ llmApiKey: 'ark_saved' }),
  })).json();
  assert.equal(data.llmConfigured, true);

  data = await (await fetch(base)).json();
  assert.equal(data.configured, true);
  assert.equal(data.rhConfigured, true);
  assert.equal(data.llmConfigured, true);
});
