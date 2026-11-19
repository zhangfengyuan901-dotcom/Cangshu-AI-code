import assert from 'node:assert/strict';
import test from 'node:test';
import { createTosMigrationWorker } from './worker.mjs';
import { createTosMediaWorker } from '../../../仓鼠AI/cloudflare/media-worker/tos-migration/worker.mjs';
import { createTosBillingWorker, withTosWorkflow } from '../../../仓鼠AI/cloudflare/billing-worker/tos-migration/worker.mjs';
import { GenerationWorkflow as ReleasedWorkflow } from '../../../仓鼠AI/cloudflare/billing-worker/src/worker.mjs';

const origin = 'https://www.piknoai.com';
const env = {
  CONTROL_OWNER: 'ecs', CONTROL_ORIGIN: 'https://origin.piknoai.com', CONTROL_ORIGIN_HOST: 'origin.piknoai.com',
  TOS_STORAGE_PROXY_ORIGIN: 'https://origin.piknoai.com', TOS_STORAGE_PROXY_SECRET: 'synthetic-private-secret',
  MEDIA: { old: true }, RESULTS: { old: true }, DB: { retained: true }, GENERATION: { retained: true },
};

test('PIKNO keeps only ECS control execution and replaces asset storage without R2 fallback', async () => {
  const calls = [], storage = { head: async () => ({ size: 8 }) };
  const assetWorker = { async fetch(request, bindings, context) {
    assert.equal(bindings.MEDIA, storage);
    assert.equal(bindings.DB, env.DB);
    assert.equal(context, 'synthetic-context');
    calls.push('asset');
    return Response.json({ ok: true });
  } };
  const worker = createTosMigrationWorker(assetWorker, {
    storageFactory(options) {
      assert.deepEqual(options, { origin: env.TOS_STORAGE_PROXY_ORIGIN, secret: env.TOS_STORAGE_PROXY_SECRET, namespace: 'pikno-relay-inputs' });
      return storage;
    },
    async fetchImpl(url, options) {
      assert.equal(url, 'https://origin.piknoai.com/media/v1/tools/status');
      assert.equal(options.redirect, 'manual');
      assert.equal(options.headers.get('authorization'), 'Bearer synthetic-client');
      assert.equal(options.headers.has('x-untrusted'), false);
      assert.equal([...options.headers.values()].includes(env.TOS_STORAGE_PROXY_SECRET), false);
      calls.push('ecs');
      return Response.json({ ok: true });
    },
  });
  const asset = new Request(origin + '/media/v1/assets/' + 'a'.repeat(32));
  assert.equal((await worker.fetch(asset, env, 'synthetic-context')).status, 200);
  const control = new Request(origin + '/media/v1/tools/status', { headers: { authorization: 'Bearer synthetic-client', 'x-untrusted': 'discard' } });
  assert.equal((await worker.fetch(control, env)).status, 200);
  for (const owner of ['blocked', 'cloudflare', undefined]) {
    assert.equal((await worker.fetch(control, { ...env, CONTROL_OWNER: owner })).status, 503);
  }
  assert.equal((await worker.fetch(control, { ...env, CONTROL_ORIGIN: origin, CONTROL_ORIGIN_HOST: 'www.piknoai.com' })).status, 503);
  assert.equal((await worker.fetch(new Request(origin + '/__control-store/v1/tool-config/active'), env)).status, 404);
  assert.deepEqual(calls, ['asset', 'ecs']);
  assert.deepEqual(env.MEDIA, { old: true });
});

test('legacy media and billing fetch/scheduled preserve all nonstorage bindings', async () => {
  const calls = [], storage = { synthetic: true };
  const factory = namespace => options => { assert.equal(options.namespace, namespace); return storage; };
  const media = createTosMediaWorker({ async fetch(request, bindings, context) {
    assert.equal(bindings.MEDIA, storage); assert.equal(bindings.DB, env.DB); assert.equal(context, 'context');
    calls.push('media'); return new Response(null, { status: 204 });
  } }, { storageFactory: factory('hamster-ai-media') });
  const billing = createTosBillingWorker({
    async fetch(request, bindings, context) {
      assert.equal(bindings.RESULTS, storage); assert.equal(bindings.DB, env.DB); assert.equal(bindings.GENERATION, env.GENERATION);
      assert.equal(context, 'context'); calls.push('billing'); return new Response(null, { status: 204 });
    },
    async scheduled(controller, bindings, context) {
      assert.equal(bindings.RESULTS, storage); assert.equal(bindings.DB, env.DB); assert.equal(controller, 'timer'); assert.equal(context, 'context');
      calls.push('scheduled'); return 'retained';
    },
  }, { storageFactory: factory('hamster-billing-results') });
  assert.equal((await media.fetch(new Request('https://media.hamsterai.cc/health'), env, 'context')).status, 204);
  assert.equal((await billing.fetch(new Request('https://account.hamsterai.cc/health'), env, 'context')).status, 204);
  assert.equal(await billing.scheduled('timer', env, 'context'), 'retained');
  assert.deepEqual(calls, ['media', 'billing', 'scheduled']);
  assert.deepEqual(env.RESULTS, { old: true });
});

test('actual billing Workflow uses proxy inside durable step and retains original transition', async () => {
  let state = 'transferring', heads = 0, updates = 0, steps = 0;
  const DB = { prepare(sql) { return { bind(...args) { return {
    async first() { return { id: 'task_synthetic', state, result_key: 'result/1/synthetic.mp4', user_id: '1', kind: 'video' }; },
    async run() {
      assert.match(sql, /UPDATE tasks SET state='succeeded'/);
      assert.equal(args[0], 'result/1/synthetic.mp4');
      state = 'succeeded'; updates++; return { success: true };
    },
  }; } }; } };
  const Workflow = withTosWorkflow(ReleasedWorkflow, { storageFactory(options) {
    assert.equal(options.namespace, 'hamster-billing-results');
    return { async head(key) { assert.equal(key, 'result/1/synthetic.mp4'); heads++; return { size: 16 }; } };
  } });
  const context = { synthetic: true }, instance = new Workflow(context, { ...env, DB });
  const result = await instance.run({ payload: { taskId: 'task_synthetic' } }, {
    async do(name, options, work) { assert.equal(name, 'advance-0'); assert.equal(options.retries.limit, 2); steps++; return work(); },
    async sleep() { assert.fail('completed synthetic task must not sleep'); },
  });
  assert.deepEqual(result, { state: 'done' });
  assert.equal(instance.ctx, context);
  assert.equal(heads, 2); assert.equal(updates, 1); assert.equal(steps, 1);
  assert.equal(instance.env.DB, DB);
});

test('read-only storage guard rejects writes before proxy calls and permits reads', async () => {
  let reads = 0, writes = 0;
  const storageFactory = () => ({ async head() { reads++; return null; }, put() { writes++; }, delete() { writes++; } });
  const blockedEnv = { ...env, TOS_STORAGE_READ_ONLY: 'true' };
  const check = async bindings => {
    const store = bindings.MEDIA || bindings.RESULTS;
    await store.head('synthetic');
    assert.throws(() => store.put('synthetic', 'body'), /writes blocked/);
    assert.throws(() => store.delete('synthetic'), /writes blocked/);
    return new Response(null, { status: 204 });
  };
  const pikno = createTosMigrationWorker({ fetch: (request, bindings) => check({ MEDIA: bindings.MEDIA }) }, { storageFactory });
  const media = createTosMediaWorker({ fetch: (request, bindings) => check({ MEDIA: bindings.MEDIA }) }, { storageFactory });
  const billing = createTosBillingWorker({ fetch: (request, bindings) => check({ RESULTS: bindings.RESULTS }), scheduled: (controller, bindings) => check({ RESULTS: bindings.RESULTS }) }, { storageFactory });
  await pikno.fetch(new Request(origin + '/media/v1/assets/' + 'a'.repeat(32)), blockedEnv);
  await media.fetch(new Request('https://media.hamsterai.cc/health'), blockedEnv);
  await billing.fetch(new Request('https://account.hamsterai.cc/health'), blockedEnv);
  await billing.scheduled({}, blockedEnv);
  assert.equal(reads, 4); assert.equal(writes, 0);
});
