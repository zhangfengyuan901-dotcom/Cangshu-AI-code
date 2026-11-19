import {
  isVideo, isImage, concurrencyOptions, defaultVideoOptions, defaultImageOptions, imageSizesForRatio,
  buildVideoPayload, buildImagePayload, extractTaskIds, hamsterModelName, mapUpstreamModels, mediaLimitError, publicText,
  OFFICIAL_VIDEO_ROUTE, modelMediaSummary,
} from './core.mjs';
import { autoAnimate } from './vendor/auto-animate.mjs';
import { assetLibrary, pickAsset, chooseAssetCategory, assetsRequest, invalidateAssetsCache } from './asset-library.mjs';
import { copyTaskPrompt } from './task-prompt.mjs';
import { fileFingerprint, createUploadGate, createUploadQueue, mediaUploadMetadata, mediaExpiryError, refreshMediaReferences } from './media-upload-state.mjs';
import { installFaultEvents } from './fault-events.mjs';
import {pricingQuote,quoteValid,quoteSummary,catalogPriceText,formatMoney,estimatePrice} from './canvas-pricing.mjs';
import {modelOptionsError} from './canvas-core.mjs';
import {startVisibleCatalogRefresh} from './catalog-refresh.mjs';
import {createQuoteController,quoteFingerprint} from './quote-ui.mjs';
import {createInferenceIndicator} from './inference-indicator.mjs';
import {toolAvailability,batchIsActive,batchProgressText} from './relay-ui-state.mjs';
import {mountLocalWorkspace,safeLocalWorkspaceUrl} from './local-workspace.mjs';
import {createStorageStatusController,storageStatusKind,storageStatusView} from './storage-status.mjs';
import {startupView,startupCheckKind,startupGenerationType,needsMainCatalogue,createViewPreferenceWriter} from './startup-ui.mjs';
import {mountMaterialPreview,safeMaterialPreviewUrl} from './material-preview.mjs';
import {installInteractionHost,mountInteractionSettings,getInteractionPreferences,observeInteractionPreferences} from './interaction-policy.mjs';
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
let startupHydrated=false,startupConfig=null,navigationEpoch=0,catalogRefresh=null;
const viewPreferences=createViewPreferenceWriter(json=>request('/ui-preferences',{method:'POST',json,keepalive:true}));

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
  const animations=[];
  for (const selector of ['#mediaList', '#taskFeed', '#dhResults', '#depthResults', '#historyList']) {
    const element = $(selector);
    if (element) animations.push(autoAnimate(element, { duration: 190, easing: 'ease-out',disrespectUserMotionPreference:true }));
  }
  const apply=preferences=>{
    for(const animation of animations)animation[preferences.effectiveReducedMotion?'disable':'enable']();
    document.documentElement.dataset.uiMotion=preferences.effectiveReducedMotion?'reduced':'auto-animate';
  };
  apply(getInteractionPreferences());
  const stop=observeInteractionPreferences(apply);
  window.addEventListener('pagehide',stop,{once:true});
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
let toastTimer = null;
function toast(msg) {
  if(!msg)return;
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
async function requestOnce(path, { method = 'GET', json, raw, contentType, headers = {}, signal, keepalive = false } = {}) {
  const opts = { method, signal, keepalive, headers: { Authorization: `Bearer ${state.apiKey}`, ...headers } };
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
  if (/^media_(?:metadata_unavailable|duration_required|upload_(?:ticket|transfer|confirm))$/.test(e?.code||'') && e.message) return toast(e.message);
  if (e?.status === 401) toast(state.relayMode?'Key 验证未通过，请到「个人中心」检查 PIKNO Key':'登录已失效，请到「个人中心」重新登录');
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
function accountHint(){return state.relayMode?'请先到「个人中心」配置有效的 PIKNO Key':'请先在「个人中心」完成邮箱登录';}

// 报价只携带计费参数与素材数量；提示词和素材地址留在本机。
const pendingQuotedSubmissions=new Map();
let notifiedBalanceBatch;
const quotePanels={generate:'#generationQuote',digital:'#digitalQuote',depth:'#depthQuote'};
function surfaceModel(key){return key==='generate'?state.model:state.toolModels.find(m=>m.id===(key==='digital'?'tool-digital':'tool-depth'));}
function generationSelectionError(){
  if(!state.relayMode||!state.model)return '';
  if(!state.models.some(model=>model.id===state.model.id))return '当前线路已不可用，请重新选择线路';
  if(state.model.type==='image'&&state.model.image_billing!=='usage-v1')return '中转站尚未开放当前图片线路，请刷新线路后重试';
  if(!state.model.concurrency_options?.includes(state.concurrency))return '原任务份数已不可用，请重新选择份数';
  return modelOptionsError(state.model,state.options,state.model.type==='image'?'image':'main');
}
function generationSnapshot(){
  if(!state.relayMode||accountSessionRejected||!Number.isSafeInteger(state.relayServerRevision)||!state.model||!hasGenerationKey()||generationSelectionError())return null;
  const model=state.model,payload={model:model.id,concurrency:state.concurrency,media_counts:{images:0,videos:0,audios:0}};
  for(const field of ['size','quality','aspect_ratio','ratio','resolution','duration','reference'])if(state.options[field]!==undefined)payload[field]=state.options[field];
  const media=[...state.media,...state.pendingMedia];
  if(mediaLimitError(model,media))return null;
  for(const item of media){const field={image:'images',video:'videos',audio:'audios'}[item.kind];if(field)payload.media_counts[field]++;}
  return {revision:state.relayServerRevision,version:model.line_revision??model.price_version,payload,context:media.map(item=>[item.uiKey,item.authorizationInvalid])};
}
function quoteSnapshot(key){
  if(key==='generate')return isVideoType()?generationSnapshot():null;
  if(!state.relayMode||accountSessionRejected||!Number.isSafeInteger(state.relayServerRevision))return null;
  const model=surfaceModel(key);if(!model||!rhHasKey()||toolStatus(key).state!=='ready')return null;
  const payload={model:model.id,concurrency:1,media_counts:{images:0,videos:0,audios:0}};
  let context;
  if(key==='digital'){if(!state.dh.image?.fileName||!state.dh.audio?.fileName)return null;payload.media_counts.images=1;payload.media_counts.audios=1;context=[state.dh.image.fileName,state.dh.audio.fileName];}
  else {if(!state.depth.video?.fileName)return null;payload.media_counts.videos=1;context=[state.depth.video.fileName];}
  return {revision:state.relayServerRevision,version:model.line_revision??model.price_version,payload,context};
}
function quoteIsCurrent(key,snapshot){return quoteFingerprint(snapshot)===quoteFingerprint(quoteSnapshot(key));}
function renderQuoteCard(key,entry){
  const panel=$(quotePanels[key]);if(!panel)return;
  panel.hidden=!state.relayMode||key==='generate'&&!isVideoType();
  if(panel.hidden)return;
  panel.dataset.state=pendingQuotedSubmissions.has(key)?'unknown':entry.status;
  const model=surfaceModel(key),snapshot=quoteSnapshot(key),pending=pendingQuotedSubmissions.has(key)||entry.status==='unknown';
  const quote=!pending&&snapshot&&entry.fingerprint===quoteFingerprint(snapshot)&&entry.status==='ready'&&quoteValid(entry.quote,{model:snapshot.payload.model,quantity:snapshot.payload.concurrency})?entry.quote:null;
  const preview=!pending&&snapshot?estimatePrice(model,snapshot.payload):{known:false,text:'预估￥？元'};
  if(key==='generate'){
    const refresh=panel.querySelector('[data-quote-refresh]');
    refresh.textContent=quote?`预估￥${formatMoney(quote.total_cny).slice(1)}元`:preview.text;
    refresh.disabled=entry.status==='loading';
    refresh.setAttribute('aria-label',pendingQuotedSubmissions.has(key)?'核对原任务':'刷新预估费用');
    return;
  }
  panel.querySelector('[data-quote-title]').textContent=quote?.name||model?.name||'请选择线路';
  let description='暂时无法核算费用，请先配置对应 Key 并选择可用线路';
  if(model)description=preview.text+' · 生成时核算费用';
  if(pendingQuotedSubmissions.has(key))description='上次提交结果待确认。请先核对历史记录，暂不再次提交。';
  else if(entry.status==='loading')description='正在获取本次报价…';
  else if(quote)description=quoteSummary(quote)+(quote.reference_surcharge_cny&&!/^0(?:\.0+)?$/.test(quote.reference_surcharge_cny)?` · 含每份参考素材附加费 ${formatMoney(quote.reference_surcharge_cny)}`:'');
  else if(entry.status==='expired')description=preview.text+' · 生成时核算费用';
  else if(entry.status==='error')description='暂时无法核算费用，请稍后重试';
  panel.querySelector('[data-quote-description]').textContent=description;
  const refresh=panel.querySelector('[data-quote-refresh]');refresh.disabled=entry.status==='loading';refresh.textContent=pendingQuotedSubmissions.has(key)?'查询原任务':'重新报价';
}
function quoteEligible(key){return !pendingQuotedSubmissions.has(key)&&Boolean(quoteSnapshot(key));}
function refreshQuoteAvailability(key){
  if(key==='generate'){
    const error=state.model?mediaLimitError(state.model,[...state.media,...state.pendingMedia]):'';
    const eligible=isVideoType()?quoteEligible(key):!pendingQuotedSubmissions.has(key)&&Boolean(generationSnapshot());
    $('.send-button').disabled=!state.model||Boolean(error)||state.submitting||Object.values(activeFileBatches).some(Boolean)||state.pendingMedia.length>0||Boolean(state.relayMode&&(!eligible||state.batches?.some(batchIsActive)));
  }else if(key==='digital')dhSetHint(false);else depthSetHint(false);
}
const quoteController=createQuoteController({
  request:(snapshot,{checkBalance})=>requestOnce('/quotes',{method:'POST',json:{...snapshot.payload,...(checkBalance?{check_balance:true}:{})},headers:{'X-Hamster-Config-Revision':String(snapshot.revision)}}),
  isCurrent:quoteIsCurrent,
  onChange:(key,entry)=>{renderQuoteCard(key,entry);refreshQuoteAvailability(key);},
});
function updateSurfaceQuote(key){if(pendingQuotedSubmissions.has(key)){renderQuoteCard(key,quoteController.state(key));return;}const entry=quoteController.prepare(key,quoteSnapshot(key));renderQuoteCard(key,entry||{status:'empty',quote:null});refreshQuoteAvailability(key);}
function openGenerationRecharge(){
  switchView('account');
  const pay=$('#payLocalAccount');
  if(!$('#localAccountWallet')?.hidden&&!pay?.disabled)pay?.click();
}
function showInsufficientBalance(batch=false){
  const dialog=$('#generationBalanceDialog');
  if(!dialog||dialog.open)return;
  $('#generationBalanceMessage').textContent=batch?'余额不足，剩余份数已停止提交。请充值后按需发起生成。':state.type==='image'?'当前中转站余额不足。请充值后重新生成。':'当前余额不足以支付本次生成费用。请充值后重新生成。';
  dialog.showModal();
}
function showStoppedBalance(stopped,batch){
  if(stopped?.code!=='insufficient_balance')return false;
  if(!batch||batch.id!==notifiedBalanceBatch){
    notifiedBalanceBatch=batch?.id;
    showInsufficientBalance(batch?.quantity>1);
  }
  return true;
}
async function preparePaidSubmission(key,snapshot){
  if(!state.relayMode)return {};
  if(pendingQuotedSubmissions.has(key)){toast('上次提交结果待确认，请先核对历史记录，勿重复提交');return null;}
  if(!snapshot||!quoteIsCurrent(key,snapshot))return null;
  const entry=quoteController.update(key,snapshot,{immediate:true,force:true,checkBalance:true});
  const quote=await entry.pending;
  if(!quoteIsCurrent(key,snapshot))return null;
  if(entry.insufficientBalance){showInsufficientBalance();return null;}
  if(!preparedQuoteCurrent(key,snapshot,quote)){toast('暂时无法核算本次费用，请稍后重试');return null;}
  return quote;
}
function preparedQuoteCurrent(key,snapshot,quote){return !state.relayMode||quoteIsCurrent(key,snapshot)&&quoteValid(quote,{model:snapshot?.payload.model,quantity:snapshot?.payload.concurrency});}
function quoteSubmissionFailed(key,error,requestId){
  if(!state.relayMode)return false;
  if(error?.status===402&&error.code==='insufficient_balance'){quoteController.invalidate(key,'expired');showInsufficientBalance();return true;}
  if(['quote_expired','quote_changed','quote_parameters_changed','quote_invalid'].includes(error?.code)){
    quoteController.invalidate(key,'expired');toast('本次报价已失效，任务未继续提交。请重新点击生成。');return true;
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
    if(tasks.length&&!state.batches?.some(batch=>batchIsActive(batch)&&(batch.requestId===requestId||key==='generate'))&&tasks.every(task=>!['unknown','submitting'].includes(task.status))){pendingQuotedSubmissions.delete(key);quoteController.invalidate(key,'expired');}
  }
}
function resetSurfaceQuotes(){
  pendingQuotedSubmissions.clear();notifiedBalanceBatch=undefined;
  const dialog=$('#generationBalanceDialog');if(dialog?.open)dialog.close();
  quoteController.reset();
}

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
  return result;
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
async function loadModels(configReady = Promise.resolve(), {force=false,preserveSelection=false} = {}) {
  await Promise.resolve(configReady);
  const revision=relayConfigRevision;
  if(loadModels.pending?.revision===revision&&(!force||preserveSelection))return loadModels.pending.promise;
  const flight={revision,promise:null},catalogRevision=++modelLoadRevision;
  const current=()=>revision===relayConfigRevision&&catalogRevision===modelLoadRevision;
  flight.promise=(async()=>{
    if(state.relayMode&&!preserveSelection){state.toolChecking=hasRhKey();state.toolCatalogReady=false;state.toolConnection=null;state.toolStates={};dhSetHint();depthSetHint();}
    const cached=state.relayMode?null:readModelCache();
    if(state.relayMode)localStorage.removeItem(MODEL_CACHE_STORAGE);
    if(cached&&!preserveSelection){state.models=cached.models;pickDefaultModel();renderComposer();}
    const catalog=rows=>{if(!current())return [];state.toolModels=(rows||[]).filter(m=>m.provider==='tool');return mapUpstreamModels(rows);};
    let models=[];
    if(hasKey()||state.relayMode&&(hasVideoKey()||hasRhKey())) {
      try {
        const [response,connection]=await Promise.all([force?requestOnce('/models'):request('/models'),state.relayMode&&hasRhKey()&&!preserveSelection?request('/relay/connection').catch(()=>null):Promise.resolve(null)]);
        if(current()&&state.relayMode&&Number.isSafeInteger(state.relayServerRevision)&&Number.isSafeInteger(response?.revision)&&response.revision!==state.relayServerRevision){window.dispatchEvent(new Event('hamster-relay-configured'));return;}
        models=catalog(response?.data || []);
        if(current()&&state.relayMode){
          if(!preserveSelection)state.toolConnection=connection?.tool||null;
          state.toolStates=response?.toolStates||connection?.toolStates||{};
        }
      } catch {if(current()&&state.relayMode){state.toolModels=[];state.toolStates={};state.toolConnection=null;}}
    }
    if(!models.length&&!state.relayMode) {
      try { models=catalog((await request('/public-models'))?.data || []); } catch {}
    }
    if(!current())return;
    if(state.relayMode){state.toolChecking=false;state.toolCatalogReady=true;}
    if(models.length){state.models=models;if(!state.relayMode)writeModelCache(models);}
    else if(!cached)state.models=[];
    if(preserveSelection&&state.model)state.model=state.models.find(model=>model.id===state.model.id)||state.model;
    else if(state.relayMode&&state.models.length&&!modelsOfType().length)setType(videoModels().length?'video':'image');
    else pickDefaultModel();
    mediaLimitSignature='';renderComposer();
    dhSetHint();depthSetHint();
  })().finally(()=>{if(loadModels.pending===flight)loadModels.pending=null;});
  loadModels.pending=flight;return flight.promise;
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
  if(state.relayMode)for(const item of state.media){
    if(item.kind==='image'&&Boolean(item.direct)!==(type==='image')){
      item.direct=type==='image';item.expires_at=0;
    }
  }
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
  syncStorageStatusKind();
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
      ? `<span class="channel-icon"><img src="/hamster-mark.png" alt="" /></span><span class="channel-copy"><strong>${escapeHtml(it.label)}</strong><small>${escapeHtml(it.sub || '')}</small><span>${escapeHtml(it.meta || '')}</span></span>${it.selected ? '<i class="channel-check" data-lucide="check"></i>' : ''}`
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
    type: 'card', label: m.name, sub: m.type==='image'?'图片创作线路':state.relayMode?catalogPriceText(m,state.options):m.summary || '视频创作线路',
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
  const error = generationSelectionError() || (model ? mediaLimitError(model, all) : '');
  const fee=isVideoType()?pricingQuote(model,{...state.options,concurrency:state.concurrency,quote:quoteController.state('generate').quote}):null;
  const limits=modelMediaSummary(model);
  $('#mediaLimitHint').textContent = error || (state.relayMode||!fee?limits:fee.external?`${limits} · ${fee.text}`:fee.known?`${limits} · 本次预冻结 ¥${fee.total.toFixed(2)} · 成功交付后扣费`:model?.summary || (model ? '售价待确认，暂未开放扣费' : '请先配置账户并选择线路'));
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
  const declared=String(type||'').split(';')[0].trim().toLowerCase();
  const aliases={'audio/x-wav':'audio/wav','audio/wave':'audio/wav','audio/x-m4a':'audio/mp4','audio/x-aac':'audio/aac','image/jpg':'image/jpeg'};
  if (declared && declared!=='application/octet-stream') return aliases[declared]||declared;
  const ext = (name.split('.').pop() || '').toLowerCase();
  const map = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', aac: 'audio/aac' };
  return map[ext] || 'application/octet-stream';
}
function nextTag(kind) {
  state.tagCounters[kind] = (state.tagCounters[kind] || 0) + 1;
  return (KIND_LABEL[kind] || '素材') + state.tagCounters[kind];
}
const uploadReuse = new Map();
const mediaUploadGate = createUploadGate(() => [...state.media, ...state.pendingMedia]);
const mediaUploadQueue = createUploadQueue(2);
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
      if (xhr.status >= 200 && xhr.status < 300) return resolve(payload?.file&&{...payload.file,...mediaUploadMetadata(payload),...mediaUploadMetadata(payload.file)});
      const error = new Error(payload?.error || payload?.detail || `请求失败 (${xhr.status})`);
      error.status = xhr.status;
      error.code = payload?.code;
      reject(error);
    };
    xhr.onerror = () => reject(new Error('素材上传连接中断，请重试'));
    xhr.ontimeout = () => reject(new Error('素材上传超时，请检查网络后重试'));
    xhr.send(file);
  });
}
async function uploadFile(file, kind, direct = false, onProgress, fingerprint = '', use = '') {
  const revision=relayConfigRevision;
  const cacheKey = fingerprint ? `${state.relayMode&&use?use+':':''}${direct ? 'direct' : 'video'}:${fingerprint}` : '';
  let pending = cacheKey && uploadReuse.get(cacheKey);
  try {
    while(pending) {
      const reused=await pending;
      if(revision!==relayConfigRevision)throw Object.assign(new Error('连接配置已变更，请重新上传素材'),{status:409});
      if(!mediaExpiryError([reused],{required:state.relayMode})){onProgress?.(file.size,file.size);return reused;}
      if(uploadReuse.get(cacheKey)===pending)uploadReuse.delete(cacheKey);
      pending=cacheKey&&uploadReuse.get(cacheKey);
    }
    pending = uploadRequest(file, kind, direct, onProgress, use);
    if (cacheKey) uploadReuse.set(cacheKey, pending);
    const result=await pending;if(revision!==relayConfigRevision)throw Object.assign(new Error('连接配置已变更，请重新上传素材'),{status:409});return result;
  }
  catch (error) { if (cacheKey&&uploadReuse.get(cacheKey)===pending) uploadReuse.delete(cacheKey); throw error; }
}
let activeView='account',storageStatusMode=null,storageModePending=null;
function renderStorageStatus(value) {
  const status = $('#storageStatus');
  if (!status) return;
  const view=storageStatusView(value);
  status.dataset.state=view.state;
  status.classList.toggle('is-connected',view.state==='ready');
  status.classList.toggle('is-disconnected',view.state==='failed');
  status.classList.toggle('is-pending',view.state==='pending');
  status.classList.toggle('is-checking',view.state==='checking');
  status.setAttribute('aria-label',view.label);
  status.setAttribute('aria-busy',String(view.checking));
  status.title=view.label;
  status.disabled=view.checking||!value?.kind;
  if(startupHydrated&&state.relayMode&&activeView!=='account'&&['unauthorized','forbidden','account_mismatch'].includes(value?.state))switchView('account',{remember:false});
}
const storageStatusController=createStorageStatusController({
  request:async(kind,{signal})=>{
    const response=await fetch('/api/uploads/status'+(kind==='legacy'?'':'?kind='+kind),{cache:'no-store',signal});
    let payload;try{payload=await response.json();}catch{payload={};}
    const header=response.headers.get('Retry-After');
    const headerDelay=header==null?0:/^\d+(?:\.\d+)?$/.test(header)?Number(header)*1000:Math.max(0,Date.parse(header)-Date.now());
    const retry=Number.isSafeInteger(payload?.retryAfterMs)?payload.retryAfterMs:Number.isFinite(headerDelay)?Math.ceil(headerDelay):0;
    return {...payload,httpStatus:response.status,retryAfterMs:Math.min(3600000,Math.max(0,retry))};
  },
  onChange:renderStorageStatus,
});
function currentStorageKind(){return storageStatusMode==='legacy'?'legacy':storageStatusKind(activeView,state.type);}
function syncStorageStatusKind(){
  if(!startupHydrated)return;
  if(!storageStatusMode){renderStorageStatus({kind:storageStatusKind(activeView,state.type),state:'idle'});return;}
  void storageStatusController.select(currentStorageKind());
}
function resetStorageStatus(){storageStatusMode=null;storageModePending=null;storageStatusController.reset();syncStorageStatusKind();}
async function checkStorageStatus(options={}){
  if(!storageStatusMode){
    const revision=relayConfigRevision;
    if(!storageModePending){
      const pending=Promise.resolve().then(async()=>{
        try{
          const response=await fetch('/api/config',{cache:'no-store',signal:AbortSignal.timeout(25000)});
          if(!response.ok)throw Error('storage_configuration_unavailable');
          const config=await response.json();
          if(typeof config?.relayMode!=='boolean')throw Error('storage_configuration_unavailable');
          if(revision!==relayConfigRevision)return;
          storageStatusMode=config.relayMode?'relay':'legacy';
        }catch{if(revision===relayConfigRevision)renderStorageStatus({kind:storageStatusKind(activeView,state.type),state:'pending'});}
        finally{if(revision===relayConfigRevision&&storageModePending===pending)storageModePending=null;}
      });
      storageModePending=pending;
    }
    await storageModePending;if(revision!==relayConfigRevision||!storageStatusMode)return;
  }
  const kind=currentStorageKind();
  if(storageStatusController.snapshot().kind!==kind)return storageStatusController.select(kind);
  return storageStatusController.check(options);
}
async function handleFiles(files, kind) {
  const revision=relayConfigRevision;
  if (!hasGenerationKey()) { toast(accountHint()); return; }
  const tile = $(`.media-tile[data-kind="${kind}"]`);
  const accepted = [];
  const selectedType = state.type, selectedModel = state.model?.id;
  const directUpload = selectedType === 'image';
  const current = () => revision===relayConfigRevision && selectedType===state.type && selectedModel===state.model?.id;
  let completed = false;
  activeFileBatches[kind]++;
  renderMediaLimits();
  tile?.classList.remove('is-complete');
  tile?.classList.add('is-uploading');
  try {
    for (const file of files) {
      if (!current()) break;
      if (kindForFile(file) !== kind) { toast('文件类型与素材类型不匹配'); continue; }
      if (!file.size || file.size > 50 * 1024 * 1024) { toast('请选择非空且 50MB 以内的素材'); continue; }
      let release;
      let queued = false;
      try {
        const fingerprint = await fileFingerprint(file);
        if(!current())break;
        release = mediaUploadGate.claim(kind, fingerprint);
        if (!release) { toast('该素材已添加或正在上传，无需重复上传'); continue; }
        const limitError = mediaLimitError(state.model, [...state.media, ...state.pendingMedia, { kind }]);
        if (limitError) { toast(limitError); continue; }
        const pending = { kind, file, name:file.name, local:URL.createObjectURL(file), fingerprint, startedAt:0, loaded:0, total:file.size, uiKey:crypto.randomUUID(), release };
        accepted.push(pending);
        state.pendingMedia.push(pending);
        queued = true;
        renderMedia();
        // Start each prepared file immediately; all batches share two upload slots.
        pending.transfer = mediaUploadQueue(async () => {
          if (!current()) return {};
          const limitError = mediaLimitError(state.model, [...state.media, ...state.pendingMedia]);
          if (limitError) throw new Error(limitError);
          pending.startedAt=performance.now();
          const uploaded=await uploadFile(pending.file, kind, directUpload, (loaded,total)=>{
            if(!current())return;
            pending.loaded=loaded;pending.total=total || pending.file.size;
            queueMediaProgress(pending);
          }, pending.fingerprint, directUpload?'':'video');
          return {uploaded};
        }).catch(error => ({error}));
      } catch (error) {
        if(current())handleError(error);
      } finally {
        if (!queued) release?.();
      }
    }
    for (const pending of accepted) {
      let retained = false;
      try {
        const {uploaded,error}=await pending.transfer;
        if (!current()) continue;
        if (error) throw error;
        if (!uploaded?.url) throw new Error('上传未返回有效素材地址，请重试');
        state.media.push({ kind, url: uploaded.url, ...mediaUploadMetadata(uploaded), file:pending.file, key: uploaded.key || '', name: pending.name, local: pending.local, fingerprint:pending.fingerprint, direct:directUpload, tag: nextTag(kind), uiKey:pending.uiKey });
        retained = true;
        completed = true;
      } catch (e) {
        if(current())handleError(e);
      }
      finally {
        state.pendingMedia = state.pendingMedia.filter(item => item.uiKey !== pending.uiKey);
        pending.release();
        if (!retained) URL.revokeObjectURL(pending.local);
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
function addMediaByUrl(url, kind, metadata={}) {
  if (!url) { toast('请输入 URL'); return; }
  const error = mediaLimitError(state.model, [...state.media, ...state.pendingMedia, { kind }]);
  if (error) { toast(error); return; }
  state.media.push({ kind, url, ...mediaUploadMetadata(metadata), ...(metadata.assetId?{assetId:metadata.assetId,direct:Boolean(metadata.direct)}:{}), name: metadata.name||url, local: metadata.local||null, tag: nextTag(kind), uiKey:crypto.randomUUID() });
  renderMedia();
}
function removeMedia(key) {
  const idx = state.media.findIndex(item => item.uiKey === key);
  if (idx < 0) return;
  const [removed] = state.media.splice(idx, 1);
  if (removed?.local) URL.revokeObjectURL(removed.local);
  const cacheKey=removed?.fingerprint?`${removed.direct?'direct':'video'}:${removed.fingerprint}`:'';
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
const pendingMediaCards = new Map(), dirtyMediaProgress = new Map();
let mediaProgressFrame = null, mediaMentionSignature = '', generationMaterialPreview = null;
function generationMaterialName(item) {
  const name=typeof item?.name==='string'?item.name.trim():'';
  if(name&&!/^(?:[a-z][a-z0-9+.-]*:|[\\/])/i.test(name))return name;
  return item?.tag || `${KIND_LABEL[item?.kind] || '参考'}素材`;
}
function updateMediaProgress(card, item) {
  const total=Math.max(1,Number(item.total)||Number(item.file?.size)||1);
  const loaded=Math.min(total,Math.max(0,Number(item.loaded)||0));
  const percent=Math.round(loaded/total*100);
  const elapsed=Math.max(.001,(performance.now()-(item.startedAt || performance.now()))/1000),rate=loaded/elapsed;
  const speed=rate>=1024*1024?`${(rate/1024/1024).toFixed(1)}MB/s`:rate>=1024?`${(rate/1024).toFixed(0)}KB/s`:'';
  const eta=rate>0&&loaded<total?` · 约${Math.max(1,Math.ceil((total-loaded)/rate))}秒`:'';
  const detail=loaded>=total?'服务确认中':`${percent}%${speed?' · '+speed:''}${eta}`;
  const label=`${generationMaterialName(item)}正在上传 ${percent}%`;
  const text=card.querySelector('[data-upload-progress]');
  if(text.textContent!==detail){text.textContent=detail;text.title=detail;}
  if(card.getAttribute('aria-label')!==label)card.setAttribute('aria-label',label);
}
function queueMediaProgress(item) {
  dirtyMediaProgress.set(item.uiKey,item);
  if(mediaProgressFrame!==null||activeView!=='generate'||document.visibilityState==='hidden')return;
  mediaProgressFrame=requestAnimationFrame(()=>{
    mediaProgressFrame=null;
    if(activeView!=='generate'||document.visibilityState==='hidden')return;
    for(const [key,pending] of dirtyMediaProgress){
      const card=pendingMediaCards.get(key);
      if(card)updateMediaProgress(card,pending);
    }
    dirtyMediaProgress.clear();
  });
}
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
  for (const [key, card] of existing) if (!wanted.has(key)) {
    pendingMediaCards.delete(key);dirtyMediaProgress.delete(key);card.remove();
  }
  entries.forEach(({item:m,pending},index) => {
    const name=escapeHtml(generationMaterialName(m));
    const source=m.local || m.url || '';
    const kindLabel=KIND_LABEL[m.kind] || '素材';
    const cover=m.kind==='image'?`<img src="${escapeHtml(source)}" loading="lazy" decoding="async" alt="" />`:`<span class="chip-kind" aria-hidden="true">${m.kind==='video'?'▷':'♫'}</span><span class="media-kind-label">${escapeHtml(kindLabel)}</span>`;
    const thumb=source?`<button type="button" class="media-thumbnail${m.kind==='image'?'':' media-kind-placeholder'}" data-material-preview aria-label="预览${kindLabel}：${name}" title="预览${kindLabel}">${cover}</button>`:`<div class="media-thumbnail media-kind-placeholder" aria-hidden="true"><span class="chip-kind">${m.kind==='video'?'🎞':m.kind==='audio'?'🎵':'▧'}</span><span class="media-kind-label">${escapeHtml(kindLabel)}</span></div>`;
    let html;
    if (pending) {
      html=`<div class="media-chip pending" data-media-key="${m.uiKey}">${thumb}<span class="media-name" title="${name}">${name}</span><span class="media-uploading"><i></i><span data-upload-progress></span></span></div>`;
    } else {
      const label=m.authorizationInvalid?`${name} · 请重新上传`:name;
      html=`<div class="media-chip${m.authorizationInvalid?' is-invalid':''}" data-media-key="${m.uiKey}">${thumb}<span class="media-name" title="${label}">${label}</span><button type="button" class="media-tag" data-tag="${escapeHtml(m.tag)}" title="引用 @${escapeHtml(m.tag)} 到提示词" aria-label="引用 @${escapeHtml(m.tag)} 到提示词">@</button><button type="button" class="rm" data-remove-media="${m.uiKey}" title="移除此素材" aria-label="移除素材：${name}">×</button></div>`;
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
    if(pending){pendingMediaCards.set(m.uiKey,card);updateMediaProgress(card,m);}
    else {pendingMediaCards.delete(m.uiKey);dirtyMediaProgress.delete(m.uiKey);}
    if(list.children[index]!==card)list.insertBefore(card,list.children[index]||null);
  });
  list.hidden = !entries.length;
  generationMaterialPreview?.refresh();
  renderMediaLimits();
  const mentionSignature=state.media.map(item=>`${item.uiKey}:${item.tag}:${item.name}`).join('|');
  if(mentionSignature!==mediaMentionSignature){mediaMentionSignature=mentionSignature;updateMentionMenu();}
}
function generationMaterialPreviewEntry(button) {
  const key=button.closest('[data-media-key]')?.dataset.mediaKey;
  const item=state.media.find(item=>item.uiKey===key) || state.pendingMedia.find(item=>item.uiKey===key);
  if(!['image','video','audio'].includes(item?.kind))return null;
  const src=item.local || item.url;
  return src?{src,name:generationMaterialName(item),kind:item.kind}:null;
}
function bindGenerationMedia() {
  const list=$('#mediaList');
  generationMaterialPreview=mountMaterialPreview(list,{resolve:generationMaterialPreviewEntry,selector:'[data-material-preview]'});
  list.addEventListener('click',event=>{
    const remove=event.target.closest('[data-remove-media]');
    if(remove){removeMedia(remove.dataset.removeMedia);return;}
    const tag=event.target.closest('.media-tag');if(tag)insertMention(tag.dataset.tag);
  });
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
function updateMentionMenu(event) {
  if (event?.isComposing || composingPrompt) return;
  const menu = $('#mentionMenu');
  const context = mentionContext();
  if (!context || !state.media.length) { closeMentionMenu(); return; }
  const matches = state.media.filter((m) => !context.query || m.tag.toLowerCase().includes(context.query) || m.name.toLowerCase().includes(context.query));
  if (!matches.length) { closeMentionMenu(); return; }
  mentionStart = context.start;
  mentionIndex = Math.min(mentionIndex, matches.length - 1);
  menu.innerHTML = `<div class="mention-title">引用素材</div>${matches.map((m, i) => `<button type="button" class="mention-option${i === mentionIndex ? ' active' : ''}" data-tag="${escapeHtml(m.tag)}"><span class="mention-kind"><i data-lucide="${m.kind === 'image' ? 'image' : m.kind === 'video' ? 'video' : 'audio-lines'}"></i></span><span><strong>@${escapeHtml(m.tag)}</strong><small>${escapeHtml(generationMaterialName(m))}</small></span><kbd>↵</kbd></button>`).join('')}`;
  menu.hidden = false;
  $('#prompt').setAttribute('aria-expanded', 'true');
  menu.querySelectorAll('.mention-option').forEach((b) => b.addEventListener('mousedown', (e) => {
    e.preventDefault();
    insertMention(b.dataset.tag, mentionStart, $('#prompt').selectionStart);
  }));
  refreshIcons(menu);
}
let composingPrompt=false;
function onPromptKeydown(e) {
  if (e.isComposing || composingPrompt || e.keyCode===229) return;
  const menu = $('#mentionMenu');
  if (menu.hidden) return;
  const options = $$('.mention-option');
  if (e.key === 'Escape') { e.preventDefault(); closeMentionMenu(); return; }
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    options[mentionIndex]?.classList.remove('active');
    mentionIndex = (mentionIndex + (e.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length;
    options[mentionIndex]?.classList.add('active');
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
  for (const m of state.media) out[m.kind].push({ tag: m.tag, url: m.url, ...mediaUploadMetadata(m) });
  return out;
}
async function refreshGenerationMedia(revision) {
  const items=[...state.media],modelId=state.model?.id,modelRevision=modelLoadRevision;
  const current=()=>revision===relayConfigRevision&&modelRevision===modelLoadRevision&&modelId===state.model?.id
    &&state.pendingMedia.length===0&&!Object.values(activeFileBatches).some(Boolean)
    &&items.length===state.media.length&&items.every((item,index)=>item===state.media[index]&&!item.authorizationInvalid);
  return refreshMediaReferences(items,{required:state.relayMode,current,upload:async item=>{
    if(item.file)return uploadFile(item.file,item.kind,Boolean(item.direct),undefined,item.fingerprint||'',item.direct?'':'video');
    if(item.assetId){
      const route=item.direct?'/upload-direct':'/upload?use=video';
      return assetsRequest('/api/assets',`/${item.assetId}${route}`,{method:'POST',headers:state.relayMode&&Number.isSafeInteger(state.relayServerRevision)?{'X-Hamster-Config-Revision':String(state.relayServerRevision)}:{}});
    }
    throw Object.assign(new Error('参考素材已过期或即将到期，请重新上传'),{code:'media_reference_expired'});
  }});
}
async function onSubmit(e) {
  e.preventDefault();
  const revision=relayConfigRevision;
  if(state.submitting)return;
  if(pendingQuotedSubmissions.has('generate')){toast('提交结果仍待确认，请先核对历史记录，勿重复提交');return;}
  if(state.relayMode&&state.batches?.some(batchIsActive)){toast('原批次仍在提交中，可先停止剩余份数；已发送任务继续查询原结果');return;}
  if (!hasGenerationKey()) {
    toast(accountHint());
    return;
  }
  if (!state.model) { toast('请选择模型'); return; }
  const selectionError=generationSelectionError();
  if(selectionError){toast(selectionError);return;}
  if (state.pendingMedia.length) { toast('素材正在上传，请稍候'); return; }
  if(state.relayMode&&state.media.some(item=>item.authorizationInvalid)){toast('连接配置已变更，请移除并重新上传当前账户的参考素材');return;}
  const mediaError = mediaLimitError(state.model, state.media);
  if (mediaError) { toast(mediaError); return; }
  const prompt = $('#prompt').value.trim();
  if (!prompt) { toast('请输入提示词'); return; }
  state.submitting = true;
  renderMediaLimits();
  let requestStarted=false,requestId;
  try {
    const isVideoTask=isVideoType(),snapshot=generationSnapshot();
    const quote=isVideoTask?await preparePaidSubmission('generate',snapshot):null;
    if(state.relayMode&&(!snapshot||isVideoTask&&!quote)||revision!==relayConfigRevision||$('#prompt').value.trim()!==prompt)return;
    if(!await refreshGenerationMedia(revision))return;
    const generationCurrent=isVideoTask?preparedQuoteCurrent('generate',snapshot,quote):!state.relayMode||quoteFingerprint(snapshot)===quoteFingerprint(generationSnapshot());
    if(!generationCurrent||$('#prompt').value.trim()!==prompt){toast(isVideoTask?'参数或报价已变化，请重新点击生成':'生成参数已变化，请重新点击生成');return;}
    const media = groupMedia();
    const payload = isVideoTask
      ? buildVideoPayload({ model: state.model, prompt, ...state.options, concurrency: state.concurrency, images: media.image, videos: media.video, audios: media.audio })
      : buildImagePayload({ model: state.model, prompt, ...state.options, concurrency: state.concurrency, images: media.image });
    const path = state.type === 'official-video' ? '/official-videos' : isVideoTask ? '/videos' : '/images';
    requestId=crypto.randomUUID();
    const headers = {
      Prefer: 'respond-async',
      'Idempotency-Key': requestId,
      ...(state.type === 'official-video' && state.videoApiKey ? {'X-Hamster-Official-Key':state.videoApiKey} : {}),
    };
    const expiryError=mediaExpiryError(state.media,{required:state.relayMode});
    if(expiryError){toast(expiryError);return;}
    if(state.relayMode&&isVideoTask)payload.quote_id=quote.id;
    requestStarted=true;
    const created = await request(path, { method: 'POST', json: payload, headers });
    if(revision!==relayConfigRevision)return;
    if (!acceptLocalTask(created) && !extractTaskIds(created).length && !(created?.accepted&&created?.stopped)) throw new Error('提交结果待确认，请检查历史记录，勿重复提交');
    noteQuotedResult('generate',created,requestId);
    if(!showStoppedBalance(created?.stopped??created?.batch?.stopped,created?.batch))toast(submissionMessage(created));
    if(!created?.stopped&&!pendingQuotedSubmissions.has('generate')){$('#prompt').value = '';releaseSubmittedMedia();}
    renderAllTasks();
  } catch (err) { if(revision===relayConfigRevision&&!(requestStarted&&quoteSubmissionFailed('generate',err,requestId)))handleError(err); }
  finally { if(revision===relayConfigRevision){state.submitting = false; renderMediaLimits(); syncTasks();} }
}
let syncingBatches=false,batchControlsSignature='';
const stoppingBatches=new Set();
function renderBatchControls(){
  const panel=$('#relayBatchControls');if(!panel)return;
  const batches=(state.batches||[]).filter(batchIsActive),signature=JSON.stringify([batches,[...stoppingBatches]]);
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
    const requestId=pendingQuotedSubmissions.get('generate');
    const stopped=requestId&&result.batches.find(batch=>batch.requestId===requestId&&batch.stopped?.code==='insufficient_balance');
    if(stopped)showStoppedBalance(stopped.stopped,stopped);
    state.batches=result.batches;renderBatchControls();settleQuotedSubmissions();refreshQuoteAvailability('generate');
  }catch{/* Keep the last durable batch view until its status can be read. */}
  finally{syncingBatches=false;if(typeof taskRefreshLoop!=='undefined')taskRefreshLoop?.schedule();}
}
async function stopRelayBatch(id){
  if(!/^[a-f0-9]{32}$/.test(id)||stoppingBatches.has(id))return;
  const revision=relayConfigRevision;stoppingBatches.add(id);renderBatchControls();
  try{const result=await request(`/relay/batches/${id}/stop`,{method:'POST'});if(revision!==relayConfigRevision)return;
    if(!result?.batch)throw Error('停止结果暂未确认，请查询原批次');
    state.batches=(state.batches||[]).map(batch=>batch.id===id?result.batch:batch);
    const message=batchProgressText(result.batch);if(message)toast(message);await syncTasks();
  }catch(error){if(revision===relayConfigRevision)toast('停止结果暂未确认，请重新查询原批次，勿再次生成');}
  finally{stoppingBatches.delete(id);if(revision===relayConfigRevision){renderBatchControls();refreshQuoteAvailability('generate');}}
}
// The UI reads the local journal; the local service alone polls upstream IDs.
let syncingTasks = false, taskRefreshLoop = null, lastTaskRead=0;
const taskViews = new Set(['generate','digital','depth','history']);
function tasksNeedFrequentRefresh() {
  return Boolean(state.submitting || state.dh?.submitting || state.depth?.submitting || pendingQuotedSubmissions.size
    || state.batches?.some(batchIsActive)
    || state.tasks.some(task => ['submitting','unknown','queued','processing'].includes(task.status)
      || task.status === 'succeeded' && !task.result?.local_url && !task.result?.text));
}
function startTaskRefreshLoop({refresh,active,enabled=()=>true,document=globalThis.document,window=globalThis.window,setTimer=setTimeout,clearTimer=clearTimeout}) {
  let timer = null, pending = null, stopped = false, pageSuspended = false;
  const canRefresh = () => !stopped && !pageSuspended && document.visibilityState === 'visible' && (enabled() || active());
  const clear = () => { if (timer !== null) clearTimer(timer); timer = null; };
  const schedule = () => {
    clear();
    if (canRefresh()) timer = setTimer(tick, active() ? 3000 : 15000);
  };
  const tick = () => {
    if (!canRefresh()) return pending;
    clear();
    if (pending) return pending;
    pending = Promise.resolve().then(refresh).catch(() => {}).finally(() => { pending = null; schedule(); });
    return pending;
  };
  const resume = () => { if (document.visibilityState === 'visible') void tick(); else clear(); };
  const onPageHide = event => { if (event.persisted) { pageSuspended = true; clear(); } else stop(); };
  const onPageShow = event => { if (event.persisted && pageSuspended) { pageSuspended = false; resume(); } };
  const stop = () => {
    if (stopped) return;
    stopped = true; clear();
    document.removeEventListener('visibilitychange', resume);
    window.removeEventListener('online', resume);
    window.removeEventListener('pagehide', onPageHide);
    window.removeEventListener('pageshow', onPageShow);
  };
  document.addEventListener('visibilitychange', resume);
  window.addEventListener('online', resume);
  window.addEventListener('pagehide', onPageHide);
  window.addEventListener('pageshow', onPageShow);
  schedule();
  return {schedule, tick, stop, updateVisibility(){if(!canRefresh())clear();else if(timer===null&&!pending)schedule();}};
}
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
    lastTaskRead=Date.now();
    settleQuotedSubmissions();
    renderAllTasks();
    $('#taskPersistenceNote').textContent = data.warnings?.length ? data.warnings.join('；') : '';
    $('#taskPersistenceNote').hidden = !data.warnings?.length;
  } catch {
    if(revision!==relayConfigRevision)return;
    $('#taskPersistenceNote').hidden = false;
    $('#taskPersistenceNote').textContent = '暂时无法更新任务进度，正在重试…';
  } finally { syncingTasks = false; taskRefreshLoop?.schedule(); }
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
  taskRefreshLoop?.stop();
  taskRefreshLoop = startTaskRefreshLoop({refresh: syncTasks, active: tasksNeedFrequentRefresh, enabled:()=>taskViews.has(activeView)});
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
  return '<div class="task-progress"><span></span></div>';
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
  if (!download && !retry && !saveAsset && !copyPrompt) return '';
  return `<div class="task-card-actions">${copyPrompt}${download}${saveAsset}${retry}</div>`;
}
function taskPreviewEntry(task) {
  if(task?.status!=='succeeded'||taskIsText(task))return null;
  const kind=task.type==='image'?'image':'video';
  const src=safeMaterialPreviewUrl(task.result?.local_url || (kind==='video'?task.result?.video_url:task.result?.image_url) || task.result?.download_url);
  return src?{src,kind,name:kind==='video'?'视频作品':'图片作品'}:null;
}
function taskResultPreviewEntry(button) {
  const key=button.closest('[data-task-key]')?.dataset.taskKey;
  const task=state.tasks.find(item=>(item.key || item.id)===key);
  return taskPreviewEntry(task);
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
  const preview = taskPreviewEntry(t);
  if (preview) {
    const media = preview.kind === 'video'
      ? `<video src="${escapeHtml(preview.src)}" preload="none" muted playsinline aria-hidden="true"></video><span class="task-video-play" aria-hidden="true">▷</span>`
      : `<img src="${escapeHtml(preview.src)}" loading="lazy" decoding="async" fetchpriority="low" alt="生成结果" />`;
    return `<button type="button" class="task-media-frame task-media-preview" data-preview-result aria-label="预览${preview.name}" title="悬停预览，点击放大">${media}<span class="task-preview-button" aria-hidden="true"><i data-lucide="maximize-2"></i></span></button>`;
  }
  const failed = t.status === 'failed';
  return `<div class="task-media-frame task-media-placeholder ${failed ? 'is-failed' : ''}"><span class="task-placeholder-icon"><i data-lucide="${failed ? 'triangle-alert' : 'sparkles'}"></i></span><strong>${failed ? '生成未完成' : t.status==='succeeded'?'正在准备本地预览':'正在准备作品'}</strong><small>${failed ? '查看下方原因后可重新尝试' : t.status==='succeeded'?(t.key&&t.id&&!t.result?.local_url?'可点击重新获取，查询原作品文件':'本地文件就绪后可预览'):(STATUS_LABEL[t.status] || '任务处理中')}</small>${taskProgressHtml(t)}</div>`;
}
function taskModelLabel(task) {
  if(task.relay&&task.modelName)return task.modelName;
  const special = { digital: '仓鼠数字人', depth: '仓鼠深度视频', reverse: '仓鼠视频反推' };
  if (special[task.source]) return special[task.source];
  if(task.modelName?.includes('深度视频'))return '仓鼠深度视频';
  for (const label of ['数字人', '视频反推']) if (task.modelName?.includes(label)) return `仓鼠${label}`;
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
function updateMoreButton(container, selector, count, loadMore) {
  let button=container.querySelector(`[${selector}]`);
  if(!count){button?.remove();return;}
  if(!button){
    button=document.createElement('button');button.type='button';button.className='plain-button subtle history-more';
    button.setAttribute(selector,'');button.addEventListener('click',loadMore);container.append(button);
  }
  const text=`显示更多（剩余 ${count} 条）`;
  if(button.textContent!==text)button.textContent=text;
}
function renderTasksFor(source, container) {
  if (!container) return;
  const list = state.tasks.filter((t) => (t.source || 'generate') === source);
  const limit = taskFeedLimits[source] || HISTORY_BATCH_SIZE;
  const visible = list.slice(0,limit);
  patchTaskCards(container,visible);
  updateMoreButton(container,'data-task-more',list.length-visible.length,()=>{
    taskFeedLimits[source]+=HISTORY_BATCH_SIZE;renderTasksFor(source,container);
  });
}
const taskDisplayFields=['id','key','source','type','provider','relay','modelId','modelName','status','error','poll_error','prompt','createdAt'];
const resultDisplayFields=['text','local_url','local_path','image_url','video_url','download_url','saving','save_error'];
function sameTaskDisplay(before, after) {
  return before && taskDisplayFields.every(key=>before[key]===after[key])
    && resultDisplayFields.every(key=>before.result?.[key]===after.result?.[key])
    && Boolean(before.result)===Boolean(after.result);
}
function updateTaskCard(card, template) {
  const oldParts=card?._taskParts;
  const parts=new Map([...template.children].map(part=>{
    const name=part.classList.item(0),markup=part.outerHTML,previous=oldParts?.get(name);
    return [name,previous?.markup===markup?previous:{markup,element:part}];
  }));
  if(!card){
    card=template;refreshIcons(card);bindResultCopy(card);
  }else{
    card.className=template.className;
    for(const [name,part] of oldParts)if(!parts.has(name))part.element.remove();
    let position=0;
    for(const [name,part] of parts){
      const previous=oldParts.get(name);
      if(part!==previous){
        previous?.element.remove();refreshIcons(part.element);bindResultCopy(part.element);
      }
      if(card.children[position]!==part.element)card.insertBefore(part.element,card.children[position]||null);
      position++;
    }
  }
  card._taskParts=parts;
  return card;
}
function patchTaskCards(container,list) {
  if(!container._taskPreview)container._taskPreview=mountMaterialPreview(container,{resolve:taskResultPreviewEntry,selector:'[data-preview-result]'});
  const cards=[...container.querySelectorAll(':scope > .task-card')];
  const existing=new Map(cards.map(card=>[card.dataset.taskKey,card]));
  const wanted = new Set(list.map(t => t.key || t.id));
  for (const card of cards) if (!wanted.has(card.dataset.taskKey)) card.remove();
  list.forEach((task,index) => {
    const key = task.key || task.id;
    let card = existing.get(key);
    if (!sameTaskDisplay(card?._taskDisplay,task)) {
      const template=document.createElement('template');template.innerHTML=taskCardHtml(task);
      card=updateTaskCard(card,template.content.firstElementChild);
      card.dataset.taskKey=key;
      card._taskProgress=card.querySelector('.task-progress');
      card._taskPercent=null;
    }
    card._taskDisplay=task;
    const percent=Math.max(0,Math.min(100,Number(task.progress)||0));
    if(card._taskProgress&&card._taskPercent!==percent){
      card._taskProgress.setAttribute('aria-label',`任务进度 ${percent}%`);
      card._taskProgress.firstElementChild.style.transform=`scaleX(${Math.max(.03,percent/100)})`;
      card._taskPercent=percent;
    }
    if (container.children[index] !== card) container.insertBefore(card,container.children[index] || null);
  });
  container._taskPreview.refresh();
}
function renderTaskFeed() {
  renderTasksFor('generate', $('#taskFeed'));
  const empty=$('#studioResultsEmpty');
  if(empty)empty.hidden=state.tasks.some(task=>(task.source||'generate')==='generate');
}
function renderDhResults() { renderTasksFor('digital', $('#dhResults')); }
function renderDepthResults() { renderTasksFor('depth', $('#depthResults')); }
function renderAllTasks() {
  if(document.visibilityState==='hidden')return;
  if(activeView==='generate')renderTaskFeed();
  if(activeView==='digital')renderDhResults();
  if(activeView==='depth')renderDepthResults();
  if(activeView==='history')renderHistory();
}
function clearTaskCards() {
  for(const id of ['taskFeed','dhResults','depthResults','historyList']){
    const container=$(`#${id}`);container._taskPreview?.close();container.replaceChildren();
  }
}
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
}

let historyFilter = 'all';
let historyLimit = HISTORY_BATCH_SIZE;
function renderHistory() {
  const history = state.tasks;
  const filtered = history.filter((h) => historyFilter === 'all' || h.type === historyFilter);
  const el = $('#historyList');
  let empty=el.querySelector('.empty-hint');
  if(!filtered.length){
    if(!empty){empty=document.createElement('div');empty.className='empty-hint';el.append(empty);}
    const message=history.length?'该分类暂无记录':'暂无历史记录';
    if(empty.textContent!==message)empty.textContent=message;
  }else empty?.remove();
  const visible=filtered.slice(0,historyLimit);
  patchTaskCards(el,visible);
  updateMoreButton(el,'data-history-more',filtered.length-visible.length,()=>{historyLimit+=HISTORY_BATCH_SIZE;renderHistory();});
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
  btn.disabled = state.relayMode&&!quoteEligible('digital');
  hint.textContent = `${state.relayMode?'素材已就绪，请核对报价':feeText+' · 已就绪'}${Number.isFinite(audio.duration) ? ` · 音频 ${audio.duration.toFixed(1)} 秒` : ''}`;
}
function renderDhSlots() {
  const { image, audio } = state.dh;
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
    const uploaded = await rhUpload(file);
    if(revision!==relayConfigRevision||version!==toolUploadVersions.image)return;
    if(state.dh.image?.local)URL.revokeObjectURL(state.dh.image.local);
    state.dh.image = { fileName:uploaded.url, ...mediaUploadMetadata(uploaded), name: file.name, local: URL.createObjectURL(file) };
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
    const uploaded = await rhUpload(file);
    if(revision!==relayConfigRevision||version!==toolUploadVersions.audio)return;
    state.dh.audio = { fileName:uploaded.url, ...mediaUploadMetadata(uploaded), name: file.name, duration: uploaded.durationSeconds || dur };
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
    return {revision,version,value:{fileName:uploaded.url,...mediaUploadMetadata(uploaded),name:item.name,local,duration:uploaded.durationSeconds || duration}};
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
  const expiryError=mediaExpiryError([image,audio],{required:state.relayMode});
  if(expiryError){toast(expiryError);return;}
  const btn = $('#dhSubmit');
  const snapshot=quoteSnapshot('digital'),requestId=crypto.randomUUID();
  state.dh.submitting=true;
  btn.disabled = true;
  let requestStarted=false;
  try {
    const quote=await preparePaidSubmission('digital',snapshot);
    if(!quote||revision!==relayConfigRevision)return;
    if(!preparedQuoteCurrent('digital',snapshot,quote)){toast('参数或报价已变化，请重新点击生成');return;}
    const expiryError=mediaExpiryError([image,audio],{required:state.relayMode});
    if(expiryError){toast(expiryError);return;}
    requestStarted=true;
    const created = await request('/tools/digital', {method:'POST',headers:{'Idempotency-Key':requestId},json:{model:'tool-digital',price_version:model.price_version,...(state.relayMode?{quote_id:quote.id}:{}),prompt:'数字人视频',images:[{url:image.fileName}],audios:[{url:audio.fileName,durationSeconds:audio.duration}],concurrency:1}});
    if(revision!==relayConfigRevision)return;
    if (created?.errorCode) throw new Error(created.errorMessage || created.errorCode);
    if (!acceptLocalTask(created) && !created?.taskId && !(created?.accepted&&created?.stopped)) throw new Error('提交结果待确认，请检查历史记录，勿重复提交');
    noteQuotedResult('digital',created,requestId);if(!showStoppedBalance(created?.stopped,created?.batch))toast(submissionMessage(created));
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
  btn.disabled = state.relayMode&&!quoteEligible('depth');
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
    const uploaded = await rhUpload(file);
    if(revision!==relayConfigRevision||version!==toolUploadVersions.video)return;
    if(state.depth.video?.local)URL.revokeObjectURL(state.depth.video.local);
    state.depth.video = { fileName:uploaded.url, ...mediaUploadMetadata(uploaded), name: file.name, local: URL.createObjectURL(file) };
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
  const expiryError=mediaExpiryError([video],{required:state.relayMode});
  if(expiryError){toast(expiryError);return;}
  const btn = $('#depthSubmit');
  const snapshot=quoteSnapshot('depth'),requestId=crypto.randomUUID();
  state.depth.submitting=true;
  btn.disabled = true;
  let requestStarted=false;
  try {
    const quote=await preparePaidSubmission('depth',snapshot);
    if(!quote||revision!==relayConfigRevision)return;
    if(!preparedQuoteCurrent('depth',snapshot,quote)){toast('参数或报价已变化，请重新点击生成');return;}
    const expiryError=mediaExpiryError([video],{required:state.relayMode});
    if(expiryError){toast(expiryError);return;}
    requestStarted=true;
    const created = await request('/tools/depth', {method:'POST',headers:{'Idempotency-Key':requestId},json:{model:'tool-depth',price_version:model.price_version,...(state.relayMode?{quote_id:quote.id}:{}),prompt:'黑白深度视频',videos:[{url:video.fileName}],concurrency:1}});
    if(revision!==relayConfigRevision)return;
    if (created?.errorCode) throw new Error(created.errorMessage || created.errorCode);
    if (!acceptLocalTask(created) && !created?.taskId && !(created?.accepted&&created?.stopped)) throw new Error('提交结果待确认，请检查历史记录，勿重复提交');
    noteQuotedResult('depth',created,requestId);if(!showStoppedBalance(created?.stopped,created?.batch))toast(submissionMessage(created));
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
  if(state.relayMode){s.textContent=rhHasKey()?'已配置工具 Key；工具能否使用取决于 PIKNO 已开放线路':'请到「个人中心」配置 PIKNO 工具 Key';s.className='hint';}
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
let reverseWorkspace = null, reverseLoad = null;
async function openReverse() {
  if(!reverseWorkspace){
    reverseLoad ||= import('./reverse.mjs').then(({mountReverse})=>{
      reverseWorkspace=mountReverse($('#reverseWorkspace'),{request,notify:toast});
      return reverseWorkspace;
    }).catch(()=>{reverseLoad=null;toast('反推界面未能加载，请重新打开');return null;});
    await reverseLoad;
  }
  if(activeView==='reverse')await reverseWorkspace?.setVisible(true);
}
async function useGenerationAsset(item) {
  if (selectingAsset) return;
  if (!hasGenerationKey()) { toast(accountHint()); return; }
  const revision=relayConfigRevision;
  const error = mediaLimitError(state.model, [...state.media, ...state.pendingMedia, {kind:item.kind}]);
  if (error) { toast(error); return; }
  selectingAsset = true;
  $('#assetTile').disabled = true;
  try {
    toast(state.type==='image'?'正在准备参考图片…':'正在上传选定资产…');
    let uploaded;
    const headers={...(state.apiKey?{Authorization:`Bearer ${state.apiKey}`} : {}),...(state.relayMode&&Number.isSafeInteger(state.relayServerRevision)?{'X-Hamster-Config-Revision':String(state.relayServerRevision)}:{})};
    if (state.type === 'image') {
      uploaded = await assetsRequest('/api/assets', `/${item.id}/upload-direct`, {method:'POST', headers});
    } else {
      uploaded = await assetsRequest('/api/assets', `/${item.id}/upload?use=video`, {method:'POST', headers});
    }
    if(revision!==relayConfigRevision)return;
    addMediaByUrl(uploaded.url, item.kind, {...uploaded,assetId:item.id,direct:state.type==='image',name:item.name,local:`/api/assets/${item.id}/file`});
    switchView('generate');
  } catch (e) { if(revision===relayConfigRevision)toast(e.message); }
  finally { selectingAsset = false; $('#assetTile').disabled = false; }
}
async function openGenerationAssets() {
  const item = await pickAsset({category:'talent'});
  if (item) await useGenerationAsset(item);
}
const visitedViews=new Set();
let viewFrame=null;
function syncWorkspaceVisibility() {
  const visible=document.visibilityState!=='hidden';
  chatWorkspace?.setVisible?.(visible&&activeView==='chat');
  canvasWorkspace?.setVisible?.(visible&&activeView==='canvas');
  assetsView?.setVisible(visible&&activeView==='assets');
  if(!visible||activeView!=='reverse')void reverseWorkspace?.setVisible(false);
}
function scheduleView() {
  if(viewFrame!==null)cancelAnimationFrame(viewFrame);
  const name=activeView, navigation=navigationEpoch;
  viewFrame=requestAnimationFrame(()=>{
    viewFrame=requestAnimationFrame(()=>{
      viewFrame=null;
      if(name!==activeView||navigation!==navigationEpoch||document.visibilityState==='hidden')return;
      if(name==='generate')for(const item of state.pendingMedia)queueMediaProgress(item);
      if(name==='assets'&&!assetsView)assetsView=assetLibrary($('#assetLibrary'),{onSelect:useGenerationAsset});
      if(name==='account'){renderAccount();renderRhStatus();}
      if(!visitedViews.has(name)){
        visitedViews.add(name);
        if(name==='digital')renderDhSlots();
        if(name==='depth')renderDepthSlot();
      }
      renderAllTasks();
      if(taskViews.has(name)&&Date.now()-lastTaskRead>=15000)void taskRefreshLoop?.tick();
      if(name==='chat')void openWorkbench();
      if(!startupHydrated)return;
      if(name==='reverse')void openReverse();
      if(name==='canvas')void openCanvas();
      if(needsMainCatalogue(name))void loadModels(Promise.resolve(),{preserveSelection:state.models.length>0});
      void catalogRefresh?.tick();
    });
  });
}
function switchView(name,{remember=true}={}) {
  const previous=activeView;
  if(previous!==name){
    if(previous==='canvas')invalidateAssetsCache();
    for(const media of $$(`[data-panel="${previous}"] video, [data-panel="${previous}"] audio`))if(!media.paused)media.pause();
  }
  activeView=name;
  if(remember){navigationEpoch++;if(startupHydrated)void viewPreferences.remember(name);}
  const title=$('#studioPageTitle');
  if(title)title.textContent=({generate:'生成',chat:'对话',digital:'数字人',assets:'达人资产',canvas:'创作画布',depth:'深度视频',reverse:'视频反推',history:'历史',account:'个人中心',hypit:'Hypit'})[name]||'工作台';
  $$('.view').forEach((v) => v.classList.toggle('active', v.dataset.panel === name));
  const tabs = $$('#browserTabs [role="tab"]');
  const inTabList = tabs.some(tab => tab.dataset.view === name);
  tabs.forEach((b) => {
    const current=b.dataset.view===name;
    b.classList.toggle('active',current);
    b.setAttribute('aria-selected',String(current));
    if(inTabList)b.tabIndex=current?0:-1;
    if(current)b.setAttribute('aria-current','page');else b.removeAttribute('aria-current');
    if(current)b.scrollIntoView?.({block:'nearest',inline:'nearest'});
  });
  $$('.workspace-link[data-view]').forEach(button => {
    if(button.dataset.view===name)button.setAttribute('aria-current','page');
    else button.removeAttribute('aria-current');
  });
  syncWorkspaceVisibility();
  syncStorageStatusKind();
  taskRefreshLoop?.updateVisibility();
  window.dispatchEvent(new CustomEvent('hamster-view-changed',{detail:{view:name}}));
  scheduleView();
}
async function validateStartupConnection(){
  const kind=startupCheckKind(startupConfig,activeView),revision=relayConfigRevision,navigation=navigationEpoch;
  if(!state.relayMode||activeView!=='chat'||kind!=='chat'||document.visibilityState==='hidden')return;
  const current=()=>revision===relayConfigRevision&&navigation===navigationEpoch&&activeView==='chat';
  try{
    const result=await request('/uploads/status?kind='+kind,{signal:AbortSignal.timeout(25000)});
    if(current()&&['unauthorized','forbidden','account_mismatch'].includes(result?.state))switchView('account',{remember:false});
  }catch(error){
    if(current()&&[401,403,409].includes(error?.status))switchView('account',{remember:false});
    // A timeout or cooldown leaves the local page usable. Paid actions still
    // use their original fresh authorization and never rely on this display.
  }
}
let chatWorkspace,canvasWorkspace;
async function openWorkbench() {
  if(!chatWorkspace)chatWorkspace=mountLocalWorkspace($('#chatWorkspace'),{kind:'chat',title:'仓鼠AI 对话',reconnectButton:$('#chatReconnect'),open:async()=>{
    const response=await fetch('/api/chat/open',{method:'POST',credentials:'same-origin'});
    const result=await response.json();
    if(!response.ok||result.status!=='ready'){
      if(typeof result.message==='string'&&activeView==='chat')toast(publicText(result.message));
      throw Error('chat_not_ready');
    }
    return result;
  }});
  chatWorkspace.setVisible?.(activeView==='chat'&&document.visibilityState!=='hidden');
  return chatWorkspace.open();
}
async function openCanvas() {
  if(!canvasWorkspace)canvasWorkspace=mountLocalWorkspace($('#canvasWorkspace'),{kind:'canvas',title:'仓鼠AI 创作画布',open:async()=>{
    const response=await fetch('/api/canvas/open',{method:'POST',credentials:'same-origin'});
    if(!response.ok)throw Error('canvas_open_failed');
    return response.json();
  }});
  canvasWorkspace.setVisible?.(activeView==='canvas'&&document.visibilityState!=='hidden');
  return canvasWorkspace.open();
}
function bindViewTabs() {
  const list=$('#browserTabs');
  if(!list)return;
  list.addEventListener('keydown',event=>{
    if(event.altKey||event.ctrlKey||event.metaKey||event.shiftKey)return;
    const target=event.target.closest('[role="tab"]');
    if(!target||target.parentElement!==list)return;
    const tabs=[...list.querySelectorAll('[role="tab"]')].filter(tab=>!tab.hidden&&!tab.disabled);
    const index=tabs.indexOf(target);
    if(index<0)return;
    let next;
    if(event.key==='ArrowRight')next=(index+1)%tabs.length;
    else if(event.key==='ArrowLeft')next=(index-1+tabs.length)%tabs.length;
    else if(event.key==='Home')next=0;
    else if(event.key==='End')next=tabs.length-1;
    else return;
    event.preventDefault();
    switchView(tabs[next].dataset.view);
    tabs[next].focus({preventScroll:true});
  });
}
function bindEvents() {
  bindViewTabs();
  $('#generationRecharge')?.addEventListener('click',()=>{
    $('#generationBalanceDialog').close();
    openGenerationRecharge();
  });
  window.addEventListener('message',event=>{
    if(activeView!=='canvas'||event.data?.type!=='hamster-generation-recharge')return;
    const frame=$('#canvasWorkspace')?.querySelector('.local-workspace-frame');
    if(!frame||event.source!==frame.contentWindow)return;
    const url=safeLocalWorkspaceUrl('canvas',frame.src);
    if(url&&event.origin===new URL(url).origin)openGenerationRecharge();
  });
  $('#studioHistoryShortcut')?.addEventListener('click',()=>switchView('history'));
  $('#storageStatus').addEventListener('click', () => void checkStorageStatus({manual:true}));
  $('#inferenceLogo').addEventListener('click',()=>{
    if($('#inferenceLogo').getAttribute('aria-busy')==='true')return;
    void inferenceIndicator.check({manual:true});
  });
  window.addEventListener('hamster-session-invalidated',()=>{accountSessionRejected=true;inflightGets.clear();resetSurfaceQuotes();inferenceIndicator.reset();reverseWorkspace?.reset();});
  window.addEventListener('hamster-onboarding-start',event=>{if(['image','video'].includes(event.detail?.kind))setType(event.detail.kind);});
  window.addEventListener('hamster-relay-catalog-refresh',()=>{if(state.relayMode&&document.visibilityState!=='hidden'&&needsMainCatalogue(activeView))void loadModels(Promise.resolve(),{force:true});});
  window.addEventListener('hamster-relay-configured',()=>{
    const revision=++relayConfigRevision;
    inflightGets.clear();
    reverseWorkspace?.reset();
    state.dh.submitting=false;state.depth.submitting=false;
    for(const kind of ['image','audio','video'])toolUploadVersions[kind]++;
    for(const item of [state.dh.image,state.dh.audio,state.depth.video])if(item)item.fileName='';
    for(const item of state.media)item.authorizationInvalid=true;
    for(const selector of ['#dhImageBox','#dhAudioBox','#depthVideoBox'])$(selector)?.classList.remove('is-uploading');
    state.submitting=false;
    state.models=[];state.toolModels=[];state.tasks=[];state.batches=[];state.model=null;lastTaskRead=0;
    state.toolChecking=false;state.toolCatalogReady=false;state.toolConnection=null;state.toolStates={};batchControlsSignature='';renderBatchControls();
    state.serverKeyConfigured=false;state.videoServerConfigured=false;state.rhServerConfigured=false;state.llmServerConfigured=false;
    accountSessionRejected=false;inflightGets.clear();uploadReuse.clear();inferenceIndicator.reset();
    resetSurfaceQuotes();mediaLimitSignature='';
    resetStorageStatus();
    renderComposer();renderRhStatus();clearTaskCards();renderAllTasks();
    void (async()=>{
      try {
        const d=await requestOnce('/config',{signal:AbortSignal.timeout(25000)});if(revision!==relayConfigRevision)return;
        state.relayMode=Boolean(d.relayMode);state.serverKeyConfigured=Boolean(d.configured);state.videoServerConfigured=Boolean(d.videoConfigured);
        state.rhServerConfigured=Boolean(d.toolConfigured??d.rhConfigured);state.llmServerConfigured=Boolean(d.llmConfigured);state.relayServerRevision=d.revision;
        startupConfig=d;
        storageStatusMode=d.relayMode?'relay':'legacy';syncStorageStatusKind();
        renderRhStatus();if(document.visibilityState!=='hidden'&&needsMainCatalogue(activeView))await loadModels();await syncTasks();
        if(revision===relayConfigRevision&&state.llmServerConfigured&&activeView==='chat')void inferenceIndicator.check();
      }catch {if(revision===relayConfigRevision){renderStorageStatus({kind:storageStatusKind(activeView,state.type),state:'pending'});toast('无法刷新连接配置，请重新打开应用');}}
    })();
  });
  window.addEventListener('offline',()=>inferenceIndicator.reset('error'));
  window.addEventListener('online',()=>{if(activeView==='chat')void inferenceIndicator.check();});
  $$('[data-quote-refresh]').forEach(button=>button.addEventListener('click',async()=>{
    const key=button.dataset.quoteRefresh;
    if(pendingQuotedSubmissions.has(key)){await syncTasks();if(pendingQuotedSubmissions.has(key)){toast('提交结果仍待确认，请先核对历史记录，勿重复提交');return;}}
    const snapshot=quoteSnapshot(key);if(snapshot)quoteController.update(key,snapshot,{immediate:true,force:true});
  }));
  $$('button[data-view]').forEach((b) => b.addEventListener('click', () => switchView(b.dataset.view)));
  $('[data-menu="type"]').addEventListener('click', (e) => typeMenu(e.currentTarget));
  $('[data-menu="model"]').addEventListener('click', (e) => modelMenu(e.currentTarget));
  $('[data-menu="reference"]').addEventListener('click', (e) => referenceMenu(e.currentTarget));
  $('[data-menu="ratio"]').addEventListener('click', (e) => ratioMenu(e.currentTarget));
  $('[data-menu="size"]').addEventListener('click', (e) => sizeMenu(e.currentTarget));
  $('[data-menu="quality"]').addEventListener('click', (e) => qualityMenu(e.currentTarget));
  $('[data-menu="duration"]').addEventListener('click', (e) => durationMenu(e.currentTarget));
  $('[data-menu="concurrency"]').addEventListener('click', (e) => concurrencyMenu(e.currentTarget));
  $('#prompt').addEventListener('input', updateMentionMenu);
  $('#prompt').addEventListener('compositionstart',()=>{composingPrompt=true;});
  $('#prompt').addEventListener('compositionend',()=>{composingPrompt=false;updateMentionMenu();});
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
  bindGenerationMedia();



  $('#dhImageFile').addEventListener('change', (e) => { dhPickImage(e.target.files[0]); e.target.value = ''; });
  $('#dhImageAsset').addEventListener('click',()=>void dhPickImageAsset());
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
  installInteractionHost({getFrames:()=>document.querySelectorAll('iframe')});
  mountInteractionSettings($('[data-panel="account"]'));
  state.apiKey = '';
  state.videoApiKey = '';
  state.rhApiKey = '';
  localStorage.removeItem('hamster_llm_api_key');



  bindEvents();
  window.addEventListener('online',()=>{if(document.visibilityState==='visible')void checkStorageStatus();});
  window.addEventListener('focus',()=>{if(document.visibilityState==='visible')void checkStorageStatus();});
  document.addEventListener('visibilitychange',()=>{
    storageStatusController.setVisible(document.visibilityState==='visible');
    syncWorkspaceVisibility();
    if(document.visibilityState==='visible')scheduleView();
    if(document.visibilityState==='visible'&&!storageStatusMode)void checkStorageStatus();
    if(document.visibilityState==='visible'&&startupHydrated){if(needsMainCatalogue(activeView)&&!state.models.length)void loadModels();void validateStartupConnection();}
  });
  window.addEventListener('pagehide',()=>storageStatusController.stop(),{once:true});
  storageStatusController.setVisible(document.visibilityState==='visible');
  initUiComponents();
  switchView('account',{remember:false});
  renderMedia();
  const configReady=(async()=>{
    const initialNavigation=navigationEpoch;
    try {
      const revision=relayConfigRevision,startup = await request('/startup?light=1',{signal:AbortSignal.timeout(25000)});
      if(revision===relayConfigRevision){
      const d = startup?.config || {};
      state.relayMode=Boolean(d.relayMode);
      storageStatusMode=state.relayMode?'relay':'legacy';
      state.assetSummary = startup?.assets || state.assetSummary;
      state.serverKeyConfigured = Boolean(d && d.configured);
      state.videoServerConfigured = Boolean(d && d.videoConfigured);
      state.rhServerConfigured = Boolean(d && (d.toolConfigured??d.rhConfigured));
      state.llmServerConfigured = Boolean(d && d.llmConfigured);
      state.relayServerRevision = d.revision;
      startupConfig=d;
      if(state.relayMode)setType(startupGenerationType(d,state.type));
      if(initialNavigation===navigationEpoch)switchView(startupView(d,startup.uiPreferences),{remember:false});
      }
    } catch (e) { state.serverKeyConfigured = false; state.videoServerConfigured = false; state.rhServerConfigured = false; state.llmServerConfigured = false; }
    startupHydrated=true;
    document.body.dataset.startupState='ready';
    window.dispatchEvent(new CustomEvent('hamster-startup-ready',{detail:{view:activeView}}));
    performance.mark('hamster-local-ready');
    if(navigationEpoch!==initialNavigation)void viewPreferences.remember(activeView);
    if(storageStatusMode)syncStorageStatusKind();else renderStorageStatus({kind:storageStatusKind(activeView,state.type),state:'pending'});
    renderAccount();renderRhStatus();inferenceIndicator.render();
    scheduleView();
    void validateStartupConnection();
  })();
  const deferred=configReady.then(()=>new Promise(resolve=>{
    const run=()=>{void restoreTasks();resolve();};
    if(typeof requestIdleCallback==='function')requestIdleCallback(run,{timeout:1000});else setTimeout(run,0);
  }));
  const startupLoads=[configReady,deferred];
  void Promise.allSettled(startupLoads);
  catalogRefresh=startVisibleCatalogRefresh({events:true,enabled:()=>startupHydrated&&state.relayMode&&!accountSessionRejected&&needsMainCatalogue(activeView),refresh:()=>loadModels(Promise.resolve(),{preserveSelection:true})});
  void configReady.then(()=>{if(document.visibilityState!=='hidden'&&needsMainCatalogue(activeView))void loadModels();void catalogRefresh.tick();});
}
init();
