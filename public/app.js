import {
  isVideo, isImage, concurrencyOptions, defaultVideoOptions, defaultImageOptions, closestImageRatio, imageSizesForRatio,
  buildVideoPayload, buildImagePayload, buildImageEditPrompt, extractTaskIds, hamsterModelName, mapUpstreamModels, mediaLimitError, publicText,
  OFFICIAL_VIDEO_ROUTE, modelMediaSummary, supportsImageMarks,
} from './core.mjs';
import { autoAnimate } from './vendor/auto-animate.mjs';
import { assetLibrary, pickAsset, chooseAssetCategory, assetsRequest } from './asset-library.mjs';
import { copyTaskPrompt } from './task-prompt.mjs';
import { fileFingerprint, createUploadGate } from './media-upload-state.mjs';
import { installFaultEvents } from './fault-events.mjs';
import {pricingQuote,quoteValid,quoteSummary,catalogPriceText,formatMoney} from './canvas-pricing.mjs';
import {createQuoteController,createQuoteConfirmation,quoteFingerprint} from './quote-ui.mjs';
import {createInferenceIndicator} from './inference-indicator.mjs';
import {toolAvailability,batchIsActive,batchProgressText} from './relay-ui-state.mjs';
installFaultEvents();

const API_BASE = '/api';
const KEY_STORAGE = 'hamster_api_key';
const KEY_STORAGE_VIDEO = 'hamster_official_video_api_key';
const KEY_STORAGE_RH = 'hamster_rh_api_key';
const HISTORY_STORAGE = 'hamster_history';
const MODEL_CACHE_STORAGE = 'hamster_wallet_model_cache_v1';
const MODEL_CACHE_TTL = 6 * 60 * 60 * 1000;
let relayConfigRevision = 0;
let modelLoadRevision = 0;

/* ---- 数字人 ---- */
const RH_MAX_AUDIO_SECONDS = 30;

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const REFERENCE_OPTIONS = [
  { value: 'all', label: '全能参考' },
  { value: 'startEnd', label: '首尾帧' },
  { value: 'face', label: '人物一致' },
];
const STATUS_LABEL = { submitting:'提交中', unknown:'任务待确认', queued: '排队中', processing: '生成中', succeeded: '已完成', failed: '失败' };
const KIND_LABEL = { image: '图片', video: '视频', audio: '音频' };
const QUALITY_LABEL = { auto: '自动', high: '高质量', medium: '标准', low: '快速' };
const HISTORY_BATCH_SIZE = 40;

const state = {
  apiKey: '',
  serverKeyConfigured: false,
  videoApiKey: '',
  videoServerConfigured: false,
  rhApiKey: '',
  rhServerConfigured: false,
  toolModels: [],
  toolChecking:false,
  toolCatalogReady:false,
  toolConnection:null,
  toolStates:{},
  batches:[],
  llmServerConfigured: false,
  relayMode: false,
  relayServerRevision: undefined,
  dh: { image: null, audio: null },
  depth: { video: null },
  models: [],
  type: 'video',
  model: null,
  options: {},
  concurrency: 1,
  media: [],
  pendingMedia: [],
  submitting: false,
  tasks: [],
  assetSummary: { total: 0, counts: {} },
  tagCounters: { image: 0, video: 0, audio: 0 },
};

function refreshIcons(root = document) {
  const icons = window.lucide;
  if (!icons?.createIcons || !icons?.icons) return;
  icons.createIcons({ icons: icons.icons, root, attrs: { 'stroke-width': 1.8, 'aria-hidden': 'true' } });
}
function initUiComponents() {
  refreshIcons();
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    document.documentElement.dataset.uiMotion = 'reduced';
    return;
  }
  for (const selector of ['#mediaList', '#taskFeed', '#dhResults', '#depthResults', '#historyList']) {
    const element = $(selector);
    if (element) autoAnimate(element, { duration: 190, easing: 'ease-out' });
  }
  document.documentElement.dataset.uiMotion = 'auto-animate';
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
let toastTimer = null;
function toast(msg) {
  const t = $('#toast');
  t.textContent = publicText(msg);
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 3200);
}

const inflightGets = new Map();
function request(path, options = {}) {
  const { method = 'GET', json, raw } = options;
  const key = method === 'GET' && json === undefined && raw === undefined ? `${path}\0${state.apiKey}` : '';
  if (key && inflightGets.has(key)) return inflightGets.get(key);
  const pending = requestOnce(path, options);
  if (key) {
    inflightGets.set(key,pending);
    pending.finally(() => { if (inflightGets.get(key) === pending) inflightGets.delete(key); }).catch(() => {});
  }
  return pending;
}
async function requestOnce(path, { method = 'GET', json, raw, contentType, headers = {}, signal } = {}) {
  const opts = { method, signal, headers: { Authorization: `Bearer ${state.apiKey}`, ...headers } };
  if(state.relayMode&&Number.isSafeInteger(state.relayServerRevision)&&method==='POST'&&['/images','/videos','/tools/digital','/tools/depth'].includes(path))opts.headers['X-Hamster-Config-Revision']=String(state.relayServerRevision);
  if (json !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(json);
  } else if (raw !== undefined) {
    opts.headers['Content-Type'] = contentType || 'application/octet-stream';
    opts.body = raw;
  }
  const res = await fetch(API_BASE + path, opts);
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    const err = new Error(data?.error || data?.detail || `请求失败 (${res.status})`);
    err.status = res.status;
    err.code = data?.code;
    throw err;
  }
  return data;
}
function handleError(e) {
  const msg = e?.payload?.errorMessage || e?.payload?.message || e?.message;
  if (e?.status === 401) toast(state.relayMode?'Key 验证未通过，请到「账户」页检查 PIKNO Key':'登录已失效，请到「账户」页重新登录');
  else if (e?.status === 402) toast(state.relayMode?'PIKNO 账户余额不足，请到 PIKNO 充值后重新获取报价':'服务额度不足，请联系管理员');
  else if (e?.status === 429) toast('请求过于频繁，请稍后重试');
  else if (e?.status === 413) toast('素材文件过大');
  else if (e?.status === 502 || e?.status === 503) toast('服务暂时不可用，请稍后重试');
  else toast(msg || '请求失败');
}
function hasKey() { return Boolean(state.apiKey || state.serverKeyConfigured); }
function hasVideoKey() { return Boolean(state.videoApiKey || state.videoServerConfigured); }
function hasGenerationKey() { return state.type === 'official-video' || state.relayMode&&state.type==='video' ? hasVideoKey() : hasKey(); }
function hasRhKey() { return Boolean(state.rhApiKey || state.rhServerConfigured); }
function accountHint(){return state.relayMode?'请先到「账户」页配置有效的 PIKNO Key':'请先在「账户」页完成邮箱登录';}

// 报价只携带计费参数与素材数量；提示词和素材地址留在本机。
const pendingQuotedSubmissions=new Map();
const quotePanels={generate:'#generationQuote',imageEdit:'#imageEditQuote',digital:'#digitalQuote',depth:'#depthQuote'};
function surfaceModel(key){return key==='generate'?state.model:key==='imageEdit'?imageModels().find(m=>m.id===$('#imageEditModel').value):state.toolModels.find(m=>m.id===(key==='digital'?'tool-digital':'tool-depth'));}
function quoteSnapshot(key){
  if(!state.relayMode||accountSessionRejected||!Number.isSafeInteger(state.relayServerRevision))return null;
  const model=surfaceModel(key);if(!model)return null;
  const payload={model:model.id,concurrency:key==='generate'?state.concurrency:1,media_counts:{images:0,videos:0,audios:0}};
  let context;
  if(key==='generate'){
    if(!hasGenerationKey())return null;
    for(const field of ['size','quality','aspect_ratio','ratio','resolution','duration','reference'])if(state.options[field]!==undefined)payload[field]=state.options[field];
    const media=[...state.media,...state.pendingMedia];
    if(mediaLimitError(model,media))return null;
    for(const item of media){const field={image:'images',video:'videos',audio:'audios'}[item.kind];if(field)payload.media_counts[field]++;}
    context=media.map(item=>[item.uiKey,item.url,item.authorizationInvalid]);
  }else if(key==='imageEdit'){
    if(!hasKey()||!imageEdit.blob||!$('#imageEditDialog').open)return null;
    payload.size=$('#imageEditSize').value;payload.quality=$('#imageEditQuality').value;payload.aspect_ratio=$('#imageEditRatio').value;
    payload.media_counts.images=imageEdit.strokes.length?2:1;context=[imageEdit.loadId,imageEdit.strokes.length];
    if(mediaLimitError(model,Array.from({length:payload.media_counts.images},()=>({kind:'image'}))))return null;
  }else{
    if(!rhHasKey()||toolStatus(key).state!=='ready')return null;
    if(key==='digital'){if(!state.dh.image?.fileName||!state.dh.audio?.fileName)return null;payload.media_counts.images=1;payload.media_counts.audios=1;context=[state.dh.image.fileName,state.dh.audio.fileName];}
    else {if(!state.depth.video?.fileName)return null;payload.media_counts.videos=1;context=[state.depth.video.fileName];}
  }
  return {revision:state.relayServerRevision,version:model.line_revision??model.price_version,payload,context};
}
function quoteIsCurrent(key,snapshot){return quoteFingerprint(snapshot)===quoteFingerprint(quoteSnapshot(key));}
function renderQuoteCard(key,entry){
  const panel=$(quotePanels[key]);if(!panel)return;
  panel.hidden=!state.relayMode;panel.dataset.state=pendingQuotedSubmissions.has(key)?'unknown':entry.status;
  const model=surfaceModel(key),quote=entry.quote;
  panel.querySelector('[data-quote-title]').textContent=quote?.name||model?.name||'请选择线路';
  let description='暂时无法确认费用，请先配置对应 Key 并选择可用线路';
  if(entry.status==='empty'&&model)description=catalogPriceText(model)+' · 请先准备素材以获取本次报价';
  if(pendingQuotedSubmissions.has(key))description='上次提交结果待确认。请先核对历史记录，暂不再次提交。';
  else if(entry.status==='loading')description='正在获取本次报价…';
  else if(entry.status==='ready')description=quoteSummary(quote)+(quote.reference_surcharge_cny&&!/^0(?:\.0+)?$/.test(quote.reference_surcharge_cny)?` · 含每份参考素材附加费 ${formatMoney(quote.reference_surcharge_cny)}`:'');
  else if(entry.status==='expired')description='报价已失效，请重新获取报价并确认';
  else if(entry.status==='error')description='暂时无法确认费用，请重新获取报价';
  panel.querySelector('[data-quote-description]').textContent=description;
  const refresh=panel.querySelector('[data-quote-refresh]');refresh.disabled=entry.status==='loading';refresh.textContent=pendingQuotedSubmissions.has(key)?'查询原任务':'重新报价';
}
function quoteReady(key){const snapshot=quoteSnapshot(key),entry=quoteController.state(key);return !pendingQuotedSubmissions.has(key)&&snapshot&&entry.fingerprint===quoteFingerprint(snapshot)&&entry.status==='ready'&&quoteValid(entry.quote,{model:snapshot.payload.model,quantity:snapshot.payload.concurrency});}
function refreshQuoteAvailability(key){
  if(key==='generate'){
    const error=state.model?mediaLimitError(state.model,[...state.media,...state.pendingMedia]):'';
    $('.send-button').disabled=!state.model||Boolean(error)||state.submitting||Object.values(activeFileBatches).some(Boolean)||state.pendingMedia.length>0||(state.relayMode&&(!quoteReady(key)||state.batches?.some(batchIsActive)));
  }else if(key==='imageEdit')$('#imageEditSubmit').disabled=imageEdit.busy||imageEdit.loading||imageEdit.aborted||!imageEdit.blob||(state.relayMode&&!quoteReady(key));
  else if(key==='digital')dhSetHint(false);else depthSetHint(false);
}
const quoteController=createQuoteController({
  request:snapshot=>requestOnce('/quotes',{method:'POST',json:snapshot.payload,headers:{'X-Hamster-Config-Revision':String(snapshot.revision)}}),
  isCurrent:quoteIsCurrent,
  onChange:(key,entry)=>{renderQuoteCard(key,entry);refreshQuoteAvailability(key);},
});
const quoteConfirmation=createQuoteConfirmation({dialog:$('#quoteConfirmDialog')});
function updateSurfaceQuote(key){if(pendingQuotedSubmissions.has(key)){renderQuoteCard(key,quoteController.state(key));return;}const entry=quoteController.update(key,quoteSnapshot(key));if(!entry)renderQuoteCard(key,{status:'empty',quote:null});}
function quoteDetails(snapshot){const p=snapshot.payload;return [p.size&&p.size!=='auto'?p.size.replace('x',' × '):'',p.resolution||'',p.duration?`${p.duration} 秒`:'',p.aspect_ratio||p.ratio||'',p.quality?QUALITY_LABEL[p.quality]||p.quality:'',`${p.media_counts.images} 图 / ${p.media_counts.videos} 视频 / ${p.media_counts.audios} 音频`].filter(Boolean).join(' · ');}
async function confirmPaidSubmission(key,snapshot){
  if(!state.relayMode)return {};
  if(pendingQuotedSubmissions.has(key)){toast('上次提交结果待确认，请先核对历史记录，勿重复提交');return null;}
  if(!snapshot||!quoteIsCurrent(key,snapshot))return null;
  const quote=await quoteController.ensure(key,snapshot);
  if(!quote||!quoteIsCurrent(key,snapshot)){toast('暂时无法确认本次费用，请重新获取报价');return null;}
  const accepted=await quoteConfirmation.confirm({quote,details:quoteDetails(snapshot),isCurrent:()=>quoteIsCurrent(key,snapshot)});
  return accepted&&quoteIsCurrent(key,snapshot)&&quoteValid(quote,{model:snapshot.payload.model,quantity:snapshot.payload.concurrency})?quote:null;
}
function confirmedQuoteCurrent(key,snapshot,quote){return !state.relayMode||quoteIsCurrent(key,snapshot)&&quoteValid(quote,{model:snapshot?.payload.model,quantity:snapshot?.payload.concurrency});}
function quoteSubmissionFailed(key,error,requestId){
  if(!state.relayMode)return false;
  if(['quote_expired','quote_changed','quote_parameters_changed','quote_invalid'].includes(error?.code)){
    quoteController.invalidate(key,'expired');toast('本次报价已失效，任务未继续提交。请重新获取报价并确认。');return true;
  }
  if(error?.code==='quote_already_submitted'||!error?.status||error.status>=500){
    pendingQuotedSubmissions.set(key,requestId);quoteController.invalidate(key,'unknown');toast('提交结果待确认，请先核对历史记录，勿重复提交');return true;
  }
  return false;
}
function noteQuotedResult(key,created,requestId){
  if(!state.relayMode)return;
  const tasks=created?.tasks||[created?.task].filter(Boolean);
  if(created?.batch){state.batches=[created.batch,...(state.batches||[]).filter(batch=>batch.id!==created.batch.id)];renderBatchControls();}
  if(batchIsActive(created?.batch)||!tasks.length&&created?.stopped||tasks.some(task=>task.status==='unknown'||task.status==='submitting'))pendingQuotedSubmissions.set(key,requestId);
  quoteController.invalidate(key,pendingQuotedSubmissions.has(key)?'unknown':'expired');
}
function submissionMessage(created){const tasks=created?.tasks||[created?.task].filter(Boolean);return created?.batch?batchProgressText(created.batch):created?.stopped?(created.stopped.submitted?`已处理 ${created.stopped.submitted}/${created.stopped.total} 份；剩余未提交，请先核对历史记录。`:'原批次正在处理中，请先核对历史记录，勿重复提交。'):tasks.some(task=>['unknown','submitting'].includes(task.status))?'提交结果待确认，请先核对历史记录，勿重复提交':'已提交，任务将在后台继续';}
function settleQuotedSubmissions(){
  for(const [key,requestId] of pendingQuotedSubmissions){
    const tasks=state.tasks.filter(task=>task.requestId===requestId||task.requestId?.startsWith(requestId+':'));
    if(tasks.length&&!state.batches?.some(batch=>batchIsActive(batch)&&(batch.requestId===requestId||key==='generate'))&&tasks.every(task=>!['unknown','submitting'].includes(task.status))){pendingQuotedSubmissions.delete(key);if(key==='imageEdit')imageEdit.aborted=false;quoteController.invalidate(key,'expired');}
  }
}
function resetSurfaceQuotes(){pendingQuotedSubmissions.clear();quoteConfirmation.cancel();quoteController.reset();}

/* ---- 数字人请求（走 /rh 代理） ---- */
/* 工具素材与其他生成素材使用相同的账户素材通道。 */
async function rhUpload(file) {
  const revision=relayConfigRevision;
  const kind=file.type.startsWith('image/')?'image':file.type.startsWith('audio/')?'audio':'video';
  const fingerprint=await fileFingerprint(file);
  if(revision!==relayConfigRevision)throw Object.assign(new Error('连接配置已变更，请重新上传素材'),{status:409});
  const result=await uploadFile(file,kind,false,undefined,fingerprint,state.relayMode?'tool':'video');
  const url=result?.url;
  if(!url)throw new Error('素材上传未完成，请重试');
  return url;
}

/* 读取音频时长（秒），失败返回 NaN */
function audioDuration(fileOrUrl) {
  return new Promise((resolve) => {
    const objectUrl = typeof fileOrUrl !== 'string';
    const url = objectUrl ? URL.createObjectURL(fileOrUrl) : fileOrUrl;
    const a = document.createElement('audio');
    a.preload = 'metadata';
    a.onloadedmetadata = () => { if(objectUrl)URL.revokeObjectURL(url); resolve(a.duration); };
    a.onerror = () => { if(objectUrl)URL.revokeObjectURL(url); resolve(NaN); };
    a.src = url;
  });
}

// ---- 账户 ----
function renderAccount() {}

// ---- 模型 ----
function videoModels() { return state.models.filter(m=>isVideo(m)&&m.provider!=='official'); }
function imageModels() { return state.models.filter(isImage); }
function isVideoType() { return state.type === 'video' || state.type === 'official-video'; }
function modelsOfType() {
  if (state.type === 'official-video') return state.models.filter(m=>m.provider==='official');
  return state.type === 'video' ? videoModels() : imageModels();
}
function readModelCache() {
  try {
    const cached=JSON.parse(localStorage.getItem(MODEL_CACHE_STORAGE) || 'null');
    if(cached?.version!==2 || !Array.isArray(cached.models) || !Number.isFinite(cached.updatedAt))return null;
    const models=cached.models.filter(model=>model && typeof model.id==='string');
    return models.length ? {...cached,models,fresh:Date.now()-cached.updatedAt<MODEL_CACHE_TTL} : null;
  } catch { return null; }
}
function writeModelCache(models) {
  try { localStorage.setItem(MODEL_CACHE_STORAGE,JSON.stringify({version:2,updatedAt:Date.now(),models})); } catch {}
}
async function loadModels(configReady = Promise.resolve(), {force=false} = {}) {
  await Promise.resolve(configReady);
  const revision=relayConfigRevision,catalogRevision=++modelLoadRevision;
  const current=()=>revision===relayConfigRevision&&catalogRevision===modelLoadRevision;
  if(state.relayMode){state.toolChecking=hasRhKey();state.toolCatalogReady=false;state.toolConnection=null;state.toolStates={};dhSetHint();depthSetHint();}
  const cached=state.relayMode?null:readModelCache();
  if(state.relayMode)localStorage.removeItem(MODEL_CACHE_STORAGE);
  if(cached){state.models=cached.models;pickDefaultModel();renderComposer();}
  const catalog=rows=>{if(!current())return [];state.toolModels=(rows||[]).filter(m=>m.provider==='tool');return mapUpstreamModels(rows);};
  let models=[];
  if(hasKey()||state.relayMode&&(hasVideoKey()||hasRhKey())) {
    try {
      const [response,connection]=await Promise.all([force?requestOnce('/models'):request('/models'),state.relayMode&&hasRhKey()?request('/relay/connection').catch(()=>null):Promise.resolve(null)]);
      if(current()&&state.relayMode&&Number.isSafeInteger(state.relayServerRevision)&&Number.isSafeInteger(response?.revision)&&response.revision!==state.relayServerRevision){window.dispatchEvent(new Event('hamster-relay-configured'));return;}
      models=catalog(response?.data || []);
      if(current()&&state.relayMode){state.toolConnection=connection?.tool||null;state.toolStates=connection?.toolStates||{};}
    } catch {if(current()&&state.relayMode)state.toolModels=[];}
  }
  if(!models.length&&!state.relayMode) {
    try { models=catalog((await request('/public-models'))?.data || []); } catch {}
  }
  if(!current())return;
  if(state.relayMode){state.toolChecking=false;state.toolCatalogReady=true;}
  if(models.length){state.models=models;if(!state.relayMode)writeModelCache(models);}
  else if(!cached)state.models=[];
  if(state.relayMode&&state.models.length&&!modelsOfType().length)setType(videoModels().length?'video':'image');
  else pickDefaultModel();
  renderComposer();
  dhSetHint();depthSetHint();
}
function pickDefaultModel() {
  const list = modelsOfType();
  if (!list.length) { state.model = null; state.options = {}; return; }
  state.model = list.find((m) => m.id === state.model?.id) || list[0];
  state.options = isVideoType() ? defaultVideoOptions(state.model) : defaultImageOptions(state.model);
  clampConcurrency();
}
function renderComposer() {
  const m = state.model;
  $('#sizePill').style.display = !isVideoType() && m?.size_options?.length ? '' : 'none';
  renderMediaLimits();
  if (!m) {
    $('#modelLabel').textContent = '暂无模型';
    $('#ratioLabel').textContent = '--';
    $('#qualityLabel').textContent = '--';
    $('#sizeLabel').textContent = '--';
    $('#durationLabel').textContent = '--';
    return;
  }
  $('#modelLabel').textContent = m.name || m.id;
  if (isVideoType()) {
    $('#referenceLabel').textContent = REFERENCE_OPTIONS.find((r) => r.value === state.options.reference)?.label || '全能参考';
    $('#ratioLabel').textContent = state.options.ratio;
    $('#qualityLabel').textContent = state.options.resolution === '2k' ? '2K' : state.options.resolution;
    $('#durationLabel').textContent = `${state.options.duration}s`;
  } else {
    $('#ratioLabel').textContent = state.options.aspect_ratio === 'auto' ? '自动' : state.options.aspect_ratio;
    $('#sizeLabel').textContent = state.options.size === 'auto' ? '自动' : String(state.options.size || '--').replace('x', ' × ');
    $('#qualityLabel').textContent = QUALITY_LABEL[state.options.quality] || state.options.quality;
  }
  $('#concurrencyLabel').textContent = state.concurrency + 'x';
}
function setType(type) {
  state.type = type;
  $('#typeLabel').textContent = type === 'official-video' ? '官方视频生成（备选线路）' : type === 'video' ? '视频生成（主线路）' : '图片生成';
  $('#referencePill').style.display = isVideoType() ? '' : 'none';
  $('#durationPill').style.display = isVideoType() ? '' : 'none';
  $('#concurrencyPill').style.display = type === 'official-video' ? 'none' : '';
  $$('.media-tile[data-kind]').forEach((el) => {
    el.style.display = isVideoType() || el.dataset.kind === 'image' ? '' : 'none';
  });
  pickDefaultModel();
  renderMedia();
  renderComposer();
}
function setModel(model) {
  state.model = model;
  state.options = isVideoType() ? defaultVideoOptions(model) : defaultImageOptions(model);
  clampConcurrency();
  renderComposer();
}
function clampConcurrency() {
  const opts = concurrencyOptions(state.model);
  if (!opts.includes(state.concurrency)) state.concurrency = opts[0] ?? 1;
}

// ---- 菜单 ----
let menuEl = null;
function openMenu(anchor, items, className = '') {
  closeMenu();
  menuEl = document.createElement('div');
  menuEl.className = `menu-popover ${className}`.trim();
  for (const it of items) {
    if (it.type === 'title') { const t = document.createElement('div'); t.className = 'menu-section-title'; t.textContent = it.label; menuEl.appendChild(t); continue; }
    const b = document.createElement('button');
    b.className = (it.type === 'card' ? 'channel-card' : 'menu-item') + (it.selected ? ' selected' : '');
    b.innerHTML = it.type === 'card'
      ? `<span class="channel-icon"><img src="/hamster-logo.png" alt="" /></span><span class="channel-copy"><strong>${escapeHtml(it.label)}</strong><small>${escapeHtml(it.sub || '')}</small><span>${escapeHtml(it.meta || '')}</span></span>${it.selected ? '<i class="channel-check" data-lucide="check"></i>' : ''}`
      : `<span>${escapeHtml(it.label)}</span>${it.sub ? `<span class="sub">${escapeHtml(it.sub)}</span>` : ''}`;
    b.addEventListener('click', () => { closeMenu(); it.onSelect(); });
    menuEl.appendChild(b);
  }
  document.body.appendChild(menuEl);
  refreshIcons(menuEl);
  const r = anchor.getBoundingClientRect();
  const menuHeight = menuEl.getBoundingClientRect().height;
  menuEl.style.top = Math.max(8, r.bottom + 6 + menuHeight > window.innerHeight ? r.top - menuHeight - 6 : r.bottom + 6) + 'px';
  const menuWidth = className.includes('channel-popover') ? 520 : 260;
  menuEl.style.left = Math.max(8, Math.min(r.left, window.innerWidth - menuWidth - 8)) + 'px';
  document.addEventListener('click', onDocClick, true);
}
function closeMenu() { if (menuEl) { menuEl.remove(); menuEl = null; } document.removeEventListener('click', onDocClick, true); }
function onDocClick(e) { if (menuEl && !menuEl.contains(e.target)) closeMenu(); }

function typeMenu(anchor) {
  openMenu(anchor, [
    { label: '视频生成（主线路）', selected: state.type === 'video', onSelect: () => setType('video') },
    { label: '图片生成', selected: state.type === 'image', onSelect: () => setType('image') },
    ...(!state.relayMode?[{ label: '官方视频生成（备选线路）', selected: state.type === 'official-video', onSelect: () => setType('official-video') }]:[]),
  ]);
}
function formatDurationRange(durations = []) {
  if (!durations.length) return '标准时长';
  if (durations.length === 1) return `${durations[0]}秒`;
  return `${Math.min(...durations)}–${Math.max(...durations)}秒`;
}
function modelMenu(anchor) {
  openMenu(anchor, modelsOfType().map((m) => ({
    type: 'card', label: m.name, sub: state.relayMode?catalogPriceText(m,state.options):m.summary || '图片创作线路',
    meta: isVideoType()
      ? `${(m.resolutions || []).map(v => v === '2k' ? '2K' : v).join(' / ') || '标准画质'} · ${formatDurationRange(m.durations)}`
      : `${(m.aspect_ratios || []).join(' / ') || '自适应比例'} · ${(m.quality_options || []).map((v) => QUALITY_LABEL[v] || v).join(' / ') || '标准质量'}`,
    selected: state.model?.id === m.id, onSelect: () => setModel(m),
  })), 'channel-popover');
}
function referenceMenu(anchor) {
  if (!state.model) { toast('请先选择模型'); return; }
  openMenu(anchor, REFERENCE_OPTIONS.filter(r=>!state.relayMode||r.value==='all').map((r) => ({
    label: r.label, selected: state.options.reference === r.value,
    onSelect: () => { state.options.reference = r.value; renderComposer(); },
  })));
}
function ratioMenu(anchor) {
  const m = state.model; if (!m) { toast('请先选择模型'); return; }
  const values = isVideoType() ? (m.ratios || []) : (m.aspect_ratios || []);
  const selected = isVideoType() ? state.options.ratio : state.options.aspect_ratio;
  openMenu(anchor, values.map((v) => ({
    label: v === 'auto' ? '自动' : v, selected: selected === v,
    onSelect: () => {
      state.options[isVideoType() ? 'ratio' : 'aspect_ratio'] = v;
      if (!isVideoType() && m.size_options?.length) {
        const sizes=imageSizesForRatio(m,v);
        state.options.size=sizes.includes(state.options.size)?state.options.size:sizes[0];
      }
      renderComposer();
    },
  })));
}
function sizeMenu(anchor) {
  const m = state.model; if (!m || isVideoType()) return;
  openMenu(anchor, imageSizesForRatio(m,state.options.aspect_ratio).map(size=>({
    label:size==='auto'?'自动':size.replace('x',' × '),selected:state.options.size===size,
    onSelect:()=>{state.options.size=size;renderComposer();},
  })));
}
function qualityMenu(anchor) {
  const m = state.model; if (!m) { toast('请先选择模型'); return; }
  const values = isVideoType() ? (m.resolutions || []) : (m.quality_options || ['high', 'medium', 'low']);
  const selected = isVideoType() ? state.options.resolution : state.options.quality;
  openMenu(anchor, values.map((v) => ({
    label: isVideoType() ? v : (QUALITY_LABEL[v] || v), selected: selected === v,
    onSelect: () => { state.options[isVideoType() ? 'resolution' : 'quality'] = v; renderComposer(); },
  })));
}
function durationMenu(anchor) {
  const m = state.model; if (!m) { toast('请先选择模型'); return; }
  openMenu(anchor, (m.durations || []).map((v) => ({
    label: `${v}s`, selected: state.options.duration === v,
    onSelect: () => { state.options.duration = v; renderComposer(); },
  })));
}
function concurrencyMenu(anchor) {
  const opts = concurrencyOptions(state.model);
  openMenu(anchor, opts.map((n) => ({ label: `${n}x`, selected: state.concurrency === n, onSelect: () => { state.concurrency = n; renderComposer(); } })));
}

// ---- 素材 ----
let mediaLimitSignature = '';
let mediaLimitModel = null;
function renderMediaLimits() {
  const model = state.model;
  const all = [...state.media, ...state.pendingMedia];
  const preparing = Object.values(activeFileBatches).some(Boolean);
  const signature = `${model?.id || ''}:${JSON.stringify(state.options)}:${state.concurrency}:${state.submitting}:${preparing}:${all.map(item=>[item.kind,item.uiKey,item.url,item.authorizationInvalid]).join(',')}`;
  if (signature === mediaLimitSignature && model === mediaLimitModel) return;
  mediaLimitSignature = signature;
  mediaLimitModel = model;
  updateSurfaceQuote('generate');
  const error = model ? mediaLimitError(model, all) : '';
  const fee=pricingQuote(model,{...state.options,concurrency:state.concurrency,quote:quoteController.state('generate').quote});
  const limits=modelMediaSummary(model);
  $('#mediaLimitHint').textContent = error || (state.relayMode?limits:fee.external?`${limits} · ${fee.text}`:fee.known?`${limits} · 本次预冻结 ¥${fee.total.toFixed(2)} · 成功交付后扣费`:model?.summary || (model ? '售价待确认，暂未开放扣费' : '请先配置账户并选择线路'));
  $('#mediaLimitHint').classList.toggle('error', Boolean(error));
  refreshQuoteAvailability('generate');
  for (const kind of ['image', 'video', 'audio']) {
    const blocked = !model || Boolean(mediaLimitError(model, [...all, { kind }]));
    const tile = $(`.media-tile[data-kind="${kind}"]`);
    tile.classList.toggle('is-disabled', blocked);
    tile.querySelector('input').disabled = blocked;
    tile.title = blocked ? mediaLimitError(model, [...all, { kind }]) : `上传${KIND_LABEL[kind]}`;
    const option = $(`#urlKind option[value="${kind}"]`);
    option.disabled = blocked;
  }
  const selected = $('#urlKind').selectedOptions[0];
  if (selected?.disabled) $('#urlKind').value = Array.from($('#urlKind').options).find((o) => !o.disabled)?.value || 'image';
}
function mimeFor(name, type) {
  if (type) return type;
  const ext = (name.split('.').pop() || '').toLowerCase();
  const map = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', mp4: 'video/mp4', webm: 'video/webm', mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4' };
  return map[ext] || 'application/octet-stream';
}
function nextTag(kind) {
  state.tagCounters[kind] = (state.tagCounters[kind] || 0) + 1;
  return (KIND_LABEL[kind] || '素材') + state.tagCounters[kind];
}
const uploadReuse = new Map();
const mediaUploadGate = createUploadGate(() => [...state.media, ...state.pendingMedia]);
const activeFileBatches = { image:0, video:0, audio:0 };
function uploadRequest(file, kind, direct, onProgress, use = '') {
  const route = direct ? '/uploads/direct' : '/uploads/raw';
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${API_BASE}${route}?kind=${encodeURIComponent(kind)}&fileName=${encodeURIComponent(file.name)}${state.relayMode&&use?`&use=${encodeURIComponent(use)}`:''}`);
    xhr.timeout = 180000;
    xhr.setRequestHeader('Content-Type', mimeFor(file.name, file.type));
    if (state.apiKey) xhr.setRequestHeader('Authorization', `Bearer ${state.apiKey}`);
    if(state.relayMode&&Number.isSafeInteger(state.relayServerRevision))xhr.setRequestHeader('X-Hamster-Config-Revision',String(state.relayServerRevision));
    xhr.upload.onprogress = event => onProgress?.(event.loaded, event.lengthComputable ? event.total : file.size);
    xhr.onload = () => {
      let payload;
      try { payload = xhr.responseText ? JSON.parse(xhr.responseText) : {}; } catch { payload = {}; }
      if (xhr.status >= 200 && xhr.status < 300) return resolve(payload?.file);
      const error = new Error(payload?.error || payload?.detail || `请求失败 (${xhr.status})`);
      error.status = xhr.status;
      reject(error);
    };
    xhr.onerror = () => reject(new Error('素材上传连接中断，请重试'));
    xhr.ontimeout = () => reject(new Error('素材上传超时，请检查网络后重试'));
    xhr.send(file);
  });
}
async function uploadFile(file, kind, direct = false, onProgress, fingerprint = '', use = '') {
  const revision=relayConfigRevision;
  const cacheKey = fingerprint ? `${state.relayMode&&use?use+':':''}${direct ? 'direct' : 'r2'}:${fingerprint}` : '';
  let pending = cacheKey && uploadReuse.get(cacheKey);
  if (pending) onProgress?.(file.size, file.size);
  else {
    pending = uploadRequest(file, kind, direct, onProgress, use);
    if (cacheKey) uploadReuse.set(cacheKey, pending);
  }
  try { const result=await pending;if(revision!==relayConfigRevision)throw Object.assign(new Error('连接配置已变更，请重新上传素材'),{status:409});return result; }
  catch (error) { if (cacheKey&&uploadReuse.get(cacheKey)===pending) uploadReuse.delete(cacheKey); throw error; }
}
let storageStatusTimer;
let storageStatusPending = null;
let storageStatusKnown = false;
let storageStatusFailures = 0;
function renderStorageStatus(connected) {
  const status = $('#storageStatus');
  if (!status) return;
  status.classList.toggle('is-connected', connected === true);
  status.classList.toggle('is-disconnected', connected === false);
  status.classList.toggle('is-checking', connected == null);
  const label = state.relayMode
    ? connected===true?'素材权限已验证':connected===false?'素材权限未验证':'正在检测素材权限'
    : connected === true ? '对象存储已连接' : connected === false ? '对象存储未连接' : '正在检测对象存储';
  status.setAttribute('aria-label', label);
  status.disabled = connected == null;
}
function scheduleStorageStatus(connected) {
  clearTimeout(storageStatusTimer);
  const delay=connected ? 5*60*1000 : Math.min(60000,10000*2**Math.max(0,storageStatusFailures-1));
  storageStatusTimer=setTimeout(()=>void checkStorageStatus(),delay);
}
function checkStorageStatus({manual=false} = {}) {
  if(storageStatusPending)return storageStatusPending;
  const revision=relayConfigRevision;
  if(manual || !storageStatusKnown)renderStorageStatus(null);
  storageStatusPending=(async()=>{
    let connected=false;
    try {
      const payload=await request('/uploads/status');
      connected=payload?.connected===true;
    } catch {}
    if(revision!==relayConfigRevision)return false;
    storageStatusKnown=true;
    storageStatusFailures=connected ? 0 : storageStatusFailures+1;
    renderStorageStatus(connected);
    scheduleStorageStatus(connected);
    return connected;
  })().finally(()=>{if(revision===relayConfigRevision)storageStatusPending=null;});
  return storageStatusPending;
}
async function handleFiles(files, kind) {
  const revision=relayConfigRevision;
  if (!hasGenerationKey()) { toast(accountHint()); return; }
  const tile = $(`.media-tile[data-kind="${kind}"]`);
  const accepted = [];
  const directUpload = state.type === 'image';
  let completed = false;
  activeFileBatches[kind]++;
  renderMediaLimits();
  tile?.classList.remove('is-complete');
  tile?.classList.add('is-uploading');
  try {
    for (const file of files) {
      if (kindForFile(file) !== kind) { toast('文件类型与素材类型不匹配'); continue; }
      if (!file.size || file.size > 50 * 1024 * 1024) { toast('请选择非空且 50MB 以内的素材'); continue; }
      let release;
      let queued = false;
      try {
        const fingerprint = await fileFingerprint(file);
        if(revision!==relayConfigRevision)break;
        release = mediaUploadGate.claim(kind, fingerprint);
        if (!release) { toast('该素材已添加或正在上传，无需重复上传'); continue; }
        const limitError = mediaLimitError(state.model, [...state.media, ...state.pendingMedia, { kind }]);
        if (limitError) { toast(limitError); continue; }
        const pending = { kind, file, name:file.name, local:URL.createObjectURL(file), fingerprint, startedAt:0, loaded:0, total:file.size, uiKey:crypto.randomUUID(), release };
        accepted.push(pending);
        state.pendingMedia.push(pending);
        queued = true;
        renderMedia();
      } catch (error) {
        if(revision===relayConfigRevision)handleError(error);
      } finally {
        if (!queued) release?.();
      }
    }
    for (const pending of accepted) {
      if(revision!==relayConfigRevision){state.pendingMedia=state.pendingMedia.filter(item=>item.uiKey!==pending.uiKey);pending.release();URL.revokeObjectURL(pending.local);continue;}
      try {
        pending.startedAt=performance.now();
        let lastRender=0;
        const uploaded = await uploadFile(pending.file, kind, directUpload, (loaded,total)=>{
          if(revision!==relayConfigRevision)return;
          pending.loaded=loaded;pending.total=total || pending.file.size;
          const now=performance.now();
          if(now-lastRender>=120 || loaded>=pending.total){lastRender=now;renderMedia();}
        }, pending.fingerprint);
        if (!uploaded?.url) throw new Error('上传未返回有效素材地址，请重试');
        if(revision!==relayConfigRevision)continue;
        state.media.push({ kind, url: uploaded.url, key: uploaded.key || '', name: pending.name, local: pending.local, fingerprint:pending.fingerprint, direct:directUpload, tag: nextTag(kind), uiKey:pending.uiKey });
        if (!directUpload) renderStorageStatus(true);
        completed = true;
      } catch (e) {
        if(revision===relayConfigRevision)uploadReuse.delete(`${directUpload ? 'direct' : 'r2'}:${pending.fingerprint}`);
        if (revision===relayConfigRevision&&!directUpload) renderStorageStatus(false);
        URL.revokeObjectURL(pending.local);
        if(revision===relayConfigRevision)handleError(e);
      }
      finally {
        state.pendingMedia = state.pendingMedia.filter(item => item.uiKey !== pending.uiKey);
        pending.release();
        renderMedia();
      }
    }
  } finally {
    if (--activeFileBatches[kind] === 0) tile?.classList.remove('is-uploading');
    renderMediaLimits();
    if (completed&&revision===relayConfigRevision) {
      tile?.classList.add('is-complete');
      setTimeout(() => tile?.classList.remove('is-complete'), 1600);
    }
  }
}
function kindForFile(file) {
  const type = String(file?.type || '').toLowerCase();
  if (type.startsWith('image/')) return 'image';
  if (type.startsWith('video/')) return 'video';
  if (type.startsWith('audio/')) return 'audio';
  const ext = String(file?.name || '').split('.').pop().toLowerCase();
  if (['png', 'jpg', 'jpeg', 'webp'].includes(ext)) return 'image';
  if (['mp4', 'webm', 'mov'].includes(ext)) return 'video';
  if (['mp3', 'wav', 'm4a', 'aac'].includes(ext)) return 'audio';
  return '';
}
async function handleDroppedFiles(files) {
  const grouped = { image: [], video: [], audio: [] };
  let ignored = 0;
  for (const file of Array.from(files || [])) {
    const kind = kindForFile(file);
    if (!kind || (state.type === 'image' && kind !== 'image')) ignored += 1;
    else grouped[kind].push(file);
  }
  for (const kind of ['image', 'video', 'audio']) {
    if (grouped[kind].length) await handleFiles(grouped[kind], kind);
  }
  if (ignored) toast(state.type === 'image' ? '图片生成仅接收图片素材' : '已忽略不支持的文件');
}
function bindDropZone(element, onDrop) {
  element.addEventListener('dragenter', (e) => { e.preventDefault(); element.classList.add('drag-over'); });
  element.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
  element.addEventListener('dragleave', (e) => {
    if (!element.contains(e.relatedTarget)) element.classList.remove('drag-over');
  });
  element.addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopPropagation();
    element.classList.remove('drag-over');
    onDrop(e.dataTransfer.files);
  });
}
function addMediaByUrl(url, kind) {
  if (!url) { toast('请输入 URL'); return; }
  const error = mediaLimitError(state.model, [...state.media, ...state.pendingMedia, { kind }]);
  if (error) { toast(error); return; }
  state.media.push({ kind, url, name: url, local: null, tag: nextTag(kind), uiKey:crypto.randomUUID() });
  renderMedia();
}
function removeMedia(key) {
  const idx = state.media.findIndex(item => item.uiKey === key);
  if (idx < 0) return;
  const [removed] = state.media.splice(idx, 1);
  if (removed?.local) URL.revokeObjectURL(removed.local);
  const cacheKey=removed?.fingerprint?`${removed.direct?'direct':'r2'}:${removed.fingerprint}`:'';
  if(cacheKey && !state.media.some(item=>item.fingerprint===removed.fingerprint && item.direct===removed.direct))uploadReuse.delete(cacheKey);
  if (removed?.url && removed?.key && !state.media.some(item=>item.url===removed.url)) request('/uploads/raw', { method: 'DELETE', json: { urls: [removed.url] } }).catch(() => {});
  renderMedia();
}

function releaseSubmittedMedia() {
  for (const media of state.media) if (media.local) URL.revokeObjectURL(media.local);
  state.media = [];
  uploadReuse.clear();
  state.tagCounters = { image: 0, video: 0, audio: 0 };
  renderMedia();
}
let mediaMentionSignature = '';
function renderMedia() {
  const list = $('#mediaList');
  const readyKeys=new Set(state.media.map(item=>item.uiKey));
  const entries = [...state.media.map(item => ({item,pending:false})), ...state.pendingMedia.filter(item=>!readyKeys.has(item.uiKey)).map(item => ({item,pending:true}))];
  const existing = new Map();
  for(const card of [...list.children]) {
    if(existing.has(card.dataset.mediaKey))card.remove();
    else existing.set(card.dataset.mediaKey,card);
  }
  const wanted = new Set(entries.map(({item}) => item.uiKey));
  for (const [key, card] of existing) if (!wanted.has(key)) card.remove();
  entries.forEach(({item:m,pending},index) => {
    const thumb = m.kind === 'image' && m.local ? `<img src="${escapeHtml(m.local)}" alt="" />` : `<span class="chip-kind">${m.kind === 'video' ? '🎞' : '🎵'}</span>`;
    let html;
    if (pending) {
      const total=Math.max(1,Number(m.total)||Number(m.file?.size)||1),loaded=Math.min(total,Number(m.loaded)||0);
      const percent=Math.min(100,Math.round(loaded/total*100));
      const elapsed=Math.max(.001,(performance.now()-(m.startedAt || performance.now()))/1000),rate=loaded/elapsed;
      const speed=rate>=1024*1024?`${(rate/1024/1024).toFixed(1)}MB/s`:rate>=1024?`${(rate/1024).toFixed(0)}KB/s`:'';
      const eta=rate>0&&loaded<total?` · 约${Math.max(1,Math.ceil((total-loaded)/rate))}秒`:'';
      const detail=loaded>=total?'服务确认中':`${percent}%${speed?' · '+speed:''}${eta}`;
      html=`<div class="media-chip pending" data-media-key="${m.uiKey}" aria-label="${escapeHtml(m.name || KIND_LABEL[m.kind])}正在上传 ${percent}%">${thumb}<span class="media-name">${escapeHtml(m.name || KIND_LABEL[m.kind])}</span><span class="media-uploading"><i></i>${detail}</span></div>`;
    } else {
      const readyThumb=m.kind==='image'?`<img src="${escapeHtml(m.local || m.url)}" loading="lazy" decoding="async" alt="" />`:`<span class="chip-kind">${m.kind==='video'?'🎞':'🎵'}</span>`;
      const edit=m.kind==='image'?`<button type="button" class="media-edit" data-edit-media="${m.uiKey}" title="标注修改这张图片" aria-label="编辑${escapeHtml(m.name)}"><i data-lucide="pencil-line"></i></button>`:'';
      html=`<div class="media-chip" data-media-key="${m.uiKey}">${readyThumb}<span class="media-name">${escapeHtml(m.name)}${m.authorizationInvalid?' · 请重新上传':''}</span><button type="button" class="media-tag" data-tag="${escapeHtml(m.tag)}" title="插入到提示词">@${escapeHtml(m.tag)}</button>${edit}<button type="button" class="rm" data-remove-media="${m.uiKey}">×</button></div>`;
    }
    let card=existing.get(m.uiKey);
    if (!card) {
      const template=document.createElement('template');template.innerHTML=html;
      card=template.content.firstElementChild;card._mediaHtml=html;
      list.append(card);refreshIcons(card);
    } else if (card._mediaHtml !== html) {
      const template=document.createElement('template');template.innerHTML=html;
      const next=template.content.firstElementChild;
      for (const attribute of [...card.attributes]) if (!next.hasAttribute(attribute.name)) card.removeAttribute(attribute.name);
      for (const attribute of [...next.attributes]) card.setAttribute(attribute.name, attribute.value);
      card.replaceChildren(...next.childNodes);
      card._mediaHtml=html;
      refreshIcons(card);
    }
    if(list.children[index]!==card)list.insertBefore(card,list.children[index]||null);
  });
  list.hidden = !entries.length;
  renderMediaLimits();
  const mentionSignature=state.media.map(item=>`${item.uiKey}:${item.tag}:${item.name}`).join('|');
  if(mentionSignature!==mediaMentionSignature){mediaMentionSignature=mentionSignature;updateMentionMenu();}
}

// ---- 提示词素材引用 ----
let mentionIndex = 0;
let mentionStart = -1;
let mentionBlurTimer = null;
function mentionContext() {
  const input = $('#prompt');
  const cursor = input.selectionStart;
  const match = input.value.slice(0, cursor).match(/@([^@\s，。！？、,.;:：；]*)$/u);
  return match ? { query: match[1].toLowerCase(), start: cursor - match[0].length, end: cursor } : null;
}
function closeMentionMenu() {
  if (mentionBlurTimer !== null) {
    clearTimeout(mentionBlurTimer);
    mentionBlurTimer = null;
  }
  const menu = $('#mentionMenu');
  menu.hidden = true;
  menu.innerHTML = '';
  $('#prompt').setAttribute('aria-expanded', 'false');
  mentionStart = -1;
}
function insertMention(tag, start = null, end = null) {
  const input = $('#prompt');
  const cursor = input.selectionStart;
  const from = start ?? cursor;
  const to = end ?? cursor;
  const prefix = from > 0 && !/\s/.test(input.value[from - 1]) ? ' ' : '';
  const hasFollowingWhitespace = to < input.value.length && /\s/.test(input.value[to]);
  const suffix = hasFollowingWhitespace ? '' : ' ';
  const value = `${prefix}@${tag}${suffix}`;
  input.setRangeText(value, from, to, 'end');
  if (hasFollowingWhitespace) {
    const position = input.selectionStart + 1;
    input.setSelectionRange(position, position);
  }
  input.focus();
  closeMentionMenu();
  input.dispatchEvent(new Event('input', { bubbles: true }));
}
function updateMentionMenu() {
  const menu = $('#mentionMenu');
  const context = mentionContext();
  if (!context || !state.media.length) { closeMentionMenu(); return; }
  const matches = state.media.filter((m) => !context.query || m.tag.toLowerCase().includes(context.query) || m.name.toLowerCase().includes(context.query));
  if (!matches.length) { closeMentionMenu(); return; }
  mentionStart = context.start;
  mentionIndex = Math.min(mentionIndex, matches.length - 1);
  menu.innerHTML = `<div class="mention-title">引用素材</div>${matches.map((m, i) => `<button type="button" class="mention-option${i === mentionIndex ? ' active' : ''}" data-tag="${escapeHtml(m.tag)}"><span class="mention-kind"><i data-lucide="${m.kind === 'image' ? 'image' : m.kind === 'video' ? 'video' : 'audio-lines'}"></i></span><span><strong>@${escapeHtml(m.tag)}</strong><small>${escapeHtml(m.name)}</small></span><kbd>↵</kbd></button>`).join('')}`;
  menu.hidden = false;
  $('#prompt').setAttribute('aria-expanded', 'true');
  menu.querySelectorAll('.mention-option').forEach((b) => b.addEventListener('mousedown', (e) => {
    e.preventDefault();
    insertMention(b.dataset.tag, mentionStart, $('#prompt').selectionStart);
  }));
  refreshIcons(menu);
}
function onPromptKeydown(e) {
  const menu = $('#mentionMenu');
  if (menu.hidden) return;
  const options = $$('.mention-option');
  if (e.key === 'Escape') { e.preventDefault(); closeMentionMenu(); return; }
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    mentionIndex = (mentionIndex + (e.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length;
    updateMentionMenu();
    return;
  }
  if (e.key === 'Enter' && options[mentionIndex]) {
    e.preventDefault();
    insertMention(options[mentionIndex].dataset.tag, mentionStart, $('#prompt').selectionStart);
  }
}

// ---- 生成 ----
function groupMedia() {
  const out = { image: [], video: [], audio: [] };
  for (const m of state.media) out[m.kind].push({ tag: m.tag, url: m.url });
  return out;
}
async function onSubmit(e) {
  e.preventDefault();
  const revision=relayConfigRevision;
  if(state.submitting)return;
  if(state.relayMode&&state.batches?.some(batchIsActive)){toast('原批次仍在提交中，可先停止剩余份数；已发送任务继续查询原结果');return;}
  if (!hasGenerationKey()) {
    toast(accountHint());
    return;
  }
  if (!state.model) { toast('请选择模型'); return; }
  if (state.pendingMedia.length) { toast('素材正在上传，请稍候'); return; }
  if(state.relayMode&&state.media.some(item=>item.authorizationInvalid)){toast('连接配置已变更，请移除并重新上传当前账户的参考素材');return;}
  const mediaError = mediaLimitError(state.model, state.media);
  if (mediaError) { toast(mediaError); return; }
  const prompt = $('#prompt').value.trim();
  if (!prompt) { toast('请输入提示词'); return; }
  const media = groupMedia();
  const isVideoTask = isVideoType();
  const payload = isVideoTask
    ? buildVideoPayload({ model: state.model, prompt, ...state.options, concurrency: state.concurrency, images: media.image, videos: media.video, audios: media.audio })
    : buildImagePayload({ model: state.model, prompt, ...state.options, concurrency: state.concurrency, images: media.image });
  const path = state.type === 'official-video' ? '/official-videos' : isVideoTask ? '/videos' : '/images';
  const snapshot=quoteSnapshot('generate'),requestId=crypto.randomUUID();
  const headers = {
    Prefer: 'respond-async',
    'Idempotency-Key': requestId,
    ...(state.type === 'official-video' && state.videoApiKey ? {'X-Hamster-Official-Key':state.videoApiKey} : {}),
  };
  state.submitting = true;
  renderMediaLimits();
  let requestStarted=false;
  try {
    const quote=await confirmPaidSubmission('generate',snapshot);
    if(!quote||revision!==relayConfigRevision)return;
    if(!confirmedQuoteCurrent('generate',snapshot,quote)){toast('参数或报价已变化，请重新确认');return;}
    if(state.relayMode)payload.quote_id=quote.id;
    requestStarted=true;
    const created = await request(path, { method: 'POST', json: payload, headers });
    if(revision!==relayConfigRevision)return;
    if (!acceptLocalTask(created) && !extractTaskIds(created).length && !(created?.accepted&&created?.stopped)) throw new Error('提交结果待确认，请检查历史记录，勿重复提交');
    noteQuotedResult('generate',created,requestId);
    toast(submissionMessage(created));
    if(!created?.stopped&&!pendingQuotedSubmissions.has('generate')){$('#prompt').value = '';releaseSubmittedMedia();}
    renderAllTasks();
  } catch (err) { if(revision===relayConfigRevision&&!(requestStarted&&quoteSubmissionFailed('generate',err,requestId)))handleError(err); }
  finally { if(revision===relayConfigRevision){state.submitting = false; renderMediaLimits(); syncTasks();} }
}
let syncingBatches=false,batchControlsSignature='';
const stoppingBatches=new Set();
function renderBatchControls(){
  const panel=$('#relayBatchControls');if(!panel)return;
  const all=state.batches||[],batches=[...all.filter(batchIsActive),...all.filter(batch=>!batchIsActive(batch)).slice(0,6)],signature=JSON.stringify([batches,[...stoppingBatches]]);
  panel.hidden=!state.relayMode||!batches.length;
  if(signature===batchControlsSignature)return;batchControlsSignature=signature;
  panel.innerHTML=batches.map(batch=>`<div class="relay-batch-row"><p>${escapeHtml(batchProgressText(batch))}</p>${batchIsActive(batch)?`<button type="button" class="plain-button subtle" data-stop-relay-batch="${escapeHtml(batch.id)}" ${stoppingBatches.has(batch.id)?'disabled':''}>${stoppingBatches.has(batch.id)?'正在停止…':'停止剩余份数'}</button>`:''}</div>`).join('');
  for(const button of panel.querySelectorAll('[data-stop-relay-batch]'))button.addEventListener('click',()=>void stopRelayBatch(button.dataset.stopRelayBatch));
}
async function syncRelayBatches(){
  if(!state.relayMode||syncingBatches)return;
  syncingBatches=true;const revision=relayConfigRevision;
  try{const result=await request('/relay/batches');if(revision!==relayConfigRevision)return;
    if(!Array.isArray(result?.batches))throw Error('batch');
    state.batches=result.batches;renderBatchControls();settleQuotedSubmissions();refreshQuoteAvailability('generate');
  }catch{/* Keep the last durable batch view until its status can be read. */}
  finally{syncingBatches=false;}
}
async function stopRelayBatch(id){
  if(!/^[a-f0-9]{32}$/.test(id)||stoppingBatches.has(id))return;
  const revision=relayConfigRevision;stoppingBatches.add(id);renderBatchControls();
  try{const result=await request(`/relay/batches/${id}/stop`,{method:'POST'});if(revision!==relayConfigRevision)return;
    if(!result?.batch)throw Error('停止结果暂未确认，请查询原批次');
    state.batches=(state.batches||[]).map(batch=>batch.id===id?result.batch:batch);
    toast(batchProgressText(result.batch));await syncTasks();
  }catch(error){if(revision===relayConfigRevision)toast('停止结果暂未确认，请重新查询原批次，勿再次生成');}
  finally{stoppingBatches.delete(id);if(revision===relayConfigRevision){renderBatchControls();refreshQuoteAvailability('generate');}}
}
// The UI reads the local journal; the local service alone polls upstream IDs.
let syncingTasks = false;
async function syncTasks() {
  if (syncingTasks) return;
  syncingTasks = true;
  const revision=relayConfigRevision;
  void syncRelayBatches();
  try {
    const data = await request('/tasks');
    if(revision!==relayConfigRevision)return;
    if (!Array.isArray(data?.tasks)) throw new Error('任务记录暂不可用');
    state.tasks = data.tasks;
    settleQuotedSubmissions();
    renderAllTasks();
    if ($('[data-panel="history"]').classList.contains('active')) renderHistory();
    $('#taskPersistenceNote').textContent = data.warnings?.length ? data.warnings.join('；') : '';
    $('#taskPersistenceNote').hidden = !data.warnings?.length;
  } catch {
    if(revision!==relayConfigRevision)return;
    $('#taskPersistenceNote').hidden = false;
    $('#taskPersistenceNote').textContent = '暂时无法更新任务进度，正在重试…';
  } finally { syncingTasks = false; }
}
async function restoreTasks() {
  try {
    const legacy = JSON.parse(localStorage.getItem(HISTORY_STORAGE) || '[]');
    if (legacy.length && !localStorage.getItem('hamster_history_migrated')) {
      await request('/tasks/import', {method:'POST',json:{tasks:legacy}});
      localStorage.setItem('hamster_history_migrated','1');
    }
  } catch { toast('旧历史导入暂未完成，原始记录仍保留'); }
  await syncTasks();
  setInterval(syncTasks, 3000);
  window.addEventListener('online', syncTasks);
}

// ---- 任务流 & 历史 ----
function assetSaveButton(result) {
  return result?.local_path && /\.(png|jpe?g|webp|mp4|webm|mov)$/i.test(result.local_path)
    ? `<button type="button" class="task-action task-action-secondary asset-button" data-save-asset="${escapeHtml(result.local_path)}"><i data-lucide="archive"></i>收入资产库</button>`
    : '';
}
function taskIsText(t) {
  return t.source === 'reverse' || Boolean(t.result?.text);
}
function taskKind(t) {
  if (t.source === 'reverse') return { label: '视频反推', icon: 'scan-text' };
  if (t.source === 'digital') return { label: '数字人', icon: 'scan-face' };
  if (t.source === 'depth') return { label: '深度视频', icon: 'scan-line' };
  if (t.provider === 'official') return { label: '官方视频生成（备选线路）', icon: 'badge-check' };
  return t.type === 'image' ? { label: '图片生成', icon: 'image' } : { label: '视频生成', icon: 'video' };
}
function taskStatusClass(status) {
  return ['submitting','unknown','queued','processing','succeeded','failed'].includes(status) ? status : 'unknown';
}
function taskProgressHtml(t) {
  if (!['submitting','unknown','queued','processing'].includes(t.status)) return '';
  const pct = Math.max(0, Math.min(100, Number(t.progress) || 0));
  return `<div class="task-progress" aria-label="任务进度 ${pct}%"><span style="width:${pct}%"></span></div>`;
}
function taskSaveStateHtml(t) {
  if (!t.result || t.result.text) return '';
  if (t.result.saving) return '<span class="task-save-state"><i data-lucide="loader-circle"></i>正在保存</span>';
  if (t.result.local_path) return `<span class="task-save-state is-saved" title="${escapeHtml(t.result.local_path)}"><i data-lucide="circle-check"></i>已保存到本地</span>`;
  if (t.result.save_error) return `<span class="task-save-state is-error" title="${escapeHtml(publicText(t.result.save_error))}"><i data-lucide="circle-alert"></i>保存待重试</span>`;
  return '<span class="task-save-state"><i data-lucide="clock-3"></i>等待保存</span>';
}
function taskActionHtml(t) {
  const copyPrompt = typeof t.prompt === 'string' && t.prompt.trim()
    ? `<button class="task-action task-action-secondary" type="button" data-copy-task-prompt="${escapeHtml(t.key || t.id)}" title="复制本次任务提交时的完整提示词"><i data-lucide="copy"></i>复制提示词</button>` : '';
  const download = t.result?.local_url
    ? `<a class="task-action task-action-primary" href="${escapeHtml(t.result.local_url)}?download=1" download><i data-lucide="download"></i>下载</a>`
    : '';
  const retry = t.key && t.id && t.status !== 'failed' && !t.result?.local_url && !t.result?.text
    ? `<button class="task-action task-action-secondary" type="button" data-retry-task="${escapeHtml(t.key)}"><i data-lucide="refresh-cw"></i>${t.status === 'succeeded' ? '重新获取' : '恢复查询'}</button>`
    : '';
  const saveAsset = assetSaveButton(t.result);
  const editImage = t.type === 'image' && t.status === 'succeeded' && t.result?.local_url
    ? `<button class="task-action task-action-secondary" type="button" data-edit-image="${escapeHtml(t.key)}"><i data-lucide="pencil-line"></i>图片编辑</button>` : '';
  if (!download && !retry && !saveAsset && !editImage && !copyPrompt) return '';
  return `<div class="task-card-actions">${copyPrompt}${editImage}${download}${saveAsset}${retry}</div>`;
}
function resultHtml(t) {
  if (taskIsText(t)) {
    if (!t.result?.text) {
      return `<div class="task-text-placeholder"><i data-lucide="file-clock"></i><span>${t.status === 'failed' ? '本次分析未生成可用正文' : '正在整理分析结果'}</span>${taskProgressHtml(t)}</div>`;
    }
    return `<div class="text-result">
      <div class="text-result-head"><span><i data-lucide="file-text"></i>分析结果</span><div class="text-result-tools"><button type="button" class="copy-result" data-copy-result><i data-lucide="copy"></i>复制</button><button type="button" class="copy-result" data-expand-result aria-expanded="false"><i data-lucide="maximize-2"></i><span>展开</span></button></div></div>
      <pre>${escapeHtml(t.result.text)}</pre>
    </div>`;
  }
  const preview = t.result?.local_url || (t.type === 'video' ? t.result?.video_url : t.result?.image_url) || t.result?.download_url;
  if (preview) {
    const media = t.type === 'video'
      ? `<video src="${escapeHtml(preview)}" preload="none" controls></video>`
      : `<img src="${escapeHtml(preview)}" loading="lazy" decoding="async" fetchpriority="low" alt="生成结果" />`;
    return `<div class="task-media-frame">${media}<button type="button" class="task-preview-button" data-preview-result data-preview-kind="${t.type === 'video' ? 'video' : 'image'}" data-preview-src="${escapeHtml(preview)}" aria-label="放大预览"><i data-lucide="maximize-2"></i></button></div>`;
  }
  const failed = t.status === 'failed';
  return `<div class="task-media-frame task-media-placeholder ${failed ? 'is-failed' : ''}"><span class="task-placeholder-icon"><i data-lucide="${failed ? 'triangle-alert' : 'sparkles'}"></i></span><strong>${failed ? '生成未完成' : '正在准备作品'}</strong><small>${failed ? '查看下方原因后可重新尝试' : (STATUS_LABEL[t.status] || '任务处理中')}</small>${taskProgressHtml(t)}</div>`;
}
function taskModelLabel(task) {
  if(task.relay&&task.modelName)return task.modelName;
  const special = { digital: '仓鼠数字人', depth: '仓鼠黑白深度视频', reverse: '仓鼠视频反推' };
  if (special[task.source]) return special[task.source];
  for (const label of ['数字人', '黑白深度视频', '视频反推']) if (task.modelName?.includes(label)) return `仓鼠${label}`;
  return hamsterModelName({ id: task.modelId, name: task.modelName });
}
function taskCardHtml(t) {
  const textCard = taskIsText(t);
  const kind = taskKind(t);
  const status = taskStatusClass(t.status);
  const error = t.error || t.poll_error;
  const createdAt = Number.isFinite(Date.parse(t.createdAt)) ? new Date(t.createdAt).toLocaleString('zh-CN', { month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit' }) : '时间未知';
  return `<article class="task-card ${textCard ? 'task-card-text' : 'task-card-visual'} is-${status}">
    <header class="task-head">
      <div class="task-identity"><span class="task-kind-icon"><i data-lucide="${kind.icon}"></i></span><span><strong>${kind.label}</strong><small>${escapeHtml(taskModelLabel(t))}</small></span></div>
      <span class="task-status ${status}">${STATUS_LABEL[t.status] || '状态待确认'}</span>
    </header>
    ${textCard ? `<div class="task-copy"><p class="task-prompt">${escapeHtml(t.prompt || '视频分析任务')}</p></div>` : ''}
    <div class="task-result">${resultHtml(t)}</div>
    ${error ? `<div class="task-error" role="alert"><i data-lucide="circle-alert"></i><span>${escapeHtml(publicText(error))}</span></div>` : ''}
    ${textCard ? '' : `<div class="task-copy"><p class="task-prompt">${escapeHtml(t.prompt || kind.label)}</p><div class="task-meta"><span class="task-time"><i data-lucide="clock-3"></i>${escapeHtml(createdAt)}</span>${taskSaveStateHtml(t)}</div></div>`}
    ${textCard ? `<footer class="task-card-footer"><span class="task-time"><i data-lucide="clock-3"></i>${escapeHtml(createdAt)}</span>${taskSaveStateHtml(t)}${taskActionHtml(t)}</footer>` : taskActionHtml(t)}
  </article>`;
}
const taskFeedLimits = { generate: HISTORY_BATCH_SIZE, digital: HISTORY_BATCH_SIZE, depth: HISTORY_BATCH_SIZE };
function renderTasksFor(source, container) {
  if (!container) return;
  const list = state.tasks.filter((t) => (t.source || 'generate') === source);
  const limit = taskFeedLimits[source] || HISTORY_BATCH_SIZE;
  const visible = list.slice(0,limit);
  container.querySelector('[data-task-more]')?.remove();
  patchTaskCards(container,visible);
  if (visible.length < list.length) {
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'plain-button subtle history-more';
    more.dataset.taskMore = source;
    more.textContent = `显示更多（剩余 ${list.length-visible.length} 条）`;
    more.addEventListener('click',() => { taskFeedLimits[source] = limit + HISTORY_BATCH_SIZE; renderTasksFor(source,container); });
    container.append(more);
  }
}
function patchTaskCards(container,list) {
  const cards=[...container.querySelectorAll(':scope > .task-card')];
  const existing=new Map(cards.map(card=>[card.dataset.taskKey,card]));
  const wanted = new Set(list.map(t => t.key || t.id));
  for (const card of cards) if (!wanted.has(card.dataset.taskKey)) card.remove();
  list.forEach((task,index) => {
    const key = task.key || task.id;
    let card = existing.get(key);
    const html = taskCardHtml(task);
    if (!card) {
      const template = document.createElement('template'); template.innerHTML = html;
      const next = template.content.firstElementChild; next.dataset.taskKey = key; next._taskHtml = html;
      container.append(next);
      card = next; refreshIcons(card); bindResultCopy(card);
    } else if (card._taskHtml !== html) {
      const template = document.createElement('template'); template.innerHTML = html;
      const next = template.content.firstElementChild;
      card.className = next.className;
      card.replaceChildren(...next.childNodes);
      card._taskHtml = html;
      refreshIcons(card); bindResultCopy(card);
    }
    if (container.children[index] !== card) container.insertBefore(card,container.children[index] || null);
  });
}
function renderTaskFeed() { renderTasksFor('generate', $('#taskFeed')); }
function renderDhResults() { renderTasksFor('digital', $('#dhResults')); }
function renderDepthResults() { renderTasksFor('depth', $('#depthResults')); }
function renderAllTasks() { renderTaskFeed(); renderDhResults(); renderDepthResults(); }
function acceptLocalTask(created) {
  const task = created?.accepted && created?.task;
  if (!task?.key) return false;
  state.tasks = [task, ...state.tasks.filter(item => (item.key || item.id) !== task.key)];
  renderAllTasks();
  return true;
}
function bindResultCopy(container) {
  container?.querySelectorAll('[data-copy-task-prompt]').forEach(button => button.addEventListener('click', async () => {
    const task = state.tasks.find(item => (item.key || item.id) === button.dataset.copyTaskPrompt);
    const result = await copyTaskPrompt(task?.prompt);
    if (result === 'copied') toast('本次任务的完整提示词已复制');
    else if (result === 'empty') toast('该历史任务未保存提示词');
  }));
  container?.querySelectorAll('[data-edit-image]').forEach(button=>button.addEventListener('click',()=>{
    const task=state.tasks.find(item=>item.key===button.dataset.editImage);
    if(task)void openImageEdit(task);
  }));
  container?.querySelectorAll('[data-retry-task]').forEach(button => button.addEventListener('click',async()=>{
    button.disabled = true;
    try { await request(`/tasks/${button.dataset.retryTask}/retry`,{method:'POST'}); toast('已安排查询原任务，不会重新生成'); await syncTasks(); }
    catch(e) {handleError(e);} finally {button.disabled=false;}
  }));
  container?.querySelectorAll('[data-save-asset]').forEach(button=>button.addEventListener('click',async()=>{
    const category=await chooseAssetCategory();if(!category)return;button.disabled=true;
    try{await assetsRequest('/api/assets','/import-result',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({category,local_path:button.dataset.saveAsset})});toast('已收入本地资产库');}
    catch(e){toast(e.message);}finally{button.disabled=false;}
  }));
  container?.querySelectorAll('[data-copy-result]').forEach((button) => button.addEventListener('click', async () => {
    const text = button.closest('.text-result')?.querySelector('pre')?.textContent || '';
    try { await navigator.clipboard.writeText(text); toast('反推结果已复制'); }
    catch { toast('复制失败，请手动选择文本'); }
  }));
  container?.querySelectorAll('[data-expand-result]').forEach((button) => button.addEventListener('click', () => {
    const result = button.closest('.text-result');
    const expanded = result.classList.toggle('is-expanded');
    button.setAttribute('aria-expanded', String(expanded));
    button.querySelector('span').textContent = expanded ? '收起' : '展开';
  }));
  container?.querySelectorAll('[data-preview-result]').forEach((button) => button.addEventListener('click', () => {
    const dialog = $('#taskPreviewDialog');
    const body = $('#taskPreviewBody');
    body.replaceChildren();
    const media = document.createElement(button.dataset.previewKind === 'video' ? 'video' : 'img');
    media.src = button.dataset.previewSrc;
    if (media.tagName === 'VIDEO') { media.controls = true; media.autoplay = true; }
    else media.alt = '作品大图预览';
    body.append(media);
    dialog.showModal();
  }));
}

// 所有入口共用一个编辑器；标注在提交前只存在于画布中。
const imageEdit = { blob:null, objectUrl:'', strokes:[], active:null, busy:false, loading:false, aborted:false, loadId:0 };
function imageEditStatus(message, error=false) {
  const status=$('#imageEditStatus');
  status.textContent=message;
  status.classList.toggle('is-error',error);
}
function setImageEditBusy(busy) {
  imageEdit.busy=busy;
  for(const id of ['closeImageEdit','imageEditUpload','imageEditPickAsset','imageEditInstruction','imageEditModel','imageEditRatio','imageEditSize','imageEditQuality','imageEditBrush','imageEditUndo','imageEditClear']) {
    const element=$(`#${id}`);
    if(element)element.disabled=busy || (id==='imageEditUndo'||id==='imageEditClear' ? !imageEdit.strokes.length : false);
  }
  renderImageEditCapability();
  updateSurfaceQuote('imageEdit');
  refreshQuoteAvailability('imageEdit');
  $('#imageEditSubmit').textContent=busy?'正在提交…':'生成修改版';
}
function renderImageEditCapability(){
  const model=imageModels().find(item=>item.id===$('#imageEditModel').value),supported=supportsImageMarks(model);
  const brush=$('#imageEditBrush'),canvas=$('#imageEditCanvas'),hint=$('#imageEditCapability');
  if(brush)brush.disabled=imageEdit.busy||!supported;
  if(canvas){canvas.setAttribute('aria-disabled',String(!supported));canvas.style.cursor=supported?'crosshair':'default';}
  if(hint)hint.textContent=supported?'支持原图与标注图，可画圈或涂画定位。':'当前线路仅支持单张原图，可填写文字修改要求；圈选暂未适配，已停用。'+(imageEdit.strokes.length?'原笔画仍保留，请清空笔画后使用文字编辑。':'');
  const badge=$('#imageEditMarkBadge'),help=$('#imageEditHelp');
  if(badge){badge.textContent=supported?'画笔标注':'文字编辑';badge.classList.toggle('is-disabled',!supported);}
  if(help)help.textContent=supported?'标记用于指明修改范围；这不是像素级蒙版，请在右侧明确描述修改内容。':'在右侧明确描述修改内容。原图保留，修改结果另存为新任务。';
}
function imageEditOptions() {
  const model=imageModels().find(item=>item.id===$('#imageEditModel').value);
  const defaults=defaultImageOptions(model);
  const fill=(selector,values,selected)=>{
    const select=$(selector); select.replaceChildren();
    for(const value of [...new Set(values)]) {
      const option=document.createElement('option'); option.value=String(value);
      option.textContent=selector==='#imageEditQuality' ? (QUALITY_LABEL[value]||value) : value==='auto'?'自动':String(value);
      select.append(option);
    }
    select.value=values.includes(selected)?String(selected):String(values[0]||'');
  };
  fill('#imageEditRatio',model?.aspect_ratios?.length?model.aspect_ratios:[defaults.aspect_ratio],defaults.aspect_ratio);
  fill('#imageEditQuality',model?.quality_options?.length?model.quality_options:[defaults.quality],defaults.quality);
  const img=$('#imageEditSource');
  const matched=closestImageRatio(img.naturalWidth,img.naturalHeight,model?.aspect_ratios||[]);
  if(matched)$('#imageEditRatio').value=matched;
  imageEditSizes(defaults.size);
  renderImageEditCapability();
}
function imageEditSizes(preferred=$('#imageEditSize').value) {
  const model=imageModels().find(item=>item.id===$('#imageEditModel').value);
  const select=$('#imageEditSize'),sizes=imageSizesForRatio(model,$('#imageEditRatio').value);
  $('#imageEditSizeField').hidden=!model?.size_options?.length;
  select.replaceChildren();
  for(const size of sizes) {
    const option=document.createElement('option');option.value=size;
    option.textContent=size==='auto'?'自动':size.replace('x',' × ');select.append(option);
  }
  select.value=sizes.includes(preferred)?preferred:sizes[0]||'';
  updateSurfaceQuote('imageEdit');
}
function imageEditPoint(event) {
  const canvas=$('#imageEditCanvas'),rect=canvas.getBoundingClientRect();
  return {x:(event.clientX-rect.left)*canvas.width/rect.width,y:(event.clientY-rect.top)*canvas.height/rect.height};
}
function drawImageEditStroke(ctx,stroke) {
  if(!stroke.points.length)return;
  ctx.lineCap='round';ctx.lineJoin='round';ctx.strokeStyle='#f04438';ctx.fillStyle='#f04438';ctx.lineWidth=stroke.width;
  const first=stroke.points[0];
  if(stroke.points.length===1){ctx.beginPath();ctx.arc(first.x,first.y,stroke.width/2,0,Math.PI*2);ctx.fill();return;}
  ctx.beginPath();ctx.moveTo(first.x,first.y);
  for(const point of stroke.points.slice(1))ctx.lineTo(point.x,point.y);
  ctx.stroke();
}
function renderImageEditStrokes() {
  const canvas=$('#imageEditCanvas'),ctx=canvas.getContext('2d');
  ctx.clearRect(0,0,canvas.width,canvas.height);
  for(const stroke of imageEdit.strokes)drawImageEditStroke(ctx,stroke);
  if(imageEdit.active)drawImageEditStroke(ctx,imageEdit.active);
  $('#imageEditUndo').disabled=imageEdit.busy||!imageEdit.strokes.length;
  $('#imageEditClear').disabled=imageEdit.busy||!imageEdit.strokes.length;
  updateSurfaceQuote('imageEdit');
}
function closeImageEdit() { if(!imageEdit.busy)$('#imageEditDialog').close(); }
async function loadImageEditSource(source) {
  const loadId=++imageEdit.loadId;
  imageEdit.loading=true;imageEdit.blob=null;imageEdit.strokes=[];imageEdit.active=null;
  if(imageEdit.objectUrl)URL.revokeObjectURL(imageEdit.objectUrl);
  imageEdit.objectUrl='';
  $('#imageEditSource').removeAttribute('src');
  $('.image-edit-stage').hidden=true;$('#imageEditEmpty').hidden=false;
  $('#imageEditCanvas').width=0;$('#imageEditCanvas').height=0;
  $('#imageEditInstruction').value='';
  imageEditStatus('正在读取图片…');setImageEditBusy(false);
  try {
    let blob;
    if(source instanceof Blob)blob=source;
    else {
      const url=source?.result?.local_url||source?.local||source?.url||source;
      const response=await fetch(url);
      if(!response.ok)throw new Error('图片无法读取，请重新上传');
      blob=await response.blob();
    }
    if(loadId!==imageEdit.loadId||!$('#imageEditDialog').open)return;
    const name=source?.name||source?.result?.local_name||'';
    const type=mimeFor(name,blob.type==='application/octet-stream'?'':blob.type);
    if(!['image/png','image/jpeg','image/webp'].includes(type))throw new Error('仅支持 PNG、JPG、WEBP 图片');
    if(blob.type!==type)blob=new Blob([blob],{type});
    imageEdit.objectUrl=URL.createObjectURL(blob);
    const img=$('#imageEditSource');img.src=imageEdit.objectUrl;
    await img.decode();
    if(loadId!==imageEdit.loadId||!$('#imageEditDialog').open)return;
    const scale=Math.min(1,2048/Math.max(img.naturalWidth,img.naturalHeight));
    const canvas=$('#imageEditCanvas');canvas.width=Math.max(1,Math.round(img.naturalWidth*scale));canvas.height=Math.max(1,Math.round(img.naturalHeight*scale));
    imageEditOptions();
    imageEdit.blob=blob;
    $('.image-edit-stage').hidden=false;$('#imageEditEmpty').hidden=true;
    imageEditStatus('原图保留，修改结果将成为一条新任务。');
  } catch(error) {
    if(loadId===imageEdit.loadId&&$('#imageEditDialog').open)imageEditStatus(error instanceof TypeError?'图片链接无法直接读取，请下载图片后从本机上传':error.message||'读取图片失败',true);
  } finally {
    if(loadId===imageEdit.loadId){imageEdit.loading=false;setImageEditBusy(false);}
  }
}
async function openImageEdit(source=null) {
  if($('#imageEditDialog').open)return;
  if(!hasKey()){toast('请先在「账户」页填写 API Key');return;}
  const models=imageModels();
  if(!models.length){toast('图片线路尚未加载，请稍后重试');return;}
  const select=$('#imageEditModel');select.replaceChildren();
  for(const model of models){const option=document.createElement('option');option.value=model.id;option.textContent=(model.name||'图片线路')+(state.relayMode?` · ${catalogPriceText(model)}`:'');select.append(option);}
  select.value=models.some(model=>model.id===source?.modelId)?source.modelId:models[0].id;
  imageEdit.blob=null;imageEdit.strokes=[];imageEdit.active=null;imageEdit.aborted=false;imageEdit.loading=false;
  $('#imageEditInstruction').value='';
  $('#imageEditSource').removeAttribute('src');
  $('#imageEditCanvas').width=0;$('#imageEditCanvas').height=0;
  $('.image-edit-stage').hidden=true;$('#imageEditEmpty').hidden=false;
  imageEditOptions();
  imageEditStatus('请选择一张图片；修改结果将成为一条新任务。');setImageEditBusy(false);
  const dialog=$('#imageEditDialog');dialog.showModal();
  if(source)await loadImageEditSource(source);
}
function imageEditPointerDown(event) {
  if(!imageEdit.blob||imageEdit.busy||imageEdit.active)return;
  if(!supportsImageMarks(imageModels().find(item=>item.id===$('#imageEditModel').value)))return;
  event.preventDefault();
  const canvas=$('#imageEditCanvas'),point=imageEditPoint(event);
  imageEdit.active={width:Number($('#imageEditBrush').value)*canvas.width/canvas.getBoundingClientRect().width,points:[point]};
  canvas.setPointerCapture(event.pointerId);renderImageEditStrokes();
}
function imageEditPointerMove(event) {
  if(!imageEdit.active)return;
  event.preventDefault();
  const stroke=imageEdit.active,previous=stroke.points[stroke.points.length-1],current=imageEditPoint(event);
  stroke.points.push(current);
  drawImageEditStroke($('#imageEditCanvas').getContext('2d'),{width:stroke.width,points:[previous,current]});
}
function imageEditPointerEnd(event) {
  if(!imageEdit.active)return;
  event.preventDefault();
  imageEdit.strokes.push(imageEdit.active);imageEdit.active=null;renderImageEditStrokes();
}
function canvasBlob(canvas,type,quality) {
  return new Promise((resolve,reject)=>canvas.toBlob(blob=>blob?resolve(blob):reject(new Error('标注图片导出失败')),type,quality));
}
async function imageEditFiles() {
  const img=$('#imageEditSource'),overlay=$('#imageEditCanvas');
  const composite=document.createElement('canvas');composite.width=overlay.width;composite.height=overlay.height;
  const ctx=composite.getContext('2d');ctx.drawImage(img,0,0,composite.width,composite.height);
  let original=imageEdit.blob;
  if(!['image/png','image/jpeg','image/webp'].includes(original.type)||original.size>30*1024*1024) {
    original=await canvasBlob(composite,'image/webp',0.94);
  }
  const originalFile=new File([original],`原图.${original.type==='image/png'?'png':original.type==='image/jpeg'?'jpg':'webp'}`,{type:original.type});
  if(!imageEdit.strokes.length)return [originalFile];
  ctx.drawImage(overlay,0,0);
  const marked=await canvasBlob(composite,'image/webp',0.94);
  return [originalFile,new File([marked],'手绘标注.webp',{type:'image/webp'})];
}
async function submitImageEdit(event) {
  event.preventDefault();
  const revision=relayConfigRevision;
  if(imageEdit.busy||imageEdit.loading||imageEdit.aborted)return;
  if(!imageEdit.blob){imageEditStatus('请等待原图加载完成',true);return;}
  const model=imageModels().find(item=>item.id===$('#imageEditModel').value);
  if(!model){imageEditStatus('请重新选择图片线路',true);return;}
  const hasMarks=imageEdit.strokes.length>0;
  const limitError=mediaLimitError(model,Array.from({length:hasMarks?2:1},()=>({kind:'image'})));
  if(limitError){imageEditStatus(limitError,true);return;}
  let prompt;
  try{prompt=buildImageEditPrompt($('#imageEditInstruction').value,hasMarks);}
  catch(error){imageEditStatus(error.message,true);return;}
  const snapshot=quoteSnapshot('imageEdit'),requestId=crypto.randomUUID();
  setImageEditBusy(true);
  let requestStarted=false;
  try {
    const quote=await confirmPaidSubmission('imageEdit',snapshot);
    if(!quote||revision!==relayConfigRevision)return;
    const files=await imageEditFiles();
    if(revision!==relayConfigRevision)return;
    const images=[];
    for(let index=0;index<files.length;index++) {
      imageEditStatus(`正在上传${index===0?'原图':'标注图'}（${index+1}/${files.length}）…`);
      const uploaded=await uploadFile(files[index],'image',true,(loaded,total)=>{
        if(revision===relayConfigRevision&&total)imageEditStatus(`正在上传${index===0?'原图':'标注图'}（${Math.round(loaded/total*100)}%）…`);
      });
      if(revision!==relayConfigRevision)return;
      if(!uploaded?.url)throw new Error('上传未返回有效图片地址，请重试');
      images.push({tag:`图片${index+1}`,url:uploaded.url});
    }
    if(!confirmedQuoteCurrent('imageEdit',snapshot,quote)){quoteController.invalidate('imageEdit','expired');imageEditStatus('报价已失效或参数已变化，请重新获取报价并确认。',true);return;}
    imageEditStatus('正在提交图片修改任务…');
    const payload=buildImagePayload({model,prompt,aspect_ratio:$('#imageEditRatio').value,size:$('#imageEditSize').value,quality:$('#imageEditQuality').value,concurrency:1,images});
    if(state.relayMode)payload.quote_id=quote.id;
    requestStarted=true;
    const created=await request('/images',{method:'POST',json:payload,headers:{Prefer:'respond-async','Idempotency-Key':requestId}});
    if(revision!==relayConfigRevision)return;
    if(!acceptLocalTask(created)&&!extractTaskIds(created).length&&!(created?.accepted&&created?.stopped))throw new Error('提交状态待确认，请先查看历史记录，勿重复提交');
    noteQuotedResult('imageEdit',created,requestId);
    if(pendingQuotedSubmissions.has('imageEdit')){imageEditStatus('提交结果待确认，请先核对历史记录，勿重复提交。',true);return;}
    toast(created?.stopped?submissionMessage(created):'修改任务已提交，原图已保留');
    $('#imageEditDialog').close();switchView('generate');
    void syncTasks();
  } catch(error) {
    if(revision!==relayConfigRevision)return;
    if(requestStarted) {
      const handled=quoteSubmissionFailed('imageEdit',error,requestId);
      if(pendingQuotedSubmissions.has('imageEdit')||!state.relayMode){imageEdit.aborted=true;imageEditStatus('提交状态待确认，请先查看历史记录，勿重复提交。',true);}
      else imageEditStatus(handled?'报价已失效，请重新获取报价并确认。':publicText(error.message||'提交失败，请检查后重试'),true);
    } else imageEditStatus(error.message||'图片上传失败，请重试',true);
  } finally {if(revision===relayConfigRevision)setImageEditBusy(false);}
}
let historyFilter = 'all';
let historyLimit = HISTORY_BATCH_SIZE;
function renderHistory() {
  const history = state.tasks;
  const filtered = history.filter((h) => historyFilter === 'all' || h.type === historyFilter);
  const el = $('#historyList');
  el.querySelector('.empty-hint')?.remove();
  el.querySelector('[data-history-more]')?.remove();
  if (!filtered.length) { patchTaskCards(el,[]); const empty=document.createElement('div');empty.className='empty-hint';empty.textContent=history.length?'该分类暂无记录':'暂无历史记录';el.append(empty);return; }
  const visible=filtered.slice(0,historyLimit);
  patchTaskCards(el,visible);
  if(visible.length<filtered.length){const more=document.createElement('button');more.type='button';more.className='plain-button subtle history-more';more.dataset.historyMore='';more.textContent=`显示更多（剩余 ${filtered.length-visible.length} 条）`;more.addEventListener('click',()=>{historyLimit+=HISTORY_BATCH_SIZE;renderHistory();});el.append(more);}
}
async function clearHistory() {
  if (!confirm('仅清除已结束且不再等待保存的任务记录；进行中任务和桌面结果文件会保留。继续吗？')) return;
  try { await request('/tasks',{method:'DELETE'}); await syncTasks(); renderHistory(); }
  catch(e) {handleError(e);}
}
async function clearFailedTasks() {
  if (!state.tasks.some(task => task.status === 'failed')) { toast('暂无失败任务'); return; }
  if (!confirm('清除所有失败任务记录？进行中任务、成功作品和本地文件不会删除。')) return;
  try { await request('/tasks?status=failed',{method:'DELETE'}); await syncTasks(); renderHistory(); toast('失败任务记录已清除'); }
  catch(e) {handleError(e);}
}

// ---- 数字人 ----
function rhHasKey() { return hasRhKey(); }
function toolStatus(channel){return toolAvailability({configured:rhHasKey(),checking:state.toolChecking,connection:state.toolConnection,lineState:state.toolStates?.[channel],model:state.toolModels.find(model=>model.id==='tool-'+channel),catalogReady:state.toolCatalogReady});}
function requireToolReady(channel){
  if(!requireRhKey())return false;
  if(!state.relayMode)return true;
  const result=toolStatus(channel);if(result.state==='ready')return true;
  toast(result.message);return false;
}
const toolUploadVersions={image:0,audio:0,video:0};
function dhSetHint(update=true) {
  const { image, audio } = state.dh;
  const btn = $('#dhSubmit');
  const hint = $('#dhHint');
  if (!btn || !hint) return;
  if(update)updateSurfaceQuote('digital');
  if(state.dh.submitting){btn.disabled=true;hint.textContent='正在提交数字人任务，请勿重复提交';return;}
  if (!rhHasKey()) {
    btn.disabled = true;
    hint.textContent = accountHint();
    return;
  }
  if(state.relayMode){const availability=toolStatus('digital');if(availability.state!=='ready'){btn.disabled=true;hint.textContent=availability.message;return;}}
  const fee=pricingQuote(state.toolModels.find(m=>m.id==='tool-digital'),{quote:quoteController.state('digital').quote,concurrency:1});
  if(!state.relayMode&&!fee.known){btn.disabled=true;hint.textContent='工具线路尚未开放，请稍后刷新';return;}
  const feeText=fee.text+(fee.external?'':'/次');
  if (!image && !audio) { btn.disabled = true; hint.textContent = feeText+' · 请先上传人物参考图与音频'; return; }
  if (!image) { btn.disabled = true; hint.textContent = feeText+' · 还需上传人物参考图'; return; }
  if (!audio) { btn.disabled = true; hint.textContent = feeText+' · 还需上传音频'; return; }
  if(!image.fileName||!audio.fileName){btn.disabled=true;hint.textContent='连接配置已变更，请重新上传人物参考图与音频';return;}
  btn.disabled = state.relayMode&&!quoteReady('digital');
  hint.textContent = `${state.relayMode?'素材已就绪，请核对报价':feeText+' · 已就绪'}${Number.isFinite(audio.duration) ? ` · 音频 ${audio.duration.toFixed(1)} 秒` : ''}`;
}
function renderDhSlots() {
  const { image, audio } = state.dh;
  $('#editDhImage').hidden=!image;
  const imgBox = $('#dhImageBox');
  const audBox = $('#dhAudioBox');
  imgBox.classList.toggle('is-loaded', Boolean(image));
  audBox.classList.toggle('is-loaded', Boolean(audio));
  const old = imgBox.querySelector('img');
  if (old) old.remove();
  const imgInfo = $('#dhImageInfo');
  if (image) {
    $('#dhImagePlaceholder').hidden = true;
    const el = document.createElement('img');
    el.src = image.local;
    el.alt = '';
    imgBox.appendChild(el);
    imgInfo.textContent = `✓ ${image.name}`;
    imgInfo.className = 'upload-info ok';
  } else {
    $('#dhImagePlaceholder').hidden = false;
    imgInfo.textContent = '';
    imgInfo.className = 'upload-info';
  }
  const audInfo = $('#dhAudioInfo');
  const audPh = $('#dhAudioPlaceholder');
  if (audio) {
    audPh.hidden = false;
    audPh.innerHTML = '<b><i data-lucide="badge-check"></i></b><strong>声音已就绪</strong><small>点击或拖入可替换音频</small>';
    audPh.classList.add('audio-loaded');
    audInfo.textContent = `✓ ${audio.name}${Number.isFinite(audio.duration) ? ` · ${audio.duration.toFixed(1)} 秒` : ''}`;
    audInfo.className = 'upload-info ok';
  } else {
    audPh.hidden = false;
    audPh.innerHTML = '<b><i data-lucide="audio-lines"></i></b><strong>拖入声音文件</strong><small>或点击选择 · 最长 30 秒</small>';
    audPh.classList.remove('audio-loaded');
    audInfo.textContent = '';
    audInfo.className = 'upload-info';
  }
  refreshIcons(audPh);
  dhSetHint();
}
function requireRhKey() {
  if (rhHasKey()) return true;
  toast(accountHint());
  switchView('account');
  return false;
}
async function dhPickImage(file) {
  if (!file || !requireToolReady('digital')) return;
  const revision=relayConfigRevision,version=++toolUploadVersions.image;
  const info = $('#dhImageInfo');
  const box = $('#dhImageBox');
  box.classList.add('is-uploading');
  info.textContent = '上传中…'; info.className = 'upload-info';
  try {
    const fileName = await rhUpload(file);
    if(revision!==relayConfigRevision||version!==toolUploadVersions.image)return;
    if(state.dh.image?.local)URL.revokeObjectURL(state.dh.image.local);
    state.dh.image = { fileName, name: file.name, local: URL.createObjectURL(file) };
  } catch (e) {
    if(revision!==relayConfigRevision||version!==toolUploadVersions.image)return;
    info.textContent = publicText(e.message); info.className = 'upload-info error';
    handleError(e); return;
  } finally {
    if(revision===relayConfigRevision&&version===toolUploadVersions.image)box.classList.remove('is-uploading');
  }
  if(revision!==relayConfigRevision||version!==toolUploadVersions.image)return;
  renderDhSlots();
}
async function dhPickAudio(file) {
  if (!file || !requireToolReady('digital')) return;
  const revision=relayConfigRevision,version=++toolUploadVersions.audio;
  const info = $('#dhAudioInfo');
  const dur = await audioDuration(file);
  if(revision!==relayConfigRevision||version!==toolUploadVersions.audio)return;
  if(!Number.isFinite(dur)||dur<=0){toast('无法读取音频时长，请更换音频');return;}
  if (Number.isFinite(dur) && dur > RH_MAX_AUDIO_SECONDS) {
    const msg = `音频 ${dur.toFixed(1)} 秒，超过 ${RH_MAX_AUDIO_SECONDS} 秒上限`;
    info.textContent = msg; info.className = 'upload-info error';
    toast(msg);
    return;
  }
  info.textContent = '上传中…'; info.className = 'upload-info';
  const box = $('#dhAudioBox');
  box.classList.add('is-uploading');
  try {
    const fileName = await rhUpload(file);
    if(revision!==relayConfigRevision||version!==toolUploadVersions.audio)return;
    state.dh.audio = { fileName, name: file.name, duration: dur };
  } catch (e) {
    if(revision!==relayConfigRevision||version!==toolUploadVersions.audio)return;
    info.textContent = publicText(e.message); info.className = 'upload-info error';
    handleError(e); return;
  } finally {
    if(revision===relayConfigRevision&&version===toolUploadVersions.audio)box.classList.remove('is-uploading');
  }
  if(revision!==relayConfigRevision||version!==toolUploadVersions.audio)return;
  renderDhSlots();
}
async function pickToolAsset(kind,category,boxSelector,infoSelector) {
  if(!requireToolReady(kind==='video'?'depth':'digital'))return null;
  const revision=relayConfigRevision;
  const item=await pickAsset({category,kinds:[kind]});
  if(!item||revision!==relayConfigRevision)return null;
  if(item.kind!==kind){toast(`请选择${KIND_LABEL[kind]}素材`);return null;}
  const version=++toolUploadVersions[kind],box=$(boxSelector),info=$(infoSelector);
  box.classList.add('is-uploading');info.textContent='上传中…';info.className='upload-info';
  try {
    const local=`/api/assets/${item.id}/file`;
    let duration;
    if(kind==='audio'){
      duration=Number(item.durationSeconds)||await audioDuration(local);
      if(revision!==relayConfigRevision||version!==toolUploadVersions[kind])return null;
      if(!Number.isFinite(duration)||duration<=0)throw new Error('无法读取音频时长，请更换音频');
      if(duration>RH_MAX_AUDIO_SECONDS)throw new Error(`音频 ${duration.toFixed(1)} 秒，超过 ${RH_MAX_AUDIO_SECONDS} 秒上限`);
    }
    const uploaded=await assetsRequest('/api/assets',`/${item.id}/upload?use=${state.relayMode?'tool':'video'}`,{method:'POST',headers:state.relayMode&&Number.isSafeInteger(state.relayServerRevision)?{'X-Hamster-Config-Revision':String(state.relayServerRevision)}:{}});
    if(revision!==relayConfigRevision||version!==toolUploadVersions[kind])return null;
    if(!uploaded?.url)throw new Error('素材上传未完成，请重试');
    return {revision,version,value:{fileName:uploaded.url,name:item.name,local,duration}};
  } catch(error) {
    if(revision===relayConfigRevision&&version===toolUploadVersions[kind]){
      info.textContent=publicText(error.message);info.className='upload-info error';handleError(error);
    }
    return null;
  } finally {
    if(revision===relayConfigRevision&&version===toolUploadVersions[kind])box.classList.remove('is-uploading');
  }
}
async function dhPickImageAsset() {
  const result=await pickToolAsset('image','talent','#dhImageBox','#dhImageInfo');
  if(!result||result.revision!==relayConfigRevision||result.version!==toolUploadVersions.image)return;
  if(state.dh.image?.local?.startsWith('blob:'))URL.revokeObjectURL(state.dh.image.local);
  state.dh.image=result.value;renderDhSlots();
}
async function dhPickAudioAsset() {
  const result=await pickToolAsset('audio','talent','#dhAudioBox','#dhAudioInfo');
  if(!result||result.revision!==relayConfigRevision||result.version!==toolUploadVersions.audio)return;
  state.dh.audio=result.value;renderDhSlots();
}
async function dhSubmit() {
  const revision=relayConfigRevision;
  if(state.dh.submitting)return;
  if (!requireToolReady('digital')) return;
  const model=state.toolModels.find(m=>m.id==='tool-digital');if(!model||!state.relayMode&&!pricingQuote(model).known){toast('工具线路尚未开放，请稍后刷新');return;}
  const { image, audio } = state.dh;
  if (!image?.fileName || !audio?.fileName) { toast('请先上传当前账户的人物参考图和音频'); return; }
  const btn = $('#dhSubmit');
  const snapshot=quoteSnapshot('digital'),requestId=crypto.randomUUID();
  state.dh.submitting=true;
  btn.disabled = true;
  let requestStarted=false;
  try {
    const quote=await confirmPaidSubmission('digital',snapshot);
    if(!quote||revision!==relayConfigRevision)return;
    if(!confirmedQuoteCurrent('digital',snapshot,quote)){toast('参数或报价已变化，请重新确认');return;}
    requestStarted=true;
    const created = await request('/tools/digital', {method:'POST',headers:{'Idempotency-Key':requestId},json:{model:'tool-digital',price_version:model.price_version,...(state.relayMode?{quote_id:quote.id}:{}),prompt:'数字人视频',images:[{url:image.fileName}],audios:[{url:audio.fileName,durationSeconds:audio.duration}],concurrency:1}});
    if(revision!==relayConfigRevision)return;
    if (created?.errorCode) throw new Error(created.errorMessage || created.errorCode);
    if (!acceptLocalTask(created) && !created?.taskId && !(created?.accepted&&created?.stopped)) throw new Error('提交结果待确认，请检查历史记录，勿重复提交');
    noteQuotedResult('digital',created,requestId);toast(submissionMessage(created));
  } catch (e) {
    if(revision!==relayConfigRevision)return;
    await syncTasks();
    if(revision===relayConfigRevision&&!(requestStarted&&quoteSubmissionFailed('digital',e,requestId)))handleError(e);
  } finally { if(revision===relayConfigRevision){state.dh.submitting=false;btn.disabled = false; dhSetHint(); syncTasks();} }
}

// ---- 工具箱：黑白深度视频 ----
function depthSetHint(update=true) {
  const btn = $('#depthSubmit');
  const hint = $('#depthHint');
  if (!btn || !hint) return;
  if(update)updateSurfaceQuote('depth');
  if(state.depth.submitting){btn.disabled=true;hint.textContent='正在提交深度视频任务，请勿重复提交';return;}
  if (!rhHasKey()) {
    btn.disabled = true;
    hint.textContent = accountHint();
    return;
  }
  if(state.relayMode){const availability=toolStatus('depth');if(availability.state!=='ready'){btn.disabled=true;hint.textContent=availability.message;return;}}
  const fee=pricingQuote(state.toolModels.find(m=>m.id==='tool-depth'),{quote:quoteController.state('depth').quote,concurrency:1});
  if(!state.relayMode&&!fee.known){btn.disabled=true;hint.textContent='工具线路尚未开放，请稍后刷新';return;}
  if (!state.depth.video) {
    btn.disabled = true;
    hint.textContent = fee.text+' · 请先上传源视频';
    return;
  }
  if(!state.depth.video.fileName){btn.disabled=true;hint.textContent='连接配置已变更，请重新上传源视频';return;}
  btn.disabled = state.relayMode&&!quoteReady('depth');
  hint.textContent = state.relayMode?'视频已就绪，请核对报价':fee.text+' · 视频已就绪';
}
function renderDepthSlot() {
  const item = state.depth.video;
  const box = $('#depthVideoBox');
  const placeholder = $('#depthVideoPlaceholder');
  const info = $('#depthVideoInfo');
  if (!box || !placeholder || !info) return;
  box.classList.toggle('is-loaded', Boolean(item));
  box.querySelector('video')?.remove();
  if (item) {
    placeholder.hidden = true;
    const preview = document.createElement('video');
    preview.src = item.local;
    preview.controls = true;
    preview.muted = true;
    preview.preload = 'metadata';
    box.appendChild(preview);
    info.textContent = `✓ ${item.name}`;
    info.className = 'upload-info ok';
  } else {
    placeholder.hidden = false;
    info.textContent = '';
    info.className = 'upload-info';
  }
  depthSetHint();
}
async function depthPickVideo(file) {
  if (!file || !requireToolReady('depth')) return;
  const revision=relayConfigRevision,version=++toolUploadVersions.video;
  const info = $('#depthVideoInfo');
  const box = $('#depthVideoBox');
  box.classList.add('is-uploading');
  info.textContent = '上传中…';
  info.className = 'upload-info';
  try {
    const fileName = await rhUpload(file);
    if(revision!==relayConfigRevision||version!==toolUploadVersions.video)return;
    if(state.depth.video?.local)URL.revokeObjectURL(state.depth.video.local);
    state.depth.video = { fileName, name: file.name, local: URL.createObjectURL(file) };
  } catch (e) {
    if(revision!==relayConfigRevision||version!==toolUploadVersions.video)return;
    info.textContent = publicText(e.message);
    info.className = 'upload-info error';
    handleError(e);
    return;
  } finally {
    if(revision===relayConfigRevision&&version===toolUploadVersions.video)box.classList.remove('is-uploading');
  }
  if(revision!==relayConfigRevision||version!==toolUploadVersions.video)return;
  renderDepthSlot();
}
async function depthPickVideoAsset() {
  const result=await pickToolAsset('video','scene','#depthVideoBox','#depthVideoInfo');
  if(!result||result.revision!==relayConfigRevision||result.version!==toolUploadVersions.video)return;
  if(state.depth.video?.local?.startsWith('blob:'))URL.revokeObjectURL(state.depth.video.local);
  state.depth.video=result.value;renderDepthSlot();
}
async function depthSubmit() {
  const revision=relayConfigRevision;
  if(state.depth.submitting)return;
  if (!requireToolReady('depth')) return;
  const model=state.toolModels.find(m=>m.id==='tool-depth');if(!model||!state.relayMode&&!pricingQuote(model).known){toast('工具线路尚未开放，请重新检测连接');return;}
  const video = state.depth.video;
  if (!video?.fileName) { toast('请先上传当前账户的源视频'); return; }
  const btn = $('#depthSubmit');
  const snapshot=quoteSnapshot('depth'),requestId=crypto.randomUUID();
  state.depth.submitting=true;
  btn.disabled = true;
  let requestStarted=false;
  try {
    const quote=await confirmPaidSubmission('depth',snapshot);
    if(!quote||revision!==relayConfigRevision)return;
    if(!confirmedQuoteCurrent('depth',snapshot,quote)){toast('参数或报价已变化，请重新确认');return;}
    requestStarted=true;
    const created = await request('/tools/depth', {method:'POST',headers:{'Idempotency-Key':requestId},json:{model:'tool-depth',price_version:model.price_version,...(state.relayMode?{quote_id:quote.id}:{}),prompt:'黑白深度视频',videos:[{url:video.fileName}],concurrency:1}});
    if(revision!==relayConfigRevision)return;
    if (created?.errorCode) throw new Error(created.errorMessage || created.errorCode);
    if (!acceptLocalTask(created) && !created?.taskId && !(created?.accepted&&created?.stopped)) throw new Error('提交结果待确认，请检查历史记录，勿重复提交');
    noteQuotedResult('depth',created,requestId);toast(submissionMessage(created));
  } catch (e) {
    if(revision!==relayConfigRevision)return;
    await syncTasks();
    if(revision===relayConfigRevision&&!(requestStarted&&quoteSubmissionFailed('depth',e,requestId)))handleError(e);
  } finally {
    if(revision===relayConfigRevision){
      state.depth.submitting=false;
      btn.disabled = false;
      depthSetHint();
      syncTasks();
    }
  }
}

function renderRhStatus() {
  const s = $('#rhStatus');
  if (!s) return;
  if(state.relayMode){s.textContent=rhHasKey()?'已配置工具 Key；工具能否使用取决于 PIKNO 已开放线路':'请到「账户」页配置 PIKNO 工具 Key';s.className='hint';}
  else if (rhHasKey()) { s.textContent = '已配置，数字人与工具箱共用此 Key'; s.className = 'hint ok'; }
  else { s.textContent = '未配置，数字人与工具箱功能不可用'; s.className = 'hint'; }
  dhSetHint();
  depthSetHint();
}
let accountSessionRejected=false;
const inferenceIndicator=createInferenceIndicator({
  isRelay:()=>state.relayMode,
  isAuthenticated:()=>Boolean(state.llmServerConfigured)&&!accountSessionRejected,
  request:()=>requestOnce('/inference/status',{signal:AbortSignal.timeout(20000)}),
  notify:toast,
  onChange:view=>{
    const logo=$('#inferenceLogo');
    logo.dataset.state=view.status;
    logo.classList.toggle('is-connected',view.connected);
    logo.classList.toggle('is-checking',view.checking);
    logo.setAttribute('aria-busy',String(view.checking));
    logo.setAttribute('aria-disabled',String(view.checking));
    logo.setAttribute('aria-label',view.label);
    $('#inferenceLogoHint').textContent=view.label;
  },
});


// ---- 视图 & 初始化 ----
let selectingAsset = false;
let assetsView = null;
async function useGenerationAsset(item) {
  if (selectingAsset) return;
  if (!hasGenerationKey()) { toast(accountHint()); return; }
  const revision=relayConfigRevision;
  const error = mediaLimitError(state.model, [...state.media, ...state.pendingMedia, {kind:item.kind}]);
  if (error) { toast(error); return; }
  selectingAsset = true;
  $('#assetTile').disabled = true;
  try {
    toast('正在上传选定资产…');
    let uploaded;
    const headers={...(state.apiKey?{Authorization:`Bearer ${state.apiKey}`} : {}),...(state.relayMode&&Number.isSafeInteger(state.relayServerRevision)?{'X-Hamster-Config-Revision':String(state.relayServerRevision)}:{})};
    if (state.type === 'image') {
      uploaded = await assetsRequest('/api/assets', `/${item.id}/upload-direct`, {method:'POST', headers});
    } else {
      uploaded = await assetsRequest('/api/assets', `/${item.id}/upload?use=video`, {method:'POST', headers});
    }
    if(revision!==relayConfigRevision)return;
    addMediaByUrl(uploaded.url, item.kind);
    switchView('generate');
  } catch (e) { if(revision===relayConfigRevision)toast(e.message); }
  finally { selectingAsset = false; $('#assetTile').disabled = false; }
}
async function openGenerationAssets() {
  const item = await pickAsset({category:'talent'});
  if (item) await useGenerationAsset(item);
}
function switchView(name) {
  $$('.view').forEach((v) => v.classList.toggle('active', v.dataset.panel === name));
  $$('.rail-item').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
  if (name === 'history') { renderHistory(); syncTasks(); }
  if (name === 'assets') {
    if (!assetsView) assetsView=assetLibrary($('#assetLibrary'),{onSelect:useGenerationAsset,onEdit:item=>void openImageEdit({url:`/api/assets/${item.id}/file`})});
    else void assetsView.refresh();
  }
  if (name === 'account') { renderAccount(); renderRhStatus(); }
  if (name === 'digital') { renderDhSlots(); renderDhResults(); }
  if (name === 'depth') { renderDepthSlot(); renderDepthResults(); }
}
function wait(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
async function readSmartVideoResponse(path, options) {
  const response = await fetch(path, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message || '对话服务启动失败');
  return data;
}
let workbenchReady=false, preparationPromise=null, workbenchOpening=false, preparationError='';
function renderWorkbenchPreparation(data) {
  workbenchReady=data.status==='ready';
  const failed=data.status==='error';
  const waiting=data.status==='stopped';
  const percent=workbenchReady?100:Math.min(95,Math.max(0,Number(data.progress?.percent)||0));
  $('#workbenchProgress').value=percent;
  $('#workbenchProgressText').textContent=failed?'准备失败':workbenchReady?'已就绪':waiting?'等待后台准备':`准备中 ${percent}%`;
  $('#workbenchProgressText').title=failed?data.message || '请查看问题':waiting?'点击可立即启动，或等待后台预热':'准备完成后即可打开对话';
  $('#workbenchButton').disabled=workbenchOpening;
  $('#retryWorkbench').hidden=!failed;
  $('#workbenchDiagnostic').hidden=!failed;
  if(failed)preparationError=data.message || '对话准备失败，请查看问题';
}
async function prepareWorkbench() {
  if(preparationPromise)return preparationPromise;
  preparationPromise=(async()=>{
    renderWorkbenchPreparation({status:'starting'});
    try {
      let data=await readSmartVideoResponse('/api/workbench/prepare',{method:'POST'});
      for(let attempt=0;attempt<900;attempt++) {
        renderWorkbenchPreparation(data);
        if(data.status==='ready')return true;
        if(data.status==='error'||data.status==='stopped')throw Error(data.message || '对话准备中断，请重试');
        await wait(1000);
        data=await readSmartVideoResponse('/api/chat/status');
      }
      throw Error('对话准备超时，请稍后重试或联系支持');
    } catch(error) {
      renderWorkbenchPreparation({status:'error',message:publicText(error.message),progress:{percent:$('#workbenchProgress').value}});
      return false;
    }
  })();
  try{return await preparationPromise;}finally{preparationPromise=null;}
}
async function openWorkbench() {
  if(workbenchOpening)return;
  const endpoint = '/api/chat';
  const label = '对话';
  const button = $('#workbenchButton');
  workbenchOpening=true;
  button.disabled = true;
  button.classList.add('is-launching');
  try {
    if(!workbenchReady) {
      toast('正在准备对话，完成后将自动打开…');
      if(!await prepareWorkbench())return;
    }
    toast('正在打开对话…');
    let state = await readSmartVideoResponse(endpoint + '/open', { method: 'POST' });
    if (state.status === 'ready') { toast(label + '已在浏览器打开'); return; }
    workbenchReady=false;
    void prepareWorkbench();
    toast('对话正在重新准备，完成后请再次点击打开');
  } catch (error) {
    renderWorkbenchPreparation({status:'error',message:publicText(error.message)});
    $('#startupErrorMessage').textContent=publicText(error.message || '本地对话启动失败');
    if(!$('#startupErrorDialog').open)$('#startupErrorDialog').showModal();
  } finally {
    workbenchOpening=false;
    button.disabled = false;
    button.classList.remove('is-launching');
  }
}
function bindEvents() {
  $('#storageStatus').addEventListener('click', () => void checkStorageStatus({manual:true}));
  $('#inferenceLogo').addEventListener('click',()=>{
    if($('#inferenceLogo').getAttribute('aria-busy')==='true')return;
    void inferenceIndicator.check({manual:true});
  });
  window.addEventListener('hamster-session-invalidated',()=>{accountSessionRejected=true;resetSurfaceQuotes();inferenceIndicator.reset();});
  window.addEventListener('hamster-relay-catalog-refresh',()=>{if(state.relayMode)void loadModels(Promise.resolve(),{force:true});});
  window.addEventListener('hamster-relay-configured',()=>{
    const revision=++relayConfigRevision;
    state.dh.submitting=false;state.depth.submitting=false;
    for(const kind of ['image','audio','video'])toolUploadVersions[kind]++;
    for(const item of [state.dh.image,state.dh.audio,state.depth.video])if(item)item.fileName='';
    for(const item of state.media)item.authorizationInvalid=true;
    for(const selector of ['#dhImageBox','#dhAudioBox','#depthVideoBox'])$(selector)?.classList.remove('is-uploading');
    state.submitting=false;
    imageEdit.loadId++;imageEdit.loading=false;imageEdit.aborted=true;setImageEditBusy(false);
    if($('#imageEditDialog').open)imageEditStatus('连接配置已变更。原图与笔画仍保留；请关闭后重新选择当前账户的图片线路。');
    state.models=[];state.toolModels=[];state.tasks=[];state.batches=[];state.model=null;
    state.toolChecking=false;state.toolCatalogReady=false;state.toolConnection=null;state.toolStates={};batchControlsSignature='';renderBatchControls();
    state.serverKeyConfigured=false;state.videoServerConfigured=false;state.rhServerConfigured=false;state.llmServerConfigured=false;
    accountSessionRejected=false;inflightGets.clear();uploadReuse.clear();inferenceIndicator.reset();
    resetSurfaceQuotes();mediaLimitSignature='';
    clearTimeout(storageStatusTimer);storageStatusPending=null;storageStatusKnown=false;storageStatusFailures=0;renderStorageStatus(false);
    renderComposer();renderRhStatus();renderAllTasks();
    void (async()=>{
      try {
        const d=await requestOnce('/config');if(revision!==relayConfigRevision)return;
        state.relayMode=Boolean(d.relayMode);state.serverKeyConfigured=Boolean(d.configured);state.videoServerConfigured=Boolean(d.videoConfigured);
        state.rhServerConfigured=Boolean(d.toolConfigured??d.rhConfigured);state.llmServerConfigured=Boolean(d.llmConfigured);state.relayServerRevision=d.revision;
        if(hasKey()||hasVideoKey()||hasRhKey())void checkStorageStatus();
        renderRhStatus();await loadModels();await syncTasks();
        if(revision===relayConfigRevision&&state.llmServerConfigured)void inferenceIndicator.check();
      }catch {if(revision===relayConfigRevision)toast('无法刷新连接配置，请重新打开应用');}
    })();
  });
  window.addEventListener('offline',()=>inferenceIndicator.reset('error'));
  window.addEventListener('online',()=>void inferenceIndicator.check());
  $('#closeStartupError').addEventListener('click',()=>$('#startupErrorDialog').close());
  $('#closeTaskPreview').addEventListener('click',()=>$('#taskPreviewDialog').close());
  $('#taskPreviewDialog').addEventListener('click',(event)=>{if(event.target===event.currentTarget)event.currentTarget.close();});
  $('#taskPreviewDialog').addEventListener('close',()=>{
    const video=$('#taskPreviewBody video');if(video)video.pause();$('#taskPreviewBody').replaceChildren();
  });
  $('#closeImageEdit').addEventListener('click',closeImageEdit);
  $('#imageEditDialog').addEventListener('cancel',event=>{if(imageEdit.busy)event.preventDefault();});
  $('#imageEditDialog').addEventListener('close',()=>{
    imageEdit.loadId++;
    if(imageEdit.objectUrl)URL.revokeObjectURL(imageEdit.objectUrl);
    imageEdit.objectUrl='';imageEdit.blob=null;imageEdit.strokes=[];imageEdit.active=null;imageEdit.loading=false;
    $('#imageEditSource').removeAttribute('src');
    updateSurfaceQuote('imageEdit');
  });
  $('#globalImageEdit').addEventListener('click',()=>void openImageEdit());
  $('#imageEditUpload').addEventListener('change',event=>{
    const file=event.target.files?.[0];event.target.value='';
    if(file)void loadImageEditSource(file);
  });
  $('#imageEditPickAsset').addEventListener('click',async()=>{
    const item=await pickAsset({category:'talent'});
    if(item){if(item.kind==='image')void loadImageEditSource({url:`/api/assets/${item.id}/file`});else toast('请选择图片资产');}
  });
  $('#imageEditModel').addEventListener('change',imageEditOptions);
  $('#imageEditRatio').addEventListener('change',()=>imageEditSizes());
  for(const selector of ['#imageEditSize','#imageEditQuality'])$(selector).addEventListener('change',()=>updateSurfaceQuote('imageEdit'));
  $('#imageEditUndo').addEventListener('click',()=>{imageEdit.strokes.pop();renderImageEditStrokes();});
  $('#imageEditClear').addEventListener('click',()=>{imageEdit.strokes=[];renderImageEditStrokes();});
  $('#imageEditCanvas').addEventListener('pointerdown',imageEditPointerDown);
  $('#imageEditCanvas').addEventListener('pointermove',imageEditPointerMove);
  $('#imageEditCanvas').addEventListener('pointerup',imageEditPointerEnd);
  $('#imageEditCanvas').addEventListener('pointercancel',imageEditPointerEnd);
  $('#imageEditForm').addEventListener('submit',submitImageEdit);
  $$('[data-quote-refresh]').forEach(button=>button.addEventListener('click',async()=>{
    const key=button.dataset.quoteRefresh;
    if(pendingQuotedSubmissions.has(key)){await syncTasks();if(pendingQuotedSubmissions.has(key)){toast('提交结果仍待确认，请先核对历史记录，勿重复提交');return;}}
    const snapshot=quoteSnapshot(key);if(snapshot)quoteController.update(key,snapshot,{immediate:true,force:true});
  }));
  $$('.rail-item[data-view]').forEach((b) => b.addEventListener('click', () => switchView(b.dataset.view)));
  $('#workbenchButton').addEventListener('click', openWorkbench);
  $('#retryWorkbench').addEventListener('click',()=>void prepareWorkbench());
  $('#workbenchDiagnostic').addEventListener('click',()=>{
    $('#startupErrorMessage').textContent=preparationError;
    if(!$('#startupErrorDialog').open)$('#startupErrorDialog').showModal();
  });
  $('[data-menu="type"]').addEventListener('click', (e) => typeMenu(e.currentTarget));
  $('[data-menu="model"]').addEventListener('click', (e) => modelMenu(e.currentTarget));
  $('[data-menu="reference"]').addEventListener('click', (e) => referenceMenu(e.currentTarget));
  $('[data-menu="ratio"]').addEventListener('click', (e) => ratioMenu(e.currentTarget));
  $('[data-menu="size"]').addEventListener('click', (e) => sizeMenu(e.currentTarget));
  $('[data-menu="quality"]').addEventListener('click', (e) => qualityMenu(e.currentTarget));
  $('[data-menu="duration"]').addEventListener('click', (e) => durationMenu(e.currentTarget));
  $('[data-menu="concurrency"]').addEventListener('click', (e) => concurrencyMenu(e.currentTarget));
  $('#prompt').addEventListener('input', updateMentionMenu);
  $('#prompt').addEventListener('keydown', onPromptKeydown);
  $('#prompt').addEventListener('blur', () => {
    if (mentionBlurTimer !== null) clearTimeout(mentionBlurTimer);
    mentionBlurTimer = setTimeout(() => {
      mentionBlurTimer = null;
      closeMentionMenu();
    }, 120);
  });
  $('#imageFile').addEventListener('change', (e) => { const files = Array.from(e.target.files || []); e.target.value = ''; void handleFiles(files, 'image'); });
  $('#videoFile').addEventListener('change', (e) => { const files = Array.from(e.target.files || []); e.target.value = ''; void handleFiles(files, 'video'); });
  $('#audioFile').addEventListener('change', (e) => { const files = Array.from(e.target.files || []); e.target.value = ''; void handleFiles(files, 'audio'); });
  $('#urlTile').addEventListener('click', () => { const f = $('#urlForm'); f.hidden = !f.hidden; });
  $('#assetTile').addEventListener('click', openGenerationAssets);
  $('#urlAdd').addEventListener('click', () => { addMediaByUrl($('#urlInput').value.trim(), $('#urlKind').value); $('#urlInput').value = ''; });
  $('#generationForm').addEventListener('submit', onSubmit);
  $('#mediaList').addEventListener('click',event=>{
    const remove=event.target.closest('[data-remove-media]');
    if(remove){removeMedia(remove.dataset.removeMedia);return;}
    const edit=event.target.closest('[data-edit-media]');
    if(edit){const media=state.media.find(item=>item.uiKey===edit.dataset.editMedia);if(media)void openImageEdit(media);return;}
    const tag=event.target.closest('.media-tag');if(tag)insertMention(tag.dataset.tag);
  });



  $('#dhImageFile').addEventListener('change', (e) => { dhPickImage(e.target.files[0]); e.target.value = ''; });
  $('#dhImageAsset').addEventListener('click',()=>void dhPickImageAsset());
  $('#editDhImage').addEventListener('click',()=>{if(state.dh.image)void openImageEdit(state.dh.image);});
  $('#dhAudioFile').addEventListener('change', (e) => { dhPickAudio(e.target.files[0]); e.target.value = ''; });
  $('#dhAudioAsset').addEventListener('click',()=>void dhPickAudioAsset());
  $('#dhSubmit').addEventListener('click', dhSubmit);
  $('#depthVideoFile').addEventListener('change', (e) => { depthPickVideo(e.target.files[0]); e.target.value = ''; });
  $('#depthVideoAsset').addEventListener('click',()=>void depthPickVideoAsset());
  $('#depthSubmit').addEventListener('click', depthSubmit);
  $('#depthPromptCopy').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText($('#depthPromptTemplate').textContent.trim());
      toast('提示词模板已复制');
    } catch { toast('复制失败，请手动选择模板'); }
  });
  bindDropZone($('#generationForm'), handleDroppedFiles);
  bindDropZone($('#dhImageBox'), (files) => {
    const file = Array.from(files || []).find((f) => kindForFile(f) === 'image');
    if (file) dhPickImage(file); else toast('请拖入图片文件');
  });
  bindDropZone($('#dhAudioBox'), (files) => {
    const file = Array.from(files || []).find((f) => kindForFile(f) === 'audio');
    if (file) dhPickAudio(file); else toast('请拖入音频文件');
  });
  bindDropZone($('#depthVideoBox'), (files) => {
    const file = Array.from(files || []).find((f) => kindForFile(f) === 'video');
    if (file) depthPickVideo(file); else toast('请拖入视频文件');
  });
  $$('#historyFilter .chip').forEach((c) => c.addEventListener('click', () => {
    $$('#historyFilter .chip').forEach((x) => x.classList.remove('active'));
    c.classList.add('active');
    historyFilter = c.dataset.hfilter;
    historyLimit = HISTORY_BATCH_SIZE;
    renderHistory();
  }));
  $('#clearHistory').addEventListener('click', clearHistory);
  $('#clearFailedTasks').addEventListener('click', clearFailedTasks);
}

async function init() {
  state.apiKey = '';
  state.videoApiKey = '';
  state.rhApiKey = '';
  localStorage.removeItem('hamster_llm_api_key');



  bindEvents();
  renderWorkbenchPreparation({status:'stopped'});
  void checkStorageStatus();
  window.addEventListener('online', () => void checkStorageStatus());
  initUiComponents();
  switchView('generate');
  renderMedia();
  renderTaskFeed();
  const configReady=(async()=>{
    try {
      const revision=relayConfigRevision,startup = await request('/startup');
      if(revision!==relayConfigRevision)return;
      const d = startup?.config || {};
      state.relayMode=Boolean(d.relayMode);
      state.assetSummary = startup?.assets || state.assetSummary;
      state.serverKeyConfigured = Boolean(d && d.configured);
      state.videoServerConfigured = Boolean(d && d.videoConfigured);
      state.rhServerConfigured = Boolean(d && (d.toolConfigured??d.rhConfigured));
      state.llmServerConfigured = Boolean(d && d.llmConfigured);
      state.relayServerRevision = d.revision;
    } catch (e) { state.serverKeyConfigured = false; state.videoServerConfigured = false; state.rhServerConfigured = false; state.llmServerConfigured = false; }
    renderAccount();renderRhStatus();inferenceIndicator.render();renderDhSlots();renderDepthSlot();
    if(state.relayMode&&!hasKey()&&!hasVideoKey()&&!hasRhKey())switchView('account');
    if (state.llmServerConfigured) void inferenceIndicator.check();
  })();
  const startupLoads=[configReady,restoreTasks(),loadModels(configReady)];
  void Promise.allSettled(startupLoads);
  const prewarm=()=>void prepareWorkbench();
  if('requestIdleCallback' in window)window.requestIdleCallback(prewarm,{timeout:3000});
  else setTimeout(prewarm,1500);
}
init();
