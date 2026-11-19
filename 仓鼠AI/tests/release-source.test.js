const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),cp=require('node:child_process');
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'hamster-official-source-')),app=path.join(root,'app');
 const write=(name,bytes)=>{const file=path.join(root,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,bytes);return file;};
 const runtime={name:'hamster-ai',version:'1.7.96',main:'electron/main.cjs',dependencies:{}},runtimeBytes=Buffer.from(JSON.stringify(runtime,null,2)+'\n');
 const sources={
  'electron/main.cjs':'module.exports="official-source";\n',
  'electron/installer.nsh':'; fixture installer\n',
  'package-lock.json':JSON.stringify({name:runtime.name,version:runtime.version,lockfileVersion:3,packages:{'':{name:runtime.name,version:runtime.version}}}),
 };
 const tools={
  'scripts/build-canvas.cjs':'const fs=require("fs");fs.mkdirSync("canvas/dist",{recursive:true});fs.writeFileSync("canvas/dist/index.html","canvas from source");\n',
  'scripts/build-python-runtime.cjs':'const fs=require("fs"),crypto=require("crypto");const data="fresh-python-runtime";fs.mkdirSync("build");fs.writeFileSync("build/python-runtime.zip",data);fs.writeFileSync("build/python-runtime.json",JSON.stringify({archiveSha256:crypto.createHash("sha256").update(data).digest("hex")}));\n',
 };
 const record=bytes=>({bytes:Buffer.byteLength(bytes),sha256:hash(bytes)});
 for(const [name,bytes] of Object.entries({...sources,...tools}))write('app/'+name,bytes);
 write('app/package.json',JSON.stringify({...runtime,scripts:{test:'node --test'}}));
 write('app/workflow/main.py','print("official")\n');write('app/build/icon.ico','icon');
 const pins=values=>Object.fromEntries(Object.entries(values).map(([name,body])=>[name,record(body)]));
 const manifest={format:2,version:runtime.version,runtimePackage:runtime,files:pins(sources),buildSources:pins(tools),
  resourceSources:{'smart-video-agent/main.py':{source:'workflow/main.py',...record('print("official")\n')}},installerInputs:{'build/icon.ico':record('icon')}};
 const spec={format:2,version:runtime.version,sourceManifest:'release/source-manifest.json',builder:{appId:'com.hamster.ai',
  directories:{app:'@stage',output:'@artifacts',buildResources:'@build-inputs'},nsis:{deleteAppDataOnUninstall:false,include:'@stage/electron/installer.nsh'},win:{icon:'@build-inputs/icon.ico'}}};
 write('app/release/source-manifest.json',JSON.stringify(manifest));write('app/release/current.json',JSON.stringify(spec));
 const script=write('app/scripts/stage-current-release.cjs',fs.readFileSync(path.join(__dirname,'../scripts/stage-current-release.cjs')));
 t.after(()=>{assert.equal(path.dirname(path.resolve(root)),path.resolve(os.tmpdir()));fs.rmSync(root,{recursive:true,force:true});});
 const run=(...args)=>cp.spawnSync(process.execPath,[script,...args],{cwd:app,encoding:'utf8'});
 return {root,app,run,write,runtimeBytes,sources};
}
test('workspace source stages without existing archives, installers, canvas or runtime builds',t=>{
 const f=fixture(t),check=f.run('--check');
 assert.equal(check.status,0,check.stderr);assert.equal(JSON.parse(check.stdout).historicalReleaseDependencies,0);
 const out=path.join(f.root,'fixture-stage'),build=f.run('--out',out);
 assert.equal(build.status,0,build.stderr);
 assert.equal(fs.readFileSync(path.join(out,'source/electron/main.cjs'),'utf8'),f.sources['electron/main.cjs']);
 assert.deepEqual(fs.readFileSync(path.join(out,'source/package.json')),f.runtimeBytes);
 assert.equal(fs.readFileSync(path.join(out,'resource-inputs/smart-video-agent/main.py'),'utf8'),'print("official")\n');
 assert.equal(fs.readFileSync(path.join(out,'resource-inputs/hamster-canvas/dist/index.html'),'utf8'),'canvas from source');
 assert.equal(fs.readFileSync(path.join(out,'resource-inputs/python-runtime.zip'),'utf8'),'fresh-python-runtime');
 assert.equal(fs.existsSync(path.join(out,'source/tests')),false);
 assert.equal(f.run('--out',out).status,1,'must preserve an existing stage');
});
test('changed application source, dependency lock or build source cannot silently pass verification',t=>{
 const f=fixture(t);f.write('app/electron/main.cjs','module.exports="unreviewed";');assert.equal(f.run('--check').status,1);
 f.write('app/electron/main.cjs',f.sources['electron/main.cjs']);
 f.write('app/package-lock.json','{}');assert.equal(f.run('--check').status,1);
 f.write('app/package-lock.json',f.sources['package-lock.json']);
 f.write('app/scripts/build-canvas.cjs','');assert.equal(f.run('--check').status,1);
});
test('output traversal, altered source resources and package drift fail before staging',t=>{
 const f=fixture(t);assert.equal(f.run('--out','../outside').status,1);
 const out=path.join(f.root,'bad-resource');
 f.write('app/workflow/main.py','print("unreviewed")');assert.equal(f.run('--out',out).status,1);assert.equal(fs.existsSync(out),false);
 f.write('app/workflow/main.py','print("official")\n');
 const pkg=JSON.parse(fs.readFileSync(path.join(f.app,'package.json')));pkg.version='1.7.97';f.write('app/package.json',JSON.stringify(pkg));assert.equal(f.run('--check').status,1);
});
