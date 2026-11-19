import { createServer } from 'node:http';
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const MAX_BODY_BYTES = 16 * 1024;
const ALLOWED_PAY_TYPES = new Map([
  ['wxpay', '1'],
  ['alipay', '2'],
]);
const ORDER_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const CHECKOUT_VERSION = 'pikno-checkout-v2';
const INTERNAL_STATUS_PATH = '/pay/lanjing/internal/status';
const INTERNAL_CANCEL_PATH = '/pay/lanjing/internal/cancel';

export function md5(value) {
  return createHash('md5').update(value, 'utf8').digest('hex');
}

export function safeEqual(left, right) {
  const a = Buffer.from(String(left).toLowerCase(), 'utf8');
  const b = Buffer.from(String(right).toLowerCase(), 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

export function epaySign(input, key) {
  const payload = Object.entries(input)
    .filter(([name, value]) => name !== 'sign' && name !== 'sign_type' && value !== '' && value != null)
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([name, value]) => `${name}=${value}`)
    .join('&');
  return md5(payload + key);
}

export function lanjingCreateSign({ payId, param, type, price }, key) {
  return md5(`${payId}${param}${type}${price}${key}`);
}

export function lanjingNotifySign({ payId, param, type, price, reallyPrice }, key) {
  return md5(`${payId}${param}${type}${price}${reallyPrice}${key}`);
}

export function internalPaymentSign(path, body, key) {
  return createHmac('sha256', key).update(`POST\n${path}\n${body}`, 'utf8').digest('hex');
}

export function canonicalMoney(value) {
  const raw = String(value ?? '').trim();
  const match = /^(0|[1-9]\d{0,6})(?:\.(\d{1,2}))?$/.exec(raw);
  if (!match) throw new Error('invalid money');
  const cents = BigInt(match[1]) * 100n + BigInt((match[2] ?? '').padEnd(2, '0') || '0');
  if (cents < 1n) throw new Error('money must be positive');
  return `${cents / 100n}.${String(cents % 100n).padStart(2, '0')}`;
}

function stateKeyBuffer(key) {
  const decoded = Buffer.from(key, 'base64url');
  if (decoded.length !== 32) throw new Error('state key must be 32 bytes encoded as base64url');
  return decoded;
}

export function sealState(state, key) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', stateKeyBuffer(key), iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(state), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([Buffer.from([1]), iv, tag, ciphertext]).toString('base64url');
}

export function openState(token, key, nowSeconds = Math.floor(Date.now() / 1000)) {
  const packed = Buffer.from(String(token), 'base64url');
  if (packed.length < 30 || packed[0] !== 1) throw new Error('invalid state');
  const iv = packed.subarray(1, 13);
  const tag = packed.subarray(13, 29);
  const ciphertext = packed.subarray(29);
  const decipher = createDecipheriv('aes-256-gcm', stateKeyBuffer(key), iv);
  decipher.setAuthTag(tag);
  const state = JSON.parse(Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8'));
  if (state.v !== 1 || !Number.isInteger(state.exp) || state.exp < nowSeconds) throw new Error('expired state');
  return state;
}

// The refresh cookie is scoped to /api/user/auth. Refresh in the browser so
// rotation Set-Cookie headers reach it; never copy session tokens to the provider.
function authenticationPage(params, nonce, returnUrl) {
  const encoded = Buffer.from(new URLSearchParams(params).toString()).toString('base64');
  const returnHref = returnUrl.replaceAll('&', '&amp;').replaceAll('"', '&quot;');
  const userId = parseTradeUserId(params.out_trade_no);
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>仓鼠 AI 收银台</title>
<style nonce="${nonce}">
  body { margin: 0; padding: 32px 16px; background: #f5f5f7; color: #202124; font: 16px/1.5 system-ui, sans-serif; text-align: center; }
  main { max-width: 400px; margin: auto; padding: 24px; border-radius: 16px; background: #fff; }
  h1 { margin: 0 0 12px; font-size: 24px; }
  #amount { font-size: 28px; font-weight: 700; margin: 0; }
  #qr canvas { display: block; margin: 12px auto; max-width: 100%; height: auto; }
  button { margin: 8px 0; padding: 8px 16px; font: inherit; cursor: pointer; }
  a { color: #1459b8; }
</style>
<main><h1>充值收银台</h1><section id="cashier" hidden>
<p id="amount"></p><p id="amount-note" hidden></p><div id="qr"></div>
<button id="open-alipay" type="button" hidden>打开支付宝</button><p id="remaining"></p>
</section><p id="status" role="status">正在核对账户和订单…</p>
<a id="return" href="${returnHref}">返回充值</a></main><script nonce="${nonce}">
  const showStatus = text => { document.getElementById('status').textContent = text; };
  const accountReturn = document.getElementById('return').href;
  const tradeNo = ${JSON.stringify(params.out_trade_no)};
  const userId = '${userId}';
  const expiredMessage = '付款码已到期。已付款请回到账户核对，未付款可重新发起。';

  async function request(path, options, timeout) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetch(path, {
        ...options, credentials: 'same-origin', cache: 'no-store',
        redirect: 'error', signal: controller.signal,
      });
      if (!response.ok) return null;
      return await response.json();
    } finally {
      clearTimeout(timer);
    }
  }

  async function refresh() {
    const run = () => request('/api/user/auth/refresh', { method: 'POST' }, 15000);
    if (!navigator.locks?.request) return run();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      return await navigator.locks.request('new-api:auth-refresh', {
        mode: 'exclusive', signal: controller.signal,
      }, () => { clearTimeout(timer); return run(); });
    } finally {
      clearTimeout(timer);
    }
  }

  (async () => {
    try {
      const auth = await refresh();
      if (auth?.success !== true || typeof auth.data?.access_token !== 'string' || !auth.data.access_token) {
        showStatus('请登录账户后重新打开充值页面。');
        return;
      }
      const headers = { authorization: 'Bearer ' + auth.data.access_token, 'New-Api-User': userId };
      const readStatus = async () => {
        const result = await request('/api/user/topup/status?trade_no=' + encodeURIComponent(tradeNo), { headers }, 12000);
        if (result?.success === true && result.data?.trade_no === tradeNo) return result.data.status;
      };
      const payment = await request('/pay/lanjing/epay/authorize', {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/x-www-form-urlencoded', 'X-PIKNO-Cashier': '1' },
        body: atob('${encoded}'),
      }, 30000);
      const checkout = payment?.checkout;
      if (!checkout) {
        if (payment?.return_url !== accountReturn) {
          showStatus('暂未打开收银台，请回到账户查看订单。');
          return;
        }
        const messages = {
          expired: expiredMessage,
          provider_missing: '蓝鲸暂时查不到原付款码。已付款请核对到账，未付款可返回重新发起充值。',
          provider_details_unavailable: '支付平台暂未返回可用付款码。请返回充值记录核对原订单。',
          provider_paid: '支付平台显示已收款。请返回充值记录核对到账状态。',
        };
        showStatus(messages[payment.checkout_status] || '当前没有可用付款码，请回到账户核对订单。');
        if (await readStatus().catch(() => undefined) === 'success') window.location.replace(accountReturn);
        return;
      }
      const deadline = performance.now() + checkout.remaining_ms;
      const { renderCheckoutQr } = await import('/account-lite/checkout-qr.mjs');
      if (deadline <= performance.now()) {
        showStatus(expiredMessage);
        return;
      }
      const cashier = document.getElementById('cashier');
      const amount = document.getElementById('amount');
      const note = document.getElementById('amount-note');
      const remaining = document.getElementById('remaining');
      const alipay = document.getElementById('open-alipay');
      const clearQr = renderCheckoutQr(document.getElementById('qr'), checkout.pay_url);
      const method = checkout.payment_method === 'alipay' ? '支付宝' : '微信';
      amount.textContent = '实付 ¥' + checkout.really_price;
      if (checkout.money !== checkout.really_price) {
        note.textContent = '充值金额 ¥' + checkout.money + '，请按实付金额支付。';
        note.hidden = false;
      }
      cashier.hidden = false;
      const mobile = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
      showStatus(mobile && checkout.payment_method === 'wxpay'
        ? '请截图保存付款码，再在微信扫一扫中选择该截图。支付完成后会自动核对到账。'
        : '请使用' + method + '扫码。支付完成后会自动核对到账。');
      if (checkout.payment_method === 'alipay' && mobile) {
        alipay.hidden = false;
        alipay.onclick = () => {
          if (performance.now() < deadline) window.location.href = 'alipay://platformapi/startapp?saId=10000007&qrcode=' + encodeURIComponent(checkout.pay_url);
        };
      }

      let countdown;
      function hideCheckout(message) {
        if (!cashier.hidden) {
          cashier.hidden = true;
          alipay.onclick = null;
          clearQr();
        }
        clearInterval(countdown);
        showStatus(message);
      }
      function updateCountdown() {
        const seconds = Math.ceil((deadline - performance.now()) / 1000);
        if (seconds <= 0) {
          hideCheckout(expiredMessage);
          return;
        }
        remaining.textContent = '剩余 ' + Math.floor(seconds / 60) + ' 分 ' + (seconds % 60) + ' 秒';
      }
      updateCountdown();
      if (!cashier.hidden) countdown = setInterval(updateCountdown, 1000);
      window.addEventListener('pageshow', () => { if (!cashier.hidden) updateCountdown(); });
      document.addEventListener('visibilitychange', () => { if (!cashier.hidden) updateCountdown(); });

      const checkUntil = performance.now() + Math.min(checkout.remaining_ms + 30000, 15 * 60000);
      async function checkStatus() {
        try {
          if (document.visibilityState !== 'hidden') {
            const status = await readStatus();
            if (status === 'success') {
              hideCheckout('充值已入账，正在返回账户。');
              window.location.replace(accountReturn);
              return;
            }
            if (status === 'expired') hideCheckout(expiredMessage);
            if (['closing', 'cancelled', 'failed'].includes(status)) {
              hideCheckout('当前没有可用付款码，请回到账户核对订单。');
              return;
            }
          }
        } catch { /* A temporary lookup failure does not change order state. */ }
        if (performance.now() < checkUntil) setTimeout(checkStatus, 8000);
      }
      setTimeout(checkStatus, 5000);
      return;
    } catch {}
    showStatus('暂未打开收银台，请回到账户查看订单。');
  })();
  </script></html>`;
}

function htmlHeaders(nonce) {
  return securityHeaders({
    'content-type': 'text/html; charset=utf-8',
    'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}' 'self'; style-src 'nonce-${nonce}'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`,
  });
}

function securityHeaders(extra = {}) {
  return {
    'cache-control': 'no-store',
    'content-security-policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    ...extra,
  };
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, securityHeaders({
    'content-type': 'text/plain; charset=utf-8',
    ...headers,
  }));
  res.end(body);
}

function sendJson(res, status, body) {
  send(res, status, JSON.stringify(body), { 'content-type': 'application/json; charset=utf-8' });
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error('body too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function strictParams(searchParams, required, optional = []) {
  const allowed = new Set([...required, ...optional]);
  const result = {};
  for (const [name] of searchParams) {
    if (!allowed.has(name) || searchParams.getAll(name).length !== 1) throw new Error('invalid parameters');
  }
  for (const name of required) {
    const value = searchParams.get(name);
    if (value == null || value === '' || value.length > 4096) throw new Error('missing parameter');
    result[name] = value;
  }
  for (const name of optional) {
    const value = searchParams.get(name);
    if (value != null) {
      if (value.length > 4096) throw new Error('parameter too long');
      result[name] = value;
    }
  }
  return result;
}

function validateReturnUrl(value, publicOrigin) {
  const url = new URL(value);
  if (url.origin !== publicOrigin || url.username || url.password) throw new Error('invalid return URL');
  return url.toString();
}

function parseTradeUserId(tradeNo) {
  const match = /^USR([1-9]\d{0,15})NO[A-Za-z0-9]{1,96}$/.exec(tradeNo);
  const userId = match && Number(match[1]);
  if (!Number.isSafeInteger(userId)) throw new Error('invalid trade number');
  return userId;
}

function normalizedConfig(input) {
  const required = ['lanjingKey', 'epayKey', 'stateKey'];
  for (const name of required) if (!input[name]) throw new Error(`missing ${name}`);
  const lanjingOrigin = new URL(input.lanjingBase ?? 'https://2347637.pay.lanjingzf.com');
  if (lanjingOrigin.protocol !== 'https:' || lanjingOrigin.username || lanjingOrigin.password
    || lanjingOrigin.pathname !== '/' || lanjingOrigin.search || lanjingOrigin.hash) {
    throw new Error('invalid payment provider origin');
  }
  return {
    listenHost: input.listenHost ?? '0.0.0.0',
    listenPort: Number(input.listenPort ?? 8080),
    publicOrigin: input.publicOrigin ?? 'https://www.piknoai.com',
    lanjingBase: lanjingOrigin.origin,
    lanjingMerchantId: String(input.lanjingMerchantId ?? '2347637'),
    lanjingKey: input.lanjingKey,
    epayKey: input.epayKey,
    stateKey: input.stateKey,
    newApiOrigin: input.newApiOrigin ?? 'http://new-api:3000',
    resendKey: input.resendKey ?? '',
    resendFrom: input.resendFrom ?? 'PIKNO <notify@mail.piknoai.com>',
    stateLifetimeSeconds: Number(input.stateLifetimeSeconds ?? 24 * 60 * 60),
    diagnosticReceiptDir: input.diagnosticReceiptDir ?? '/data/diagnostics',
  };
}

function validateOrder(params, config) {
  if (params.pid !== config.lanjingMerchantId) throw new Error('invalid merchant');
  if (!ALLOWED_PAY_TYPES.has(params.type)) throw new Error('invalid payment type');
  if (String(params.sign_type).toUpperCase() !== 'MD5') throw new Error('invalid signature type');
  // Derive a checkout-only key so the original form fields remain compatible
  // with released clients and old bridges cannot authorize the new checkout.
  const checkoutKey = createHmac('sha256', config.epayKey).update(CHECKOUT_VERSION, 'utf8').digest('hex');
  const validSignature = safeEqual(params.sign, epaySign(params, checkoutKey));
  const legacySignature = !validSignature && safeEqual(params.sign, epaySign(params, config.epayKey));
  if (!validSignature && !legacySignature) throw new Error('invalid signature');
  const userId = parseTradeUserId(params.out_trade_no);
  const money = canonicalMoney(params.money);
  if (!['50.00', '100.00', '200.00'].includes(money)) throw new Error('invalid topup amount: only CNY 50, 100 or 200 allowed');
  validateReturnUrl(params.return_url, config.publicOrigin);
  if (params.notify_url !== `${config.publicOrigin}/api/user/epay/notify`) throw new Error('invalid notify URL');
  return { userId, money, legacySignature };
}

async function authenticateOrder(params, req, config, fetchImpl) {
  const { userId, money } = validateOrder(params, config);
  if (!/^Bearer \S+$/.test(req.headers.authorization ?? '')) throw new Error('invalid authorization');
  const authResponse = await fetchImpl(`${config.newApiOrigin}/api/user/self`, {
    headers: { authorization: req.headers.authorization, 'New-Api-User': String(userId) },
    signal: AbortSignal.timeout(10000),
    redirect: 'error',
  });
  if (!authResponse.ok) throw new Error('authentication unavailable');
  const payload = await authResponse.json();
  const user = payload?.data;
  if (!payload?.success || Number(user?.id) !== userId) throw new Error('account mismatch');
  const email = String(user.email ?? '').trim();
  return {
    money,
    email: email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : '',
  };
}

function providerNotifyFields(params) {
  return strictParams(params, ['payId', 'param', 'type', 'price', 'reallyPrice', 'sign']);
}

function verifyProviderNotify(fields, config, nowSeconds) {
  if (!safeEqual(fields.sign, lanjingNotifySign(fields, config.lanjingKey))) throw new Error('invalid provider signature');
  const state = openState(fields.param, config.stateKey, nowSeconds);
  if (state.o !== fields.payId || state.m !== canonicalMoney(fields.price)) {
    throw new Error('order mismatch');
  }
  if (ALLOWED_PAY_TYPES.get(state.t) !== fields.type) throw new Error('payment type mismatch');
  // Blue Whale can vary reallyPrice by cents to distinguish simultaneous QR
  // orders. Its signed notification binds that collected amount to this order.
  const reallyPrice = canonicalMoney(fields.reallyPrice);
  validateReturnUrl(state.r, config.publicOrigin);
  return { ...state, reallyPrice };
}

async function creditNewApi(state, config, fetchImpl) {
  const callback = {
    pid: config.lanjingMerchantId,
    type: state.t,
    out_trade_no: state.o,
    trade_no: state.o,
    name: 'PIKNO充值',
    money: state.m,
    really_price: state.reallyPrice,
    trade_status: 'TRADE_SUCCESS',
    sign_type: 'MD5',
  };
  callback.sign = epaySign(callback, config.epayKey);
  const response = await fetchImpl(`${config.newApiOrigin}/api/user/epay/notify`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(callback),
    signal: AbortSignal.timeout(10000),
    redirect: 'error',
  });
  const body = await response.text();
  if (!response.ok || body.trim() !== 'success') throw new Error('credit rejected');
}

async function sendRechargeEmail(state, config, fetchImpl) {
  const response = await fetchImpl('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${config.resendKey}`,
      'content-type': 'application/json',
      'idempotency-key': `pikno-topup-${state.o}`,
    },
    body: JSON.stringify({
      from: config.resendFrom,
      to: [state.e],
      subject: 'PIKNO 充值成功通知',
      text: `你的 PIKNO 账户已成功充值 ¥${state.m}。订单号：${state.o}。如非本人操作，请立即联系管理员。`,
    }),
    signal: AbortSignal.timeout(10000),
    redirect: 'error',
  });
  if (!response.ok) throw new Error('email delivery failed');
}

function accountReturnUrl(tradeNo, config) {
  parseTradeUserId(tradeNo);
  const url = new URL('/account-lite/index.html', config.publicOrigin);
  url.search = new URLSearchParams({ tab: 'topup', payment_return: '1', trade_no: tradeNo }).toString();
  return url.href;
}

function checkoutUrl(orderId, config) {
  if (!ORDER_ID_PATTERN.test(orderId)) throw new Error('invalid provider order ID');
  const url = new URL('/payPage/pay.html', config.lanjingBase);
  url.searchParams.set('orderId', orderId);
  return url.href;
}

async function requestProvider(path, fields, config, fetchImpl) {
  const response = await fetchImpl(new URL(path, config.lanjingBase).href, {
    method: 'POST',
    body: new URLSearchParams(fields),
    signal: AbortSignal.timeout(6000),
    redirect: 'error',
  });
  if (!response.ok) throw new Error('provider request unavailable');
  return response.json();
}

async function requestLedger(path, data, config, fetchImpl) {
  const body = JSON.stringify(data);
  const response = await fetchImpl(`${config.newApiOrigin}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-PIKNO-Payment-Sign': internalPaymentSign(path, body, config.epayKey) },
    body,
    signal: AbortSignal.timeout(10000),
    redirect: 'error',
  });
  if (!response.ok) throw new Error('ledger request rejected');
  const payload = await response.json();
  if (!payload?.success || !payload.data) throw new Error('ledger request rejected');
  return payload.data;
}

function providerOrderStatus(result, order) {
  const data = result?.data;
  if (Number(result?.code) !== 1 || !data || typeof data.orderId !== 'string'
    || !ORDER_ID_PATTERN.test(data.orderId) || (order.provider_order_id && data.orderId !== order.provider_order_id)
    || data.payId !== order.trade_no
    || String(data.payType) !== ALLOWED_PAY_TYPES.get(order.payment_method)
    || canonicalMoney(data.price) !== order.money) throw new Error('provider order mismatch');
  const reallyPrice = canonicalMoney(data.reallyPrice);
  if (order.really_price && order.really_price !== reallyPrice) throw new Error('provider amount mismatch');
  const state = String(data.state);
  if (!['-1', '0', '1', '2'].includes(state)) throw new Error('invalid provider state');
  return { orderId: data.orderId, reallyPrice, state, createdAt: data.date, timeoutMinutes: data.timeOut, payUrl: data.payUrl };
}

function paymentQr(value, method) {
  if (typeof value !== 'string' || value.length > 1024) return '';
  let raw = value;
  try {
    if (/^[a-z]+%3a/i.test(raw)) raw = decodeURIComponent(raw);
    if (/[\s\p{Cc}\\]/u.test(raw)) return '';
    if (method === 'wxpay' && /^wxp:\/\/[a-z0-9_+=/-]+$/i.test(raw)) return raw;
    const url = new URL(raw);
    if (url.username || url.password || url.port || url.hash) return '';
    if (method === 'alipay') {
      if (url.protocol === 'https:' && url.hostname === 'qr.alipay.com' && /^\/[a-z0-9_-]+$/i.test(url.pathname)) return raw;
    } else if (url.protocol === 'weixin:' && ['wxpay', 'pay.wechatpay.cn'].includes(url.hostname) &&
      /^\/bizpayurl(?:\/up)?$/.test(url.pathname) && url.search) {
      return raw;
    } else if (url.protocol === 'https:' && url.hostname === 'payapp.weixin.qq.com' &&
      url.pathname === '/materialqr/entry/home' && [...url.searchParams.keys()].length === 1 &&
      /^\d{1,32}$/.test(url.searchParams.get('id') ?? '')) {
      return raw;
    } else if (url.protocol === 'https:' && (
      (url.hostname === 'pay.wechatpay.cn' && /^\/bizpayurl(?:\/up)?$/.test(url.pathname)) ||
      (url.hostname === 'wx.tenpay.com' && url.pathname === '/cgi-bin/mmpayweb-bin/checkmweb')
    ) && url.search) {
      return raw;
    }
  } catch { /* Unknown provider QR formats must not be rendered. */ }
  return '';
}

function checkoutDetailShape(provider, method) {
  const fieldType = (value) => {
    if (value === undefined) return 'missing';
    if (value === null) return 'null';
    const type = typeof value;
    return type === 'string' || type === 'number' ? type : 'other';
  };
  const dateType = fieldType(provider.createdAt);
  const timeoutType = fieldType(provider.timeoutMinutes);
  const qrType = fieldType(provider.payUrl);
  const date = dateType === 'string' || dateType === 'number' ? String(provider.createdAt) : '';
  const timeout = timeoutType === 'string' || timeoutType === 'number' ? String(provider.timeoutMinutes) : '';
  const qr = qrType === 'string' ? provider.payUrl : '';
  const qrFormat = !qr ? 'missing' : paymentQr(qr, method) ? 'supported' :
    /^(?:https|wxp|weixin)(?::|%3a)/i.test(qr) ? 'unsupported_host_or_path' : 'unsupported_scheme';
  return {
    date_type: dateType,
    date_format: /^\d{13}$/.test(date) ? 'millis' : /^\d{10}$/.test(date) ? 'seconds' : 'other',
    timeout_type: timeoutType,
    timeout_positive_integer: /^\d+$/.test(timeout) && Number.isSafeInteger(Number(timeout)) && Number(timeout) > 0,
    qr_type: qrType,
    qr_format: qrFormat,
  };
}

function checkoutResponse(provider, order, ownCashier, config, now) {
  if (provider.state === '-1') return { checkout_status: 'expired' };
  if (provider.state !== '0') return { checkout_status: 'provider_paid' };
  if (!['string', 'number'].includes(typeof provider.createdAt) || !/^\d{13}$/.test(String(provider.createdAt)) ||
    !['string', 'number'].includes(typeof provider.timeoutMinutes) || !/^\d+$/.test(String(provider.timeoutMinutes))) {
    return { checkout_status: 'provider_timing_invalid' };
  }
  const createdAt = Number(provider.createdAt);
  const duration = Number(provider.timeoutMinutes) * 60000;
  const expiresAt = createdAt + duration;
  if (!Number.isSafeInteger(createdAt) || createdAt <= 0 ||
    !Number.isSafeInteger(duration) || duration <= 0 || !Number.isSafeInteger(expiresAt)) {
    return { checkout_status: 'provider_timing_invalid' };
  }
  const remaining = Math.min(expiresAt - now(), duration);
  if (remaining <= 0) return { checkout_status: 'expired' };
  if (!ownCashier) return { checkout_url: checkoutUrl(provider.orderId, config) };
  const payUrl = paymentQr(provider.payUrl, order.payment_method);
  if (!payUrl) return { checkout_status: 'provider_qr_unsupported' };
  return { checkout: {
    payment_method: order.payment_method,
    money: order.money,
    really_price: provider.reallyPrice,
    pay_url: payUrl,
    remaining_ms: remaining,
  } };
}

async function lookupCheckout(order, ownCashier, config, fetchImpl, now) {
  const result = await requestProvider('/getOrder', { orderId: order.provider_order_id }, config, fetchImpl);
  if (missingProviderOrder(result)) return { checkout_status: 'provider_missing' };
  return checkoutResponse(providerOrderStatus(result, order), order, ownCashier, config, now);
}

async function createCheckout(params, verified, config, fetchImpl, now, ownCashier, logger) {
  const tradeNo = params.out_trade_no;
  const order = { trade_no: tradeNo, payment_method: params.type, money: verified.money };
  const returnUrl = accountReturnUrl(tradeNo, config);
  const claim = await requestLedger('/api/user/lanjing/internal/claim', order, config, fetchImpl);
  const phase = claim.provider_order_id ? 'resume' : 'create';
  const respond = (result) => {
    const reason = result.checkout_status;
    if (!reason) return result;
    logger.info(JSON.stringify({ event: 'checkout_code_unavailable', phase, method: order.payment_method, reason }));
    if (!ownCashier) return { return_url: returnUrl };
    const status = ['provider_timing_invalid', 'provider_qr_unsupported', 'provider_lookup_failed'].includes(reason)
      ? 'provider_details_unavailable' : reason;
    return { return_url: returnUrl, checkout_status: status };
  };
  if (claim.status !== 'pending') return respond({ checkout_status: 'local_not_pending' });
  if (claim.provider_order_id) {
    if (canonicalMoney(claim.really_price) !== claim.really_price) throw new Error('invalid linked provider amount');
    const linked = { ...order, provider_order_id: claim.provider_order_id, really_price: claim.really_price };
    return respond(await lookupCheckout(linked, ownCashier, config, fetchImpl, now));
  }
  if (claim.can_create !== true) return respond({ checkout_status: 'claim_already_used' });

  const state = {
    v: 1,
    o: tradeNo,
    m: verified.money,
    t: params.type,
    e: verified.email,
    r: returnUrl,
    exp: Math.floor(now() / 1000) + config.stateLifetimeSeconds,
  };
  const fields = {
    payId: tradeNo,
    type: ALLOWED_PAY_TYPES.get(params.type),
    price: verified.money,
    param: sealState(state, config.stateKey),
    isHtml: '0',
    notifyUrl: `${config.publicOrigin}/pay/lanjing/notify`,
    returnUrl: `${config.publicOrigin}/pay/lanjing/return`,
  };
  fields.sign = lanjingCreateSign(fields, config.lanjingKey);
  // The durable ledger claim remains in place after an ambiguous create response.
  // A subsequent navigation therefore cannot create a second provider order.
  const provider = providerOrderStatus(await requestProvider('/createOrder', fields, config, fetchImpl), order);
  const bindingFields = { ...order, provider_order_id: provider.orderId, really_price: provider.reallyPrice };
  const bind = () => requestLedger('/api/user/lanjing/internal/bind', bindingFields, config, fetchImpl);
  let binding;
  try {
    binding = await bind();
  } catch {
    binding = await bind();
  }
  if (binding.status === 'pending' && binding.provider_order_id === provider.orderId && binding.really_price === provider.reallyPrice) {
    const result = checkoutResponse(provider, order, ownCashier, config, now);
    if (ownCashier && ['provider_timing_invalid', 'provider_qr_unsupported'].includes(result.checkout_status)) {
      logger.info(JSON.stringify({
        event: 'checkout_details_incomplete',
        method: order.payment_method,
        reason: result.checkout_status,
        ...checkoutDetailShape(provider, order.payment_method),
      }));
      try {
        return respond(await lookupCheckout(bindingFields, ownCashier, config, fetchImpl, now));
      } catch {
        return respond({ checkout_status: 'provider_lookup_failed' });
      }
    }
    return respond(result);
  }
  return respond({ checkout_status: 'binding_not_payable' });
}

async function readInternalOrder(req, requestUrl, config) {
  if (requestUrl.search || !/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) {
    throw new Error('invalid internal request');
  }
  const body = await readBody(req);
  const signature = req.headers['x-pikno-payment-sign'];
  if (typeof signature !== 'string' || !/^[0-9a-f]{64}$/i.test(signature)
    || !safeEqual(signature, internalPaymentSign(requestUrl.pathname, body, config.epayKey))) {
    throw new Error('invalid internal signature');
  }
  const order = JSON.parse(body);
  if (typeof order?.trade_no !== 'string' || typeof order.provider_order_id !== 'string'
    || !ORDER_ID_PATTERN.test(order.provider_order_id) || !ALLOWED_PAY_TYPES.has(order.payment_method)
    || typeof order.money !== 'string' || canonicalMoney(order.money) !== order.money
    || typeof order.really_price !== 'string' || canonicalMoney(order.really_price) !== order.really_price) {
    throw new Error('invalid internal order');
  }
  parseTradeUserId(order.trade_no);
  return order;
}

async function verifyPaidOrder(order, config, fetchImpl, nowSeconds, settle) {
  const result = await requestProvider('/checkOrder', { orderId: order.provider_order_id }, config, fetchImpl);
  if (Number(result?.code) !== 1 || typeof result.data !== 'string') throw new Error('provider confirmation unavailable');
  // Read the provider's signed callback fields, never fetch the returned URL.
  const url = new URL(result.data);
  if (url.origin !== config.publicOrigin || url.pathname !== '/pay/lanjing/return'
    || url.username || url.password || url.hash) throw new Error('invalid provider return');
  const state = verifyProviderNotify(providerNotifyFields(url.searchParams), config, nowSeconds);
  if (state.p === 'diagnostic' || state.o !== order.trade_no || state.m !== order.money
    || state.t !== order.payment_method || state.reallyPrice !== order.really_price) {
    throw new Error('provider confirmation mismatch');
  }
  await settle(state);
  return 'paid';
}

async function reconcileOrder(order, shouldClose, config, fetchImpl, nowSeconds, settle) {
  const fields = { orderId: order.provider_order_id };
  const readStatus = async () => {
    const result = await requestProvider('/getOrder', fields, config, fetchImpl);
    return missingProviderOrder(result) ? 'provider_order_missing' : providerOrderStatus(result, order).state;
  };
  const state = await readStatus();
  if (state === 'provider_order_missing') return state;
  if (state === '1' || state === '2') return verifyPaidOrder(order, config, fetchImpl, nowSeconds, settle);
  if (state === '-1') return 'expired';
  if (!shouldClose) return 'pending';

  try {
    const result = await requestProvider('/closeOrder', {
      ...fields,
      sign: md5(`${fields.orderId}${config.lanjingKey}`),
    }, config, fetchImpl);
    if (Number(result?.code) === 1) return 'cancelled';
  } catch {
    // Closing may have raced with payment, or reached the provider before a timeout.
  }
  const after = await readStatus();
  if (after === '1' || after === '2') return verifyPaidOrder(order, config, fetchImpl, nowSeconds, settle);
  return after === '-1' ? 'expired' : 'processing';
}

function missingProviderOrder(result) {
  return result?.code === -1 && result.msg === '云端订单编号不存在' && result.data == null;
}

export function createHandler(rawConfig, { fetchImpl = globalThis.fetch, now = () => Date.now(), logger = console } = {}) {
  const config = normalizedConfig(rawConfig);
  const sendingEmails = new Set();
  const queueRechargeEmail = (state) => {
    if (!config.resendKey || !state.e || sendingEmails.has(state.o)) return;
    sendingEmails.add(state.o);
    void sendRechargeEmail(state, config, fetchImpl)
      .catch(() => logger.error(JSON.stringify({ event: 'recharge_email_failed' })))
      .finally(() => sendingEmails.delete(state.o));
  };
  return async function handler(req, res) {
    const nowSeconds = Math.floor(now() / 1000);
    let operation = 'unknown';
    try {
      const requestUrl = new URL(req.url, config.publicOrigin);
      if (req.method === 'GET' && requestUrl.pathname === '/pay/lanjing/health') {
        sendJson(res, 200, { ok: true, paymentConfigured: true });
        return;
      }

      if ((req.method === 'POST' || req.method === 'GET') && ['/pay/lanjing/epay/submit.php', '/pay/lanjing/epay/authorize'].includes(requestUrl.pathname)) {
        operation = 'checkout';
        const source = req.method === 'POST' ? new URLSearchParams(await readBody(req)) : requestUrl.searchParams;
        const params = strictParams(source,
          ['pid', 'type', 'out_trade_no', 'notify_url', 'return_url', 'name', 'money', 'sign_type', 'sign'],
          ['device', 'clientip', 'param']);
        const order = validateOrder(params, config);
        if (order.legacySignature) {
          send(res, 409, '该充值页面已更新，请回到账户后重新打开充值页面。');
          return;
        }
        if (requestUrl.pathname.endsWith('/submit.php')) {
          const nonce = randomBytes(18).toString('base64');
          res.writeHead(200, htmlHeaders(nonce));
          res.end(authenticationPage(params, nonce, accountReturnUrl(params.out_trade_no, config)));
          return;
        }
        if (req.method !== 'POST') throw new Error('invalid method');
        const verified = await authenticateOrder(params, req, config, fetchImpl);
        sendJson(res, 200, await createCheckout(params, verified, config, fetchImpl, now, req.headers['x-pikno-cashier'] === '1', logger));
        return;
      }

      if (req.method === 'POST' && [INTERNAL_STATUS_PATH, INTERNAL_CANCEL_PATH, '/pay/lanjing/internal/lookup'].includes(requestUrl.pathname)) {
        const shouldClose = requestUrl.pathname === INTERNAL_CANCEL_PATH;
        operation = shouldClose ? 'cancel' : 'status';
        const order = await readInternalOrder(req, requestUrl, config);
        try {
          if (requestUrl.pathname.endsWith('/lookup')) {
            const result = await requestProvider('/getOrder', { orderId: order.provider_order_id }, config, fetchImpl);
            sendJson(res, 200, { status: missingProviderOrder(result) ? 'provider_order_missing' : 'processing' });
            return;
          }
          let confirmedState;
          const status = await reconcileOrder(order, shouldClose, config, fetchImpl, nowSeconds, async (state) => {
            await creditNewApi(state, config, fetchImpl);
            confirmedState = state;
          });
          if (status === 'provider_order_missing') logger.info(JSON.stringify({ event: 'payment_reconciliation_pending', operation, reason: status }));
          sendJson(res, 200, { status });
          if (confirmedState) queueRechargeEmail(confirmedState);
        } catch {
          logger.error(JSON.stringify({ event: 'payment_reconciliation_pending', operation }));
          sendJson(res, 200, { status: 'processing' });
        }
        return;
      }

      if (req.method === 'GET' && requestUrl.pathname === '/pay/lanjing/notify') {
        operation = 'notify';
        const fields = providerNotifyFields(requestUrl.searchParams);
        const state = verifyProviderNotify(fields, config, nowSeconds);
        if (state.p === 'diagnostic') throw new Error('invalid callback purpose');
        parseTradeUserId(state.o);
        await creditNewApi(state, config, fetchImpl);
        send(res, 200, 'success');
        queueRechargeEmail(state);
        logger.info(JSON.stringify({ event: 'recharge_completed' }));
        return;
      }

      if (req.method === 'GET' && requestUrl.pathname === '/pay/lanjing/diagnostic/notify') {
        operation = 'diagnostic_notify';
        const fields = providerNotifyFields(requestUrl.searchParams);
        const state = verifyProviderNotify(fields, config, nowSeconds);
        if (state.p !== 'diagnostic' || !/^PIKNOTEST[A-Za-z0-9]+$/.test(state.o) || state.m !== '1.00') throw new Error('invalid diagnostic order');
        mkdirSync(config.diagnosticReceiptDir, { recursive: true, mode: 0o700 });
        const receipt = { receivedAt: new Date(now()).toISOString(), order: state.o, quotedCny: state.m, collectedCny: canonicalMoney(fields.reallyPrice), type: state.t, diagnosticOnly: true };
        try {
          writeFileSync(join(config.diagnosticReceiptDir, `${state.o}.json`), JSON.stringify(receipt), { flag: 'wx', mode: 0o600 });
        } catch (error) { if (error.code !== 'EEXIST') throw error; }
        logger.info(JSON.stringify({ event: 'diagnostic_payment_received' }));
        send(res, 200, 'success');
        return;
      }

      if (req.method === 'GET' && requestUrl.pathname === '/pay/lanjing/return') {
        operation = 'return';
        const fields = providerNotifyFields(requestUrl.searchParams);
        const state = verifyProviderNotify(fields, config, nowSeconds);
        if (state.p === 'diagnostic') {
          send(res, 200, '已收到支付返回信息。这是人民币1元收款诊断订单，不自动增加账户余额。请回到对话核验服务器回调记录。');
          return;
        }
        res.writeHead(303, securityHeaders({ location: accountReturnUrl(state.o, config) }));
        res.end();
        return;
      }

      send(res, 404, 'not found');
    } catch (error) {
      const status = /signature|merchant|account mismatch|invalid|expired|order mismatch|payment type|parameter|body too large/.test(error.message) ? 403 : 502;
      logger.error(JSON.stringify({ event: 'payment_bridge_error', operation, status }));
      send(res, status, 'fail');
    }
  };
}

function readSecret(path) {
  return readFileSync(path, 'utf8').trim();
}

export function configFromEnvironment(env = process.env) {
  let resend = {};
  try {
    resend = JSON.parse(readSecret(env.RESEND_CONFIG_FILE ?? '/run/secrets/resend_config'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return normalizedConfig({
    listenHost: env.LISTEN_HOST,
    listenPort: env.LISTEN_PORT,
    publicOrigin: env.PUBLIC_ORIGIN,
    lanjingBase: env.LANJING_BASE,
    lanjingMerchantId: env.LANJING_MERCHANT_ID,
    newApiOrigin: env.NEW_API_ORIGIN,
    lanjingKey: readSecret(env.LANJING_KEY_FILE ?? '/run/secrets/lanjing_key'),
    epayKey: readSecret(env.EPAY_KEY_FILE ?? '/run/secrets/epay_key'),
    stateKey: readSecret(env.STATE_KEY_FILE ?? '/run/secrets/state_key'),
    resendKey: resend.apiKey,
    resendFrom: resend.smtpFrom,
  });
}

export function startServer(config = configFromEnvironment()) {
  const server = createServer(createHandler(config));
  server.listen(config.listenPort, config.listenHost, () => {
    console.info(JSON.stringify({ event: 'payment_bridge_started', port: config.listenPort }));
  });
  return server;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) startServer();
