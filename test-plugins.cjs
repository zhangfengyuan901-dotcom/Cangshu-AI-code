'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
async function main() {
  const catalog = JSON.parse(fs.readFileSync(path.join(__dirname, 'plugins/generated/catalog.json'), 'utf8'));
  let passed = 0;
  function test(name, fn) { fn(); passed++; console.log('PASS ' + name); }
  for (const spec of catalog.specs) {
    const source = fs.readFileSync(path.join(__dirname, 'plugins/generated', spec.key + '.js'), 'utf8');
    const plugin = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
    const context = (model, input) => ({ model, upstreamModel: model, publicTaskId: 'task_gateway_fixture', baseUrl: spec.baseUrl, apiKey: 'fake-fixture-key', authHeader: 'fake-fixture-key', requestBody: input });
    for (const [model, config] of Object.entries(spec.models)) {
      const input = { model, prompt: 'A simple ceramic cup in soft studio lighting' };
      if (config.kind === 'video') { input.duration = config.durations[0] || 5; input.resolution = config.resolutions[0]; }
      if (config.minImages) input.images = Array(config.minImages).fill('https://example.com/ref.png');
      const ctx = context(model, input);
      test(spec.key + ' constructs ' + model, () => {
        const req = plugin.buildSubmitRequest(ctx);
        assert.equal(req.url, spec.baseUrl + config.path);
        assert.equal(req.headers.Authorization, 'Bearer fake-fixture-key');
        assert.equal(req.method, 'POST');
        assert.equal(req.body.model, spec.provider === 'sanbao' || config.kind === 'image' ? config.upstreamModel : 'video');
        const facts = plugin.extractUsage(ctx);
        assert.equal(facts.requests, 1);
        assert.equal(facts.image_count, config.kind === 'image' ? 1 : 0);
        for (const [key, field] of Object.entries(plugin.meta.usageSchema)) if (field.enum) assert.ok(field.enum.includes(facts[key]), key);
        const intent = plugin.native.create({ body: { kind: 'json', value: input } });
        assert.equal(intent.model, model);
      });
    }
    test(spec.key + ' exposes no image models', () => assert.ok(Object.values(spec.models).every(config => config.kind === 'video')));
    test(spec.key + ' rejects former image models', () => assert.throws(() => plugin.buildSubmitRequest(context(spec.provider + '/gpt-image-2', { prompt: 'A cup' }))));
    const model = Object.keys(spec.models).find(key => !spec.models[key].minImages);
    const config = spec.models[model];
    const ctx = context(model, { model, prompt: 'A cup', duration: config.durations[0], resolution: config.resolutions[0] });
    const unified = { model, prompt: 'A cup', seconds: String(config.durations[0]), resolution: config.resolutions[0] };
    const decode = value => plugin.protocols.openai_video.decodeRequest({ model, upstreamModel: model, body: { kind: 'json', value } });
    test(spec.key + ' unified video preserves native routing and billing', () => {
      assert.ok(plugin.meta.protocols.includes('openai_video'));
      const intent = decode(unified);
      assert.equal(intent.model, model);
      assert.deepEqual(plugin.extractUsage({ ...ctx, requestBody: intent.requestBody }), plugin.extractUsage(ctx));
      assert.deepEqual(plugin.buildSubmitRequest({ ...ctx, requestBody: intent.requestBody }), plugin.buildSubmitRequest(ctx));
    });
    for (const seconds of [0, -1, 31, 1.5, '1e1', '4.0', null, true, 9007199254740991]) {
      test(spec.key + ' unified rejects invalid duration ' + seconds, () => assert.throws(() => decode({ ...unified, seconds })));
    }
    for (const field of ['duration', 'metadata', 'n', 'callback_url', 'provider_route', 'cost', 'size']) {
      test(spec.key + ' unified rejects override ' + field, () => assert.throws(() => decode({ ...unified, [field]: 1 })));
    }
    test(spec.key + ' unified rejects model mismatch and multipart', () => {
      assert.throws(() => decode({ ...unified, model: 'other' }));
      assert.throws(() => plugin.protocols.openai_video.decodeRequest({ model, body: { kind: 'multipart', fields: unified, files: [] } }));
    });
    test(spec.key + ' unified exposes no private result fields', () => {
      const result = plugin.protocols.openai_video.render({}, { task_id: 'public', status: 'SUCCESS', data: { id: 'private', api_key: 'secret', video_url: 'https://example.com/video.mp4' } });
      assert.deepEqual(result.outputs, [{ type: 'video', url: 'https://example.com/video.mp4' }]);
      assert.ok(!JSON.stringify(result).includes('private'));
      assert.ok(!JSON.stringify(result).includes('secret'));
    });
    test(spec.key + ' content uses credentialless video only', () => {
      const data = { content: { video_url: 'https://example.com/video.mp4' } };
      assert.deepEqual(plugin.listArtifacts({ status: 'SUCCESS', data }), [{ key: 'video', type: 'video', mimeType: 'video/mp4' }]);
      assert.deepEqual(plugin.listArtifacts({ status: 'IN_PROGRESS', data }), []);
      for (const method of ['GET', 'HEAD']) assert.deepEqual(plugin.buildContentRequest({ artifactKey: 'video', data, apiKey: 'secret', clientRequest: { method } }), { url: 'https://example.com/video.mp4', method, credentialless: true });
      assert.throws(() => plugin.buildContentRequest({ artifactKey: 'other', data }));
      assert.throws(() => plugin.buildContentRequest({ artifactKey: 'video', data: { video_url: 'http://localhost/' }, clientRequest: { method: 'GET' } }));
    });
    for (const field of ['concurrency', 'n', 'number_of_runs']) {
      test(spec.key + ' rejects multiple outputs via ' + field, () => assert.throws(() => plugin.buildSubmitRequest({ ...ctx, requestBody: { ...ctx.requestBody, [field]: 2 } })));
    }
    test(spec.key + ' rejects blank prompt', () => assert.throws(() => plugin.buildSubmitRequest({ ...ctx, requestBody: { model, prompt: ' ' } })));
    test(spec.key + ' rejects unknown models', () => assert.throws(() => plugin.buildSubmitRequest({ ...ctx, upstreamModel: '__proto__' })));
    test(spec.key + ' refuses credential exfiltration', () => assert.throws(() => plugin.buildSubmitRequest({ ...ctx, baseUrl: 'https://attacker.example' })));
    test(spec.key + ' rejects arbitrary billing/URL fields', () => assert.throws(() => plugin.buildSubmitRequest({ ...ctx, requestBody: { ...ctx.requestBody, cost: 0, callback_url: 'http://localhost' } })));
    test(spec.key + ' rejects null native input', () => assert.throws(() => plugin.native.create({ body: { kind: 'json', value: null } })));
    test(spec.key + ' accepts single task envelope', () => {
      const result = plugin.parseSubmitResponse(ctx, { statusCode: 200, body: { tasks: [{ id: 'provider-1', status: 'queued' }] } });
      assert.equal(result.taskId, 'provider-1');
      const query = plugin.buildQueryRequest({ ...ctx, taskId: 'provider/1', state: result.state });
      assert.ok(query.url.endsWith('/provider%2F1'));
    });
    for (const body of [null, {}, { tasks: [{ id: 'a' }, { id: 'b' }] }]) {
      test(spec.key + ' rejects ambiguous submit response', () => assert.throws(() => plugin.parseSubmitResponse(ctx, { statusCode: 200, body })));
    }
    for (const [status, expected] of Object.entries({ queued: 'QUEUED', running: 'IN_PROGRESS', processing: 'IN_PROGRESS', failed: 'FAILURE', mystery: 'UNKNOWN' })) {
      test(spec.key + ' status ' + status, () => assert.equal(plugin.parseTaskResult(ctx, { data: { status, error: { message: 'Fixture failure' } } }).status, expected));
    }
    test(spec.key + ' success requires media', () => assert.throws(() => plugin.parseTaskResult(ctx, { status: 'succeeded' })));
    test(spec.key + ' sanitizes native result', () => {
      const result = plugin.native.result({}, { task_id: 'public-1', status: 'SUCCESS', data: { data: { id: 'private-1', status: 'succeeded', content: { image_url: 'https://example.com/result.png' }, api_key: 'do-not-expose' } } });
      assert.equal(result.id, 'public-1'); assert.equal(result.outputs.length, 1);
      assert.ok(!JSON.stringify(result).includes('private-1')); assert.ok(!JSON.stringify(result).includes('do-not-expose'));
    });
  }
  console.log(passed + ' tests passed; no upstream generation calls were made.');
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
