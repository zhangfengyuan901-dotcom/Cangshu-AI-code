import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url)), root = path.resolve(here, '../..');
const args = process.argv.slice(2), value = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const clientMode = args.includes('--client');
const accountAssets = ['index.html', 'account.mjs', 'account.css', 'admin-wechat.png'];
const accountRelease = path.join('acme', 'hamster-account-manual-20261118');
const config = path.resolve(value('--nginx', path.join(here, 'nginx.conf')));
const out = path.resolve(value('--out', path.join(root, 'output/direct-origin-current/ingress-qa-' + Date.now())));
const openssl = value('--openssl', process.platform === 'win32' ? 'C:\\Program Files\\Git\\usr\\bin\\openssl.exe' : 'openssl');
const nginxImage = 'nginx:stable-alpine@sha256:47928bf67eb62a1863cb08d9ecb52d3e704304ba614eaee17884204677702951';
const nodeImage = 'node:22-alpine@sha256:8ea2348b068a9544dae7317b4f3aafcdc032df1647bb7d768a05a5cad1a7683f';
const suffix = randomBytes(5).toString('hex'), network = 'hamster-ingress-qa-' + suffix, mockName = network + '-mock', ingressName = network + '-nginx';
const tlsDir = path.join(out, 'tls'), checks = [], cleanup = [], createdContainers = [];
let networkCreated = false, ca, httpsPort, httpPort, adminPort, configSHA, setupError;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function run(binary, argv) {
  const result = spawnSync(binary, argv, { encoding: 'utf8', windowsHide: true, timeout: 45000, maxBuffer: 4 * 1024 * 1024 });
  if (result.status !== 0) throw Object.assign(Error('COMMAND_FAILED: ' + binary + ' ' + argv.slice(0, 3).join(' ')), { code: 'COMMAND_FAILED', detail: (result.stderr || result.error?.message || result.stdout || '').slice(0, 4000) });
  return result.stdout.trim();
}
const docker = (...argv) => run('docker', argv);
function request(route, { method = 'GET', headers = {}, body, hostname = 'www.piknoai.com', secure = true, admin = false, firstChunk = false } = {}) {
  const started = performance.now();
  return new Promise((resolve, reject) => {
    const transport = secure && !admin ? https : http;
    const req = transport.request({ hostname: value(admin ? '--mock-host' : '--ingress-host', '127.0.0.1'), port: admin ? adminPort : secure ? httpsPort : httpPort, path: route, method, headers: { Host: hostname, ...headers }, servername: hostname, ca, rejectUnauthorized: true, agent: false, timeout: 7000 }, res => {
      const chunks = []; let firstMs;
      res.on('data', chunk => { chunks.push(chunk); firstMs ??= performance.now() - started; if (firstChunk) { resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks), firstMs, complete: res.complete }); res.destroy(); req.destroy(); } });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks), firstMs, totalMs: performance.now() - started }));
      res.on('error', error => { if (!firstChunk) reject(error); });
    });
    req.on('error', reject); req.on('timeout', () => req.destroy(Error('QA_REQUEST_TIMEOUT'))); req.end(body);
  });
}
const inspectRequests = async () => JSON.parse((await request('/observations', { admin: true })).body).observations;
async function check(id, fn) {
  const started = Date.now();
  try { const measurements = await fn(); checks.push({ id, passed: true, durationMs: Date.now() - started, ...(measurements ? { measurements } : {}) }); }
  catch (error) { checks.push({ id, passed: false, durationMs: Date.now() - started, error: error.code || error.name, message: error.message.slice(0, 600) }); }
  console.log(JSON.stringify(checks.at(-1)));
}
async function waitReady() {
  for (let attempt = 0; attempt < 35; attempt++) { try { if (JSON.parse((await request('/health', { admin: true })).body).ready) return; } catch {} await new Promise(resolve => setTimeout(resolve, 100)); }
  throw Error('MOCK_START_TIMEOUT');
}
async function certificates() {
  await fs.mkdir(tlsDir, { recursive: true });
  const p = file => path.join(tlsDir, file);
  run(openssl, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-subj', '/CN=Hamster ingress synthetic QA CA', '-keyout', p('ca.key'), '-out', p('ca.pem'), '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign']);
  for (const [name, sans] of [['ingress', 'DNS:www.piknoai.com,DNS:origin.piknoai.com'], ['media', 'DNS:media.piknoai.com']]) {
    await fs.writeFile(p(name + '.ext'), 'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=' + sans + '\n');
    run(openssl, ['req', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=' + (name === 'media' ? 'media.piknoai.com' : 'www.piknoai.com'), '-keyout', p(name + '.key'), '-out', p(name + '.csr')]);
    run(openssl, ['x509', '-req', '-days', '2', '-in', p(name + '.csr'), '-CA', p('ca.pem'), '-CAkey', p('ca.key'), '-CAcreateserial', '-extfile', p(name + '.ext'), '-out', p(name + '.pem')]);
  }
  run(openssl, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-subj', '/CN=media.piknoai.com', '-keyout', p('untrusted.key'), '-out', p('untrusted.pem'), '-addext', 'subjectAltName=DNS:media.piknoai.com']);
  await fs.copyFile(p('ingress.pem'), p('fullchain.pem')); await fs.copyFile(p('ingress.key'), p('privkey.pem')); ca = await fs.readFile(p('ca.pem'));
}
try {
  await fs.mkdir(out, { recursive: true }); configSHA = hash(await fs.readFile(config));
  if (!clientMode) {
  docker('image', 'inspect', nginxImage); docker('image', 'inspect', nodeImage);
  await certificates();
  const acme = path.join(out, 'acme'); await fs.mkdir(path.join(acme, '.well-known/acme-challenge'), { recursive: true }); await fs.writeFile(path.join(acme, '.well-known/acme-challenge/synthetic-token'), 'synthetic-acme-response');
  const assets = path.resolve(value('--account-assets', path.join(root, 'build/hamster-trim44-web/public/account-lite')));
  const accountStage = path.join(out, accountRelease);
  await fs.mkdir(accountStage, { recursive: true });
  for (const name of accountAssets) await fs.copyFile(path.join(assets, name), path.join(accountStage, name));
  docker('network', 'create', '--internal', network); networkCreated = true;
  docker('run', '-d', '--pull=never', '--name', mockName, '--network', network, '--network-alias', 'new-api', '--network-alias', 'lanjing-bridge', '--network-alias', 'tool-control', '--network-alias', 'media.piknoai.com', '--read-only', '--cap-drop=ALL', '--cap-add=NET_BIND_SERVICE', '--security-opt=no-new-privileges:true', '-e', 'HAMSTER_INGRESS_QA=synthetic-only', '-v', here + ':/qa/code:ro', '-v', tlsDir + ':/qa/tls:ro', nodeImage, 'node', '/qa/code/mock-upstreams.mjs'); createdContainers.push(mockName);
  const common = ['--pull=never', '--network', network, '--read-only', '--cap-drop=ALL', '--cap-add=NET_BIND_SERVICE', '--cap-add=SETUID', '--cap-add=SETGID', '--cap-add=CHOWN', '--security-opt=no-new-privileges:true', '--tmpfs', '/var/cache/nginx:rw,noexec,nosuid,size=16m', '--tmpfs', '/var/run:rw,noexec,nosuid,size=1m', '-v', config + ':/etc/nginx/nginx.conf:ro', '-v', tlsDir + ':/etc/nginx/tls:ro', '-v', path.join(tlsDir, 'ca.pem') + ':/etc/ssl/certs/ca-certificates.crt:ro', '-v', acme + ':/var/www/acme:ro', '--entrypoint', 'nginx'];
  const syntax = docker('run', '--rm', ...common, nginxImage, '-t'); await fs.writeFile(path.join(out, 'nginx-syntax.txt'), syntax + '\n');
  docker('run', '-d', '--name', ingressName, ...common, nginxImage, '-g', 'daemon off;'); createdContainers.push(ingressName);
  try { console.log(docker('run', '--rm', '--pull=never', '--network', network, '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges:true', '-v', here + ':/qa/code:ro', '-v', out + ':/qa/output', '-v', config + ':/qa/nginx.conf:ro', nodeImage, 'node', '/qa/code/test-ingress.mjs', '--client', '--nginx', '/qa/nginx.conf', '--out', '/qa/output', '--ingress-host', ingressName, '--mock-host', mockName)); }
  catch (error) { try { await fs.access(path.join(out, 'client-verification.json')); } catch { throw error; } }
  const clientResult = JSON.parse(await fs.readFile(path.join(out, 'client-verification.json'), 'utf8')); checks.push(...clientResult.checks); if (clientResult.setupError) setupError = clientResult.setupError;
  } else {
  ca = await fs.readFile(path.join(tlsDir, 'ca.pem')); httpsPort = 443; httpPort = 80; adminPort = 18080; await waitReady();
  await check('http-acme-and-https-redirect', async () => {
    let res = await request('/.well-known/acme-challenge/synthetic-token', { secure: false }); assert.equal(res.status, 200); assert.equal(res.body.toString(), 'synthetic-acme-response');
    res = await request('/account-lite/index.html?mode=test', { secure: false }); assert.equal(res.status, 308); assert.equal(res.headers.location, 'https://www.piknoai.com/account-lite/index.html?mode=test'); return { redirectStatus: res.status };
  });
  const spoofed = { 'X-Forwarded-For': '198.51.100.222, 127.0.0.1', 'X-Real-IP': '203.0.113.222', 'CF-Connecting-IP': '192.0.2.222', 'True-Client-IP': '192.0.2.223', Forwarded: 'for=192.0.2.224;host=evil.invalid;proto=http', 'X-Forwarded-Host': 'evil.invalid', 'X-Forwarded-Proto': 'http', Origin: 'https://www.piknoai.com', Referer: 'https://www.piknoai.com/account-lite/index.html' };
  function cleanHeaders(headers, expectedHost) {
    assert.equal(headers.host, expectedHost); assert.equal(headers['x-forwarded-host'], 'www.piknoai.com'); assert.equal(headers['x-forwarded-proto'], 'https');
    assert.match(headers['x-forwarded-for'], /^[0-9a-fA-F:.]+$/); assert(!['198.51.100.222', '203.0.113.222', '192.0.2.222'].includes(headers['x-forwarded-for']));
    assert.equal(headers['x-real-ip'], headers['x-forwarded-for']); for (const key of ['cf-connecting-ip', 'true-client-ip', 'forwarded']) assert.equal(headers[key], undefined);
  }
  await check('api-spoofed-ip-host-proto-headers-replaced', async () => { const res = await request('/api/status', { headers: spoofed }); assert.equal(res.status, 200); const payload = JSON.parse(res.body); assert.equal(payload.backend, 'new-api'); cleanHeaders(payload.request.headers, 'www.piknoai.com'); assert.equal(payload.request.headers.origin, spoofed.Origin); assert.equal(payload.request.headers.referer, spoofed.Referer); });
  await check('origin-rejection-and-refresh-cookie-preserved', async () => {
    let res = await request('/api/user/auth/refresh', { method: 'POST', headers: { Origin: 'https://evil.invalid', Cookie: 'new_api_refresh=synthetic' } }); assert.equal(res.status, 403);
    res = await request('/api/user/auth/refresh', { method: 'POST', headers: { Origin: 'https://www.piknoai.com', Cookie: 'new_api_refresh=synthetic' } }); assert.equal(res.status, 200); assert.deepEqual(res.headers['set-cookie'], ['new_api_refresh=qa-only; Path=/api/user/auth; HttpOnly; Secure; SameSite=Strict']);
  });
  await check('post-reset-and-uncertain-response-never-replayed', async () => {
    for (const mode of ['reset-after-body', 'uncertain-503']) {
      const before = (await inspectRequests()).length; const res = await request('/v1/images/generations', { method: 'POST', headers: { 'X-QA-Mode': mode, 'Content-Type': 'application/json' }, body: '{"synthetic":true}' }); assert.equal(res.status, mode === 'reset-after-body' ? 502 : 503);
      const accepted = (await inspectRequests()).slice(before).filter(row => row.uri === '/v1/images/generations'); assert.equal(accepted.length, 1); assert.equal(accepted[0].bytes, 18);
    }
  });
  await check('chat-files-50mib-plus-multipart-reaches-account-api-once', async () => {
    const contentType = 'multipart/form-data; boundary=synthetic-chat-files';
    const body = Buffer.alloc(50 * 1024 * 1024 + 65536, 0x41);
    const before = (await inspectRequests()).length;
    const res = await request('/assistant/v2/files', { method:'POST', headers:{'Content-Type':contentType, 'Content-Length':String(body.length), Authorization:'Bearer synthetic-chat-key'}, body });
    assert.equal(res.status, 200);
    const payload = JSON.parse(res.body); assert.equal(payload.backend, 'new-api');
    assert.equal(payload.request.bytes, body.length); assert.equal(payload.request.sha256, hash(body));
    assert.equal(payload.request.headers.authorization, 'Bearer synthetic-chat-key');
    assert.equal(payload.request.headers['content-type'], contentType);
    assert.equal((await inspectRequests()).slice(before).filter(row => row.uri === '/assistant/v2/files').length, 1);
    return { bodyBytes:body.length, sha256:hash(body) };
  });
  await check('chat-file-status-delete-routing-and-post-failure-not-replayed', async () => {
    const route = '/assistant/v2/files/hf1_synthetic-file-handle';
    for (const method of ['GET','DELETE']) {
      const res = await request(route, { method, headers:{Authorization:'Bearer synthetic-chat-key'} });
      assert.equal(res.status, 200); assert.equal(JSON.parse(res.body).backend, 'new-api');
      assert.equal(JSON.parse(res.body).request.method, method);
    }
    for (const mode of ['reset-after-body','uncertain-503']) {
      const before = (await inspectRequests()).length;
      const res = await request('/assistant/v2/files', { method:'POST', headers:{'X-QA-Mode':mode}, body:'synthetic-file' });
      assert.equal(res.status, mode === 'reset-after-body' ? 502 : 503);
      assert.equal((await inspectRequests()).slice(before).filter(row=>row.uri === '/assistant/v2/files').length, 1);
    }
    assert.equal((await request(route, {hostname:'origin.piknoai.com'})).status,404);
  });
  await check('native-image-edits-large-body-with-exact-route-limit', async () => {
    const body = Buffer.alloc(130 * 1024 * 1024, 0x42);
    const before = (await inspectRequests()).length;
    const res = await request('/v1/images/edits', { method: 'POST', headers: { 'Content-Type': 'multipart/form-data; boundary=synthetic-image-edit', 'Content-Length': String(body.length) }, body });
    assert.equal(res.status, 200);
    const payload = JSON.parse(res.body); assert.equal(payload.backend, 'new-api');
    assert.equal(payload.request.bytes, body.length); assert.equal(payload.request.sha256, hash(body));
    assert.equal((await inspectRequests()).slice(before).filter(row => row.uri === '/v1/images/edits').length, 1);
    for (const [route, bytes] of [['/v1/images/edits', 602 * 1024 * 1024], ['/v1/images/generations', body.length]]) {
      const rejected = await request(route, { method: 'POST', headers: { 'Content-Length': String(bytes) } });
      assert.equal(rejected.status, 413);
    }
    return { bodyBytes: body.length, forwardedOnce: true, oversizedAndOtherRouteRejected: true };
  });
  await check('sse-first-block-arrives-before-upstream-completion', async () => { const res = await request('/api/pikno/catalog/events', { firstChunk: true }); assert.equal(res.status, 200); assert.match(res.body.toString(), /event: first/); assert(!res.body.includes(Buffer.from('event: last'))); assert(res.firstMs < 1200, 'SSE first block buffered'); return { firstBlockMs: Math.round(res.firstMs), upstreamCompletionDelayMs: 1800 }; });
  const asset = '/media/v1/assets/0123456789abcdef0123456789abcdef', bytes = Buffer.alloc(128 * 1024, 0x61); Buffer.from('89504e470d0a1a0a', 'hex').copy(bytes);
  const query = '?ticket=synthetic-read-ticket&preserve=a%2Bb%2F%3D&order=2&order=1';
  const assetLocation = (await fs.readFile(config, 'utf8')).split(/^\s*location\s+/m).find(block => block.startsWith('^~ /media/v1/assets/ {'));
  const directAsset = assetLocation?.includes('proxy_pass http://task_control;') ?? false;
  await check('media-upload-host-sni-length-auth-origin-cookie-boundary', async () => {
    const res = await request(asset, { method: 'PUT', headers: { ...spoofed, Cookie: 'new_api_refresh=synthetic; other=private', Authorization: 'Bearer synthetic-upload-ticket', 'Content-Type': 'image/png', 'Content-Length': String(bytes.length) }, body: bytes }); assert.equal(res.status, 201); assert.equal(res.headers['set-cookie'], undefined); assert.equal(JSON.parse(res.body).sha256, hash(bytes));
    const row = (await inspectRequests()).findLast(row => row.backend === (directAsset ? 'media-direct' : 'media')); cleanHeaders(row.headers, directAsset ? 'www.piknoai.com' : 'media.piknoai.com'); assert.equal(row.sni, directAsset ? null : 'media.piknoai.com'); assert.equal(row.headers.cookie, undefined); assert.equal(row.headers.authorization, 'Bearer synthetic-upload-ticket'); assert.equal(row.headers['content-length'], String(bytes.length)); assert.equal(row.bytes, bytes.length);
  });
  await check('media-head-get-range-query-and-inspection-preserved', async () => {
    let res = await request(asset + query); assert.equal(res.status, 200); assert.deepEqual(res.body, bytes); assert.equal(res.headers['cache-control'], 'private, no-store'); assert.equal(res.headers['set-cookie'], undefined); assert.equal((await inspectRequests()).at(-1).uri, asset + query);
    res = await request(asset + query, { method: 'HEAD' }); assert.equal(res.status, 200); assert.equal(res.body.length, 0); assert.equal(res.headers['content-length'], String(bytes.length));
    res = await request(asset + query, { headers: { Range: 'bytes=7-22', 'If-Range': '"synthetic-etag"' } }); assert.equal(res.status, 206); assert.equal(res.headers['content-range'], `bytes 7-22/${bytes.length}`); assert.deepEqual(res.body, bytes.subarray(7, 23)); assert.equal((await inspectRequests()).at(-1).headers['if-range'], '"synthetic-etag"');
    res = await request(asset + query, { headers: { Range: 'bytes=999999-' } }); assert.equal(res.status, 416);
    res = await request(asset + '/inspect', { method: 'POST', headers: { Authorization: 'Bearer synthetic-inspect-ticket' } }); assert.equal(res.status, 200);
    res = await request(asset + query, { headers: { Origin: 'https://evil.invalid' } }); assert.equal(res.status, 403);
  });
  await check(directAsset ? 'media-direct-independent-of-worker-tls' : 'media-upstream-untrusted-tls-certificate-rejected', async () => {
    await request('/tls/untrusted', { method: 'POST', admin: true });
    try { const before = (await inspectRequests()).length, res = await request(asset + query); assert.equal(res.status, directAsset ? 200 : 502); assert.equal((await inspectRequests()).length, before + (directAsset ? 1 : 0)); }
    finally { await request('/tls/trusted', { method: 'POST', admin: true }); }
    assert.equal((await request(asset + query)).status, 200);
  });
  await check('payment-and-control-independent-routing', async () => {
    for (const [route, backend] of [['/pay/lanjing/health', 'payment'], ['/media/v1/tools/status', 'control'], ['/media/v1/packy', 'control']]) { const res = await request(route, { headers: spoofed }); assert.equal(res.status, 200); const data = JSON.parse(res.body); assert.equal(data.backend, backend); cleanHeaders(data.request.headers, 'www.piknoai.com'); }
    assert.equal((await request('/media/not-allowed')).status, 404);
  });
  await check('manual-recharge-static-assets-match-candidate', async () => {
    const before = (await inspectRequests()).length;
    const mimeTypes = ['text/html', 'application/javascript', 'text/css', 'image/png'];
    for (const [index, name] of accountAssets.entries()) {
      const expected = await fs.readFile(path.join(out, accountRelease, name));
      const res = await request('/account-lite/' + name + '?tab=topup');
      assert.equal(res.status, 200, name);
      assert.equal(res.headers['content-type'].split(';')[0], mimeTypes[index]);
      assert.equal(res.headers['cache-control'], 'no-store');
      assert.equal(res.headers['x-content-type-options'], 'nosniff');
      assert.equal(hash(res.body), hash(expected));
    }
    assert.equal((await inspectRequests()).length, before);
    const storageName = path.basename(accountRelease);
    const probe = await request('/' + storageName + '/admin-wechat.png');
    assert.equal(JSON.parse(probe.body).backend, 'new-api');
  });
  await check('manual-recharge-blocks-customer-checkout', async () => {
    const before = (await inspectRequests()).length;
    const routes = [
      ['/api/user/pay', 'POST'],
      ['/api/user/topup/checkout/', 'POST'],
      ['/pay/lanjing/epay/submit.php', 'POST'],
      ['/pay/lanjing/epay/submit.php?synthetic=only', 'GET'],
      ['/pay/lanjing/epay/authorize', 'POST'],
    ];
    for (const [route, method] of routes) {
      const res = await request(route, { method });
      assert.equal(res.status, 410, route);
      assert.match(res.headers['content-type'], /^application\/json\b/);
      assert.equal(res.headers['cache-control'], 'no-store');
      assert.deepEqual(JSON.parse(res.body), { success: false, message: '在线充值已关闭，请联系管理员充值。' });
    }
    assert.equal((await inspectRequests()).length, before);
  });
  await check('historical-payment-and-quota-management-route-independently', async () => {
    const routes = [
      ['/pay/lanjing/notify', 'GET', 'payment'],
      ['/pay/lanjing/return', 'GET', 'payment'],
      ['/api/user/epay/notify', 'POST', 'new-api'],
      ['/api/user/topup/self', 'GET', 'new-api'],
      ['/api/user/topup/status?trade_no=synthetic', 'GET', 'new-api'],
      ['/api/user/topup/cancel', 'POST', 'new-api'],
      ['/api/user/manage', 'POST', 'new-api'],
      ['/api/user/self', 'GET', 'new-api'],
    ];
    for (const [route, method, backend] of routes) {
      const res = await request(route, { method });
      assert.equal(res.status, 200, route);
      assert.equal(JSON.parse(res.body).backend, backend);
    }
  });
  await check('legacy-origin-control-only', async () => {
    for (const route of ['/media/v1/tools/status', '/media/v1/packy']) { const res = await request(route, { hostname: 'origin.piknoai.com' }); assert.equal(res.status, 200); assert.equal(JSON.parse(res.body).backend, 'control'); }
    for (const route of ['/auth-lite/index.html', '/api/status', asset + query, '/pay/lanjing/health']) assert.equal((await request(route, { hostname: 'origin.piknoai.com' })).status, 404);
  });
  await check('unrecognized-host-http-and-tls-rejected', async () => { await assert.rejects(() => request('/', { hostname: 'evil.invalid', secure: false })); await assert.rejects(() => request('/', { hostname: 'evil.invalid' })); });
  await check('candidate-config-unchanged', async () => assert.equal(hash(await fs.readFile(config)), configSHA));
  await fs.writeFile(path.join(out, 'observations.json'), JSON.stringify({ syntheticOnly: true, observations: await inspectRequests() }, null, 2) + '\n');
  }
} catch (error) { setupError = { code: error.code || error.name, message: error.message, detail: error.detail }; }
finally {
  for (const container of createdContainers.toReversed()) {
    try { const logs = docker('logs', container); await fs.writeFile(path.join(out, container.endsWith('-nginx') ? 'nginx.log' : 'mocks.log'), logs + '\n'); } catch {}
    try { docker('rm', '-f', container); cleanup.push({ resource: container, removed: true }); } catch { cleanup.push({ resource: container, removed: false }); }
  }
  if (networkCreated) { try { docker('network', 'rm', network); cleanup.push({ resource: network, removed: true }); } catch { cleanup.push({ resource: network, removed: false }); } }
  const result = { format: 1, generatedAt: new Date().toISOString(), passed: !setupError && checks.length > 0 && checks.every(row => row.passed) && cleanup.every(row => row.removed), config, configSHA256: configSHA, nginxImage, nodeImage, checks, setupError, cleanup, scope: { dockerNetworkInternal: true, tlsValidationDisabled: false, productionNetworkUsed: false, realAccounts: false, paidCalls: false, mockUpstreams: true, nginxConfigAltered: false }, limitations: ['Synthetic upstreams verify Nginx transport, not real Go authentication or payment settlement.', 'QA CA is mounted only in isolated test containers; production certificate chain is not validated here.', 'No public DNS, firewall, real carrier routing, or production deployment was exercised.'] };
  const resultName = clientMode ? 'client-verification.json' : 'verification.json';
  await fs.mkdir(out, { recursive: true }); await fs.writeFile(path.join(out, resultName), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify({ passed: result.passed, checks: checks.length, setupError, output: path.join(out, resultName) }));
  if (!result.passed) process.exitCode = 1;
}
