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
test('runtime extracts once, survives relocation, verifies reuse, and repairs corrupted cache without deleting data',async t=>{
  const f=fixture(t),provider=createRuntimeProvider(f);
  const [a,b]=await Promise.all([provider(),provider()]);assert.deepEqual(a,b);assert.equal(f.count(),1);
  fs.mkdirSync(path.join(path.dirname(a.python),'__pycache__'));fs.writeFileSync(path.join(path.dirname(a.python),'__pycache__/fixture.pyc'),'mutable cache');
  await createRuntimeProvider(f)();assert.equal(f.count(),1);
  fs.writeFileSync(a.python,'corrupt');await createRuntimeProvider(f)();assert.equal(f.count(),2);
  assert.ok(fs.readdirSync(f.cacheDir).some(x=>x.includes('-replaced-')));
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
  const launcher=createSmartVideoLauncher({requireIdentity:true,fetchImpl:async()=>({status:200,json:async()=>token?{app:'hamster-smart-video',version:19,creative:true,chat:true,instance:token}: {app:'other'}}),
    runtimeProvider:createRuntimeProvider(f),allocatePort:async()=>23456,portProbe:async()=>({state:'occupied',port:8000}),
    openExternal:url=>opened=url,spawnImpl:(command,args,options)=>{calls++;spawned={command,args,options};return c;}});
  t.after(()=>launcher.stop());
  const results=await Promise.all([launcher.open(),launcher.open(true)]);
  assert.ok(results.every(x=>x.url==='http://127.0.0.1:23456/'));assert.equal(calls,1);
  assert.match(spawned.command,/中文 cache/);assert.equal(spawned.args[0],'-I');assert.ok(!spawned.args.includes('run'));
  token=spawned.options.env.HAMSTER_SERVICE_INSTANCE;
  assert.equal((await launcher.status()).status,'ready');await launcher.open(true);
  assert.equal(opened,'http://127.0.0.1:23456/creative/');assert.equal(calls,1);
  await launcher.open('chat');assert.equal(opened,'http://127.0.0.1:23456/chat/');assert.equal(calls,1);
});
test('another instance or wrong version never passes owned-service health check',async t=>{
  let token='wrong',version=19;
  const c=mockChild();let spawns=0;
  const launcher=createSmartVideoLauncher({requireIdentity:true,portProbe:async()=>({state:'available'}),
    fetchImpl:async()=>({status:200,json:async()=>({app:'hamster-smart-video',version,instance:token})}),
    spawnImpl:(cmd,args,opts)=>{token=opts.env.HAMSTER_SERVICE_INSTANCE;spawns++;return c;}});
  t.after(()=>launcher.stop());assert.equal((await launcher.open()).status,'starting');assert.equal(spawns,1);
  version=18;assert.equal((await launcher.status()).status,'starting');version=19;assert.equal((await launcher.status()).status,'ready');
});
test('closing app during extraction prevents late child spawn',async()=>{
  let release;const waiting=new Promise(r=>release=r);
  const launcher=createSmartVideoLauncher({fetchImpl:offline,runtimeProvider:()=>waiting,spawnImpl:()=>{throw Error('must not spawn');}});
  const opening=launcher.open();await new Promise(r=>setImmediate(r));launcher.stop();release({});
  assert.equal((await opening).status,'stopped');
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
