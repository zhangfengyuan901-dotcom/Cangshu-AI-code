// Local durable task journal. Only query existing IDs; never resubmit generation.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const hash = value => crypto.createHash('sha256').update(value).digest('hex').slice(0, 32);
const terminal = status => ['succeeded', 'failed', 'unknown'].includes(status);
const stamp = () => new Date().toISOString();
const statusOf = value => ({preparing:'queued',pending:'queued',waiting:'queued',running:'processing',success:'succeeded',error:'failed'})[String(value).toLowerCase()] || String(value || 'queued').toLowerCase();
const safeUrl = value => { try { const u = new URL(value); return ['http:', 'https:'].includes(u.protocol) ? u.href : ''; } catch { return ''; } };
const TYPES = {png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',webp:'image/webp',gif:'image/gif',mp4:'video/mp4',mov:'video/quicktime',webm:'video/webm',mp3:'audio/mpeg',wav:'audio/wav',txt:'text/plain; charset=utf-8'};

function createTasks({dir, resultDir, upstream, dhUpstream, getKey, interval=5000, tickMs=1000, fetchImpl=fetch}) {
  const records = new Map(), active = new Set(), keys = new Map(), controllers = new Set();
  let timer, stopped = false;
  const warnings = [];
  fs.mkdirSync(dir, {recursive:true});
  for (const file of fs.readdirSync(dir).filter(f => /^[a-f0-9]{32}\.json$/.test(f))) {
    try {
      const item = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
      if (item.key !== file.slice(0, -5)) continue;
      if (item.status === 'submitting') { item.status = 'unknown'; item.poll_error = '上次提交中断，未取得任务 ID。请核对服务端记录，勿重复提交。'; }
      if (item.result) delete item.result.saving;
      item.nextPollAt = Date.now();
      records.set(item.key, item);
    } catch { warnings.push(`任务记录 ${file} 读取失败，原文件已保留，请备份后检查`); }
  }
  function save(item) {
    item.updatedAt = stamp();
    const file = path.join(dir, item.key + '.json');
    const temp = file + '.tmp';
    const fd = fs.openSync(temp, 'w', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(item, null, 2)); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    fs.renameSync(temp, file);
    records.set(item.key, item);
  }
  function rememberKey(key) { if (key) keys.set(hash(key), key); return key ? hash(key) : ''; }
  function outputPath(item) {
    const file = item.result?.local_path;
    if (!file) return '';
    try {
      const real = fs.realpathSync(file), root = fs.realpathSync(resultDir);
      const relative = path.relative(root, real);
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || !fs.statSync(real).isFile() || !fs.statSync(real).size) return '';
      return real;
    } catch { return ''; }
  }
  function view(item) {
    const {keyHash, ...out} = item;
    if (out.result) {
      out.result = {...out.result};
      if (outputPath(item)) out.result.local_url = `/api/tasks/${item.key}/file`;
      else { delete out.result.local_path; delete out.result.local_url; }
    }
    return out;
  }
  function list() { return [...records.values()].sort((a,b) => b.createdAt.localeCompare(a.createdAt)).map(view); }
  function begin(route, payload, apiKey, requestId) {
    const tool = route.startsWith('/rh/');
    const source = tool ? (route.endsWith('2089021172049596418') ? 'depth' : 'digital') : 'generate';
    const type = route === '/api/images' ? 'image' : 'video';
    const item = {key:hash(crypto.randomUUID()), id:'', source, type,
      modelId:payload.model || (source === 'depth' ? 'depth-video' : 'digital-human'),
      modelName:source === 'depth' ? '仓鼠黑白深度视频' : source === 'digital' ? '仓鼠数字人' : payload.model,
      prompt:String(payload.prompt || (source === 'depth' ? '黑白深度视频' : '数字人视频')),
      status:'submitting', createdAt:stamp(), result:null, keyHash:rememberKey(apiKey), requestId:requestId || '', progress:0};
    save(item); // Must succeed before any chargeable upstream request is sent.
    return item;
  }
  function uncertain(item, message) {
    item.status = 'unknown'; item.poll_error = message || '提交结果待确认，未取得任务 ID。请勿重复提交。'; save(item);
  }
  function capture(submission, response, httpStatus) {
    if (httpStatus >= 400 || response?.errorCode) {
      submission.status = httpStatus >= 500 || httpStatus === 408 ? 'unknown' : 'failed';
      submission.error = String(response?.errorMessage || response?.error || `提交请求异常 (${httpStatus})`);
      save(submission); return;
    }
    const candidates = Array.isArray(response?.tasks) && response.tasks.length ? response.tasks : [response?.data || response];
    let count = 0;
    for (const data of candidates) {
      const id = data?.task_id ?? data?.taskId ?? data?.id;
      if (!id || !/^[a-zA-Z0-9_-]{1,200}$/.test(String(id))) continue;
      const key = hash(`${submission.source}:${submission.type}:${id}`);
      if (!records.has(key)) {
        const item = {...submission, key, id:String(id), status:'queued', nextPollAt:Date.now(), progress:1};
        applyStatus(item, data); save(item);
      }
      count++;
    }
    if (count) { fs.unlinkSync(path.join(dir, submission.key + '.json')); records.delete(submission.key); }
    else uncertain(submission, '未收到有效任务 ID，提交结果待确认。请核对服务端记录，勿重复提交。');
  }
  function applyStatus(item, data) {
    const status = statusOf(data.status);
    if (!['queued','processing','succeeded','failed'].includes(status)) throw new Error('任务状态暂不可识别，稍后重新查询');
    item.status = status;
    item.progress = Math.max(0, Math.min(100, Number(data.progress) || (status === 'succeeded' ? 100 : item.progress || 1)));
    item.lastPolledAt = stamp(); item.poll_error = ''; item.error = '';
    if (status === 'failed') item.error = String(data.errorMessage || data.error || data.errorCode || '生成失败');
    if (status !== 'succeeded') return;
    item.completedAt ||= stamp();
    const results = Array.isArray(data.results) ? data.results : [];
    const pick = results.find(r => /mp4|webm|mov/i.test(r.outputType || '')) || results.find(r => r.url);
    const text = results.filter(r => r.text != null).map(r => String(r.text)).join('\n');
    item.result = {...item.result,
      video_url:safeUrl(data.video_url || (item.type === 'video' ? pick?.url : '')),
      image_url:safeUrl(data.image_url || (item.type === 'image' ? pick?.url : '')),
      download_url:safeUrl(data.download_url || pick?.url),
      link_expires_in:data.link_expires_in || (pick ? 86400 : 0),
      outputType:pick?.outputType || item.type, text:text || item.result?.text || '', linksUpdatedAt:stamp()};
  }
  async function network(url, options, consume, timeout=30000) {
    const controller = new AbortController(); controllers.add(controller);
    const timeoutId = setTimeout(() => controller.abort(), timeout); timeoutId.unref?.();
    try { return await consume(await fetchImpl(url, {...options, signal:controller.signal})); }
    finally { clearTimeout(timeoutId); controllers.delete(controller); }
  }
  async function download(item) {
    const result = item.result;
    if (outputPath(item)) { result.save_error = ''; return; }
    fs.mkdirSync(resultDir, {recursive:true});
    if (result.text && !result.download_url && !result.video_url && !result.image_url) {
      const file = path.join(resultDir, `仓鼠-${item.key}.txt`);
      fs.writeFileSync(file + '.part', result.text, 'utf8'); fs.renameSync(file + '.part', file);
      result.local_path = file; result.local_name = path.basename(file); result.save_error = ''; return;
    }
    const url = safeUrl(result.download_url || result.video_url || result.image_url);
    if (!url) throw new Error('任务已完成，暂未返回结果链接；将重新查询');
    result.saving = true; save(item);
    try {
      await network(url, {}, async response => {
        if (!response.ok || !response.body) throw new Error(`结果下载失败 (${response.status})，稍后刷新链接重试`);
        const mime = (response.headers.get('content-type') || '').split(';')[0];
        if (/text\/html|application\/json/.test(mime)) throw new Error('结果返回了错误页面，稍后刷新链接重试');
        const urlExt = path.extname(new URL(url).pathname).slice(1).toLowerCase();
        const ext = Object.keys(TYPES).find(e => TYPES[e] === mime) || (TYPES[urlExt] ? urlExt : item.type === 'video' ? 'mp4' : 'png');
        const file = path.join(resultDir, `仓鼠-${item.key}.${ext}`), temp = file + '.part';
        // A completed deterministic file survives a crash between rename and journal update.
        if (!fs.existsSync(file) || !fs.statSync(file).size) {
          try {
            await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(temp));
            const length = fs.statSync(temp).size;
            if (!length) throw new Error('下载文件为空');
            fs.renameSync(temp, file);
          } catch (e) { try { fs.unlinkSync(temp); } catch {} throw e; }
        } else await response.body.cancel();
        result.local_path = file; result.local_name = path.basename(file); result.savedAt = stamp(); result.save_error = '';
      }, 300000);
    } finally { delete result.saving; }
  }
  function eligible(item) { return item.id && (!terminal(item.status) || (item.status === 'succeeded' && !outputPath(item))); }
  async function poll(item) {
    if (active.has(item.key) || stopped) return;
    active.add(item.key);
    try {
      const provider = item.source === 'generate' ? 'generate' : 'tool';
      const configured = getKey(provider);
      const key = keys.get(item.keyHash) || (configured && (!item.keyHash || hash(configured) === item.keyHash) ? configured : '');
      if (!key) throw Object.assign(new Error('等待原任务使用的 API Key，请在账户配置后恢复查询'), {status:401});
      const url = provider === 'generate' ? `${upstream}/openapi/v1/${item.type === 'video' ? 'videos' : 'images'}/${encodeURIComponent(item.id)}` : `${dhUpstream}/query`;
      const options = {headers:{Authorization:`Bearer ${key}`, 'Content-Type':'application/json'}};
      if (provider !== 'generate') { options.method = 'POST'; options.body = JSON.stringify({taskId:item.id}); }
      const data = await network(url, options, async response => {
        if (!response.ok) {
          const retry = response.headers.get('retry-after');
          const retryMs = retry ? (/^\d+$/.test(retry) ? Number(retry)*1000 : Date.parse(retry)-Date.now()) : 0;
          throw Object.assign(new Error(`任务查询暂不可用 (${response.status})，将自动重试`), {status:response.status,retryMs});
        }
        const body = await response.json();
        const data = body?.data || body;
        if (!data || typeof data.status !== 'string') throw new Error('查询响应暂缺任务状态，将自动重试');
        return data;
      });
      applyStatus(item, data);
      item.failures = 0; item.nextPollAt = Date.now() + interval;
      save(item); // Completion and links are durable before downloading starts.
      if (item.status === 'succeeded') {
        try { await download(item); item.saveFailures = 0; }
        catch (e) {
          item.result.save_error = e.message;
          item.saveFailures = (item.saveFailures || 0) + 1;
          item.nextPollAt = Date.now() + Math.min(300000, interval * 2 ** Math.min(item.saveFailures, 6));
        }
      }
    } catch (e) {
      item.poll_error = e.status === 401 || e.status === 403 ? '鉴权暂不可用，请检查原任务的 API Key；任务记录仍保留' : e.message;
      item.failures = (item.failures || 0) + 1;
      const delay = e.status === 401 || e.status === 403 ? 60000 : Math.min(60000, interval * 2 ** Math.min(item.failures, 6));
      item.nextPollAt = Date.now() + Math.max(delay, Math.min(3600000, e.retryMs || 0));
    } finally {
      try { save(item); } finally { active.delete(item.key); }
    }
  }
  function tick() {
    if (stopped) return;
    for (const item of records.values()) {
      if (active.size >= 2) break;
      if (eligible(item) && !active.has(item.key) && (item.nextPollAt || 0) <= Date.now()) poll(item).catch(() => {});
    }
  }
  function start() { stopped = false; timer = setInterval(tick, tickMs); timer.unref?.(); tick(); }
  function stop() { stopped = true; clearInterval(timer); for (const controller of controllers) controller.abort(); }
  function send(res, status, data) { res.writeHead(status, {'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}); res.end(JSON.stringify(data)); }
  async function read(req) { const chunks=[]; let size=0; for await (const c of req) {size+=c.length;if(size>10*1024*1024)throw new Error('历史文件过大');chunks.push(c);} return JSON.parse(Buffer.concat(chunks).toString() || '{}'); }
  async function handle(req, res, url) {
    if (url.pathname === '/api/tasks' && req.method === 'GET') return send(res, 200, {tasks:list(),warnings});
    if (url.pathname === '/api/tasks/import' && req.method === 'POST') {
      const payload = await read(req);
      for (const old of (Array.isArray(payload.tasks) ? payload.tasks : []).slice(0, 10000)) {
        if (!old?.id || !/^[a-zA-Z0-9_-]{1,200}$/.test(String(old.id))) continue;
        const source = ['digital','depth','reverse'].includes(old.source) ? old.source : /数字人/.test(old.modelName) ? 'digital' : /深度/.test(old.modelName) ? 'depth' : /反推/.test(old.modelName) ? 'reverse' : 'generate';
        const type = old.type === 'image' ? 'image' : 'video';
        const key = hash(`${source}:${type}:${old.id}`);
        if (records.has(key)) continue;
        const item = {key, id:String(old.id), source, type, modelId:old.modelId, modelName:old.modelName,
          prompt:String(old.prompt || ''), status:['queued','processing','succeeded','failed'].includes(old.status) ? old.status : 'queued',
          error:String(old.error || ''), createdAt:typeof old.createdAt === 'string' && Number.isFinite(Date.parse(old.createdAt)) ? old.createdAt : stamp(), nextPollAt:Date.now(), result:old.result ? {...old.result} : null};
        if (item.result) { delete item.result.local_url; delete item.result.saving; if (!outputPath(item)) delete item.result.local_path; }
        save(item);
      }
      return send(res, 200, {tasks:list()});
    }
    if (url.pathname === '/api/tasks' && req.method === 'DELETE') {
      for (const item of records.values()) {
        if (active.has(item.key) || eligible(item) || !terminal(item.status)) continue;
        fs.unlinkSync(path.join(dir,item.key+'.json')); records.delete(item.key);
      }
      return send(res, 200, {tasks:list()});
    }
    const match = url.pathname.match(/^\/api\/tasks\/([a-f0-9]{32})\/(retry|file)$/);
    const item = match && records.get(match[1]);
    if (!item) return send(res, 404, {error:'任务记录不存在'});
    if (match[2] === 'retry' && req.method === 'POST') {
      if (item.id && item.status !== 'failed' && !active.has(item.key)) { item.nextPollAt = Date.now(); save(item); tick(); }
      return send(res, 200, {task:view(item)});
    }
    if (match[2] === 'file' && ['GET','HEAD'].includes(req.method)) {
      const file = outputPath(item);
      if (!file) { if (item.id) {item.nextPollAt=Date.now();save(item);} return send(res,404,{error:'本地文件不存在，正在尝试重新保存'}); }
      const size = fs.statSync(file).size, ext = path.extname(file).slice(1);
      let start = 0, end = size-1;
      if (req.headers.range) {
        const range = req.headers.range.match(/^bytes=(\d*)-(\d*)$/);
        if (!range || (!range[1] && !range[2])) {res.writeHead(416,{'Content-Range':`bytes */${size}`});res.end();return;}
        if (!range[1]) start = Math.max(0,size-Number(range[2]));
        else {start=Number(range[1]); if(range[2])end=Math.min(end,Number(range[2]));}
        if(start>end || start>=size) {res.writeHead(416,{'Content-Range':`bytes */${size}`});res.end();return;}
      }
      res.writeHead(req.headers.range ? 206 : 200, {'Content-Type':TYPES[ext] || 'application/octet-stream','Content-Length':end-start+1,
        'Accept-Ranges':'bytes','X-Content-Type-Options':'nosniff',...(req.headers.range ? {'Content-Range':`bytes ${start}-${end}/${size}`} : {}),
        ...(url.searchParams.has('download') ? {'Content-Disposition':`attachment; filename*=UTF-8''${encodeURIComponent(path.basename(file))}`} : {})});
      if (req.method === 'HEAD') return res.end();
      await pipeline(fs.createReadStream(file,{start,end}),res); return;
    }
    return send(res,405,{error:'不支持的操作'});
  }
  return {begin,capture,uncertain,start,stop,handle,list};
}
module.exports = {createTasks};
