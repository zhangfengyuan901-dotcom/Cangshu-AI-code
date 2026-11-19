import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createContext, runInContext } from 'node:vm';
import { desktopFlowContext } from '../public/account-lite/compat.mjs';

const authSource = await readFile(new URL('../public/auth-lite/auth.mjs', import.meta.url), 'utf8');
const turn = async () => { for (let step = 0; step < 12; step++) await Promise.resolve(); };
const session = { session: { sid: 'synthetic-session' }, user: { id: 12, role: 1 } };
function harness({ mode = 'login', unknown = null, refresh, login, statusFetch, turnstile = false } = {}) {
  const nodes = new Map(), windowEvents = new Map(), calls = [], navigations = [], widgets = [];
  const node = (id) => {
    if (!nodes.has(id)) nodes.set(id, {
      id, value: '', textContent: '', hidden: false, disabled: false, checked: false, type: 'password', events: new Map(),
      classList: { toggle() {} }, querySelectorAll: () => [], replaceChildren() {},
      addEventListener(name, listener) { this.events.set(name, listener); }, focus() { this.focused = true; }, select() { this.selected = true; }, setSelectionRange(start, end) { this.selection = [start, end]; },
    });
    return nodes.get(id);
  };
  const client = {
    unknown: () => unknown, cancel: () => calls.push('cancel'), restart() { unknown = null; calls.push('restart'); },
    status: async () => { calls.push('status'); return statusFetch ? statusFetch() : { password_login_enabled: true, turnstile_check: turnstile, turnstile_site_key: 'synthetic-site-key' }; },
    refresh: async () => { calls.push('refresh'); if (refresh) return refresh(); throw Object.assign(new Error('not authenticated'), { status: 401 }); },
    login: async () => { calls.push('login'); return login ? login() : { challenge: { methods: [{ method: '2fa', available: true }] } }; },
    verify: async () => { calls.push('verify'); return { bundle: session }; },
  };
  const context = createContext({
    URL, Date, Event, sessionStorage: { getItem: () => null }, desktopFlowContext, createAuthClient: () => client, pendingStore: () => ({}),
    safeRedirect: () => '/account-lite/index.html', loginTarget: () => '/account-lite/index.html', secureUUID: () => 'synthetic-uuid',
    location: { href: `https://account.test/auth-lite/index.html?mode=${mode}&email=synthetic%40example.test&token=synthetic-reset-token`, origin: 'https://account.test', replace: (target) => navigations.push(target) },
    history: { replaceState() {} }, navigator: {}, setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {},
    document: { getElementById: node, cookie: '', hidden: false, addEventListener() {}, head: { append() {} } },
    window: {
      dispatchEvent() {},
      addEventListener: (name, listener) => windowEvents.set(name, listener),
      turnstile: { render(_target, options) { widgets.push(options); return widgets.length; }, remove: () => calls.push('remove-widget') },
    },
  });
  runInContext(`${authSource.replace(/^import [^\n]+\n/gm, '')}\n globalThis.inspectAuth = () => ({ busy, verifying, challengeOnlyPasskey, resetToken, turnstileToken });`, context);
  return { nodes, node, calls, navigations, windowEvents, widgets, context, inspect: () => context.inspectAuth(), event: async (name, persisted = true) => { windowEvents.get(name)({ persisted }); await turn(); }, click: (id) => node(id).events.get('click')(), submit: () => node('auth-form').events.get('submit')({ preventDefault() {} }) };
}

test('H5 keeps a readable boot notice and same-origin external startup script under its original CSP', async () => {
  for (const entry of ['account', 'auth']) {
    const html = await readFile(new URL(`../public/${entry}-lite/index.html`, import.meta.url), 'utf8');
    assert.match(html, /id="boot-status"[^>]*>[^<]*刷新页面/);
    assert.match(html, new RegExp(`<script defer src="/account-lite/boot\\.js" data-entry="${entry}"></script>`));
    assert.match(html, /viewport-fit=cover/); assert.match(html, /<noscript>/);
    assert.doesNotMatch(html, /<script[^>]*>\s*[^<\s]|unsafe-inline|onerror=|onclick=/);
    assert.match(html, /script-src 'self'/);
  }
});

test('mobile layout retains vh fallback, touch-size inputs, safe areas and a scrollable modal', async () => {
  for (const entry of ['account', 'auth']) {
    const css = await readFile(new URL(`../public/${entry}-lite/${entry}.css`, import.meta.url), 'utf8');
    assert.match(css, /min-height:100vh;min-height:100dvh/); assert.match(css, /safe-area-inset-bottom/);
    assert.match(css, /font-size:16px/); assert.match(css, /min-height:44px/);
  }
  const css = await readFile(new URL('../public/account-lite/account.css', import.meta.url), 'utf8');
  assert.match(css, /max-height:calc\(100vh - 32px\);max-height:calc\(100dvh - 32px\);overflow-y:auto/);
  assert.match(css, /dialog\[open\]\[data-dialog-fallback\][^{]*\{[^}]*position:fixed[^}]*z-index:1000/);
  assert.match(css, /\.dialog-backdrop\{[^}]*z-index:999/);
});

test('BFCache departure clears all credentials, resets 2FA and invalidates challenge callbacks', async () => {
  const view = harness({ turnstile: true }); await turn();
  for (const id of ['password', 'confirm', 'otp', 'email-code', 'new-password']) view.node(id).value = 'synthetic-private';
  const oldChallenge = view.widgets[0]; oldChallenge.callback('synthetic-challenge');
  await view.event('pagehide');
  for (const id of ['password', 'confirm', 'otp', 'email-code', 'new-password']) assert.equal(view.node(id).value, '');
  assert.equal(view.inspect().resetToken, ''); assert.equal(view.inspect().turnstileToken, ''); assert.equal(view.inspect().verifying, false);
  assert.equal(view.node('auth-form').hidden, true); assert.equal(view.node('reset-result').hidden, true);
  oldChallenge.callback('stale-challenge'); assert.equal(view.inspect().turnstileToken, '');
  assert.ok(view.calls.includes('remove-widget'));
});

test('BFCache restoration rechecks current cookie session without replaying any authentication write', async () => {
  const view = harness({ refresh: async () => session }); await turn();
  await view.event('pagehide'); await view.event('pageshow');
  assert.deepEqual(view.calls.filter((call) => call !== 'cancel'), ['status', 'status', 'refresh']);
  assert.deepEqual(view.navigations, ['/account-lite/index.html']);
});

test('a restored 2FA page cannot keep using its previous challenge or late login result', async () => {
  const view = harness(); await turn();
  await view.submit(); assert.equal(view.inspect().verifying, true);
  await view.event('pagehide'); await view.event('pageshow');
  assert.equal(view.inspect().verifying, false); assert.equal(view.node('otp-field').hidden, true);
  assert.equal(view.node('auth-form').hidden, false); assert.equal(view.node('submit').disabled, false);
  assert.equal(view.calls.filter((call) => call === 'login').length, 1); assert.equal(view.calls.includes('verify'), false);

  let complete; const late = harness({ login: () => new Promise((resolve) => { complete = resolve; }) }); await turn();
  const oldSubmission = late.submit(); await turn(); await late.event('pagehide'); await late.event('pageshow');
  complete({ bundle: session }); await oldSubmission;
  assert.equal(late.navigations.length, 0); assert.equal(late.inspect().busy, false);
});

test('rapid BFCache navigation ignores older status replies and old challenge callbacks', async () => {
  let count = 0, oldStatus;
  const status = { password_login_enabled: true, turnstile_check: true, turnstile_site_key: 'synthetic-site-key' };
  const view = harness({ statusFetch: () => ++count === 2 ? new Promise((resolve) => { oldStatus = resolve; }) : status }); await turn();
  const firstWidget = view.widgets[0];
  await view.event('pagehide'); await view.event('pageshow');
  assert.equal(view.inspect().busy, true);
  await view.event('pagehide'); await view.event('pageshow');
  assert.equal(view.calls.filter((call) => call === 'refresh').length, 1);
  assert.equal(view.widgets.length, 2); assert.equal(view.inspect().busy, false);
  const currentNotice = view.node('notice').textContent;
  oldStatus(status); await turn();
  firstWidget.callback('stale-token'); firstWidget['expired-callback'](); firstWidget['error-callback']();
  assert.equal(view.calls.filter((call) => call === 'refresh').length, 1);
  assert.equal(view.inspect().turnstileToken, ''); assert.equal(view.node('notice').textContent, currentNotice);
  view.widgets[1].callback('current-token'); assert.equal(view.inspect().turnstileToken, 'current-token');
});

test('an older cookie refresh cannot navigate or unlock a later BFCache restoration', async () => {
  let count = 0, oldRefresh;
  const view = harness({ refresh: () => ++count === 1 ? new Promise((resolve) => { oldRefresh = resolve; }) : Promise.reject(new Error('offline')) }); await turn();
  await view.event('pagehide'); await view.event('pageshow'); assert.equal(view.inspect().busy, true);
  await view.event('pagehide'); await view.event('pageshow'); assert.equal(view.inspect().busy, false);
  oldRefresh(session); await turn();
  assert.equal(view.navigations.length, 0); assert.equal(view.inspect().busy, false);
  assert.equal(view.calls.filter((call) => call === 'refresh').length, 2);
});

test('restored unknown registration remains blocked and a reset link cannot be replayed', async () => {
  const unknown = harness({ mode: 'register', unknown: 'register' }); await turn();
  await unknown.event('pagehide'); await unknown.event('pageshow');
  assert.equal(unknown.node('auth-form').hidden, true); assert.equal(unknown.node('unknown-actions').hidden, false);
  assert.equal(unknown.node('submit').disabled, true); assert.equal(unknown.calls.includes('register'), false);
  const reset = harness({ mode: 'reset' }); await turn(); assert.equal(reset.node('confirm-reset').disabled, false);
  await reset.event('pagehide'); await reset.event('pageshow');
  assert.equal(reset.node('confirm-reset').disabled, true); assert.equal(reset.inspect().resetToken, '');
  assert.match(reset.node('notice').textContent, /重置链接无效/);
});

test('password clipboard denial keeps secrets masked and provides phone and Mac copy guidance', async () => {
  const view = harness(); await turn(); view.node('new-password').value = 'synthetic-private';
  await view.click('copy-password');
  assert.equal(view.node('new-password').type, 'password'); assert.equal(view.node('new-password').selected, true);
  assert.match(view.node('notice').textContent, /长按.*Ctrl\+C.*Mac.*⌘C/);
  assert.doesNotMatch(view.node('notice').textContent, /synthetic-private/);
});
