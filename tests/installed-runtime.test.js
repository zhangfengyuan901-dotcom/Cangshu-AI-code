const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {MARKER,prepareInstalledRuntime,createInstalledRuntimeProvider,removeInstalledRuntime}=require('../installed-runtime.cjs');
const hash=s=>crypto.createHash('sha256').update(s).digest('hex');
function fixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'hamster-install-test-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const resourcesDir=path.join(root,'中文 安装','resources');fs.mkdirSync(resourcesDir,{recursive:true});
  const manifest={id:'pytest-2',platform:'win32-x64',archiveSha256:hash('zip'),files:{'python.exe':hash('py'),'bootstrap.py':hash('boot'),'Lib/sample.py':hash('sample')}};
  fs.writeFileSync(path.join(resourcesDir,'python-runtime.json'),JSON.stringify(manifest));fs.writeFileSync(path.join(resourcesDir,'python-runtime.zip'),'zip');
  let extracts=0,checks=0;
  const extract=async(zip,dest)=>{extracts++;fs.mkdirSync(path.join(dest,'Lib'));for(const [file,content] of Object.entries({'python.exe':'py','bootstrap.py':'boot','Lib/sample.py':'sample'}))fs.writeFileSync(path.join(dest,file),content);};
  return {root,resourcesDir,manifest,extract,check:async()=>{checks++;},counts:()=>({extracts,checks})};
}
test('installer verifies and smoke-tests before readiness; installed launches never unpack or create user cache',async t=>{
  const f=fixture(t);const runtime=await prepareInstalledRuntime(f);
  assert.deepEqual(f.counts(),{extracts:1,checks:1});
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.resourcesDir,MARKER))).state,'ready');
  const provider=createInstalledRuntimeProvider(f);
  const [a,b]=await Promise.all([provider(),provider()]);assert.deepEqual(a,b);assert.equal(a.python,runtime.python);
  assert.equal(provider.progress().percent,95);assert.deepEqual(f.counts(),{extracts:1,checks:1});
  // Even without the archive, normal installed launches can use the verified environment.
  fs.unlinkSync(path.join(f.resourcesDir,'python-runtime.zip'));
  assert.equal((await createInstalledRuntimeProvider(f)()).python,runtime.python);
});
test('failed install check remains unready, then explicit installer retry can complete',async t=>{
  const f=fixture(t);
  await assert.rejects(prepareInstalledRuntime({...f,check:async()=>{throw Error('smoke failed');}}),/smoke failed/);
  await assert.rejects(createInstalledRuntimeProvider(f)(),/重新运行安装包修复/);
  await prepareInstalledRuntime(f);assert.equal(f.counts().extracts,1);
  assert.ok((await createInstalledRuntimeProvider(f)()).python);
});
test('missing marker, stale version, and damaged executable require repair without silent portable fallback',async t=>{
  const f=fixture(t);await assert.rejects(createInstalledRuntimeProvider(f)(),/环境不完整/);
  const runtime=await prepareInstalledRuntime(f);
  const marker=path.join(f.resourcesDir,MARKER),saved=fs.readFileSync(marker);
  fs.writeFileSync(marker,JSON.stringify({state:'ready',id:'py-stale'}));await assert.rejects(createInstalledRuntimeProvider(f)(),/环境不完整/);
  fs.writeFileSync(marker,saved);fs.writeFileSync(runtime.python,'damaged');await assert.rejects(createInstalledRuntimeProvider(f)(),/环境不完整/);
  const personal=path.join(f.root,'personal.json');fs.writeFileSync(personal,'customer data');
  await prepareInstalledRuntime(f);assert.equal(fs.readFileSync(personal,'utf8'),'customer data');
  assert.equal(f.counts().extracts,2);assert.ok((await createInstalledRuntimeProvider(f)()).python);
});
test('installer hook waits for prep, aborts on failure, and retains customer app data',()=>{
  const pkg=require('../package.json'),hook=fs.readFileSync(path.join(__dirname,'../electron/installer.nsh'),'utf8');
  assert.equal(pkg.build.nsis.deleteAppDataOnUninstall,false);assert.equal(pkg.build.nsis.oneClick,false);
  assert.match(hook,/ExecWait.*--hamster-prepare-installed-runtime/);assert.match(hook,/SetErrorLevel 1/);assert.match(hook,/Abort/);
  const main=fs.readFileSync(path.join(__dirname,'../electron/main.cjs'),'utf8');
  assert.match(main,/installingRuntime \|\| removingRuntime \|\| app.requestSingleInstanceLock/);
  assert.match(main,/!process.env.PORTABLE_EXECUTABLE_FILE/);
});

test('uninstaller removes only generated environment, including long paths; retains personal files and archive',async t=>{
  const f=fixture(t);const runtime=await prepareInstalledRuntime(f);
  const nested=path.join(path.dirname(runtime.python),'nested-'.repeat(20),'nested-'.repeat(20));
  fs.mkdirSync(path.toNamespacedPath(nested),{recursive:true});fs.writeFileSync(path.toNamespacedPath(path.join(nested,'test.txt')),'test');
  fs.writeFileSync(path.join(f.root,'personal.txt'),'keep');
  await removeInstalledRuntime(f);
  assert.ok(!fs.existsSync(path.join(f.resourcesDir,'installed-runtimes')));
  assert.ok(!fs.existsSync(path.join(f.resourcesDir,MARKER)));
  assert.ok(fs.existsSync(path.join(f.resourcesDir,'python-runtime.zip')));
  assert.equal(fs.readFileSync(path.join(f.root,'personal.txt'),'utf8'),'keep');
});
