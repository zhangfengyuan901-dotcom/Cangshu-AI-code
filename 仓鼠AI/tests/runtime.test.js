const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {EventEmitter}=require('node:events');
const {PassThrough}=require('node:stream');
const {createRuntimeProvider,safeChild}=require('../runtime.cjs');
const {createSmartVideoLauncher}=require('../server.js');
const {createDiagnostics}=require('../diagnostics.cjs');
const hash=s=>crypto.createHash('sha256').update(s).digest('hex');
function fixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'hamster-runtime-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const resourcesDir=path.join(root,'resources'),cacheDir=path.join(root,'中文 cache');
  fs.mkdirSync(resourcesDir);const files={'python.exe':hash('python'),'bootstrap.py':hash('boot')};
  fs.writeFileSync(path.join(resourcesDir,'python-runtime.json'),JSON.stringify({id:'pytest-1',platform:'win32-x64',files,archiveSha256:hash('zip')}));
  fs.writeFileSync(path.join(resourcesDir,'python-runtime.zip'),'zip');
  let extracts=0;
  const extract=async(zip,dest)=>{extracts++;fs.writeFileSync(path.join(dest,'python.exe'),'python');fs.writeFileSync(path.join(dest,'bootstrap.py'),'boot');};
  return {root,resourcesDir,cacheDir,extract,count:()=>extracts};
}
function mockChild(){const c=new EventEmitter();c.exitCode=null;c.stdout=new PassThrough();c.stderr=new PassThrough();c.kill=()=>{c.killed=true;};return c;}
const offline=async()=>{throw Error('offline');};
test('bundled runtime excludes removed smart-video framework dependencies',()=>{
  const lock=fs.readFileSync(path.join(__dirname,'../smart-video-agent/runtime-requirements.lock'),'utf8');
  assert.match(lock,/^fastapi==/m);assert.match(lock,/^moviepy==/m);assert.match(lock,/^volcengine-python-sdk==/m);
  assert.doesNotMatch(lock,/^(?:google-adk|veadk-python|agentkit-sdk-python|litellm)==/m);
});
test('desktop defers workflow copying until workbench prewarm or user action',()=>{
  const main=fs.readFileSync(path.join(__dirname,'../electron/main.cjs'),'utf8');
  assert.match(main,/smartVideoDir:\s*getSmartVideoWorkflow/);
  assert.match(main,/await require\('\.\/workflow-sync\.cjs'\)\.syncWorkflow\(source, target, app\.getVersion\(\)\)/);
  const ready=main.slice(main.indexOf('app.whenReady()'));
  assert.doesNotMatch(ready,/const smartVideoDir = prepareSmartVideoWorkflow\(\)/);
});
test('runtime extracts once, survives relocation, verifies reuse, and repairs corrupted cache without deleting data',async t=>{
  const f=fixture(t),provider=createRuntimeProvider(f);
  assert.equal(provider.progress().percent,0);
  const [a,b]=await Promise.all([provider(),provider()]);assert.deepEqual(a,b);assert.equal(f.count(),1);
  assert.equal(provider.progress().percent,95); // Only health checks may claim 100%.
  fs.mkdirSync(path.join(path.dirname(a.python),'__pycache__'));fs.writeFileSync(path.join(path.dirname(a.python),'__pycache__/fixture.pyc'),'mutable cache');
  await createRuntimeProvider(f)();assert.equal(f.count(),1);
  fs.writeFileSync(a.python,'corrupt');await createRuntimeProvider(f)();assert.equal(f.count(),2);
  assert.ok(fs.readdirSync(f.cacheDir).some(x=>x.includes('-replaced-')));
});
test('background preparation is nonblocking, deduplicated and never opens browser',async t=>{
  let release,healthy=false,spawns=0,opens=0;
  const c=mockChild(),pending=new Promise(resolve=>release=resolve);
  const provider=()=>pending;provider.progress=()=>({percent:42,stage:'释放内置环境'});
  const launcher=createSmartVideoLauncher({runtimeProvider:provider,fetchImpl:async()=>({status:200,json:async()=>healthy?{app:'hamster-smart-video',chat:true,creative:false}:{}}),
    portProbe:async()=>({state:'available'}),spawnImpl:()=>{spawns++;return c;},openExternal:()=>opens++});
  t.after(()=>launcher.stop());
  await Promise.all([launcher.prepare(),launcher.prepare()]);
  assert.equal((await launcher.status()).progress.percent,42);
  assert.equal(spawns,0);assert.equal(opens,0);
  release({python:'fixture-python',bootstrap:'fixture-bootstrap',id:'fixture'});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(spawns,1);assert.equal((await launcher.status()).progress.percent,95);
  healthy=true;
  assert.equal((await launcher.prepare()).progress.percent,100);assert.equal(opens,0);
  const chatUrl=(await launcher.open('chat')).url,target=new URL(chatUrl);
  assert.equal(target.origin,'http://127.0.0.1:8000');assert.equal(target.pathname,'/chat/');
  assert.match(target.searchParams.get('instance'),/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
  assert.equal((await launcher.open('chat')).url,chatUrl);assert.equal(opens,0);assert.equal(spawns,1);
});
test('workflow preparation stays lazy and is shared by concurrent prewarm requests',async t=>{
  let workflowCalls=0,spawns=0;
  const child=mockChild();
  const launcher=createSmartVideoLauncher({
    workflowDir:async()=>{workflowCalls++;return path.join(__dirname,'../smart-video-agent');},
    fetchImpl:offline,portProbe:async()=>({state:'available'}),spawnImpl:()=>{spawns++;return child;},
  });
  t.after(()=>launcher.stop());
  assert.equal((await launcher.status()).status,'stopped');assert.equal(workflowCalls,0);
  await Promise.all([launcher.prepare(),launcher.prepare()]);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(workflowCalls,1);assert.equal(spawns,1);
});
test('failed background preparation can be explicitly retried',async t=>{
  let tries=0;
  const launcher=createSmartVideoLauncher({fetchImpl:offline,runtimeProvider:async()=>{tries++;throw Error('corrupt runtime');}});
  t.after(()=>launcher.stop());
  await launcher.prepare();await new Promise(resolve=>setImmediate(resolve));
  assert.equal((await launcher.status()).status,'error');
  await launcher.prepare();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(tries,2);assert.equal((await launcher.status()).status,'error');
});
test('corrupt archive and partial extraction never become usable runtime; subsequent call can retry',async t=>{
  const f=fixture(t);fs.writeFileSync(path.join(f.resourcesDir,'python-runtime.zip'),'corrupt');
  await assert.rejects(createRuntimeProvider(f)(),/校验失败/);assert.equal(f.count(),0);
  fs.writeFileSync(path.join(f.resourcesDir,'python-runtime.zip'),'zip');
  await assert.rejects(createRuntimeProvider({...f,extract:async()=>{}})(),/释放不完整/);
  assert.ok(!fs.existsSync(path.join(f.cacheDir,'pytest-1')));
  assert.ok(fs.existsSync((await createRuntimeProvider(f)()).python));
  assert.throws(()=>safeChild(f.root,'../escape'),/路径无效/);
});
test('occupied preferred port switches automatically; isolated bundled runtime wins over installed Python; concurrent opens spawn once',async t=>{
  const f=fixture(t),c=mockChild();let calls=0,spawned,opened,token;
  const launcher=createSmartVideoLauncher({requireIdentity:true,fetchImpl:async()=>({status:200,json:async()=>token?{app:'hamster-smart-video',version:26,creative:false,chat:true,instance:token}: {app:'other'}}),
    runtimeProvider:createRuntimeProvider(f),allocatePort:async()=>23456,portProbe:async()=>({state:'occupied',port:8000}),
    openExternal:url=>opened=url,spawnImpl:(command,args,options)=>{calls++;spawned={command,args,options};return c;}});
  t.after(()=>launcher.stop());
  const results=await Promise.all([launcher.open(),launcher.open('chat')]);
  assert.ok(results.every(x=>x.url==='http://127.0.0.1:23456/'));assert.equal(calls,1);
  assert.match(spawned.command,/中文 cache/);assert.equal(spawned.args[0],'-I');assert.ok(!spawned.args.includes('run'));
  token=spawned.options.env.HAMSTER_SERVICE_INSTANCE;
  assert.equal((await launcher.status()).status,'ready');
  assert.equal((await launcher.open('chat')).url,'http://127.0.0.1:23456/chat/?instance='+token);assert.equal(opened,undefined);assert.equal(calls,1);
});
test('another instance or wrong version never passes owned-service health check',async t=>{
  let token='wrong',version=26;
  const c=mockChild();let spawns=0;
  const launcher=createSmartVideoLauncher({requireIdentity:true,portProbe:async()=>({state:'available'}),
    fetchImpl:async()=>({status:200,json:async()=>({app:'hamster-smart-video',version,instance:token})}),
    spawnImpl:(cmd,args,opts)=>{token=opts.env.HAMSTER_SERVICE_INSTANCE;spawns++;return c;}});
  t.after(()=>launcher.stop());assert.equal((await launcher.open()).status,'starting');assert.equal(spawns,1);
  version=25;assert.equal((await launcher.status()).status,'starting');version=26;assert.equal((await launcher.status()).status,'ready');
});
test('closing app during extraction prevents late child spawn',async()=>{
  let release;const waiting=new Promise(r=>release=r);
  const launcher=createSmartVideoLauncher({fetchImpl:offline,runtimeProvider:()=>waiting,spawnImpl:()=>{throw Error('must not spawn');}});
  const opening=launcher.open();await new Promise(r=>setImmediate(r));launcher.stop();release({});
  assert.equal((await opening).status,'stopped');
});
test('closing chat during a pending health check cannot return a late ready URL',async()=>{
  let release;const health=new Promise(resolve=>release=resolve);
  const launcher=createSmartVideoLauncher({fetchImpl:()=>health,spawnImpl:()=>assert.fail('closed launcher cannot spawn')});
  const opening=launcher.open();launcher.stop();
  release({status:200,json:async()=>({app:'hamster-smart-video',version:26,chat:true})});
  assert.equal((await opening).status,'stopped');assert.equal((await launcher.status()).status,'stopped');assert.equal((await launcher.open()).status,'stopped');
});
test('invalid dynamically allocated chat ports cannot start a process or become an open URL',async t=>{
  for(const port of [0,65536,'23456',NaN]){
    const launcher=createSmartVideoLauncher({fetchImpl:offline,portProbe:async()=>({state:'occupied'}),allocatePort:async()=>port,
      spawnImpl:()=>assert.fail('invalid port cannot launch')});t.after(()=>launcher.stop());
    assert.equal((await launcher.open()).code,'PORT_UNAVAILABLE');
  }
});
test('unhealthy child times out and only owned process is stopped',async t=>{
  const c=mockChild();
  const launcher=createSmartVideoLauncher({fetchImpl:offline,portProbe:async()=>({state:'available'}),spawnImpl:()=>c,startupTimeoutMs:15});
  t.after(()=>launcher.stop());await launcher.open();await new Promise(r=>setTimeout(r,40));
  assert.equal((await launcher.status()).code,'STARTUP_TIMEOUT');assert.ok(c.killed);
});
test('port bind race retries only bounded times, preserves diagnostic history',async t=>{
  const f=fixture(t),diag=createDiagnostics({dir:path.join(f.root,'logs'),exportDir:path.join(f.root,'exports')});
  const children=[];
  const launcher=createSmartVideoLauncher({diagnostics:diag,fetchImpl:offline,portProbe:async()=>({state:'occupied'}),allocatePort:async()=>23457,
    spawnImpl:()=>{const c=mockChild();children.push(c);return c;}});
  t.after(()=>launcher.stop());await launcher.open();
  for(let n=0;n<4;n++){const c=children[n];c.stderr.write('ERROR: [WinError 10048] address already in use\n');c.exitCode=1;c.emit('close',1,null);await new Promise(r=>setImmediate(r));}
  assert.equal(children.length,4);assert.equal((await launcher.status()).code,'PORT_IN_USE');
});
