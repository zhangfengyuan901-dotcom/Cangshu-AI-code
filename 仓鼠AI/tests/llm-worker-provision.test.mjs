import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {runInNewContext} from 'node:vm';
const require = createRequire(import.meta.url);
const {stageRoutes} = require('../scripts/stage-llm-worker-routes.cjs');
const base='11111111-1111-4111-8111-111111111111', staged='22222222-2222-4222-8222-222222222222';
const routes=Buffer.from(JSON.stringify([
  {endpoint:'ep-synthetic-primary',version:'260915'},
  {endpoint:'ep-synthetic-backup',version:'260915'},
  {endpoint:'ep-synthetic-older',version:'260628'},
]));
const bindings=[{name:'LLM_EXECUTIONS',type:'durable_object_namespace',class_name:'LlmExecutionGuard'},
  {name:'LLM_BILLING_MODE',type:'plain_text',text:'actual_usage_v1'},
  {name:'PIKNO_LLM_MODEL_VERIFIED',type:'plain_text',text:'false'},
  {name:'ARK_API_KEY',type:'secret_text'}, {name:'TOKEN_SIGNING_KEY',type:'secret_text'},
  {name:'PIKNO_ASSISTANT_BRIDGE_SECRET',type:'secret_text'}];
function fixture({latest=base,deployed=base,baseline=bindings,stagedBindings=[...bindings,{name:'PIKNO_LLM_ROUTES',type:'secret_text'}],putError=false}={}) {
  const calls=[];
  return {calls,run(args,input){
    calls.push({args,input:input && Buffer.from(input)});
    if (args.join(' ') === 'versions list --json') return JSON.stringify([{id:latest,metadata:{created_on:'2026-10-21T00:00:00Z'}}]);
    if (args.join(' ') === 'deployments list --json') return JSON.stringify([{created_on:'2026-10-21T00:00:00Z',versions:[{version_id:deployed,percentage:100}]}]);
    if (args[0]==='versions' && args[1]==='view') return JSON.stringify({id:args[2],resources:{bindings:args[2]===base?baseline:stagedBindings}});
    assert.deepEqual(args,['versions','secret','put','PIKNO_LLM_ROUTES','--name','hamster-ai-inference','--tag','llm-routes-closed']);
    if (putError) throw Error('synthetic private text must not be copied');
    return `Success! Created version ${staged} with secret PIKNO_LLM_ROUTES.`;
  }};
}
test('provisioning is dry by default and does not consume stdin or contact Cloudflare',async()=>{
  const result=await stageRoutes({run(){assert.fail('dry mode cannot call Wrangler');}});
  assert.deepEqual(result,{applied:false,deployed:false,worker:'hamster-ai-inference',secretNames:['PIKNO_LLM_ROUTES']});
});
test('provisioning rejects invalid baseline and route shape before any metadata or write',async()=>{
  for (const input of [Buffer.from('{}'),Buffer.from('['),Buffer.from('x'.repeat(16385)),Buffer.from(JSON.stringify([{endpoint:'ep-test-only',version:'260915'}]))]) {
    await assert.rejects(stageRoutes({apply:true,baseVersion:base,input,run(){assert.fail('invalid input cannot call Wrangler');}}),{message:'invalid_routes_input'});
  }
  await assert.rejects(stageRoutes({apply:true,baseVersion:'wrong',input:routes}),{message:'base_version_required'});
});
test('one protected-stdin write stages a closed version without deploying or exposing values in arguments/output',async()=>{
  const mock=fixture(),result=await stageRoutes({apply:true,baseVersion:base,input:routes,run:mock.run});
  assert.deepEqual(result,{applied:true,deployed:false,worker:'hamster-ai-inference',secretNames:['PIKNO_LLM_ROUTES'],baseVersion:base,versionId:staged});
  const writes=mock.calls.filter(call=>call.input);
  assert.equal(writes.length,1);assert.deepEqual(writes[0].input,routes);
  assert.doesNotMatch(JSON.stringify(mock.calls.map(call=>call.args)),/ep-synthetic|deploy /);
  assert.doesNotMatch(JSON.stringify(result),/ep-synthetic|260915|260628/);
  const pinned=fixture(),isolated={exports:{}};
  runInNewContext(readFileSync(new URL('../scripts/stage-llm-worker-routes.cjs',import.meta.url),'utf8'),{
    module:isolated,__dirname:fileURLToPath(new URL('../scripts/',import.meta.url)),Buffer,TextDecoder,
    process:{execPath:'node',env:{WRANGLER_LOG:'error'}},
    require(name){return name==='node:child_process'?{spawnSync(command,args,options){
      assert.equal(command,'node');assert.deepEqual(Array.from(args.slice(-2)),['--profile','default']);
      assert.equal(args.at(-4),'--config');assert.match(args.at(-3),/llm-worker[\\/]wrangler\.jsonc$/);
      assert.equal(options.env.CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV,'false');assert.equal(options.env.WRANGLER_LOG,undefined);
      return {status:0,stdout:pinned.run(Array.from(args.slice(1,-4)),options.input)};
    }}:require(name);},
  });
  const pinnedResult=await isolated.exports.stageRoutes({apply:true,baseVersion:base,input:routes});
  assert.equal(pinnedResult.versionId,staged);assert.equal(pinned.calls.filter(call=>call.input).length,1);
});
test('changed latest/deployment, open code, missing durable guard and an existing Secret all prevent mutation',async()=>{
  for (const options of [{latest:staged},{deployed:staged},{baseline:bindings.filter(binding=>binding.name!=='LLM_EXECUTIONS')},
    {baseline:bindings.map(binding=>binding.name==='PIKNO_LLM_MODEL_VERIFIED'?{...binding,text:'true'}:binding)},
    {baseline:[...bindings,{name:'PIKNO_LLM_ROUTES',type:'secret_text'}]}]) {
    const mock=fixture(options);
    await assert.rejects(stageRoutes({apply:true,baseVersion:base,input:routes,run:mock.run}));
    assert.equal(mock.calls.filter(call=>call.input).length,0);
  }
});
test('an ambiguous Secret write is never retried and the helper never deploys',async()=>{
  const mock=fixture({putError:true});
  await assert.rejects(stageRoutes({apply:true,baseVersion:base,input:routes,run:mock.run}));
  assert.equal(mock.calls.filter(call=>call.input).length,1);
  assert.ok(mock.calls.every(call=>!call.args.includes('deploy')));
});
test('post-write metadata must still be closed, durable and include the staged Secret',async()=>{
  const mock=fixture({stagedBindings:bindings});
  await assert.rejects(stageRoutes({apply:true,baseVersion:base,input:routes,run:mock.run}),{message:'staged_secret_unverified',safeVersionId:staged});
  assert.equal(mock.calls.filter(call=>call.input).length,1);
  assert.ok(mock.calls.every(call=>!call.args.includes('deploy')));
});
