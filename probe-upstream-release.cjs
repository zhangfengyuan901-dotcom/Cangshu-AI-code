'use strict';
// One paid CanSeeDream request; a durable journal prevents uncertain resubmission.
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, 'private', 'release-probe-20261008');
const file = path.join(root, 'canseedream.json');
const base = 'https://see.ximeiedu.org';
const key = JSON.parse(fs.readFileSync(path.join(__dirname, 'private/upstreams.json'))).canseedream.videoApiKey;
const headers = { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' };
const save = d => fs.writeFileSync(file, JSON.stringify(d, null, 2));
async function main() {
  fs.mkdirSync(root, { recursive: true });
  let d;
  if (process.argv.includes('--submit')) {
    if (fs.existsSync(file)) throw new Error('Journal exists: never resubmit; use polling.');
    const health = await (await fetch(base + '/health')).json();
    const route = health.defaults.videoProviders.find(x => x.id === 'ningmeng_c_pool');
    if (!route || !route.allowedResolutions.includes('480p') || !route.allowedDurations.includes(4)) throw new Error('Route changed');
    d = { startedAt: new Date().toISOString(), provider: 'canseedream', model: 'ningmeng_c_pool', expectedPoints: route.resolutionPointsPerSecond?.['480p'] * 4, status: 'submission_started_no_retry' };
    if (d.expectedPoints !== 76) throw new Error('Quote changed');
    save(d);
    const r = await fetch(base + '/api/v3/contents/generations/tasks', {
      method: 'POST', headers: { ...headers, 'Idempotency-Key': 'pikno-release-probe-20261008-csd-01' },
      body: JSON.stringify({ model: 'video', provider_route: 'ningmeng_c_pool', prompt: 'A calm ocean horizon at sunrise, gentle waves, fixed camera, natural light, no people, no text or logos.', duration: 4, resolution: '480p', aspect_ratio: '16:9', number_of_runs: 1, enhance: false }),
      redirect: 'error', signal: AbortSignal.timeout(90000),
    });
    d.httpStatus = r.status;
    d.response = await r.json();
    d.taskId = d.response.id || d.response.tasks?.[0]?.id || d.response.data?.id;
    d.status = d.taskId ? 'accepted' : 'rejected_no_retry';
    save(d);
  } else {
    d = JSON.parse(fs.readFileSync(file));
    if (!d.taskId) throw new Error('No task ID: inspect journal, do not retry submission.');
    const r = await fetch(base + '/api/v3/contents/generations/tasks/' + encodeURIComponent(d.taskId), { headers, redirect: 'error', signal: AbortSignal.timeout(30000) });
    d.pollHttpStatus = r.status;
    d.poll = await r.json();
    d.status = d.poll.status || d.poll.data?.status || 'unknown';
    d.checkedAt = new Date().toISOString();
    save(d);
  }
  console.log(JSON.stringify({ provider: d.provider, httpStatus: d.httpStatus, pollHttpStatus: d.pollHttpStatus, taskId: d.taskId, status: d.status, expectedPoints: d.expectedPoints, error: d.poll?.error || d.response?.error, hasVideo: Boolean(d.poll?.content?.video_url) }));
}
main().catch(e => { console.error(e.message); process.exitCode = 1; });
