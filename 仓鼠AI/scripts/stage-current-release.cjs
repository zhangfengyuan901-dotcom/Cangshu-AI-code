// Stage the pinned source and regenerate every packaged runtime from its inputs.
'use strict';
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const app = path.resolve(__dirname, '..');
const readJSON = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function inside(parent, name) {
  const file = path.resolve(parent, name);
  const relative = path.relative(parent, file);
  assert(relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative), 'Build input must stay within its root');
  for (let current = file; current !== parent; current = path.dirname(current)) {
    if (fs.existsSync(current)) assert(!fs.lstatSync(current).isSymbolicLink(), 'Build inputs cannot be links');
  }
  return file;
}

function pinned(input, expected) {
  const file = inside(app, input);
  assert(fs.statSync(file).isFile(), 'Missing source input: ' + input);
  const bytes = fs.readFileSync(file);
  assert.equal(bytes.length, expected.bytes, 'Source size changed: ' + input);
  assert.equal(hash(bytes), expected.sha256, 'Source hash changed: ' + input);
  return bytes;
}

function write(parent, name, bytes) {
  const file = inside(parent, name);
  fs.mkdirSync(path.dirname(file), {recursive:true});
  fs.writeFileSync(file, bytes, {flag:'wx'});
}

function run(executable, args, cwd, extraEnv = {}) {
  const result = cp.spawnSync(executable, args, {cwd, env:{...process.env, ...extraEnv}, stdio:'inherit', windowsHide:true});
  if (result.error) throw result.error;
  assert.equal(result.status, 0, 'Build step failed: ' + path.basename(executable));
}

function stageGeneratedResources(out, resources, appFiles, resourceInputs, toolInputs) {
  const tools = path.join(out, 'build-source');
  for (const [name, bytes] of toolInputs) write(tools, name, bytes);
  for (const [name, bytes] of appFiles) if (name.startsWith('public/')) write(tools, name, bytes);
  for (const [name, bytes] of resourceInputs) {
    if (name.startsWith('smart-video-agent/')) write(tools, name, bytes);
  }

  run(process.execPath, ['scripts/build-canvas.cjs'], tools, {HAMSTER_CANVAS_BUILD_NODE:process.execPath});
  run(process.execPath, ['scripts/build-python-runtime.cjs'], tools, {HAMSTER_BUILD_STAGE:''});
  fs.cpSync(path.join(tools, 'canvas', 'dist'), path.join(resources, 'hamster-canvas', 'dist'), {recursive:true, force:false, errorOnExist:true});
  for (const name of ['python-runtime.zip','python-runtime.json']) {
    fs.copyFileSync(path.join(tools, 'build', name), path.join(resources, name), fs.constants.COPYFILE_EXCL);
  }
  const manifest = readJSON(path.join(resources, 'python-runtime.json'));
  assert.equal(manifest.archiveSha256, hash(fs.readFileSync(path.join(resources, 'python-runtime.zip'))));
}

function main() {
  const args = process.argv.slice(2);
  const check = args.length === 1 && args[0] === '--check';
  const build = args.includes('--build');
  const other = args.filter(arg => arg !== '--build');
  assert(check || other.length === 0 || other.length === 2 && other[0] === '--out', 'Use --check or [--build] [--out <empty-path>]');

  const spec = readJSON(inside(app, 'release/current.json'));
  const manifest = readJSON(inside(app, spec.sourceManifest));
  const pkg = readJSON(inside(app, 'package.json'));
  assert.equal(spec.format, 2);
  assert.equal(manifest.format, 2);
  assert.equal(spec.version, manifest.version);
  assert.match(pkg.version, /^1\.7\.\d+$/);
  assert.equal(pkg.version, spec.version);
  assert.deepEqual(Object.fromEntries(Object.keys(manifest.runtimePackage).map(key => [key, pkg[key]])), manifest.runtimePackage);
  assert.equal(pkg.name, 'hamster-ai');
  assert.equal(pkg.main, 'electron/main.cjs');
  const appFiles = new Map(Object.entries(manifest.files).map(([name, value]) => [name, pinned(name, value)]));
  appFiles.set('package.json', Buffer.from(JSON.stringify(manifest.runtimePackage, null, 2) + '\n'));
  const resourceInputs = new Map(Object.entries(manifest.resourceSources).map(([name, value]) => [name, pinned(value.source, value)]));
  const installerInputs = new Map(Object.entries(manifest.installerInputs).map(([name, value]) => [name, pinned(name, value)]));
  const toolInputs = new Map(Object.entries(manifest.buildSources).map(([name, value]) => [name, pinned(name, value)]));

  const result = {ok:true, version:pkg.version, source:'official-workspace-source', applicationFiles:appFiles.size, sourceResources:resourceInputs.size,
    buildSourceFiles:toolInputs.size, historicalReleaseDependencies:0};
  if (check) {
    console.log(JSON.stringify(result));
    return;
  }

  const destination = other[1];
  assert(!destination || path.isAbsolute(destination) || /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(destination), 'Invalid staging output path');
  const out = destination ? path.resolve(os.tmpdir(), destination) : fs.mkdtempSync(path.join(os.tmpdir(), 'hamster-ai-release-'));
  if (other.length) fs.mkdirSync(out);
  assert.equal(fs.realpathSync(out), out, 'Staging must use a real directory');
  const stage = path.join(out, 'source');
  const resources = path.join(out, 'resource-inputs');
  const artifacts = path.join(out, 'artifacts');
  const buildInputs = path.join(out, 'build-inputs');
  for (const [name, bytes] of appFiles) write(stage, name, bytes);
  for (const [name, bytes] of resourceInputs) write(resources, name, bytes);
  for (const [name, bytes] of installerInputs) write(buildInputs, name === 'build/icon.ico' ? 'icon.ico' : name, bytes);

  const roots = {'@stage':stage, '@resources':resources, '@artifacts':artifacts, '@build-inputs':buildInputs, '@app':app};
  function expand(value) {
    if (Array.isArray(value)) return value.map(expand);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key,item]) => [key, expand(item)]));
    if (typeof value !== 'string') return value;
    const [prefix, ...rest] = value.split('/');
    return Object.hasOwn(roots, prefix) ? path.join(roots[prefix], ...rest) : value;
  }

  const builder = expand(spec.builder);
  assert.equal(builder.appId, 'com.hamster.ai');
  assert.equal(builder.nsis.deleteAppDataOnUninstall, false);
  const config = path.join(out, 'builder.json');
  write(out, 'builder.json', JSON.stringify(builder, null, 2) + '\n');
  stageGeneratedResources(out, resources, appFiles, resourceInputs, toolInputs);
  const npm = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  run(process.execPath, [npm,'ci','--omit=dev','--ignore-scripts'], stage);

  if (build) {
    const cli = inside(app, 'node_modules/electron-builder/cli.js');
    assert(fs.statSync(cli).isFile(), 'Run npm ci in the application directory before building an installer');
    run(process.execPath, [cli, '--config', config, '--win', 'nsis', '--x64', '--publish', 'never'], stage);
    const installed = path.join(artifacts, 'win-unpacked');
    const packaged = path.join(installed, 'resources');
    const archive = path.join(packaged, 'app.asar');
    const packageName = '仓鼠AI-' + pkg.version;
    run(process.execPath, [path.join(buildInputs, 'scripts/build-custom-installer.cjs'),
      '--engine', path.join(artifacts, packageName + '-安装引擎.exe'), '--output', path.join(artifacts, packageName + '-安装包.exe'),
      '--version', pkg.version, '--runtime-manifest', path.join(packaged, 'python-runtime.json'), '--asar', archive, '--install-root', installed],
      out, {NODE_PATH: path.join(app, 'node_modules')});
  }

  write(out, 'stage.json', JSON.stringify({...result, built:build}, null, 2) + '\n');
  console.log(JSON.stringify({...result, stage, config, built:build}));
}

try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
