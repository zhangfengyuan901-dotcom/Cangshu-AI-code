// Local durable task journal. Only query existing IDs; never resubmit generation.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Readable,Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const {decodeInlineImage,directResultURL,imageMime}=require('./direct-media.cjs');

const hash = value => crypto.createHash('sha256').update(value).digest('hex').slice(0, 32);
const terminal = status => ['succeeded', 'failed', 'unknown'].includes(status);
const confirmedTerminal = status => ['succeeded', 'failed'].includes(status);
const stamp = () => new Date().toISOString();
const statusOf = value => ({preparing:'queued',pending:'queued',waiting:'queued',running:'processing',in_progress:'processing',success:'succeeded',completed:'succeeded',failure:'failed',cancelled:'failed',error:'failed'})[String(value).toLowerCase()] || String(value || 'queued').toLowerCase();
const safeUrl = value => { try { const u = new URL(value); return ['http:', 'https:'].includes(u.protocol) ? u.href : ''; } catch { return ''; } };
const TYPES = {png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',webp:'image/webp',gif:'image/gif',mp4:'video/mp4',mov:'video/quicktime',webm:'video/webm',mp3:'audio/mpeg',wav:'audio/wav',txt:'text/plain; charset=utf-8'};

function mediaUrlsOf(payload) {
  const urls = [];
  for (const field of ['images', 'videos', 'audios']) {
    for (const media of Array.isArray(payload?.[field]) ? payload[field] : []) {
      try {
        const url = new URL(typeof media === 'string' ? media : media?.url);
        const key = url.pathname.slice(1);
        if (/^tmp\/\d{4}\/\d{2}\/\d{2}\/[0-9a-f-]{36}\./.test(key) && url.searchParams.has('sig')) urls.push(url.href);
      } catch {}
    }
  }
  for (const item of Array.isArray(payload?.content) ? payload.content : []) {
    const value = item?.image_url?.url || item?.video_url?.url || item?.audio_url?.url;
    if (!value) continue;
    try {
      const url = new URL(value), key = url.pathname.slice(1);
      if (/^tmp\/\d{4}\/\d{2}\/\d{2}\/[0-9a-f-]{36}\./.test(key) && url.searchParams.has('sig')) urls.push(url.href);
    } catch {}
  }
  return [...new Set(urls)];
}

function createTasks({dir, resultDir, resultReadDirs=[], upstream, officialVideoUpstream, dhUpstream, getKey, walletQuery, walletUser=()=>'', relayMode=false, deleteMedia=async()=>{}, onFailure=()=>{}, interval=5000, tickMs=1000, fetchImpl=fetch}) {
  const {findResultFile,directoryUnreachable,within}=require('./electron/work-directory.cjs');
  const resultDirs=[...new Set([resultDir,...resultReadDirs].map(directory=>path.resolve(directory)))];
  const retainedDirs=resultDirs.slice(1);
  const records = new Map(), active = new Set(), downloading = new Set(), cleaning = new Map(), keys = new Map(), controllers = new Set();
  let timer, stopped = false;
  const warnings = [];
  fs.mkdirSync(dir, {recursive:true});
  // Batch receipts outlive cleared task cards. Interrupted batches never resume
  // unsent chargeable slots after a process restart.
  const batchDir=path.join(dir,'batches'),batches=new Map();
  fs.mkdirSync(batchDir,{recursive:true});
  function saveBatch(value){
    const file=path.join(batchDir,value.id+'.json'),temp=file+'.tmp';
    const fd=fs.openSync(temp,'w',0o600);
    try{fs.writeFileSync(fd,JSON.stringify(value));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
    fs.renameSync(temp,file);batches.set(value.id,value);return {...value};
  }
  for(const file of fs.readdirSync(batchDir).filter(f=>/^[a-f0-9]{32}\.json$/.test(f))){
    try{
      const batch=JSON.parse(fs.readFileSync(path.join(batchDir,file),'utf8'));
      if(batch.id!==file.slice(0,-5))continue;
      if(['accepted','running'].includes(batch.status)){
        batch.status='stopped';batch.stopped={code:'process_interrupted',message:'上次批次中断，剩余份数未提交；请核对原任务',submitted:batch.submitted,total:batch.quantity};
        saveBatch(batch);
      }else batches.set(batch.id,batch);
    }catch{warnings.push('批次记录读取失败，原文件已保留，请备份后检查');}
  }
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
    if(['failed','unknown'].includes(item.status) || item.result?.save_error){
      try{onFailure(item.result?.save_error?'RESULT_FAILED':'TASK_FAILED');}catch{}
    }
  }
  function rememberKey(key) { if (key) keys.set(hash(key), key); return key ? hash(key) : ''; }
  const outputPath = item => findResultFile(item.result?.local_path,resultDirs);
  function resultDirectoryUnavailable(item) {
    const file=item.result?.local_path;
    if (typeof file !== 'string' || !file) return false;
    const target=path.resolve(file);
    return retainedDirs.some(directory=>within(directory,target) && directoryUnreachable(directory));
  }
  function view(item) {
    const {keyHash, refreshResult, directMediaResult, ...out} = item;
    if (out.result) {
      out.result = {...out.result};
      delete out.result.inline_image;
      if (outputPath(item)) out.result.local_url = `/api/tasks/${item.key}/file`;
      else { delete out.result.local_path; delete out.result.local_url; }
    }
    if(walletQuery){
      delete out.mediaUrls;delete out.mediaKeys;delete out.mediaLease;
      if(!/^(main-(video|image)-[a-z0-9]+|backup-video-480|tool-(digital|depth))$/.test(out.modelId||'')){
        out.modelId='legacy-'+(out.type==='image'?'image':'video');
        out.modelName=out.provider==='official'?'官方备选线路':'仓鼠线路';
      }
      for(const key of ['error','poll_error','mediaCleanupError'])if(out[key])out[key]=String(out[key]).replace(/https?:\/\/\S+|sanbao\S*|videofee|packy|runninghub|cloudflare|resend|seedance|doubao|\bR2\b|gpt[- ]?image\S*|ep-[\w-]+|(?:sk|ark)-[\w-]+/gi,'仓鼠服务');
      if(out.result&&(!item.walletUser||item.relay)){
        delete out.result.video_url;delete out.result.image_url;delete out.result.download_url;
        if(out.result.save_error)out.result.save_error='结果尚未保存，请恢复查询或联系支持';
      }
    }
    if(item.relay){
      delete out.estimatedCost;delete out.chargedCost;delete out.billingStatus;
      if(out.error)out.error=item.relayFailureCode==='insufficient_balance'?'PIKNO 账户余额不足，请前往账户页充值':'生成未完成，请到 PIKNO 任务记录核对结果';
      if(out.result?.save_error)out.result.save_error='结果尚未保存，请恢复查询或联系支持';
    }
    return out;
  }
  function list() { return [...records.values()].filter(t=>!t.walletUser||t.walletUser===walletUser()).sort((a,b) => b.createdAt.localeCompare(a.createdAt)).map(view); }
  function annotate(item,patch){Object.assign(item,patch);save(item);}
  function annotateRequest(requestId,walletUser,patch){for(const item of records.values())if(item.requestId===requestId&&item.walletUser===walletUser)annotate(item,patch);}
  function batchFor(requestId,walletUser){const value=batches.get(hash(walletUser+':'+requestId));return value&&value.walletUser===walletUser?{...value}:null;}
  function batchGet(id,walletUser){const value=batches.get(id);return value&&value.walletUser===walletUser?{...value}:null;}
  function batchBegin(requestId,walletUser,fingerprint,quantity){
    return batchFor(requestId,walletUser)||saveBatch({id:hash(walletUser+':'+requestId),requestId,walletUser,fingerprint,quantity,submitted:0,status:'accepted',createdAt:stamp()});
  }
  function batchUpdate(id,walletUser,patch){const value=batchGet(id,walletUser);if(!value)throw Error('批次记录不存在');return saveBatch({...value,...patch,updatedAt:stamp()});}
  function batchList(walletUser){return [...batches.values()].filter(b=>b.walletUser===walletUser).map(b=>({...b}));}
  function begin(route, payload, apiKey, requestId, initial={}) {
    const tool = route.startsWith('/rh/') || route.startsWith('/api/tools/');
    const provider = route === '/api/official-videos' ? 'official' : tool ? 'tool' : 'generate';
    const source = tool ? (route.endsWith('2089021172049596418') ? 'depth' : 'digital') : 'generate';
    const type = route === '/api/images' ? 'image' : 'video';
    const prompt = payload.prompt || (Array.isArray(payload.content) ? payload.content.find(item => item?.type === 'text')?.text : '');
    const item = {key:hash(crypto.randomUUID()), id:'', source, provider, type,
      modelId:payload.model || (source === 'depth' ? 'depth-video' : 'digital-human'),
      modelName:source === 'depth' ? '仓鼠黑白深度视频' : source === 'digital' ? '仓鼠数字人' : provider === 'official' ? '官方备选线路-480P' : payload.model,
      prompt:String(prompt || (source === 'depth' ? '黑白深度视频' : '数字人视频')),
      status:'submitting', createdAt:stamp(), result:null, keyHash:rememberKey(apiKey), requestId:requestId || '', progress:0,
      mediaLease:crypto.randomUUID(), mediaUrls:mediaUrlsOf(payload),...initial};
    save(item); // Must succeed before any chargeable upstream request is sent.
    return item;
  }
  function uncertain(item, message) {
    item.status = 'unknown'; item.poll_error = message || '提交结果待确认，未取得任务 ID。请勿重复提交。'; save(item);
  }
  function cleanupInputs(item) {
    if (stopped || !item.mediaLease || !(item.mediaUrls?.length || item.mediaKeys?.length)) return Promise.resolve();
    if (cleaning.has(item.mediaLease)) return cleaning.get(item.mediaLease);
    const group = [...records.values()].filter(record => record.mediaLease === item.mediaLease);
    if (!group.length || group.some(record => !confirmedTerminal(record.status))) return Promise.resolve();
    const objects = [...new Set(group.flatMap(record => [...(record.mediaUrls || []), ...(record.mediaKeys || [])]))];
    if (!objects.length) return Promise.resolve();
    const pending = cleanupInputsNow(group, objects).finally(() => cleaning.delete(item.mediaLease));
    cleaning.set(item.mediaLease, pending);
    return pending;
  }
  async function cleanupInputsNow(group, objects) {
    try {
      await deleteMedia(objects);
      if (stopped) return;
      for (const record of group) {
        record.mediaUrls = [];
        record.mediaKeys = [];
        record.mediaCleanedAt = stamp();
        delete record.mediaCleanupError;
        save(record);
      }
    } catch {
      if (stopped) return;
      for (const record of group) {
        record.mediaCleanupError = '临时素材主动清理未确认，将由 1 天生命周期规则兜底';
        save(record);
      }
    }
  }
  async function capture(submission, response, httpStatus) {
    if (httpStatus >= 400 || response?.errorCode) {
      submission.status = httpStatus >= 500 || httpStatus === 408 ? 'unknown' : 'failed';
      submission.error = String(response?.errorMessage || response?.error || `提交请求异常 (${httpStatus})`);
      save(submission);
      await cleanupInputs(submission);
      return;
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
    if (count) {
      fs.unlinkSync(path.join(dir, submission.key + '.json')); records.delete(submission.key);
      const member = [...records.values()].find(record => record.mediaLease === submission.mediaLease);
      if (member) void cleanupInputs(member).catch(() => {});
    }
    else uncertain(submission, '未收到有效任务 ID，提交结果待确认。请核对服务端记录，勿重复提交。');
  }
  function preserveAccepted(submission,response){
    // An accepted upstream response cannot become a failed generation because
    // the local fsync/rename failed. Keep its ID (or synchronous result) and
    // only query/save that original result. The pre-submit receipt remains on
    // disk even when a continuing disk fault prevents this repair from saving.
    const item=[...records.values()].find(value=>value.requestId===submission.requestId&&value.walletUser===submission.walletUser&&value.id===response.id)||submission;
    item.id=response.id;applyStatus(item,response);
    item.poll_error='服务已受理，本地记录保存待确认；仅查询原任务，请勿重复提交';
    item.nextPollAt=Date.now();
    try{save(item);}catch{records.set(item.key,item);try{onFailure('RESULT_FAILED');}catch{}}
    if(item.key!==submission.key){
      try{fs.unlinkSync(path.join(dir,submission.key+'.json'));}catch{}
      records.delete(submission.key);
    }
  }
  function applyStatus(item, data) {
    if(item.walletUser){item.billingStatus=data.billing_status||'';item.estimatedCost=data.estimated_cost;item.chargedCost=data.cost;}
    const status = statusOf(data.status);
    if (!['queued','processing','succeeded','failed','unknown'].includes(status)) throw new Error('任务状态暂不可识别，稍后重新查询');
    item.status = status;
    item.progress = Math.max(0, Math.min(100, Number.parseFloat(data.progress) || (status === 'succeeded' ? 100 : item.progress || 1)));
    item.lastPolledAt = stamp(); item.poll_error = ''; item.error = '';
    if (status === 'unknown') item.poll_error = '任务状态待确认，将继续查询原任务；请勿重复提交，可到 PIKNO 任务记录或联系管理员核对';
    if (status === 'failed') item.error = String(data.fail_reason || data.errorMessage || data.error || data.errorCode || '生成失败');
    if (status !== 'succeeded') return;
    item.completedAt ||= stamp();
    const results = Array.isArray(data.results) ? data.results : Array.isArray(data.outputs) ? data.outputs.map(output=>({url:output.url,outputType:output.type==='video'?'mp4':output.type==='image'?'png':''})) : [];
    const inline=results.find(result=>typeof result.b64_json==='string');
    const pick = results.find(r => /mp4|webm|mov/i.test(r.outputType || '')) || results.find(r => r.url);
    const text = results.filter(r => r.text != null).map(r => String(r.text)).join('\n');
    item.result = {...item.result,
      video_url:safeUrl(data.video_url || data.result_url || data.data?.url || (item.type === 'video' ? pick?.url : '')),
      image_url:safeUrl(data.image_url || (item.type === 'image' ? pick?.url : '')),
      download_url:safeUrl(data.download_url || data.result_url || data.data?.url || pick?.url),
      link_expires_in:data.link_expires_in || (pick ? 86400 : 0),
      outputType:pick?.outputType || item.type, text:text || item.result?.text || '', linksUpdatedAt:stamp()};
    if(inline&&item.type==='image'){decodeInlineImage(inline.b64_json);item.result.inline_image=inline.b64_json;}
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
    if (directoryUnreachable(path.resolve(resultDir))) throw Error('无法访问作品目录');
    if(typeof result.inline_image==='string'){
      const {bytes,mime}=decodeInlineImage(result.inline_image);
      const ext={'image/png':'png','image/jpeg':'jpg','image/webp':'webp'}[mime];
      const file=path.join(resultDir,`仓鼠-${item.key}.${ext}`),temp=file+'.part';
      if(!fs.existsSync(file)){
        const descriptor=fs.openSync(temp,'w',0o600);
        try{fs.writeFileSync(descriptor,bytes);fs.fsyncSync(descriptor);}finally{fs.closeSync(descriptor);}
        if(stopped||!currentOwner(item)){try{fs.unlinkSync(temp);}catch{}throw Error('结果保存已暂停');}
        fs.renameSync(temp,file);
      }
      result.local_path=file;result.local_name=path.basename(file);result.savedAt=stamp();result.save_error='';
      delete result.inline_image;
      return;
    }
    if (result.text && !result.download_url && !result.video_url && !result.image_url) {
      const file = path.join(resultDir, `仓鼠-${item.key}.txt`);
      fs.writeFileSync(file + '.part', result.text, 'utf8'); fs.renameSync(file + '.part', file);
      result.local_path = file; result.local_name = path.basename(file); result.save_error = ''; return;
    }
    const directKind=['image','tool'].includes(item.directMediaResult)?item.directMediaResult:null;
    const source=result.download_url || result.video_url || result.image_url;
    const url = directKind?directResultURL(source,directKind):safeUrl(source);
    if (!url) throw new Error('任务已完成，暂未返回结果链接；将重新查询');
    result.saving = true; save(item);
    try {
      await network(url, directKind?{redirect:'manual'}:{}, async response => {
        if (response.status !== 200 || !response.body || response.headers.has('content-range')) {
          await response.body?.cancel().catch(() => {});
          throw Object.assign(new Error(`结果下载失败 (${response.status})，稍后重试`), {refreshLink:[401,403,404,410].includes(response.status)});
        }
        const mime = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
        const declared=response.headers.get('content-length');
        const resultLimit=directKind==='image'?16<<20:50<<20;
        if(directKind&&(declared!==null&&(!/^\d+$/.test(declared)||Number(declared)>resultLimit)||directKind==='image'&&!['image/png','image/jpeg','image/webp'].includes(mime)||directKind==='tool'&&!['','application/octet-stream','video/mp4'].includes(mime))){
          await response.body.cancel().catch(()=>{});throw Error('结果文件大小或格式无效');
        }
        if (/text\/html|application\/json/.test(mime)) {
          await response.body.cancel().catch(() => {});
          throw new Error('结果返回了错误页面，稍后重试');
        }
        const urlExt = path.extname(new URL(url).pathname).slice(1).toLowerCase();
        const ext = directKind==='tool'?'mp4':Object.keys(TYPES).find(e => TYPES[e] === mime) || (TYPES[urlExt] ? urlExt : item.type === 'video' ? 'mp4' : 'png');
        const file = path.join(resultDir, `仓鼠-${item.key}.${ext}`), temp = file + '.part';
        // A completed deterministic file survives a crash between rename and journal update.
        if (!fs.existsSync(file) || !fs.statSync(file).size) {
          try {
            let received=0,signature=Buffer.alloc(0);
            const checked=new Transform({transform(chunk,_encoding,done){
              received+=chunk.length;
              if(directKind&&received>resultLimit){done(Error('结果文件超过大小限制'));return;}
              if(signature.length<12)signature=Buffer.concat([signature,chunk.subarray(0,12-signature.length)]);
              done(null,chunk);
            },flush(done){
              const valid=directKind==='image'?imageMime(signature)===mime:signature.toString('ascii',4,8)==='ftyp';
              done(directKind&&(received<12||!valid)?Error('结果文件内容与格式不匹配'):null);
            }});
            await pipeline(Readable.fromWeb(response.body), checked, fs.createWriteStream(temp));
            const length = fs.statSync(temp).size;
            if (!length) throw new Error('下载文件为空');
            const declared = response.headers.get('content-length');
            const encoding = response.headers.get('content-encoding');
            if ((!encoding || encoding === 'identity') && declared !== null && (!/^\d+$/.test(declared) || Number(declared) !== length)) throw new Error('结果下载不完整，稍后重试');
            if (stopped || !currentOwner(item)) throw new Error('结果保存已暂停');
            fs.renameSync(temp, file);
          } catch (e) { try { fs.unlinkSync(temp); } catch {} throw e; }
        } else await response.body.cancel();
        if (stopped || !currentOwner(item)) throw new Error('结果保存已暂停');
        result.local_path = file; result.local_name = path.basename(file); result.savedAt = stamp(); result.save_error = '';
      }, 300000);
    } finally { delete result.saving; }
  }
  const currentOwner = item => !item.walletUser || item.walletUser === walletUser();
  const hasResult = item => !!(item.result?.inline_image || item.result?.text || safeUrl(item.result?.download_url || item.result?.video_url || item.result?.image_url));
  function expiredResult(item) {
    const seconds = Number(item.result?.link_expires_in), updated = Date.parse(item.result?.linksUpdatedAt);
    return seconds > 0 && Number.isFinite(updated) && updated + seconds * 1000 <= Date.now();
  }
  async function saveResult(item) {
    if (downloading.has(item.key) || stopped || !currentOwner(item)) return;
    downloading.add(item.key);
    try {
      await download(item);
      item.saveFailures = 0;
      delete item.refreshResult;
    } catch (e) {
      item.result.save_error = '结果尚未保存，请恢复查询或稍后重试';
      item.saveFailures = (item.saveFailures || 0) + 1;
      item.nextPollAt = Date.now() + Math.min(300000, interval * 2 ** Math.min(item.saveFailures, 6));
      if (e.refreshLink) item.refreshResult = true;
    } finally {
      try { save(item); } finally { downloading.delete(item.key); if (!stopped) tick(); }
    }
  }
  function eligible(item) { return item.id && (!terminal(item.status) || item.status==='unknown' || (item.status === 'succeeded' && !outputPath(item))); }
  async function poll(item) {
    if (active.has(item.key) || stopped) return;
    active.add(item.key);
    try {
      let data;
      if(item.walletUser){
        if(!walletQuery)throw new Error('账户任务查询尚未就绪');
        data=await walletQuery(item);
      }else{
      if(relayMode)throw new Error('旧任务仅保留本地记录，不再直连旧服务');
      const provider = item.provider || (item.source === 'generate' ? 'generate' : 'tool');
      const configured = getKey(provider);
      const key = keys.get(item.keyHash) || (configured && (!item.keyHash || hash(configured) === item.keyHash) ? configured : '');
      if (!key) throw Object.assign(new Error('等待原任务使用的 API Key，请在账户配置后恢复查询'), {status:401});
      const url = provider === 'official' ? `${officialVideoUpstream}/v1/video/generations/${encodeURIComponent(item.id)}`
        : provider === 'generate' ? `${upstream}/openapi/v1/${item.type === 'video' ? 'videos' : 'images'}/${encodeURIComponent(item.id)}` : `${dhUpstream}/query`;
      const options = {headers:{Authorization:`Bearer ${key}`, 'Content-Type':'application/json'}};
      if (provider === 'tool') { options.method = 'POST'; options.body = JSON.stringify({taskId:item.id}); }
      data = await network(url, options, async response => {
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
      }
      if (stopped || !currentOwner(item)) return;
      if (item.status === 'succeeded' && statusOf(data.status) !== 'succeeded') throw new Error('原任务的结果链接暂不可用，稍后重试');
      applyStatus(item, data);
      delete item.refreshResult;
      item.failures = 0; item.nextPollAt = Date.now() + interval;
      save(item); // Completion and links are durable before downloading starts.
      void cleanupInputs(item).catch(() => {});
      if (item.status === 'succeeded' && hasResult(item)) item.nextPollAt = Date.now();
    } catch (e) {
      item.poll_error = item.walletUser && [401,403].includes(e.statusCode||e.status) ? '请登录原任务所属账户后恢复查询；任务记录仍保留' : e.status === 401 || e.status === 403 ? '鉴权暂不可用，请检查原任务的 API Key；任务记录仍保留' : e.message;
      item.failures = (item.failures || 0) + 1;
      const delay = e.status === 401 || e.status === 403 ? 60000 : Math.min(60000, interval * 2 ** Math.min(item.failures, 6));
      item.nextPollAt = Date.now() + Math.max(delay, Math.min(3600000, e.retryMs || 0));
    } finally {
      try { save(item); } finally { active.delete(item.key); if (!stopped) tick(); }
    }
  }
  function tick() {
    if (stopped) return;
    for (const item of records.values()) {
      if (!eligible(item) || !currentOwner(item) || active.has(item.key) || downloading.has(item.key) || (item.nextPollAt || 0) > Date.now() || resultDirectoryUnavailable(item)) continue;
      if (item.status === 'succeeded' && hasResult(item) && !item.refreshResult && !expiredResult(item)) {
        if (downloading.size < 2) saveResult(item).catch(() => {});
      } else if (active.size < 2) poll(item).catch(() => {});
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
      const status = url.searchParams.get('status');
      if (url.searchParams.has('status') && status !== 'failed') return send(res, 400, {error:'不支持的任务筛选条件'});
      for (const item of records.values()) {
        if(item.walletUser && item.walletUser!==walletUser())continue;
        if (status === 'failed' && item.status !== 'failed') continue;
        if (active.has(item.key) || downloading.has(item.key) || cleaning.has(item.mediaLease) || eligible(item) || !confirmedTerminal(item.status)) continue;
        fs.unlinkSync(path.join(dir,item.key+'.json')); records.delete(item.key);
      }
      return send(res, 200, {tasks:list()});
    }
    const match = url.pathname.match(/^\/api\/tasks\/([a-f0-9]{32})\/(retry|file)$/);
    const item = match && records.get(match[1]);
    if (!item || item.walletUser && item.walletUser!==walletUser()) return send(res, 404, {error:'任务记录不存在'});
    if (match[2] === 'retry' && req.method === 'POST') {
      if (item.id && item.status !== 'failed' && !active.has(item.key) && !downloading.has(item.key)) { item.nextPollAt = Date.now(); save(item); tick(); }
      return send(res, 200, {task:view(item)});
    }
    if (match[2] === 'file' && ['GET','HEAD'].includes(req.method)) {
      const file = outputPath(item);
      if (!file) {
        if (resultDirectoryUnavailable(item)) return send(res,404,{error:'结果所在目录暂不可用，请连接磁盘后重试'});
        if (item.id) {item.nextPollAt=Date.now();save(item);}
        return send(res,404,{error:'本地文件不存在，正在尝试重新保存'});
      }
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
  return {begin,capture,preserveAccepted,uncertain,annotate,annotateRequest,batchFor,batchGet,batchBegin,batchUpdate,batchList,start,stop,handle,list,view};
}
module.exports = {createTasks};
