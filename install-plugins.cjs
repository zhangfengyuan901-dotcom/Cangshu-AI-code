'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { connect } = require('./admin-client.cjs');
async function main() {
  const request = await connect();
  const installed = await request('/api/plugin/task');
  for (const key of ['pikno-sanbao', 'pikno-canseedream']) {
    const source = fs.readFileSync(path.join(__dirname, 'plugins/generated', key + '.js'), 'utf8');
    const hash = crypto.createHash('sha256').update(source).digest('hex');
    const existing = installed.find(row => row.meta.key === key);
    if (existing) {
      if (existing.source_hash === hash) { console.log(key + ' unchanged'); continue; }
      if (!process.argv.includes('--replace-staged') || existing.enabled || existing.channel_count || existing.in_flight_count) throw new Error(key + ' differs; --replace-staged only replaces disabled, unused plugins after review');
    }
    // Stage without enabling routes until credentials, live tests and pricing are ready.
    await request('/api/plugin/task', 'POST', { source, sourceSha256: hash, enabled: false, remark: 'PIKNO pilot: pending credentials, real-call acceptance and retail pricing' });
    console.log(key + ' compiled and installed, disabled pending acceptance');
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
