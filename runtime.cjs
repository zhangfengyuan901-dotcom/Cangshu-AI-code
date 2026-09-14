const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {pipeline}=require('node:stream/promises');
const yauzl=require('yauzl');
const nativePath=file=>path.toNamespacedPath(path.resolve(file));
async function digest(file){
  const hash=crypto.createHash('sha256');
  for await(const chunk of fs.createReadStream(nativePath(file)))hash.update(chunk);
  return hash.digest('hex');
}
function safeChild(root,name){
  const target=path.resolve(root,name),relative=path.relative(root,target);
  if(!relative||relative.startsWith('..')||path.isAbsolute(relative))throw Error('运行环境清单路径无效');
  return target;
}
async function verify(dir,manifest){
  const entries=Object.entries(manifest.files);let next=0,valid=true;
  // Bounded asynchronous reads keep the UI responsive without serial I/O per tiny module.
  await Promise.all(Array.from({length:8},async()=>{
    while(valid && next<entries.length){
      const [name,sha]=entries[next++];
      try{const bytes=await fs.promises.readFile(nativePath(safeChild(dir,name)));if(crypto.createHash('sha256').update(bytes).digest('hex')!==sha)valid=false;}
      catch{valid=false;}
    }
  }));
  return valid;
}
function extractRuntimeZip(file,destination,manifest){
  // Node/libuv Unicode extended paths bypass legacy MAX_PATH, independent of
  // PowerShell/.NET settings and system console code pages. Never execute a shell.
  return new Promise((resolve,reject)=>{
    let archive,input,output,settled=false;
    const finish=error=>{
      if(settled)return;settled=true;clearTimeout(timer);
      if(error){input?.destroy();output?.destroy();archive?.close();
        const detail=String(error.message || error);
        const wrapped=new Error(`内置环境解压失败（${error.code || 'ZIP_ERROR'}）：${detail}`);
        wrapped.code=error.code || 'RUNTIME_EXTRACT_FAILED';reject(wrapped);
      }else resolve();
    };
    const timer=setTimeout(()=>finish(Object.assign(new Error('解压超时，请检查磁盘与安全软件'),{code:'RUNTIME_EXTRACT_TIMEOUT'})),600000);
    timer.unref?.();
    yauzl.open(nativePath(file),{lazyEntries:true,strictFileNames:true,validateEntrySizes:true},(error,zip)=>{
      if(error)return finish(error);
      if(settled){zip.close();return;}archive=zip;
      zip.on('error',finish);zip.on('end',()=>finish());
      zip.on('entry',entry=>{
        (async()=>{
          const name=entry.fileName,mode=(entry.externalFileAttributes>>>16)&0xf000;
          if(name.includes(':') || mode===0xa000 || (entry.generalPurposeBitFlag&1))throw Error('压缩包含不允许的路径、符号链接或加密条目');
          const target=nativePath(safeChild(destination,name));
          if(name.endsWith('/')){await fs.promises.mkdir(target,{recursive:true});}
          else{
            if(manifest && !Object.hasOwn(manifest.files,name))throw Error('压缩包文件不在运行环境清单中');
            await fs.promises.mkdir(nativePath(path.dirname(target)),{recursive:true});
            input=await new Promise((res,rej)=>zip.openReadStream(entry,(err,stream)=>err?rej(err):res(stream)));
            output=fs.createWriteStream(target,{flags:'wx'});
            await pipeline(input,output);input=output=null;
          }
          if(!settled)zip.readEntry();
        })().catch(finish);
      });
      zip.readEntry();
    });
  });
}
function createRuntimeProvider({resourcesDir,cacheDir,diagnostics={log(){}},extract=extractRuntimeZip}){
  let pending=null;
  async function prepare(){
    const manifest=JSON.parse(await fs.promises.readFile(path.join(resourcesDir,'python-runtime.json'),'utf8'));
    if(!/^py[\w.-]+$/.test(manifest.id)||manifest.platform!=='win32-x64'||!manifest.files?.['python.exe']||!manifest.files?.['bootstrap.py'])throw Error('内置运行环境清单无效，请重新下载安装包');
    await fs.promises.mkdir(cacheDir,{recursive:true});
    const target=safeChild(cacheDir,manifest.id);
    if(await verify(target,manifest)){
      diagnostics.log('runtime-reuse',{id:manifest.id});
      return {python:path.join(target,'python.exe'),bootstrap:path.join(target,'bootstrap.py'),id:manifest.id};
    }
    const archive=path.join(resourcesDir,'python-runtime.zip');
    if(await digest(archive)!==manifest.archiveSha256)throw Error('内置运行环境压缩包校验失败，请重新下载安装包');
    const stage=await fs.promises.mkdtemp(nativePath(path.join(cacheDir,'r-')));
    diagnostics.log('runtime-extract',{id:manifest.id,extractor:'node-extended-path'});
    await extract(archive,stage,manifest);
    if(!await verify(stage,manifest))throw Error('运行环境释放不完整，请检查磁盘空间和安全软件，并导出诊断信息');
    // Incomplete/modified caches are preserved for diagnosis, never merged into a new runtime.
    if(fs.existsSync(target))await fs.promises.rename(target,`${target}-replaced-${Date.now()}`);
    await fs.promises.rename(stage,target);
    diagnostics.log('runtime-ready',{id:manifest.id});
    return {python:path.join(target,'python.exe'),bootstrap:path.join(target,'bootstrap.py'),id:manifest.id};
  }
  return ()=>{
    if(!pending)pending=prepare().catch(error=>{pending=null;throw error;});
    return pending;
  };
}
module.exports={createRuntimeProvider,verify,safeChild,extractRuntimeZip};
