'use strict';
const fs = require('node:fs');
const path = require('node:path');
const base = 'https://sanbaobeauty.com';
const file = path.join(__dirname, 'private/release-probe-20261008/sanbao.json');
const key = JSON.parse(fs.readFileSync(path.join(__dirname, 'private/sanbao-release-key.json'))).apiKey;
const headers = { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' };
async function get(route) {
  const r = await fetch(base + route, { headers, redirect: 'error', signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}
const save = d => fs.writeFileSync(file, JSON.stringify(d, null, 2));
async function main() {
  let d;
  if (process.argv.includes('--submit')) {
    if (fs.existsSync(file)) throw new Error('Existing journal; do not resubmit.');
    const catalog = await get('/openapi/v1/models');
    const model = catalog.data.find(x => x.id === 'sd2_480p_real');
    if (!model || model.price_credits !== 30 || model.billing !== 'per_generation') throw new Error('Model or price changed');
    const me = await get('/openapi/v1/me');
    if (me.user.credits < 30) throw new Error('Insufficient balance');
    d = { startedAt: new Date().toISOString(), model: model.id, creditsBefore: me.user.credits, expectedCredits: 30, status: 'submission_started_do_not_retry' };
    save(d);
    const r = await fetch(base + '/openapi/v1/videos', { method: 'POST', headers, redirect: 'error', signal: AbortSignal.timeout(90000), body: JSON.stringify({ model: model.id, prompt: 'A calm ocean horizon at sunrise, gentle waves, fixed camera, natural lighting, no people, no text or logos.', duration: 4, resolution: '480p', ratio: '16:9', concurrency: 1 }) });
    d.httpStatus = r.status;
    d.response = await r.json();
    d.taskId = d.response.data?.id || d.response.id || d.response.tasks?.[0]?.id || d.response.data?.tasks?.[0]?.id;
    d.status = d.taskId ? 'accepted' : 'no_task_id_do_not_retry';
    save(d);
  } else {
    d = JSON.parse(fs.readFileSync(file));
    if (!d.taskId) throw new Error('No task ID; inspect journal, do not resubmit.');
    d.poll = await get('/openapi/v1/videos/' + encodeURIComponent(d.taskId));
    const task = d.poll.data || d.poll;
    d.status = task.status;
    d.checkedAt = new Date().toISOString();
    if (['succeeded', 'failed'].includes(d.status)) {
      d.creditsAfter = (await get('/openapi/v1/me')).user.credits;
      d.balanceDelta = Number((d.creditsBefore - d.creditsAfter).toFixed(6));
      d.taskCost = task.cost;
      if (d.status === 'succeeded' && task.video_url) {
        const r = await fetch(task.video_url, { method: 'HEAD', signal: AbortSignal.timeout(20000) });
        d.media = { http: r.status, type: r.headers.get('content-type'), bytes: r.headers.get('content-length') };
      }
    }
    save(d);
  }
  console.log(JSON.stringify({ model: d.model, taskId: d.taskId, status: d.status, creditsBefore: d.creditsBefore, creditsAfter: d.creditsAfter, balanceDelta: d.balanceDelta, taskCost: d.taskCost, media: d.media, error: d.poll?.data?.error || d.response?.error }));
}
main().catch(e => { console.error(e.message); process.exitCode = 1; });
