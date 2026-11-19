import test from 'node:test';
import assert from 'node:assert/strict';
import { AccountError, createCreatedKeyConnector, findCreatedToken, operationStore } from '../public/account-lite/client.mjs';

const operation = () => ({ userID: 12, name: '手动创建 ·test', group: 'image-standard', startedAt: 1800000000000, requestId: 'bb83a81b-4b35-445e-8558-24433fc7042a' });
const token = () => ({ id: 8, name: '手动创建 ·test', group: 'image-standard', status: 1, created_time: 1800000000 });
const secret = `sk-${'h'.repeat(48)}`;
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
function fixture(overrides = {}) {
  const calls = [], imported = [], failures = []; let account = { userId: 12, value: '12:session-a' };
  const bridge = { connectCreatedKey: async (value) => { imported.push({ ...value }); return { ok: true, code: 'CONNECTED', raw: secret }; } };
  const connect = createCreatedKeyConnector({ request: async (path, options) => { calls.push({ path, options }); return { data: { key: secret } }; }, identity: () => account, bridge: () => bridge, onFailure: (value) => failures.push(value), ...overrides });
  return { connect, calls, imported, failures, account: (value) => { account = value; } };
}
test('only a single exact original creation is recoverable; other groups, names and earlier keys are excluded', () => {
  const original = token(); assert.equal(findCreatedToken(operation(), [original]).id, 8);
  for (const changes of [{ name: '旧Key' }, { group: 'chat-standard' }, { created_time: 1799999990 }, { id: -8 }]) assert.equal(findCreatedToken(operation(), [{ ...original, ...changes }]), null);
  assert.equal(findCreatedToken(operation(), [original, { ...original, id: 9 }]), null);
  assert.equal(findCreatedToken({ ...operation(), keyId: 9 }, [original]), null);
  assert.equal(findCreatedToken({ ...operation(), createdAt: 1799999999 }, [original]), null);
});
test('handoff reads only the newly created id and sends no login credentials', async () => {
  const f = fixture(); const result = await f.connect(operation(), token());
  assert.deepEqual(result, { ok: true, code: 'CONNECTED', connected: true });
  assert.deepEqual(f.calls, [{ path: '/api/token/8/key', options: { method: 'POST' } }]);
  assert.deepEqual(Object.keys(f.imported[0]).sort(), ['keyId', 'userId', 'group', 'name', 'createdAt', 'key', 'requestId'].sort());
  assert.equal(f.imported[0].key, secret); assert.equal(f.imported[0].userId, 12);
  assert.doesNotMatch(JSON.stringify(result), /synthetic|raw|session|token/);
});
test('compatibility handoff also normalizes the server raw key and erases transient references', async () => {
  const raw = 'h'.repeat(48), data = { key: raw }; let forwarded;
  const f = fixture({ request: async () => ({ data }), bridge: () => ({ connectCreatedKey: async value => {
    assert.equal(value.key, `sk-${raw}`); forwarded = value; return { ok: true, code: 'CONNECTED' };
  } }) });
  const result = await f.connect(operation(), token());
  assert.equal(result.connected, true); assert.equal(data.key, ''); assert.equal(forwarded.key, '');
  assert.doesNotMatch(JSON.stringify({ result, failures: f.failures }), new RegExp(raw));
});
test('ordinary web pages never fetch a complete key automatically', async () => {
  const f = fixture({ bridge: () => undefined });
  assert.equal((await f.connect(operation(), token())).code, 'WEB_ONLY'); assert.equal(f.calls.length, 0);
});
test('legacy pending metadata without an explicit operation id cannot import old keys', async () => {
  const f = fixture(); const old = operation(); delete old.requestId;
  assert.equal((await f.connect(old, token())).code, 'ACCOUNT_CHANGED'); assert.equal(f.calls.length, 0);
});
test('duplicate activation is single flight for the original operation', async () => {
  const gate = deferred(); let reads = 0, imports = 0;
  const f = fixture({ request: async () => { reads++; await gate.promise; return { data: { key: secret } }; }, bridge: () => ({ connectCreatedKey: async () => { imports++; return { ok: true, code: 'CONNECTED' }; } }) });
  const one = f.connect(operation(), token()), two = f.connect(operation(), token());
  assert.equal(one, two); gate.resolve(); await one;
  assert.equal(reads, 1); assert.equal(imports, 1);
});
test('account context must be accepted before any complete key is fetched', async () => {
  const f = fixture({ context: async () => ({ ok: false }) });
  assert.equal((await f.connect(operation(), token())).code, 'CONNECT_FAILED'); assert.equal(f.calls.length, 0);
  assert.deepEqual(f.failures, [{ code: 'ACCOUNT_KEY_IMPORT_FAILED' }]);
});
test('an account change while context is pending prevents complete key retrieval', async () => {
  const gate = deferred(), f = fixture({ context: () => gate.promise }); const task = f.connect(operation(), token());
  f.account({ userId: 13, value: '13:session-b' }); gate.resolve({ ok: true });
  assert.equal((await task).code, 'ACCOUNT_CHANGED'); assert.equal(f.calls.length, 0); assert.equal(f.imported.length, 0);
});
test('a late complete key is erased and never imported after account change', async () => {
  const gate = deferred(), readStarted = deferred(), data = { key: secret };
  const f = fixture({ request: async () => { readStarted.resolve(); await gate.promise; return { data }; } });
  const task = f.connect(operation(), token()); await readStarted.promise;
  f.account({ userId: 13, value: '13:session-b' }); gate.resolve();
  assert.equal((await task).code, 'ACCOUNT_CHANGED'); assert.equal(f.imported.length, 0); assert.equal(data.key, '');
});
test('temporary key references are cleared even when native IPC rejects', async () => {
  let forwarded; const data = { key: secret };
  const f = fixture({ request: async () => ({ data }), bridge: () => ({ connectCreatedKey: async (value) => { forwarded = value; throw new Error(`${secret} C:\\private\\client-file.txt`); } }) });
  const result = await f.connect(operation(), token());
  assert.deepEqual(result, { ok: false, code: 'CONNECT_FAILED' }); assert.equal(data.key, ''); assert.equal(forwarded.key, '');
  assert.doesNotMatch(JSON.stringify({ result, failures: f.failures }), /synthetic|private|client-file/);
});
test('saved-but-pending check is a terminal handoff success, without pretending generation succeeded', async () => {
  const f = fixture({ bridge: () => ({ connectCreatedKey: async () => ({ ok: true, code: 'SAVED_CHECK_PENDING', connected: false }) }) });
  assert.deepEqual(await f.connect(operation(), token()), { ok: true, code: 'SAVED_CHECK_PENDING', connected: false });
});
test('native failure codes and arbitrary result fields cannot enter customer messages or diagnostics', async () => {
  const f = fixture({ bridge: () => ({ connectCreatedKey: async () => ({ ok: false, code: secret, error: secret }) }) });
  assert.deepEqual(await f.connect(operation(), token()), { ok: false, code: 'CONNECT_FAILED' });
  assert.deepEqual(f.failures, [{ code: 'ACCOUNT_KEY_IMPORT_FAILED' }]);
});
test('a local account mismatch is explicit and does not request a different old key', async () => {
  const f = fixture({ bridge: () => ({ connectCreatedKey: async () => ({ ok: false, code: 'ACCOUNT_MISMATCH' }) }) });
  assert.deepEqual(await f.connect(operation(), token()), { ok: false, code: 'ACCOUNT_MISMATCH' }); assert.equal(f.calls.length, 1);
});
test('four handoff recoveries persist only account-scoped non-secret original operation metadata', () => {
  const values = new Map(), store = operationStore({ getItem: (key) => values.get(key), setItem: (key, value) => values.set(key, value), removeItem: (key) => values.delete(key) });
  for (const group of ['image-standard', 'video-standard', 'tool-standard', 'chat-standard']) {
    store.save(`handoff-${group}`, 12, { ...operation(), group, keyId: 8, createdAt: 1800000000, key: secret, access_token: secret, cookie: secret });
    const value = store.read(`handoff-${group}`, 12); assert.equal(value.requestId, operation().requestId); assert.equal(value.keyId, 8); assert.equal(store.read(`handoff-${group}`, 13), null);
  }
  assert.equal(values.size, 4); assert.doesNotMatch([...values.values()].join(''), /synthetic|access_token|cookie|"key":/);
});

test('429 handoff cools all groups, erases keys, and resumes only the original key after the deadline', async () => {
  let now = 1800000000000, attempts = 0, data, forwarded;
  const f = fixture({ now: () => now, request: async () => ({ data: data = { key: secret } }), bridge: () => ({ connectCreatedKey: async (payload) => { forwarded = payload; attempts++; return attempts === 1 ? { ok: false, code: 'RATE_LIMITED', httpStatus: 429, retryAfterMs: 90000, raw: secret } : { ok: true, code: 'CONNECTED' }; } }) });
  const first = await f.connect(operation(), token());
  assert.deepEqual(first, { ok: false, code: 'RATE_LIMITED', httpStatus: 429, retryAfterMs: 90000 });
  assert.equal(data.key, ''); assert.equal(forwarded.key, ''); assert.deepEqual(f.failures, []);
  const other = { ...operation(), group: 'chat-standard', requestId: 'cb83a81b-4b35-445e-8558-24433fc7042a' };
  assert.equal((await f.connect(other, { ...token(), group: 'chat-standard' })).code, 'RATE_LIMITED'); assert.equal(attempts, 1);
  now += 90001;
  assert.equal((await f.connect(operation(), token())).code, 'CONNECTED'); assert.equal(attempts, 2);
  assert.equal((await f.connect(operation(), token())).code, 'CONNECTED'); assert.equal(attempts, 2);
  assert.equal(forwarded.keyId, 8); assert.equal(forwarded.requestId, operation().requestId);
  assert.doesNotMatch(JSON.stringify(first), /synthetic|raw/);
});

test('429 from key retrieval never calls native and respects persisted metadata after reload', async () => {
  let now = 1800000000000, reads = 0;
  const f = fixture({ now: () => now, request: async () => { reads++; throw new AccountError('safe', 'RATE_LIMITED', 429, 8000); } });
  assert.equal((await f.connect({ ...operation(), retryAt: now + 5000 }, token())).retryAfterMs, 5000); assert.equal(reads, 0);
  now += 5001;
  assert.equal((await f.connect(operation(), token())).retryAfterMs, 8000);
  await f.connect(operation(), token()); assert.equal(reads, 1); assert.equal(f.imported.length, 0); assert.deepEqual(f.failures, []);
});

test('saved pending 429 is terminal and never reads that key again', async () => {
  const f = fixture({ bridge: () => ({ connectCreatedKey: async () => ({ ok: true, code: 'SAVED_CHECK_PENDING', httpStatus: 429, retryAfterMs: 2000 }) }) });
  const expected = { ok: true, code: 'SAVED_CHECK_PENDING', connected: false, httpStatus: 429, retryAfterMs: 2000 };
  assert.deepEqual(await f.connect(operation(), token()), expected);
  assert.deepEqual(await f.connect(operation(), token()), expected);
  assert.equal(f.calls.length, 1); assert.deepEqual(f.failures, []);
});

test('account changes discard a late limited result and do not inherit another account cooldown', async () => {
  const gate = deferred(), started = deferred();
  const f = fixture({ request: async () => { started.resolve(); await gate.promise; throw new AccountError('safe', 'RATE_LIMITED', 429, 90000); } });
  const pending = f.connect(operation(), token()); await started.promise;
  f.account({ userId: 13, value: '13:other-session' }); gate.resolve();
  assert.equal((await pending).code, 'ACCOUNT_CHANGED'); assert.deepEqual(f.failures, []);
  assert.equal((await f.connect(operation(), token())).code, 'ACCOUNT_CHANGED');
});

test('cooldown persistence whitelists only a bounded timestamp and recovery metadata', () => {
  const values = new Map(), store = operationStore({ getItem: (key) => values.get(key), setItem: (key, value) => values.set(key, value) });
  const before = Date.now();
  store.save('handoff-image-standard', 12, { ...operation(), retryAt: before + 999999999, key: secret, cookie: secret, retryAfter: secret });
  const value = store.read('handoff-image-standard', 12);
  assert.ok(value.retryAt >= before + 3599999 && value.retryAt <= Date.now() + 3600000);
  assert.doesNotMatch([...values.values()].join(''), /synthetic|cookie|retryAfter/);
});
