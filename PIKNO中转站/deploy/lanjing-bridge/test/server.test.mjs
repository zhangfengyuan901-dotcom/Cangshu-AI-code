import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { runInNewContext } from 'node:vm';
import {
  canonicalMoney,
  createHandler,
  epaySign,
  internalPaymentSign,
  lanjingCreateSign,
  lanjingNotifySign,
  md5,
  openState,
  sealState,
} from '../server.mjs';

const stateKey = Buffer.alloc(32, 7).toString('base64url');
const currentTime = 1_800_000_000_000;
const alipayQr = 'HTTPS://QR.ALIPAY.COM/test-synthetic';
const wechatQr = 'wxp://f2f0Synthetic-Wechat_Code=';
const config = {
  publicOrigin: 'https://www.piknoai.com',
  lanjingBase: 'https://2347637.pay.lanjingzf.com',
  lanjingMerchantId: '2347637',
  lanjingKey: 'provider-secret',
  epayKey: 'bridge-secret',
  stateKey,
  newApiOrigin: 'http://new-api:3000',
  resendKey: 'resend-secret',
  resendFrom: 'PIKNO <notify@mail.piknoai.com>',
  diagnosticReceiptDir: mkdtempSync(join(tmpdir(), 'pikno-payment-test-')),
};

let server;
let origin;
let calls;
let mockResponse;
let claimedOrders;
let now;
let logs;

beforeEach(async () => {
  calls = [];
  logs = [];
  mockResponse = async () => undefined;
  claimedOrders = new Map();
  now = currentTime;
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    const override = await mockResponse(String(url), options);
    if (override) return override;
    if (String(url).endsWith('/api/user/self')) {
      return new Response(JSON.stringify({ success: true, data: { id: 12, email: 'buyer@example.com' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (String(url).endsWith('/api/user/lanjing/internal/claim') || String(url).endsWith('/api/user/lanjing/internal/bind')) {
      const path = new URL(url).pathname;
      assert.equal(options.headers['X-PIKNO-Payment-Sign'], internalPaymentSign(path, options.body, config.epayKey));
      const order = JSON.parse(options.body);
      const prior = claimedOrders.get(order.trade_no);
      if (path.endsWith('/bind')) {
        assert.ok(prior);
        prior.provider_order_id = order.provider_order_id;
        prior.really_price = order.really_price;
      } else if (!prior) {
        claimedOrders.set(order.trade_no, {});
      }
      return Response.json({ success: true, data: { status: 'pending', can_create: !prior, provider_order_id: prior?.provider_order_id ?? '', really_price: prior?.really_price ?? '' } });
    }
    if (String(url).endsWith('/createOrder')) {
      const fields = Object.fromEntries(options.body);
      assert.equal(options.method, 'POST');
      assert.equal(fields.sign, lanjingCreateSign(fields, config.lanjingKey));
      return Response.json({
        code: 1,
        data: { orderId: '201901102220147500', payId: fields.payId, payType: Number(fields.type), price: fields.price, reallyPrice: fields.price, state: 0,
          date: currentTime, timeOut: 5, payUrl: fields.type === '2' ? alipayQr : wechatQr },
      });
    }
    if (String(url).endsWith('/api/user/epay/notify')) return new Response('success');
    if (String(url) === 'https://api.resend.com/emails') return new Response('{}', { status: 200 });
    throw new Error(`unexpected fetch ${url}`);
  };
  server = createServer(createHandler(config, {
    fetchImpl, now: () => now, logger: { info: line => logs.push(JSON.parse(line)), error() {} },
  }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
});

afterEach(async () => {
  await new Promise((resolve) => server.close(resolve));
});

function epayOrder(overrides = {}) {
  const order = {
    pid: '2347637',
    type: 'alipay',
    out_trade_no: 'USR12NOABC123',
    notify_url: 'https://www.piknoai.com/api/user/epay/notify',
    return_url: 'https://www.piknoai.com/console/topup',
    name: '充值 50 元',
    money: '50.00',
    sign_type: 'MD5',
    ...overrides,
  };
  const checkoutKey = createHmac('sha256', config.epayKey).update('pikno-checkout-v2', 'utf8').digest('hex');
  order.sign = epaySign(order, checkoutKey);
  return order;
}

function providerCallback(stateOverrides = {}, fieldOverrides = {}) {
  const state = {
    v: 1,
    o: 'USR12NOABC123',
    m: '10.00',
    t: 'alipay',
    e: 'buyer@example.com',
    r: 'https://www.piknoai.com/console/topup',
    exp: 1_800_003_600,
    ...stateOverrides,
  };
  const fields = {
    payId: state.o,
    param: sealState(state, stateKey),
    type: '2',
    price: state.m,
    reallyPrice: state.m,
    ...fieldOverrides,
  };
  fields.sign = lanjingNotifySign(fields, config.lanjingKey);
  return fields;
}

const bridgeOrder = { trade_no: 'USR12NOABC123', provider_order_id: '201901102220147500', payment_method: 'alipay', money: '50.00', really_price: '50.01' };

function providerOrder(state, overrides = {}) {
  return Response.json({
    code: 1,
    data: { orderId: bridgeOrder.provider_order_id, payId: bridgeOrder.trade_no, payType: 2, price: 50, reallyPrice: 50.01, state,
      date: currentTime, timeOut: 5, payUrl: alipayQr, ...overrides },
  });
}

function callInternal(action, body = JSON.stringify(bridgeOrder), signature) {
  const path = `/pay/lanjing/internal/${action}`;
  return fetch(origin + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-pikno-payment-sign': signature ?? internalPaymentSign(path, body, config.epayKey) },
    body,
  });
}

test('only the exact missing order result gives a signed lookup permission to detach locally', async () => {
  for (const [response, expected] of [
    [{ code: -1, msg: '云端订单编号不存在', data: null }, 'provider_order_missing'],
    [{ code: -1, msg: '云端订单编号不存在' }, 'provider_order_missing'],
    [{ code: 0, msg: '云端订单编号不存在' }, 'processing'],
    [{ code: -1, msg: '暂不可用' }, 'processing'],
    [{ code: -1, msg: '云端订单编号不存在', data: {} }, 'processing'],
    [{ code: 1, data: { state: 2 } }, 'processing'],
  ]) {
    mockResponse = async (url, options) => {
      assert.ok(url.endsWith('/getOrder')); assert.equal(options.body.get('orderId'), bridgeOrder.provider_order_id);
      return Response.json(response);
    };
    assert.deepEqual(await (await callInternal('lookup')).json(), { status: expected });
  }
  mockResponse = async () => { throw new Error('timeout'); };
  assert.deepEqual(await (await callInternal('lookup')).json(), { status: 'processing' });
  const before = calls.length;
  assert.notEqual((await callInternal('lookup', JSON.stringify(bridgeOrder), '0'.repeat(64))).status, 200);
  assert.notEqual((await callInternal('lookup', JSON.stringify({ ...bridgeOrder, payment_method: 'other' }))).status, 200);
  assert.equal(calls.length, before);
  mockResponse = async () => Response.json({ code: -1, msg: '云端订单编号不存在', data: null });
  assert.deepEqual(await (await callInternal('cancel')).json(), { status: 'provider_order_missing' });
  assert.ok(calls.every(call => call.url.endsWith('/getOrder')));
});

test('one-yuan diagnostic callback persists once without crediting or emailing', async () => {
  const fields = providerCallback({ o: 'PIKNOTEST123', m: '1.00', p: 'diagnostic' });
  const url = `${origin}/pay/lanjing/diagnostic/notify?${new URLSearchParams(fields)}`;
  for (let i = 0; i < 2; i++) assert.equal(await (await fetch(url)).text(), 'success');
  assert.equal(calls.length, 0);
  assert.deepEqual(readdirSync(config.diagnosticReceiptDir), ['PIKNOTEST123.json']);
  const wrongRoute = await fetch(`${origin}/pay/lanjing/notify?${new URLSearchParams(fields)}`);
  assert.equal(wrongRoute.status, 403);
  assert.equal(calls.length, 0);
});

test('signing and money helpers are deterministic', () => {
  assert.equal(canonicalMoney('1.2'), '1.20');
  assert.equal(epaySign({ b: '2', a: '1', sign_type: 'MD5' }, 'k'), epaySign({ a: '1', b: '2' }, 'k'));
  assert.equal(lanjingCreateSign({ payId: 'o', param: 'p', type: '2', price: '1.00' }, 'k'), lanjingCreateSign({ payId: 'o', param: 'p', type: '2', price: '1.00' }, 'k'));
});

test('encrypted state round-trips and rejects tampering and expiry', () => {
  const state = { v: 1, exp: 100, o: 'order' };
  const token = sealState(state, stateKey);
  assert.deepEqual(openState(token, stateKey, 99), state);
  const tampered = Buffer.from(token, 'base64url');
  tampered[13] ^= 1;
  assert.throws(() => openState(tampered.toString('base64url'), stateKey, 99));
  assert.throws(() => openState(token, stateKey, 101), /expired/);
});

test('valid Epay authorize verifies the bearer user, binds the provider ID and returns only the checkout URL', async () => {
  const response = await fetch(`${origin}/pay/lanjing/epay/authorize`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: 'Bearer test' },
    body: new URLSearchParams(epayOrder()),
  });
  const payment = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(payment, { checkout_url: `${config.lanjingBase}/payPage/pay.html?orderId=${bridgeOrder.provider_order_id}` });
  const sent = calls.find(call => call.url.endsWith('/createOrder')).options.body;
  assert.equal(sent.get('notifyUrl'), 'https://www.piknoai.com/pay/lanjing/notify');
  assert.equal(sent.get('isHtml'), '0');
  assert.equal(sent.get('price'), '50.00');
  assert.equal(openState(sent.get('param'), stateKey, 1_800_000_000).o, bridgeOrder.trade_no);
  assert.ok(calls.at(-1).url.endsWith('/bind'));
  assert.equal(JSON.parse(calls.at(-1).options.body).really_price, '50.00');
  assert.equal(calls[0].options.headers.authorization, 'Bearer test');
});

test('both payment methods accept exactly the three CNY tiers and reject custom amounts before authentication', async () => {
  for (const type of ['alipay', 'wxpay']) {
    for (const money of ['50.00', '100.00', '200.00']) {
      const tradeNo = `USR12NO${type}${money.replace('.', '')}`;
      const response = await fetch(`${origin}/pay/lanjing/epay/authorize`, {
        method: 'POST', headers: { authorization: 'Bearer test' },
        body: new URLSearchParams(epayOrder({ out_trade_no: tradeNo, type, money })),
      });
      assert.equal(response.status, 200);
      assert.ok((await response.json()).checkout_url);
      assert.equal(calls.at(-2).options.body.get('price'), money);
    }
  }
  const before = calls.length;
  for (const money of ['1.00', '49.99', '50.01', '150.00', '365.00']) {
    const response = await fetch(`${origin}/pay/lanjing/epay/authorize`, {
      method: 'POST', headers: { authorization: 'Bearer test' },
      body: new URLSearchParams(epayOrder({ money })),
    });
    assert.equal(response.status, 403);
  }
  assert.equal(calls.length, before);
});

test('cashier refreshes the session, verifies the paid ledger and returns to the account', async () => {
  const response = await fetch(`${origin}/pay/lanjing/epay/submit.php`, { method: 'POST', body: new URLSearchParams(epayOrder()) });
  const html = await response.text();
  const nonce = html.match(/nonce="([^"]+)"/)[1];
  assert.ok(response.headers.get('content-security-policy').includes(`script-src 'nonce-${nonce}' 'self'`));
  assert.match(html, /\/api\/user\/auth\/refresh/);
  assert.match(html, /import\('\/account-lite\/checkout-qr\.mjs'\)/);
  assert.equal(calls.length, 0);

  const script = html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)[1]
    .replace("import('/account-lite/checkout-qr.mjs')", 'loadQr()');
  const accountReturn = `${config.publicOrigin}/account-lite/index.html?tab=topup&payment_return=1&trade_no=${bridgeOrder.trade_no}`;
  let locked = false;
  let navigation;
  let qrVisible = false;
  let elapsed = 0;
  let checkoutPayment = { checkout: { payment_method: 'alipay', money: '50.00', really_price: '50.01', pay_url: alipayQr, remaining_ms: 60000 } };
  let ledgerStatus = 'success';
  let statusReads = 0;
  const timers = new Map();
  const elements = new Map([['return', { href: accountReturn }]]);
  const element = id => {
    if (!elements.has(id)) elements.set(id, { hidden: true });
    return elements.get(id);
  };
  const browser = {
    AbortController, URL, atob,
    performance: { now: () => elapsed },
    setTimeout(callback, delay) { timers.set(delay, callback); return delay; },
    clearTimeout(delay) { timers.delete(delay); },
    setInterval(callback, delay) { timers.set(delay, callback); return delay; },
    clearInterval(delay) { timers.delete(delay); },
    window: { addEventListener() {}, location: { replace(value) { navigation = value; } } },
    document: { addEventListener() {}, visibilityState: 'visible', getElementById: element },
    navigator: { userAgent: 'iPhone', locks: { async request(name, options, run) {
      assert.equal(name, 'new-api:auth-refresh');
      assert.equal(options.mode, 'exclusive');
      locked = true;
      try { return await run(); } finally { locked = false; }
    } } },
    async loadQr() {
      return { renderCheckoutQr(host, payload) {
        assert.equal(host, element('qr'));
        assert.equal(payload, alipayQr);
        qrVisible = true;
        return () => { qrVisible = false; };
      } };
    },
    async fetch(path, options) {
      if (path === '/api/user/auth/refresh') {
        assert.ok(locked);
        return Response.json({ success: true, data: { access_token: 'synthetic-access' } });
      }
      assert.equal(options.headers['New-Api-User'], '12');
      assert.equal(options.headers.authorization, 'Bearer synthetic-access');
      if (path === '/pay/lanjing/epay/authorize') {
        assert.ok(!locked);
        assert.equal(options.headers['X-PIKNO-Cashier'], '1');
        return Response.json(checkoutPayment);
      }
      assert.equal(path, '/api/user/topup/status?trade_no=' + bridgeOrder.trade_no);
      statusReads++;
      return Response.json({ success: true, data: { trade_no: bridgeOrder.trade_no, status: ledgerStatus } });
    },
  };
  await runInNewContext(script, browser);
  assert.equal(qrVisible, true);
  assert.equal(element('amount').textContent, '实付 ¥50.01');
  assert.equal(element('open-alipay').hidden, false);
  assert.equal(navigation, undefined);
  elapsed = 60001;
  timers.get(1000)();
  assert.equal(qrVisible, false);
  assert.equal(element('open-alipay').onclick, null);
  assert.match(element('status').textContent, /已到期/);
  assert.equal(navigation, undefined);
  await timers.get(5000)();
  assert.equal(navigation, accountReturn);

  checkoutPayment = { return_url: accountReturn, checkout_status: 'expired' };
  ledgerStatus = 'pending';
  navigation = undefined;
  statusReads = 0;
  timers.clear();
  await runInNewContext(script, { ...browser });
  assert.equal(statusReads, 1);
  assert.equal(timers.size, 0);
  assert.equal(navigation, undefined);
  assert.match(element('status').textContent, /已到期/);
  checkoutPayment.checkout_status = 'provider_missing';
  await runInNewContext(script, { ...browser });
  assert.equal(statusReads, 2);
  assert.equal(navigation, undefined);
  assert.match(element('status').textContent, /蓝鲸暂时查不到原付款码/);
  ledgerStatus = 'success';
  await runInNewContext(script, { ...browser });
  assert.equal(statusReads, 3);
  assert.equal(navigation, accountReturn);
  assert.equal(qrVisible, false);
});

test('authorization endpoint rejects requests without an access token', async () => {
  const response = await fetch(`${origin}/pay/lanjing/epay/authorize`, { method: 'POST', body: new URLSearchParams(epayOrder()) });
  assert.equal(response.status, 403);
  assert.equal(calls.length, 0);
});

test('signed user mismatch is rejected', async () => {
  const response = await fetch(`${origin}/pay/lanjing/epay/authorize`, { method: 'POST', headers: { authorization: 'Bearer test' }, body: new URLSearchParams(epayOrder({ out_trade_no: 'USR99NOABC123' })) });
  assert.equal(response.status, 403);
});

test('signed provider cent adjustment credits original order amount', async () => {
  const response = await fetch(`${origin}/pay/lanjing/notify?${new URLSearchParams(providerCallback({}, { reallyPrice: '10.01' }))}`);
  assert.equal(await response.text(), 'success');
  assert.equal(calls[0].options.body.get('money'), '10.00');
  assert.equal(calls[0].options.body.get('really_price'), '10.01');
});

test('duplicate callback forwards same order and mail idempotency key', async () => {
  const url = `${origin}/pay/lanjing/notify?${new URLSearchParams(providerCallback())}`;
  for (let i=0;i<2;i++) assert.equal(await (await fetch(url)).text(), 'success');
  assert.equal(calls[0].options.body.get('out_trade_no'), calls[2].options.body.get('out_trade_no'));
  assert.equal(calls[1].options.headers['idempotency-key'], calls[3].options.headers['idempotency-key']);
});

test('invalid Epay signature is rejected before authentication', async () => {
  const order = epayOrder();
  order.sign = 'bad';
  const response = await fetch(`${origin}/pay/lanjing/epay/submit.php`, { method: 'POST', body: new URLSearchParams(order) });
  assert.equal(response.status, 403);
  assert.equal(await response.text(), 'fail');
  assert.equal(calls.length, 0);
});

test('previous checkout signature cannot open a payment without durable provider binding', async () => {
  const oldOrder = epayOrder();
  oldOrder.sign = epaySign(oldOrder, config.epayKey);
  for (const path of ['/pay/lanjing/epay/submit.php', '/pay/lanjing/epay/authorize']) {
    const response = await fetch(origin + path, {
      method: 'POST', headers: { authorization: 'Bearer test' }, body: new URLSearchParams(oldOrder),
    });
    assert.equal(response.status, 409);
    assert.match(await response.text(), /重新打开充值页面/);
  }
  assert.equal(calls.length, 0);
});

test('valid callback credits New API and sends an idempotent email', async () => {
  const fields = providerCallback();
  const response = await fetch(`${origin}/pay/lanjing/notify?${new URLSearchParams(fields)}`);
  assert.equal(await response.text(), 'success');
  assert.equal(calls[0].url, 'http://new-api:3000/api/user/epay/notify');
  const forwarded = Object.fromEntries(calls[0].options.body);
  assert.equal(forwarded.trade_status, 'TRADE_SUCCESS');
  assert.equal(forwarded.money, '10.00');
  assert.equal(forwarded.sign, epaySign(forwarded, config.epayKey));
  assert.equal(calls[1].options.headers['idempotency-key'], 'pikno-topup-USR12NOABC123');
});

test('invalid callback signature and amount mismatch never credit New API', async () => {
  const invalid = providerCallback({}, { sign: 'bad' });
  invalid.sign = 'bad';
  let response = await fetch(`${origin}/pay/lanjing/notify?${new URLSearchParams(invalid)}`);
  assert.equal(response.status, 403);
  assert.equal(calls.length, 0);

  const mismatch = providerCallback({}, { price: '11.00', reallyPrice: '11.00' });
  response = await fetch(`${origin}/pay/lanjing/notify?${new URLSearchParams(mismatch)}`);
  assert.equal(response.status, 403);
  assert.equal(calls.length, 0);
});

test('return validates provider data and redirects only to the encrypted same-origin URL', async () => {
  const fields = providerCallback();
  const response = await fetch(`${origin}/pay/lanjing/return?${new URLSearchParams(fields)}`, { redirect: 'manual' });
  assert.equal(response.status, 303);
  assert.equal(response.headers.get('location'), 'https://www.piknoai.com/account-lite/index.html?tab=topup&payment_return=1&trade_no=USR12NOABC123');
  assert.equal(calls.length, 0);
});

test('checkout requires a durable claim, and a closing or uncertain order never opens checkout', async () => {
  const authorize = () => fetch(`${origin}/pay/lanjing/epay/authorize`, {
    method: 'POST', headers: { authorization: 'Bearer test' }, body: new URLSearchParams(epayOrder()),
  });
  mockResponse = async (url) => {
    if (url.endsWith('/api/user/self')) return Response.json({ success: true, data: { id: 12 } });
    if (url.endsWith('/createOrder')) throw new Error('provider timeout');
  };
  assert.equal((await authorize()).status, 502);
  const next = await (await authorize()).json();
  assert.match(next.return_url, /payment_return=1/);
  assert.equal(calls.filter(call => call.url.endsWith('/createOrder')).length, 1);

  claimedOrders.clear();
  mockResponse = async (url) => {
    if (url.endsWith('/bind')) return Response.json({ success: true, data: { status: 'closing', provider_order_id: bridgeOrder.provider_order_id } });
  };
  const closing = await (await authorize()).json();
  assert.match(closing.return_url, /payment_return=1/);
  assert.equal(closing.checkout_url, undefined);
});

test('ambiguous binding retries identical order ID and amount once without recreating payment', async () => {
  let attempts = 0;
  mockResponse = async url => {
    if (url.endsWith('/bind') && attempts++ === 0) throw new Error('transport timeout');
  };
  const response = await fetch(`${origin}/pay/lanjing/epay/authorize`, {
    method: 'POST', headers: { authorization: 'Bearer test' }, body: new URLSearchParams(epayOrder()),
  });
  assert.ok((await response.json()).checkout_url);
  const bindings = calls.filter(call => call.url.endsWith('/bind'));
  assert.equal(bindings.length, 2);
  assert.equal(bindings[0].options.body, bindings[1].options.body);
  assert.equal(calls.filter(call => call.url.endsWith('/createOrder')).length, 1);
});

test('resuming the existing bound order returns its QR only while the matching provider order is payable', async () => {
  claimedOrders.set(bridgeOrder.trade_no, { provider_order_id: bridgeOrder.provider_order_id, really_price: bridgeOrder.really_price });
  for (const state of [0, -1, 1, 2]) {
    mockResponse = async url => url.endsWith('/getOrder') ? providerOrder(state) : undefined;
    const response = await fetch(`${origin}/pay/lanjing/epay/authorize`, {
      method: 'POST', headers: { authorization: 'Bearer test' }, body: new URLSearchParams(epayOrder()),
    });
    assert.equal(response.status, 200);
    const result = await response.json();
    if (state === 0) assert.equal(result.checkout_url, `${config.lanjingBase}/payPage/pay.html?orderId=${bridgeOrder.provider_order_id}`);
    else { assert.ok(result.return_url); assert.equal(result.checkout_url, undefined); }
  }
  mockResponse = async url => url.endsWith('/getOrder') ? providerOrder(0, { payId: 'wrong' }) : undefined;
  const rejected = await fetch(`${origin}/pay/lanjing/epay/authorize`, {
    method: 'POST', headers: { authorization: 'Bearer test' }, body: new URLSearchParams(epayOrder()),
  });
  assert.notEqual(rejected.status, 200);
  assert.equal(calls.filter(call => call.url.endsWith('/getOrder')).length, 5);
  assert.equal(calls.filter(call => call.url.endsWith('/createOrder') || call.url.endsWith('/bind')).length, 0);
});

test('cashier returns bound amounts and supported provider QR formats only to the opted-in caller', async () => {
  const wechatMerchantQr = 'https://payapp.weixin.qq.com/materialqr/entry/home?id=123450987654321';
  for (const [type, money, payUrl] of [['alipay', '50.00', alipayQr], ['wxpay', '100.00', wechatQr], ['wxpay', '200.00', wechatMerchantQr]]) {
    const tradeNo = `USR12NO${type}${Number(money)}`;
    mockResponse = async (url, options) => {
      if (!url.endsWith('/createOrder')) return;
      const fields = Object.fromEntries(options.body);
      return providerOrder(0, { payId: fields.payId, payType: Number(fields.type), price: money, reallyPrice: money, payUrl });
    };
    const response = await fetch(`${origin}/pay/lanjing/epay/authorize`, {
      method: 'POST', headers: { authorization: 'Bearer test', 'X-PIKNO-Cashier': '1' },
      body: new URLSearchParams(epayOrder({ out_trade_no: tradeNo, type, money })),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      checkout: { payment_method: type, money, really_price: money, pay_url: payUrl, remaining_ms: 300000 },
    });
    assert.ok(claimedOrders.get(tradeNo).provider_order_id);
  }
  const wxTrade = 'USR12NOwxpay200';
  for (const payUrl of [
    wechatMerchantQr + '&id=9999',
    wechatMerchantQr + '&other=1',
    wechatMerchantQr.replace('weixin.qq.com', 'weixin.qq.com.example'),
  ]) {
    mockResponse = async url => url.endsWith('/getOrder')
      ? providerOrder(0, { payId: wxTrade, payType: 1, price: 200, reallyPrice: 200, payUrl }) : undefined;
    const response = await fetch(`${origin}/pay/lanjing/epay/authorize`, {
      method: 'POST', headers: { authorization: 'Bearer test', 'X-PIKNO-Cashier': '1' },
      body: new URLSearchParams(epayOrder({ out_trade_no: wxTrade, type: 'wxpay', money: '200.00' })),
    });
    assert.equal((await response.json()).checkout_status, 'provider_details_unavailable');
  }

  claimedOrders.set(bridgeOrder.trade_no, { provider_order_id: bridgeOrder.provider_order_id, really_price: bridgeOrder.really_price });
  for (const [payUrl, valid] of [[encodeURIComponent(alipayQr), true], ['https://qr.alipay.com.evil.example/test', false], ['javascript:alert(1)', false]]) {
    mockResponse = async url => url.endsWith('/getOrder') ? providerOrder(0, { payUrl }) : undefined;
    const response = await fetch(`${origin}/pay/lanjing/epay/authorize`, {
      method: 'POST', headers: { authorization: 'Bearer test', 'X-PIKNO-Cashier': '1' },
      body: new URLSearchParams(epayOrder()),
    });
    assert.equal(response.status, 200);
    const result = await response.json();
    if (valid) assert.equal(result.checkout?.pay_url, alipayQr);
    else assert.equal(result.checkout_status, 'provider_details_unavailable');
    assert.equal(result.checkout_url, undefined);
  }
});

test('incomplete create details trigger one lookup of the bound order without recreating it', async () => {
  mockResponse = async url => {
    if (url.endsWith('/createOrder')) return providerOrder(0, { date: undefined, timeOut: undefined, payUrl: undefined });
    if (url.endsWith('/getOrder')) return providerOrder(0, { date: String(currentTime), timeOut: '5' });
  };
  const response = await fetch(`${origin}/pay/lanjing/epay/authorize`, {
    method: 'POST', headers: { authorization: 'Bearer test', 'X-PIKNO-Cashier': '1' },
    body: new URLSearchParams(epayOrder()),
  });
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).checkout, {
    payment_method: 'alipay', money: '50.00', really_price: '50.01', pay_url: alipayQr, remaining_ms: 300000,
  });
  const operations = calls.map(call => new URL(call.url).pathname).filter(path => /\/(claim|bind|createOrder|getOrder)$/.test(path));
  assert.deepEqual(operations.map(path => path.split('/').at(-1)), ['claim', 'createOrder', 'bind', 'getOrder']);
  assert.equal(calls.at(-1).options.body.get('orderId'), bridgeOrder.provider_order_id);

  const tradeNo = 'USR12NOmissing';
  mockResponse = async url => {
    if (url.endsWith('/createOrder')) return providerOrder(0, { payId: tradeNo, payUrl: undefined });
    if (url.endsWith('/getOrder')) return Response.json({ code: -1, msg: '云端订单编号不存在', data: null });
  };
  const missing = await fetch(`${origin}/pay/lanjing/epay/authorize`, {
    method: 'POST', headers: { authorization: 'Bearer test', 'X-PIKNO-Cashier': '1' },
    body: new URLSearchParams(epayOrder({ out_trade_no: tradeNo })),
  });
  const result = await missing.json();
  assert.equal(result.checkout_status, 'provider_missing');
  assert.equal(result.checkout, undefined);
  assert.ok(claimedOrders.get(tradeNo).provider_order_id);
  assert.equal(calls.filter(call => call.url.endsWith('/createOrder')).length, 2);
  assert.equal(calls.filter(call => call.url.endsWith('/getOrder')).length, 2);
});

test('checkout logs only the original provider field shapes before the fallback lookup', async () => {
  for (const testCase of [
    {
      fields: { date: currentTime / 1000, timeOut: '5', payUrl: null },
      shape: {
        reason: 'provider_timing_invalid',
        date_type: 'number', date_format: 'seconds', timeout_type: 'string', timeout_positive_integer: true,
        qr_type: 'null', qr_format: 'missing',
      },
    },
    {
      fields: { date: String(currentTime), timeOut: 5, payUrl: 'https://example.invalid/synthetic-private-qr' },
      shape: {
        reason: 'provider_qr_unsupported',
        date_type: 'string', date_format: 'millis', timeout_type: 'number', timeout_positive_integer: true,
        qr_type: 'string', qr_format: 'unsupported_host_or_path',
      },
    },
  ]) {
    claimedOrders.clear();
    logs.length = 0;
    const expected = { event: 'checkout_details_incomplete', method: 'alipay', ...testCase.shape };
    mockResponse = async url => {
      if (url.endsWith('/createOrder')) return providerOrder(0, testCase.fields);
      if (url.endsWith('/getOrder')) {
        assert.deepEqual(logs, [expected]);
        return providerOrder(0);
      }
    };
    const response = await fetch(`${origin}/pay/lanjing/epay/authorize`, {
      method: 'POST', headers: { authorization: 'Bearer synthetic-private-token', 'X-PIKNO-Cashier': '1' },
      body: new URLSearchParams(epayOrder()),
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).checkout?.pay_url, alipayQr);
    assert.deepEqual(logs, [expected]);
  }
});

test('checkout uses time after binding and avoids redirecting to expired or missing provider orders', async () => {
  const authorize = (cashier) => fetch(`${origin}/pay/lanjing/epay/authorize`, {
    method: 'POST', headers: { authorization: 'Bearer test', ...(cashier ? { 'X-PIKNO-Cashier': '1' } : {}) },
    body: new URLSearchParams(epayOrder()),
  });
  mockResponse = async url => {
    if (url.endsWith('/bind')) now += 300000;
  };
  const newExpired = await (await authorize(true)).json();
  assert.ok(newExpired.return_url);
  assert.equal(newExpired.checkout_status, 'expired');
  assert.ok(claimedOrders.get(bridgeOrder.trade_no).provider_order_id);

  mockResponse = async url => url.endsWith('/getOrder') ? providerOrder(0, { reallyPrice: '50.00' }) : undefined;
  const expired = await (await authorize(false)).json();
  assert.ok(expired.return_url);
  assert.equal(expired.checkout_status, undefined);
  assert.equal(expired.checkout_url, undefined);

  mockResponse = async url => url.endsWith('/getOrder') ? Response.json({ code: -1, msg: '云端订单编号不存在', data: null }) : undefined;
  const missing = await (await authorize(true)).json();
  assert.ok(missing.return_url);
  assert.equal(missing.checkout_url, undefined);
  assert.equal(missing.checkout_status, 'provider_missing');
  assert.deepEqual(logs.at(-1), { event: 'checkout_code_unavailable', phase: 'resume', method: 'alipay', reason: 'provider_missing' });

  mockResponse = async url => url.endsWith('/getOrder') ? providerOrder(0, { reallyPrice: '50.00', date: undefined }) : undefined;
  const invalid = await (await authorize(true)).json();
  assert.ok(invalid.return_url);
  assert.equal(invalid.checkout_status, 'provider_details_unavailable');
  assert.deepEqual(logs.at(-1), { event: 'checkout_code_unavailable', phase: 'resume', method: 'alipay', reason: 'provider_timing_invalid' });

  mockResponse = async url => url.endsWith('/getOrder') ? providerOrder(-1, { reallyPrice: '50.00', date: undefined }) : undefined;
  const explicitlyExpired = await (await authorize(true)).json();
  assert.equal(explicitlyExpired.checkout_status, 'expired');
  assert.equal(calls.filter(call => call.url.endsWith('/createOrder')).length, 1);
});

test('callback acknowledges accounting success even while recharge email is delayed or fails', async () => {
  let release;
  mockResponse = async url => {
    if (url === 'https://api.resend.com/emails') {
      await new Promise(resolve => { release = resolve; });
      return new Response('', { status: 503 });
    }
  };
  const url = `${origin}/pay/lanjing/notify?${new URLSearchParams(providerCallback())}`;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
    assert.equal(await response.text(), 'success');
    assert.ok(release);
  } finally {
    release?.();
  }
});

test('signed close request closes a matching pending provider order, while a forged or mismatched request makes no change', async () => {
  assert.equal((await callInternal('cancel', undefined, '0'.repeat(64))).status, 403);
  assert.equal(calls.length, 0);
  mockResponse = async (url) => {
    if (url.endsWith('/getOrder')) return providerOrder(0, { payId: 'different-order' });
  };
  assert.deepEqual(await (await callInternal('cancel')).json(), { status: 'processing' });
  assert.equal(calls.filter(call => call.url.endsWith('/closeOrder')).length, 0);
  mockResponse = async (url) => {
    if (url.endsWith('/getOrder')) return providerOrder(0, { orderId: 'different-provider-order' });
  };
  assert.deepEqual(await (await callInternal('cancel')).json(), { status: 'processing' });
  assert.equal(calls.filter(call => call.url.endsWith('/closeOrder')).length, 0);
  mockResponse = async (url, options) => {
    if (url.endsWith('/getOrder')) return providerOrder(0);
    if (url.endsWith('/closeOrder')) {
      assert.equal(options.body.get('orderId'), bridgeOrder.provider_order_id);
      assert.equal(options.body.get('sign'), md5(bridgeOrder.provider_order_id + config.lanjingKey));
      return Response.json({ code: 1 });
    }
  };
  assert.deepEqual(await (await callInternal('cancel')).json(), { status: 'cancelled' });
});

test('a failed close rechecks paid orders and credits only the matching signed provider evidence', async () => {
  let reads = 0;
  let signedDestination = `${config.publicOrigin}/pay/lanjing/return?${new URLSearchParams(providerCallback({ m: '50.00' }, { reallyPrice: '50.01' }))}`;
  mockResponse = async (url) => {
    if (url.endsWith('/getOrder')) return providerOrder(reads++ === 0 ? 0 : 2);
    if (url.endsWith('/closeOrder')) return Response.json({ code: -1 });
    if (url.endsWith('/checkOrder')) return Response.json({ code: 1, data: signedDestination });
  };
  assert.deepEqual(await (await callInternal('cancel')).json(), { status: 'paid' });
  assert.equal(calls.find(call => call.url.endsWith('/api/user/epay/notify')).options.body.get('money'), '50.00');
  signedDestination = signedDestination.replace(config.publicOrigin, 'https://unrelated.example');
  const credits = calls.filter(call => call.url.endsWith('/api/user/epay/notify')).length;
  assert.deepEqual(await (await callInternal('status')).json(), { status: 'processing' });
  assert.equal(calls.filter(call => call.url.endsWith('/api/user/epay/notify')).length, credits);
  assert.ok(!calls.some(call => call.url.startsWith('https://unrelated.example')));
  signedDestination = `${config.publicOrigin}/pay/lanjing/return?${new URLSearchParams(providerCallback({ m: '50.00' }, { reallyPrice: '50.02' }))}`;
  assert.deepEqual(await (await callInternal('status')).json(), { status: 'processing' });
  assert.equal(calls.filter(call => call.url.endsWith('/api/user/epay/notify')).length, credits);
});
