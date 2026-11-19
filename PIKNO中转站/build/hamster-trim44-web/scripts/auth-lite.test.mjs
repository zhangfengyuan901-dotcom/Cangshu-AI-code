import test from 'node:test';
import { createLocalChallenge } from '../public/auth-lite/local-challenge.mjs';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { generateKeyPairSync, privateDecrypt, createDecipheriv, constants, webcrypto } from 'node:crypto';
import { ACCOUNT_HOME, createAuthClient, encryptPassword, isBundle, isChallenge, loginTarget, pendingStore, safeRedirect, validPassword } from '../public/auth-lite/client.mjs';

const origin = 'https://account.test';
const bundle = { access_token: 'synthetic-secret-access', token_type: 'Bearer', access_expires_at: Math.floor(Date.now() / 1000) + 300, user: { id: 12, username: 'fixture-user', role: 1 }, session: { sid: 'fixture-session', current: true } };
const response = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
const success = (data) => response({ success: true, data });
const challenge = () => ({ require_verification: true, flow_token: 'synthetic-secret-flow', expires_at: Math.floor(Date.now() / 1000) + 300, methods: [{ method: '2fa', available: true }, { method: 'passkey', available: true }] });
const memory = () => { const rows = new Map(); return { rows, getItem: (key) => rows.get(key), setItem: (key, value) => rows.set(key, value), removeItem: (key) => rows.delete(key) }; };
const keypair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const localQuestion = { id: 'Q'.repeat(43), image: 'data:image/png;base64,aGVsbG8=', expires_in: 120 };
const localProof = { token: `local.${'T'.repeat(43)}`, expires_in: 120 };

test('local challenge uses fixed same-origin requests, consumes its answer once and keeps proof only in memory', async () => {
  const calls = [], states = [];
  const client = createLocalChallenge({ onChange: (state) => states.push(state), fetchImpl: async (path, options) => { calls.push({ path, options }); return success(path.endsWith('/verify') ? localProof : localQuestion); } });
  await client.load(); await client.verify('123456'); await client.verify('123456');
  assert.equal(states.at(-1).token, localProof.token); assert.equal(calls.length, 2);
  assert.equal(calls[0].path, '/api/auth/challenge'); assert.equal(calls[1].path, '/api/auth/challenge/verify');
  assert.deepEqual(JSON.parse(calls[1].options.body), { id: localQuestion.id, answer: '123456' });
  for (const call of calls) { assert.equal(call.options.credentials, 'same-origin'); assert.equal(call.options.cache, 'no-store'); assert.equal(call.options.redirect, 'error'); }
  client.invalidate(); assert.equal(states.at(-1).token, ''); client.dispose();
});

test('local challenge rejects hostile image data and never automatically retries a failed answer', async () => {
  let calls = 0; const states = [];
  const bad = createLocalChallenge({ onChange: (state) => states.push(state), fetchImpl: async () => success({ ...localQuestion, image: 'https://evil.test/code.svg' }) });
  await bad.load(); assert.equal(states.at(-1).error, true); assert.equal(states.at(-1).image, ''); bad.dispose();
  const client = createLocalChallenge({ fetchImpl: async () => { calls++; if (calls === 1) return success(localQuestion); throw new Error('network lost'); }, onChange: (state) => states.push(state) });
  await client.load(); await client.verify('123456'); await client.verify('123456');
  assert.equal(calls, 2); assert.equal(states.at(-1).error, true); assert.equal(states.at(-1).token, ''); client.dispose();
});

test('a late local proof cannot revive a cleared or replaced page', async () => {
  let reply; const states = [];
  const client = createLocalChallenge({ onChange: (state) => states.push(state), fetchImpl: async (path) => path.endsWith('/verify') ? new Promise((resolve) => { reply = resolve; }) : success(localQuestion) });
  await client.load(); const pending = client.verify('123456'); client.invalidate(); reply(success(localProof)); await pending;
  assert.equal(states.at(-1).token, ''); assert.equal(states.at(-1).busy, false); client.dispose();
});

test('local proof expires and clears the form authorization gate', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); const states = [];
  const client = createLocalChallenge({ onChange: (state) => states.push(state), fetchImpl: async (path) => success(path.endsWith('/verify') ? localProof : localQuestion) });
  await client.load(); await client.verify('123456'); assert.equal(states.at(-1).token, localProof.token);
  t.mock.timers.tick(120001); assert.equal(states.at(-1).token, ''); assert.equal(states.at(-1).error, true); client.dispose();
});
const encryptionKey = { kid: 'fixture-key', public_key: keypair.publicKey.export({ type: 'spki', format: 'pem' }).toString() };
function decrypt(encrypted) {
  const value = encrypted.password_encrypted;
  if (!value.startsWith('v2.')) return privateDecrypt({ key: keypair.privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, Buffer.from(value, 'base64')).toString();
  const [, wrapped, nonce, ciphertext] = value.split('.');
  const secret = privateDecrypt({ key: keypair.privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256', oaepLabel: Buffer.from('password-v2') }, Buffer.from(wrapped, 'base64'));
  const data = Buffer.from(ciphertext, 'base64'), decipher = createDecipheriv('aes-256-gcm', secret, Buffer.from(nonce, 'base64'));
  decipher.setAAD(Buffer.from(`password-v2:${encrypted.encryption_key_id}`)); decipher.setAuthTag(data.subarray(-16));
  return Buffer.concat([decipher.update(data.subarray(0, -16)), decipher.final()]).toString();
}

test('redirects allow exact customer home and role-gated admin paths only', () => {
  assert.equal(safeRedirect(ACCOUNT_HOME, origin), ACCOUNT_HOME);
  assert.equal(safeRedirect('/hub/billing', origin), '/hub/billing');
  assert.equal(loginTarget(bundle, '/hub/billing', origin), '/hub/billing');
  assert.equal(safeRedirect('/dashboard/overview', origin), null);
  assert.equal(safeRedirect('/dashboard/overview', origin, 10), '/dashboard/overview');
  for (const value of ['https://evil.test/account-lite/index.html', '//evil.test', '/\\evil.test', '/account-lite/index.html?token=secret', '/account-lite/index.html#secret', '/api/user/auth/logout', '/pay/lanjing/epay/submit.php', 'javascript:alert(1)', '/sign-in?compat=1', '/users/../api/user/self', '\n/account-lite/index.html']) assert.equal(safeRedirect(value, origin, 100), null, value);
  assert.equal(loginTarget(bundle, '/users', origin), ACCOUNT_HOME);
  assert.equal(loginTarget({ user: { role: 10 } }, null, origin), '/dashboard/overview');
});
test('password policy counts Unicode characters without modifying password content', () => {
  assert.equal(validPassword('汉'.repeat(128)), true); assert.equal(validPassword('🧑'.repeat(128)), true);
  assert.equal(validPassword('汉'.repeat(129)), false); assert.equal(validPassword('abc'), false);
});
test('RSA-OAEP SHA256 short password matches the existing server decryption contract', async () => {
  const password = 'correct horse battery'; const encrypted = await encryptPassword(password, encryptionKey, webcrypto);
  assert.equal(decrypt(encrypted), password); assert.equal(encrypted.encryption_key_id, encryptionKey.kid); assert.equal(Object.hasOwn(encrypted, 'password'), false);
});
test('long Unicode passwords use authenticated v2 AES-GCM with OAEP label and kid AAD', async () => {
  const password = '汉'.repeat(128), encrypted = await encryptPassword(password, encryptionKey, webcrypto);
  assert.match(encrypted.password_encrypted, /^v2\./); assert.equal(decrypt(encrypted), password);
  assert.throws(() => decrypt({ ...encrypted, encryption_key_id: 'other-kid' }));
});
test('encryption is fail-closed with no HTTP login or cleartext fallback', async () => {
  const calls = [], client = createAuthClient({ cryptoImpl: {}, locks: null, fetchImpl: async (path) => { calls.push(path); return success(encryptionKey); } });
  await assert.rejects(client.login({ username: 'fixture', password: 'must-not-send', encryption: true }), { code: 'ENCRYPTION_UNAVAILABLE' });
  assert.deepEqual(calls, ['/api/user/login/encryption-key']); assert.equal(client.unknown(), null);
});
test('login uses existing encrypted POST contract and same-origin no-store cookies', async () => {
  const calls = [], client = createAuthClient({ cryptoImpl: webcrypto, locks: null, fetchImpl: async (path, options) => { calls.push({ path, options }); return success(path.endsWith('/encryption-key') ? encryptionKey : bundle); } });
  const result = await client.login({ username: 'fixture', password: 'private-password', turnstile: 'fixture + token', encryption: true });
  assert.equal(result.bundle, bundle === result.bundle ? bundle : result.bundle);
  const { path, options } = calls[1], payload = JSON.parse(options.body);
  assert.equal(path, '/api/user/login?turnstile=fixture+%2B+token'); assert.equal(options.method, 'POST'); assert.equal(options.credentials, 'same-origin'); assert.equal(options.redirect, 'error'); assert.equal(options.cache, 'no-store');
  assert.equal(payload.username, 'fixture'); assert.equal(Object.hasOwn(payload, 'password'), false); assert.equal(decrypt(payload), 'private-password');
});
test('registration retains the real API payload and never imports affiliate metadata', async () => {
  let sent;
  const client = createAuthClient({ locks: null, fetchImpl: async (path, options) => { sent = { path, ...options }; return success(null); } });
  await client.register({ username: 'fixture', password: 'password123', email: 'fixture@example.test', code: '123456', turnstile: 'cf-value', emailRequired: true, aff: 'unwanted', aff_code: 'unwanted' });
  assert.equal(sent.path, '/api/user/register?turnstile=cf-value');
  assert.deepEqual(JSON.parse(sent.body), { username: 'fixture', password: 'password123', email: 'fixture@example.test', verification_code: '123456', turnstile: 'cf-value' });
});

test('desktop registration sends its bound context once and adopts only a valid returned login bundle', async () => {
  const flow = 'D'.repeat(43), calls = [], store = memory();
  const client = createAuthClient({ locks: null, pending: pendingStore(store), fetchImpl: async (path, options) => { calls.push({ path, options }); return success(bundle); } });
  const result = await client.register({ username: 'fixture', password: 'password123', desktopFlow: flow });
  assert.deepEqual(result, { bundle });
  assert.equal(calls.length, 1); assert.equal(calls[0].options.headers['X-Hamster-Desktop-Flow'], flow);
  assert.equal(calls[0].path, '/api/user/register?turnstile=');
  assert.equal(store.rows.size, 0);
});

test('lost desktop registration retains unknown state and cannot replay account creation', async () => {
  const store = memory(), calls = [];
  const client = createAuthClient({ locks: null, pending: pendingStore(store), fetchImpl: async (path) => { calls.push(path); throw Error('lost'); } });
  const value = { username: 'fixture', password: 'password123', desktopFlow: 'D'.repeat(43) };
  await assert.rejects(client.register(value), { code: 'NETWORK' });
  await assert.rejects(client.register(value), { code: 'RESULT_UNKNOWN' });
  assert.equal(calls.length, 1); assert.equal(client.unknown(), 'register');
  assert.doesNotMatch([...store.rows.values()].join(''), /password|secret|desktop|DDDD/);
});
test('two-factor login keeps its challenge in memory and posts only the verified method', async () => {
  const storage = memory(), calls = [];
  const client = createAuthClient({ locks: null, pending: pendingStore(storage), fetchImpl: async (path, options) => { calls.push({ path, options }); return success(path.startsWith('/api/user/login?') ? challenge() : bundle); } });
  assert.equal((await client.login({ username: 'fixture', password: 'password' })).challenge.require_verification, true);
  assert.equal(storage.rows.size, 0);
  await client.verify('AB12-CD34');
  assert.equal(calls[1].path, '/api/user/login/verify');
  assert.deepEqual(JSON.parse(calls[1].options.body), { flow_token: 'synthetic-secret-flow', method: '2fa', code: 'AB12-CD34' });
  assert.equal(storage.rows.size, 0);
});
test('expired, unavailable and malformed security challenges never downgrade to a bundle', async () => {
  assert.equal(isChallenge({ ...challenge(), expires_at: 1 }), false); assert.equal(isChallenge({ ...challenge(), methods: [{ method: 'password', available: true }] }), false);
  assert.equal(isBundle({ ...bundle, access_expires_at: 1 }), false); assert.equal(isBundle({ ...bundle, user: { ...bundle.user, id: -1 } }), false);
  const calls = [], client = createAuthClient({ locks: null, fetchImpl: async (path) => { calls.push(path); return success({ ...challenge(), methods: [{ method: 'passkey', available: true }] }); } });
  await client.login({ username: 'fixture', password: 'password' });
  await assert.rejects(client.verify('123456'), { code: 'METHOD_UNAVAILABLE' }); assert.equal(calls.length, 1);
});
test('a network-unknown login is persisted as an action marker and never automatically replayed', async () => {
  const storage = memory(), calls = [], fetchImpl = async (path) => { calls.push(path); if (path.endsWith('/refresh')) return success(bundle); throw new Error('sensitive transport detail'); };
  const client = createAuthClient({ locks: null, pending: pendingStore(storage), fetchImpl });
  await assert.rejects(client.login({ username: 'fixture', password: 'private-password' }), { code: 'NETWORK', uncertain: true });
  assert.equal(client.unknown(), 'login'); assert.doesNotMatch([...storage.rows.values()].join(''), /private-password|fixture|synthetic-secret/);
  const reloaded = createAuthClient({ locks: null, pending: pendingStore(storage), fetchImpl });
  await assert.rejects(reloaded.login({ username: 'fixture', password: 'private-password' }), { code: 'RESULT_UNKNOWN' });
  await reloaded.refresh(); assert.equal(reloaded.unknown(), null); assert.equal(calls.filter((path) => path.startsWith('/api/user/login?')).length, 1); assert.equal(storage.rows.size, 0);
});
test('server errors keep unknown mutations blocked, while explicit rejection permits correction', async () => {
  let count = 0;
  const client = createAuthClient({ locks: null, fetchImpl: async () => { count++; return response({ success: false, message: 'do-not-display', code: 'secret-detail' }, 503); } });
  await assert.rejects(client.login({ username: 'fixture', password: 'password' }), { code: 'REQUEST_REJECTED', uncertain: true });
  await assert.rejects(client.login({ username: 'fixture', password: 'password' }), { code: 'RESULT_UNKNOWN' }); assert.equal(count, 1);
  const rejected = createAuthClient({ locks: null, fetchImpl: async () => response({ success: false }, 400) });
  await assert.rejects(rejected.login({ username: 'fixture', password: 'password' }), { uncertain: false }); assert.equal(rejected.unknown(), null);
});
test('concurrent submissions dispatch once and late login results cannot cross cancellation', async () => {
  let finish, count = 0; const client = createAuthClient({ locks: null, fetchImpl: () => { count++; return new Promise((resolve) => { finish = resolve; }); } });
  const first = client.login({ username: 'fixture', password: 'password' });
  await assert.rejects(client.login({ username: 'fixture', password: 'password' }), { code: 'BUSY' }); client.cancel(); finish(success(bundle));
  await assert.rejects(first, { code: 'ACCOUNT_CHANGED' }); assert.equal(count, 1);
});
test('reset confirmation is an explicit POST and an unknown result cannot be submitted twice', async () => {
  const calls = [], client = createAuthClient({ locks: null, fetchImpl: async (path, options) => { calls.push({ path, options }); throw new Error('lost'); } });
  await assert.rejects(client.reset('fixture@example.test', 'mail-secret-token'), { uncertain: true });
  await assert.rejects(client.reset('fixture@example.test', 'mail-secret-token'), { code: 'RESULT_UNKNOWN' });
  assert.equal(calls.length, 1); assert.equal(calls[0].path, '/api/user/reset'); assert.deepEqual(JSON.parse(calls[0].options.body), { email: 'fixture@example.test', token: 'mail-secret-token' });
});
test('verification and forgot endpoints preserve their server GET query contract', async () => {
  const calls = [], client = createAuthClient({ locks: null, fetchImpl: async (path, options) => { calls.push({ path, options }); return success(null); } });
  await client.sendCode('f+tag@example.test', 'a+b'); await client.forgot('f@example.test', 'x');
  assert.equal(calls[0].path, '/api/verification?email=f%2Btag%40example.test&turnstile=a%2Bb'); assert.equal(calls[0].options.method, 'GET');
  assert.equal(calls[1].path, '/api/reset_password?email=f%40example.test&turnstile=x');
});
test('refresh shares the original exclusive lock without persisting returned credentials', async () => {
  const storage = memory(), lockCalls = [], client = createAuthClient({ pending: pendingStore(storage), fetchImpl: async () => success(bundle), locks: { request: async (name, options, run) => { lockCalls.push({ name, options }); return run(); } } });
  assert.equal((await client.refresh()).user.id, 12); assert.equal(lockCalls[0].name, 'new-api:auth-refresh'); assert.equal(lockCalls[0].options.mode, 'exclusive'); assert.equal(storage.rows.size, 0);
});
test('H5 ships without React, remote fonts, HTML injection, persisted secrets or automatic reset', async () => {
  const html = await readFile(new URL('../public/auth-lite/index.html', import.meta.url), 'utf8'), source = await readFile(new URL('../public/auth-lite/auth.mjs', import.meta.url), 'utf8');
  assert.match(html, /name="referrer" content="no-referrer"/); assert.match(html, /frame-src https:\/\/challenges.cloudflare.com/); assert.match(html, /script defer src="\/account-lite\/boot\.js" data-entry="auth"/);
  assert.doesNotMatch(html + source, /react|innerHTML|localStorage|document\.write|fonts\.googleapis/i);
  assert.ok(source.indexOf('history.replaceState') < source.indexOf('client.status()'));
  assert.match(source, /confirm-reset'\)\.addEventListener\('click'/);
  assert.match(source, /password_login_encryption_enabled === true/); assert.match(source, /turnstile_site_key/); assert.match(source, /consent/); assert.match(source, /compat', '1'/);
});
