'use strict';

// Internal release helper. Input is supplied only through a protected pipe;
// never put route values in arguments, normal files, logs or diagnostics.
// This stages one Secret on a verified closed version and never deploys it.
const {spawnSync} = require('node:child_process');
const {resolve} = require('node:path');

const WORKER = 'hamster-ai-inference';
const SECRET = 'PIKNO_LLM_ROUTES';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const CONFIG = resolve(__dirname, '../cloudflare/llm-worker/wrangler.jsonc');
const CLI = resolve(__dirname, '../cloudflare/billing-worker/node_modules/wrangler/bin/wrangler.js');
const failure = code => Object.assign(new Error(code), {safeCode:code});

function parseOutput(text) {
  for (const match of [...String(text || '').matchAll(/^[\[{]/gm)].reverse()) {
    try { return JSON.parse(text.slice(match.index)); } catch {}
  }
  throw failure('metadata_unavailable');
}

function runWrangler(args, input) {
  const env = {...process.env, CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV:'false',
    CLOUDFLARE_INCLUDE_PROCESS_ENV:'false', WRANGLER_SEND_METRICS:'false',
    WRANGLER_LOG_SANITIZE:'true', CI:'true', NO_COLOR:'1'};
  // Custom log levels can suppress the JSON metadata needed by this helper.
  delete env.WRANGLER_LOG;
  const result = spawnSync(process.execPath, [CLI, ...args, '--config', CONFIG, '--profile', 'default'], {
    encoding:'utf8', input, env, timeout:60_000, maxBuffer:1024*1024,
    windowsHide:true, stdio:['pipe','pipe','pipe'],
  });
  if (result.error || result.status !== 0) throw failure(input ? 'secret_stage_outcome_unknown' : 'metadata_unavailable');
  return result.stdout;
}

function validateRoutes(input) {
  if (!Buffer.isBuffer(input) || input.length < 1 || input.length > 16_384) throw failure('invalid_routes_input');
  let routes;
  try { routes = JSON.parse(new TextDecoder('utf-8', {fatal:true}).decode(input)); } catch { throw failure('invalid_routes_input'); }
  if (!Array.isArray(routes) || routes.length !== 3 || !routes.every((route, index) =>
    route && typeof route === 'object' && !Array.isArray(route) && Object.keys(route).length === 2 &&
    Object.hasOwn(route, 'endpoint') && Object.hasOwn(route, 'version') &&
    typeof route.endpoint === 'string' && /^ep-[a-zA-Z0-9-]{5,100}$/.test(route.endpoint) &&
    route.version === (index < 2 ? '260915' : '260628')) || new Set(routes.map(route => route.endpoint)).size !== 3) {
    throw failure('invalid_routes_input');
  }
  return Buffer.from(JSON.stringify(routes));
}

function requireClosedVersion(version, id) {
  const bindings = version?.resources?.bindings;
  if (version?.id !== id || !Array.isArray(bindings) ||
    !bindings.some(binding => binding.name === 'LLM_EXECUTIONS' && binding.type === 'durable_object_namespace' && binding.class_name === 'LlmExecutionGuard') ||
    !bindings.some(binding => binding.name === 'LLM_BILLING_MODE' && binding.type === 'plain_text' && binding.text === 'actual_usage_v1') ||
    !bindings.some(binding => binding.name === 'PIKNO_LLM_MODEL_VERIFIED' && binding.type === 'plain_text' && binding.text === 'false')) {
    throw failure('closed_baseline_required');
  }
  return bindings;
}

async function stageRoutes({apply=false, baseVersion, input, run=runWrangler}={}) {
  if (!apply) return {applied:false, deployed:false, worker:WORKER, secretNames:[SECRET]};
  if (!UUID.test(baseVersion || '')) throw failure('base_version_required');
  const value = validateRoutes(input);
  try {
    const versions = parseOutput(run(['versions','list','--json']));
    if (!Array.isArray(versions) || !versions.length) throw failure('metadata_unavailable');
    const latest = [...versions].sort((a,b) => String(b.metadata?.created_on || '').localeCompare(String(a.metadata?.created_on || '')))[0];
    if (latest.id !== baseVersion) throw failure('latest_version_changed');
    const deployments = parseOutput(run(['deployments','list','--json']));
    if (!Array.isArray(deployments) || !deployments.length) throw failure('metadata_unavailable');
    const deployed = [...deployments].sort((a,b) => String(b.created_on || '').localeCompare(String(a.created_on || '')))[0];
    if (deployed.versions?.length !== 1 || deployed.versions[0].version_id !== baseVersion || deployed.versions[0].percentage !== 100) {
      throw failure('deployed_version_changed');
    }
    const baseline = parseOutput(run(['versions','view',baseVersion,'--json']));
    if (requireClosedVersion(baseline, baseVersion).some(binding => binding.name === SECRET)) throw failure('secret_already_exists');
    // Wrangler patches the latest version, not a caller-supplied base. Keep
    // release writers serialized; this preflight is deliberately not called CAS.
    const result = run(['versions','secret','put',SECRET,'--name',WORKER,'--tag','llm-routes-closed'], value);
    const created = [...String(result).matchAll(/Created version ([a-f0-9-]{36}) with secret PIKNO_LLM_ROUTES\./g)];
    if (created.length !== 1 || !UUID.test(created[0][1]) || created[0][1] === baseVersion) throw failure('secret_stage_outcome_unknown');
    const versionId = created[0][1];
    try {
      const staged = parseOutput(run(['versions','view',versionId,'--json']));
      if (!requireClosedVersion(staged, versionId).some(binding => binding.name === SECRET && binding.type === 'secret_text')) {
        throw failure('staged_secret_unverified');
      }
    } catch (error) { error.safeVersionId = versionId; throw error; }
    return {applied:true, deployed:false, worker:WORKER, secretNames:[SECRET], baseVersion, versionId};
  } finally { value.fill(0); }
}

async function main() {
  const args = process.argv.slice(2);
  if (!args.length) return stageRoutes();
  if (args.length !== 3 || args[0] !== '--apply' || args[1] !== '--base-version' || !UUID.test(args[2])) throw failure('invalid_arguments');
  const chunks = [];
  let size = 0;
  try {
    for await (const chunk of process.stdin) {
      size += chunk.length;
      if (size > 16_384) throw failure('invalid_routes_input');
      chunks.push(chunk);
    }
    const input = Buffer.concat(chunks);
    try { return await stageRoutes({apply:true, baseVersion:args[2], input}); }
    finally { input.fill(0); }
  } finally { for (const chunk of chunks) chunk.fill(0); }
}

if (require.main === module) main().then(result => process.stdout.write(JSON.stringify(result)+'\n')).catch(error => {
  process.stderr.write(JSON.stringify({error:error.safeCode || 'provisioning_failed', deployed:false,
    ...(UUID.test(error.safeVersionId || '') ? {versionId:error.safeVersionId} : {})})+'\n');
  process.exitCode = 1;
});

module.exports = {stageRoutes, validateRoutes};
