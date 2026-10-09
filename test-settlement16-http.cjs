'use strict';
// Isolated localhost acceptance only. Fake media upstream, real gateway HTTP
// auth/reservations/review proofs/refunds. No real supplier key or email sender.
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const port = process.env.PIKNO_SETTLEMENT_TEST_PORT || '3216';
assert.ok(['3216', '3217'].includes(port), 'Only isolated acceptance ports are allowed');
const BASE = `http://127.0.0.1:${port}`;
const MODEL = 'gpt-image-2.5-flare';
const directory = path.join(__dirname, 'private', port === '3216' ? 'settlement16-http' : 'settlement16-http-3217');
let calls = 0;
const fake = http.createServer(async (request, response) => {
  let text = ''; for await (const chunk of request) text += chunk;
  const body = JSON.parse(text); calls++;
  response.setHeader('Content-Type', 'application/json');
  if (body.prompt === 'isolated-failure') { response.writeHead(500); response.end(JSON.stringify({ error: { type: 'upstream_error', message: 'simulated ambiguous failure' } })); return; }
  response.end(JSON.stringify({ created: 1791496800, data: [{ url: 'https://example.com/isolated-fixture.png' }] }));
});
async function call(route, method = 'GET', body, headers = {}) {
  const response = await fetch(BASE + route, { method, headers: { 'Content-Type': 'application/json', Origin: BASE, ...headers }, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(15000) });
  let value; try { value = await response.json(); } catch { throw new Error(route + ' non-JSON HTTP ' + response.status); }
  return { status: response.status, value };
}
async function api(route, method, body, headers) {
  const result = await call(route, method, body, headers);
  assert.equal(result.status, 200, route + ': HTTP ' + result.status);
  assert.equal(result.value.success, true, route + ': ' + (result.value.message || 'rejected'));
  return result.value.data;
}
const headers = (session) => ({ Authorization: 'Bearer ' + session.access_token });
async function run() {
  await new Promise((resolve, reject) => { fake.once('error', reject); fake.listen(0, '0.0.0.0', resolve); });
  fs.mkdirSync(directory, { recursive: true });
  const password = crypto.randomBytes(24).toString('base64url') + 'Aa1!';
  await api('/api/setup', 'POST', { username: 'piknoadmin', password, confirmPassword: password });
  const root = await api('/api/user/login', 'POST', { username: 'piknoadmin', password });
  const admin = headers(root);
  for (const [key, value] of Object.entries({ RetryTimes: '3', QuotaPerUnit: '7300000', USDExchangeRate: '7.3', 'general_setting.quota_display_type': 'CNY', RegisterEnabled: 'false', GroupRatio: '{"default":1}', UserUsableGroups: '{"default":"default"}', ModelPrice: JSON.stringify({ [MODEL]: 0.0136986301369863 }) })) await api('/api/option/', 'PUT', { key, value }, admin);
  await api('/api/channel/', 'POST', { mode: 'single', channel: { type: 1, name: 'isolated settlement fixture', key: 'not-a-real-upstream-key', base_url: `http://host.docker.internal:${fake.address().port}`, models: MODEL, group: 'default', status: 1, weight: 1, auto_ban: 0 } }, admin);
  const customerPassword = crypto.randomBytes(24).toString('base64url') + 'Aa1!';
  await api('/api/user/', 'POST', { username: 'settlement16customer', password: customerPassword, role: 1 }, admin);
  const customer = await api('/api/user/login', 'POST', { username: 'settlement16customer', password: customerPassword });
  const ordinary = headers(customer);
  await api('/api/user/manage', 'POST', { id: customer.user.id, action: 'add_quota', mode: 'override', value: 10000000 }, admin);
  await api('/api/token/', 'POST', { name: 'isolated-settlement', expired_time: Math.floor(Date.now() / 1000) + 7200, remain_quota: 5000000, unlimited_quota: false, model_limits_enabled: true, model_limits: MODEL, group: 'default', cross_group_retry: false }, ordinary);
  const token = (await api('/api/token/?p=1&page_size=100', 'GET', undefined, ordinary)).items[0];
  const key = (await api(`/api/token/${token.id}/key`, 'POST', undefined, ordinary)).key;
  const customerToken = { Authorization: 'Bearer ' + (key.startsWith('sk-') ? key : 'sk-' + key) };
  fs.writeFileSync(path.join(directory, 'auth.json'), JSON.stringify({ root, customer, password, customerPassword }), { mode: 0o600 });
  assert.equal((await call('/api/pikno/settlements/admin', 'GET', undefined, ordinary)).status, 403);
  const success = await call('/v1/images/generations', 'POST', { model: MODEL, prompt: 'isolated-success', n: 1, response_format: 'url' }, customerToken);
  assert.equal(success.status, 200, 'successful fake image response');
  const afterImage = await api('/api/user/self', 'GET', undefined, ordinary);
  assert.equal(afterImage.quota, 9900000); assert.equal(afterImage.used_quota, 100000);
  const failure = await call('/v1/images/generations', 'POST', { model: MODEL, prompt: 'isolated-failure', n: 1, response_format: 'url' }, customerToken);
  assert.ok(failure.status >= 400); assert.equal(calls, 2, 'no second upstream attempt despite configured retries');
  const orders = await api('/api/pikno/settlements/self', 'GET', undefined, ordinary);
  assert.equal(orders.items.length, 2);
  const pending = orders.items.find(order => order.financial_state === 'pending_review'); assert.ok(pending);
  assert.equal(pending.reserved_quota, 100000); assert.equal(pending.net_quota, 0);
  const command = { operation_id: crypto.randomUUID(), version: pending.version, action: 'failure', reason: 'ISOLATED: verified fake upstream receipt', upstream_task_id: 'fixture-transaction', evidence_ref: 'fixture-receipt', charged_quota: 50000, refunded_quota: 0, images: 1, fixed_refund_quota: 0 };
  const prefix = `/api/pikno/settlements/admin/${pending.order_id}`;
  const preview = await api(prefix + '/preview', 'POST', command, admin);
  assert.equal(preview.after_net, 50000); assert.equal(preview.wallet_delta, 50000);
  assert.equal((await call(prefix + '/apply', 'POST', command, admin)).status, 403);
  const proof = await api('/api/verify', 'POST', { method: 'password', password, scope: 'pikno.settlement.review', context: { digest: preview.digest } }, admin);
  await api(prefix + '/apply', 'POST', command, { ...admin, 'X-Security-Proof': proof.proof_token });
  assert.equal((await call(prefix + '/apply', 'POST', command, { ...admin, 'X-Security-Proof': proof.proof_token })).status, 409);
  const paid = await api('/api/user/self', 'GET', undefined, ordinary); assert.equal(paid.quota, 9850000); assert.equal(paid.used_quota, 150000);
  const reviewed = await api(prefix, 'GET', undefined, admin);
  const refund = { ...command, operation_id: crypto.randomUUID(), version: reviewed.order.version, action: 'refund', reason: 'ISOLATED: fake upstream refund', refunded_quota: 50000 };
  const refundPreview = await api(prefix + '/preview', 'POST', refund, admin); assert.equal(refundPreview.after_net, 0);
  const refundProof = await api('/api/verify', 'POST', { method: 'password', password, scope: 'pikno.settlement.review', context: { digest: refundPreview.digest } }, admin);
  await api(prefix + '/apply', 'POST', refund, { ...admin, 'X-Security-Proof': refundProof.proof_token });
  const final = await api('/api/user/self', 'GET', undefined, ordinary); assert.equal(final.quota, 9900000); assert.equal(final.used_quota, 100000);
  const detail = await api(`/api/pikno/settlements/self/${pending.order_id}`, 'GET', undefined, ordinary);
  assert.equal(detail.order.refunded_quota, 50000); assert.equal(detail.order.financial_state, 'refunded');
  assert.ok(!JSON.stringify(detail).includes('fixture-receipt'));
  const result = { passed: true, upstream: 'simulated', realSupplierCalls: 0, realEmailSends: 0, upstreamRequests: calls, customerRemainingCNY: 9.9, consumptionCNY: 0.1, failedOrderRefundCNY: 0.05, duplicateReviewHTTP: 409, unauthorizedReviewHTTP: 403 };
  fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
}
run().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(() => fake.close());
