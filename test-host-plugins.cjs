'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { connect } = require('./admin-client.cjs');
// The host's dry-run API executes hooks only; no HTTP descriptors are dispatched.
async function main() {
  const request = await connect();
  const { specs } = JSON.parse(fs.readFileSync(path.join(__dirname, 'plugins/generated/catalog.json'), 'utf8'));
  let count = 0;
  for (const spec of specs) {
    const dryrun = (hook, args, member) => request('/api/plugin/task/' + spec.key + '/dryrun', 'POST', { hook, args, ...(member ? { member } : {}) });
    for (const kind of ['video']) {
      const [model, config] = Object.entries(spec.models).find(([, config]) => config.kind === kind && !config.minImages);
      const input = { model, prompt: 'A ceramic cup on a neutral background' };
      if (kind === 'video') { input.duration = config.durations[0]; input.resolution = config.resolutions[0]; }
      const ctx = { model, upstreamModel: model, requestBody: input, baseUrl: spec.baseUrl, publicTaskId: 'fixture-public', authHeader: 'Bearer fake-fixture-key' };
      const intent = await dryrun('native', [{ body: { kind: 'json', value: input } }], 'create');
      assert.equal(intent.model, model); count++;
      const built = await dryrun('buildSubmitRequest', [ctx]);
      assert.equal(built.url, spec.baseUrl + config.path); count++;
      const facts = await dryrun('extractUsage', [ctx]);
      assert.equal(facts.image_count, kind === 'image' ? 1 : 0); count++;
      const submit = await dryrun('parseSubmitResponse', [ctx, { statusCode: 200, body: { tasks: [{ id: 'upstream-fixture', status: 'queued' }] } }]);
      assert.equal(submit.taskId, 'upstream-fixture'); count++;
      const query = await dryrun('buildQueryRequest', [{ ...ctx, taskId: submit.taskId, state: submit.state }]);
      assert.equal(query.url, built.url + '/upstream-fixture'); count++;
      const result = { status: 'succeeded', content: { [kind + '_url']: 'https://example.com/fixture.' + (kind === 'image' ? 'png' : 'mp4') } };
      const polled = await dryrun('parseTaskResult', [ctx, { data: result }, { status: 200 }]);
      assert.equal(polled.status, 'SUCCESS'); count++;
      const rendered = await dryrun('native', [{}, { task_id: 'fixture-public', status: 'SUCCESS', data: { data: result } }], 'result');
      assert.equal(rendered.id, 'fixture-public'); assert.equal(rendered.outputs[0].type, kind); count++;
    }
    const unknown = await dryrun('parseTaskResult', [{}, { status: 'not-documented' }, { status: 200 }]);
    assert.equal(unknown.status, 'UNKNOWN'); count++;
  }
  console.log(count + ' New API runtime hook checks passed; no upstream generation calls were made.');
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
