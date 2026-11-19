// Isolated workerd/SQLite checks. All credentials, identities and upstream
// responses are synthetic. The outbound hook rejects every unexpected URL.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFile, mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve, dirname, basename} from 'node:path';
const require = createRequire(new URL('../../billing-worker/package.json', import.meta.url));
const {Miniflare, convertV4MiniflareOptions} = require('miniflare');
const script = await readFile(new URL('../src/worker.js', import.meta.url), 'utf8');
const enc = new TextEncoder();
const secret = 'runtime-only-bridge-secret-not-a-real-credential';
const routes = [
  {endpoint:'ep-runtime-primary',version:'260915'},
  {endpoint:'ep-runtime-second',version:'260915'},
  {endpoint:'ep-runtime-third',version:'260628'},
];
async function signedRequest(id, patch={}) {
  const body = JSON.stringify({model:'pikno-chat-standard',input:'Reply OK',max_output_tokens:32,stream:false});
  const now = Math.floor(Date.now()/1000);
  const claims = {v:2,aud:'pikno-llm-execute',billing_mode:'actual_usage_v1',uid:2,request_id:id,jti:id,
    model_alias:'pikno-chat-standard',route_policy:'pikno-text-three-actual-usage-v2',
    body_sha256:Buffer.from(await crypto.subtle.digest('SHA-256',enc.encode(body))).toString('hex'),
    max_output_tokens:32,iat:now,exp:now+60,...patch};
  const data = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const key = await crypto.subtle.importKey('raw',enc.encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  const sig = Buffer.from(await crypto.subtle.sign('HMAC',key,enc.encode(data))).toString('base64url');
  return {method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${data}.${sig}`},body};
}
async function runtime(persistence, upstream, source=script) {
  return new Miniflare(convertV4MiniflareOptions({name:'llm-isolated-runtime',modules:true,script:source,
    compatibilityDate:'2026-09-28',compatibilityFlags:['nodejs_compat'],telemetry:{enabled:false},
    resourcePersistencePath:persistence,
    durableObjects:{LLM_EXECUTIONS:{className:'LlmExecutionGuard',useSQLite:true}},
    bindings:{LLM_BILLING_MODE:'actual_usage_v1',PIKNO_LLM_MODEL_VERIFIED:'true',
      ARK_API_KEY:'runtime-only-upstream-not-a-real-key',TOKEN_SIGNING_KEY:'runtime-only-envelope-secret-32-bytes',
      PIKNO_ASSISTANT_BRIDGE_SECRET:secret,PIKNO_LLM_ROUTES:JSON.stringify(routes)},
    outboundService:async request=>{
      assert.equal(request.url,'https://ark.cn-beijing.volces.com/api/v3/responses');
      assert.equal(request.method,'POST');
      return upstream(await request.json());
    },
  }));
}
function limited() {
  return Response.json({error:{code:'RateLimitExceeded.EndpointRPMExceeded',type:'TooManyRequests',message:'synthetic limit'}},{status:429});
}
async function isolated(t) {
  const root = resolve(tmpdir()), path = await mkdtemp(resolve(root,'hamster-llm-runtime-'));
  const instances = [];
  t.after(async()=>{
    for (const instance of instances.reverse()) await instance.dispose();
    // Only remove this test's explicitly created temporary child directory.
    assert.equal(dirname(resolve(path)),root);
    assert.ok(basename(path).startsWith('hamster-llm-runtime-'));
    await rm(path,{recursive:true,force:true});
  });
  return {path,instances};
}
test('workerd durable journal permits one sequential two-line operation under concurrent replay',async t=>{
  const fixture = await isolated(t), seen = [];
  const mf = await runtime(fixture.path,body=>{
    seen.push(body.model);
    if (seen.length<2) return limited();
    return Response.json({object:'response',id:'response-runtime',model:'internal-model',status:'completed',
      output:[{type:'message',role:'assistant',content:[{type:'output_text',text:'OK'}]}],
      usage:{input_tokens:9,output_tokens:2,total_tokens:11}});
  });
  fixture.instances.push(mf);
  const results = await Promise.all(Array.from({length:8},async()=>mf.dispatchFetch('https://inference.test/internal/pikno/responses',await signedRequest('a'.repeat(32)))));
  assert.equal(results.filter(result=>result.status===200).length,1);
  assert.equal(results.filter(result=>result.status===409).length,7);
  assert.deepEqual(seen,routes.slice(0,2).map(route=>route.endpoint));
  for (const result of results) {
    const body = await result.text();
    assert.doesNotMatch(body,/ep-runtime|internal-model|runtime-only/);
    if (result.status===200) assert.equal(JSON.parse(body).usage.total_tokens,11);
  }
});
test('workerd persisted zero-execution and unknown outcomes cannot dispatch again after restart',async t=>{
  const fixture = await isolated(t), seen = [];
  let mode = 'limited';
  const upstream = body=>{
    seen.push(body.model);
    return mode==='limited'?limited():Response.json({error:{code:'InternalServiceError'}},{status:503});
  };
  const first = await runtime(fixture.path,upstream);
  fixture.instances.push(first);
  const capped = await first.dispatchFetch('https://inference.test/internal/pikno/responses',await signedRequest('b'.repeat(32)));
  assert.equal(capped.headers.get('x-pikno-execution-state'),'rejected_before_execution');
  assert.equal((await capped.json()).error.submission_state,'rejected_before_execution');
  assert.deepEqual(seen,[routes[0].endpoint,routes[1].endpoint]); // Configured older version is disabled by this policy.
  mode = 'unknown';
  const uncertain = await first.dispatchFetch('https://inference.test/internal/pikno/responses',await signedRequest('c'.repeat(32)));
  assert.equal((await uncertain.json()).error.submission_state,'unknown');
  assert.equal(seen.length,3);
  await first.dispose(); fixture.instances.pop();
  const second = await runtime(fixture.path,()=>assert.fail('persisted operation must never dispatch again'));
  fixture.instances.push(second);
  for (const id of ['b','c']) {
    const replay = await second.dispatchFetch('https://inference.test/internal/pikno/responses',await signedRequest(id.repeat(32)));
    assert.equal(replay.status,409); await replay.arrayBuffer();
  }
});
test('workerd upgrade preserves a pre-existing v1 permanent dispatch tombstone',async t=>{
  const fixture = await isolated(t);
  // Seed the exact released single-dispatch record/identity, not a new journal.
  const legacy = `export class LlmExecutionGuard {
    constructor(state){this.state=state;}
    async fetch(){await this.state.storage.put('dispatched',{v:1,claimed_at:1});return new Response('seeded');}
  }
  export default {async fetch(request,env){
    const bytes=new TextEncoder().encode('pikno-llm-execute-v1\\0'+'2\\0'+'${'d'.repeat(32)}');
    const digest=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(x=>x.toString(16).padStart(2,'0')).join('');
    return env.LLM_EXECUTIONS.get(env.LLM_EXECUTIONS.idFromName(digest)).fetch('https://execution.internal/claim',{method:'POST'});
  }};`;
  const first = await runtime(fixture.path,()=>assert.fail('seed must not invoke upstream'),legacy);
  fixture.instances.push(first);
  const seeded = await first.dispatchFetch('https://inference.test/');
  assert.equal(await seeded.text(),'seeded');
  await first.dispose(); fixture.instances.pop();
  const current = await runtime(fixture.path,()=>assert.fail('v1 tombstone must prohibit every upstream attempt'));
  fixture.instances.push(current);
  const replay = await current.dispatchFetch('https://inference.test/internal/pikno/responses',await signedRequest('d'.repeat(32)));
  assert.equal(replay.status,409);
  assert.equal((await replay.json()).error.submission_state,'unknown');
});

test('workerd actual-usage upgrade cannot replay a previous prepaid-policy journal',async t=>{
  const fixture = await isolated(t);
  const legacy = `export class LlmExecutionGuard {
    constructor(state){this.state=state;}
    async fetch(){
      const hash=async value=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)))].map(x=>x.toString(16).padStart(2,'0')).join('');
      await this.state.storage.put('dispatched',{v:2,policy_sha256:await hash('pikno-text-three-v1'),owner_sha256:await hash('old-owner'),next:1,state:'ready',attempts:[{slot:0,state:'endpoint_limit'}]});
      return new Response('seeded');
    }
  }
  export default {async fetch(request,env){
    const bytes=new TextEncoder().encode('pikno-llm-execute-v1\\0'+'2\\0'+'${'e'.repeat(32)}');
    const digest=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(x=>x.toString(16).padStart(2,'0')).join('');
    return env.LLM_EXECUTIONS.get(env.LLM_EXECUTIONS.idFromName(digest)).fetch('https://execution.internal/claim',{method:'POST'});
  }};`;
  const first = await runtime(fixture.path,()=>assert.fail('seed must not invoke upstream'),legacy);
  fixture.instances.push(first);
  const seeded = await first.dispatchFetch('https://inference.test/');
  assert.equal(await seeded.text(),'seeded');
  await first.dispose(); fixture.instances.pop();
  const current = await runtime(fixture.path,()=>assert.fail('old journal must prohibit every upstream attempt'));
  fixture.instances.push(current);
  const replay = await current.dispatchFetch('https://inference.test/internal/pikno/responses',await signedRequest('e'.repeat(32)));
  assert.equal(replay.status,409);
  assert.equal((await replay.json()).error.submission_state,'unknown');
});
