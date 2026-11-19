import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { AccountError, createSelectedKeyConnector, selectedKeyOperation, findSelectedToken, findCreatedToken, operationStore } from '../public/account-lite/client.mjs';

const uuid = 'bb83a81b-4b35-445e-8558-24433fc7042a';
const otherUuid = 'cb83a81b-4b35-445e-8558-24433fc7042a';
const secret = `sk-${'q'.repeat(40)}`;
const rawSecret = 'r'.repeat(48);
const token = (changes = {}) => ({ id: 7, name: '既有图片 Key', group: 'image-standard', status: 1, created_time: 1799990000, expired_time: -1, ...changes });
const selected = (row = token(), changes = {}) => ({ ...selectedKeyOperation(row, 12, uuid, 1800000000000), ...changes });
function deferred() { let resolve; const promise = new Promise((done) => { resolve = done; }); return { resolve, promise }; }
function fixture(overrides = {}) {
  let account = { userId: 12, value: '12:session-a:0' };
  const reads = [], imports = [], failures = [];
  const connect = createSelectedKeyConnector({ request: async (path, options) => { reads.push({ path, options }); return { data: { key: secret } }; }, identity: () => account, bridge: () => ({ connectCreatedKey: async (payload) => { imports.push({ ...payload }); return { ok: true, code: 'CONNECTED' }; } }), onFailure: value => failures.push(value), ...overrides });
  return { connect, reads, imports, failures, account: value => { account = value; } };
}

test('existing and newly created Keys require the same explicit selection; selection time is not creation time', () => {
  for (const row of [token(), token({ created_time: 1800000000 })]) {
    const operation = selected(row);
    assert.equal(operation.startedAt, 1800000000000);
    assert.equal(findSelectedToken(operation, [row]).id, 7);
  }
  assert.equal(findCreatedToken(selected(), [token()]), null);
});

test('activation matches only the exact available selected row and never adopts a different Key with its name', () => {
  const operation = selected();
  for (const changes of [{ id: 8 }, { name: '另一 Key' }, { group: 'chat-standard' }, { created_time: token().created_time + 1 }, { status: 2 }]) assert.equal(findSelectedToken(operation, [token(changes)]), null);
  assert.equal(findSelectedToken(operation, [token(), token()]), null);
  assert.equal(findSelectedToken(operation, [token({ id: 8 }), token()]).id, 7);
});

test('old creation or handoff metadata without explicit activation intent cannot fetch a complete Key', async () => {
  const f = fixture();
  for (const changes of [{ intent: undefined }, { intent: 'create-key' }, { keyId: undefined }, { requestId: '' }, { group: 'default' }, { userID: 13 }]) {
    assert.equal((await f.connect(selected(token(), changes), token())).code, 'ACCOUNT_CHANGED');
  }
  assert.deepEqual(f.reads, []); assert.deepEqual(f.imports, []);
});

test('selection validates all metadata before it can be persisted', () => {
  for (const row of [token({ status: 2 }), token({ name: '' }), token({ name: 'x'.repeat(101) }), token({ name: 'name\n' }), token({ created_time: 0 }), token({ id: 1.5 }), token({ group: 'private' })]) assert.throws(() => selectedKeyOperation(row, 12, uuid));
  assert.throws(() => selectedKeyOperation(token(), 12, 'not-an-operation'));
});

test('explicit activation reads only its selected id and forwards only the existing fixed native schema', async () => {
  const f = fixture(), result = await f.connect(selected(), token());
  assert.deepEqual(f.reads, [{ path: '/api/token/7/key', options: { method: 'POST' } }]);
  assert.deepEqual(Object.keys(f.imports[0]).sort(), ['createdAt', 'group', 'key', 'keyId', 'name', 'requestId', 'userId']);
  assert.equal(f.imports[0].keyId, 7); assert.equal(f.imports[0].key, secret);
  assert.deepEqual(result, { ok: true, code: 'CONNECTED', connected: true });
  assert.doesNotMatch(JSON.stringify(result), /sk-|session|userId|keyId/);
});

test('server raw 48-character keys are canonicalized for existing and newly created keys of all four purposes', async () => {
  for (const group of ['image-standard', 'video-standard', 'tool-standard', 'chat-standard']) {
    for (const created_time of [1799990000, 1800000000]) {
      const data = { key: rawSecret }, row = token({ group, created_time }); let forwarded;
      const f = fixture({ request: async () => ({ data }), bridge: () => ({ connectCreatedKey: async payload => {
        assert.equal(payload.key, `sk-${rawSecret}`); assert.equal(payload.group, group); forwarded = payload;
        return { ok: true, code: 'CONNECTED' };
      } }) });
      const result = await f.connect(selected(row), row);
      assert.equal(result.connected, true); assert.equal(data.key, ''); assert.equal(forwarded.key, '');
      assert.doesNotMatch(JSON.stringify({ result, failures: f.failures }), new RegExp(rawSecret));
    }
  }
});

test('canonical keys keep one prefix and malformed, masked or unbounded keys never reach native', async () => {
  for (const key of [`sk-${rawSecret}`, `sk-${'q'.repeat(20)}`, `sk-${'q'.repeat(128)}`]) {
    const f = fixture({ request: async () => ({ data: { key } }) });
    assert.equal((await f.connect(selected(), token())).connected, true); assert.equal(f.imports[0].key, key);
  }
  for (const key of [null, 42, '', 'q'.repeat(47), 'q'.repeat(49), ` ${rawSecret}`, `${rawSecret}\n`, `sk-sk-${rawSecret}`, `sk-${'q'.repeat(19)}`, `sk-${'q'.repeat(129)}`, `${'q'.repeat(24)}****${'q'.repeat(20)}`, `sk-${'q'.repeat(24)}-invalid`]) {
    const data = { key }, f = fixture({ request: async () => ({ data }) });
    assert.deepEqual(await f.connect(selected(), token()), { ok: false, code: 'CONNECT_FAILED' });
    assert.equal(f.imports.length, 0); assert.equal(data.key, '');
    assert.deepEqual(f.failures, [{ code: 'ACCOUNT_KEY_IMPORT_FAILED' }]);
  }
});

test('activation selection recovery survives reload, binds account and group, and excludes secret and arbitrary intent data', () => {
  const values = new Map(), storage = { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
  const store = operationStore(storage), operation = selected();
  store.save('activate-image-standard', 12, { ...operation, key: secret, access_token: secret, cookie: secret, data: { key: secret } });
  assert.deepEqual(operationStore(storage).read('activate-image-standard', 12), operation);
  assert.equal(store.read('activate-image-standard', 13), null);
  assert.throws(() => store.save('activate-chat-standard', 12, operation));
  assert.throws(() => store.save('activate-image-standard', 12, { ...operation, intent: 'legacy' }));
  const persisted = [...values.values()].join(''); assert.doesNotMatch(persisted, /sk-|access_token|cookie|"key":/);
  values.set('hamster-account-lite:pending-activate-image-standard:12', JSON.stringify({ ...operation, intent: undefined }));
  assert.equal(store.read('activate-image-standard', 12), null);
});

test('ordinary browser has no activation capability and does not retrieve any Key', async () => {
  const f = fixture({ bridge: () => undefined });
  assert.equal((await f.connect(selected(), token())).code, 'WEB_ONLY'); assert.equal(f.reads.length, 0);
});

test('duplicate activation is one in-flight read and remains idempotent after successful save', async () => {
  const gate = deferred(); let reads = 0, writes = 0;
  const f = fixture({ request: async () => { reads++; await gate.promise; return { data: { key: secret } }; }, bridge: () => ({ connectCreatedKey: async () => { writes++; return { ok: true, code: 'CONNECTED' }; } }) });
  const first = f.connect(selected(), token()), second = f.connect(selected(), token());
  assert.equal(first, second); gate.resolve(); await first; await f.connect(selected(), token());
  assert.equal(reads, 1); assert.equal(writes, 1);
  assert.equal((await f.connect(selected(token({ id: 8 })), token({ id: 8 }))).code, 'ACCOUNT_CHANGED');
  assert.equal(reads, 1);
});

test('native context or superseded activation stops secret retrieval before transport', async () => {
  for (const changes of [{ context: async () => ({ ok: false }) }, { isCurrent: () => false }]) {
    const f = fixture(changes); assert.equal((await f.connect(selected(), token())).ok, false); assert.equal(f.reads.length, 0);
  }
  const gate = deferred(), f = fixture({ context: () => gate.promise }); const pending = f.connect(selected(), token());
  f.account({ userId: 12, value: '12:session-a:1' }); gate.resolve({ ok: true });
  assert.equal((await pending).code, 'ACCOUNT_CHANGED'); assert.equal(f.reads.length, 0);
});

test('late secret is erased on logout/account change and never passed to native', async () => {
  const gate = deferred(), started = deferred(), data = { key: secret };
  const f = fixture({ request: async () => { started.resolve(); await gate.promise; return { data }; } });
  const pending = f.connect(selected(), token()); await started.promise;
  f.account({ userId: 13, value: '13:session-b:1' }); gate.resolve();
  assert.equal((await pending).code, 'ACCOUNT_CHANGED'); assert.equal(data.key, ''); assert.equal(f.imports.length, 0);
});

test('superseding the explicit operation while its Key is being fetched discards that secret', async () => {
  let current = true; const gate = deferred(), started = deferred(), data = { key: secret };
  const f = fixture({ isCurrent: () => current, request: async () => { started.resolve(); await gate.promise; return { data }; } });
  const pending = f.connect(selected(), token()); await started.promise; current = false; gate.resolve();
  assert.equal((await pending).code, 'ACCOUNT_CHANGED'); assert.equal(data.key, ''); assert.equal(f.imports.length, 0);
});

test('native rejection keeps its fixed account-mismatch state and never switches to another Key', async () => {
  const f = fixture({ bridge: () => ({ connectCreatedKey: async () => ({ ok: false, code: 'ACCOUNT_MISMATCH', detail: secret }) }) });
  assert.deepEqual(await f.connect(selected(), token()), { ok: false, code: 'ACCOUNT_MISMATCH' });
  assert.equal(f.reads.length, 1); assert.deepEqual(f.failures, [{ code: 'ACCOUNT_KEY_IMPORT_FAILED' }]);
});

test('native failures retain only allowed codes and integer HTTP statuses without private details', async () => {
  for (const code of ['KEY_INVALID', 'KEY_FORBIDDEN', 'KEY_STORAGE_UNAVAILABLE', 'ACCOUNT_MISMATCH', 'CONNECT_FAILED']) {
    for (const httpStatus of [100, 200, 401, 403, 409, 503, 599]) {
      const f = fixture({ bridge: () => ({ connectCreatedKey: async () => ({ ok: false, code, httpStatus, message: secret, detail: { key: secret } }) }) });
      assert.deepEqual(await f.connect(selected(), token()), { ok: false, code, httpStatus });
      assert.deepEqual(f.failures, [{ code: 'ACCOUNT_KEY_IMPORT_FAILED', httpStatus }]);
    }
  }
  for (const httpStatus of [undefined, null, 0, 99, 600, -1, NaN, Infinity, 503.5, '503', true]) {
    const f = fixture({ bridge: () => ({ connectCreatedKey: async () => ({ ok: false, code: secret, httpStatus, message: secret }) }) });
    assert.deepEqual(await f.connect(selected(), token()), { ok: false, code: 'CONNECT_FAILED' });
    assert.deepEqual(f.failures, [{ code: 'ACCOUNT_KEY_IMPORT_FAILED' }]);
  }
});

test('normal native account invalidation is returned without reporting an import fault', async () => {
  const f = fixture({ bridge: () => ({ connectCreatedKey: async () => ({ ok: false, code: 'ACCOUNT_CHANGED', httpStatus: 409, message: secret }) }) });
  assert.deepEqual(await f.connect(selected(), token()), { ok: false, code: 'ACCOUNT_CHANGED', httpStatus: 409 });
  assert.deepEqual(f.failures, []);
});

test('selected Key read failures retain bounded HTTP status but no exception text or arbitrary error code', async () => {
  for (const status of [401, 403, 503, 599, 0, 600, '503', NaN]) {
    const f = fixture({ request: async () => { throw Object.assign(Error(secret), { status, code: secret }); } });
    const http = Number.isInteger(status) && status >= 100 && status <= 599 ? { httpStatus: status } : {};
    assert.deepEqual(await f.connect(selected(), token()), { ok: false, code: 'CONNECT_FAILED', ...http });
    assert.deepEqual(f.failures, [{ code: 'ACCOUNT_KEY_IMPORT_FAILED', ...http }]);
    assert.equal(f.imports.length, 0);
  }
});

test('activation UI uses fixed recovery messages for account, Key, permission, storage and connectivity failures', async () => {
  const source = await readFile(new URL('../public/account-lite/account.mjs', import.meta.url), 'utf8');
  const messageSource = source.match(/^function activationFailureMessage\([^\n]+\{[\s\S]*?^\}/m)?.[0];
  assert.ok(messageSource);
  for (const [result, pattern] of [
    [{ code: 'ACCOUNT_MISMATCH' }, /其他账户/],
    [{ code: 'KEY_INVALID', httpStatus: 401 }, /Key 无效或已过期/],
    [{ code: 'KEY_FORBIDDEN', httpStatus: 403 }, /用途权限/],
    [{ code: 'KEY_STORAGE_UNAVAILABLE', httpStatus: 503 }, /本机密钥保护/],
    [{ code: 'CONNECT_FAILED', httpStatus: 503 }, /网络或中转站连接/],
    [{ code: 'CONNECT_FAILED', httpStatus: 401 }, /账户登录已过期/],
    [{ code: 'CONNECT_FAILED', httpStatus: 403 }, /账户无权/],
    [{ code: secret, httpStatus: 'private' }, /网络或中转站连接/],
  ]) {
    const message = runInNewContext(`${messageSource}\nactivationFailureMessage(result)`, { result: { ...result, message: secret, raw: secret } });
    assert.match(message, pattern); assert.doesNotMatch(message, new RegExp(secret));
  }
});

test('exception paths clear the transient payload and report only whitelisted failure fields', async () => {
  let forwarded; const data = { key: secret };
  const f = fixture({ request: async () => ({ data }), bridge: () => ({ connectCreatedKey: async payload => { forwarded = payload; throw new Error(`${secret} C:\\private\\file`); } }) });
  const result = await f.connect(selected(), token());
  assert.equal(data.key, ''); assert.equal(forwarded.key, '');
  assert.deepEqual(result, { ok: false, code: 'CONNECT_FAILED' }); assert.doesNotMatch(JSON.stringify({ result, failures: f.failures }), /sk-|private|file/);
});

test('429 before save is shared across purposes, erases the secret, and retries only the same selected operation', async () => {
  let now = 1800000000000, reads = 0, writes = 0, data, forwarded;
  const f = fixture({ now: () => now, request: async () => { reads++; return { data: data = { key: secret } }; }, bridge: () => ({ connectCreatedKey: async payload => { forwarded = payload; return ++writes === 1 ? { ok: false, code: 'RATE_LIMITED', httpStatus: 429, retryAfterMs: 60000 } : { ok: true, code: 'CONNECTED' }; } }) });
  const limited = await f.connect(selected(), token()); assert.equal(limited.retryAfterMs, 60000); assert.equal(data.key, ''); assert.equal(forwarded.key, '');
  const other = token({ id: 8, group: 'chat-standard' });
  assert.equal((await f.connect(selected(other, { requestId: otherUuid }), other)).code, 'RATE_LIMITED'); assert.equal(reads, 1);
  now += 60001;
  assert.equal((await f.connect(selected(), token())).connected, true); assert.equal(reads, 2); assert.equal(forwarded.keyId, 7); assert.equal(forwarded.requestId, uuid); assert.deepEqual(f.failures, []);
});

test('429 from full Key retrieval never reaches native or reports a fault, and respects persisted cooldown', async () => {
  let now = 1800000000000, reads = 0;
  const f = fixture({ now: () => now, request: async () => { reads++; throw new AccountError('safe', 'RATE_LIMITED', 429, 8000); } });
  assert.equal((await f.connect(selected(token(), { retryAt: now + 4000 }), token())).retryAfterMs, 4000); assert.equal(reads, 0);
  now += 4001; assert.equal((await f.connect(selected(), token())).retryAfterMs, 8000);
  await f.connect(selected(), token()); assert.equal(reads, 1); assert.equal(f.imports.length, 0); assert.deepEqual(f.failures, []);
});

test('already saved but pending detection is terminal: repeated refresh must not reread or resave that Key', async () => {
  const f = fixture({ bridge: () => ({ connectCreatedKey: async () => ({ ok: true, code: 'SAVED_CHECK_PENDING', httpStatus: 429, retryAfterMs: 12000, detail: secret }) }) });
  const result = await f.connect(selected(), token()); assert.deepEqual(result, { ok: true, code: 'SAVED_CHECK_PENDING', connected: false, httpStatus: 429, retryAfterMs: 12000 });
  assert.deepEqual(await f.connect(selected(), token()), result); assert.equal(f.reads.length, 1); assert.deepEqual(f.failures, []);
});

test('late 429 is discarded after account switch and cannot carry another account cooldown', async () => {
  const gate = deferred(), started = deferred();
  const f = fixture({ request: async () => { started.resolve(); await gate.promise; throw new AccountError('safe', 'RATE_LIMITED', 429, 90000); } });
  const pending = f.connect(selected(), token()); await started.promise;
  f.account({ userId: 13, value: '13:session-b' }); gate.resolve();
  assert.equal((await pending).code, 'ACCOUNT_CHANGED'); assert.deepEqual(f.failures, []);
});
