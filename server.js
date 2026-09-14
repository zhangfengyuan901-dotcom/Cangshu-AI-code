const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { exec, execFile, spawn } = require('node:child_process');
const { createDiagnostics, inspectPort, classifyFailure } = require('./diagnostics.cjs');

const PUBLIC_DIR = path.join(__dirname, 'public');
const CONFIG_PATH = path.join(__dirname, 'config.json');
const RESULT_DIR = path.join(os.homedir(), 'Desktop', '仓鼠AI生成结果');
const SMART_VIDEO_URL = 'http://127.0.0.1:8000/';
async function freeLocalPort(){
  const net=require('node:net');
  return new Promise((resolve,reject)=>{const probe=net.createServer();probe.once('error',reject);
    probe.listen(0,'127.0.0.1',()=>{const port=probe.address().port;probe.close(()=>resolve(port));});});
}

/* 上游服务 */
const GEN_UPSTREAM = 'https://sanbaobeauty.com';        // 图片/视频生成上游
const DH_UPSTREAM = 'https://www.runninghub.cn/openapi/v2'; // 数字人上游

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

/* 转发时跳过的请求头（鉴权头由服务端重新注入，长度/连接头交给 fetch 处理） */
const SKIP_REQ_HEADERS = new Set([
  'host', 'connection', 'content-length',
  'authorization', 'x-api-key', 'x-sandbox-key', 'x-rh-key',
]);

/* ---------- config.json（可选，服务端持久化 API Key） ---------- */
function loadConfig(configPath) {
  try { return JSON.parse(fs.readFileSync(configPath, 'utf8')); }
  catch { return {}; }
}
function saveConfig(configPath, cfg) {
  fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
}

/* 解析图片/视频 API Key：Authorization / X-API-Key / x-sandbox-key 优先，其次 config.json */
function resolveGenKey(req, configPath) {
  const auth = String(req.headers['authorization'] || '');
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (m && m[1].trim()) return m[1].trim();
  const xk = String(req.headers['x-api-key'] || req.headers['x-sandbox-key'] || '');
  if (xk.trim()) return xk.trim();
  const cfg = loadConfig(configPath);
  return (cfg.apiKey || '').trim();
}

/* 解析数字人 API Key：x-rh-key 优先，其次 config.json */
function resolveDhKey(req, configPath) {
  const xk = String(req.headers['x-rh-key'] || '');
  if (xk.trim()) return xk.trim();
  const auth = String(req.headers['authorization'] || '');
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (m && m[1].trim()) return m[1].trim();
  const cfg = loadConfig(configPath);
  return (cfg.rhApiKey || '').trim();
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(chunks.length ? Buffer.concat(chunks) : undefined));
    req.on('error', reject);
  });
}

const OUTPUT_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'mp4', 'webm', 'mov', 'mp3', 'wav', 'm4a']);
const CONTENT_TYPE_EXTENSIONS = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif',
  'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov',
  'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/mp4': 'm4a',
};

function safeOutputExtension(outputType, url, contentType) {
  const requested = String(outputType || '').replace(/^\./, '').toLowerCase();
  if (OUTPUT_EXTENSIONS.has(requested)) return requested;
  const fromUrl = path.extname(new URL(url).pathname).slice(1).toLowerCase();
  if (OUTPUT_EXTENSIONS.has(fromUrl)) return fromUrl;
  return CONTENT_TYPE_EXTENSIONS[String(contentType || '').split(';')[0].toLowerCase()] || 'bin';
}

async function handleSaveResult(req, res, resultDir) {
  if (req.method !== 'POST') { res.writeHead(405); res.end('Method Not Allowed'); return; }
  const body = await readBody(req);
  let payload;
  try { payload = JSON.parse(body?.toString('utf8') || '{}'); }
  catch { payload = {}; }
  let remoteUrl;
  try {
    remoteUrl = new URL(String(payload.url || ''));
    if (!['http:', 'https:'].includes(remoteUrl.protocol)) throw new Error('unsupported protocol');
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'invalid-result-url', message: '结果链接无效' }));
    return;
  }

  const download = await fetch(remoteUrl);
  if (!download.ok || !download.body) {
    res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'result-download-failed', message: `下载结果失败 (${download.status})` }));
    return;
  }

  fs.mkdirSync(resultDir, { recursive: true });
  const ext = safeOutputExtension(payload.outputType, remoteUrl, download.headers.get('content-type'));
  const taskId = String(payload.taskId || 'result').replace(/[^a-zA-Z0-9_-]/g, '').slice(-48) || 'result';
  const timestamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 17);
  const fileName = `仓鼠-${timestamp}-${taskId}.${ext}`;
  const localPath = path.join(resultDir, fileName);
  try {
    await pipeline(Readable.fromWeb(download.body), fs.createWriteStream(localPath, { flags: 'wx' }));
  } catch (err) {
    try { fs.unlinkSync(localPath); } catch { /* 未生成完整文件 */ }
    throw err;
  }
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ ok: true, fileName, localPath }));
}

function findSmartVideoDir(explicitDir) {
  const samplePath = path.join('agentkit-samples', 'python', '02-use-cases', 'ad_video_gen_seq');
  const candidates = [
    explicitDir,
    process.env.HAMSTER_SMART_VIDEO_DIR,
    process.resourcesPath && path.join(process.resourcesPath, 'smart-video-agent'),
    path.join(path.dirname(process.execPath), 'smart-video-agent'),
    path.join(__dirname, 'smart-video-agent'),
    path.join(__dirname, samplePath),
    path.join(__dirname, '..', samplePath),
  ].filter(Boolean);
  return candidates.find((dir) => (
    fs.existsSync(path.join(dir, 'pyproject.toml'))
    && fs.existsSync(path.join(dir, 'main.py'))
  )) || '';
}

function createSmartVideoLauncher({
  workflowDir,
  url = SMART_VIDEO_URL,
  openExternal = openBrowser,
  fetchImpl = fetch,
  spawnImpl = spawn,
  envProvider = () => ({}),
  diagnostics,
  portProbe = inspectPort,
  allocatePort = freeLocalPort,
  dynamicPorts = true,
  runtimeProvider,
  requireIdentity = false,
  startupTimeoutMs = 120000,
} = {}) {
  let child = null;
  let startError = null, starting = null, captureEnabled = false, failureText = '';
  let lastPortCheck = null;
  let port = Number(new URL(url).port || 8000), stopped=false, startupTimer=null, healthTimer=null, retries=0;
  function clearStartupWatch(){clearTimeout(startupTimer);clearInterval(healthTimer);}
  const instanceId=require('node:crypto').randomUUID();
  const diag = diagnostics || {log(){},failure(){},redact:String,addSecrets(){},capture(){return ()=>{};}};

  function failed(details) {
    startError = details;
    diag.failure(details);
    return {status:'error',url,...details};
  }

  async function readyUrl() {
    try {
      const response = await fetchImpl(new URL('/studio-api/health', url), {
        signal: AbortSignal.timeout(1500),
      });
      if (response.status !== 200) return '';
      const health = await response.json();
      if (health.app === 'hamster-smart-video' && (!requireIdentity || (health.instance===instanceId && health.version===19))) return health;
      return '';
    } catch {
      return '';
    }
  }

  async function start() {
    if(stopped)return {status:'stopped',url};
    if (child && child.exitCode === null) return { status: 'starting', url };
    if (starting) return starting;
    starting = startChecked();
    try {return await starting;} finally {starting=null;}
  }
  async function startChecked() {
    startError = null;
    const runtime=runtimeProvider?await runtimeProvider():null;
    if(stopped)return {status:'stopped',url};
    lastPortCheck = await portProbe(port);
    diag.log('port-preflight',lastPortCheck);
    if (lastPortCheck.state !== 'available' && dynamicPorts) {
      const previous=port;port=await allocatePort();url=`http://127.0.0.1:${port}/`;
      diag.log('port-switch',{previous,port,reason:lastPortCheck.state});
    } else if (lastPortCheck.state !== 'available') {
      const owners=(lastPortCheck.owners || []).map(item=>`${item.name}（PID ${item.pid}）`).join('、');
      return failed({code:lastPortCheck.state==='occupied'?'PORT_IN_USE':'PORT_UNAVAILABLE',port,
        message:lastPortCheck.state==='occupied'?`${port} 端口已被${owners || '其他本地程序'}占用，工作台未启动。请确认占用程序后处理，或导出诊断信息`:`无法使用 ${port} 端口，请检查系统权限、安全软件或端口保留策略`,portCheck:lastPortCheck});
    }
    const dir = findSmartVideoDir(workflowDir);
    if (!dir) {
      return failed({code:'WORKFLOW_MISSING',message:'未找到本地工作流文件，请检查安装是否完整并导出诊断信息'});
    }

    const localVeadk = process.platform === 'win32'
      ? path.join(dir, '.venv', 'Scripts', 'python.exe')
      : path.join(dir, '.venv', 'bin', 'python');
    const bundledUv = process.platform === 'win32'
      ? path.join(dir, 'bin', 'uv.exe')
      : '';
    const command = runtime ? runtime.python : fs.existsSync(localVeadk)
      ? localVeadk
      : fs.existsSync(bundledUv) ? bundledUv : 'uv';
    const args = runtime ? ['-I','-B',runtime.bootstrap,dir,'--port',String(port)] : fs.existsSync(localVeadk)
      ? ['web.py', '--port', String(port)]
      : ['run', 'python', 'web.py', '--port', String(port)];
    const extraEnv = envProvider();
    if(stopped)return {status:'stopped',url};
    diag.addSecrets(extraEnv);
    diag.log('launch',{runtime:runtime?runtime.id:fs.existsSync(localVeadk)?'python-venv':'uv-bootstrap',command,port,workflow:dir});
    let launched;
    try { launched = spawnImpl(command, args, {
      cwd: dir,
      env: {
        ...process.env,
        ...extraEnv,
        PYTHONPATH: [dir, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter),
        PYTHONUNBUFFERED: '1',
        HAMSTER_SERVICE_INSTANCE: instanceId,
        HAMSTER_PARENT_PID: String(process.pid),
        PYTHONNOUSERSITE: '1',
      },
      windowsHide: true,
      stdio: ['ignore','pipe','pipe'],
    }); } catch(error) {return failed(classifyFailure(String(error),diag.redact(error.message)));}
    child = launched;
    clearStartupWatch();
    let checking=false;
    healthTimer=setInterval(async()=>{
      if(checking||child!==launched)return;
      checking=true;
      try{if(await readyUrl()){captureEnabled=false;clearStartupWatch();diag.log('health-ready',{port});}}finally{checking=false;}
    },1000);
    healthTimer.unref?.();
    startupTimer=setTimeout(()=>{
      if(child!==launched)return;
      failed({code:'STARTUP_TIMEOUT',message:'本地工作台未在预期时间内通过健康检查，请导出诊断信息'});
      child=null;launched.kill?.();
      clearStartupWatch();
    },startupTimeoutMs);
    startupTimer.unref?.();
    captureEnabled=true;failureText='';
    const note=line=>{
      failureText=(failureText+'\n'+line).slice(-32768);
      if(/Uvicorn running on/i.test(line)){captureEnabled=false;diag.log('ready','本地服务已开始监听；停止采集业务期输出');}
    };
    const enabled=()=>captureEnabled && child===launched;
    const flushOut=diag.capture(launched.stdout,'stdout',note,enabled);
    const flushErr=diag.capture(launched.stderr,'stderr',note,enabled);
    launched.once('error', (err) => {
      if (child !== launched) return;
      flushOut();flushErr();diag.log('spawn-error',String(err));
      failed(classifyFailure(String(err),`启动失败：${diag.redact(err.message)}`));
      child = null;captureEnabled=false;
      clearStartupWatch();
    });
    launched.once('close', (code, signal) => {
      if (child !== launched) return;
      flushOut();flushErr();
      diag.log('process-close',{code,signal});
      clearStartupWatch();
      if(!stopped && dynamicPorts && classifyFailure(failureText).code==='PORT_IN_USE' && retries++<3){
        child=null;captureEnabled=false;
        start().catch(error=>failed(classifyFailure(String(error))));return;
      }
      if(!startError)failed({...classifyFailure(failureText,`本地工作台已退出（代码 ${code ?? '未知'}），请导出诊断信息`),exitCode:code,signal});
      child = null;captureEnabled=false;
    });
    return { status: 'starting', url };
  }

  async function status() {
    const health = await readyUrl();
    if (health) {captureEnabled=false;clearStartupWatch();return { status: 'ready', url };}
    if (startError) return { status: 'error', url, ...startError };
    return { status: starting || (child && child.exitCode === null) ? 'starting' : 'stopped', url };
  }

  async function open(creative = false) {
    const health = await readyUrl();
    if (health) {
      captureEnabled=false;
      clearStartupWatch();
      if ((creative === 'chat' && !health.chat) || (creative === true && !health.creative)) return failed({code:'WORKFLOW_VERSION_MISMATCH',message:'本地工作台仍是旧版本，请退出旧版应用及其工作台后重试'});
      diag.log('reuse-service',{port,version:health.version || 'unknown'});
      const target = creative === 'chat' ? new URL('/chat/', url).href : creative ? new URL('/creative/', url).href : url;
      openExternal(target);
      return { status: 'ready', url: target };
    }
    try{return await start();}catch(error){diag.log('prepare-error',String(error));return failed(classifyFailure(String(error)));}
  }

  function stop() {
    stopped=true;clearStartupWatch();
    const launched = child;
    child = null;
    startError = null;captureEnabled=false;
    diag.log('stop','应用正在关闭本次启动的工作台');
    if (!launched || launched.exitCode !== null) return;
    if (process.platform === 'win32' && launched.pid) {
      execFile('taskkill', ['/PID', String(launched.pid), '/T', '/F'], { windowsHide: true }, () => {});
    } else if (typeof launched.kill === 'function') {
      launched.kill();
    }
  }

  async function diagnose() {
    const health=await readyUrl();
    const check=health?{port,host:'127.0.0.1',state:'own-service',version:health.version || null}:await portProbe(port);
    const dir=findSmartVideoDir(workflowDir);
    const exists=relative=>!!dir && fs.existsSync(path.join(dir,relative));
    return {service:health?'ready':child?'starting':startError?'error':'stopped',port:check,lastPortCheck,
      workflow:{found:!!dir,webEntry:exists('web.py'),manifest:exists('pyproject.toml'),
        python:exists(process.platform==='win32'?'.venv/Scripts/python.exe':'.venv/bin/python'),bundledRuntime:!!runtimeProvider,bundledLauncher:exists('bin/uv.exe')},currentFailure:startError};
  }
  return { open, status, stop, diagnose };
}

async function handleSmartVideo(req, res, launcher, action, creative = false) {
  const allowedMethod = action === 'open' ? 'POST' : 'GET';
  if (req.method !== allowedMethod) { res.writeHead(405); res.end('Method Not Allowed'); return; }
  const payload = action === 'open' ? await launcher.open(creative) : await launcher.status();
  const statusCode = payload.status === 'error' ? 503 : 200;
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function serveStatic(req, res, publicDir, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405); res.end('Method Not Allowed'); return;
  }
  const filePath = pathname === '/' ? 'index.html' : pathname.slice(1);
  const full = path.normalize(path.join(publicDir, filePath));
  if (!full.startsWith(publicDir)) { res.writeHead(403); res.end('Forbidden'); return; }
  fs.readFile(full, (err, data) => {
    if (err) {
      res.writeHead(err.code === 'ENOENT' ? 404 : 500);
      res.end(err.code === 'ENOENT' ? 'Not Found' : 'Server Error');
      return;
    }
    const ext = path.extname(full).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

/* 公共模型列表（无需 Key），走公共端点 */
async function handlePublicModels(req, res, upstream) {
  try {
    const resp = await fetch(upstream + '/api/public/openapi-models', { headers: { Accept: 'application/json' } });
    const buffer = Buffer.from(await resp.arrayBuffer());
    res.writeHead(resp.status, { 'Content-Type': resp.headers.get('content-type') || 'application/json; charset=utf-8' });
    res.end(buffer);
  } catch (err) {
    res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'upstream-unreachable', message: String(err?.message || err) }));
  }
}

/* 本地配置端点：GET 查询是否已配置 Key，POST 保存 Key 到 config.json */
async function handleConfig(req, res, configPath) {
  if (req.method === 'GET') {
    const cfg = loadConfig(configPath);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({
      configured: Boolean((cfg.apiKey || '').trim()),
      rhConfigured: Boolean((cfg.rhApiKey || '').trim()),
      llmConfigured: Boolean((cfg.llmApiKey || '').trim()),
      llmEndpointId: String(cfg.llmEndpointId ?? cfg.creativeEndpointId ?? ''),
    }));
  }
  if (req.method === 'POST') {
    const body = await readBody(req);
    let payload = {};
    try { payload = body && body.length ? JSON.parse(body.toString('utf8')) : {}; } catch { payload = {}; }
    const cfg = loadConfig(configPath);
    const endpoint = Object.hasOwn(payload, 'llmEndpointId') ? payload.llmEndpointId : payload.creativeEndpointId;
    if (endpoint !== undefined) {
      if (typeof endpoint !== 'string' || (endpoint.trim() && !/^ep-[a-zA-Z0-9-]{5,100}$/.test(endpoint.trim()))) {
        res.writeHead(400, { 'Content-Type':'application/json; charset=utf-8' });
        return res.end(JSON.stringify({error:'接入点 ID 格式不正确，请输入 ep- 开头的接入点编号。'}));
      }
      cfg.llmEndpointId = endpoint.trim();
    }
    if (!Object.hasOwn(cfg, 'llmEndpointId') && Object.hasOwn(cfg, 'creativeEndpointId')) cfg.llmEndpointId = cfg.creativeEndpointId;
    delete cfg.creativeEndpointId;
    if (typeof payload.apiKey === 'string') cfg.apiKey = payload.apiKey.trim();
    if (typeof payload.rhApiKey === 'string') cfg.rhApiKey = payload.rhApiKey.trim();
    if (typeof payload.llmApiKey === 'string') cfg.llmApiKey = payload.llmApiKey.trim();
    saveConfig(configPath, cfg);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({
      ok: true,
      configured: Boolean((cfg.apiKey || '').trim()),
      rhConfigured: Boolean((cfg.rhApiKey || '').trim()),
      llmConfigured: Boolean((cfg.llmApiKey || '').trim()),
    }));
  }
  res.writeHead(405); res.end('Method Not Allowed');
}

/*
 * 通用转发：把请求原样转发到上游，并注入 Authorization。
 * multipart 上传（媒体上传）也能直接透传——content-type 含 boundary，body 为原始 Buffer。
 */
async function forward(req, res, { target, apiKey, dualHeader, taskStore }) {
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (SKIP_REQ_HEADERS.has(k)) continue;
    headers[k] = v;
  }
  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`;
    if (dualHeader) headers['X-API-Key'] = apiKey; // 图片/视频兼容头
  }
  const body = await readBody(req);
  if (req.method === 'POST' && new URL(req.url, 'http://localhost').pathname === '/api/images') {
    const { IMAGE_ROUTES } = await import('./public/core.mjs');
    let payload;
    try { payload = JSON.parse(body?.toString('utf8') || '{}'); } catch { payload = {}; }
    if (!IMAGE_ROUTES.some((route) => route.id === payload.model)) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: '图片生成仅支持 Image 2.5 Flare / Image 2.5 Sunburst' }));
      return;
    }
  }
  if (req.method === 'POST' && new URL(req.url, 'http://localhost').pathname === '/api/videos') {
    const { VIDEO_ROUTES, mediaLimitError } = await import('./public/core.mjs');
    let payload;
    try { payload = JSON.parse(body?.toString('utf8') || '{}'); } catch { payload = {}; }
    const route = VIDEO_ROUTES.find((r) => r.id === payload.model);
    let error = route ? '' : '请选择当前可用的仓鼠视频线路';
    const media = [];
    for (const [field, kind] of [['images', 'image'], ['videos', 'video'], ['audios', 'audio']]) {
      if (payload[field] !== undefined && !Array.isArray(payload[field])) error = '素材参数格式错误';
      for (const item of Array.isArray(payload[field]) ? payload[field] : []) media.push({ kind });
    }
    if (!error) error = mediaLimitError({ ...route, type: 'video' }, media);
    if (!error && payload.resolution && !route.resolutions.includes(payload.resolution)) error = '所选线路不支持此画质';
    if (error) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error }));
      return;
    }
  }
  const route = new URL(req.url, 'http://localhost').pathname;
  const track = req.method === 'POST' && (/^\/api\/(videos|images)$/.test(route) || /^\/rh\/run\/ai-app\//.test(route));
  const journal = track && taskStore ? taskStore() : null;
  const submission = journal?.begin(route, JSON.parse(body?.toString('utf8') || '{}'), apiKey, req.headers['idempotency-key']);
  let upstreamRes, buffer;
  try {
    upstreamRes = await fetch(target, { method: req.method, headers, body, signal:AbortSignal.timeout(120000) });
    buffer = Buffer.from(await upstreamRes.arrayBuffer());
    if (submission) {
      let data; try { data = JSON.parse(buffer.toString('utf8')); } catch { data = {}; }
      journal.capture(submission, data, upstreamRes.status);
    }
  } catch (error) {
    if (submission) journal.uncertain(submission);
    throw error;
  }
  const resHeaders = {};
  for (const [k, v] of upstreamRes.headers) {
    if (['content-length', 'connection', 'transfer-encoding'].includes(k)) continue;
    resHeaders[k] = v;
  }
  res.writeHead(upstreamRes.status, resHeaders);
  res.end(buffer);
}

function createApp({
  upstream = GEN_UPSTREAM,
  dhUpstream = DH_UPSTREAM,
  publicDir = PUBLIC_DIR,
  configPath = CONFIG_PATH,
  resultDir = RESULT_DIR,
  taskDir = path.join(path.dirname(configPath), 'task-history'),
  taskOptions = {},
  diagnostics = null,
  diagnosticsDir = path.join(path.dirname(configPath),'diagnostics'),
  diagnosticExportDir = path.join(path.dirname(resultDir),'仓鼠AI诊断'),
  assetDir = path.join(path.dirname(resultDir), '仓鼠AI资产库'),
  smartVideoLauncher = null,
  smartVideoDir,
  runtimeProvider,
} = {}) {
  const diagnosticStore = diagnostics || createDiagnostics({dir:diagnosticsDir,exportDir:diagnosticExportDir,configPath,version:require('./package.json').version});
  const activeSmartVideoLauncher = smartVideoLauncher || createSmartVideoLauncher({
    workflowDir: smartVideoDir,
    diagnostics:diagnosticStore,
    runtimeProvider,
    requireIdentity:true,
    envProvider: () => ({
      SANBAO_API_KEY: String(loadConfig(configPath).apiKey || '').trim(),
      MODEL_AGENT_API_KEY: String(loadConfig(configPath).llmApiKey || '').trim(),
      HAMSTER_SMART_VIDEO_OUTPUT_DIR: path.join(resultDir, '智能成片'),
      HAMSTER_CONFIG_PATH: path.resolve(configPath),
      HAMSTER_ASSET_API: `http://127.0.0.1:${server.address().port}/api/assets`,
    }),
  });
  // 图片/视频：/api/xxx → /openapi/v1/xxx
  const genTarget = (url) => upstream + '/openapi/v1' + url.pathname.replace(/^\/api/, '') + url.search;
  // 数字人：/rh/xxx → /openapi/v2/xxx
  const dhTarget = (url) => dhUpstream + url.pathname.replace(/^\/rh/, '') + url.search;

  const fail = (res) => (err) => {
    if (res.destroyed) return;
    if (res.headersSent) { res.destroy(); return; }
    res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'proxy error', detail: String(err) }));
  };

  let assetsHandler, tasks;
  const taskStore = () => {
    if (!tasks) {
      tasks = require('./tasks.cjs').createTasks({dir:taskDir, resultDir, upstream, dhUpstream,
        getKey:provider => String(loadConfig(configPath)[provider === 'generate' ? 'apiKey' : 'rhApiKey'] || '').trim(), ...taskOptions});
      tasks.start();
    }
    return tasks;
  };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;

    if (p === '/api/diagnostics/status' || p === '/api/diagnostics/export') {
      const exportRequested=p.endsWith('/export');
      if(req.method!==(exportRequested?'POST':'GET')){res.writeHead(405);res.end();return;}
      (async()=>{
        const checks=await activeSmartVideoLauncher.diagnose?.() || {service:'unknown'};
        if(exportRequested){
          const exported=diagnosticStore.exportReport(checks);
          res.writeHead(200,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});
          res.end(JSON.stringify({ok:true,fileName:exported.fileName,localPath:exported.localPath}));
        }else{
          res.writeHead(200,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});
          res.end(JSON.stringify({...diagnosticStore.snapshot(),checks}));
        }
      })().catch(fail(res));
    } else if (p === '/api/tasks' || p.startsWith('/api/tasks/')) {
      try { taskStore().handle(req,res,url).catch(fail(res)); } catch (error) { fail(res)(error); }
    } else if (p === '/api/assets' || p.startsWith('/api/assets/')) {
      assetsHandler ||= require('./assets.cjs').createAssets(assetDir,resultDir,upstream,(r)=>resolveGenKey(r,configPath));
      assetsHandler(req,res,url).catch(fail(res));
    } else if (p === '/api/public-models') {
      handlePublicModels(req, res, upstream).catch(fail(res));
    } else if (p === '/api/save-result') {
      handleSaveResult(req, res, resultDir).catch(fail(res));
    } else if (p === '/api/smart-video/open') {
      handleSmartVideo(req, res, activeSmartVideoLauncher, 'open').catch(fail(res));
    } else if (p === '/api/smart-video/status') {
      handleSmartVideo(req, res, activeSmartVideoLauncher, 'status').catch(fail(res));
    } else if (p === '/api/chat/open') {
      handleSmartVideo(req, res, activeSmartVideoLauncher, 'open', 'chat').catch(fail(res));
    } else if (p === '/api/chat/status') {
      handleSmartVideo(req, res, activeSmartVideoLauncher, 'status', 'chat').catch(fail(res));
    } else if (p === '/api/creative/open') {
      handleSmartVideo(req, res, activeSmartVideoLauncher, 'open', true).catch(fail(res));
    } else if (p === '/api/creative/status') {
      handleSmartVideo(req, res, activeSmartVideoLauncher, 'status', true).catch(fail(res));
    } else if (p === '/api/config') {
      handleConfig(req, res, configPath).catch(fail(res));
    } else if (p === '/rh' || p.startsWith('/rh/')) {
      forward(req, res, { target: dhTarget(url), apiKey: resolveDhKey(req, configPath), dualHeader: false, taskStore }).catch(fail(res));
    } else if (p === '/api' || p.startsWith('/api/')) {
      forward(req, res, { target: genTarget(url), apiKey: resolveGenKey(req, configPath), dualHeader: true, taskStore }).catch(fail(res));
    } else {
      serveStatic(req, res, publicDir, p);
    }
  });
  server.on('listening', () => { if (fs.existsSync(taskDir)) taskStore(); });
  server.on('close', () => { tasks?.stop(); activeSmartVideoLauncher.stop?.(); });
  return server;
}

function openBrowser(url) {
  const cmd = process.platform === 'win32' ? `start "" "${url}"`
    : process.platform === 'darwin' ? `open "${url}"`
    : `xdg-open "${url}"`;
  exec(cmd, (err) => { if (err) console.log('请手动打开浏览器访问:', url); });
}

if (require.main === module) {
  const PORT = Number(process.env.PORT || 8787);
  const app = createApp();
  app.listen(PORT, () => {
    const url = `http://localhost:${PORT}`;
    console.log(`仓鼠AI 本地服务已启动: ${url}`);
    openBrowser(url);
  });
}

module.exports = { createApp, createSmartVideoLauncher, findSmartVideoDir };
