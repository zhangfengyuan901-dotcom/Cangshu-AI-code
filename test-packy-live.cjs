'use strict';
// Explicitly authorized paid acceptance: at most one generation and one edit.
// A durable journal prevents reruns after an uncertain network result.
const fs = require('node:fs');
const path = require('node:path');
const { connect } = require('./admin-client.cjs');
const MODEL = 'gpt-image-2.5-flare';
const BASE = 'https://www.piknoai.com';
const DIR = path.join(__dirname, 'private/packy-acceptance');
const JOURNAL = path.join(DIR, 'result.json');
const TOKEN_NAME = 'packy-acceptance-once';

async function main() {
  fs.mkdirSync(DIR, { recursive: true });
  const fd = fs.openSync(JOURNAL, 'wx');
  fs.closeSync(fd);
  const state = { startedAt: new Date().toISOString(), model: MODEL, baseUrl: BASE,
    authorization: 'User removed previous CNY 2 cap; one generation plus one edit only',
    parameters: { n: 1, size: '1024x1024', quality: 'high', output_format: 'png' }, attempts: [] };
  const save = () => fs.writeFileSync(JOURNAL, JSON.stringify(state, null, 2));
  save();
  const request = await connect();
  const channels = await request('/api/channel/?p=1&page_size=100');
  const channel = channels.items.find(x => x.name === 'PIKNO PackyAPI 图片');
  if (!channel || channel.models !== MODEL || channel.base_url !== 'https://cf.api.fan' || channel.status !== 2) throw new Error('Unexpected channel state');
  const options = await request('/api/option/');
  if (options.find(x => x.key === 'RetryTimes')?.value !== '0') throw new Error('Automatic retries must be disabled');
  const prices = JSON.parse(options.find(x => x.key === 'ModelPrice').value);
  const originalPrice = prices[MODEL];
  state.channelId = channel.id;
  state.originalPrice = originalPrice ?? null;
  state.originalStatus = channel.status;
  save();
  let tokenId;
  let priceChanged = false;
  try {
    // Temporary INTERNAL test accounting only, not upstream cost or retail pricing.
    prices[MODEL] = 1;
    await request('/api/option/', 'PUT', { key: 'ModelPrice', value: JSON.stringify(prices) });
    priceChanged = true;
    await request('/api/token/', 'POST', { name: TOKEN_NAME,
      expired_time: Math.floor(Date.now() / 1000) + 3600, remain_quota: 2000000,
      unlimited_quota: false, model_limits_enabled: true, model_limits: MODEL,
      group: 'default', cross_group_retry: false });
    const tokens = await request('/api/token/?p=1&page_size=100');
    const matching = tokens.items.filter(t => t.name === TOKEN_NAME);
    if (matching.length !== 1) throw new Error('Ambiguous temporary token');
    tokenId = matching[0].id;
    state.tokenId = tokenId;
    save();
    const { key } = await request('/api/token/' + tokenId + '/key', 'POST');
    const auth = 'Bearer ' + (key.startsWith('sk-') ? key : 'sk-' + key);
    await request('/api/channel/' + channel.id + '/status', 'POST', { status: 1 });
    const catalog = await fetch(BASE + '/v1/models', { headers: { Authorization: auth }, redirect: 'error', signal: AbortSignal.timeout(25000) });
    const models = await catalog.json();
    if (!catalog.ok || !models.data?.some(x => x.id === MODEL)) throw new Error('Public relay model preflight failed');
    state.publicPreflight = 'passed';
    save();

    async function run(kind, body, contentType) {
      const attempt = { kind, startedAt: new Date().toISOString(), status: 'submitted_do_not_retry' };
      state.attempts.push(attempt);
      save();
      console.log(JSON.stringify({ kind, status: 'submitted', via: BASE }));
      const started = Date.now();
      const response = await fetch(BASE + '/v1/images/' + (kind === 'generation' ? 'generations' : 'edits'), {
        method: 'POST', headers: { Authorization: auth, ...(contentType ? { 'Content-Type': contentType } : {}) },
        body, redirect: 'error', signal: AbortSignal.timeout(600000),
      });
      attempt.httpStatus = response.status;
      attempt.requestId = response.headers.get('x-request-id');
      const raw = await response.text();
      fs.writeFileSync(path.join(DIR, kind + '-response.json'), raw);
      attempt.seconds = Math.round((Date.now() - started) / 1000);
      save();
      if (!response.ok) throw new Error(kind + ': HTTP ' + response.status + '; private response saved; do not retry');
      const result = JSON.parse(raw);
      if (!Array.isArray(result.data) || result.data.length !== 1) throw new Error(kind + ': unexpected image count');
      const item = result.data[0];
      let bytes;
      if (item.b64_json) bytes = Buffer.from(item.b64_json, 'base64');
      else if (item.url) {
        const url = new URL(item.url);
        if (url.protocol !== 'https:') throw new Error('Result must use HTTPS');
        // Fetch the returned generated artifact without sending any API credentials.
        const media = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(60000) });
        if (!media.ok || !media.headers.get('content-type')?.startsWith('image/')) throw new Error('Image download validation failed');
        bytes = Buffer.from(await media.arrayBuffer());
      } else throw new Error(kind + ': no image result');
      if (bytes.length < 100 || bytes.length > 30 * 1024 * 1024) throw new Error('Unexpected image byte count');
      const png = bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
      const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
      if (!png && !jpeg) throw new Error('Unknown image format');
      const output = path.join(DIR, kind + (png ? '.png' : '.jpg'));
      fs.writeFileSync(output, bytes);
      Object.assign(attempt, { status: 'passed', bytes: bytes.length, file: output, finishedAt: new Date().toISOString() });
      save();
      console.log(JSON.stringify(attempt));
      return { bytes, mime: png ? 'image/png' : 'image/jpeg', filename: path.basename(output) };
    }

    const first = await run('generation', JSON.stringify({ model: MODEL, ...state.parameters,
      prompt: 'Product photograph of one cobalt blue ceramic mug with a curved handle on a pale beige tabletop. Soft daylight, plain warm grey background, square composition, no text, no logos.' }), 'application/json');
    const edit = new FormData();
    for (const [key, value] of Object.entries({ model: MODEL, ...state.parameters,
      prompt: 'Keep the same mug shape, handle, camera angle, lighting and background. Change only the ceramic mug color from cobalt blue to bright orange. No text, no logos.' })) edit.append(key, String(value));
    edit.append('image', new Blob([first.bytes], { type: first.mime }), first.filename);
    await run('edit', edit);
    state.status = 'both_api_calls_passed';
  } catch (error) {
    state.status = 'stopped_no_retry';
    state.error = error.message;
    throw error;
  } finally {
    state.cleanup = {};
    try { await request('/api/channel/' + channel.id + '/status', 'POST', { status: channel.status }); state.cleanup.channelRestored = true; }
    catch { state.cleanup.channelRestored = false; }
    if (tokenId) {
      try { await request('/api/token/' + tokenId, 'DELETE'); state.cleanup.temporaryTokenRevoked = true; }
      catch { state.cleanup.temporaryTokenRevoked = false; }
    }
    if (priceChanged) {
      try {
        const latest = JSON.parse((await request('/api/option/')).find(x => x.key === 'ModelPrice').value);
        if (latest[MODEL] !== 1) throw new Error('Concurrent price change; manual review needed');
        if (originalPrice === undefined) delete latest[MODEL]; else latest[MODEL] = originalPrice;
        await request('/api/option/', 'PUT', { key: 'ModelPrice', value: JSON.stringify(latest) });
        state.cleanup.priceRestored = true;
      } catch { state.cleanup.priceRestored = false; }
    }
    state.finishedAt = new Date().toISOString();
    save();
    console.log(JSON.stringify({ status: state.status, cleanup: state.cleanup }));
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
