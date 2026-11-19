import test from 'node:test';
import assert from 'node:assert/strict';
import { createAccountClient, paymentForm, keyPayload, cnyFromQuota, operationStore, tokenMetadata, retryAfterMs, adminHome } from '../public/account-lite/client.mjs';

const bundle = (id = 12, sid = 'session-12') => ({ access_token: 'synthetic-access', access_expires_at: Math.floor(Date.now() / 1000) + 300, user: { id, username: `fixture-${id}` }, session: { sid } });
const response = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
const success = (data) => response({ success: true, data });
const status = { quota_per_unit: 7300000, usd_exchange_rate: 7.3 };
const payment = { url: 'https://account.test/pay/lanjing/epay/submit.php', data: { pid: 'fixture', type: 'alipay', out_trade_no: 'USR12NOfixture', notify_url: 'https://account.test/api/user/epay/notify', return_url: 'https://account.test/usage-logs', name: 'TUC50', money: '50.00', sign_type: 'MD5', sign: '0'.repeat(32) } };

test('quota uses server units; unknown configuration never guesses money', () => {
  assert.equal(cnyFromQuota(50000000, status), 50);
  assert.equal(cnyFromQuota(50000000, {}), null);
  assert.equal(cnyFromQuota(Infinity, status), null);
});
test('pending operation metadata survives reload, stays account-scoped and excludes secrets', () => {
  const values = new Map(), storage = { getItem: (key) => values.get(key), setItem: (key, value) => values.set(key, value), removeItem: (key) => values.delete(key) };
  operationStore(storage).save('pay', 12, { startedAt: Date.now(), order: 'USR12NOfixture', access_token: 'must-not-persist', sign: 'must-not-persist' });
  assert.equal(operationStore(storage).read('pay', 12).order, 'USR12NOfixture');
  assert.equal(operationStore(storage).read('pay', 13), null);
  assert.doesNotMatch([...values.values()].join(''), /must-not-persist/);
  operationStore(storage).remove('pay', 12); assert.equal(values.size, 0);
});
test('token row projections never keep a legacy full key or unrelated response fields', () => {
  const value = tokenMetadata({ id: 7, name: 'test', group: 'image-standard', key: 'secret', raw: { key: 'secret' } });
  assert.equal(value.name, 'test'); assert.equal(Object.hasOwn(value, 'key'), false); assert.equal(Object.hasOwn(value, 'raw'), false);
});
test('key creation restricts four groups to account grants and preserves an optional cap', () => {
  assert.equal(keyPayload('My key', 'image-standard', 30, '50', status, { 'image-standard': {} }).remain_quota, 50000000);
  assert.equal(keyPayload('My key', 'chat-standard', 7, '', status, { 'chat-standard': {} }).unlimited_quota, true);
  for (const group of ['auto', 'default', 'private']) assert.throws(() => keyPayload('My key', group, 30, '', status, { [group]: {} }));
  assert.throws(() => keyPayload('My key', 'tool-standard', 30, '', status, {}));
  assert.throws(() => keyPayload('My key', 'image-standard', 30, '-1', status, { 'image-standard': {} }));
});
test('payment accepts only the same-origin signed bridge order for this user and amount', () => {
  assert.equal(paymentForm(payment, 'https://account.test', { amount: 50, method: 'alipay', userID: 12 }).action, payment.url);
  for (const change of [{ url: 'https://evil.test/pay/lanjing/epay/submit.php' }, { url: `${payment.url}?token=x` }, { data: { ...payment.data, authorization: 'secret' } }, { data: { ...payment.data, money: '100.00' } }, { data: { ...payment.data, return_url: 'https://evil.test/' } }, { data: { ...payment.data, out_trade_no: 'USR13NOfixture' } }]) assert.throws(() => paymentForm({ ...payment, ...change }, 'https://account.test', { amount: 50, method: 'alipay', userID: 12 }));
});
test('one-click authorization reuses the authenticated session for one same-origin POST', async () => {
  const calls = [];
  const client = createAccountClient({ locks: null, fetchImpl: async (path, options) => {
    calls.push({ path, options });
    return path.endsWith('/refresh') ? success(bundle()) : response({ checkout_url: 'https://1.pay.lanjingzf.com/payPage/pay.html?orderId=fixture' });
  } });
  await client.refresh();
  assert.equal(typeof (await client.authorizePayment(payment.data)).checkout_url, 'string');
  assert.deepEqual(calls.map(({ path }) => path), ['/api/user/auth/refresh', '/pay/lanjing/epay/authorize']);
  const { options } = calls[1];
  assert.equal(options.method, 'POST');
  assert.equal(options.headers.Authorization, 'Bearer synthetic-access');
  assert.equal(options.body.get('out_trade_no'), payment.data.out_trade_no);
  assert.equal(options.body.has('Authorization'), false);
  assert.equal(options.redirect, 'error');
});
test('refresh is single flight and cookies stay with same-origin requests', async () => {
  const calls = [];
  const client = createAccountClient({ locks: null, fetchImpl: async (path, options) => { calls.push({ path, options }); return success(bundle()); } });
  await Promise.all([client.refresh(), client.refresh()]); assert.equal(calls.length, 1);
  assert.equal(calls[0].options.credentials, 'same-origin'); assert.equal(calls[0].options.redirect, 'error'); assert.equal(calls[0].options.cache, 'no-store');
});
test('writes are never automatically replayed after unauthorized or uncertain responses', async () => {
  const calls = [];
  const client = createAccountClient({ locks: null, fetchImpl: async (path) => { calls.push(path); return path.endsWith('/refresh') ? success(bundle()) : response({ success: false }, 401); } });
  await client.refresh();
  await assert.rejects(client.request('/api/user/pay', { method: 'POST', body: { amount: 50 } }), /登录已过期/);
  assert.equal(calls.filter((path) => path === '/api/user/pay').length, 1);
  assert.equal(calls.length, 2);
});

test('desktop recharge binds its context to the exact create request and rejects unrelated uses', async () => {
  const calls = [];
  const client = createAccountClient({ locks: null, fetchImpl: async (path, options) => { calls.push({ path, options }); return path.endsWith('/refresh') ? success(bundle()) : success({}); } });
  await client.refresh();
  const flow = 'F'.repeat(43);
  await client.request('/api/user/pay', { method: 'POST', body: { amount: 50, payment_method: 'alipay' }, desktopFlow: flow });
  assert.equal(calls[1].options.headers['X-Hamster-Desktop-Flow'], flow);
  await assert.rejects(client.request('/api/user/self', { desktopFlow: flow }), { code: 'DESKTOP_FLOW_INVALID' });
  await assert.rejects(client.request('/api/user/pay', { method: 'POST', desktopFlow: 'invalid' }), { code: 'DESKTOP_FLOW_INVALID' });
  assert.equal(calls.length, 2);
});
test('only GET retries once after refresh and never crosses an account change', async () => {
  let refreshes = 0, reads = 0;
  const client = createAccountClient({ locks: null, fetchImpl: async (path) => {
    if (path.endsWith('/refresh')) return success(bundle(++refreshes === 1 ? 12 : 13, refreshes === 1 ? 'session-12' : 'session-13'));
    reads++; return response({ success: false }, 401);
  } });
  await client.refresh(); await assert.rejects(client.request('/api/user/self'), /账户已切换/);
  assert.equal(reads, 1); assert.equal(client.current(), null);
});
test('late responses are discarded after sign out', async () => {
  let finish;
  const client = createAccountClient({ locks: null, fetchImpl: async (path) => path.endsWith('/refresh') ? success(bundle()) : new Promise((resolve) => { finish = resolve; }) });
  await client.refresh(); const pending = client.request('/api/token/'); client.clear(); finish(success({ items: [{ key: 'must-not-render' }] }));
  await assert.rejects(pending, /结果已丢弃/);
});
test('refresh binds X-Auth-Session and handles a cookie session mismatch by clearing identity', async () => {
  const calls = []; const changes = [];
  const client = createAccountClient({ locks: null, onChange: (value) => changes.push(value), fetchImpl: async (path, options) => { calls.push(options); return calls.length === 1 ? success(bundle()) : response({ success: false, code: 'AUTH_SESSION_MISMATCH' }, 409); } });
  await client.refresh(); await assert.rejects(client.refresh(), /请登录/);
  assert.equal(calls[1].headers['X-Auth-Session'], 'session-12'); assert.equal(changes.at(-1), null);
});

test('Retry-After supports seconds and dates with bounded defaults', () => {
  const now = Date.parse('2026-10-23T11:00:00Z');
  assert.equal(retryAfterMs('45', now), 45000);
  assert.equal(retryAfterMs('Fri, 23 Oct 2026 11:02:00 GMT', now), 120000);
  assert.equal(retryAfterMs('Fri, 23 Oct 2026 10:00:00 GMT', now), 1000);
  for (const value of [null, '', 'not-a-delay']) assert.equal(retryAfterMs(value, now), 60000);
  assert.equal(retryAfterMs('0', now), 1000);
  assert.equal(retryAfterMs('999999999', now), 3600000);
});

test('empty or JSON 429 responses preserve status and cooldown without replaying writes', async () => {
  for (const body of ['', JSON.stringify({ success: false, code: 'arbitrary-private-server-detail' })]) {
    const calls = [];
    const client = createAccountClient({ locks: null, fetchImpl: async (path) => {
      calls.push(path); return path.endsWith('/refresh') ? success(bundle()) : new Response(body, { status: 429, headers: { 'Retry-After': '17' } });
    } });
    await client.refresh();
    for (const path of ['/api/user/pay', '/api/token/']) await assert.rejects(client.request(path, { method: 'POST', body: {} }), (error) => error.code === 'RATE_LIMITED' && error.status === 429 && error.retryAfterMs === 17000 && !error.message.includes('arbitrary'));
    assert.equal(calls.length, 3); assert.equal(client.current().user.id, 12);
  }
});

test('empty refresh 429 keeps an existing identity, with safe default delay', async () => {
  let calls = 0;
  const client = createAccountClient({ locks: null, fetchImpl: async () => ++calls === 1 ? success(bundle()) : new Response('', { status: 429 }) });
  await client.refresh();
  await assert.rejects(client.refresh(), (error) => error.status === 429 && error.retryAfterMs === 60000);
  assert.equal(client.current().user.id, 12); assert.equal(calls, 2);
});

test('admin entry is based only on the current authenticated numeric role', () => {
  assert.equal(adminHome({ role: 200 }), '/line-management');
  assert.equal(adminHome({ role: 100 }), '/line-management');
  assert.equal(adminHome({ role: 10 }), '/channels');
  for (const user of [null, {}, { role: 1 }, { role: 9 }, { role: '200' }, { role: Infinity }]) assert.equal(adminHome(user), '');
});
