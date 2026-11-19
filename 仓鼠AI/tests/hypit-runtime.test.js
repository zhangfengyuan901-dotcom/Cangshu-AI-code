'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {EventEmitter}=require('node:events');
const {PassThrough}=require('node:stream');
const {execFileSync}=require('node:child_process');
const {createHypitRuntime,loopbackUrl,HYPIT_VERSION,HYPIT_SOURCE_COMMIT}=require('../hypit-runtime.cjs');

function child(){
  const item=new EventEmitter();item.exitCode=null;item.stdout=new PassThrough();item.stderr=new PassThrough();
  item.kill=()=>{item.killed=true;item.exitCode=0;setImmediate(()=>item.emit('close',0));return true;};return item;
}
function fixture(t,extra={}){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'hamster-hypit-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const distributionRoot=path.join(root,'distribution'),workspaceRoot=path.join(root,'internal-projects');
  fs.mkdirSync(path.join(distributionRoot,'bin'),{recursive:true});
  fs.writeFileSync(path.join(distributionRoot,'package.json'),JSON.stringify({name:'@hypit/hypit',version:HYPIT_VERSION}));
  fs.writeFileSync(path.join(distributionRoot,'bin','hypit.mjs'),'// mocked official entry');
  for(const [name,exports] of Object.entries({'tsx':{'./esm/api':'./index.js'},'@hypit/video':{'.':'./index.js'},'@hypit/studio':{'./start':'./index.js'},'vite':{'.':'./index.js'}})){
    const directory=path.join(distributionRoot,'node_modules',name);fs.mkdirSync(directory,{recursive:true});
    fs.writeFileSync(path.join(directory,'package.json'),JSON.stringify({name,exports}));fs.writeFileSync(path.join(directory,'index.js'),'// dependency fixture');
  }
  const metadataPath=path.join(root,'runtime.json');
  fs.writeFileSync(metadataPath,JSON.stringify({format:'hamster.hypit-runtime@1',hypit:{version:HYPIT_VERSION,sourceCommit:HYPIT_SOURCE_COMMIT}}));
  const children=[],spawns=[];
  const runtime=createHypitRuntime({workspaceRoot,distributionRoot,metadataPath,nodeExecutable:process.execPath,
    allocatePort:async()=>25421,probeHttp:async()=>true,startupTimeoutMs:150,probeIntervalMs:5,stopTimeoutMs:50,
    spawnImpl:(command,args,options)=>{const c=child();children.push(c);spawns.push({command,args,options});setImmediate(()=>c.stdout.write('  Local: http://localhost:25421/\n'));return c;},...extra});
  t.after(()=>runtime.dispose());
  return {root,distributionRoot,metadataPath,workspaceRoot,runtime,children,spawns};
}

test('new isolated project contains only deterministic local Film and keeps existing project unchanged',t=>{
  const f=fixture(t),created=f.runtime.prepareProject({projectId:'project-one',label:'内部 Hypit'});
  assert.equal(created.runRelativePath,'build.svrun');
  const directory=f.runtime.projectDirectory(created.id);
  const manifest=JSON.parse(fs.readFileSync(path.join(directory,'package.json'),'utf8'));
  assert.equal(manifest.hypit.project,true);
  const source=fs.readFileSync(path.join(directory,'main.svml'),'utf8');
  assert.match(source,/<film:Film/);assert.doesNotMatch(source,/TextVideo|fetch|https?:\/\/|credential|secret|api.?key/i);
  fs.writeFileSync(path.join(directory,'preserved.txt'),'keep');
  assert.throws(()=>f.runtime.prepareProject({projectId:created.id}),{code:'PROJECT_EXISTS'});
  assert.equal(fs.readFileSync(path.join(directory,'preserved.txt'),'utf8'),'keep');
  fs.mkdirSync(path.join(f.workspaceRoot,'unowned'));assert.equal(f.runtime.listProjects().length,1);
  assert.deepEqual(f.runtime.listProjects()[0],created);
});

test('malformed identifiers, paths, missing runs and symlinked projects cannot launch',async t=>{
  const f=fixture(t);f.runtime.prepareProject({projectId:'valid'});
  for(const value of ['../escape','C:\\secret','a/b','','CON:foo'])assert.throws(()=>f.runtime.prepareProject({projectId:value}),{code:'INVALID_PROJECT'});
  for(const value of ['../build.svrun','sub/../build.svrun','/build.svrun','C:/build.svrun','sub\\file.svrun','file.json','./build.svrun']){
    await assert.rejects(f.runtime.startStudio({projectId:'valid',runRelativePath:value}),{code:'INVALID_RUN_PATH'});
  }
  await assert.rejects(f.runtime.startStudio({projectId:'valid',runRelativePath:'missing.svrun'}),{code:'INVALID_RUN'});
  const external=path.join(f.root,'outside');fs.mkdirSync(external);
  try{fs.symlinkSync(external,path.join(f.workspaceRoot,'linked'),process.platform==='win32'?'junction':'dir');}
  catch(error){if(error.code==='EPERM'){t.diagnostic('symlink fixture unavailable');return;}throw error;}
  await assert.rejects(f.runtime.startStudio({projectId:'linked'}),{code:'INVALID_PATH'});
  assert.equal(f.spawns.length,0);
});

test('loopback parser rejects network, userinfo, path, query and insecure protocol variations',()=>{
  for(const url of ['https://localhost:5179/','http://example.com:5179/','http://127.0.0.2:5179/','http://localhost.evil:5179/','http://user:pass@localhost:5179/','http://localhost:5179/private','http://localhost:5179/?token=private','http://localhost/'])assert.equal(loopbackUrl(url),null);
  assert.equal(loopbackUrl('http://localhost:5179/#comments'),'http://localhost:5179/');
  assert.equal(loopbackUrl('http://[::1]:58317/'),'http://[::1]:58317/');
});

test('Studio launch uses official CLI, selected project and actual loopback URL, with no inherited credentials',async t=>{
  const saved=process.env.OPENAI_API_KEY;process.env.OPENAI_API_KEY='fixture-must-not-leak';
  t.after(()=>{if(saved===undefined)delete process.env.OPENAI_API_KEY;else process.env.OPENAI_API_KEY=saved;});
  let probedUrl;
  const f=fixture(t,{probeHttp:async url=>{probedUrl=url;return true;},spawnImpl:(command,args,options)=>{
    const c=child();f.children.push(c);f.spawns.push({command,args,options});
    setImmediate(()=>{c.stderr.write('must-not-leak key and private path\n');c.stdout.write('Local: http://[::1]:25422/\n');});return c;
  }});
  const p=f.runtime.prepareProject({projectId:'ready'});
  const [a,b]=await Promise.all([f.runtime.startStudio({projectId:p.id}),f.runtime.startStudio({projectId:p.id})]);
  assert.equal(a.state,'ready');assert.deepEqual(a,b);assert.equal(a.url,'http://127.0.0.1:25422/');assert.equal(probedUrl,a.url);assert.equal(f.spawns.length,1);
  assert.equal(a.installed,true);
  const launch=f.spawns[0];assert.equal(launch.options.windowsHide,true);assert.equal(launch.options.shell,false);
  assert.equal(launch.options.env.OPENAI_API_KEY,undefined);assert.equal(launch.options.env.USERPROFILE,undefined);assert.equal(launch.options.env.NODE_OPTIONS,undefined);
  if(process.env.SystemRoot)assert.ok(launch.options.env.PATH.includes(path.join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0')));
  assert.ok(launch.args.includes('--project'));assert.ok(launch.args.includes('--port'));assert.ok(!launch.args.includes('--host'));
  assert.equal(launch.args[0],'--dns-result-order=ipv4first');assert.match(launch.args[1],/hypit\.mjs$/);
  assert.doesNotMatch(JSON.stringify(a),/must-not-leak|private|fixture|OPENAI/);
  await f.runtime.startStudio({projectId:p.id});assert.equal(f.spawns.length,1);
  await f.runtime.stop();assert.equal(f.children[0].killed,true);assert.equal(f.runtime.status().state,'stopped');
  assert.equal(f.runtime.status().installed,true);
});

test('only explicit ephemeral bridge fields may enter child environment',async t=>{
  const f=fixture(t,{envProvider:()=>({HAMSTER_HYPIT_BRIDGE_URL:'http://127.0.0.1:22345/api/hypit/bridge',HAMSTER_HYPIT_BRIDGE_TOKEN:'fixture-ephemeral-token-00000000',OPENAI_API_KEY:'never-copy'})});
  f.runtime.prepareProject({projectId:'bridge'});await f.runtime.startStudio({projectId:'bridge'});
  assert.equal(f.spawns[0].options.env.HAMSTER_HYPIT_BRIDGE_TOKEN,'fixture-ephemeral-token-00000000');
  assert.equal(f.spawns[0].options.env.OPENAI_API_KEY,undefined);assert.doesNotMatch(JSON.stringify(f.runtime.status()),/ephemeral-token/);
});

test('child PATH accepts only explicit existing absolute tool directories, never the parent PATH',async t=>{
  const f=fixture(t),tools=path.join(f.root,'trusted-tools'),lateTools=path.join(f.root,'late-tools'),missing=path.join(f.root,'optional-missing');fs.mkdirSync(tools);
  const saved=process.env.PATH;process.env.PATH='parent-private-tool-path';
  t.after(()=>{process.env.PATH=saved;});
  let launched;
  const runtime=createHypitRuntime({workspaceRoot:f.workspaceRoot,distributionRoot:f.distributionRoot,metadataPath:f.metadataPath,nodeExecutable:process.execPath,
    toolDirectories:[tools,tools,lateTools,missing],allocatePort:async()=>25421,probeHttp:async()=>true,
    spawnImpl:(_command,_args,options)=>{launched=options;const c=child();setImmediate(()=>c.stdout.write('http://localhost:25421/\n'));return c;}});
  t.after(()=>runtime.dispose());runtime.prepareProject({projectId:'tools'});fs.mkdirSync(lateTools);await runtime.startStudio({projectId:'tools'});
  const entries=launched.env.PATH.split(path.delimiter);assert.equal(entries.filter(entry=>entry===fs.realpathSync(tools)).length,1);assert.doesNotMatch(launched.env.PATH,/parent-private-tool-path/);
  assert.ok(entries.includes(fs.realpathSync(lateTools)));assert.ok(!entries.includes(missing));
  for(const toolDirectories of [['relative/tools'],[tools+path.delimiter+'private'],[''],null,'tools']){
    assert.throws(()=>createHypitRuntime({workspaceRoot:f.workspaceRoot,toolDirectories}),{code:'INVALID_TOOL_DIRECTORIES'});
  }
  const invalid=createHypitRuntime({workspaceRoot:f.workspaceRoot,distributionRoot:f.distributionRoot,metadataPath:f.metadataPath,toolDirectories:[path.join(f.distributionRoot,'package.json')]});
  await assert.rejects(invalid.startStudio({projectId:'tools'}),{code:'INVALID_TOOL_DIRECTORIES'});
});

test('invalid bridge configuration fails closed and does not retain starting state',async t=>{
  const f=fixture(t,{envProvider:()=>({HAMSTER_HYPIT_BRIDGE_URL:'https://not-local.invalid/',HAMSTER_HYPIT_BRIDGE_TOKEN:'fixture-ephemeral-token-00000000'})});
  f.runtime.prepareProject({projectId:'invalid-bridge'});
  assert.equal((await f.runtime.startStudio({projectId:'invalid-bridge'})).code,'INVALID_BRIDGE_CONFIGURATION');
  assert.equal(f.runtime.status().state,'error');assert.equal(f.spawns.length,0);
});

test('runtime Profile is explicit, contained, unlinked JSON and participates in child reuse',async t=>{
  const f=fixture(t);f.runtime.prepareProject({projectId:'profile'});const directory=f.runtime.projectDirectory('profile');
  const first=path.join(directory,'one.runtime.json'),second=path.join(directory,'two.runtime.json');
  fs.writeFileSync(first,'{}');fs.writeFileSync(second,'{}');
  await f.runtime.startStudio({projectId:'profile',runtimeProfilePath:first});
  assert.deepEqual(f.spawns[0].args.slice(-2),['--runtime',first]);
  assert.equal(f.runtime.status().runtimeProfileRelativePath,'one.runtime.json');
  await f.runtime.startStudio({projectId:'profile',runtimeProfilePath:first});assert.equal(f.spawns.length,1);
  await f.runtime.startStudio({projectId:'profile',runtimeProfilePath:second});assert.equal(f.spawns.length,2);assert.equal(f.children[0].killed,true);
  for(const value of ['one.runtime.json',path.join(f.root,'outside.json'),path.join(directory,'missing.json'),path.join(directory,'main.svml'),123]){
    await assert.rejects(f.runtime.startStudio({projectId:'profile',runtimeProfilePath:value}),{code:'INVALID_RUNTIME_PROFILE'});
  }
  const linked=path.join(directory,'link.runtime.json');
  try{fs.symlinkSync(first,linked,'file');await assert.rejects(f.runtime.startStudio({projectId:'profile',runtimeProfilePath:linked}),{code:'INVALID_RUNTIME_PROFILE'});}
  catch(error){if(error.code!=='EPERM')throw error;}
  assert.equal(f.spawns.length,2);
});

test('saved-result preview creates isolated native Sources, keeps main and assets unchanged, and is idempotent',t=>{
  const f=fixture(t);f.runtime.prepareProject({projectId:'saved'});const directory=f.runtime.projectDirectory('saved');
  const original=fs.readFileSync(path.join(directory,'main.svml'),'utf8'),pkg=fs.readFileSync(path.join(directory,'package.json'),'utf8');
  fs.mkdirSync(path.join(directory,'assets'));fs.writeFileSync(path.join(directory,'assets','clip & one.mp4'),'synthetic-byte-fixture');
  const input={projectId:'saved',operationId:'shot-1',videoPath:'assets/clip & one.mp4',duration:4,width:1280,height:720,hasAudio:true};
  const preview=f.runtime.prepareVideoPreview(input),author=fs.readFileSync(path.join(directory,preview.sourceRelativePath),'utf8');
  assert.match(preview.runRelativePath,/^result-[a-f0-9]{64}\.svrun$/);
  assert.match(author,/src="\.\/assets\/clip &amp; one\.mp4"/);assert.match(author,/<mediaop:Normalize/);assert.match(author,/<audio:Clip/);
  assert.doesNotMatch(author,/hamster:Video|https?:\/\/|generate/i);
  assert.deepEqual(f.runtime.prepareVideoPreview(input),preview);
  assert.equal(fs.readFileSync(path.join(directory,'main.svml'),'utf8'),original);assert.equal(fs.readFileSync(path.join(directory,'package.json'),'utf8'),pkg);
  assert.equal(fs.readFileSync(path.join(directory,'assets','clip & one.mp4'),'utf8'),'synthetic-byte-fixture');assert.equal(f.spawns.length,0);
  fs.appendFileSync(path.join(directory,preview.sourceRelativePath),'<!-- user edit -->');
  assert.throws(()=>f.runtime.prepareVideoPreview(input),{code:'PREVIEW_SOURCE_CONFLICT'});
  const silent=f.runtime.prepareVideoPreview({...input,operationId:'silent',hasAudio:false});
  assert.doesNotMatch(fs.readFileSync(path.join(directory,silent.sourceRelativePath),'utf8'),/<audio:Track/);
});

test('saved-result preview refuses unknown audio, invalid dimensions, empty files and escaped/linked asset paths',t=>{
  const f=fixture(t);f.runtime.prepareProject({projectId:'boundaries'});const directory=f.runtime.projectDirectory('boundaries');
  fs.mkdirSync(path.join(directory,'assets'));fs.writeFileSync(path.join(directory,'assets','clip.mp4'),'synthetic');fs.writeFileSync(path.join(directory,'assets','empty.mp4'),'');
  const input={projectId:'boundaries',operationId:'shot-1',videoPath:'assets/clip.mp4',duration:4,width:1280,height:720,hasAudio:false};
  for(const overrides of [{hasAudio:undefined},{hasAudio:'false'},{duration:0},{width:1},{height:Infinity},{operationId:'../x'}])assert.throws(()=>f.runtime.prepareVideoPreview({...input,...overrides}),{code:'INVALID_PREVIEW_METADATA'});
  for(const videoPath of ['../clip.mp4','assets/../clip.mp4','assets\\clip.mp4','C:/clip.mp4','assets/empty.mp4','main.svml','assets/missing.mp4','assets/file.json'])assert.throws(()=>f.runtime.prepareVideoPreview({...input,videoPath}),{code:'INVALID_PREVIEW_PATH'});
  try{fs.symlinkSync(path.join(directory,'assets','clip.mp4'),path.join(directory,'assets','linked.mp4'),'file');assert.throws(()=>f.runtime.prepareVideoPreview({...input,videoPath:'assets/linked.mp4'}),{code:'INVALID_PREVIEW_PATH'});}
  catch(error){if(error.code!=='EPERM')throw error;}
  assert.equal(fs.readdirSync(directory).some(name=>name.startsWith('result-')),false);
});

const officialRoot=path.resolve(__dirname,'../build/hypit-host/node_modules/@hypit/hypit');
const bundledNode=path.resolve(__dirname,'../build/node-runtime/node.exe');
test('pinned official SDK checks both silent and audio saved-result Runs without executing a Build',{
  skip:!fs.existsSync(path.join(officialRoot,'bin','hypit.mjs'))||!fs.existsSync(bundledNode),
},t=>{
  const f=fixture(t);f.runtime.prepareProject({projectId:'sdk-preview'});const directory=f.runtime.projectDirectory('sdk-preview');
  fs.mkdirSync(path.join(directory,'assets'));fs.writeFileSync(path.join(directory,'assets','fixture.mp4'),'synthetic-check-only-not-a-real-video');
  const env={};for(const key of ['SystemRoot','WINDIR','TEMP','TMP'])if(process.env[key])env[key]=process.env[key];env.PATH=path.dirname(bundledNode);
  for(const hasAudio of [false,true]){
    const preview=f.runtime.prepareVideoPreview({projectId:'sdk-preview',operationId:hasAudio?'audio':'silent',videoPath:'assets/fixture.mp4',duration:.5,width:64,height:64,hasAudio});
    const output=execFileSync(bundledNode,[path.join(officialRoot,'bin','hypit.mjs'),'check',path.join(directory,preview.runRelativePath),'--project',directory,'--json'],{windowsHide:true,env,timeout:15000,encoding:'utf8'});
    const checked=JSON.parse(output);assert.equal(checked.format,'hypit.cli-check@1');assert.equal(checked.ok,true);assert.equal(checked.targetCount,1);
  }
  assert.equal(f.spawns.length,0);
});

test('missing setup and wrong pinned package fail before any spawn',async t=>{
  const f=fixture(t);f.runtime.prepareProject({projectId:'setup'});
  fs.writeFileSync(path.join(f.distributionRoot,'package.json'),JSON.stringify({name:'@hypit/hypit',version:'999.0.0'}));
  assert.equal(f.runtime.status().code,'RUNTIME_VERSION_MISMATCH');
  assert.equal(f.runtime.status().installed,false);
  await assert.rejects(f.runtime.startStudio({projectId:'setup'}),{code:'RUNTIME_VERSION_MISMATCH'});assert.equal(f.spawns.length,0);
  const missing=createHypitRuntime({workspaceRoot:path.join(f.root,'missing')});assert.equal(missing.status().code,'RUNTIME_NOT_CONFIGURED');
  const g=fixture(t);fs.unlinkSync(path.join(g.distributionRoot,'node_modules','@hypit','studio','index.js'));
  assert.equal(g.runtime.status().state,'unavailable');assert.equal(g.runtime.status().installed,false);
});

test('a child failing compile or exiting after readiness reports safe error and invalidates URL',async t=>{
  const f=fixture(t);f.runtime.prepareProject({projectId:'exits'});await f.runtime.startStudio({projectId:'exits'});
  const c=f.children[0];c.exitCode=1;c.emit('close',1);assert.equal(f.runtime.status().code,'STUDIO_EXITED');assert.equal(f.runtime.status().url,null);
  const g=fixture(t,{spawnImpl:()=>{const c=child();setImmediate(()=>{c.stderr.write('Error: malformed run at private/path');c.exitCode=1;c.emit('close',1);});return c;}});
  g.runtime.prepareProject({projectId:'invalid-run'});const result=await g.runtime.startStudio({projectId:'invalid-run'});
  assert.equal(result.code,'STUDIO_EXITED');assert.doesNotMatch(JSON.stringify(result),/malformed|private/);
});

test('unexpected remote URLs and failed health checks cannot become ready or restart process',async t=>{
  let launches=0,probes=0;
  const f=fixture(t,{startupTimeoutMs:30,spawnImpl:()=>{launches++;const c=child();setImmediate(()=>c.stdout.write('http://evil.invalid:5179/\n'));return c;},probeHttp:async()=>{probes++;return true;}});
  f.runtime.prepareProject({projectId:'timeout'});const result=await f.runtime.startStudio({projectId:'timeout'});
  assert.equal(result.code,'STUDIO_START_TIMEOUT');assert.equal(probes,0);assert.equal(launches,1);
  await new Promise(resolve=>setImmediate(resolve));assert.equal(f.runtime.status().code,'STUDIO_START_TIMEOUT');
  const g=fixture(t,{startupTimeoutMs:30,probeHttp:async()=>false});g.runtime.prepareProject({projectId:'unhealthy'});
  assert.equal((await g.runtime.startStudio({projectId:'unhealthy'})).code,'STUDIO_START_TIMEOUT');assert.equal(g.spawns.length,1);
});

test('IPv6-only announcement is not converted to a usable IPv4 URL without a successful IPv4 probe',async t=>{
  const probed=[];
  const f=fixture(t,{startupTimeoutMs:30,spawnImpl:()=>{const c=child();setImmediate(()=>c.stdout.write('http://[::1]:25422/\n'));return c;},probeHttp:async url=>{probed.push(url);return false;}});
  f.runtime.prepareProject({projectId:'ipv6-only'});const result=await f.runtime.startStudio({projectId:'ipv6-only'});
  assert.equal(result.code,'STUDIO_IPV4_UNAVAILABLE');assert.equal(result.url,null);assert.ok(probed.length>0);
  assert.ok(probed.every(url=>url==='http://127.0.0.1:25422/'));
});

test('closing while allocating a port prevents late child creation; disposed runtime cannot restart',async t=>{
  let release;const waiting=new Promise(resolve=>release=resolve);
  const f=fixture(t,{allocatePort:()=>waiting});f.runtime.prepareProject({projectId:'closed'});
  const launch=f.runtime.startStudio({projectId:'closed'});await new Promise(resolve=>setImmediate(resolve));
  await f.runtime.dispose();release(25421);assert.equal((await launch).state,'stopped');assert.equal(f.spawns.length,0);
  await assert.rejects(f.runtime.startStudio({projectId:'closed'}),{code:'RUNTIME_CLOSED'});
});
