'use strict';
// One real CanSeeDream video, local isolated ledger, deployed R2 references.
// Commands are separated so polling never repeats a paid submission.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const assert = require('node:assert/strict');
const BASE = 'http://127.0.0.1:3215', MODEL = 'canseedream/video/ningmeng_c_pool', GROUP = 'client14-isolated';
const DIR = path.join(__dirname, 'private/client14-cansee'), JOURNAL = path.join(DIR, 'journal.json'), AUTH = path.join(DIR, 'auth.json');
const read = p => JSON.parse(fs.readFileSync(p, 'utf8'));
const credentials = () => read(path.join(__dirname, 'private/canseedream-client14.json'));
const save = s => fs.writeFileSync(JOURNAL, JSON.stringify(s, null, 2), { mode: 0o600 });
const sessionHeaders = s => ({ Authorization: 'Bearer ' + s.access_token, 'New-Api-User': String(s.user.id) });
const tokenHeaders = a => ({ Authorization: 'Bearer ' + a.tokenKey });
async function call(route, method = 'GET', body, headers = {}, timeout = 30000) {
  const r = await fetch(BASE + route, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(timeout) });
  const text = await r.text(); let data;
  try { data = JSON.parse(text); } catch { throw new Error(route + ': non-JSON HTTP ' + r.status); }
  return { http: r.status, bytes: Buffer.byteLength(text), body: data };
}
async function api(route, method, body, headers) {
  const r = await call(route, method, body, headers); assert.equal(r.http, 200, route);
  assert.equal(r.body.success, true, route + (body?.key ? ' ' + body.key : '') + ' rejected'); return r.body.data;
}
async function pricing() {
  const r = await fetch('https://see.ximeiedu.org/health', { redirect: 'error', signal: AbortSignal.timeout(30000) });
  assert.equal(r.status, 200); const health = await r.json(), d = health.defaults;
  assert.equal(d.pointPricing.pointsPerYuan, 100);
  assert.equal(d.videoEnhance.enabled, false, 'Enhancement changes cost; review before submitting');
  const route = d.videoProviders.find(x => x.id === 'ningmeng_c_pool');
  assert.equal(route.pricingMode, 'per_second'); assert.equal(route.videoReferenceSurchargeEnabled, false);
  assert.deepEqual([...route.allowedResolutions].sort(), ['480p', '720p']);
  assert.deepEqual(route.resolutionPointsPerSecond, { '480p': 19, '720p': 36 });
  assert.ok(route.allowedDurations.includes(4));
  const expr = 'tier("cansee_cost_x2", u("seconds") * (u("resolution") == "480p" ? 0.052054794520547946 : 0.09863013698630137))';
  return { fetchedAt: new Date().toISOString(), pointsPerYuan: 100, duration: 4, resolution: '480p', pointsPerSecond: 19, expectedUpstreamPoints: 76, upstreamCNY: 0.76, customerCNY: 1.52, expectedQuota: 1520000, expression: expr, routeCount: d.videoProviders.length, imageGenerationExcluded: true };
}
async function balance(a) {
  const h = sessionHeaders(a.customer), u = await api('/api/user/self', 'GET', undefined, h);
  const p = await api('/api/token/?p=1&page_size=100', 'GET', undefined, h), t = p.items.find(x => x.id === a.tokenId);
  assert.ok(t); return { quota: u.quota, usedQuota: u.used_quota, tokenRemain: t.remain_quota, tokenUsed: t.used_quota };
}
async function prepare() {
  fs.mkdirSync(DIR, { recursive: true }); fs.closeSync(fs.openSync(JOURNAL, 'wx'));
  const s = { startedAt: new Date().toISOString(), environment: 'loopback brand.12, real CanSeeDream and deployed R2', productionMutations: false, quote: await pricing() }; save(s);
  const password = crypto.randomBytes(24).toString('base64url') + 'Aa1!';
  await api('/api/setup', 'POST', { username: 'client14root', password, confirmPassword: password });
  const root = await api('/api/user/login', 'POST', { username: 'client14root', password }), admin = sessionHeaders(root);
  fs.writeFileSync(path.join(DIR, 'setup-session.json'), JSON.stringify(root), { mode: 0o600, flag: 'wx' });
  for (const [key, value] of Object.entries({ RetryTimes: '0', QuotaPerUnit: '7300000', USDExchangeRate: '7.3', 'general_setting.quota_display_type': 'CNY', RegisterEnabled: 'false', GroupRatio: JSON.stringify({ default: 1, [GROUP]: 1 }), UserUsableGroups: JSON.stringify({ [GROUP]: GROUP }) })) await api('/api/option/', 'PUT', { key, value }, admin);
  const source = fs.readFileSync(path.join(__dirname, 'plugins/generated/pikno-canseedream.js'), 'utf8');
  await api('/api/plugin/task', 'POST', { source, sourceSha256: crypto.createHash('sha256').update(source).digest('hex'), enabled: false }, admin);
  await api('/api/plugin/task/pikno-canseedream/activate', 'POST', { version: '0.3.0' }, admin);
  await api('/api/option/', 'PUT', { key: 'billing_setting.plugin_billing_expr', value: JSON.stringify({ ['pikno-canseedream::' + MODEL]: s.quote.expression }) }, admin);
  const config = credentials(); assert.equal(config.baseUrl, 'https://see.ximeiedu.org');
  await api('/api/channel/', 'POST', { mode: 'single', channel: { type: 61, name: 'client14-cansee', key: config.apiKey, base_url: config.baseUrl, models: MODEL, group: GROUP, status: 1, weight: 1, auto_ban: 0, setting: JSON.stringify({ task_plugin_key: 'pikno-canseedream' }) } }, admin);
  const cp = crypto.randomBytes(24).toString('base64url') + 'Aa1!';
  await api('/api/user/', 'POST', { username: 'client14customer', password: cp, role: 1 }, admin);
  let customer = await api('/api/user/login', 'POST', { username: 'client14customer', password: cp });
  await api('/api/user/', 'PUT', { id: customer.user.id, username: 'client14customer', display_name: 'Client14 acceptance', role: 1, status: 1, group: GROUP }, admin);
  await api('/api/user/manage', 'POST', { id: customer.user.id, action: 'add_quota', mode: 'override', value: 10000000 }, admin);
  customer = await api('/api/user/login', 'POST', { username: 'client14customer', password: cp });
  const ch = sessionHeaders(customer);
  await api('/api/token/', 'POST', { name: 'client14-video-once', expired_time: Math.floor(Date.now()/1000)+7200, remain_quota: 5000000, unlimited_quota: false, model_limits_enabled: true, model_limits: MODEL, group: GROUP, cross_group_retry: false }, ch);
  const p = await api('/api/token/?p=1&page_size=100', 'GET', undefined, ch), tokenId = p.items.find(x => x.name === 'client14-video-once').id;
  const key = (await api('/api/token/' + tokenId + '/key', 'POST', undefined, ch)).key;
  const a = { root, customer, tokenId, tokenKey: key.startsWith('sk-') ? key : 'sk-' + key };
  fs.writeFileSync(AUTH, JSON.stringify(a), { flag: 'wx', mode: 0o600 });
  const status = (await call('/api/status')).body.data;
  assert.equal(status.version, 'v1.0.0-rc.41-pikno.12'); assert.equal(status.quota_per_unit/status.usd_exchange_rate, 1000000);
  const forbidden = await call('/api/channel/', 'GET', undefined, ch); assert.equal(forbidden.http, 403);
  s.prepared = true; s.version = status.version; s.adminDeniedHTTP = 403; s.startBalance = await balance(a); save(s);
  console.log(JSON.stringify({ prepared: true, quote: s.quote, adminDeniedHTTP: 403 }));
}
async function submit(a, s) {
  assert.ok(!s.attempt, 'A paid attempt already exists: poll, never resubmit');
  await pricing(); // Refuse a changed quote before charging.
  const bytes = fs.readFileSync(path.join(__dirname, 'brand/pikno-logo.png')), auth = tokenHeaders(a);
  const ticket = await call('/v1/media/uploads', 'POST', { content_type: 'image/png', size: bytes.length }, auth); assert.equal(ticket.http, 201);
  assert.equal(new URL(ticket.body.upload_url).origin, 'https://www.piknoai.com');
  const put = await fetch(ticket.body.upload_url, { method: 'PUT', headers: ticket.body.headers, body: bytes, redirect: 'error', signal: AbortSignal.timeout(60000) }); assert.equal(put.status, 201);
  const completed = await call('/v1/media/complete', 'POST', { upload_ticket: ticket.body.upload_ticket }, auth); assert.equal(completed.http, 200);
  s.media = { uploadBytes: bytes.length, directUploadHTTP: 201, completeHTTP: 200 };
  const body = { model: MODEL, seconds: 4, resolution: '480p', aspect_ratio: '16:9', prompt: 'A gentle camera move toward the abstract blue logo in the reference image. Clean studio lighting, stable scene, no people.', image_urls: [completed.body.url] };
  s.attempt = { startedAt: new Date().toISOString(), status: 'submission_started_do_not_retry', before: await balance(a), requestBytes: Buffer.byteLength(JSON.stringify(body)) }; save(s);
  const r = await call('/v1/videos', 'POST', body, auth, 90000);
  Object.assign(s.attempt, { http: r.http, responseBytes: r.bytes, taskId: r.body.id, status: r.body.id ? r.body.status : 'rejected_do_not_retry', afterSubmit: await balance(a), errorCode: r.body.error?.code }); save(s);
  assert.ok(r.http >= 200 && r.http < 300 && r.body.id, 'CanSeeDream submission rejected; no automatic retry');
  console.log(JSON.stringify(s.attempt));
}
async function poll(a, s) {
  assert.ok(s.attempt?.taskId); if (s.attempt.status === 'passed') { console.log(JSON.stringify(s.attempt)); return; }
  const r = await call('/v1/videos/' + encodeURIComponent(s.attempt.taskId), 'GET', undefined, tokenHeaders(a)); assert.equal(r.http, 200);
  Object.assign(s.attempt, { status: r.body.status, checkedAt: new Date().toISOString() }); save(s);
  if (r.body.status === 'completed') {
    const output = r.body.outputs?.find(x => x.type === 'video' && x.url?.startsWith('https://')); assert.ok(output);
    const video = await fetch(output.url, { headers: { Range: 'bytes=0-31' }, redirect: 'follow', signal: AbortSignal.timeout(30000) });
    s.attempt.downloadHTTP = video.status; s.attempt.contentType = video.headers.get('content-type');
    if (video.status === 206) s.attempt.mp4Signature = Buffer.from(await video.arrayBuffer()).subarray(4,8).toString('ascii') === 'ftyp';
    else await video.body?.cancel();
    const after = await balance(a), before = s.attempt.before;
    Object.assign(s.attempt, { after, quotaDelta: before.quota-after.quota, tokenDelta: before.tokenRemain-after.tokenRemain }); save(s);
    assert.equal(s.attempt.quotaDelta, s.quote.expectedQuota); assert.equal(s.attempt.tokenDelta, s.quote.expectedQuota);
    const logs = await api('/api/log/self?p=1&page_size=100&type=2', 'GET', undefined, sessionHeaders(a.customer));
    const rows = logs.items.filter(x => x.model_name === MODEL && x.token_id === a.tokenId); assert.equal(rows.length, 1); assert.equal(rows[0].quota, s.quote.expectedQuota);
    s.attempt.usageLogId = rows[0].id; s.attempt.customerCNY = s.quote.customerCNY;
    s.attempt.status = s.attempt.downloadHTTP === 206 && s.attempt.mp4Signature ? 'passed' : 'delivery_failed'; save(s);
    assert.equal(s.attempt.status, 'passed', 'Result delivery requires investigation; do not resubmit');
  } else if (r.body.status === 'failed') {
    s.attempt.after = await balance(a); s.attempt.quotaDelta = s.attempt.before.quota-s.attempt.after.quota; save(s);
  }
  console.log(JSON.stringify(s.attempt));
}
async function cleanup(a, s) {
  assert.ok(!s.attempt || ['passed','failed','rejected_do_not_retry','delivery_failed'].includes(s.attempt.status), 'Pending task must not lose its query credential');
  const channels = await api('/api/channel/?p=1&page_size=100', 'GET', undefined, sessionHeaders(a.root));
  for (const c of channels.items) await api('/api/channel/' + c.id + '/status', 'POST', { status: 2 }, sessionHeaders(a.root));
  await api('/api/token/' + a.tokenId, 'DELETE', undefined, sessionHeaders(a.customer));
  const check = await call('/v1/media/uploads', 'POST', { content_type: 'image/png', size: 68 }, tokenHeaders(a)); assert.equal(check.http, 401);
  s.cleanup = { channelsDisabled: true, revokedHTTP: 401, finishedAt: new Date().toISOString() }; save(s); console.log(JSON.stringify(s.cleanup));
}
async function main() {
  const mode = process.argv[2]; assert.ok(['prepare','submit','poll','cleanup'].includes(mode));
  if (mode === 'prepare') return prepare();
  const s = read(JOURNAL), a = read(AUTH); assert.equal(s.prepared, true);
  if (mode === 'submit') return submit(a,s);
  if (mode === 'poll') return poll(a,s);
  return cleanup(a,s);
}
main().catch(e=>{console.error(e.message);process.exitCode=1});
