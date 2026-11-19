const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {EventEmitter}=require('node:events');
const {PassThrough}=require('node:stream');
const {createCanvasLauncher}=require('../canvas-launcher.cjs');
function fixture(t,overrides={}){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'hamster-canvas-launch-'));
  fs.mkdirSync(path.join(root,'node-runtime'),{recursive:true});fs.writeFileSync(path.join(root,'node-runtime/node.exe'),'synthetic runtime');
  fs.mkdirSync(path.join(root,'hamster-canvas/dist'),{recursive:true});fs.writeFileSync(path.join(root,'hamster-canvas/dist/index.html'),'synthetic page');
  const launches=[];let healthy=true,opens=0;
  const launcher=createCanvasLauncher({resourcesDir:root,baseUrl:()=> 'http://127.0.0.1:12000',startupTimeoutMs:100,probeIntervalMs:1,
    openExternal:()=>opens++,fetchImpl:async(url,options)=>{assert.equal(options.redirect,'manual');return Response.json({app:'hamster-canvas',version:1,instance:healthy?launches.at(-1).options.env.HAMSTER_CANVAS_INSTANCE:'wrong'});},
    spawnImpl:(command,args,options)=>{const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.kill=()=>{child.killed=true;};launches.push({command,args,options,child});return child;},...overrides});
  t.after(()=>{launcher.stop();fs.rmSync(root,{recursive:true,force:true});});
  return {launcher,launches,opens:()=>opens,setHealthy:value=>healthy=value};
}
const ready=child=>child.stdout.write('HAMSTER_CANVAS_READY:23001\n');
test('canvas opens lazily, shares one pending startup and only returns a verified loopback URL',async t=>{
  const f=fixture(t);assert.equal(f.launches.length,0);
  const first=f.launcher.open(),second=f.launcher.open('project-1');assert.equal(f.launches.length,1);
  ready(f.launches[0].child);const [a,b]=await Promise.all([first,second]);
  assert.match(a.url,/^http:\/\/127\.0\.0\.1:23001\/\?token=[a-f0-9]{64}$/);assert.equal(b.url,a.url+'&project=project-1');
  assert.equal(f.opens(),0);assert.equal(f.launches[0].options.stdio[3],'ipc');
  assert.equal((await f.launcher.open()).url,a.url);assert.equal(f.launches.length,1);
});
test('canvas cannot trust a readiness log from another service or a redirect',async t=>{
  for(const redirect of [false,true]){
    const f=fixture(t,{startupTimeoutMs:15,fetchImpl:async()=>redirect?new Response(null,{status:302,headers:{Location:'https://foreign.test'}}):Response.json({app:'hamster-canvas',version:1,instance:'wrong'})});
    const result=f.launcher.open();ready(f.launches[0].child);await assert.rejects(result,/启动超时/);assert.equal(f.launches[0].child.killed,true);
  }
});
test('canvas rejects malformed readiness ports before probing',async t=>{
  for(const port of ['0','65536','123abc','https://foreign.test']){
    const f=fixture(t,{fetchImpl:()=>assert.fail('bad port must not be probed')});
    const result=f.launcher.open();f.launches[0].child.stdout.write('HAMSTER_CANVAS_READY:'+port+'\n');await assert.rejects(result,/地址无效/);
  }
});
test('canvas stop rejects startup and a late readiness event cannot restart the service',async t=>{
  const f=fixture(t),result=f.launcher.open();const rejection=assert.rejects(result,/已关闭/);
  f.launcher.stop();ready(f.launches[0].child);await rejection;assert.equal(f.launches[0].child.killed,true);
  await assert.rejects(f.launcher.open(),/已关闭/);assert.equal(f.launches.length,1);assert.equal(f.opens(),0);
});
test('canvas stop during a reuse health check cannot return a stale ready URL',async t=>{
  let identity,release,wait=false;
  const f=fixture(t,{fetchImpl:async()=>wait?new Promise(resolve=>release=resolve):Response.json({app:'hamster-canvas',version:1,instance:identity})});
  const first=f.launcher.open();identity=f.launches[0].options.env.HAMSTER_CANVAS_INSTANCE;ready(f.launches[0].child);await first;
  wait=true;const second=f.launcher.open();const rejection=assert.rejects(second,/已关闭/);f.launcher.stop();
  release(Response.json({app:'hamster-canvas',version:1,instance:identity}));await rejection;assert.equal(f.launches.length,1);
});
test('canvas unexpected exit clears cached readiness and an explicit open starts only one replacement',async t=>{
  const f=fixture(t),first=f.launcher.open();ready(f.launches[0].child);await first;f.launches[0].child.emit('exit',1);
  const second=f.launcher.open(),third=f.launcher.open();assert.equal(f.launches.length,2);ready(f.launches[1].child);
  assert.deepEqual(await second,await third);assert.equal(f.opens(),0);
});
test('canvas exiting during startup fails safely and an explicit retry creates a new instance',async t=>{
  const f=fixture(t),first=f.launcher.open();const rejection=assert.rejects(first,/已退出/);
  f.launches[0].child.emit('exit',1);await rejection;
  const second=f.launcher.open();ready(f.launches[1].child);await second;
  assert.notEqual(f.launches[0].options.env.HAMSTER_CANVAS_INSTANCE,f.launches[1].options.env.HAMSTER_CANVAS_INSTANCE);
});
test('canvas rejects foreign or credentialed shell configuration without starting a child',async t=>{
  for(const url of ['https://127.0.0.1:12000','http://localhost:12000','http://user@127.0.0.1:12000','http://127.0.0.1:12000/path']){
    const f=fixture(t,{baseUrl:()=>url});await assert.rejects(f.launcher.open(),/本地画布地址无效/);assert.equal(f.launches.length,0);
  }
});
