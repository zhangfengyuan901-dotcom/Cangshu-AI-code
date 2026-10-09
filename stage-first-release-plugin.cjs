'use strict';

// Registers only the approved Sanbao task adapter. Customer channels stay disabled.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { connect } = require('./admin-client.cjs');

const KEY = 'pikno-sanbao';
const VERSION = '0.2.3';
const MODEL = 'sanbao/sd2_480p_real';
const SOURCE_FILE = path.join(__dirname, 'plugins/generated', KEY + '.js');
const JOURNAL_FILE = path.join(__dirname, 'private', 'pricing-rollout', 'plugin-stage-result.json');

async function main() {
  if (fs.existsSync(JOURNAL_FILE)) throw new Error('Plugin stage journal already exists; inspect it before another run');
  fs.mkdirSync(path.dirname(JOURNAL_FILE), { recursive: true });
  const source = fs.readFileSync(SOURCE_FILE, 'utf8');
  const sourceSha256 = crypto.createHash('sha256').update(source).digest('hex');
  const journal = { startedAt: new Date().toISOString(), key: KEY, version: VERSION, sourceSha256, status: 'started' };
  const save = () => fs.writeFileSync(JOURNAL_FILE, JSON.stringify(journal, null, 2));
  save();

  const request = await connect();
  const before = await request('/api/plugin/task');
  const current = before.find(row => row.meta?.key === KEY);
  journal.before = current ? { version: current.meta?.version, enabled: current.enabled, sourceSha256: current.source_hash } : null;
  const canSeeDream = before.find(row => row.meta?.key === 'pikno-canseedream');
  if (!canSeeDream || canSeeDream.enabled !== false) throw new Error('CanSeeDream must remain installed and disabled');

  try {
    if (!current || current.meta?.version !== VERSION || current.source_hash !== sourceSha256) {
      if (current && (current.enabled || current.channel_count || current.in_flight_count)) {
        throw new Error('Refusing to replace an active or in-use Sanbao plugin');
      }
      await request('/api/plugin/task', 'POST', {
        source,
        sourceSha256,
        enabled: false,
        remark: 'PIKNO first release: approved Sanbao 480P adapter; customer channel remains disabled pending billing acceptance',
      });
      journal.installed = true;
      save();
    }
    await request('/api/plugin/task/' + encodeURIComponent(KEY) + '/activate', 'POST', { version: VERSION });
    journal.activated = true;
    save();
    await request('/api/plugin/task/' + encodeURIComponent(KEY) + '/status', 'POST', { enabled: true });
    journal.enabled = true;
    save();

    const after = await request('/api/plugin/task');
    const verified = after.find(row => row.meta?.key === KEY);
    const verifiedCanSeeDream = after.find(row => row.meta?.key === 'pikno-canseedream');
    if (!verified || verified.meta?.version !== VERSION || verified.source_hash !== sourceSha256 || verified.enabled !== true) {
      throw new Error('Sanbao plugin verification failed');
    }
    if (!Array.isArray(verified.meta?.models) || !verified.meta.models.includes(MODEL)) {
      throw new Error('Sanbao plugin does not declare the approved model');
    }
    if (!verifiedCanSeeDream || verifiedCanSeeDream.enabled !== false) throw new Error('CanSeeDream changed unexpectedly');

    const channels = (await request('/api/channel/?p=1&page_size=100')).items || [];
    for (const name of ['PIKNO PackyAPI 图片', 'PIKNO 三宝视频', 'PIKNO CanSeeDream 视频']) {
      const channel = channels.find(item => item.name === name);
      if (channel && channel.status !== 2) throw new Error('Customer channel is not disabled: ' + name);
    }
    journal.status = 'registered_routes_only_channels_disabled';
    journal.completedAt = new Date().toISOString();
    save();
    console.log(JSON.stringify({ status: journal.status, key: KEY, version: VERSION, channelsEnabled: false }));
  } catch (error) {
    journal.error = String(error.message || error).slice(0, 500);
    try {
      await request('/api/plugin/task/' + encodeURIComponent(KEY) + '/status', 'POST', { enabled: false });
      journal.rollback = 'plugin_disabled';
    } catch (rollbackError) {
      journal.rollback = 'failed: ' + String(rollbackError.message || rollbackError).slice(0, 300);
    }
    save();
    throw error;
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
