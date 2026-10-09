'use strict';
// Default: preliminary online snapshot. --freeze stops the local tunnel and app
// before archiving and leaves them stopped for cutover (or explicit rollback).
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { connect } = require('./admin-client.cjs');

async function main() {
  const request = await connect();
  const options = await request('/api/option/');
  const channels = await request('/api/channel/?p=1&page_size=100');
  if (options.find(x => x.key === 'RegisterEnabled')?.value !== 'false') throw new Error('Expected closed registration; plan a maintenance window first');
  if (channels.total > channels.items.length || channels.items.some(x => x.status === 1)) throw new Error('Expected only disabled channels; freeze writes before migration');
  const dir = path.join(__dirname, 'private/migration', new Date().toISOString().replace(/[:.]/g, '-'));
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const compose = ['compose', '-f', 'compose.yaml', '-f', 'compose.tunnel.yaml'];
  const freeze = process.argv.includes('--freeze');
  if (freeze) {
    const tasks = spawnSync('docker', [...compose, 'exec', '-T', 'postgres', 'psql', '-U', 'pikno', '-d', 'newapi', '-Atc', 'SELECT count(*) FROM tasks;'], { cwd: __dirname, encoding: 'utf8' });
    if (tasks.status !== 0 || tasks.stdout.trim() !== '0') throw new Error('Freeze requires an empty task table; reconcile tasks first');
    const stop = spawnSync('docker', [...compose, 'stop', '-t', '60', 'cloudflared', 'new-api'], { cwd: __dirname, timeout: 150000, stdio: 'pipe' });
    if (stop.status !== 0) throw new Error('Freeze failed; check container state before proceeding');
  }
  function archive(name, args) {
    const fd = fs.openSync(path.join(dir, name), 'wx', 0o600);
    let result;
    try { result = spawnSync('docker', [...compose, ...args], { cwd: __dirname, stdio: ['ignore', fd, 'pipe'], timeout: 120000 }); }
    finally { fs.closeSync(fd); }
    if (result.error || result.status !== 0) throw new Error(name + ' backup failed; inspect locally, partial directory retained');
  }
  archive('postgres.dump', ['exec', '-T', 'postgres', 'pg_dump', '-U', 'pikno', '-d', 'newapi', '-Fc']);
  const dataCommand = freeze ? ['run', '--rm', '--no-deps', '-T', '--entrypoint', 'tar', 'new-api'] : ['exec', '-T', 'new-api', 'tar'];
  archive('newapi-data.tar.gz', [...dataCommand, 'czf', '-', '-C', '/data', '.']);
  for (const [name, args] of [
    ['postgres.dump', ['exec', '-T', 'postgres', 'pg_restore', '--list']],
    ['newapi-data.tar.gz', [...dataCommand, 'tzf', '-']],
  ]) {
    const result = spawnSync('docker', [...compose, ...args], { cwd: __dirname,
      input: fs.readFileSync(path.join(dir, name)), stdio: ['pipe', 'pipe', 'pipe'], timeout: 120000, maxBuffer: 16 * 1024 * 1024 });
    if (result.error || result.status !== 0) throw new Error(name + ' archive validation failed');
  }
  // Copy secrets only into the private ACL-restricted directory. Never print them.
  for (const file of ['.env', 'compose.yaml', 'compose.tunnel.yaml', 'compose.ecs.yaml', 'private/administrator.json', 'private/tunnel.json', 'private/tunnel-token.txt']) {
    const dest = path.join(dir, file);
    fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
    fs.copyFileSync(path.join(__dirname, file), dest, fs.constants.COPYFILE_EXCL);
  }
  const files = ['postgres.dump', 'newapi-data.tar.gz', '.env', 'compose.yaml', 'compose.tunnel.yaml', 'compose.ecs.yaml', 'private/administrator.json', 'private/tunnel.json', 'private/tunnel-token.txt'];
  const manifest = { createdAt: new Date().toISOString(), kind: freeze ? 'frozen-cutover-snapshot' : 'preliminary-online-snapshot',
    restoreTest: 'archive structure validated; full database restore not yet performed',
    redis: 'not copied; rebuild cache on target, do not run two writable origins against diverging databases',
    source: 'local piknoai-relay; registration closed and channels disabled',
    files: files.map(file => { const bytes = fs.readFileSync(path.join(dir, file)); return { file, bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') }; }) };
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ backupDirectory: dir, archivesValidated: true, files: files.length, totalBytes: manifest.files.reduce((n, f) => n + f.bytes, 0) }));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
