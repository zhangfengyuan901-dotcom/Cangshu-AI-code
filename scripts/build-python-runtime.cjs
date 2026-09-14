// Release-time only. Customers never run uv/pip or download Python.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {execFileSync}=require('node:child_process');
const root=path.resolve(__dirname,'..'),build=path.join(root,'build');
const version='3.12.10';
const pythonHash='4acbed6dd1c744b0376e3b1cf57ce906f9dc9e95e68824584c8099a63025a3c3';
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const run=(cmd,args,options={})=>execFileSync(cmd,args,{stdio:'inherit',windowsHide:true,...options});
async function main(){
  if(process.platform!=='win32'||process.arch!=='x64')throw Error('Build on Windows x64');
  fs.mkdirSync(build,{recursive:true});
  const archive=path.join(build,`python-${version}-embed-amd64.zip`);
  if(!fs.existsSync(archive)){
    const response=await fetch(`https://www.python.org/ftp/python/${version}/python-${version}-embed-amd64.zip`);
    if(!response.ok)throw Error(`Python download failed: ${response.status}`);
    const bytes=Buffer.from(await response.arrayBuffer());
    if(hash(bytes)!==pythonHash)throw Error('Python SHA-256 mismatch');
    fs.writeFileSync(archive,bytes,{flag:'wx'});
  }
  if(hash(fs.readFileSync(archive))!==pythonHash)throw Error('Cached Python SHA-256 mismatch');
  const stage=process.env.HAMSTER_BUILD_STAGE || fs.mkdtempSync(path.join(build,'python-stage-'));
  if(path.dirname(path.resolve(stage))!==build||!path.basename(stage).startsWith('python-stage-'))throw Error('Invalid build staging directory');
  const sevenRoot=path.join(process.env.LOCALAPPDATA,'electron-builder/Cache/7zip@1.0.0');
  const seven=process.env.HAMSTER_BUILD_7ZIP || fs.readdirSync(sevenRoot).map(x=>path.join(sevenRoot,x,'bin/7za.exe')).find(x=>fs.existsSync(x));
  run(seven,['x',archive,`-o${stage}`,'-y']);
  fs.writeFileSync(path.join(stage,'python312._pth'),'python312.zip\n.\nLib/site-packages\nimport site\n');
  const uv=path.join(root,'smart-video-agent/bin/uv.exe');
  const lock=path.join(root,'smart-video-agent/runtime-requirements.lock');
  run(uv,['pip','install','--python',path.join(stage,'python.exe'),'--target',path.join(stage,'Lib/site-packages'),'--require-hashes','--no-deps','-r',lock]);
  fs.copyFileSync(path.join(root,'scripts/runtime-bootstrap.py'),path.join(stage,'bootstrap.py'));
  run(path.join(stage,'python.exe'),['-I',path.join(stage,'bootstrap.py'),'--check',path.join(root,'smart-video-agent')],{env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'}});
  const files={};
  function walk(dir){for(const e of fs.readdirSync(dir,{withFileTypes:true})){if(e.name==='__pycache__')continue;const p=path.join(dir,e.name);if(e.isDirectory())walk(p);else files[path.relative(stage,p).replaceAll('\\','/')]=hash(fs.readFileSync(p));}}
  walk(stage);
  const id=`py${version}-${hash(JSON.stringify(files)).slice(0,12)}`;
  const zip=path.join(build,`runtime-${id}-${Date.now()}.zip`);
  run(seven,['a','-tzip',zip,'.','-mx=5','-xr!__pycache__'],{cwd:stage});
  fs.copyFileSync(zip,path.join(build,'python-runtime.zip'));
  fs.writeFileSync(path.join(build,'python-runtime.json'),JSON.stringify({id,python:version,platform:'win32-x64',lockSha256:hash(fs.readFileSync(lock)),bootstrapSha256:hash(fs.readFileSync(path.join(root,'scripts/runtime-bootstrap.py'))),archiveSha256:hash(fs.readFileSync(zip)),files},null,2));
  console.log(`Runtime ready: ${id}, ${Object.keys(files).length} files`);
}
main().catch(error=>{console.error(error);process.exitCode=1;});
