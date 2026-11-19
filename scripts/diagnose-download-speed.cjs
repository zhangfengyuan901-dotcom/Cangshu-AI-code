// Public, bounded download probes. No credentials, proxy addresses or client IPs in reports.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const phase = process.argv[2] || 'before';
if (!/^[a-z0-9-]+$/.test(phase)) throw new Error('Invalid report label');
const dir = path.join(root, 'output/download-speed-20261019'); fs.mkdirSync(dir, { recursive: true });
const base = 'https://hamsterai.cc';
const artifact = path.join(root, 'dist/release-1.7.49/仓鼠AI-1.7.49-便携版.exe');
const headerNames = new Set(['content-length', 'content-range', 'content-type', 'cache-control', 'cf-cache-status', 'age', 'etag', 'last-modified', 'accept-ranges', 'server-timing', 'x-download-cache']);
async function probe(label, pathname, range, head = false) {
  const headerFile = path.join(dir, phase + '-' + label + '.headers.tmp');
  const args = ['--silent', '--show-error', '--ipv4', '--connect-timeout', '10', '--max-time', '35', '--dump-header', headerFile, '--write-out', '%{stderr}\n__METRICS__%{json}', base + pathname];
  if (head) args.push('--head');
  if (range) args.push('--range', range);
  const began = new Date().toISOString(), digest = crypto.createHash('sha256'); let bytes = 0, stderr = '';
  const process = spawn('curl.exe', args, { windowsHide: true });
  process.stdout.on('data', data => { if (!head) { bytes += data.length; digest.update(data); } });
  process.stderr.on('data', data => { stderr += data; });
  const exitCode = await new Promise((resolve, reject) => { process.on('error', reject); process.on('close', resolve); });
  const marker = stderr.lastIndexOf('__METRICS__'); const metrics = marker >= 0 ? JSON.parse(stderr.slice(marker + 11)) : {};
  const headers = {}; let colo;
  if (fs.existsSync(headerFile)) {
    for (const row of fs.readFileSync(headerFile, 'utf8').split(/\r?\n/)) {
      const colon = row.indexOf(':'); if (colon < 0) continue;
      const key = row.slice(0, colon).toLowerCase(), value = row.slice(colon + 1).trim();
      if (headerNames.has(key)) headers[key] = value;
      if (key === 'cf-ray') colo = value.split('-').at(-1);
    }
    fs.unlinkSync(headerFile);
  }
  const result = { label, startedAt: began, transport: 'curl IPv4 without explicit proxy', pathname, range: range || null, method: head ? 'HEAD' : 'GET', exitCode, status: metrics.http_code, bytes, dnsSeconds: metrics.time_namelookup, tcpSeconds: metrics.time_connect, tlsSeconds: metrics.time_appconnect, firstByteSeconds: metrics.time_starttransfer, totalSeconds: metrics.time_total, bytesPerSecond: metrics.speed_download, httpVersion: metrics.http_version, edgeColo: colo, headers, timedOut: exitCode === 28 };
  if (!head) result.bodySha256 = digest.digest('hex');
  if (range && bytes > 0 && fs.existsSync(artifact)) {
    const start = Number(range.split('-')[0]), buffer = Buffer.alloc(bytes), fd = fs.openSync(artifact, 'r');
    try { fs.readSync(fd, buffer, 0, bytes, start); } finally { fs.closeSync(fd); }
    result.receivedBytesMatchLocal = result.bodySha256 === crypto.createHash('sha256').update(buffer).digest('hex');
  }
  console.log(JSON.stringify(result)); return result;
}
(async () => {
  const results = [];
  results.push(await probe('homepage', '/'));
  results.push(await probe('download-head', '/download/HamsterAI-Portable-1.7.49.exe', null, true));
  for (let round = 1; round <= 2; round++) results.push(await probe('range4mb-' + round, '/download/HamsterAI-Portable-1.7.49.exe', '0-4194303'));
  const report = { checkedAt: new Date().toISOString(), phase, scope: 'Public website only; no generation/inference or customer information', results };
  fs.writeFileSync(path.join(dir, phase + '-curl-probes.json'), JSON.stringify(report, null, 2) + '\n');
})().catch(error => { console.error(error.name); process.exitCode = 1; });
