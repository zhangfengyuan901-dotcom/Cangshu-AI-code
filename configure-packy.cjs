'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { connect } = require('./admin-client.cjs');
const NAME = 'PIKNO PackyAPI 图片';
async function main() {
  const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'private/packy.json'), 'utf8'));
  if (cfg.baseUrl !== 'https://cf.api.fan' || cfg.model !== 'gpt-image-2.5-flare' || !/^sk-[A-Za-z0-9_-]+$/.test(cfg.apiKey)) throw new Error('Invalid Packy configuration');
  const response = await fetch(cfg.baseUrl + '/v1/models', { headers: { Authorization: 'Bearer ' + cfg.apiKey }, redirect: 'error', signal: AbortSignal.timeout(25000) });
  const catalog = await response.json();
  if (!response.ok || !Array.isArray(catalog.data) || !catalog.data.some(item => item.id === cfg.model)) throw new Error('Packy authentication/model preflight failed');
  const request = await connect();
  const list = await request('/api/channel/?p=1&page_size=100');
  if (list.total > list.items.length) throw new Error('Channel list needs pagination; do not create a possible duplicate');
  const existing = list.items.find(item => item.name === NAME);
  if (existing) {
    if (existing.base_url !== cfg.baseUrl || existing.models !== cfg.model || existing.type !== 1) throw new Error('Existing Packy channel differs; inspect before modifying');
    console.log(JSON.stringify({ id: existing.id, name: NAME, status: existing.status, unchanged: true }));
    return;
  }
  await request('/api/channel/', 'POST', { mode: 'single', channel: {
    type: 1, name: NAME, key: cfg.apiKey, base_url: cfg.baseUrl,
    models: cfg.model, test_model: cfg.model, group: 'default', status: 2,
    priority: 0, weight: 1, auto_ban: 0,
    remark: 'PIKNO existing Packy image line; staged pending price and paid generation/edit acceptance',
  } });
  const saved = await request('/api/channel/?p=1&page_size=100');
  const row = saved.items.find(item => item.name === NAME);
  if (!row || row.status !== 2 || row.models !== cfg.model || row.base_url !== cfg.baseUrl) throw new Error('Saved channel verification failed');
  console.log(JSON.stringify({ id: row.id, name: NAME, status: 'disabled_pending_acceptance', model: row.models, keyConfigured: true }));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
