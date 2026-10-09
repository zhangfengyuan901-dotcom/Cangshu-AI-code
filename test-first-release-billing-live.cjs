'use strict';

// Paid one-shot production billing acceptance for the approved first release.
// A durable journal prevents accidental resubmission after an uncertain result.
const fs = require('node:fs');
const path = require('node:path');

const ADMIN_BASE = process.env.NEW_API_BASE || 'http://127.0.0.1:3100';
const PUBLIC_BASE = 'https://www.piknoai.com';
const PRIVATE = path.join(__dirname, 'private');
const SESSION_FILE = path.join(PRIVATE, 'admin-session.json');
const RUN_DIR = path.join(PRIVATE, 'first-release-billing-acceptance');
const JOURNAL_FILE = path.join(RUN_DIR, 'result.json');
const IMAGE_MODEL = 'gpt-image-2.5-flare';
const VIDEO_MODEL = 'sanbao/sd2_480p_real';
const IMAGE_QUOTA = 100_000;
const VIDEO_QUOTA = 6_000_000;
const VIDEO_EXPR = 'tier("retail_cny_6", u("requests") * 0.821917808219178)';
const POLL_INTERVAL_MS = 10_000;
const POLL_TIMEOUT_MS = 20 * 60_000;

function readJSON(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function safeMessage(error) { return String(error?.message || error).slice(0, 800); }

async function main() {
  fs.mkdirSync(RUN_DIR, { recursive: true });
  if (fs.existsSync(JOURNAL_FILE)) throw new Error('Billing acceptance journal already exists; refusing to resubmit paid requests');
  const journal = {
    startedAt: new Date().toISOString(),
    authorization: 'User authorized direct generation and requested continuation of the first-release build',
    policy: { imageCalls: 1, videoCalls: 1, retries: 0, customerChannelsDefault: 'disabled' },
    attempts: [], cleanup: {},
  };
  const save = () => fs.writeFileSync(JOURNAL_FILE, JSON.stringify(journal, null, 2));
  save();

  async function admin(route, method = 'GET', payload) {
    const session = readJSON(SESSION_FILE);
    if (!session.accessToken || !session.userId) throw new Error('Short-lived administrator session is missing');
    const response = await fetch(ADMIN_BASE + route, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + session.accessToken,
        'New-Api-User': String(session.userId),
      },
      body: payload === undefined ? undefined : JSON.stringify(payload),
      signal: AbortSignal.timeout(45_000),
    });
    const body = await response.json();
    if (!response.ok || !body.success) throw new Error(route + ': ' + (body.message || 'HTTP ' + response.status));
    return body.data;
  }

  async function tokenRow(id) {
    const page = await admin('/api/token/?p=1&page_size=100');
    const row = (page.items || []).find(item => item.id === id);
    if (!row) throw new Error('Temporary token not found: ' + id);
    return row;
  }

  async function waitForQuota(id, before, expected) {
    let latest = before;
    for (let i = 0; i < 30; i += 1) {
      latest = Number((await tokenRow(id)).remain_quota);
      if (before - latest === expected) return latest;
      await sleep(1_000);
    }
    throw new Error('Quota delta mismatch: expected ' + expected + ', observed ' + (before - latest));
  }

  async function createToken(name, group, model, quota) {
    const before = await admin('/api/token/?p=1&page_size=100');
    if ((before.items || []).some(item => item.name === name)) throw new Error('Temporary token name already exists: ' + name);
    await admin('/api/token/', 'POST', {
      name, expired_time: Math.floor(Date.now() / 1000) + 3600,
      remain_quota: quota, unlimited_quota: false,
      model_limits_enabled: true, model_limits: model,
      allow_ips: '', group, auto_groups: [], cross_group_retry: false,
    });
    const after = await admin('/api/token/?p=1&page_size=100');
    const matches = (after.items || []).filter(item => item.name === name);
    if (matches.length !== 1) throw new Error('Temporary token lookup is ambiguous: ' + name);
    let key = (await admin('/api/token/' + matches[0].id + '/key', 'POST')).key;
    if (!key.startsWith('sk-')) key = 'sk-' + key;
    return { id: matches[0].id, key };
  }

  const tokens = [];
  const channels = new Map();
  try {
    const options = Object.fromEntries((await admin('/api/option/')).map(item => [item.key, item.value]));
    const prices = JSON.parse(options.ModelPrice || '{}');
    const expressions = JSON.parse(options['billing_setting.plugin_billing_expr'] || '{}');
    if (options.RegisterEnabled !== 'false' || options.PasswordRegisterEnabled !== 'false') throw new Error('Registration must remain closed');
    if (options.RetryTimes !== '0') throw new Error('Automatic retries must remain disabled');
    if (options.QuotaPerUnit !== '7300000' || options.USDExchangeRate !== '7.3' || options['general_setting.quota_display_type'] !== 'CNY') {
      throw new Error('Accounting basis differs from the approved draft');
    }
    if (Math.abs(Number(prices[IMAGE_MODEL]) - 0.013698630136986) > 1e-15) throw new Error('Image price differs from approved retail price');
    if (expressions['pikno-sanbao::' + VIDEO_MODEL] !== VIDEO_EXPR) throw new Error('Video price expression differs from approved retail price');

    const plugins = await admin('/api/plugin/task');
    const sanbaoPlugin = plugins.find(item => item.meta?.key === 'pikno-sanbao');
    const canSeeDreamPlugin = plugins.find(item => item.meta?.key === 'pikno-canseedream');
    if (!sanbaoPlugin?.enabled || canSeeDreamPlugin?.enabled !== false) throw new Error('Unexpected task plugin state');

    const page = await admin('/api/channel/?p=1&page_size=100');
    const packy = (page.items || []).find(item => item.name === 'PIKNO PackyAPI 图片');
    const sanbao = (page.items || []).find(item => item.name === 'PIKNO 三宝视频');
    const canSeeDream = (page.items || []).find(item => item.name === 'PIKNO CanSeeDream 视频');
    if (!packy || packy.status !== 2 || packy.group !== 'image-standard') throw new Error('Unexpected Packy channel state');
    if (!sanbao || sanbao.status !== 2 || sanbao.group !== 'video-standard') throw new Error('Unexpected Sanbao channel state');
    if (canSeeDream && canSeeDream.status !== 2) throw new Error('CanSeeDream channel must remain disabled');
    channels.set('image', packy);
    channels.set('video', sanbao);

    const imageToken = await createToken('pikno-first-release-image-once', 'image-standard', IMAGE_MODEL, 12_000_000);
    tokens.push(imageToken.id);
    const imageAttempt = { kind: 'image', model: IMAGE_MODEL, channelId: packy.id, status: 'prepared' };
    journal.attempts.push(imageAttempt); save();
    const imageBefore = Number((await tokenRow(imageToken.id)).remain_quota);
    await admin('/api/channel/' + packy.id + '/status', 'POST', { status: 1 });
    imageAttempt.submissionStartedAt = new Date().toISOString();
    imageAttempt.status = 'submitted_do_not_retry'; save();
    console.log(JSON.stringify({ kind: 'image', phase: 'submitted' }));
    let imageResponse;
    try {
      imageResponse = await fetch(PUBLIC_BASE + '/v1/images/generations', {
        method: 'POST', redirect: 'error',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + imageToken.key },
        body: JSON.stringify({
          model: IMAGE_MODEL, n: 1, size: '1024x1024', quality: 'high', output_format: 'png',
          prompt: 'Minimal product photo of one matte white geometric vase on a pale grey table, soft daylight, plain background, square composition, no text, no logo.',
        }),
        signal: AbortSignal.timeout(10 * 60_000),
      });
    } finally {
      await admin('/api/channel/' + packy.id + '/status', 'POST', { status: 2 });
    }
    const imageRaw = await imageResponse.text();
    fs.writeFileSync(path.join(RUN_DIR, 'image-response.json'), imageRaw);
    const imageBody = JSON.parse(imageRaw);
    if (!imageResponse.ok || !Array.isArray(imageBody.data) || imageBody.data.length !== 1) {
      throw new Error('Image acceptance failed with HTTP ' + imageResponse.status + '; private response saved; do not retry');
    }
    const imageItem = imageBody.data[0];
    if (!imageItem.url && !imageItem.b64_json) throw new Error('Image acceptance returned no media');
    const imageAfter = await waitForQuota(imageToken.id, imageBefore, IMAGE_QUOTA);
    Object.assign(imageAttempt, {
      status: 'passed', quotaBefore: imageBefore, quotaAfter: imageAfter,
      quotaDelta: imageBefore - imageAfter, finishedAt: new Date().toISOString(),
    });
    save();
    console.log(JSON.stringify({ kind: 'image', phase: 'passed', quotaDelta: imageAttempt.quotaDelta }));

    const videoToken = await createToken('pikno-first-release-video-once', 'video-standard', VIDEO_MODEL, 12_000_000);
    tokens.push(videoToken.id);
    const videoAttempt = { kind: 'video', model: VIDEO_MODEL, channelId: sanbao.id, status: 'prepared' };
    journal.attempts.push(videoAttempt); save();
    const videoBefore = Number((await tokenRow(videoToken.id)).remain_quota);
    await admin('/api/channel/' + sanbao.id + '/status', 'POST', { status: 1 });
    videoAttempt.submissionStartedAt = new Date().toISOString();
    videoAttempt.status = 'submitted_do_not_retry'; save();
    console.log(JSON.stringify({ kind: 'video', phase: 'submitted' }));
    const submit = await fetch(PUBLIC_BASE + '/pikno-sanbao/tasks', {
      method: 'POST', redirect: 'error',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + videoToken.key },
      body: JSON.stringify({
        model: VIDEO_MODEL, duration: 4, resolution: '480p', ratio: '16:9',
        prompt: 'A calm ocean horizon at sunrise, gentle waves, locked camera, no text, no logos.',
      }),
      signal: AbortSignal.timeout(90_000),
    });
    const submitRaw = await submit.text();
    let submitted;
    try { submitted = JSON.parse(submitRaw); } catch { submitted = null; }
    if (!submit.ok || !submitted?.id) throw new Error('Video submission failed with HTTP ' + submit.status + '; do not retry');
    videoAttempt.taskId = submitted.id;
    videoAttempt.status = submitted.status || 'QUEUED'; save();
    console.log(JSON.stringify({ kind: 'video', phase: 'accepted', status: videoAttempt.status }));

    const deadline = Date.now() + POLL_TIMEOUT_MS;
    let lastStatus = '';
    while (Date.now() < deadline) {
      await sleep(POLL_INTERVAL_MS);
      const poll = await fetch(PUBLIC_BASE + '/pikno-sanbao/tasks/' + encodeURIComponent(videoAttempt.taskId), {
        headers: { Authorization: 'Bearer ' + videoToken.key }, redirect: 'error', signal: AbortSignal.timeout(45_000),
      });
      const body = await poll.json();
      if (!poll.ok) throw new Error('Video poll failed with HTTP ' + poll.status);
      videoAttempt.status = body.status || 'UNKNOWN';
      videoAttempt.progress = body.progress || null;
      if (videoAttempt.status !== lastStatus) {
        console.log(JSON.stringify({ kind: 'video', phase: 'poll', status: videoAttempt.status, progress: videoAttempt.progress }));
        lastStatus = videoAttempt.status;
      }
      save();
      if (videoAttempt.status === 'SUCCESS') {
        const output = (body.outputs || []).find(item => item.type === 'video' && /^https:\/\//.test(item.url || ''));
        if (!output) throw new Error('Video completed without a valid HTTPS output');
        videoAttempt.status = 'passed';
        videoAttempt.outputValidated = true;
        break;
      }
      if (videoAttempt.status === 'FAILURE') throw new Error('Video task failed; do not retry');
    }
    if (videoAttempt.status !== 'passed') throw new Error('Video polling timed out; do not retry');
    await admin('/api/channel/' + sanbao.id + '/status', 'POST', { status: 2 });
    const videoAfter = await waitForQuota(videoToken.id, videoBefore, VIDEO_QUOTA);
    Object.assign(videoAttempt, {
      quotaBefore: videoBefore, quotaAfter: videoAfter, quotaDelta: videoBefore - videoAfter,
      finishedAt: new Date().toISOString(),
    });
    save();
    console.log(JSON.stringify({ kind: 'video', phase: 'passed', quotaDelta: videoAttempt.quotaDelta }));
    journal.status = 'passed';
  } catch (error) {
    journal.status = 'stopped_no_retry';
    journal.error = safeMessage(error);
    throw error;
  } finally {
    for (const channel of channels.values()) {
      try { await admin('/api/channel/' + channel.id + '/status', 'POST', { status: 2 }); journal.cleanup['channel' + channel.id + 'Disabled'] = true; }
      catch { journal.cleanup['channel' + channel.id + 'Disabled'] = false; }
    }
    for (const tokenId of tokens) {
      try { await admin('/api/token/' + tokenId, 'DELETE'); journal.cleanup['token' + tokenId + 'Revoked'] = true; }
      catch { journal.cleanup['token' + tokenId + 'Revoked'] = false; }
    }
    journal.finishedAt = new Date().toISOString();
    save();
    console.log(JSON.stringify({ status: journal.status, cleanup: journal.cleanup }));
  }
}

main().catch(error => { console.error(safeMessage(error)); process.exitCode = 1; });
