'use strict';

// Paid, one-shot acceptance for the two PIKNO video task plugins.
// The journal is deliberately durable: after an uncertain submission this
// script refuses to submit that provider again.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const BASE = process.env.NEW_API_BASE || 'http://127.0.0.1:3100';
const PUBLIC_BASE = 'https://www.piknoai.com';
const REQUEST_BASE = process.env.PIKNO_RELAY_BASE || PUBLIC_BASE;
const PRIVATE = path.join(__dirname, 'private');
const SESSION_FILE = path.join(PRIVATE, 'admin-session.json');
const UPSTREAM_FILE = path.join(PRIVATE, 'upstreams.json');
const CATALOG_FILE = path.join(__dirname, 'plugins/generated/catalog.json');
const RUN_ID = process.env.PIKNO_ACCEPTANCE_RUN_ID || 'video-acceptance';
if (!/^[a-z0-9-]{1,50}$/.test(RUN_ID)) throw new Error('Invalid acceptance run id');
const RUN_DIR = path.join(PRIVATE, RUN_ID);
const JOURNAL_FILE = path.join(RUN_DIR, 'result.json');
const TOKEN_NAME = 'video-upstream-acceptance-once';
const TEMP_EXPR = 'tier("internal_acceptance", u("seconds") * 0.01)';
const POLL_INTERVAL_MS = 10_000;
const POLL_TIMEOUT_MS = 20 * 60_000;

const ALL_CASES = [
  {
    provider: 'sanbao', pluginKey: 'pikno-sanbao', channelName: 'PIKNO 三宝视频',
    baseUrl: 'https://sanbaobeauty.com', model: 'sanbao/sd2_480p_real',
    request: { prompt: 'A calm ocean horizon at sunrise, gentle waves, locked camera, no text, no logos.', duration: 4, resolution: '480p', ratio: '16:9' },
  },
  {
    provider: 'canseedream', pluginKey: 'pikno-canseedream', channelName: 'PIKNO CanSeeDream 视频',
    baseUrl: 'https://see.ximeiedu.org', model: 'canseedream/video/ningmeng_c_pool',
    request: { prompt: 'A calm ocean horizon at sunrise, gentle waves, locked camera, no text, no logos.', duration: 4, resolution: '480p', aspect_ratio: '16:9' },
  },
];
const requestedProviders = new Set(String(process.env.PIKNO_ACCEPTANCE_PROVIDERS || 'sanbao,canseedream').split(',').map(value => value.trim()).filter(Boolean));
const CASES = ALL_CASES.filter(item => requestedProviders.has(item.provider));
if (!CASES.length || requestedProviders.size !== CASES.length) throw new Error('Invalid acceptance provider selection');

function readJSON(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function safeMessage(error) {
  return String(error && error.message || error).slice(0, 800);
}

async function main() {
  fs.mkdirSync(RUN_DIR, { recursive: true });
  if (fs.existsSync(JOURNAL_FILE)) {
    const previous = readJSON(JOURNAL_FILE);
    if ((previous.attempts || []).some(item => item.submissionStartedAt)) {
      throw new Error('A paid acceptance journal already contains a submission; refusing to rerun.');
    }
  }

  const sessionFromEnvironment = process.env.PIKNO_ADMIN_ACCESS_TOKEN && process.env.PIKNO_ADMIN_USER_ID
    ? { accessToken: process.env.PIKNO_ADMIN_ACCESS_TOKEN, userId: process.env.PIKNO_ADMIN_USER_ID }
    : null;
  const session = sessionFromEnvironment || readJSON(SESSION_FILE);
  const upstreams = readJSON(UPSTREAM_FILE);
  const catalog = readJSON(CATALOG_FILE);
  if (!session.accessToken || !session.userId) throw new Error('Temporary admin session is missing or invalid');
  if (!upstreams.sanbao?.apiKey || !upstreams.canseedream?.videoApiKey) throw new Error('Video upstream credentials are incomplete');

  const journal = {
    startedAt: new Date().toISOString(),
    authorization: 'User requested the next phase and previously authorized direct generation without a price cap',
    publicBase: PUBLIC_BASE, requestBase: REQUEST_BASE,
    policy: { outputsPerTask: 1, retries: 0, callsPerProvider: 1, durationSeconds: 4, resolution: '480p' },
    attempts: [], cleanup: {},
  };
  const save = () => fs.writeFileSync(JOURNAL_FILE, JSON.stringify(journal, null, 2));
  save();

  const adminHeaders = {
    'Content-Type': 'application/json',
    Authorization: 'Bearer ' + session.accessToken,
    'New-Api-User': String(session.userId),
  };
  async function admin(route, method = 'GET', payload) {
    const response = await fetch(BASE + route, {
      method, headers: adminHeaders,
      body: payload === undefined ? undefined : JSON.stringify(payload),
      signal: AbortSignal.timeout(45_000),
    });
    const body = await response.json();
    if (!response.ok || !body.success) throw new Error(route + ': ' + (body.message || 'HTTP ' + response.status));
    return body.data;
  }

  let tokenId = null;
  let tokenKey = null;
  let originalPluginExpr = null;
  let temporaryExprJSON = null;
  let pricingApplied = false;
  const channels = new Map();
  try {
    const options = await admin('/api/option/');
    if (options.find(item => item.key === 'RetryTimes')?.value !== '0') throw new Error('RetryTimes must remain 0');
    const exprOption = options.find(item => item.key === 'billing_setting.plugin_billing_expr');
    originalPluginExpr = exprOption?.value || '{}';
    const pluginExpr = JSON.parse(originalPluginExpr);
    for (const test of CASES) pluginExpr[test.pluginKey + '::' + test.model] = TEMP_EXPR;
    temporaryExprJSON = JSON.stringify(pluginExpr);

    const installed = await admin('/api/plugin/task');
    for (const test of CASES) {
      const source = fs.readFileSync(path.join(__dirname, 'plugins/generated', test.pluginKey + '.js'), 'utf8');
      const hash = crypto.createHash('sha256').update(source).digest('hex');
      const current = installed.find(row => row.meta?.key === test.pluginKey);
      if (!current || current.meta.version !== '0.2.3' || current.source_hash !== hash) {
        await admin('/api/plugin/task', 'POST', {
          source, sourceSha256: hash, enabled: false,
          remark: 'PIKNO reviewed video-only adapter; customer exposure disabled pending pricing',
        });
      }
      await admin('/api/plugin/task/' + encodeURIComponent(test.pluginKey) + '/activate', 'POST', { version: '0.2.3' });
      console.log(JSON.stringify({ provider: test.provider, phase: 'plugin_activated', version: '0.2.3' }));
    }

    const channelPage = await admin('/api/channel/?p=1&page_size=100');
    const existingChannels = channelPage.items || [];
    for (const test of CASES) {
      const spec = catalog.specs.find(item => item.key === test.pluginKey);
      if (!spec) throw new Error('Catalog entry missing for ' + test.pluginKey);
      let channel = existingChannels.find(item => item.name === test.channelName);
      const desired = {
        name: test.channelName, type: 61,
        base_url: test.baseUrl, models: Object.keys(spec.models).join(','), group: 'default',
        priority: 0, weight: 1, test_model: test.model, auto_ban: 0,
        setting: JSON.stringify({ task_plugin_key: test.pluginKey }), settings: '{}',
        other: '', remark: 'Internal acceptance only; keep disabled until retail pricing is approved',
      };
      if (!channel) {
        const key = test.provider === 'sanbao' ? upstreams.sanbao.apiKey : upstreams.canseedream.videoApiKey;
        await admin('/api/channel/', 'POST', {
          mode: 'single', channel: { ...desired, key, status: 2 },
        });
        const refreshed = await admin('/api/channel/?p=1&page_size=100');
        channel = (refreshed.items || []).find(item => item.name === test.channelName);
      } else {
        await admin('/api/channel/', 'PUT', { ...desired, id: channel.id });
        channel = { ...channel, ...desired };
      }
      if (!channel || channel.type !== 61 || channel.base_url !== test.baseUrl) throw new Error('Unexpected channel state for ' + test.provider);
      await admin('/api/channel/' + channel.id + '/status', 'POST', { status: 2 });
      channels.set(test.provider, channel);
      console.log(JSON.stringify({ provider: test.provider, phase: 'channel_staged', channelId: channel.id }));
    }

    await admin('/api/option/', 'PUT', { key: 'billing_setting.plugin_billing_expr', value: temporaryExprJSON });
    pricingApplied = true;
    await admin('/api/token/', 'POST', {
      name: TOKEN_NAME, expired_time: Math.floor(Date.now() / 1000) + 3600,
      remain_quota: 10_000_000, unlimited_quota: false,
      model_limits_enabled: true, model_limits: CASES.map(item => item.model).join(','),
      allow_ips: '', group: 'default', auto_groups: [], cross_group_retry: false,
    });
    const tokenPage = await admin('/api/token/?p=1&page_size=100');
    const matches = (tokenPage.items || []).filter(item => item.name === TOKEN_NAME);
    if (matches.length !== 1) throw new Error('Temporary token lookup is ambiguous');
    tokenId = matches[0].id;
    tokenKey = (await admin('/api/token/' + tokenId + '/key', 'POST')).key;
    if (!tokenKey.startsWith('sk-')) tokenKey = 'sk-' + tokenKey;
    journal.tokenId = tokenId;
    save();

    for (const test of CASES) {
      const channel = channels.get(test.provider);
      const attempt = {
        provider: test.provider, model: test.model, channelId: channel.id,
        request: test.request, status: 'prepared',
      };
      journal.attempts.push(attempt);
      save();
      await admin('/api/channel/' + channel.id + '/status', 'POST', { status: 1 });
      attempt.submissionStartedAt = new Date().toISOString();
      attempt.status = 'submitted_do_not_retry';
      save();
      console.log(JSON.stringify({ provider: test.provider, phase: 'submitting', model: test.model }));

      let response;
      try {
        response = await fetch(REQUEST_BASE + '/' + test.pluginKey + '/tasks', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tokenKey },
          body: JSON.stringify({ model: test.model, ...test.request }),
          redirect: 'error', signal: AbortSignal.timeout(90_000),
        });
      } catch (error) {
        attempt.status = 'submission_uncertain_no_retry';
        attempt.error = safeMessage(error);
        save();
        console.log(JSON.stringify({ provider: test.provider, phase: attempt.status }));
        continue;
      }
      const raw = await response.text();
      let submitted;
      try { submitted = JSON.parse(raw); } catch { submitted = null; }
      attempt.submitHttpStatus = response.status;
      attempt.requestId = response.headers.get('x-request-id');
      if (!response.ok || !submitted?.id) {
        attempt.status = 'submission_rejected_no_retry';
        attempt.error = (submitted?.error?.message || submitted?.message || raw).slice(0, 800);
        save();
        console.log(JSON.stringify({ provider: test.provider, phase: attempt.status, httpStatus: response.status }));
        continue;
      }
      attempt.taskId = submitted.id;
      attempt.status = submitted.status || 'QUEUED';
      save();
      console.log(JSON.stringify({ provider: test.provider, phase: 'accepted', taskId: attempt.taskId, status: attempt.status }));

      const deadline = Date.now() + POLL_TIMEOUT_MS;
      let lastStatus = '';
      while (Date.now() < deadline) {
        await sleep(POLL_INTERVAL_MS);
        const poll = await fetch(REQUEST_BASE + '/' + test.pluginKey + '/tasks/' + encodeURIComponent(attempt.taskId), {
          headers: { Authorization: 'Bearer ' + tokenKey }, redirect: 'error', signal: AbortSignal.timeout(45_000),
        });
        const body = await poll.json();
        if (!poll.ok) throw new Error(test.provider + ' poll HTTP ' + poll.status + ': ' + (body.message || 'unknown error'));
        attempt.status = body.status || 'UNKNOWN';
        attempt.progress = body.progress || null;
        if (attempt.status !== lastStatus) {
          console.log(JSON.stringify({ provider: test.provider, phase: 'poll', status: attempt.status, progress: attempt.progress }));
          lastStatus = attempt.status;
        }
        save();
        if (attempt.status === 'SUCCESS') {
          const video = (body.outputs || []).find(item => item.type === 'video' && /^https:\/\//.test(item.url || ''));
          if (!video) throw new Error(test.provider + ' completed without a valid HTTPS video URL');
          attempt.outputUrl = video.url;
          attempt.finishedAt = new Date().toISOString();
          attempt.status = 'passed';
          save();
          console.log(JSON.stringify({ provider: test.provider, phase: 'passed', taskId: attempt.taskId }));
          break;
        }
        if (attempt.status === 'FAILURE') {
          attempt.error = String(body.error || 'upstream task failed').slice(0, 800);
          attempt.finishedAt = new Date().toISOString();
          attempt.status = 'failed_no_retry';
          save();
          console.log(JSON.stringify({ provider: test.provider, phase: attempt.status, taskId: attempt.taskId }));
          break;
        }
      }
      if (!['passed', 'failed_no_retry'].includes(attempt.status)) {
        attempt.status = 'poll_timeout_no_retry';
        attempt.finishedAt = new Date().toISOString();
        save();
        console.log(JSON.stringify({ provider: test.provider, phase: attempt.status, taskId: attempt.taskId }));
      }
      await admin('/api/channel/' + channel.id + '/status', 'POST', { status: 2 });
    }
    journal.status = journal.attempts.every(item => item.status === 'passed') ? 'all_passed' : 'completed_with_failures';
  } catch (error) {
    journal.status = 'stopped_no_retry';
    journal.error = safeMessage(error);
    throw error;
  } finally {
    for (const test of CASES) {
      const channel = channels.get(test.provider);
      if (!channel) continue;
      try { await admin('/api/channel/' + channel.id + '/status', 'POST', { status: 2 }); journal.cleanup[test.provider + 'ChannelDisabled'] = true; }
      catch { journal.cleanup[test.provider + 'ChannelDisabled'] = false; }
    }
    if (tokenId) {
      try { await admin('/api/token/' + tokenId, 'DELETE'); journal.cleanup.temporaryTokenRevoked = true; }
      catch { journal.cleanup.temporaryTokenRevoked = false; }
    }
    if (pricingApplied && originalPluginExpr !== null && temporaryExprJSON !== null) {
      try {
        const latest = await admin('/api/option/');
        const current = JSON.parse(latest.find(item => item.key === 'billing_setting.plugin_billing_expr')?.value || '{}');
        const original = JSON.parse(originalPluginExpr);
        for (const test of CASES) {
          const key = test.pluginKey + '::' + test.model;
          if (current[key] !== TEMP_EXPR) throw new Error('Concurrent pricing change detected for ' + key);
          if (Object.prototype.hasOwnProperty.call(original, key)) current[key] = original[key];
          else delete current[key];
        }
        await admin('/api/option/', 'PUT', { key: 'billing_setting.plugin_billing_expr', value: JSON.stringify(current) });
        journal.cleanup.temporaryPricingRestored = true;
      } catch { journal.cleanup.temporaryPricingRestored = false; }
    } else {
      journal.cleanup.temporaryPricingRestored = true;
    }
    for (const test of CASES) {
      try {
        await admin('/api/plugin/task/' + encodeURIComponent(test.pluginKey) + '/status', 'POST', { enabled: false });
        journal.cleanup[test.provider + 'PluginDisabled'] = true;
      } catch { journal.cleanup[test.provider + 'PluginDisabled'] = false; }
    }
    journal.finishedAt = new Date().toISOString();
    save();
    if (!sessionFromEnvironment) {
      try { fs.rmSync(SESSION_FILE); journal.cleanup.temporaryAdminSessionRemoved = true; save(); }
      catch { journal.cleanup.temporaryAdminSessionRemoved = false; save(); }
    }
    console.log(JSON.stringify({ status: journal.status, cleanup: journal.cleanup }));
  }
}

main().catch(error => {
  console.error(safeMessage(error));
  process.exitCode = 1;
});
