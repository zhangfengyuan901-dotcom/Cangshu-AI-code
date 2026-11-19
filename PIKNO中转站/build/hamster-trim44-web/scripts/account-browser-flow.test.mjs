import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { JSDOM } from 'jsdom';
import { AccountError } from '../public/account-lite/client.mjs';

const source = await readFile(new URL('../public/account-lite/account.mjs', import.meta.url), 'utf8');
function functions(...names) {
  return names.map(name => {
    const value = source.match(new RegExp('^(?:async )?function ' + name + '\\([^\\n]*\\) \\{[\\s\\S]*?^\\}', 'm'))?.[0];
    assert.ok(value, 'function ' + name + ' exists'); return value;
  }).join('\n');
}
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { resolve, promise }; }

const html = await readFile(new URL('../public/account-lite/index.html', import.meta.url), 'utf8');
const user = { id: 12, username: 'fixture-user', display_name: 'Fixture Display Name' };
const legacyOrder = {
  trade_no: 'USR12NOhistorical', money: 50, payment_method: 'alipay',
  create_time: 1794950000, status: 'pending', checkout_state: 'ready',
};
let fixtureID = 0;

async function openAccountPage(t, { desktopFlow = '', inspect, search = '?tab=topup', exchangeRate = 7.3 } = {}) {
  const entry = new URL('https://account.invalid/account-lite/index.html' + search);
  if (desktopFlow) entry.hash = `desktop=${desktopFlow}`;
  const { window } = new JSDOM(html, { url: entry.href });
  const fixture = { quota: 128500000, orders: [legacyOrder], calls: [] };
  const domGlobals = ['window', 'document', 'history', 'location', 'localStorage', 'sessionStorage', 'navigator', 'Event', 'BroadcastChannel'];
  const globals = Object.getOwnPropertyDescriptors(globalThis);
  t.after(() => {
    window.close();
    for (const name of domGlobals) {
      if (globals[name]) Object.defineProperty(globalThis, name, globals[name]);
      else delete globalThis[name];
    }
  });
  for (const name of domGlobals) {
    Object.defineProperty(globalThis, name, {
      configurable: true,
      value: name === 'window' ? window : name === 'BroadcastChannel' ? undefined : window[name],
    });
  }
  const response = (data, status = 200) => new Response(JSON.stringify(data), { status });
  const ok = data => response({ success: true, data });
  t.mock.method(globalThis, 'fetch', async (input, { method = 'GET', body } = {}) => {
    const target = new URL(input, entry);
    fixture.calls.push({ path: target.pathname, method, body: body ? JSON.parse(body) : undefined });
    assert.equal(target.origin, entry.origin);
    if (target.pathname === '/api/status') return ok({ quota_per_unit: 7300000, usd_exchange_rate: exchangeRate });
    if (target.pathname === '/api/user/auth/refresh') return ok({
      access_token: 'fixture-access', access_expires_at: Math.floor(Date.now() / 1000) + 300,
      user, session: { sid: 'fixture-session' },
    });
    if (target.pathname === '/api/user/self') return ok({ id: user.id, quota: fixture.quota, used_quota: 0 });
    if (target.pathname === '/api/user/topup/self') return ok({ total: fixture.orders.length, items: fixture.orders });
    if (target.pathname === '/api/pikno/settlements/self') return ok({ total: 1, items: [
      { order_id: 'img_fixture', model: 'pikno-image-flare', financial_state: 'settled', net_quota: 300050,
        reserved_quota: 0, refunded_quota: 0, created_at: 1794950000 }
    ] });
    if (target.pathname === '/api/token/') return ok({ total: 0, items: [] });
    if (target.pathname === '/api/user/desktop/inspect' && inspect) {
      const result = await inspect();
      return result?.code ? response({ success: false, code: result.code }, 409) : ok(result);
    }
    if (target.pathname === '/api/user/desktop/approve' && inspect) return ok(await inspect(true));
    throw new Error(`Unexpected fixture request ${method} ${target.pathname}`);
  });
  const node = id => window.document.getElementById(id);
  function waitFor(condition, description) {
    if (condition()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const observer = new window.MutationObserver(() => {
        if (!condition()) return;
        observer.disconnect();
        clearTimeout(timeout);
        resolve();
      });
      const timeout = setTimeout(() => {
        observer.disconnect();
        reject(new Error(`Timed out waiting for ${description}`));
      }, 3000);
      observer.observe(window.document.body, { subtree: true, attributes: true, childList: true, characterData: true });
    });
  }
  await import(new URL(`../public/account-lite/account.mjs?fixture=${++fixtureID}`, import.meta.url));
  return { fixture, node, window, waitFor };
}

test('image settlement link shows the server net debit directly', async t => {
  const { node, waitFor, fixture } = await openAccountPage(t, { search: '?tab=usage&kind=settlements', exchangeRate: 9 });
  assert.equal(node('usage-kind').value, 'settlements');
  await waitFor(() => node('usage-list').textContent.includes('img_fixture'), 'image ledger row');
  assert.equal(node('usage-list').querySelector('.record-title').textContent, '图片生成');
  assert.equal(node('usage-list').querySelector('.record-amount').textContent, '¥0.30005');
  assert.ok(!fixture.calls.some(call => call.path === '/api/log/self'));
});

function assertReadOnlyRecharge(calls) {
  const allowed = [
    'GET /api/status', 'POST /api/user/auth/refresh', 'POST /api/user/desktop/inspect',
    'POST /api/user/desktop/approve', 'GET /api/user/self', 'GET /api/user/topup/self', 'GET /api/token/',
  ];
  assert.deepEqual(calls.map(({ method, path }) => `${method} ${path}`).filter(request => !allowed.includes(request)), []);
}

test('manual recharge displays the account and refreshes the relay balance and read-only historical orders', async t => {
  const { fixture, node, window, waitFor } = await openAccountPage(t);
  assert.equal(node('topup').hidden, false);
  assert.equal(node('topup').querySelector('h2').textContent, '添加管理员充值');
  await waitFor(() => node('order-list').textContent.includes(legacyOrder.trade_no), 'historical order');
  const identity = node('manual-recharge-account');
  assert.equal(identity.hidden, false);
  assert.match(identity.textContent, /fixture-user/);
  assert.match(identity.textContent, /用户 ID[：:]\s*12/);
  assert.equal(node('balance-value').textContent, '¥128.50');
  assert.match(node('order-list').textContent, /待核对/);
  assert.equal(node('order-list').querySelector('a,button,input,form'), null);
  assert.equal(node('topup').querySelector('form'), null);

  const firstBalanceReads = fixture.calls.filter(call => call.path === '/api/user/self').length;
  const firstHistoryReads = fixture.calls.filter(call => call.path === '/api/user/topup/self').length;
  fixture.quota = 178500000;
  fixture.orders = [{ ...legacyOrder, status: 'success' }];
  const refresh = node('refresh-orders');
  assert.equal(refresh.textContent.trim(), '刷新余额与记录');
  refresh.click();
  await waitFor(() => !refresh.disabled && node('balance-value').textContent === '¥178.50', 'updated relay balance');
  assert.match(node('order-list').textContent, /已入账/);
  assert.equal(fixture.calls.filter(call => call.path === '/api/user/self').length, firstBalanceReads + 1);
  assert.equal(fixture.calls.filter(call => call.path === '/api/user/topup/self').length, firstHistoryReads + 1);
  assertReadOnlyRecharge(fixture.calls);

  fixture.quota = 180500000;
  window.document.querySelector('[data-tab="balance"]').click();
  assert.equal(node('balance').hidden, false);
  assert.equal(node('balance-value').textContent, '¥178.50');
  await waitFor(() => node('balance-value').textContent === '¥180.50', 'balance tab read');
  assertReadOnlyRecharge(fixture.calls);
});

test('desktop recharge reveals the account only after the desktop flow matches', async t => {
  const desktopFlow = 'F'.repeat(43);
  const first = deferred();
  let checks = 0;
  const { fixture, node, waitFor } = await openAccountPage(t, {
    desktopFlow, inspect: async () => {
      if (++checks === 1) return first.promise;
      return { flow_id: desktopFlow, purpose: 'recharge', status: 'ready', account_matched: true, requires_approval: false, expires_at: Math.floor(Date.now() / 1000) + 900 };
    },
  });
  const identity = node('manual-recharge-account');
  assert.equal(identity.hidden, true);
  assert.equal(identity.textContent, '');
  first.resolve({ code: 'DESKTOP_ACCOUNT_MISMATCH' });
  await waitFor(() => node('desktop-message').textContent.includes('账号不一致') && !node('refresh').disabled, 'account mismatch');
  assert.equal(identity.hidden, true);
  assert.equal(identity.textContent, '');

  node('desktop-retry').click();
  await waitFor(() => !identity.hidden, 'verified desktop account');
  assert.match(identity.textContent, /fixture-user.*用户 ID[：:]\s*12/);
  assert.deepEqual(fixture.calls.filter(call => call.path.endsWith('/desktop/inspect')).map(call => call.body), [{ flow_id: desktopFlow }, { flow_id: desktopFlow }]);
  assertReadOnlyRecharge(fixture.calls);
});

test('first desktop connection still requires explicit approval before showing the recharge account', async t => {
  const desktopFlow = 'C'.repeat(43);
  const { fixture, node, waitFor } = await openAccountPage(t, {
    desktopFlow, inspect: async (approved = false) => ({
      flow_id: desktopFlow, purpose: 'connect', status: approved ? 'approved' : 'pending',
      account_matched: true, requires_approval: !approved, expires_at: Math.floor(Date.now() / 1000) + 900,
    }),
  });
  const identity = node('manual-recharge-account'), connect = node('desktop-connect');
  await waitFor(() => !connect.hidden && !connect.disabled && !node('refresh').disabled, 'desktop connection approval');
  assert.equal(identity.hidden, true);
  assert.equal(fixture.calls.some(call => call.path.endsWith('/desktop/approve')), false);
  connect.click();
  await waitFor(() => !identity.hidden, 'approved desktop account');
  assert.match(identity.textContent, /fixture-user/);
  assert.deepEqual(fixture.calls.find(call => call.path.endsWith('/desktop/approve'))?.body, { flow_id: desktopFlow, confirmed: true });
  assertReadOnlyRecharge(fixture.calls);
});

test('recreating the account page on back navigation restores the selected tab at its canonical URL', async () => {
  const document = { querySelectorAll: () => [] }, history = {
    state: { preserved: true },
    replaceState(next, _title, url) { this.state = next; this.url = url; },
  };
  const methods = runInNewContext(functions('accountEntryTab', 'saveAccountTab', 'switchTab') + '\n({accountEntryTab, saveAccountTab, switchTab})', {
    history, document, state: {}, closeReveals() {}, async loadTab() {},
  });
  const url = new URL('https://account.test/account-lite/index.html?tab=topup#keys');
  assert.equal(methods.accountEntryTab(url, 'usage'), 'topup');
  methods.saveAccountTab('topup', true);
  assert.equal(history.state.preserved, true); assert.equal(history.url, '/account-lite/index.html');
  const canonical = new URL(history.url, url);
  assert.equal(methods.accountEntryTab(canonical, history.state.tab), 'topup');
  assert.equal(methods.accountEntryTab(new URL('#keys', canonical), history.state.tab), 'keys');
  await methods.switchTab('usage');
  assert.equal(methods.accountEntryTab(canonical, history.state.tab), 'usage');
  assert.equal(methods.accountEntryTab(canonical, 'invalid'), 'balance');
});

test('BFCache restore waits for the stale bootstrap, clears private identity and coalesces duplicate pageshow requests', async () => {
  const old = deferred(); let cleared = 0, opened = 0, boots = 0;
  const state = { suspended: true, restoring: null, bootstrap: old.promise, loading: new Set(['keys']), lastRefresh: 123 };
  old.promise.finally(() => { state.bootstrap = null; });
  const context = { state, client: { clear() { cleared++; } }, openAuthChannel() { opened++; }, bootstrap: async () => { boots++; } };
  const restore = runInNewContext(`${functions('restorePage')}\nrestorePage`, context);
  const one = restore(), two = restore(); assert.equal(one, two); assert.equal(boots, 0); assert.equal(cleared, 1);
  old.resolve(); await one; assert.equal(boots, 1); assert.equal(opened, 1); assert.equal(state.loading.size, 0); assert.equal(state.lastRefresh, 0); assert.equal(state.restoring, null);
});

test('a second navigation while restore is pending schedules one fresh read after the invalidated read', async () => {
  const reading = deferred(); let boots = 0;
  const state = { suspended: true, restoring: null, bootstrap: null, loading: new Set() };
  const restore = runInNewContext(`${functions('restorePage')}\nrestorePage`, { state, client: { clear() {} }, openAuthChannel() {}, bootstrap: async () => { boots++; if (boots === 1) await reading.promise; } });
  const one = restore(); assert.equal(boots, 1); state.suspended = true;
  assert.equal(restore(), one); reading.resolve(); await one;
  assert.equal(boots, 2); assert.equal(state.suspended, false);
});

test('a late old-generation tab completion cannot release a new generation loading lock', async () => {
  const reading = deferred(); let generation = 0;
  const state = { loading: new Set() };
  const loadTab = runInNewContext(`${functions('loadTab')}\nloadTab`, { state, client: { current: () => ({}), generation: () => generation }, loadKeys: () => reading.promise });
  const old = loadTab('keys'); generation++; state.loading.clear(); state.loading.add('keys'); reading.resolve(); await old;
  assert.equal(state.loading.has('keys'), true);
});

test('a bootstrap invalidated during its first read cannot restore status, private data or activation', async () => {
  const status = deferred(), auth = deferred(); let generation = 0, reads = 0;
  const state = { suspended: false, bootstrap: null, status: null }, refresh = { disabled: false };
  const boot = runInNewContext(`${functions('bootstrap')}\nbootstrap`, {
    state, $: () => refresh, notice() {}, reportFailure() {}, AccountError,
    client: { generation: () => generation, publicStatus: () => status.promise, refresh: () => auth.promise },
    loadBalance: () => { reads++; }, resumeSelectedKeys: () => { reads++; }, loadTab: () => { reads++; }, loadSetupGuide: () => { reads++; },
  });
  const pending = boot(); generation++; state.suspended = true; status.resolve({ quota_per_unit: 123 }); auth.resolve({}); await pending;
  assert.equal(state.status, null); assert.equal(reads, 0); assert.equal(state.bootstrap, null); assert.equal(refresh.disabled, false);
});

test('lifecycle cleanup and compatibility use remain explicit without putting signed fields in markup', () => {
  assert.match(source, /import \{ hasOwn, secureUUID, openDialog, closeDialog, desktopFlowContext \} from '\.\/compat\.mjs'/);
  assert.doesNotMatch(source, /Object\.hasOwn|crypto\.randomUUID|\.showModal\(/);
  assert.match(source, /pagehide', \(\) => \{ state\.suspended = true; client\.clear\(\)/);
  assert.match(source, /pageshow', \(event\) => \{ if \(event\.persisted\) void restorePage\(\)/);
  assert.match(source, /Ctrl\+C 或 ⌘C；手机请长按/);
});
