// Installer-only preparation. No API keys, user sessions, or online dependency installs.
const fs=require('node:fs'),path=require('node:path');
const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
const {createRuntimeProvider,verify,safeChild}=require('./runtime.cjs');
const MARKER='installed-runtime.json';
const repair=()=>Object.assign(new Error('工作台环境不完整，请退出应用后重新运行安装包修复。个人配置与作品不会被清除。'),{code:'INSTALLED_RUNTIME_INCOMPLETE'});
function markerPath(resourcesDir){return path.join(resourcesDir,MARKER);}
function writeMarker(resourcesDir,value){
  const file=markerPath(resourcesDir),temporary=file+'.tmp';
  fs.writeFileSync(temporary,JSON.stringify(value));fs.renameSync(temporary,file);
}
async function smokeCheck(runtime,resourcesDir){
  const env={};
  for(const key of ['SystemRoot','WINDIR','TEMP','TMP','LOCALAPPDATA','APPDATA','USERPROFILE'])if(process.env[key])env[key]=process.env[key];
  env.PATH=path.join(process.env.SystemRoot || 'C:/Windows','System32');
  // SDK constructors require a nonempty value even for imports. This is an
  // intentionally invalid fixture, never read from or written to customer config.
  env.MODEL_AGENT_API_KEY='hamster-offline-install-check';
  env.MODEL_AGENT_API_BASE='http://127.0.0.1:1';
  env.HTTP_PROXY=env.HTTPS_PROXY=env.ALL_PROXY='http://127.0.0.1:1';
  await promisify(execFile)(runtime.python,['-I','-B',path.join(resourcesDir,'installed-runtime-check.py'),path.join(resourcesDir,'smart-video-agent')],
    {windowsHide:true,env,timeout:120000,maxBuffer:1024*1024});
}
async function prepareInstalledRuntime({resourcesDir,diagnostics={log(){}},extract,check=smokeCheck}){
  writeMarker(resourcesDir,{state:'preparing'});
  const runtime=await createRuntimeProvider({resourcesDir,cacheDir:path.join(resourcesDir,'installed-runtimes'),diagnostics,extract})();
  await check(runtime,resourcesDir);
  const manifest=JSON.parse(fs.readFileSync(path.join(resourcesDir,'python-runtime.json'),'utf8'));
  writeMarker(resourcesDir,{state:'ready',id:runtime.id,archiveSha256:manifest.archiveSha256});
  diagnostics.log('installed-runtime-ready',{id:runtime.id});
  return runtime;
}
function createInstalledRuntimeProvider({resourcesDir,diagnostics={log(){}}}){
  let pending,progress={percent:0,stage:'检查工作台'};
  const provider=()=>{
    if(!pending)pending=(async()=>{
      const marker=JSON.parse(await fs.promises.readFile(markerPath(resourcesDir),'utf8'));
      const manifest=JSON.parse(await fs.promises.readFile(path.join(resourcesDir,'python-runtime.json'),'utf8'));
      if(marker.state!=='ready'||marker.id!==manifest.id||marker.archiveSha256!==manifest.archiveSha256||!/^py[\w.-]+$/.test(manifest.id)||manifest.platform!=='win32-x64')throw repair();
      const target=safeChild(path.join(resourcesDir,'installed-runtimes'),manifest.id);
      // Full verification and imports ran during installation. On launch verify
      // root executables/DLLs/bootstrap; the service health check verifies imports.
      const files=Object.fromEntries(Object.entries(manifest.files).filter(([name])=>!name.includes('/')));
      if(!files['python.exe']||!files['bootstrap.py']||!await verify(target,{files}))throw repair();
      progress={percent:95,stage:'环境已就绪'};
      diagnostics.log('installed-runtime-reuse',{id:manifest.id});
      return {python:path.join(target,'python.exe'),bootstrap:path.join(target,'bootstrap.py'),id:manifest.id};
    })().catch(()=>{pending=null;throw repair();});
    return pending;
  };
  provider.progress=()=>({...progress});
  return provider;
}
async function removeInstalledRuntime({resourcesDir}){
  const root=await fs.promises.realpath(resourcesDir);
  const target=safeChild(root,'installed-runtimes');
  if(fs.existsSync(target)){
    const info=await fs.promises.lstat(target);
    if(info.isSymbolicLink()||await fs.promises.realpath(target)!==target)throw Error('安装环境路径异常，未执行移除');
    // Only this installation's generated runtime, never userData or workspace roots.
    await fs.promises.rm(path.toNamespacedPath(target),{recursive:true,force:true,maxRetries:3,retryDelay:300});
  }
  await fs.promises.rm(markerPath(root),{force:true});
}
module.exports={MARKER,prepareInstalledRuntime,createInstalledRuntimeProvider,removeInstalledRuntime};
