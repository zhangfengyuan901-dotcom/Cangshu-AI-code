const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const DEFAULT_INFERENCE_ENDPOINT = 'https://inference.hamsterai.cc';
const CLIENT_HEADER = 'hamster-desktop-v1';

const keyId = value => crypto.createHash('sha256').update(value).digest('hex');

function createInferenceGateway({ endpoint = DEFAULT_INFERENCE_ENDPOINT, pathPrefix='', fetchImpl = fetch } = {}) {
  const sessions = new Map();
  const pending = new Map();

  async function activate(apiKey, { refresh = false } = {}) {
    const key = String(apiKey || '').trim();
    if (!key) throw Object.assign(new Error(pathPrefix?'请先在账户页配置有效的 PIKNO Key':'请先完成账户登录'), { statusCode: 401 });
    const id = keyId(key);
    const cached = sessions.get(id);
    if (!refresh && cached && cached.expiresAt > Date.now() + 60_000) return cached.token;
    if (pending.has(id)) return pending.get(id);
    const request = (async () => {
      let response;
      try {
        response = await fetchImpl(new URL(pathPrefix+'/v1/activate', endpoint), {
          method: 'POST',
          redirect: 'error',
          headers: { Authorization: `Bearer ${key}`, 'X-Hamster-Client': CLIENT_HEADER },
          signal: AbortSignal.timeout(30_000),
        });
      } catch {
        throw Object.assign(new Error('仓鼠智能服务暂时无法连接，请稍后重试'), { statusCode: 503 });
      }
      let payload = {};
      try {
        const value = await response.json();
        if (value && typeof value === 'object' && !Array.isArray(value)) payload = value;
      } catch {}
      if (!response.ok || typeof payload.token !== 'string') {
        if ([401,403].includes(response.status)) sessions.delete(id);
        const disabled = response.status === 503 && payload.code === 'assistant_disabled';
        throw Object.assign(new Error(response.status === 401 ? '账户未通过激活验证，请重新登录' : disabled ? '仓鼠智能服务尚未开放' : '仓鼠智能服务激活失败，请稍后重试'), {
          statusCode: response.status || 503,
          ...(disabled ? { code:'assistant_disabled' } : {}),
        });
      }
      const expiresAt = Date.parse(payload.expiresAt);
      if (!Number.isFinite(expiresAt) || expiresAt<=Date.now() || expiresAt>Date.now()+(pathPrefix?16*60_000:25*60*60_000)) throw Object.assign(new Error('推理会话有效期无效，请重新验证'),{statusCode:502});
      sessions.set(id, { token:payload.token, expiresAt });
      return payload.token;
    })();
    pending.set(id, request);
    try { return await request; }
    finally { pending.delete(id); }
  }

  async function status(apiKey) {
    await activate(apiKey, {refresh:true});
    return { configured:true, mode:'cloud-auto' };
  }

  async function handle(req, res, url, apiKey, { assertCurrent = () => {} } = {}) {
    // Each request keeps its captured credential. A configuration change can only
    // stop this request; it must never resolve a replacement account credential.
    assertCurrent();
    const controller = new AbortController();
    let scopeError;
    const check = () => { try { assertCurrent(); } catch (error) { scopeError=error;controller.abort(error); } };
    const timer=setInterval(check,50);
    const abort = () => controller.abort();
    req.once?.('aborted',abort);
    const waitCurrent=promise=>new Promise((resolve,reject)=>{
      const stopped=()=>{controller.signal.removeEventListener('abort',stopped);reject(scopeError||Object.assign(new Error('本次智能服务请求已停止'),{statusCode:409}));};
      if(controller.signal.aborted){promise.catch(()=>{});stopped();return;}
      controller.signal.addEventListener('abort',stopped,{once:true});
      promise.then(value=>{controller.signal.removeEventListener('abort',stopped);resolve(value);},error=>{controller.signal.removeEventListener('abort',stopped);reject(error);});
    });
    try {
    if (url.pathname === '/api/inference/status') {
      if (req.method !== 'GET') { res.writeHead(405); res.end(); return; }
      const payload = await waitCurrent(status(apiKey));
      assertCurrent();
      res.writeHead(200, { 'Content-Type':'application/json; charset=utf-8', 'Cache-Control':'no-store' });
      res.end(JSON.stringify(payload));
      return;
    }
    if (!url.pathname.startsWith('/api/inference/api/v3/')) {
      res.writeHead(404); res.end('Not Found'); return;
    }
    const token = await waitCurrent(activate(apiKey));
    assertCurrent();
    const target = new URL(pathPrefix+url.pathname.replace(/^\/api\/inference/, '') + url.search, endpoint);
    const headers = new Headers();
    for (const name of ['accept', 'content-type', 'content-length', 'range']) {
      const value = req.headers[name];
      if (value) headers.set(name, String(value));
    }
    headers.set('Authorization', `Bearer ${token}`);
    headers.set('X-Hamster-Client', CLIENT_HEADER);
    const hasBody = !['GET','HEAD'].includes(req.method || 'GET');
    let response;
    try {
      response = await fetchImpl(target, {
        method:req.method,
        redirect:'error',
        headers,
        body:hasBody ? Readable.toWeb(req) : undefined,
        ...(hasBody ? {duplex:'half'} : {}),
        signal:AbortSignal.any([controller.signal,AbortSignal.timeout(660_000)]),
      });
    } catch {
      if(scopeError)throw scopeError;
      throw Object.assign(new Error('仓鼠智能服务暂时无法连接，请稍后重试'), {statusCode:503});
    }
    assertCurrent();
    const responseHeaders = {};
    for (const name of ['content-type','content-length','content-range','accept-ranges','cache-control']) {
      const value = response.headers.get(name);
      if (value) responseHeaders[name] = value;
    }
    res.writeHead(response.status, responseHeaders);
    if (!response.body || req.method === 'HEAD') { res.end(); return; }
    await pipeline(Readable.fromWeb(response.body), res, {signal:controller.signal});
    } catch(error) { throw scopeError || error; }
    finally { clearInterval(timer);req.removeListener?.('aborted',abort); }
  }

  return { activate, status, handle };
}

module.exports = { DEFAULT_INFERENCE_ENDPOINT, createInferenceGateway };
