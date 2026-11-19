import { createAuthClient, pendingStore, safeRedirect, loginTarget } from './client.mjs';
import { secureUUID, desktopFlowContext } from '../account-lite/compat.mjs';
import { mountLocalChallenge } from './local-challenge.mjs';

const $ = (id) => document.getElementById(id);
const entry = new URL(location.href);
let mode = ['login', 'register', 'forgot', 'reset'].includes(entry.searchParams.get('mode')) ? entry.searchParams.get('mode') : 'login';
let storage; try { storage = sessionStorage; } catch { /* Storage can be unavailable. */ }
const desktopFlow = desktopFlowContext(storage, entry.hash);
const redirect = desktopFlow ? '/hub/billing' : safeRedirect(entry.searchParams.get('redirect'), location.origin, 10);
let resetEmail = entry.searchParams.get('email') || '', resetToken = entry.searchParams.get('token') || '';
const entryURL = (nextMode) => { const value = new URL('/auth-lite/index.html', location.origin); value.searchParams.set('mode', nextMode); if (redirect) value.searchParams.set('redirect', redirect); if (desktopFlow) value.hash = `desktop=${desktopFlow}`; return `${value.pathname}${value.search}${value.hash}`; };
// Remove email-link credentials before status fetches, external challenges or navigation.
history.replaceState(null, '', entryURL(mode).split('#')[0]);
const pending = pendingStore(storage), client = createAuthClient({ pending });
let status = null, busy = false, verifying = false, challengeOnlyPasskey = false, turnstileToken = '', widget, localWidget, cooldownUntil = 0, cooldownTimer, secretTimer, operationEpoch = 0, challengeEpoch = 0;
const titles = { login: ['登录账户', '登录后管理余额、充值与 API Key。', '登录'], register: ['注册账户', '创建仓鼠AI账户，连接你的创作工具。', '创建账户'], forgot: ['找回密码', '我们将向账户邮箱发送密码重置链接。', '发送重置邮件'], reset: ['重置密码', '核对邮箱后，确认生成新的账户密码。', '确认重置密码'] };

function notice(message = '', error = false) { $('notice').textContent = message; $('notice').hidden = !message; $('notice').classList.toggle('error', error); }
function field(name, visible, required = false) { const group = $(`${name}-field`); group.hidden = !visible; for (const input of group.querySelectorAll('input')) { input.disabled = !visible; input.required = visible && required; } }
function legalRequired() { return mode !== 'forgot' && !verifying && !!(status?.user_agreement_enabled || status?.privacy_policy_enabled); }
function turnstileRequired() { return !verifying && mode !== 'reset' && !!status?.turnstile_check; }
function canUsePassword() { return mode !== 'login' || status?.password_login_enabled !== false; }
function hasAlternatives() { return !!(status?.passkey_login || status?.wechat_login || status?.github_oauth || status?.discord_oauth || status?.oidc_enabled || status?.linuxdo_oauth || status?.telegram_oauth || status?.custom_oauth_providers?.length); }
function updateButton() {
  $('submit').disabled = busy || !status || desktopFlow === 'invalid' || !canUsePassword() || challengeOnlyPasskey || !!client.unknown() || (mode === 'forgot' && Date.now() < cooldownUntil) || (legalRequired() && !$('consent').checked) || (turnstileRequired() && !turnstileToken);
  $('send-code').disabled = busy || !status || Date.now() < cooldownUntil || (turnstileRequired() && !turnstileToken);
  $('confirm-reset').disabled = busy || !!client.unknown() || !resetEmail || !resetToken;
  $('check-session').disabled = busy;
}
function render() {
  const [heading, description, submit] = titles[mode];
  $('heading').textContent = verifying ? '验证账户身份' : heading;
  $('description').textContent = verifying ? '请输入动态验证码或一枚尚未使用的备用码。' : description;
  $('submit').textContent = verifying ? '确认验证' : submit;
  $('auth-form').hidden = mode === 'reset' || challengeOnlyPasskey;
  field('username', !verifying && ['login', 'register'].includes(mode), true);
  field('email', !verifying && ['register', 'forgot'].includes(mode), mode === 'forgot' || !!status?.email_verification);
  field('password', !verifying && ['login', 'register'].includes(mode), true);
  $('password').autocomplete = mode === 'register' ? 'new-password' : 'current-password';
  field('confirm', !verifying && mode === 'register', true);
  field('verification', !verifying && mode === 'register' && !!status?.email_verification, true);
  field('otp', verifying && !challengeOnlyPasskey, true);
  $('reset-panel').hidden = mode !== 'reset' || !$('reset-result').hidden;
  $('reset-email').value = resetEmail;
  $('legal').hidden = !legalRequired();
  $('agreement-link').hidden = !status?.user_agreement_enabled;
  $('privacy-link').hidden = !status?.privacy_policy_enabled;
  $('legal-and').hidden = !(status?.user_agreement_enabled && status?.privacy_policy_enabled);
  $('turnstile').hidden = !turnstileRequired();
  $('login-link').hidden = mode === 'login' && !verifying;
  $('register-link').hidden = mode === 'register' || status?.register_enabled === false || status?.password_register_enabled === false || verifying;
  $('forgot-link').hidden = mode === 'forgot' || verifying;
  $('advanced').hidden = !(hasAlternatives() || challengeOnlyPasskey || !canUsePassword());
  $('challenge-actions').hidden = !verifying;
  for (const [id, nextMode] of [['login-link', 'login'], ['register-link', 'register'], ['forgot-link', 'forgot'], ['unknown-login', 'login']]) $(id).href = entryURL(nextMode);
  const advanced = new URL('/sign-in', location.origin); advanced.searchParams.set('compat', '1'); if (redirect) advanced.searchParams.set('redirect', redirect); $('advanced-link').href = `${advanced.pathname}${advanced.search}`;
  if (mode === 'register' && (status?.register_enabled === false || status?.password_register_enabled === false)) { $('auth-form').hidden = true; notice('当前未开放密码注册。请使用已有账户登录，或选择已开放的其他登录方式。'); }
  if (!canUsePassword()) { $('auth-form').hidden = true; notice('当前未开放密码登录。请使用其他已开放的安全登录方式。'); }
  updateButton();
  if (desktopFlow === 'invalid') notice('连接已失效，请回到仓鼠 AI 重新点击“去中转站充值”。', true);
}
function resetTurnstile() { turnstileToken = ''; if (localWidget) localWidget.reset(); if (widget !== undefined && typeof window.turnstile?.reset === 'function') { try { window.turnstile.reset(widget); } catch { /* Keep submissions disabled until a new challenge arrives. */ } } updateButton(); }
function initTurnstile() {
  if (!turnstileRequired()) return;
  if (status?.auth_challenge_provider === 'local-image' || status?.turnstile_site_key === 'local-image') {
    if (!localWidget) { const ticket = challengeEpoch; localWidget = mountLocalChallenge($('turnstile'), (token) => { if (ticket !== challengeEpoch) return; turnstileToken = token; updateButton(); }); }
    return;
  }
  if (typeof status?.turnstile_site_key !== 'string' || !status.turnstile_site_key) { notice('安全验证配置暂不可用，请联系管理员。', true); return; }
  const mount = () => {
    if (typeof window.turnstile?.render !== 'function' || widget !== undefined) return;
    const ticket = challengeEpoch;
    try { widget = window.turnstile.render($('turnstile'), { sitekey: status.turnstile_site_key, callback: (value) => { if (ticket !== challengeEpoch) return; turnstileToken = typeof value === 'string' ? value : ''; updateButton(); }, 'expired-callback': () => { if (ticket !== challengeEpoch) return; turnstileToken = ''; updateButton(); }, 'error-callback': () => { if (ticket !== challengeEpoch) return; turnstileToken = ''; notice('安全验证未完成，请稍后重试。', true); updateButton(); } }); }
    catch { notice('安全验证暂不可用，请重新读取服务状态。', true); }
  };
  if (typeof window.turnstile?.render === 'function') { mount(); return; }
  if (document.getElementById('cf-turnstile')) return;
  const script = document.createElement('script'); script.id = 'cf-turnstile'; script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'; script.async = true; script.defer = true; script.onload = mount;
  script.onerror = () => { script.remove(); notice('安全验证未能加载，请检查网络后重新读取服务状态。', true); $('reload-status').hidden = false; };
  document.head.append(script);
}
function clearSecrets() { for (const id of ['password', 'confirm', 'otp', 'email-code', 'new-password']) $(id).value = ''; resetToken = ''; clearTimeout(secretTimer); }
function clearChallenge() {
  challengeEpoch++; turnstileToken = '';
  localWidget?.remove(); localWidget = undefined;
  if (widget !== undefined) { try { window.turnstile?.remove(widget); } catch { /* Stale challenge callbacks are ignored. */ } widget = undefined; }
  $('turnstile').replaceChildren();
}
function finish(bundle) {
  // Only a non-credential session-change signal is sent to other same-origin tabs.
  try { const channel = new BroadcastChannel('new-api:auth-session'); channel.postMessage({ kind: 'authenticated', sid: bundle.session.sid, source: secureUUID(), nonce: secureUUID(), timestamp: Date.now() }); channel.close(); } catch { /* Cookie refresh remains authoritative. */ }
  const target = loginTarget(bundle, redirect, location.origin); clearSecrets(); location.replace(desktopFlow ? `${target}#desktop=${desktopFlow}` : target);
}
function showUnknown(action) {
  $('unknown-actions').hidden = false; $('check-session').hidden = !['login', 'verify'].includes(action); $('unknown-login').hidden = !['register', 'reset'].includes(action); $('restart').hidden = true;
  $('auth-form').hidden = true; $('confirm-reset').hidden = true;
  notice(action === 'register' ? '注册结果尚未确认。请先尝试登录核对账户，不会重复提交注册。' : action === 'reset' ? '重置结果尚未确认，本页不会重复提交。若无法取得新密码，请重新申请重置邮件。' : '登录结果尚未确认。请核对现有会话，不会重复发送登录或验证码。', true);
  if (action === 'reset') { $('unknown-login').textContent = '重新申请重置邮件'; $('unknown-login').href = entryURL('forgot'); }
  updateButton();
}
function showError(error) {
  if (error?.uncertain || client.unknown()) { showUnknown(client.unknown() || mode); return; }
  const messages = {
    ENCRYPTION_UNAVAILABLE: '当前浏览器无法完成安全密码加密。请通过 HTTPS 使用更新的浏览器；不会改用明文提交。',
    INVALID_INPUT: '请检查用户名、邮箱和密码。注册密码须为 8 至 128 个字符。',
    INVALID_CODE: '请输入 6 位动态验证码，或 XXXX-XXXX 格式的备用码。',
    AUTH_FLOW_INVALID: '验证已过期，请重新登录。', METHOD_UNAVAILABLE: '请使用此账户允许的验证方式。',
    NETWORK: '网络请求未完成，请检查连接。', BUSY: '已有安全操作正在处理，请稍候。',
    INVALID_RESET: '重置链接无效，请重新申请重置邮件。', ACCOUNT_CHANGED: '账户会话已改变，请重新进入登录。',
    DESKTOP_FLOW_INVALID: '连接已失效或已绑定现有账户。已有账户请登录；否则请回到仓鼠 AI 重新打开。',
    DESKTOP_ACCOUNT_MISMATCH: '此连接已绑定现有账户，请使用对应账号登录后继续。',
  };
  notice(messages[error?.code] || '操作未通过，请检查输入；若仍失败，请稍后再试。', true);
}
function startCooldown(until = Date.now() + 30000) {
  cooldownUntil = until; clearInterval(cooldownTimer);
  const tick = () => { const seconds = Math.max(0, Math.ceil((cooldownUntil - Date.now()) / 1000)); $('send-code').textContent = seconds ? `${seconds} 秒后重发` : '发送验证码'; if (!seconds) clearInterval(cooldownTimer); updateButton(); };
  tick(); cooldownTimer = setInterval(tick, 1000);
}
$('consent').addEventListener('change', updateButton);
$('auth-form').addEventListener('submit', async (event) => {
  event.preventDefault(); if (busy || $('submit').disabled) return;
  if (legalRequired() && !$('consent').checked) { notice('请先阅读并同意相关条款。', true); return; }
  if (mode === 'register' && $('password').value !== $('confirm').value) { notice('两次输入的密码不一致。', true); return; }
  const ticket = operationEpoch; busy = true; updateButton(); notice('正在安全处理，请稍候…');
  const submittedTurnstile = turnstileToken;
  try {
    if (verifying) { const result = await client.verify($('otp').value); if (ticket === operationEpoch) finish(result.bundle); return; }
    if (mode === 'login') {
      const result = await client.login({ username: $('username').value, password: $('password').value, turnstile: submittedTurnstile, encryption: status.password_login_encryption_enabled === true });
      $('password').value = '';
      if (ticket !== operationEpoch) return;
      if (result.bundle) { finish(result.bundle); return; }
      verifying = true; challengeOnlyPasskey = !result.challenge.methods.some((item) => item.method === '2fa' && item.available); render();
      notice(challengeOnlyPasskey ? '此账户要求通行密钥验证。请选择其他安全登录方式，并重新完成认证。' : '请完成第二步验证。');
    } else if (mode === 'register') {
      const result = await client.register({ username: $('username').value, password: $('password').value, email: $('email').value, code: $('email-code').value, turnstile: submittedTurnstile, emailRequired: !!status.email_verification, desktopFlow });
      if (ticket === operationEpoch) {
        if (result?.bundle) finish(result.bundle);
        else { clearSecrets(); location.replace(entryURL('login')); }
      }
    } else if (mode === 'forgot') {
      if (Date.now() < cooldownUntil) return;
      startCooldown(); await client.forgot($('email').value, submittedTurnstile);
      if (ticket === operationEpoch) notice('重置邮件已发送。请检查收件箱和垃圾邮件。');
    }
  } catch (error) { if (ticket === operationEpoch) showError(error); }
  finally { if (ticket === operationEpoch) { $('otp').value = ''; busy = false; if (turnstileRequired()) resetTurnstile(); updateButton(); } }
});
$('send-code').addEventListener('click', async () => {
  if (busy || $('send-code').disabled) return;
  const email = $('email'); if (!email.value || !email.reportValidity()) { notice('请先填写有效邮箱。', true); return; }
  const ticket = operationEpoch; busy = true; updateButton(); startCooldown();
  try { await client.sendCode(email.value, turnstileToken); if (ticket === operationEpoch) notice('验证码已发送，请检查邮箱。'); }
  catch (error) { if (ticket === operationEpoch) showError(error); }
  finally { if (ticket === operationEpoch) { busy = false; resetTurnstile(); updateButton(); } }
});
$('confirm-reset').addEventListener('click', async () => {
  if (busy || $('confirm-reset').disabled) return;
  const ticket = operationEpoch; busy = true; updateButton();
  try {
    const password = await client.reset(resetEmail, resetToken); if (ticket !== operationEpoch) return; resetToken = '';
    $('reset-panel').hidden = true; $('reset-result').hidden = false; $('new-password').value = password;
    notice('密码已重置。请主动复制保存，再返回登录。');
  } catch (error) { if (ticket === operationEpoch) showError(error); }
  finally { if (ticket === operationEpoch) { busy = false; updateButton(); } }
});
$('show-password').addEventListener('click', () => {
  const input = $('new-password'); clearTimeout(secretTimer); input.type = input.type === 'password' ? 'text' : 'password'; $('show-password').textContent = input.type === 'password' ? '显示密码' : '隐藏密码';
  if (input.type === 'text') secretTimer = setTimeout(() => { input.type = 'password'; $('show-password').textContent = '显示密码'; }, 30000);
});
$('copy-password').addEventListener('click', async () => {
  const ticket = operationEpoch, input = $('new-password');
  try { await navigator.clipboard.writeText(input.value); if (ticket === operationEpoch) notice('密码已复制，请妥善保存。'); }
  catch {
    if (ticket !== operationEpoch) return;
    // Keep the password masked. Selecting never grants another page clipboard access.
    input.focus(); input.select(); input.setSelectionRange(0, input.value.length);
    notice('无法自动复制。请点击“显示密码”后长按选中并复制；电脑可按 Ctrl+C，Mac 可按 ⌘C。', true);
  }
});
$('check-session').addEventListener('click', async () => {
  if (busy) return; const ticket = operationEpoch; busy = true; updateButton();
  try { const bundle = await client.refresh(); if (ticket === operationEpoch) finish(bundle); }
  catch (error) { if (ticket === operationEpoch) { if ([401, 409].includes(error?.status)) { notice('当前没有可用登录会话。你可以明确重新开始一次登录。', true); $('restart').hidden = false; } else notice('登录会话暂时无法确认，请稍后再核对。', true); } }
  finally { if (ticket === operationEpoch) { busy = false; updateButton(); } }
});
$('restart').addEventListener('click', () => { client.restart(); location.replace(entryURL('login')); });
$('cancel-challenge').addEventListener('click', () => { client.cancel(); location.replace(entryURL('login')); });
async function boot({ restoreSession = false } = {}) {
  const ticket = ++operationEpoch; busy = true; status = null; updateButton();
  clearChallenge();
  $('reload-status').hidden = true;
  try {
    const nextStatus = await client.status(); if (ticket !== operationEpoch) return;
    if (!nextStatus || typeof nextStatus !== 'object') throw new Error(); status = nextStatus;
    notice(); render(); initTurnstile();
    if (restoreSession) {
      // BFCache restores DOM and JS together, but neither is proof of a current login.
      try { const bundle = await client.refresh(); if (ticket === operationEpoch) finish(bundle); return; }
      catch { if (ticket !== operationEpoch) return; /* Explicit forms remain available; writes are never replayed. */ }
    }
    const unresolved = client.unknown();
    if (unresolved && ((mode === 'login' && ['register', 'reset'].includes(unresolved)) || mode === 'forgot')) { client.restart(); updateButton(); }
    else if (unresolved) { showUnknown(unresolved); return; }
    if (mode === 'reset' && (!resetEmail || !resetToken)) notice('重置链接无效或已经处理，请重新申请重置邮件。', true);
    // The hint is an optimization only. A failure keeps the explicit login form usable.
    if (!restoreSession && mode === 'login' && document.cookie.split(';').some((part) => part.trim().startsWith('new_api_has_session='))) {
      try { const bundle = await client.refresh(); if (ticket === operationEpoch) finish(bundle); } catch { /* User may still sign in explicitly. */ }
    }
  } catch { if (ticket === operationEpoch) { notice('账户服务状态暂时无法读取，请检查网络后重试。', true); $('auth-form').hidden = true; $('reload-status').hidden = false; } }
  finally { if (ticket === operationEpoch) { busy = false; updateButton(); } }
}
$('reload-status').addEventListener('click', boot);
window.addEventListener('pagehide', () => {
  operationEpoch++; client.cancel(); clearSecrets(); clearChallenge(); clearInterval(cooldownTimer);
  status = null; busy = true; verifying = false; challengeOnlyPasskey = false;
  $('auth-form').hidden = true; $('reset-result').hidden = true; $('unknown-actions').hidden = true; $('challenge-actions').hidden = true; updateButton();
});
window.addEventListener('pageshow', (event) => {
  if (!event.persisted) return;
  clearSecrets(); clearChallenge(); verifying = false; challengeOnlyPasskey = false;
  $('new-password').type = 'password'; $('show-password').textContent = '显示密码';
  if (Date.now() < cooldownUntil) startCooldown(cooldownUntil); else $('send-code').textContent = '发送验证码';
  notice('正在重新核对账户状态…'); void boot({ restoreSession: true });
});
window.addEventListener('blur', () => { $('new-password').type = 'password'; $('show-password').textContent = '显示密码'; });
document.addEventListener('visibilitychange', () => { if (document.hidden) { $('new-password').type = 'password'; $('show-password').textContent = '显示密码'; } });
window.dispatchEvent(new Event('hamster-lite-ready'));
void boot();
