import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { hasOwn, secureUUID, desktopFlowContext } from '../public/account-lite/compat.mjs';
import { keyPayload, selectedKeyOperation, findSelectedToken, createAccountClient } from '../public/account-lite/client.mjs';

test('desktop flow intake keeps only a strict public reference and invalid context stays blocking', () => {
  const rows = new Map(), storage = { getItem: key => rows.get(key), setItem: (key, value) => rows.set(key, value) };
  const flow = 'A'.repeat(43);
  assert.equal(desktopFlowContext(storage, '#desktop=' + flow), flow);
  assert.equal(desktopFlowContext(storage), flow);
  assert.equal(desktopFlowContext(storage, '#desktop=' + flow + '&account=7'), 'invalid');
  assert.equal(desktopFlowContext(storage), 'invalid');
  assert.equal(desktopFlowContext({ getItem() { throw Error('denied'); } }), 'invalid');
  assert.equal(desktopFlowContext(undefined, '#desktop=' + flow), 'invalid');
});

test('account validation works without Object.hasOwn and rejects inherited grants', () => {
  const original = Object.hasOwn;
  try {
    Object.hasOwn = undefined;
    assert.equal(hasOwn(Object.create({ group: true }), 'group'), false);
    assert.equal(hasOwn(null, 'group'), false);
    const status = { quota_per_unit: 7300000, usd_exchange_rate: 7.3 };
    assert.equal(keyPayload('用途', 'image-standard', 30, '', status, { 'image-standard': {} }).unlimited_quota, true);
    assert.throws(() => keyPayload('用途', 'image-standard', 30, '', status, Object.create({ 'image-standard': {} })));
    const row = { id: 7, name: '用途', group: 'image-standard', created_time: 123456, status: 1 };
    const selection = selectedKeyOperation(row, 12, '12345678-1234-4234-8234-123456789012');
    assert.equal(findSelectedToken(selection, [row]).id, 7);
  } finally { Object.hasOwn = original; }
});

test('UUID fallback retains cryptographic randomness and RFC v4/version bits', () => {
  let calls = 0;
  const cryptoImpl = { getRandomValues(bytes) { calls++; for (let i = 0; i < bytes.length; i++) bytes[i] = 255 - i; return bytes; } };
  assert.equal(secureUUID(cryptoImpl), 'fffefdfc-fbfa-49f8-b7f6-f5f4f3f2f1f0');
  assert.equal(calls, 1);
  assert.throws(() => secureUUID({}), /安全随机数不可用/);
  assert.equal(secureUUID({ randomUUID: () => 'native-uuid' }), 'native-uuid');
});

const bootSource = await readFile(new URL('../public/account-lite/boot.js', import.meta.url), 'utf8');
function boot({ modules = true, secure = true, entry = 'account' } = {}) {
  const notice = { hidden: false, textContent: '', setAttribute() {} }, scripts = [];
  const document = {
    currentScript: { getAttribute: () => entry }, getElementById: () => notice,
    createElement: () => ({ ...(modules ? { noModule: false } : {}), events: {}, addEventListener(name, handler) { this.events[name] = handler; } }),
    head: { appendChild: (script) => scripts.push(script) },
  };
  const events = new Map();
  vm.runInNewContext(bootSource, { document, window: { fetch() {}, Promise, URL, AbortController, crypto: { getRandomValues() {} }, isSecureContext: secure,
    addEventListener: (name, listener) => events.set(name, listener), removeEventListener: (name) => events.delete(name),
  } });
  return { notice, scripts, events };
}
test('classic boot fails visibly before dispatch in unsupported or insecure environments', () => {
  for (const options of [{ modules: false }, { secure: false }, { entry: '__proto__' }]) {
    const result = boot(options);
    assert.equal(result.scripts.length, 0); assert.equal(result.notice.hidden, false);
    assert.ok(result.notice.textContent);
  }
});
test('boot loads only the fixed account/auth modules and reports resource failure', () => {
  for (const entry of ['account', 'auth']) {
    const result = boot({ entry });
    assert.equal(result.scripts[0].src, `/${entry === 'account' ? 'account-lite/account' : 'auth-lite/auth'}.mjs`);
    result.scripts[0].events.error(); assert.match(result.notice.textContent, /资源加载失败/);
    result.events.get('hamster-lite-ready')(); result.scripts[0].events.load(); assert.equal(result.notice.hidden, true);
  }
});
test('a module load without its ready acknowledgement leaves a visible initialization failure', () => {
  const result = boot(); result.scripts[0].events.load();
  assert.equal(result.notice.hidden, false); assert.match(result.notice.textContent, /初始化未完成/);
});

test('a restored page drains its stale refresh and starts one fresh read without reviving old callers', async () => {
  let release, calls = 0;
  const changes = [], bundle = { access_token: 'synthetic', access_expires_at: Date.now() / 1000 + 300, user: { id: 12 }, session: { sid: 'synthetic' } };
  const client = createAccountClient({ locks: null, onChange: (value) => changes.push(value), fetchImpl: async () => {
    calls++;
    if (calls === 1) await new Promise((resolve) => { release = resolve; });
    return new Response(JSON.stringify({ success: true, data: bundle }), { headers: { 'Content-Type': 'application/json' } });
  } });
  const stale = client.refresh(); const staleResult = assert.rejects(stale, { code: 'ACCOUNT_CHANGED' });
  client.clear();
  const first = client.refresh(), second = client.refresh();
  assert.equal(calls, 1); release();
  await staleResult; await Promise.all([first, second]);
  assert.equal(calls, 2); assert.equal(client.current().user.id, 12);
  assert.equal(changes.filter(Boolean).length, 1);
});
