const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {test} = require('node:test');

async function checkChat(source) {
  const root = path.join(source, 'smart-video-agent', 'chat-ui', 'chat.js');
  const js = fs.readFileSync(root, 'utf8');
  const from = js.indexOf('function billingNotice(');
  const to = js.indexOf('function paidTermsIdentity(');
  assert.ok(from >= 0 && to > from);
  const operationA = 'a'.repeat(32);
  const operationB = 'b'.repeat(32);
  const price = 'chat-doubao-seed-2-1-pro-cny-30-150-6-v1';
  const fixture = request_id => ({ id:request_id, role:'assistant', status:'failed',
    billing:{ request_id, price_version:price, billing_mode:'actual_usage_v1', status:'unknown', admission_blocking:true } });
  let now = 0;
  let recover = false;
  let transient = false;
  const reads = [];
  const context = {
    AbortSignal, Date:{now:() => now}, metered:true, ready:true, current:{id:'chat-fixture',status:'failed',messages:[fixture(operationA),fixture(operationB)]},
    selection:0, submitting:false, uploading:false, configurationContext:'fixture', configurationEpoch:0,
    billingChecks:new Map(), billingCheckDelays:[0,2000,5000,10000,20000,30000],
    render(){}, applyConfiguration(){}, json:method => ({method}),
    async api(route, options) {
      if (route === '/config') return {};
      assert.equal(options.method, 'POST');
      assert.match(route, /^\/sessions\/chat-fixture\/billing\/[a-f0-9]{32}$/);
      const id = route.split('/').at(-1);
      reads.push(id);
      if (transient) throw Error('Synthetic rate limit');
      const item = fixture(id);
      item.billing.admission_blocking = !recover;
      return {id:'chat-fixture',messages:[item]};
    },
  };
  vm.createContext(context);
  vm.runInContext(js.slice(from, to), context);
  const reconcile = () => context.reconcileBills();
  const blocked = () => context.current.messages.some(message => context.billingBlocksAdmission(message.billing));
  assert.equal(await reconcile(), true);
  assert.equal(await reconcile(), true);
  assert.deepEqual(reads, [operationB, operationA]);
  for (const delta of [2000,5000,10000,20000,30000]) {
    now += delta;
    assert.equal(await reconcile(), true);
    assert.equal(await reconcile(), true);
  }
  assert.equal(blocked(), true);
  now += 905000;
  transient = true;
  assert.equal(await reconcile(), false);
  assert.equal(await reconcile(), false);
  const checksBeforeRecovery = reads.length;
  transient = false;
  recover = true;
  assert.equal(await reconcile(), false);
  assert.equal(reads.length, checksBeforeRecovery);
  assert.equal(blocked(), true);
  now += 120000;
  assert.equal(await reconcile(), true);
  assert.equal(blocked(), true);
  assert.equal(await reconcile(), true);
  assert.equal(blocked(), false);
  assert.ok(context.current.messages.every(message => message.billing.status === 'unknown'));
}

async function checkTools(app) {
  const {createPiknoClient} = require(path.join(app, 'pikno-client.cjs'));
  let outcome = 'bad-gateway';
  const requests = [];
  const relay = createPiknoClient({endpoint:'https://fixture.invalid',async fetchImpl(url) {
    requests.push(new URL(url).pathname);
    if (outcome === 'network') throw Error('Synthetic connection loss');
    if (outcome === 'invalid-json') return new Response('corrupt');
    return Response.json({error:'Fixture service unavailable'},{status:502});
  }});
  const cfg = {piknoToolKey:'synthetic-fixture'};
  for (const mode of ['bad-gateway','network','invalid-json']) {
    outcome = mode;
    await assert.rejects(relay.upload(cfg, Buffer.alloc(32), {contentType:'video/mp4',kind:'tool'}), error =>
      error.message === '工具素材上传暂不可用，任务尚未提交。' && error.ambiguous === false);
  }
  await assert.rejects(relay.request(cfg, 'tool', '/v1/client/quote', {readOnly:true, method:'POST'}), /报价暂时无法确认/);
  assert.deepEqual(requests, ['/v1/media/direct-uploads','/v1/media/direct-uploads','/v1/media/direct-uploads','/v1/client/quote']);
}

const appRoot = path.join(__dirname, '..');
test('original chat status polling recovers without changing admission', () => checkChat(appRoot));
test('tool upload failures are distinct from quote failures', () => checkTools(appRoot));
