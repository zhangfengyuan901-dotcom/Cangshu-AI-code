import {
  isVideo, isImage, concurrencyOptions, defaultVideoOptions, defaultImageOptions,
  buildVideoPayload, buildImagePayload, extractTaskIds, hamsterModelName, mapUpstreamModels, mediaLimitError, publicText,
} from './core.mjs';
import { autoAnimate } from './vendor/auto-animate.mjs';
import { assetLibrary, pickAsset, chooseAssetCategory, assetsRequest } from './asset-library.mjs';

const API_BASE = '/api';
const RH_BASE = '/rh';
const KEY_STORAGE = 'hamster_api_key';
const KEY_STORAGE_RH = 'hamster_rh_api_key';
const KEY_STORAGE_LLM = 'hamster_llm_api_key';
const HISTORY_STORAGE = 'hamster_history';

/* ---- 数字人 ---- */
const RH_APP_ID = '2087890031699648513';
const RH_NODE_IMAGE = '133';
const RH_NODE_AUDIO = '125';
const RH_MAX_AUDIO_SECONDS = 30;
const RH_DEPTH_APP_ID = '2089021172049596418';
const RH_DEPTH_NODE_VIDEO = '183';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const REFERENCE_OPTIONS = [
  { value: 'all', label: '全能参考' },
  { value: 'startEnd', label: '首尾帧' },
  { value: 'face', label: '人物一致' },
];
const STATUS_LABEL = { submitting:'提交中', unknown:'提交待确认', queued: '排队中', processing: '生成中', succeeded: '已完成', failed: '失败' };
const KIND_LABEL = { image: '图片', video: '视频', audio: '音频' };
const QUALITY_LABEL = { high: '高质量', medium: '标准', low: '快速' };

const state = {
  apiKey: '',
  serverKeyConfigured: false,
  rhApiKey: '',
  rhServerConfigured: false,
  llmApiKey: '',
  llmServerConfigured: false,
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

async function request(path, { method = 'GET', json, raw, contentType, headers = {} } = {}) {
  const opts = { method, headers: { Authorization: `Bearer ${state.apiKey}`, ...headers } };
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
    throw err;
  }
  return data;
}
function handleError(e) {
  const msg = e?.payload?.errorMessage || e?.payload?.message || e?.message;
  if (e?.status === 401) toast('API Key 无效或未配置，请到「账户」页检查');
  else if (e?.status === 402) toast('服务额度不足，请联系管理员');
  else if (e?.status === 429) toast('请求过于频繁，请稍后重试');
  else if (e?.status === 413) toast('素材文件过大');
  else if (e?.status === 502 || e?.status === 503) toast('上游服务异常，请稍后重试');
  else toast(msg || '请求失败');
}
function hasKey() { return Boolean(state.apiKey || state.serverKeyConfigured); }
function hasRhKey() { return Boolean(state.rhApiKey || state.rhServerConfigured); }

/* ---- 数字人请求（走 /rh 代理） ---- */
async function rhRequest(path, { method = 'GET', json, form, headers = {} } = {}) {
  const opts = { method, headers: { ...headers } };
  if (state.rhApiKey) opts.headers['x-rh-key'] = state.rhApiKey;
  if (json !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(json);
  } else if (form !== undefined) {
    opts.body = form; // FormData：交给浏览器自行设置 multipart content-type（含 boundary）
  }
  const res = await fetch(RH_BASE + path, opts);
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    const err = new Error(data?.errorMessage || data?.message || data?.error || `请求失败 (${res.status})`);
    err.status = res.status;
    err.payload = data;
    throw err;
  }
  return data;
}

/* 上传素材，返回可用于 nodeInfoList 的 fileName */
async function rhUpload(file) {
  const fd = new FormData();
  fd.append('file', file);
  const res = await rhRequest('/media/upload/binary', { method: 'POST', form: fd });
  if (res && res.code !== undefined && Number(res.code) !== 0) {
    throw new Error(res.message || `上传失败 (code ${res.code})`);
  }
  const fileName = res?.data?.fileName || res?.data?.download_url;
  if (!fileName) throw new Error('上传成功但未返回文件名');
  return fileName;
}

/* 读取音频时长（秒），失败返回 NaN */
function audioDuration(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const a = document.createElement('audio');
    a.preload = 'metadata';
    a.onloadedmetadata = () => { URL.revokeObjectURL(url); resolve(a.duration); };
    a.onerror = () => { URL.revokeObjectURL(url); resolve(NaN); };
    a.src = url;
  });
}

// ---- 账户 ----
function renderAccount() {
  const s = $('#accountStatus');
  s.textContent = hasKey() ? '已配置，用于图片与视频生成；密钥有效性将在调用时验证' : '请填写 API Key 后保存';
  s.className = hasKey() ? 'hint ok' : 'hint';
}

// ---- 模型 ----
function videoModels() { return state.models.filter(isVideo); }
function imageModels() { return state.models.filter(isImage); }
function modelsOfType() { return state.type === 'video' ? videoModels() : imageModels(); }
async function loadModels() {
  try {
    const res = await fetch('/api/public-models');
    const payload = await res.json();
    state.models = mapUpstreamModels(payload.data || []);
  } catch (e) {
    state.models = [];
  }
  if (hasKey()) {
    try { state.models = mapUpstreamModels((await request('/models'))?.data || []); }
    catch (e) { /* 保留公共列表 */ }
  }
  pickDefaultModel();
  renderComposer();
}
function pickDefaultModel() {
  const list = modelsOfType();
  if (!list.length) { state.model = null; state.options = {}; return; }
  state.model = list.find((m) => m.id === state.model?.id) || list[0];
  state.options = state.type === 'video' ? defaultVideoOptions(state.model) : defaultImageOptions(state.model);
  clampConcurrency();
}
function renderComposer() {
  const m = state.model;
  renderMediaLimits();
  if (!m) {
    $('#modelLabel').textContent = '暂无模型';
    $('#ratioLabel').textContent = '--';
    $('#qualityLabel').textContent = '--';
    $('#durationLabel').textContent = '--';
    return;
  }
  $('#modelLabel').textContent = m.name || m.id;
  if (state.type === 'video') {
    $('#referenceLabel').textContent = REFERENCE_OPTIONS.find((r) => r.value === state.options.reference)?.label || '全能参考';
    $('#ratioLabel').textContent = state.options.ratio;
    $('#qualityLabel').textContent = state.options.resolution === '2k' ? '2K' : state.options.resolution;
    $('#durationLabel').textContent = `${state.options.duration}s`;
  } else {
    $('#ratioLabel').textContent = state.options.aspect_ratio;
    $('#qualityLabel').textContent = QUALITY_LABEL[state.options.quality] || state.options.quality;
  }
  $('#concurrencyLabel').textContent = state.concurrency + 'x';
}
function setType(type) {
  state.type = type;
  $('#typeLabel').textContent = type === 'video' ? '视频生成' : '图片生成';
  $('#referencePill').style.display = type === 'video' ? '' : 'none';
  $('#durationPill').style.display = type === 'video' ? '' : 'none';
  $$('.media-tile[data-kind]').forEach((el) => {
    el.style.display = type === 'video' || el.dataset.kind === 'image' ? '' : 'none';
  });
  pickDefaultModel();
  renderMedia();
  renderComposer();
}
function setModel(model) {
  state.model = model;
  state.options = state.type === 'video' ? defaultVideoOptions(model) : defaultImageOptions(model);
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
    { label: '视频生成', selected: state.type === 'video', onSelect: () => setType('video') },
    { label: '图片生成', selected: state.type === 'image', onSelect: () => setType('image') },
  ]);
}
function modelMenu(anchor) {
  openMenu(anchor, modelsOfType().map((m) => ({
    type: 'card', label: m.name, sub: m.summary || '图片创作线路',
    meta: state.type === 'video'
      ? `${(m.resolutions || []).map(v => v === '2k' ? '2K' : v).join(' / ') || '标准画质'} · ${m.durations?.length ? `${Math.min(...m.durations)}–${Math.max(...m.durations)}秒` : '标准时长'}`
      : `${(m.aspect_ratios || []).join(' / ') || '自适应比例'} · ${(m.quality_options || []).map((v) => QUALITY_LABEL[v] || v).join(' / ') || '标准质量'}`,
    selected: state.model?.id === m.id, onSelect: () => setModel(m),
  })), 'channel-popover');
}
function referenceMenu(anchor) {
  if (!state.model) { toast('请先选择模型'); return; }
  openMenu(anchor, REFERENCE_OPTIONS.map((r) => ({
    label: r.label, selected: state.options.reference === r.value,
    onSelect: () => { state.options.reference = r.value; renderComposer(); },
  })));
}
function ratioMenu(anchor) {
  const m = state.model; if (!m) { toast('请先选择模型'); return; }
  const values = state.type === 'video' ? (m.ratios || []) : (m.aspect_ratios || []);
  const selected = state.type === 'video' ? state.options.ratio : state.options.aspect_ratio;
  openMenu(anchor, values.map((v) => ({
    label: v, selected: selected === v,
    onSelect: () => { state.options[state.type === 'video' ? 'ratio' : 'aspect_ratio'] = v; renderComposer(); },
  })));
}
function qualityMenu(anchor) {
  const m = state.model; if (!m) { toast('请先选择模型'); return; }
  const values = state.type === 'video' ? (m.resolutions || []) : (m.quality_options || ['high', 'medium', 'low']);
  const selected = state.type === 'video' ? state.options.resolution : state.options.quality;
  openMenu(anchor, values.map((v) => ({
    label: state.type === 'video' ? v : (QUALITY_LABEL[v] || v), selected: selected === v,
    onSelect: () => { state.options[state.type === 'video' ? 'resolution' : 'quality'] = v; renderComposer(); },
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
function renderMediaLimits() {
  const model = state.model;
  const all = [...state.media, ...state.pendingMedia];
  const error = model ? mediaLimitError(model, all) : '';
  $('#mediaLimitHint').textContent = error || model?.summary || (model ? '支持拖入图片素材' : '请先选择线路');
  $('#mediaLimitHint').classList.toggle('error', Boolean(error));
  $('.send-button').disabled = !model || Boolean(error) || state.submitting || state.pendingMedia.length > 0;
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
async function uploadFile(file, kind) {
  const buf = await file.arrayBuffer();
  const res = await request(`/uploads/raw?kind=${encodeURIComponent(kind)}&fileName=${encodeURIComponent(file.name)}`, {
    method: 'POST', raw: buf, contentType: mimeFor(file.name, file.type),
  });
  return res?.file?.url;
}
async function handleFiles(files, kind) {
  if (!hasKey()) { toast('请先在「账户」页填写 API Key'); return; }
  const tile = $(`.media-tile[data-kind="${kind}"]`);
  let completed = false;
  tile?.classList.remove('is-complete');
  tile?.classList.add('is-uploading');
  try {
    for (const file of files) {
      if (kindForFile(file) !== kind) { toast('文件类型与素材类型不匹配'); continue; }
      const limitError = mediaLimitError(state.model, [...state.media, ...state.pendingMedia, { kind }]);
      if (limitError) { toast(limitError); break; }
      const pending = { kind };
      state.pendingMedia.push(pending);
      renderMediaLimits();
      try {
        const url = await uploadFile(file, kind);
        if (!url) throw new Error('上传未返回有效素材地址，请重试');
        state.media.push({ kind, url, name: file.name, local: URL.createObjectURL(file), tag: nextTag(kind) });
        completed = true;
      } catch (e) { handleError(e); }
      finally {
        state.pendingMedia.splice(state.pendingMedia.indexOf(pending), 1);
        renderMedia();
      }
    }
  } finally {
    tile?.classList.remove('is-uploading');
    if (completed) {
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
  state.media.push({ kind, url, name: url, local: null, tag: nextTag(kind) });
  renderMedia();
}
function removeMedia(idx) { state.media.splice(idx, 1); renderMedia(); }
function renderMedia() {
  const list = $('#mediaList');
  list.innerHTML = state.media.map((m, i) => {
    const thumb = m.kind === 'image' ? `<img src="${escapeHtml(m.local || m.url)}" alt="" />` : `<span class="chip-kind">${m.kind === 'video' ? '🎞' : '🎵'}</span>`;
    return `<div class="media-chip">${thumb}<span class="media-name">${escapeHtml(m.name)}</span><button type="button" class="media-tag" data-tag="${escapeHtml(m.tag)}" title="插入到提示词">@${escapeHtml(m.tag)}</button><button type="button" class="rm" data-i="${i}">×</button></div>`;
  }).join('');
  list.querySelectorAll('.rm').forEach((b) => b.addEventListener('click', () => removeMedia(Number(b.dataset.i))));
  list.querySelectorAll('.media-tag').forEach((b) => b.addEventListener('click', () => insertMention(b.dataset.tag)));
  list.hidden = !state.media.length;
  renderMediaLimits();
  updateMentionMenu();
}

// ---- 提示词素材引用 ----
let mentionIndex = 0;
let mentionStart = -1;
function mentionContext() {
  const input = $('#prompt');
  const cursor = input.selectionStart;
  const match = input.value.slice(0, cursor).match(/@([^@\s，。！？、,.;:：；]*)$/u);
  return match ? { query: match[1].toLowerCase(), start: cursor - match[0].length, end: cursor } : null;
}
function closeMentionMenu() {
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
  const suffix = to < input.value.length && /\s/.test(input.value[to]) ? '' : ' ';
  const value = `${prefix}@${tag}${suffix}`;
  input.setRangeText(value, from, to, 'end');
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
  if (!hasKey()) { toast('请先在「账户」页填写 API Key'); return; }
  if (!state.model) { toast('请选择模型'); return; }
  if (state.pendingMedia.length) { toast('素材正在上传，请稍候'); return; }
  const mediaError = mediaLimitError(state.model, state.media);
  if (mediaError) { toast(mediaError); return; }
  const prompt = $('#prompt').value.trim();
  if (!prompt) { toast('请输入提示词'); return; }
  const media = groupMedia();
  const isVideoTask = state.type === 'video';
  const payload = isVideoTask
    ? buildVideoPayload({ model: state.model, prompt, ...state.options, concurrency: state.concurrency, images: media.image, videos: media.video, audios: media.audio })
    : buildImagePayload({ model: state.model, prompt, ...state.options, concurrency: state.concurrency, images: media.image });
  const path = isVideoTask ? '/videos' : '/images';
  const headers = isVideoTask ? { 'Idempotency-Key': crypto.randomUUID() } : {};
  const sendBtn = $('.send-button');
  state.submitting = true;
  sendBtn.disabled = true;
  try {
    const created = await request(path, { method: 'POST', json: payload, headers });
    if (!extractTaskIds(created).length) throw new Error('提交结果待确认，请检查历史记录，勿重复提交');
    await syncTasks();
    $('#prompt').value = '';
    renderAllTasks();
  } catch (err) { handleError(err); }
  finally { state.submitting = false; renderMediaLimits(); syncTasks(); }
}
// The UI reads the local journal; the local service alone polls upstream IDs.
let syncingTasks = false;
async function syncTasks() {
  if (syncingTasks) return;
  syncingTasks = true;
  try {
    const data = await request('/tasks');
    if (!Array.isArray(data?.tasks)) throw new Error('任务记录暂不可用');
    state.tasks = data.tasks;
    renderAllTasks();
    if ($('[data-panel="history"]').classList.contains('active')) renderHistory();
    $('#taskPersistenceNote').textContent = data.warnings?.length ? data.warnings.join('；') : '任务记录保存在本机；重新打开应用会恢复查询。完成后自动保存到桌面。';
  } catch {
    $('#taskPersistenceNote').textContent = '暂时无法同步本地任务，已有记录仍保留，正在重试…';
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
  return result?.local_path && /\.(png|jpe?g|webp|mp4|webm|mov)$/i.test(result.local_path) ? `<button type="button" class="asset-button" data-save-asset="${escapeHtml(result.local_path)}">收入资产库</button>` : '';
}
function resultHtml(t) {
  if (!t.result) return '';
  const preview = t.result.local_url || (t.type === 'video' ? t.result.video_url : t.result.image_url) || t.result.download_url;
  const media = preview && !t.result.text ? (t.type === 'video'
    ? `<video src="${escapeHtml(preview)}" preload="metadata" controls></video>`
    : `<img src="${escapeHtml(preview)}" loading="lazy" alt="生成结果" />`) : '';
  const dl = t.result.local_url ? `<div class="task-actions"><a class="link-button" href="${escapeHtml(t.result.local_url)}?download=1" download><i data-lucide="download"></i>下载本地文件</a></div>` : '';
  const saved = t.result.saving
    ? '<div class="save-note">正在保存到桌面…</div>'
    : t.result.local_path
      ? `<div class="save-note ok">已自动保存：${escapeHtml(t.result.local_path)}</div>`
      : t.result.save_error ? `<div class="save-note error">自动保存待重试：${escapeHtml(publicText(t.result.save_error))}</div>` : '<div class="save-note">等待自动保存到桌面…</div>';
  const text = t.result.text
    ? `<div class="text-result"><div class="text-result-head"><span>反推结果</span><button type="button" class="copy-result" data-copy-result><i data-lucide="copy"></i>复制</button></div><pre>${escapeHtml(t.result.text)}</pre></div>`
    : '';
  return media + text + dl + saved + assetSaveButton(t.result);
}
function taskModelLabel(task) {
  const special = { digital: '仓鼠数字人', depth: '仓鼠黑白深度视频', reverse: '仓鼠视频反推' };
  if (special[task.source]) return special[task.source];
  for (const label of ['数字人', '黑白深度视频', '视频反推']) if (task.modelName?.includes(label)) return `仓鼠${label}`;
  return hamsterModelName({ id: task.modelId, name: task.modelName });
}
function taskCardHtml(t) {
  const pct = t.progress ?? 0;
  const bar = (t.status === 'processing' || t.status === 'queued') ? `<div class="progress-wrap"><div class="progress-bar" style="width:${pct}%"></div></div>` : '';
  const note = t.result?.local_url ? '<div class="link-note">本地预览不受临时链接有效期影响</div>' : '';
  return `<div class="task-card">
    <div class="task-head"><span class="task-status ${t.status}">${STATUS_LABEL[t.status] || t.status}</span><span class="task-model">${escapeHtml(taskModelLabel(t))}</span></div>
    <div class="task-prompt">${escapeHtml(t.prompt)}</div>
    <div class="link-note">${t.id ? `任务 ID：${escapeHtml(t.id)}` : '正在确认上游任务 ID'} · ${escapeHtml(new Date(t.createdAt).toLocaleString())}</div>
    ${bar}
    ${t.error ? `<div class="task-error">${escapeHtml(publicText(t.error))}</div>` : ''}
    ${t.poll_error ? `<div class="save-note error">${escapeHtml(publicText(t.poll_error))}</div>` : ''}
    <div class="task-result">${resultHtml(t)}</div>
    ${t.key && t.id && t.status !== 'failed' && !t.result?.local_url ? `<button class="link-button" type="button" data-retry-task="${escapeHtml(t.key)}">${t.status === 'succeeded' ? '重新获取并保存' : '恢复查询'}</button>` : ''}
    ${note}
  </div>`;
}
function renderTasksFor(source, container) {
  if (!container) return;
  const list = state.tasks.filter((t) => (t.source || 'generate') === source);
  patchTaskCards(container,list);
}
function patchTaskCards(container,list) {
  const wanted = new Set(list.map(t => t.key || t.id));
  for (const child of [...container.children]) if (!wanted.has(child.dataset.taskKey)) child.remove();
  list.forEach((task,index) => {
    const key = task.key || task.id;
    let card = [...container.children].find(el => el.dataset.taskKey === key);
    const html = taskCardHtml(task);
    if (!card || card._taskHtml !== html) {
      const template = document.createElement('template'); template.innerHTML = html;
      const next = template.content.firstElementChild; next.dataset.taskKey = key; next._taskHtml = html;
      if (card) card.replaceWith(next); else container.append(next);
      card = next; refreshIcons(card); bindResultCopy(card);
    }
    if (container.children[index] !== card) container.insertBefore(card,container.children[index] || null);
  });
}
function renderTaskFeed() { renderTasksFor('generate', $('#taskFeed')); }
function renderDhResults() { renderTasksFor('digital', $('#dhResults')); }
function renderDepthResults() { renderTasksFor('depth', $('#depthResults')); }
function renderAllTasks() { renderTaskFeed(); renderDhResults(); renderDepthResults(); }
function bindResultCopy(container) {
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
}
let historyFilter = 'all';
function renderHistory() {
  const history = state.tasks;
  const filtered = history.filter((h) => historyFilter === 'all' || h.type === historyFilter);
  const el = $('#historyList');
  if (!filtered.length) { el.innerHTML = `<div class="empty-hint">${history.length ? '该分类暂无记录' : '暂无历史记录'}</div>`; return; }
  patchTaskCards(el,filtered);
}
async function clearHistory() {
  if (!confirm('仅清除已结束且不再等待保存的任务记录；进行中任务和桌面结果文件会保留。继续吗？')) return;
  try { await request('/tasks',{method:'DELETE'}); await syncTasks(); renderHistory(); }
  catch(e) {handleError(e);}
}

// ---- 数字人 ----
function rhHasKey() { return hasRhKey(); }
function dhSetHint() {
  const { image, audio } = state.dh;
  const btn = $('#dhSubmit');
  const hint = $('#dhHint');
  if (!btn || !hint) return;
  if (!rhHasKey()) {
    btn.disabled = true;
    hint.textContent = '请先在「账户」页填写数字人与工具箱共用的 仓鼠工具 API Key';
    return;
  }
  if (!image && !audio) { btn.disabled = true; hint.textContent = '请先上传人物参考图与音频'; return; }
  if (!image) { btn.disabled = true; hint.textContent = '还需上传人物参考图'; return; }
  if (!audio) { btn.disabled = true; hint.textContent = '还需上传音频'; return; }
  btn.disabled = false;
  hint.textContent = `已就绪${Number.isFinite(audio.duration) ? ` · 音频 ${audio.duration.toFixed(1)} 秒` : ''}`;
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
  toast('请先在「账户」页填写 仓鼠工具 API Key');
  switchView('account');
  return false;
}
async function dhPickImage(file) {
  if (!file || !requireRhKey()) return;
  const info = $('#dhImageInfo');
  const box = $('#dhImageBox');
  box.classList.add('is-uploading');
  info.textContent = '上传中…'; info.className = 'upload-info';
  try {
    const fileName = await rhUpload(file);
    state.dh.image = { fileName, name: file.name, local: URL.createObjectURL(file) };
  } catch (e) {
    info.textContent = publicText(e.message); info.className = 'upload-info error';
    handleError(e); return;
  } finally {
    box.classList.remove('is-uploading');
  }
  renderDhSlots();
}
async function dhPickAudio(file) {
  if (!file || !requireRhKey()) return;
  const info = $('#dhAudioInfo');
  const dur = await audioDuration(file);
  if (Number.isFinite(dur) && dur > RH_MAX_AUDIO_SECONDS + 0.5) {
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
    state.dh.audio = { fileName, name: file.name, duration: dur };
  } catch (e) {
    info.textContent = publicText(e.message); info.className = 'upload-info error';
    handleError(e); return;
  } finally {
    box.classList.remove('is-uploading');
  }
  renderDhSlots();
}
async function dhSubmit() {
  if (!requireRhKey()) return;
  const { image, audio } = state.dh;
  if (!image || !audio) { toast('请先上传人物参考图和音频'); return; }
  const btn = $('#dhSubmit');
  btn.disabled = true;
  try {
    const created = await rhRequest(`/run/ai-app/${RH_APP_ID}`, {
      method: 'POST',
      json: {
        nodeInfoList: [
          { nodeId: RH_NODE_IMAGE, fieldName: 'image', fieldValue: image.fileName, description: '人物参考图' },
          { nodeId: RH_NODE_AUDIO, fieldName: 'audio', fieldValue: audio.fileName, description: '音频' },
        ],
        instanceType: 'default',
        usePersonalQueue: false,
      },
    });
    if (created?.errorCode) throw new Error(created.errorMessage || created.errorCode);
    if (!created?.taskId) throw new Error('未返回 taskId，请检查历史中的提交待确认记录');
    await syncTasks();
  } catch (e) {
    await syncTasks();
    handleError(e);
  } finally { btn.disabled = false; dhSetHint(); syncTasks(); }
}

// ---- 工具箱：黑白深度视频 ----
function depthSetHint() {
  const btn = $('#depthSubmit');
  const hint = $('#depthHint');
  if (!btn || !hint) return;
  if (!rhHasKey()) {
    btn.disabled = true;
    hint.textContent = '请先在「账户」页填写数字人与工具箱共用的 仓鼠工具 API Key';
    return;
  }
  if (!state.depth.video) {
    btn.disabled = true;
    hint.textContent = '请先上传源视频';
    return;
  }
  btn.disabled = false;
  hint.textContent = '视频已就绪';
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
  if (!file || !requireRhKey()) return;
  const info = $('#depthVideoInfo');
  const box = $('#depthVideoBox');
  box.classList.add('is-uploading');
  info.textContent = '上传中…';
  info.className = 'upload-info';
  try {
    const fileName = await rhUpload(file);
    state.depth.video = { fileName, name: file.name, local: URL.createObjectURL(file) };
  } catch (e) {
    info.textContent = publicText(e.message);
    info.className = 'upload-info error';
    handleError(e);
    return;
  } finally {
    box.classList.remove('is-uploading');
  }
  renderDepthSlot();
}
async function depthSubmit() {
  if (!requireRhKey()) return;
  const video = state.depth.video;
  if (!video) { toast('请先上传源视频'); return; }
  const btn = $('#depthSubmit');
  btn.disabled = true;
  try {
    const created = await rhRequest(`/run/ai-app/${RH_DEPTH_APP_ID}`, {
      method: 'POST',
      json: {
        nodeInfoList: [
          { nodeId: RH_DEPTH_NODE_VIDEO, fieldName: 'video', fieldValue: video.fileName, description: '上传视频' },
        ],
        instanceType: 'default',
        usePersonalQueue: false,
      },
    });
    if (created?.errorCode) throw new Error(created.errorMessage || created.errorCode);
    if (!created?.taskId) throw new Error('未返回 taskId，请检查历史中的提交待确认记录');
    await syncTasks();
  } catch (e) {
    await syncTasks();
    handleError(e);
  } finally {
    btn.disabled = false;
    depthSetHint();
    syncTasks();
  }
}

function renderRhStatus() {
  const s = $('#rhStatus');
  if (!s) return;
  if (rhHasKey()) { s.textContent = '已配置，数字人与工具箱共用此 Key'; s.className = 'hint ok'; }
  else { s.textContent = '未配置，数字人与工具箱功能不可用'; s.className = 'hint'; }
  dhSetHint();
  depthSetHint();
}
function renderLlmStatus() {
  const status = $('#llmStatus');
  if (!status) return;
  const configured = Boolean(state.llmApiKey || state.llmServerConfigured);
  status.textContent = configured ? '已配置，仓鼠智能体、智能成片与创意工作台共用' : '未配置，本地工作台可打开但无法调用智能模型';
  status.className = `hint${configured ? ' ok' : ''}`;
}
async function saveRhKey() {
  state.rhApiKey = $('#rhKeyInput').value.trim();
  if (!state.rhApiKey) { toast('请输入 仓鼠工具 API Key'); return; }
  localStorage.setItem(KEY_STORAGE_RH, state.rhApiKey);
  try {
    await fetch('/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rhApiKey: state.rhApiKey }) });
  } catch (e) { /* 可选持久化，失败忽略 */ }
  toast('数字人与工具箱共用 Key 已保存');
  renderRhStatus();
}
async function saveLlmKey() {
  const key = $('#llmKeyInput').value.trim();
  if (!key && !state.llmServerConfigured) { toast('请输入仓鼠智能 API Key'); return; }
  const button = $('#saveLlmKeyButton');
  button.disabled = true;
  try {
    const response = await fetch('/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...(key ? {llmApiKey:key} : {}), llmEndpointId:$('#llmEndpointInput').value.trim() }) });
    if (!response.ok) throw Error('保存失败，请检查 ep- 开头的接入点编号及本地服务。');
    const data = await response.json();
    state.llmServerConfigured = data.llmConfigured;
    if (key) { state.llmApiKey = key; localStorage.setItem(KEY_STORAGE_LLM, key); }
    renderLlmStatus();
    toast('智能服务配置已保存，三个功能的新请求共用');
  } catch (e) { toast(e.message); }
  finally { button.disabled = false; }
}

// ---- 视图 & 初始化 ----
let selectingAsset = false;
async function useGenerationAsset(item) {
  if (selectingAsset) return;
  if (!hasKey()) { toast('请先配置图片 / 视频 API Key'); return; }
  const error = mediaLimitError(state.model, [...state.media, ...state.pendingMedia, {kind:item.kind}]);
  if (error) { toast(error); return; }
  selectingAsset = true;
  $('#assetTile').disabled = true;
  try {
    toast('正在上传选定资产…');
    const uploaded = await assetsRequest('/api/assets', `/${item.id}/upload`, {method:'POST', headers:state.apiKey?{Authorization:`Bearer ${state.apiKey}`}:{}});
    addMediaByUrl(uploaded.url, item.kind);
    switchView('generate');
  } catch (e) { toast(e.message); }
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
  if (name === 'assets') assetLibrary($('#assetLibrary'),{onSelect:useGenerationAsset});
  if (name === 'account') { renderAccount(); renderRhStatus(); renderLlmStatus(); checkDiagnostics(); }
  if (name === 'digital') { renderDhSlots(); renderDhResults(); }
  if (name === 'depth') { renderDepthSlot(); renderDepthResults(); }
}
function wait(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
async function readSmartVideoResponse(path, options) {
  const response = await fetch(path, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message || '智能成片服务启动失败');
  return data;
}
async function checkDiagnostics() {
  const button=$('#checkDiagnostics');button.disabled=true;
  const status=$('#diagnosticStatus');status.textContent='正在检查本地端口与启动环境…';
  try {
    const response=await fetch('/api/diagnostics/status');
    const data=await response.json();if(!response.ok)throw new Error('诊断检查失败');
    const port=data.checks?.port;
    const owners=(port?.owners || []).map(x=>`${x.name}（PID ${x.pid}）`).join('、');
    const labels={available:'端口可用',occupied:`端口被占用${owners?'：'+owners:''}`,restricted:'系统限制访问此端口',unknown:'端口状态暂无法确定','own-service':'本地工作台已运行'};
    status.textContent=`${port?.port || 8000}：${labels[port?.state] || '状态待确认'}`;
    if(data.lastFailure)status.textContent+=`\n最近启动错误：${publicText(data.lastFailure.message)}（${data.lastFailure.code}）`;
    if(data.persistenceError)status.textContent+='\n'+data.persistenceError;
  }catch(e){status.textContent=publicText(e.message);}finally{button.disabled=false;}
}
async function exportDiagnostics() {
  const buttons=$$('[data-export-diagnostics]');buttons.forEach(button=>button.disabled=true);
  $$('[data-diagnostic-result]').forEach(el=>el.textContent='正在生成脱敏诊断文件…');
  try {
    const response=await fetch('/api/diagnostics/export',{method:'POST'});
    const data=await response.json();if(!response.ok)throw new Error('诊断导出失败，请检查桌面文件夹写入权限');
    $$('[data-diagnostic-result]').forEach(el=>el.textContent=`已导出：${data.localPath}\n请把这个文件发送给支持人员。`);
    toast('诊断文件已保存到桌面「仓鼠AI诊断」');
  }catch(e){$$('[data-diagnostic-result]').forEach(el=>el.textContent=publicText(e.message));}
  finally{buttons.forEach(button=>button.disabled=false);}
}
async function openWorkbench() {
  const endpoint = '/api/chat';
  const label = '工作台';
  const button = $('#workbenchButton');
  button.disabled = true;
  button.classList.add('is-launching');
  try {
    toast('正在准备本地运行环境，首次释放可能需要几分钟，请勿关闭应用…');
    let state = await readSmartVideoResponse(endpoint + '/open', { method: 'POST' });
    if (state.status === 'ready') { toast(label + '已在浏览器打开'); return; }
    toast('正在启动' + label + '，请稍候…');
    for (let attempt = 0; attempt < 900; attempt += 1) {
      await wait(1000);
      state = await readSmartVideoResponse(endpoint + '/status');
      if (state.status === 'ready') {
        await readSmartVideoResponse(endpoint + '/open', { method: 'POST' });
        toast(label + '已在浏览器打开');
        return;
      }
      if (state.status === 'error') throw new Error(state.message || '智能成片服务启动失败');
    }
    throw new Error('本地工作台准备超时，请导出诊断信息检查环境文件或系统权限');
  } catch (error) {
    $('#startupErrorMessage').textContent=publicText(error.message || '本地工作台启动失败');
    $$('[data-diagnostic-result]').forEach(el=>el.textContent='');
    if(!$('#startupErrorDialog').open)$('#startupErrorDialog').showModal();
  } finally {
    button.disabled = false;
    button.classList.remove('is-launching');
  }
}
function bindEvents() {
  $('#checkDiagnostics').addEventListener('click',checkDiagnostics);
  $$('[data-export-diagnostics]').forEach(button=>button.addEventListener('click',exportDiagnostics));
  $('#closeStartupError').addEventListener('click',()=>$('#startupErrorDialog').close());
  $$('.rail-item[data-view]').forEach((b) => b.addEventListener('click', () => switchView(b.dataset.view)));
  $('#workbenchButton').addEventListener('click', openWorkbench);
  $('.logo').addEventListener('click', () => switchView('generate'));
  $('[data-menu="type"]').addEventListener('click', (e) => typeMenu(e.currentTarget));
  $('[data-menu="model"]').addEventListener('click', (e) => modelMenu(e.currentTarget));
  $('[data-menu="reference"]').addEventListener('click', (e) => referenceMenu(e.currentTarget));
  $('[data-menu="ratio"]').addEventListener('click', (e) => ratioMenu(e.currentTarget));
  $('[data-menu="quality"]').addEventListener('click', (e) => qualityMenu(e.currentTarget));
  $('[data-menu="duration"]').addEventListener('click', (e) => durationMenu(e.currentTarget));
  $('[data-menu="concurrency"]').addEventListener('click', (e) => concurrencyMenu(e.currentTarget));
  $('#prompt').addEventListener('input', updateMentionMenu);
  $('#prompt').addEventListener('keydown', onPromptKeydown);
  $('#prompt').addEventListener('blur', () => setTimeout(closeMentionMenu, 120));
  $('#imageFile').addEventListener('change', (e) => handleFiles(e.target.files, 'image'));
  $('#videoFile').addEventListener('change', (e) => handleFiles(e.target.files, 'video'));
  $('#audioFile').addEventListener('change', (e) => handleFiles(e.target.files, 'audio'));
  $('#urlTile').addEventListener('click', () => { const f = $('#urlForm'); f.hidden = !f.hidden; });
  $('#assetTile').addEventListener('click', openGenerationAssets);
  $('#urlAdd').addEventListener('click', () => { addMediaByUrl($('#urlInput').value.trim(), $('#urlKind').value); $('#urlInput').value = ''; });
  $('#generationForm').addEventListener('submit', onSubmit);
  $('#saveKeyButton').addEventListener('click', saveKey);
  $('#saveRhKeyButton').addEventListener('click', saveRhKey);
  $('#saveLlmKeyButton').addEventListener('click', saveLlmKey);
  $('#dhImageFile').addEventListener('change', (e) => { dhPickImage(e.target.files[0]); e.target.value = ''; });
  $('#dhAudioFile').addEventListener('change', (e) => { dhPickAudio(e.target.files[0]); e.target.value = ''; });
  $('#dhSubmit').addEventListener('click', dhSubmit);
  $('#depthVideoFile').addEventListener('change', (e) => { depthPickVideo(e.target.files[0]); e.target.value = ''; });
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
    renderHistory();
  }));
  $('#clearHistory').addEventListener('click', clearHistory);
}
async function saveKey() {
  state.apiKey = $('#apiKeyInput').value.trim();
  if (!state.apiKey) { toast('请输入 API Key'); return; }
  localStorage.setItem(KEY_STORAGE, state.apiKey);
  try {
    await fetch('/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ apiKey: state.apiKey }) });
  } catch (e) { /* 可选持久化到 config.json，失败忽略 */ }
  renderAccount();
  await loadModels();
}
async function init() {
  state.apiKey = localStorage.getItem(KEY_STORAGE) || '';
  state.rhApiKey = localStorage.getItem(KEY_STORAGE_RH) || '';
  state.llmApiKey = localStorage.getItem(KEY_STORAGE_LLM) || '';
  $('#apiKeyInput').value = state.apiKey;
  $('#rhKeyInput').value = state.rhApiKey;
  $('#llmKeyInput').value = state.llmApiKey;
  bindEvents();
  initUiComponents();
  assetsRequest('/api/assets').catch(()=>{});
  switchView('generate');
  renderMedia();
  renderTaskFeed();
  await restoreTasks();
  try {
    const d = await (await fetch('/api/config')).json();
    state.serverKeyConfigured = Boolean(d && d.configured);
    state.rhServerConfigured = Boolean(d && d.rhConfigured);
    state.llmServerConfigured = Boolean(d && d.llmConfigured);
    $('#llmEndpointInput').value = d.llmEndpointId ?? d.creativeEndpointId ?? '';
  } catch (e) { state.serverKeyConfigured = false; state.rhServerConfigured = false; state.llmServerConfigured = false; }
  await loadModels();                      // 模型列表走公共端点，无需 Key
  renderAccount();
  renderRhStatus();
  renderLlmStatus();
  renderDhSlots();
  renderDepthSlot();
}
init();
