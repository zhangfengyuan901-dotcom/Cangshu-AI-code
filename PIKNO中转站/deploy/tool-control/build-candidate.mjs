import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { RELEASE_PATH, RELEASE_SHA256, loadRuntime } from './runtime.mjs';

const files = ['server.mjs', 'runtime.mjs', 'storage-client.mjs', 'protocol.mjs', 'worker-candidate.mjs', 'package.json', 'Dockerfile',
  'tos-migration/storage.mjs', 'tos-migration/proxy.mjs', 'tos-migration/server.mjs', 'tos-migration/asset-runtime.mjs',
  'tos-migration/presign-route.mjs', 'tos-migration/presigned-upload.mjs'];
const target = new URL('../../output/tool-control-build-current/', import.meta.url);
const context = new URL('build-context/', target);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

await loadRuntime();
assert.equal(hash(await readFile(RELEASE_PATH)), RELEASE_SHA256);
await mkdir(new URL('deploy/tool-control/', context), { recursive: true });
await mkdir(new URL('deploy/tool-control/tos-migration/', context), { recursive: true });
const contextHashes = {};
for (const name of files) {
  const source = new URL(name, import.meta.url);
  const relative = 'deploy/tool-control/' + name;
  const destination = new URL(relative, context);
  await copyFile(source, destination);
  contextHashes[relative] = hash(await readFile(destination));
}
const dockerfile = await readFile(new URL('deploy/tool-control/Dockerfile', context), 'utf8');
assert.ok(!dockerfile.includes('cloudflare/relay-media/'));
assert.ok(dockerfile.includes('CMD ["node", "deploy/tool-control/tos-migration/server.mjs"]'));
await writeFile(new URL('.dockerignore', context), '**\n!deploy/\n!deploy/tool-control/\n!deploy/tool-control/**\n');
await writeFile(new URL('build-verification.json', target), JSON.stringify({
  candidateOnly: true,
  deployed: false,
  releaseSHA256: RELEASE_SHA256,
  contextHashes,
  selfContainedCurrentSource: true,
  historicalReleaseDependencies: 0,
  frozenCloudflareSourceDependency: false,
  defaultControlBlocked: true,
  context: fileURLToPath(context),
  completedAt: new Date().toISOString(),
}, null, 2) + '\n');
process.stdout.write(JSON.stringify({ candidateBuilt: true, releaseSHA256: RELEASE_SHA256, sourceFiles: files.length, historicalReleaseDependencies: 0 }) + '\n');
