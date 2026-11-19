import { spawnSync } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { RELEASE_SHA256 } from './runtime.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const output = new URL('../../output/tool-control-build-current/', import.meta.url);
const image = 'pikno-tool-control:candidate';
const name = 'pikno-tool-control-local-qa-' + process.pid;
const commands = [];
function docker(args) {
  const result = spawnSync('docker', args, { cwd: root, encoding: 'utf8', timeout: 120000, maxBuffer: 2 << 20 });
  commands.push({ operation: args[0], exitCode: result.status });
  if (result.status !== 0) throw Error('Local Docker verification failed: ' + (result.stderr || result.error?.message || '').slice(0, 2000));
  return result.stdout.trim();
}
const started = Date.now();
const fixtureSecrets = new URL('fixture-secrets/', output);
await mkdir(fixtureSecrets, { recursive: true });
const fixtureEnv = new URL('fixture-compose.env', output);
await writeFile(fixtureEnv, 'CONTROL_OWNER=blocked\nTOOL_STORE_ORIGIN=https://store.invalid\n');
process.env.TOOL_CONTROL_ENV_FILE = fileURLToPath(fixtureEnv);
process.env.TOOL_CONTROL_SECRET_DIR = fileURLToPath(fixtureSecrets);
const compose = JSON.parse(docker(['compose', '-f', 'deploy/tool-control/compose.candidate.yaml', 'config', '--format', 'json']));
assert.equal(compose.services['tool-control'].ports, undefined);
assert.equal(compose.services['tool-control'].deploy.replicas, 1);
assert.equal(compose.services['tool-control'].environment.CONTROL_OWNER, 'blocked');
assert.equal(compose.networks.relay.name, 'piknoai-relay_default');
docker(['build', '--network=none', '--pull=false', '-f', 'deploy/tool-control/Dockerfile', '-t', image, 'output/tool-control-build-current/build-context']);
const build = JSON.parse(await readFile(new URL('build-verification.json', output)));
let running = false;
try {
  const env = { CONTROL_OWNER: 'blocked', TOOL_STORE_ORIGIN: 'https://store.invalid', TOOL_STORE_SECRET: 'S'.repeat(40), TOOLS_BRIDGE_SECRET: 'B'.repeat(40), TOOLS_ADMIN_SECRET: 'A'.repeat(40), TICKET_KEY: 'T'.repeat(40), RH_CONFIG_ENCRYPTION_KEY: 'a'.repeat(64) };
  docker(['run', '-d', '--name', name, '--network=none', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--memory=768m', '--pids-limit=64', ...Object.entries(env).flatMap(([key, value]) => ['-e', key + '=' + value]), image]);
  running = true;
  const probe = `const assert=require('node:assert/strict'); (async()=>{let ready;for(let i=0;i<50;i++){try{ready=await fetch('http://127.0.0.1:8090/healthz');break;}catch{await new Promise(r=>setTimeout(r,100));}}assert.equal(ready.status,200);const health=await ready.json();assert.equal(health.release_sha256,${JSON.stringify(RELEASE_SHA256)});assert.equal(health.accepting,false);assert.equal(health.active,0);for(const path of ['/media/v1/tools/status','/media/v1/packy'])assert.equal((await fetch('http://127.0.0.1:8090'+path)).status,503);console.log(JSON.stringify({health,node:process.version}));})().catch(()=>process.exit(1));`;
  const observed = JSON.parse(docker(['exec', name, 'node', '-e', probe]));
  const imageId = docker(['image', 'inspect', image, '--format', '{{.Id}}']);
  const runtimeUser = docker(['exec', name, 'id', '-u']);
  assert.equal(runtimeUser, '1000');
  docker(['stop', '--time', '10', name]);
  const exitCode = Number(docker(['inspect', name, '--format', '{{.State.ExitCode}}']));
  assert.equal(exitCode, 0);
  await writeFile(new URL('container-verification.json', output), JSON.stringify({ candidateOnly: true, productionChanged: false, providerNetwork: 'disabled', imageId, releaseSHA256: RELEASE_SHA256, contextHashes: build.contextHashes, composeValidated: true, hostPortsPublished: false, replicas: 1, runtimeUser, observed, exitCode, commands, elapsedMs: Date.now() - started, completedAt: new Date().toISOString(), allPassed: true }, null, 2));
  process.stdout.write(JSON.stringify({ localContainerPassed: true, imageId, node: observed.node }) + '\n');
} finally { if (running) docker(['rm', '-f', name]); }
