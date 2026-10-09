'use strict';
// Loopback-only brand.12 acceptance. Never administers the production gateway.
// Each paid operation is journalled before submission and cannot be resubmitted.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const BASE = 'http://127.0.0.1:3213';
const DIR = path.join(__dirname, 'private/client13-isolated');
const STATE = path.join(DIR, 'journal.json');
const AUTH = path.join(DIR, 'auth.json');
const IMAGE = 'gpt-image-2.5-flare';
const VIDEO = 'sanbao/sd2_480p_real';
const GROUP = 'client13-isolated';
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const save = state => fs.writeFileSync(STATE, JSON.stringify(state, null, 2), { mode: 0o600 });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const headers = session => ({ Authorization: 'Bearer ' + session.access_token, 'New-Api-User': String(session.user.id) });
async function request(route, method = 'GET', body, auth = {}, timeout = 30000) {
  const response = await fetch(BASE + route, {
    method, redirect: 'error', headers: { 'Content-Type': 'application/json', ...auth },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeout),
  });
  const raw = await response.text();
  let data; try { data = JSON.parse(raw); } catch { throw new Error('Non-JSON response: ' + route + ' HTTP ' + response.status); }
  return { http: response.status, body: data, bytes: Buffer.byteLength(raw) };
}
async function api(route, method, body, auth) {
  const r = await request(route, method, body, auth);
  assert.equal(r.http, 200, route + ' HTTP');
  assert.equal(r.body.success, true, route + (route === '/api/option/' ? ' ' + body?.key : '') + ' rejected');
  return r.body.data;
}
async function snapshot(auth) {
  const user = await api('/api/user/self', 'GET', undefined, headers(auth.customer));
  const page = await api('/api/token/?p=1&page_size=100', 'GET', undefined, headers(auth.customer));
  const token = page.items.find(x => x.id === auth.tokenId);
  assert.ok(token, 'Acceptance token missing');
  return { quota: user.quota, usedQuota: user.used_quota, tokenRemain: token.remain_quota, tokenUsed: token.used_quota };
}
async function settlement(auth, before, expected) {
  let after;
  for (let i = 0; i < 20; i++) {
    after = await snapshot(auth);
    if (before.quota - after.quota === expected && before.tokenRemain - after.tokenRemain === expected) break;
    await sleep(1000);
  }
  assert.equal(before.quota - after.quota, expected, 'Customer balance delta');
  assert.equal(before.tokenRemain - after.tokenRemain, expected, 'Token balance delta');
  assert.equal(after.usedQuota - before.usedQuota, expected, 'Customer usage delta');
  return { before, after, quotaDelta: expected, cny: expected / 1000000 };
}
async function prepare() {
  fs.mkdirSync(DIR, { recursive: true });
  fs.closeSync(fs.openSync(STATE, 'wx'));
  const s = { startedAt: new Date().toISOString(), environment: 'loopback brand.12 + deployed R2 edge + real upstreams', productionMutations: false, attempts: {} }; save(s);
  const password = crypto.randomBytes(24).toString('base64url') + 'Aa1!';
  await api('/api/setup', 'POST', { username: 'client13root', password, confirmPassword: password });
  const root = await api('/api/user/login', 'POST', { username: 'client13root', password });
  fs.writeFileSync(path.join(DIR, 'setup-session.json'), JSON.stringify(root), { mode: 0o600, flag: 'wx' });
  const admin = headers(root);
  const options = {
    RetryTimes: '0', QuotaPerUnit: '7300000', USDExchangeRate: '7.3',
    'general_setting.quota_display_type': 'CNY', RegisterEnabled: 'false',
    GroupRatio: JSON.stringify({ default: 1, [GROUP]: 1 }),
    UserUsableGroups: JSON.stringify({ [GROUP]: GROUP }),
    ModelPrice: JSON.stringify({ [IMAGE]: 0.013698630136986 }),
  };
  for (const [key, value] of Object.entries(options)) await api('/api/option/', 'PUT', { key, value }, admin);
  const live = (await request('/api/status')).body.data;
  assert.equal(live.version, 'v1.0.0-rc.41-pikno.12');
  assert.equal(live.quota_per_unit, 7300000);
  assert.equal(live.usd_exchange_rate, 7.3);
  s.accounting = { version: live.version, quotaPerCNY: live.quota_per_unit / live.usd_exchange_rate }; save(s);
  const source = fs.readFileSync(path.join(__dirname, 'plugins/generated/pikno-sanbao.js'), 'utf8');
  await api('/api/plugin/task', 'POST', { source, sourceSha256: crypto.createHash('sha256').update(source).digest('hex'), enabled: false }, admin);
  await api('/api/plugin/task/pikno-sanbao/activate', 'POST', { version: '0.3.0' }, admin);
  await api('/api/option/', 'PUT', { key: 'billing_setting.plugin_billing_expr', value: JSON.stringify({ ['pikno-sanbao::' + VIDEO]: 'tier("retail_cny_6", u("requests") * 0.821917808219178)' }) }, admin);
  const packy = read(path.join(__dirname, 'private/packy.json'));
  const sanbao = read(path.join(__dirname, 'private/sanbao-release-key.json'));
  assert.equal(packy.baseUrl, 'https://cf.api.fan');
  for (const channel of [
    { type: 1, name: 'client13-packy', base_url: packy.baseUrl, key: packy.apiKey, models: IMAGE },
    { type: 61, name: 'client13-sanbao', base_url: 'https://sanbaobeauty.com', key: sanbao.apiKey, models: VIDEO, setting: JSON.stringify({ task_plugin_key: 'pikno-sanbao' }) },
  ]) await api('/api/channel/', 'POST', { mode: 'single', channel: { ...channel, group: GROUP, status: 1, weight: 1, priority: 0, auto_ban: 0 } }, admin);
  const customerPassword = crypto.randomBytes(24).toString('base64url') + 'Aa1!';
  await api('/api/user/', 'POST', { username: 'client13customer', password: customerPassword, role: 1 }, admin);
  let customer = await api('/api/user/login', 'POST', { username: 'client13customer', password: customerPassword });
  const customerId = customer.user.id;
  await api('/api/user/', 'PUT', { id: customerId, username: 'client13customer', display_name: 'Client13 acceptance', role: 1, status: 1, group: GROUP }, admin);
  await api('/api/user/manage', 'POST', { id: customerId, action: 'add_quota', mode: 'override', value: 20000000 }, admin);
  customer = await api('/api/user/login', 'POST', { username: 'client13customer', password: customerPassword });
  assert.equal(customer.user.role, 1);
  assert.equal(customer.user.group, GROUP);
  const ca = headers(customer);
  await api('/api/token/', 'POST', { name: 'client13-once', expired_time: Math.floor(Date.now() / 1000) + 7200, remain_quota: 15000000, unlimited_quota: false, model_limits_enabled: true, model_limits: IMAGE + ',' + VIDEO, group: GROUP, cross_group_retry: false }, ca);
  const page = await api('/api/token/?p=1&page_size=100', 'GET', undefined, ca);
  const tokenId = page.items.find(t => t.name === 'client13-once').id;
  const tokenKey = (await api('/api/token/' + tokenId + '/key', 'POST', undefined, ca)).key;
  const auth = { root, customer, tokenId, tokenKey: tokenKey.startsWith('sk-') ? tokenKey : 'sk-' + tokenKey };
  fs.writeFileSync(AUTH, JSON.stringify(auth), { mode: 0o600, flag: 'wx' });
  const forbidden = await request('/api/channel/', 'GET', undefined, ca);
  assert.equal(forbidden.http, 403);
  s.prepared = true; s.customerRole = 1; s.adminDeniedHTTP = forbidden.http; s.startBalance = await snapshot(auth); save(s);
  console.log(JSON.stringify({ prepared: true, ...s.accounting, customerRole: 1, adminDeniedHTTP: forbidden.http }));
}
async function media(auth, s) {
  const ta = { Authorization: 'Bearer ' + auth.tokenKey };
  const bytes = fs.readFileSync(path.join(__dirname, 'brand/pikno-logo.png'));
  const issued = await request('/v1/media/uploads', 'POST', { content_type: 'image/png', size: bytes.length }, ta);
  assert.equal(issued.http, 201);
  const t = issued.body;
  const target = new URL(t.upload_url);
  assert.equal(target.origin, 'https://www.piknoai.com'); assert.ok(target.pathname.startsWith('/media/v1/assets/'));
  const put = await fetch(t.upload_url, { method: 'PUT', redirect: 'error', headers: t.headers, body: bytes, signal: AbortSignal.timeout(60000) });
  assert.equal(put.status, 201);
  const complete = await request('/v1/media/complete', 'POST', { upload_ticket: t.upload_ticket }, ta);
  assert.equal(complete.http, 200);
  const range = await fetch(complete.body.url, { headers: { Range: 'bytes=0-7' }, redirect: 'error', signal: AbortSignal.timeout(30000) });
  assert.equal(range.status, 206); assert.deepEqual(Buffer.from(await range.arrayBuffer()), bytes.subarray(0, 8));
  s.media = { uploadBytes: bytes.length, directUploadHTTP: put.status, rangeHTTP: range.status, completeHTTP: complete.http };
  save(s); return complete.body.url;
}
async function checks(auth, s) {
  const ta = { Authorization: 'Bearer ' + auth.tokenKey };
  const before = await snapshot(auth);
  const foreign = await request('/v1/images/edits', 'POST', { model: IMAGE, prompt: 'test', images: ['https://example.com/input.png'] }, ta);
  const count = await request('/v1/images/generations', 'POST', { model: IMAGE, prompt: 'test', n: 2 }, ta);
  const missing = await request('/v1/media/uploads', 'POST', { content_type: 'image/png', size: 68 });
  const multipart = await fetch(BASE + '/v1/images/edits', { method: 'POST', headers: { ...ta, 'Content-Type': 'multipart/form-data; boundary=test' }, body: 'test' });
  assert.equal(foreign.http, 403); assert.equal(count.http, 400); assert.equal(missing.http, 401); assert.equal(multipart.status, 415);
  const after = await snapshot(auth); assert.deepEqual(after, before);
  s.negative = { foreignURL: 403, imageCount: 400, missingToken: 401, multipart: 415, balanceUnchanged: true, scope: 'pre-reservation rejection; not upstream refund' }; save(s);
  console.log(JSON.stringify(s.negative));
}
async function image(kind, auth, s) {
  assert.ok(!s.attempts[kind], 'Existing paid attempt; do not resubmit');
  const reference = kind === 'edit' ? await media(auth, s) : undefined;
  const before = await snapshot(auth);
  const attempt = s.attempts[kind] = { status: 'submitted_do_not_retry', startedAt: new Date().toISOString(), before }; save(s);
  const input = { model: IMAGE, prompt: 'One small blue ceramic cup on a plain white studio background, soft light, no text or logos.', n: 1, size: '1024x1024', quality: 'high', response_format: 'url', ...(reference ? { images: Array(5).fill(reference) } : {}) };
  attempt.requestBytes = Buffer.byteLength(JSON.stringify(input)); save(s);
  const r = await request('/v1/images/' + (reference ? 'edits' : 'generations'), 'POST', input, { Authorization: 'Bearer ' + auth.tokenKey }, 600000);
  attempt.http = r.http; attempt.responseBytes = r.bytes; save(s);
  if (r.http !== 200) { attempt.after = await snapshot(auth); save(s); throw new Error(kind + ' failed HTTP ' + r.http + '; do not retry'); }
  assert.equal(r.body.data?.length, 1); assert.equal(r.body.data[0].b64_json, undefined);
  const url = new URL(r.body.data[0].url); assert.equal(url.origin, 'https://www.piknoai.com'); assert.ok(url.pathname.startsWith('/media/'));
  const head = await fetch(url, { method: 'HEAD', redirect: 'error', signal: AbortSignal.timeout(30000) });
  attempt.outputHead = head.status; assert.equal(head.status, 200);
  assert.ok(r.bytes < 32768);
  Object.assign(attempt, await settlement(auth, before, 100000), { status: 'passed', outputR2: true, references: reference ? 5 : 0 }); save(s);
  console.log(JSON.stringify({ kind, ...attempt }));
}
async function video(auth, s) {
  assert.ok(!s.attempts.video, 'Existing video attempt; do not resubmit');
  const key = read(path.join(__dirname, 'private/sanbao-release-key.json')).apiKey;
  const upstream = async route => { const r = await fetch('https://sanbaobeauty.com' + route, { headers: { Authorization: 'Bearer ' + key }, signal: AbortSignal.timeout(30000) }); assert.equal(r.status, 200); return r.json(); };
  const model = (await upstream('/openapi/v1/models')).data.find(m => m.id === 'sd2_480p_real');
  assert.equal(model?.price_credits, 30); assert.equal(model.billing, 'per_generation');
  const credits = (await upstream('/openapi/v1/me')).user.credits; assert.ok(credits >= 30);
  const reference = await media(auth, s);
  const before = await snapshot(auth);
  const attempt = s.attempts.video = { status: 'submitted_do_not_retry', startedAt: new Date().toISOString(), before, upstreamCreditsBefore: credits, quotedCredits: 30, expectedCustomerCNY: 6 }; save(s);
  const input = { model: VIDEO, prompt: 'A gentle slow camera push toward the blue reference logo, stable composition, soft studio lighting.', seconds: 4, resolution: '480p', aspect_ratio: '16:9', image_urls: [reference] };
  attempt.requestBytes = Buffer.byteLength(JSON.stringify(input)); save(s);
  const r = await request('/v1/videos', 'POST', input, { Authorization: 'Bearer ' + auth.tokenKey }, 90000);
  attempt.http = r.http; attempt.responseBytes = r.bytes; save(s);
  assert.ok(r.http >= 200 && r.http < 300, 'Video submission failed; do not retry'); assert.ok(r.body.id);
  attempt.taskId = r.body.id; attempt.status = r.body.status; attempt.afterSubmit = await snapshot(auth); save(s);
  console.log(JSON.stringify({ kind: 'video', ...attempt }));
}
async function poll(auth, s) {
  const attempt = s.attempts.video; assert.ok(attempt?.taskId, 'No video task to poll');
  if (attempt.status === 'passed') { console.log(JSON.stringify(attempt)); return; }
  const r = await request('/v1/videos/' + encodeURIComponent(attempt.taskId), 'GET', undefined, { Authorization: 'Bearer ' + auth.tokenKey });
  assert.equal(r.http, 200); attempt.status = r.body.status; attempt.checkedAt = new Date().toISOString(); save(s);
  if (r.body.status === 'completed') {
    const output = r.body.outputs?.find(x => x.type === 'video' && x.url?.startsWith('https://')); assert.ok(output);
    const head = await fetch(output.url, { method: 'HEAD', redirect: 'follow', signal: AbortSignal.timeout(30000) });
    attempt.outputHead = head.status; save(s);
    const download = await fetch(output.url, { headers: { Range: 'bytes=0-31' }, redirect: 'follow', signal: AbortSignal.timeout(30000) });
    attempt.outputRangeHTTP = download.status;
    attempt.outputContentType = download.headers.get('content-type');
    if (download.status === 206) {
      const firstBytes = Buffer.from(await download.arrayBuffer());
      attempt.outputMP4Signature = firstBytes.subarray(4, 8).toString('ascii') === 'ftyp';
    } else { await download.body?.cancel(); }
    save(s);
    // Images may finish while the asynchronous video runs. Reconcile the
    // aggregate account separately from this video's own consumption record.
    const overlappingQuota = Object.entries(s.attempts).filter(([kind, a]) => kind !== 'video' && a.status === 'passed' && a.startedAt > attempt.startedAt).reduce((sum, [, a]) => sum + a.quotaDelta, 0);
    const aggregate = await settlement(auth, attempt.before, 6000000 + overlappingQuota);
    const logs = await api('/api/log/self?p=1&page_size=100&type=2', 'GET', undefined, headers(auth.customer));
    const entries = logs.items.filter(x => x.model_name === VIDEO && x.token_id === auth.tokenId);
    assert.equal(entries.length, 1); assert.equal(entries[0].quota, 6000000);
    Object.assign(attempt, { after: aggregate.after, aggregateDelta: aggregate.quotaDelta, overlappingQuota, quotaDelta: entries[0].quota, cny: 6, usageLogId: entries[0].id });
    const key = read(path.join(__dirname, 'private/sanbao-release-key.json')).apiKey;
    const me = await fetch('https://sanbaobeauty.com/openapi/v1/me', { headers: { Authorization: 'Bearer ' + key }, signal: AbortSignal.timeout(30000) }); assert.equal(me.status, 200);
    attempt.upstreamCreditsAfter = (await me.json()).user.credits;
    attempt.upstreamBalanceDelta = attempt.upstreamCreditsBefore - attempt.upstreamCreditsAfter;
    attempt.balanceDeltaCNY = attempt.upstreamBalanceDelta / 10;
    attempt.upstreamBalanceIsShared = true; // Correlation, not proof of per-task cost.
    attempt.status = attempt.outputRangeHTTP === 206 && attempt.outputMP4Signature ? 'passed' : 'media_access_failed'; save(s);
    assert.equal(attempt.status, 'passed', 'Video billed/completed but media delivery needs investigation; do not resubmit');
  }
  console.log(JSON.stringify({ kind: 'video', ...attempt }));
}
async function failure(auth, s) {
  assert.ok(!s.controlledFailure, 'Controlled failure already recorded');
  const http = require('node:http');
  const model = 'client13-controlled-failure';
  const admin = headers(auth.root), customer = headers(auth.customer);
  let hits = 0, during, testTokenId, server;
  const before = await snapshot(auth);
  try {
    await api('/api/option/', 'PUT', { key: 'ModelPrice', value: JSON.stringify({ [IMAGE]: 0.013698630136986, [model]: 0.013698630136986 }) }, admin);
    await api('/api/channel/', 'POST', { mode: 'single', channel: { type: 1, name: 'client13-controlled-failure', key: 'fixture-no-real-key', base_url: 'http://host.docker.internal:3214', models: model, group: GROUP, status: 1, weight: 1, auto_ban: 0 } }, admin);
    await api('/api/token/', 'POST', { name: 'client13-failure-once', expired_time: Math.floor(Date.now()/1000)+600, remain_quota: 1000000, unlimited_quota: false, model_limits_enabled: true, model_limits: model, group: GROUP, cross_group_retry: false }, customer);
    const p = await api('/api/token/?p=1&page_size=100', 'GET', undefined, customer);
    testTokenId = p.items.find(t => t.name === 'client13-failure-once').id;
    const k = (await api('/api/token/' + testTokenId + '/key', 'POST', undefined, customer)).key;
    server = http.createServer(async (req, res) => {
      req.resume(); hits++;
      try { during = await snapshot(auth); } catch { during = null; }
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Controlled acceptance failure', type: 'server_error', code: 'fixture_failure' } }));
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(3214, '0.0.0.0', resolve); });
    const r = await request('/v1/chat/completions', 'POST', { model, messages: [{ role: 'user', content: 'Controlled failure test' }], max_tokens: 1 }, { Authorization: 'Bearer ' + (k.startsWith('sk-') ? k : 'sk-' + k) });
    await sleep(1000);
    const after = await snapshot(auth);
    const afterTokens = await api('/api/token/?p=1&page_size=100', 'GET', undefined, customer);
    const testToken = afterTokens.items.find(t => t.id === testTokenId);
    s.controlledFailure = { http: r.http, upstreamRequests: hits, before, during, after, mockTokenRemain: testToken.remain_quota, realProviderCalled: false };
    save(s);
    assert.equal(hits, 1, 'Mock upstream must receive exactly one request');
    assert.equal(r.http, 503); assert.deepEqual(after, before); assert.equal(testToken.remain_quota, 1000000);
    s.controlledFailure.passed = true; save(s); console.log(JSON.stringify(s.controlledFailure));
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    if (testTokenId) await api('/api/token/' + testTokenId, 'DELETE', undefined, customer);
  }
}
async function cleanup(auth, s) {
  assert.ok(!s.attempts.video || ['passed', 'failed', 'media_access_failed'].includes(s.attempts.video.status), 'Keep polling a pending video before cleanup');
  const p = await api('/api/channel/?p=1&page_size=100', 'GET', undefined, headers(auth.root));
  for (const channel of p.items) await api('/api/channel/' + channel.id + '/status', 'POST', { status: 2 }, headers(auth.root));
  await api('/api/token/' + auth.tokenId, 'DELETE', undefined, headers(auth.customer));
  const revoked = await request('/v1/media/uploads', 'POST', { content_type: 'image/png', size: 68 }, { Authorization: 'Bearer ' + auth.tokenKey });
  assert.equal(revoked.http, 401);
  s.cleanup = { channelsDisabled: true, tokenRevokedHTTP: 401, finishedAt: new Date().toISOString() }; save(s);
  console.log(JSON.stringify(s.cleanup));
}
async function audit(auth, s) {
  const logs = await api('/api/log/self?p=1&page_size=100&type=2', 'GET', undefined, headers(auth.customer));
  const rows = logs.items.filter(x => x.token_id === auth.tokenId).map(x => ({ id: x.id, model: x.model_name, quota: x.quota }));
  assert.equal(rows.length, 3);
  assert.equal(rows.filter(x => x.model === IMAGE && x.quota === 100000).length, 2);
  assert.equal(rows.filter(x => x.model === VIDEO && x.quota === 6000000).length, 1);
  const final = await snapshot(auth);
  assert.equal(s.startBalance.quota - final.quota, 6200000);
  assert.equal(s.startBalance.tokenRemain - final.tokenRemain, 6200000);
  assert.equal(final.usedQuota, 6200000);
  s.audit = { rows, final, totalQuota: 6200000, totalCNY: 6.2, customerConsumptionLogPassed: true }; save(s);
  console.log(JSON.stringify(s.audit));
}
async function main() {
  const command = process.argv[2];
  assert.ok(['prepare', 'checks', 'image', 'edit', 'video', 'poll', 'failure', 'audit', 'cleanup'].includes(command));
  if (command === 'prepare') return prepare();
  const auth = read(AUTH), s = read(STATE); assert.equal(s.prepared, true);
  if (command === 'checks') return checks(auth, s);
  if (command === 'image' || command === 'edit') return image(command, auth, s);
  if (command === 'video') return video(auth, s);
  if (command === 'poll') return poll(auth, s);
  if (command === 'failure') return failure(auth, s);
  if (command === 'audit') return audit(auth, s);
  return cleanup(auth, s);
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
