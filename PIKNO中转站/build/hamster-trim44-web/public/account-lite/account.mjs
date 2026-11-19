import { GROUPS, AccountError, createAccountClient, createSelectedKeyConnector, selectedKeyOperation, findSelectedToken, findCreatedToken, cnyFromQuota, keyPayload, operationStore, tokenMetadata, adminHome } from './client.mjs';
import { hasOwn, secureUUID, openDialog, closeDialog, desktopFlowContext } from './compat.mjs';

const $ = (id) => document.getElementById(id);
const initialURL = new URL(window.location.href);
let session; try { session = sessionStorage; } catch { /* An explicit flow still fails closed. */ }
const desktopFlow = desktopFlowContext(session, initialURL.hash);
// The public console embeds this same-origin account UI; only layout metadata
// crosses the frame boundary. Credentials and account state remain in this page.
if (initialURL.searchParams.get('embed') === '1' && window.parent !== window) {
  document.documentElement.dataset.embedded = 'true';
  let resizeFrame = 0;
  const reportSize = () => {
    cancelAnimationFrame(resizeFrame);
    resizeFrame = requestAnimationFrame(() => window.parent.postMessage({ type: 'pikno-account-size', height: Math.ceil(document.body.scrollHeight) }, window.location.origin));
  };
  if (typeof ResizeObserver === 'function') new ResizeObserver(reportSize).observe(document.body);
  window.addEventListener('load', reportSize, { once: true });
  reportSize();
}
function accountEntryTab(url, savedTab) {
  return [url.searchParams.get('tab'), ({ '#consumption': 'usage', '#recharge': 'topup', '#keys': 'keys' })[url.hash], savedTab]
    .find(tab => ['balance', 'usage', 'topup', 'keys'].includes(tab)) || 'balance';
}
function saveAccountTab(tab, canonicalize = false) {
  if (canonicalize || history.state?.tab !== tab) history.replaceState({ ...history.state, tab }, '', '/account-lite/index.html');
}
const entryTab = accountEntryTab(initialURL, history.state?.tab);
const returnOrder = initialURL.searchParams.get('payment_return') === '1' ? initialURL.searchParams.get('trade_no') : null;
// The native credential handoff accepts only this exact account entry URL.
saveAccountTab(entryTab, Boolean(initialURL.search || initialURL.hash));
const state = { tab: 'balance', status: null, groups: {}, orderRevision: 0, keyRevision: 0, revealRevision: 0, pages: { usage: 1, order: 1, key: 1 }, totals: {}, loading: new Set(), pendingKey: null, paymentOrder: '', reveals: new Map(), bootstrap: null, lastRefresh: 0 };
state.suspended = false; state.restoring = null;
state.desktopFlow = desktopFlow; state.desktopReady = !desktopFlow; state.desktopBusy = false; state.desktopExpiresAt = 0; state.desktopRequiresApproval = false;
state.paymentCheck = null; state.paymentTimer = null; state.paymentChecksLeft = 0;
state.setupKeyCount = null; state.setupBalanceSufficient = null; state.setupRevision = 0;
const recovery = operationStore({ getItem: (key) => localStorage.getItem(key), setItem: (key, value) => localStorage.setItem(key, value), removeItem: (key) => localStorage.removeItem(key) });
state.activations = new Map(); state.connectionStates = new Map(); state.activationResults = new Map(); state.nativeContext = Promise.resolve({ ok: false }); state.keyRecovery = null; state.keyRetryAt = 0;
function nativeBridge() { return window.hamsterAccount; }
function reportFailure(value) { if (value.httpStatus === 429) return; try { const clean = { code: value.code, ...(Number.isInteger(value.httpStatus) && value.httpStatus >= 100 && value.httpStatus <= 599 ? { httpStatus: value.httpStatus } : {}) }; Promise.resolve(nativeBridge()?.reportFailure?.(clean)).catch(() => {}); } catch {} }
function synchronizeNativeAccount(userId) {
  state.nativeContext = Promise.resolve().then(() => nativeBridge()?.setAccountContext?.({ userId })).then((result) => ({ ok: result?.ok === true })).catch(() => { reportFailure({ code: 'ACCOUNT_CONNECT_FAILED' }); return { ok: false }; });
}
const client = createAccountClient({ onChange(bundle) {
  synchronizeNativeAccount(bundle?.user.id ?? null);
  $('login-panel').hidden = Boolean(bundle);
  $('signed-in').hidden = !bundle;
  $('logout').hidden = !bundle;
  $('identity').textContent = bundle ? (bundle.user.display_name || bundle.user.username) : '安全账户中心';
  const home = adminHome(bundle?.user); $('admin-home').hidden = !home;
  if (home) $('admin-home').href = home; else $('admin-home').removeAttribute('href');
  if (!bundle) resetPrivateUI();
  else restoreRecovery(bundle.user.id);
  renderDesktopConnection();
  renderSetupGuide();
} });
// This guide describes the remote account and this page's receipts only. It
// never infers the desktop's saved Key state from a token's group or existence.
function setupGuideState({ keyCount, balanceSufficient, activated, native }) {
  const known = Number.isSafeInteger(keyCount) && keyCount >= 0, hasKey = known && keyCount > 0;
  return {
    key: hasKey ? 'done' : known ? 'current' : 'unknown',
    activation: activated ? 'done' : hasKey ? 'current' : 'waiting',
    status: balanceSufficient === false ? '余额不足，请联系管理员充值。' : activated ? '所选用途已激活。' : !known ? '开通状态待核对。' : !hasKey ? '按需开通用途 Key，无需一次开通四类。' : native ? '选择要使用的 Key，点击“激活”。' : '请在仓鼠AI应用中逐项激活。',
    action: balanceSufficient === false ? 'topup' : 'keys',
    label: balanceSufficient === false ? '联系管理员' : !known ? '查看 API Key' : !hasKey ? '选择用途并开通' : activated ? '管理 API Key' : '查看并激活',
    create: balanceSufficient !== false && known && !hasKey,
  };
}
function renderSetupGuide() {
  const target = $('setup-guide'); if (!target) return;
  target.hidden = !client.current(); if (target.hidden) return;
  const guide = setupGuideState({ keyCount: state.setupKeyCount, balanceSufficient: state.setupBalanceSufficient, activated: [...state.activationResults.values()].some((receipt) => receipt.connected === true), native: Boolean(nativeBridge()?.connectCreatedKey) });
  $('setup-key-step').dataset.state = guide.key; $('setup-activation-step').dataset.state = guide.activation;
  $('setup-status').textContent = guide.status; $('setup-action').textContent = guide.label;
  for (const id of ['setup-key-step', 'setup-activation-step']) { const node = $(id); if (node.dataset.state === 'current') node.setAttribute('aria-current', 'step'); else node.removeAttribute('aria-current'); }
}
async function loadSetupGuide() {
  const account = identity(), revision = ++state.setupRevision;
  try {
    // Only list metadata/counts. Complete Keys require an explicit row action.
    const data = (await client.request('/api/token/?p=1&size=1')).data;
    if (!account || account !== identity() || revision !== state.setupRevision) return;
    state.setupKeyCount = Number.isSafeInteger(data?.total) && data.total >= 0 ? data.total : null;
  } catch (error) {
    if (account !== identity() || revision !== state.setupRevision) return;
    state.setupKeyCount = null;
    if (error?.code === 'ACCOUNT_CHANGED') return;
  }
  renderSetupGuide();
}
function restorePayment(userID) {
  if (!state.returnOrderConsumed && returnOrder && new RegExp(`^USR${userID}NO[A-Za-z0-9]{1,64}$`).test(returnOrder)) {
    state.returnOrderConsumed = true;
    state.paymentOrder = returnOrder;
  }
  if (!state.paymentOrder) state.paymentOrder = recovery.read('pay', userID)?.order || '';
}
function restoreRecovery(userID) {
  restorePayment(userID);
  state.pendingKey = recovery.read('key', userID); updatePendingKey();
  // Earlier automatic handoff metadata is not an explicit activation choice.
  state.activations = new Map(Object.keys(GROUPS).map((group) => [group, recovery.read(`activate-${group}`, userID)]).filter(([, value]) => value));
  state.keyRetryAt = Math.max(0, recovery.read('activation-cooldown', userID)?.retryAt || 0, ...[...state.activations.values()].map((operation) => operation.retryAt || 0));
  renderConnectionStates();
}
const connectSelectedKey = createSelectedKeyConnector({ request: (...args) => client.request(...args), identity: () => ({ userId: client.current()?.user.id, value: identity() }), bridge: nativeBridge, context: () => state.nativeContext, isCurrent: (operation) => state.activations.get(operation.group)?.requestId === operation.requestId, onFailure: reportFailure });
function activationFailureMessage(result) {
  if (result.code === 'ACCOUNT_MISMATCH') return '本机已连接其他账户，请先移除本机 Key';
  if (result.code === 'KEY_INVALID') return 'Key 无效或已过期，请检查 Key 状态后重新激活';
  if (result.code === 'KEY_FORBIDDEN') return 'Key 用途权限不匹配，请选择对应用途的 Key';
  if (result.code === 'KEY_STORAGE_UNAVAILABLE') return '本机密钥保护或保存暂不可用，请重启应用后重新激活';
  if (result.httpStatus === 401) return '账户登录已过期，请刷新账户后重新激活';
  if (result.httpStatus === 403) return '当前账户无权读取此 Key，请检查权限后重新激活';
  return '网络或中转站连接未完成，请检查网络后重新激活';
}
function coolingMessage(retryAt) {
  const seconds = Math.max(1, Math.ceil((retryAt - Date.now()) / 1000)), wait = seconds >= 60 ? `约 ${Math.ceil(seconds / 60)} 分钟` : `${seconds} 秒`;
  return `激活暂受限，${wait}后刷新重试`;
}
function coolDownActivations(delay) {
  state.keyRetryAt = Date.now() + Math.min(3600000, Math.max(1000, Number.isFinite(delay) ? delay : 60000));
  recovery.save('activation-cooldown', client.current().user.id, { startedAt: Date.now(), retryAt: state.keyRetryAt });
  for (const [group, operation] of state.activations) {
    const value = recovery.save(`activate-${group}`, operation.userID, { ...operation, retryAt: state.keyRetryAt });
    state.activations.set(group, value); state.connectionStates.set(group, coolingMessage(state.keyRetryAt));
  }
  renderConnectionStates();
}
function renderConnectionStates() {
  const target = $('key-connection'); if (!target) return;
  target.hidden = !nativeBridge()?.connectCreatedKey;
  target.replaceChildren();
  for (const [group, label] of Object.entries(GROUPS)) {
    const message = state.connectionStates.get(group) || (state.activations.has(group) ? '激活待确认' : '选择 Key 后点击激活');
    const row = el('p', 'connection-row', `${label}：${message}`); row.dataset.group = group; target.append(row);
  }
  renderSetupGuide();
}
async function resumeSelectedKeys() {
  const account = identity(); if (!account) return;
  if (state.keyRecovery?.account === account) return state.keyRecovery.promise;
  const sameAccount = () => account === identity();
  const findOriginal = async (operation) => {
    const response = await client.request(`/api/token/search?keyword=${encodeURIComponent(operation.name)}&p=1&size=20`);
    if (!sameAccount()) return null;
    const rows = response.data?.items;
    if (!Array.isArray(rows) || Number(response.data?.total) > rows.length) return null;
    return findCreatedToken(operation, rows);
  };
  const run = async () => {
    if (state.pendingKey) {
      const operation = state.pendingKey;
      try {
        const row = await findOriginal(operation);
        if (!sameAccount()) return;
        if (state.pendingKey?.name === operation.name && row) {
          recovery.remove('key', operation.userID); state.pendingKey = null; updatePendingKey();
          notice('已找到原 Key，点击“激活”即可连接。');
        }
      } catch (error) { if (!sameAccount()) return; notice(error instanceof AccountError ? error.message : '原 Key 待核对，请稍后刷新。', true); }
    }
    if (!nativeBridge()?.connectCreatedKey) return;
    // The map contains only choices made with an explicit Activate click. Login,
    // listing and creation do not add entries or read complete Keys.
    for (const [group, operation] of state.activations) {
      if (!sameAccount()) return;
      const retryAt = Math.max(state.keyRetryAt, operation.retryAt || 0);
      if (retryAt > Date.now()) { state.connectionStates.set(group, coolingMessage(retryAt)); renderConnectionStates(); continue; }
      let response;
      try { response = await client.request(`/api/token/search?keyword=${encodeURIComponent(operation.name)}&p=1&size=20`); }
      catch (error) {
        if (!sameAccount()) return;
        if (error?.status === 429) { coolDownActivations(error.retryAfterMs); break; }
        state.connectionStates.set(group, activationFailureMessage({ code: 'CONNECT_FAILED', httpStatus: error?.status })); renderConnectionStates();
        reportFailure({ code: 'ACCOUNT_KEY_IMPORT_FAILED', httpStatus: error?.status }); continue;
      }
      if (!sameAccount() || state.activations.get(group)?.requestId !== operation.requestId) continue;
      const row = findSelectedToken(operation, response.data?.items);
      if (!row) { state.connectionStates.set(group, '所选 Key 不可用，请重新选择'); renderConnectionStates(); continue; }
      state.connectionStates.set(group, '正在激活…'); renderConnectionStates();
      const result = await connectSelectedKey(operation, row);
      if (!sameAccount() || state.activations.get(group)?.requestId !== operation.requestId) continue;
      if (result.ok) {
        recovery.remove(`activate-${group}`, operation.userID); state.activations.delete(group);
        // This is an acknowledgement of this operation, not a permanent claim
        // about a row after a restart or a separate local configuration change.
        for (const [id, receipt] of state.activationResults) if (receipt.group === group) state.activationResults.delete(id);
        state.activationResults.set(row.id, { group, connected: result.connected });
        state.connectionStates.set(group, result.connected ? '已激活' : '已保存，待检测；请在“应用连接”中重新检测');
        if (result.httpStatus === 429) coolDownActivations(result.retryAfterMs);
      } else if (result.code === 'RATE_LIMITED') coolDownActivations(result.retryAfterMs);
      else if (result.code !== 'ACCOUNT_CHANGED') state.connectionStates.set(group, activationFailureMessage(result));
      renderConnectionStates();
    }
  };
  const promise = run().finally(() => { if (state.keyRecovery?.promise === promise) state.keyRecovery = null; });
  state.keyRecovery = { account, promise }; return promise;
}
async function activateKey(row) {
  if (!nativeBridge()?.connectCreatedKey) { notice('请在仓鼠AI应用中激活。', true); return; }
  if (state.keyRecovery) { notice('正在处理激活，请稍候。'); return; }
  if (state.keyRetryAt > Date.now()) { notice(coolingMessage(state.keyRetryAt)); return; }
  const operation = selectedKeyOperation(row, client.current()?.user.id, secureUUID());
  state.activations.set(row.group, recovery.save(`activate-${row.group}`, operation.userID, operation));
  state.connectionStates.set(row.group, '正在激活…'); renderConnectionStates();
  await resumeSelectedKeys();
  if (operation.userID !== client.current()?.user.id) return;
  await loadKeys({ resume: false });
  if (state.activationResults.has(row.id)) notice();
}
function updatePendingKey() {
  $('new-key').disabled = Boolean(state.pendingKey); $('key-pending').hidden = !state.pendingKey;
  $('key-pending').textContent = state.pendingKey ? `“${state.pendingKey.name}”的开通结果待核对。请点击“刷新账户”查找原记录；不要重复开通。若记录持续不可查，请联系账户支持核实。` : '';
  $('key-form').querySelector('[type=submit]').disabled = Boolean(state.pendingKey);
}
function el(tag, className, text) { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; }
function notice(message = '', error = false) { $('notice').hidden = !message; $('notice').textContent = message; $('notice').classList.toggle('error', error); }
function formatCny(value, maximumFractionDigits = 6) { return value == null ? '金额暂不可用' : new Intl.NumberFormat('zh-CN', { style: 'currency', currency: 'CNY', minimumFractionDigits: 2, maximumFractionDigits }).format(value); }
function money(quota, maximumFractionDigits = 6) { return formatCny(cnyFromQuota(quota, state.status), maximumFractionDigits); }
function settlementMoney(quota) { return formatCny(Number.isSafeInteger(quota) ? quota / 1_000_000 : null); }
function date(value) { return Number(value) > 0 ? new Date(Number(value) * 1000).toLocaleString('zh-CN', { hour12: false }) : '—'; }
function safeAction(action) { return async (event) => { try { await action(event); } catch (error) { if (error?.code !== 'ACCOUNT_CHANGED') notice(error instanceof AccountError ? error.message : '操作未完成，请稍后刷新核对。', true); } }; }
function identity() { const value = client.current(); return value ? `${value.user.id}:${value.session.sid}:${client.generation()}` : ''; }
function button(text, action, className = 'text-button') { const node = el('button', className, text); node.type = 'button'; node.addEventListener('click', safeAction(async () => { if (node.disabled) return; node.disabled = true; try { await action(); } finally { if (node.isConnected) node.disabled = false; } })); return node; }
function loading(container) { container.replaceChildren(el('div', 'empty', '正在读取…')); }
function empty(container, message) { container.replaceChildren(el('div', 'empty', message)); }
function closeReveals() { state.revealRevision++; for (const { input, action, copy, timer } of state.reveals.values()) { clearTimeout(timer); input.value = ''; input.remove(); copy.remove(); action.textContent = '查看 Key'; } state.reveals.clear(); }
function resetPrivateUI() {
  state.desktopReady = !state.desktopFlow; state.desktopRequiresApproval = false; state.desktopExpiresAt = 0;
  stopPaymentChecks();
  state.loading.clear();
  state.setupRevision++; state.setupKeyCount = null; state.setupBalanceSufficient = null;
  closeReveals(); state.orderRevision++; state.keyRevision++; state.groups = {}; state.pendingKey = null; state.paymentOrder = ''; updatePendingKey();
  for (const id of ['usage-list', 'order-list', 'key-list']) $(id).replaceChildren();
  for (const id of ['balance-value', 'used-value', 'request-value']) $(id).textContent = '—';
  for (const id of ['key-dialog', 'confirm-dialog']) { if ($(id).open) closeDialog($(id)); }
  $('key-form').reset(); state.pages = { usage: 1, order: 1, key: 1 };
  state.activations.clear(); state.connectionStates.clear(); state.activationResults.clear(); state.keyRetryAt = 0; renderConnectionStates();
}
async function confirmAction(title, message, label = '确认') {
  const dialog = $('confirm-dialog'); if (dialog.open) return false;
  $('confirm-title').textContent = title; $('confirm-message').textContent = message; $('confirm-ok').textContent = label;
  return new Promise((resolve) => {
    const finish = (accepted) => { dialog.removeEventListener('close', closed); $('confirm-ok').removeEventListener('click', yes); $('confirm-cancel').removeEventListener('click', no); closeDialog(dialog); resolve(accepted); };
    const closed = () => finish(false), yes = () => finish(true), no = () => finish(false);
    dialog.addEventListener('close', closed); $('confirm-ok').addEventListener('click', yes); $('confirm-cancel').addEventListener('click', no); openDialog(dialog);
  });
}
async function loadBalance() {
  const account = identity();
  const data = (await client.request('/api/user/self')).data;
  if (!account || account !== identity()) return;
  if (data?.id !== client.current()?.user.id) { client.clear(); throw new AccountError('账户身份不一致，请重新登录。', 'ACCOUNT_CHANGED'); }
  $('balance-value').textContent = money(data.quota, 2); $('used-value').textContent = money(data.used_quota, 2);
  $('request-value').textContent = Number.isFinite(Number(data.request_count)) ? Number(data.request_count).toLocaleString('zh-CN') : '—';
  const balance = cnyFromQuota(data.quota, state.status); state.setupBalanceSufficient = balance === null ? null : balance > 0; renderSetupGuide();
}
function pager(kind, total, pageSize = 20) {
  state.totals[kind] = Number(total) || 0;
  $(`${kind}-page`).textContent = `第 ${state.pages[kind]} 页 · 共 ${state.totals[kind]} 条`;
  $(`${kind}-prev`).disabled = state.pages[kind] <= 1;
  $(`${kind}-next`).disabled = state.pages[kind] * pageSize >= state.totals[kind];
}
const financial = { reserved: '额度已预留', pending_review: '待核对', settled: '已结算', partially_refunded: '已部分退款', refunded: '已退款' };
async function loadUsage() {
  const list = $('usage-list'); loading(list);
  const page = state.pages.usage, kind = $('usage-kind').value, account = identity();
  try {
    const path = kind === 'settlements' ? `/api/pikno/settlements/self?page=${page}` : `/api/log/self?p=${page}&page_size=20&type=2`;
    const data = (await client.request(path)).data;
    if (account !== identity() || kind !== $('usage-kind').value || page !== state.pages.usage) return;
    const items = Array.isArray(data?.items) ? data.items : []; list.replaceChildren();
    for (const row of items) {
      const card = el('article', 'record'), top = el('div', 'record-top');
      const title = kind === 'settlements' && row.model === 'pikno-image-flare' ? '图片生成'
        : GROUPS[row.group] || (kind === 'settlements' ? '媒体任务结算' : 'API 消费');
      top.append(el('span', 'record-title', title), el('strong', 'record-amount', kind === 'settlements' ? settlementMoney(row.net_quota) : money(row.quota)));
      card.append(top);
      if (kind === 'settlements') {
        const label = row.review_required ? '待核对' : (financial[row.financial_state] || '处理中');
        card.append(el('p', 'record-meta', `${date(row.created_at)} · 订单 ${row.order_id}`), el('span', `pill${row.review_required ? ' review' : ''}`, label), el('p', 'record-meta', `当前预留 ${settlementMoney(row.reserved_quota)} · 已退回 ${settlementMoney(row.refunded_quota)}`));
      } else card.append(el('p', 'record-meta', `${date(row.created_at)}${row.token_name ? ` · ${row.token_name}` : ''}`));
      list.append(card);
    }
    if (!items.length) empty(list, kind === 'settlements' ? '暂无任务结算记录' : '暂无消费记录');
    pager('usage', data?.total);
  } catch (error) { if (account === identity()) empty(list, '记录暂未读取，点击刷新账户重试。'); throw error; }
}
function renderDesktopConnection() {
  const user = client.current()?.user;
  const rechargeAccount = $('manual-recharge-account');
  const verified = user && (!state.desktopFlow || state.desktopReady && state.desktopExpiresAt > Date.now() / 1000);
  rechargeAccount.hidden = !verified;
  rechargeAccount.textContent = !verified ? '' : user.username
    ? `充值账户：${user.username}（用户 ID：${user.id}）` : `用户 ID：${user.id}`;

  const panel = $('desktop-connection');
  panel.hidden = !state.desktopFlow || !user;
  if (panel.hidden) return;
  $('desktop-account').textContent = `当前网页账号：${user.username || user.id}`;
  $('desktop-message').textContent = state.desktopMessage || '正在核对仓鼠 AI 连接…';
  $('desktop-connect').hidden = !state.desktopRequiresApproval;
  const code = state.desktopFlow.slice(0, 8).toUpperCase();
  $('desktop-code').hidden = !state.desktopRequiresApproval;
  $('desktop-code').textContent = state.desktopRequiresApproval ? `请核对仓鼠 AI 中显示的连接码：${code.slice(0, 4)}-${code.slice(4)}` : '';
  $('desktop-connect').disabled = state.desktopBusy || state.suspended;
  $('desktop-retry').hidden = !state.desktopError;
  $('desktop-retry').disabled = state.desktopBusy;
  $('desktop-switch').hidden = !state.desktopMismatch;
  $('desktop-switch').disabled = state.desktopBusy;
}

async function loadDesktopConnection(approve = false) {
  if (!state.desktopFlow || !client.current() || state.desktopBusy || state.suspended) return;
  const account = identity();
  state.desktopReady = false; state.desktopBusy = true; state.desktopError = false; state.desktopMismatch = false;
  renderDesktopConnection();
  try {
    if (!/^[A-Za-z0-9_-]{43}$/.test(state.desktopFlow)) throw new AccountError('连接已失效，请回到仓鼠 AI 重新打开充值。', 'DESKTOP_FLOW_INVALID');
    const body = { flow_id: state.desktopFlow, ...(approve ? { confirmed: true } : {}) };
    const { data } = await client.request(`/api/user/desktop/${approve ? 'approve' : 'inspect'}`, { method: 'POST', body });
    if (account !== identity() || state.suspended) return;
    if (data?.flow_id !== state.desktopFlow || data.account_matched !== true || !['connect', 'recharge'].includes(data.purpose)
      || !['pending', 'approved', 'ready', 'complete'].includes(data.status) || !Number.isSafeInteger(data.expires_at) || data.expires_at <= Date.now() / 1000) throw new AccountError('连接已失效，请回到仓鼠 AI 重新打开充值。', 'DESKTOP_FLOW_INVALID');
    state.desktopExpiresAt = data.expires_at;
    state.desktopRequiresApproval = data.purpose === 'connect' && data.status === 'pending' && data.requires_approval === true;
    state.desktopReady = ['approved', 'ready', 'complete'].includes(data.status) && data.requires_approval === false;
    state.desktopMessage = state.desktopRequiresApproval ? '连接当前打开的仓鼠 AI 后，应用会自动配置创作用途。' : state.desktopReady ? '账号已核对。完成充值后，请手动返回仓鼠 AI 使用。' : '连接尚未就绪，请稍后重新核对。';
  } catch (error) {
    if (account !== identity()) return;
    state.desktopRequiresApproval = false; state.desktopError = true;
    state.desktopMismatch = error?.code === 'DESKTOP_ACCOUNT_MISMATCH';
    state.desktopMessage = state.desktopMismatch ? '网页账号与仓鼠 AI 账号不一致，请切换网页账号后继续充值。' : error?.code === 'DESKTOP_FLOW_INVALID' || error?.code === 'DESKTOP_FLOW_COMPLETE' ? '连接已失效，请回到仓鼠 AI 重新打开充值。' : '连接暂未确认，请重新核对。';
  } finally {
    state.desktopBusy = false; renderDesktopConnection();
  }
}

function stopPaymentChecks() {
  clearTimeout(state.paymentTimer); state.paymentTimer = null; state.paymentChecksLeft = 0;
}

function schedulePaymentCheck(reset = false) {
  if (reset) state.paymentChecksLeft = 7;
  if (state.paymentTimer != null || state.suspended || !state.paymentOrder || !state.paymentChecksLeft || document.visibilityState === 'hidden') return;
  const delay = [30000, 24000, 16000, 12000, 8000, 4000, 1500][state.paymentChecksLeft - 1];
  state.paymentTimer = setTimeout(async () => {
    state.paymentTimer = null; state.paymentChecksLeft--;
    try { await checkPayment(); } catch { /* The next check or a manual refresh can recover. */ }
    schedulePaymentCheck();
  }, delay);
}

function applyPaymentStatus(row, order, account) {
  if (account !== identity() || order !== state.paymentOrder || row?.trade_no !== order || !['success', 'cancelled', 'expired', 'failed'].includes(row.status)) return false;
  try { recovery.removePayment(client.current().user.id, order); } catch { /* Status tracking does not require browser storage. */ }
  stopPaymentChecks(); state.paymentOrder = '';
  notice({ success: '充值已入账。', cancelled: '充值订单已取消。', expired: '历史充值订单已过期。', failed: '充值订单未完成。' }[row.status]);
  return true;
}

async function checkPayment({ explicit = false } = {}) {
  const order = state.paymentOrder, account = identity();
  if (!order || !account || state.suspended) return;
  if (state.paymentCheck?.order === order && state.paymentCheck.account === account) return state.paymentCheck.promise;
  const promise = (async () => {
    const { data } = await client.request(`/api/user/topup/status?trade_no=${encodeURIComponent(order)}`);
    if (account !== identity() || order !== state.paymentOrder || data?.trade_no !== order) return;
    if (applyPaymentStatus(data, order, account)) {
      if (!explicit) await Promise.allSettled([loadBalance(), loadOrders()]);
    } else if (explicit) notice('历史充值订单待核对。若已付款，请联系管理员。');
  })();
  state.paymentCheck = { order, account, promise };
  try { await promise; } finally { if (state.paymentCheck?.promise === promise) state.paymentCheck = null; }
}

async function loadOrders() {
  const list = $('order-list'), page = state.pages.order, revision = ++state.orderRevision, account = identity(); loading(list);
  try {
    const data = (await client.request(`/api/user/topup/self?p=${page}&page_size=20`)).data;
    if (account !== identity() || page !== state.pages.order || revision !== state.orderRevision) return;
    const items = Array.isArray(data?.items) ? data.items : []; list.replaceChildren();
    const statuses = { pending: '待核对', closing: '正在关单', cancelled: '已取消', success: '已入账', expired: '已过期', failed: '未完成' };
    for (const row of items) {
      const card = el('article', 'record'), top = el('div', 'record-top');
      top.append(el('span', 'record-title', row.payment_method === 'alipay' ? '支付宝充值' : row.payment_method === 'wxpay' ? '微信充值' : '账户充值'), el('strong', 'record-amount', `¥${Number(row.money).toFixed(2)}`));
      const label = statuses[row.status] || '待核对';
      card.append(top, el('p', 'record-meta', `${date(row.create_time)} · ${row.trade_no || '订单处理中'}`), el('span', `pill${row.status === 'pending' ? ' review' : ''}`, label));
      list.append(card);
    }
    if (!items.length) empty(list, '暂无历史充值订单');
    pager('order', data?.total);
    const pending = state.paymentOrder && items.find((row) => row.trade_no === state.paymentOrder);
    if (pending && applyPaymentStatus(pending, state.paymentOrder, account) && pending.status === 'success') void loadBalance().catch(() => {});
  } catch (error) { if (revision === state.orderRevision) empty(list, '订单暂未读取，请稍后刷新核对。'); throw error; }
}
async function revealKey(row, card, action, holder) {
  const revealed = state.reveals.get(row.id);
  if (revealed) { clearTimeout(revealed.timer); revealed.input.value = ''; revealed.input.remove(); revealed.copy.remove(); state.reveals.delete(row.id); action.textContent = '查看 Key'; return; }
  const sid = client.current()?.session.sid, revision = state.revealRevision;
  const data = (await client.request(`/api/token/${row.id}/key`, { method: 'POST' })).data;
  if (sid !== client.current()?.session.sid || revision !== state.revealRevision || state.tab !== 'keys' || !card.isConnected || document.visibilityState === 'hidden') return;
  if (typeof data?.key !== 'string' || !data.key) throw new AccountError('Key 暂时无法读取。');
  const input = el('input', 'key-value'); input.readOnly = true; input.type = 'text'; input.value = data.key; input.setAttribute('aria-label', `${row.name} 的完整 Key`);
  const copy = button('复制 Key', async () => { if (sid !== client.current()?.session.sid || state.reveals.get(row.id)?.input !== input) return; try { await navigator.clipboard.writeText(input.value); if (sid === client.current()?.session.sid && state.reveals.get(row.id)?.input === input) notice('Key 已复制，请妥善保管。'); } catch { if (sid !== client.current()?.session.sid || state.reveals.get(row.id)?.input !== input) return; input.focus(); input.select(); input.setSelectionRange(0, input.value.length); notice('Key 已选中。电脑请按 Ctrl+C 或 ⌘C；手机请长按选区后选择“复制”。'); } });
  action.textContent = '隐藏 Key'; holder.append(copy); card.append(input);
  const timer = setTimeout(() => { if (state.reveals.has(row.id)) { input.value = ''; input.remove(); copy.remove(); action.textContent = '查看 Key'; state.reveals.delete(row.id); } }, 60000);
  state.reveals.set(row.id, { input, action, copy, timer });
}
async function loadKeys({ resume = true } = {}) {
  closeReveals(); const list = $('key-list'), page = state.pages.key, revision = ++state.keyRevision, account = identity(); loading(list);
  try {
    const [response, groupResponse] = await Promise.all([client.request(`/api/token/?p=${page}&size=20`), client.request('/api/user/self/groups')]);
    if (account !== identity() || page !== state.pages.key || revision !== state.keyRevision) return;
    state.groups = groupResponse.data || {}; const items = Array.isArray(response.data?.items) ? response.data.items.map(tokenMetadata) : []; list.replaceChildren();
    state.setupRevision++; state.setupKeyCount = Number.isSafeInteger(response.data?.total) && response.data.total >= 0 ? response.data.total : null; renderSetupGuide();
    if (resume) await resumeSelectedKeys();
    if (account !== identity() || page !== state.pages.key || revision !== state.keyRevision) return;
    for (const row of items) {
      if (!Number.isInteger(row.id) || row.id <= 0) continue;
      const card = el('article', 'key-card'), top = el('div', 'key-top'), actions = el('div', 'key-actions');
      const labels = { 1: '可用', 2: '已停用', 3: '已过期', 4: '额度已用完' };
      top.append(el('strong', '', row.name || '未命名 Key'), el('span', 'pill', labels[row.status] || '待核对'));
      const group = GROUPS[row.group] || '其他用途';
      card.append(top, el('p', 'record-meta', `${group} · ${row.expired_time === -1 ? '长期有效' : `到期 ${date(row.expired_time)}`}`), el('p', 'record-meta', row.unlimited_quota ? '消费上限：跟随账户可用余额' : `Key 剩余限额：${money(row.remain_quota)}`));
      const reveal = button('查看 Key', () => revealKey(row, card, reveal, actions)); actions.append(reveal);
      if (row.status === 1 && hasOwn(GROUPS, row.group)) {
        const receipt = state.activationResults.get(row.id), native = Boolean(nativeBridge()?.connectCreatedKey);
        const activate = button(receipt ? receipt.connected ? '已激活' : '已保存，待检测' : native ? '激活' : '在应用中激活', () => activateKey(row), 'primary activate-key');
        activate.dataset.action = 'activate-key'; activate.dataset.keyId = String(row.id);
        activate.disabled = !native || Boolean(receipt); actions.prepend(activate);
      }
      actions.append(button(row.status === 1 ? '停用' : '启用', async () => {
        if (!await confirmAction(row.status === 1 ? '停用 Key' : '启用 Key', `确认${row.status === 1 ? '停用' : '启用'}“${row.name}”？`)) return;
        await client.request('/api/token/?status_only=true', { method: 'PUT', body: { id: row.id, status: row.status === 1 ? 2 : 1 } }); await loadKeys(); notice('Key 状态已更新。');
      }));
      actions.append(button('撤销', async () => {
        if (!await confirmAction('撤销 Key', `撤销“${row.name}”后，使用它的应用将无法继续请求。此操作无法恢复。`, '确认撤销')) return;
        await client.request(`/api/token/${row.id}/`, { method: 'DELETE' }); await loadKeys(); notice('Key 已撤销。');
      })); card.append(actions); list.append(card);
    }
    if (!items.length) empty(list, '尚未开通 API Key，点击右上角开始。');
    pager('key', response.data?.total);
  } catch (error) { if (revision === state.keyRevision) empty(list, 'Key 列表暂未读取，点击刷新账户重试。'); throw error; }
}
async function openKeyDialog() {
  if (state.pendingKey) throw new AccountError('上一次开通结果仍待核对，请先刷新列表。');
  const account = identity();
  const groups = (await client.request('/api/user/self/groups')).data || {};
  if (account !== identity()) return;
  state.groups = groups;
  const select = $('key-form').elements.group; select.replaceChildren();
  for (const [group, label] of Object.entries(GROUPS)) if (hasOwn(state.groups, group)) { const option = el('option', '', label); option.value = group; select.append(option); }
  if (!select.options.length) throw new AccountError('当前账户尚无可开通用途。');
  $('key-error').hidden = true; $('key-form').reset(); openDialog($('key-dialog'));
}
async function createKey(event) {
  event.preventDefault(); const form = $('key-form'), submit = form.querySelector('[type=submit]'); if (submit.disabled) return;
  submit.disabled = true; $('key-error').hidden = true;
  let userID, created = false; const account = identity();
  try {
    const payload = keyPayload(form.elements.name.value, form.elements.group.value, form.elements.days.value, form.elements.limit.value, state.status, state.groups);
    const requestId = secureUUID();
    payload.name = `${payload.name.slice(0, 30)} ·${requestId.replaceAll('-', '').slice(0, 16)}`;
    userID = client.current().user.id;
    state.pendingKey = recovery.save('key', userID, { name: payload.name, group: payload.group, startedAt: Date.now(), requestId }); updatePendingKey();
    await client.request('/api/token/', { method: 'POST', body: payload });
    created = true;
    if (account !== identity()) return;
    closeDialog($('key-dialog')); form.reset(); await loadKeys();
    if (account === identity()) notice(nativeBridge()?.connectCreatedKey ? 'API Key 已开通，点击“激活”即可连接。' : 'API Key 已开通，请在仓鼠AI应用中激活。');
  } catch (error) {
    if (error?.code === 'ACCOUNT_CHANGED' || account !== identity()) return;
    if (!created && userID && [400, 401, 403, 404, 405, 413, 415, 422, 429].includes(error.status) && userID === client.current()?.user.id) { recovery.remove('key', userID); state.pendingKey = null; updatePendingKey(); }
    if (state.pendingKey) reportFailure({ code: 'ACCOUNT_KEY_CREATE_UNKNOWN', httpStatus: error?.status });
    const message = error instanceof AccountError ? error.message : '开通未确认完成，请先关闭窗口并刷新列表核对。';
    if ($('key-dialog').open) { $('key-error').hidden = false; $('key-error').textContent = message; } else notice(message, true);
  }
  finally { submit.disabled = Boolean(state.pendingKey); }
}
async function loadTab(tab) {
  if (!client.current() || state.loading.has(tab)) return;
  const generation = client.generation();
  state.loading.add(tab);
  try { if (tab === 'balance') await loadBalance(); else if (tab === 'usage') await loadUsage(); else if (tab === 'topup') await loadOrders(); else if (tab === 'keys') await loadKeys(); }
  finally { if (generation === client.generation()) state.loading.delete(tab); }
}
async function switchTab(tab) {
  closeReveals(); state.tab = tab; saveAccountTab(tab);
  for (const node of document.querySelectorAll('[data-tab]')) node.setAttribute('aria-selected', String(node.dataset.tab === tab));
  for (const node of document.querySelectorAll('.tab-panel')) node.hidden = node.id !== tab;
  await loadTab(tab);
}
async function bootstrap() {
  if (state.suspended) return;
  if (state.bootstrap) return state.bootstrap;
  const generation = client.generation();
  $('refresh').disabled = true;
  state.bootstrap = (async () => {
    notice();
    try {
      const [statusResult, authResult] = await Promise.allSettled([client.publicStatus(), client.refresh()]);
      if (state.suspended || generation !== client.generation()) return;
      if (statusResult.status === 'fulfilled') state.status = statusResult.value;
      if (authResult.status === 'rejected') { if (!['LOGIN_REQUIRED', 'ACCOUNT_CHANGED'].includes(authResult.reason?.code)) throw authResult.reason; return; }
      await loadDesktopConnection();
      if (state.suspended || generation !== client.generation()) return;
      if (returnOrder && state.paymentOrder === returnOrder) void checkPayment().catch(() => {});
      await loadBalance();
      if (state.suspended || generation !== client.generation()) return;
      await resumeSelectedKeys();
      if (state.suspended || generation !== client.generation()) return;
      if (state.tab !== 'balance') await loadTab(state.tab); else await loadSetupGuide();
      if (state.suspended || generation !== client.generation()) return;
      if (state.paymentOrder) schedulePaymentCheck(true);
      state.lastRefresh = Date.now();
      if (statusResult.status === 'rejected') notice('账户已连接，金额显示配置暂不可用，请稍后刷新。', true);
    } catch (error) { if (state.suspended || generation !== client.generation()) return; reportFailure({ code: 'ACCOUNT_CONNECT_FAILED', httpStatus: error?.status }); notice(error instanceof AccountError ? error.message : '账户暂时无法连接，请稍后刷新。', true); }
  })().finally(() => { state.bootstrap = null; $('refresh').disabled = false; });
  return state.bootstrap;
}
$('refresh').addEventListener('click', safeAction(bootstrap));
$('desktop-connect').addEventListener('click', safeAction(() => loadDesktopConnection(true)));
$('desktop-retry').addEventListener('click', safeAction(() => loadDesktopConnection()));
$('desktop-switch').addEventListener('click', safeAction(async () => {
  if (state.desktopBusy || !state.desktopMismatch) return;
  await client.logout();
  window.top.location.assign('/auth-lite/index.html?mode=login&redirect=%2Fhub%2Fbilling');
}));
if (state.desktopFlow || entryTab === 'topup') {
  for (const link of $('login-panel').querySelectorAll('a')) {
    const target = new URL(link.href, location.origin);
    if (target.origin !== location.origin || target.pathname !== '/auth-lite/index.html') continue;
    target.searchParams.set('redirect', '/hub/billing');
    if (state.desktopFlow) target.hash = `desktop=${state.desktopFlow}`;
    link.href = target.href;
  }
}
$('setup-action').addEventListener('click', safeAction(async () => {
  const guide = setupGuideState({ keyCount: state.setupKeyCount, balanceSufficient: state.setupBalanceSufficient, activated: [...state.activationResults.values()].some((receipt) => receipt.connected === true), native: Boolean(nativeBridge()?.connectCreatedKey) });
  await switchTab(guide.action);
  if (guide.create && client.current() && state.setupKeyCount === 0) await openKeyDialog();
}));
for (const node of document.querySelectorAll('[data-tab]')) node.addEventListener('click', safeAction(() => switchTab(node.dataset.tab)));
for (const node of document.querySelectorAll('[data-go]')) node.addEventListener('click', safeAction(() => {
  if (document.documentElement.dataset.embedded === 'true' && node.dataset.go === 'topup') {
    window.top.location.assign('/hub/billing');
    return;
  }
  return switchTab(node.dataset.go);
}));
$('usage-kind').addEventListener('change', safeAction(async () => { state.pages.usage = 1; await loadUsage(); }));
for (const [kind, load] of [['usage', loadUsage], ['order', loadOrders], ['key', loadKeys]]) for (const direction of ['prev', 'next']) $(`${kind}-${direction}`).addEventListener('click', safeAction(async () => { state.pages[kind] += direction === 'next' ? 1 : -1; await load(); }));
$('new-key').addEventListener('click', safeAction(openKeyDialog));
async function refreshOrders() {
  const node = $('refresh-orders');
  if (node.disabled) return;
  node.disabled = true;
  try {
    await checkPayment({ explicit: true }).catch(() => {});
    await Promise.all([loadBalance(), loadOrders()]);
  } finally { node.disabled = false; }
}
$('refresh-orders').addEventListener('click', safeAction(refreshOrders));
$('key-form').addEventListener('submit', createKey); $('close-key').addEventListener('click', () => closeDialog($('key-dialog')));
$('key-dialog').addEventListener('close', () => { $('key-form').reset(); $('key-error').textContent = ''; });
$('logout').addEventListener('click', safeAction(async () => { if (!await confirmAction('退出账户', '退出当前账户登录？应用中已保存的创作用途 Key 由应用单独管理。', '退出登录')) return; const sid = client.current()?.session.sid; await client.logout(); try { authChannel?.postMessage({ kind: 'signed_out', sid, source: 'hamster-account-lite', nonce: secureUUID(), timestamp: Date.now() }); } catch {} notice('已退出账户。'); }));
let authChannel = null;
function openAuthChannel() {
  if (authChannel || typeof BroadcastChannel === 'undefined') return;
  // Cross-tab notifications are optional. A denied channel must not blank the
  // account page; authenticated same-origin requests remain authoritative.
  try {
    authChannel = new BroadcastChannel('new-api:auth-session');
    authChannel.addEventListener('message', (event) => { const value = event.data; if (!value || value.source === 'hamster-account-lite' || !['authenticated', 'signed_out'].includes(value.kind) || typeof value.sid !== 'string' || typeof value.source !== 'string' || Math.abs(Date.now() - value.timestamp) >= 60000) return; client.clear(); notice('登录状态已改变，请刷新账户后继续。'); });
  } catch { authChannel = null; }
}
function restorePage() {
  if (state.restoring && !state.suspended) return state.restoring;
  state.suspended = false; client.clear(); openAuthChannel();
  state.restoreAgain = true;
  if (state.restoring) return state.restoring;
  const run = async () => {
    while (state.restoreAgain && !state.suspended) {
      state.restoreAgain = false;
      if (state.bootstrap) await state.bootstrap;
      if (state.suspended) return;
      // clear() invalidates pre-navigation requests; drain an old bootstrap
      // before one fresh read flow. Pending writes are metadata to reconcile,
      // never instructions to create an order, pay, or create another Key.
      state.loading.clear(); state.lastRefresh = 0;
      await bootstrap();
    }
  };
  const promise = run().finally(() => { if (state.restoring === promise) state.restoring = null; });
  state.restoring = promise; return promise;
}
openAuthChannel();
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') { closeReveals(); if ($('key-dialog').open) closeDialog($('key-dialog')); stopPaymentChecks(); return; }
  if (!state.suspended && !state.restoring) {
    schedulePaymentCheck(true);
    if (Date.now() - state.lastRefresh > 30000) void bootstrap();
  }
});
window.addEventListener('focus', () => schedulePaymentCheck(true));
window.addEventListener('blur', closeReveals);
document.addEventListener('hamster-account-view-hidden', closeReveals);
window.addEventListener('pagehide', () => { state.suspended = true; client.clear(); stopPaymentChecks(); authChannel?.close(); authChannel = null; });
window.addEventListener('pageshow', (event) => { if (event.persisted) void restorePage(); });
state.tab = entryTab;
if (entryTab === 'usage' && initialURL.searchParams.get('kind') === 'settlements') $('usage-kind').value = 'settlements';
for (const node of document.querySelectorAll('[data-tab]')) node.setAttribute('aria-selected', String(node.dataset.tab === entryTab));
for (const node of document.querySelectorAll('.tab-panel')) node.hidden = node.id !== entryTab;
window.dispatchEvent(new Event('hamster-lite-ready'));
void bootstrap();
