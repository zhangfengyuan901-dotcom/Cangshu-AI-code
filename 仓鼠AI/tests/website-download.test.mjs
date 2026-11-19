import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import worker from '../website/src/worker.js';

const NETDISK = 'https://pan.baidu.com/s/1XH4gWPgY4VjApNkWa4GN7g?pwd=njd6';
const read = path => readFileSync(new URL('../website/' + path, import.meta.url), 'utf8');

function environment() {
  return {
    get DOWNLOADS() { assert.fail('Installer requests must never read R2'); },
    ASSETS: { fetch() { assert.fail('Legacy installer requests must never reach static assets'); } },
  };
}

async function redirected(request) {
  const response = await worker.fetch(request, environment());
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), NETDISK);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('cloudflare-cdn-cache-control'), 'no-store');
  for (const name of ['content-disposition', 'content-range', 'accept-ranges', 'etag', 'last-modified']) {
    assert.equal(response.headers.get(name), null, name);
  }
  assert.equal((await response.arrayBuffer()).byteLength, 0);
}

test('all previously public releases redirect to the sole netdisk share without storage reads', async () => {
  for (const host of ['hamsterai.cc', 'www.hamsterai.cc']) {
    for (const version of ['1.7.73', '1.7.74', '1.7.75', '1.7.77']) {
      for (const method of ['GET', 'HEAD']) {
        await redirected(new Request(`https://${host}/download/HamsterAI-Portable-${version}.exe`, { method }));
      }
    }
  }
});

test('old Range and conditional requests cannot recover a cached executable body', async () => {
  for (const method of ['GET', 'HEAD']) {
    for (const headers of [
      { Range: 'bytes=0-1023' },
      { Range: 'bytes=0-', 'If-Range': '"test"' },
      { 'If-None-Match': '"test"' },
      { 'If-Match': '"obsolete"', 'If-Modified-Since': 'Sun, 18 Oct 2026 10:00:00 GMT' },
    ]) {
      await redirected(new Request('https://hamsterai.cc/download/HamsterAI-Portable-1.7.77.exe', { method, headers }));
    }
  }
});

test('query strings and alternate legacy download paths never select a different destination', async () => {
  for (const path of [
    '/download', '/download/', '/download/HamsterAI-Setup-1.7.77.exe',
    '/download/releases/1.7.77/HamsterAI-Portable-1.7.77.exe', '/download/private.exe',
    '/download/HamsterAI-Portable-1.7.46.exe?redirect=https%3A%2F%2Fexample.invalid&pwd=wrong',
  ]) await redirected(new Request('https://hamsterai.cc' + path));
});

test('write and preflight methods on legacy download paths fail before any storage or asset dispatch', async () => {
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
    const response = await worker.fetch(new Request('https://hamsterai.cc/download/file.exe', { method }), environment());
    assert.equal(response.status, 405, method);
    assert.equal(response.headers.get('allow'), 'GET, HEAD');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('location'), null);
    assert.equal((await response.arrayBuffer()).byteLength, 0);
  }
});

test('non-download routes preserve the static assets request and do not require a download binding', async () => {
  for (const path of ['/', '/tutorials/?page=1', '/assets/case-01.jpg']) {
    let seen;
    const request = new Request('https://hamsterai.cc' + path);
    const response = await worker.fetch(request, { ASSETS: { fetch(value) { seen = value; return new Response('asset'); } } });
    assert.equal(seen, request);
    assert.equal(await response.text(), 'asset');
  }
});

test('www keeps canonical redirects for ordinary pages while download requests go directly to netdisk', async () => {
  const response = await worker.fetch(new Request('https://www.hamsterai.cc/tutorials/?page=1'), environment());
  assert.equal(response.status, 308);
  assert.equal(response.headers.get('location'), 'https://hamsterai.cc/tutorials/?page=1');
  await redirected(new Request('https://www.hamsterai.cc/download/HamsterAI-Portable-1.7.77.exe'));
});

test('Workers configuration removes installer storage and named byte-cache capabilities', () => {
  const config = JSON.parse(read('wrangler.jsonc'));
  assert.equal(config.r2_buckets, undefined);
  assert.deepEqual(config.cache, { enabled: false, cross_version_cache: false });
  assert.deepEqual(config.exports, { default: { type: 'worker', cache: { enabled: false } } });
  assert.equal(config.assets.binding, 'ASSETS');
  assert.equal(config.assets.run_worker_first, true);
  assert.equal(config.compatibility_date, '2026-09-16');
  for (const file of ['src/worker.js', 'src/download-handler.js', 'src/download-gateway.js']) {
    assert.doesNotMatch(read(file), /DOWNLOADS|WorkerEntrypoint|ctx\.exports|serveDownload|publishedDownload|enforceDownloadConditions/);
  }
});

test('public assets contain no alternative installer archive that could bypass the redirect', () => {
  const publicDirectory = new URL('../website/public/', import.meta.url);
  const files = readdirSync(publicDirectory, { recursive: true });
  assert.ok(files.every(file => !/\.(?:exe|msi|msix|zip|7z)$/i.test(file)));
});

test('home page provides only the requested share and preserves release verification metadata', () => {
  const page = read('public/index.html');
  const links = [...page.matchAll(/href="([^\"]+)"/g)].map(match => match[1]);
  assert.equal(links.filter(link => link === NETDISK).length, 1);
  assert.ok(links.every(link => !/^\/download\//.test(link) && !/\.exe(?:[?#]|$)/i.test(link)));
  assert.match(page, /百度网盘下载/);
  assert.match(page, /提取码：njd6/);
  assert.match(page, /仓鼠AI-1\.7\.77\.exe/);
  assert.match(page, /166,568,579 字节/);
  assert.match(page, /CE64F8F43C6FEA70AA13EF0A90B21C5EC0808276D58E8469BBA85D0FA8903342/);
  assert.doesNotMatch(page, /直接下载 Windows|官网下载/);
});

test('the current tutorial retains browser registration and account-safe recharge behavior', () => {
  const tutorial = read('public/tutorials/index.html');
  for (const text of [
    '通过百度网盘下载仓鼠AI-1.7.77.exe，提取码 njd6',
    '连接仓鼠 AI 并继续充值', '已有同账户的有效配置继续使用',
    '系统按账户与用途补齐应用 Key', '网页账号与应用账号不一致',
    '后台获取当前报价并核对本次总费用与余额', '余额不足时显示「前往充值」',
    '图片参考图随生成请求直传', '图片和工具结果从上游下载到本机',
    '正常对话在后台静默结算',
  ]) assert.ok(tutorial.includes(text), text);
});
