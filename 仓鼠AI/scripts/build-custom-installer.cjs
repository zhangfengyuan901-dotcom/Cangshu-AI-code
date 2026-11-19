'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {spawnSync}=require('node:child_process');
const yauzl=require('yauzl');
// Invoked from the staged copy in build-inputs/scripts. All inputs must belong to this stage.
const inputRoot=path.resolve(__dirname,'..'),stageRoot=path.dirname(inputRoot);
const verificationFile=path.join(stageRoot,'setup-build-verification.json');
const buildDirectory=path.join(inputRoot,'setup');
let stage='arguments';
const fail=code=>{throw Object.assign(new Error(code),{code});};
const ensure=(value,code)=>{if(!value)fail(code);};
const inside=(base,file)=>{const relative=path.relative(base,file);return relative!==''&&relative!=='..'&&!relative.startsWith('..'+path.sep)&&!path.isAbsolute(relative);};
const relative=file=>path.relative(stageRoot,file).replaceAll('\\','/');
function safeExisting(file,directory=false){
 const resolved=path.resolve(file);ensure(inside(stageRoot,resolved),'INPUT_OUTSIDE_STAGE');
 const info=fs.lstatSync(resolved);ensure(!info.isSymbolicLink()&&(directory?info.isDirectory():info.isFile()),'INPUT_NOT_REGULAR');
 ensure(inside(fs.realpathSync(stageRoot),fs.realpathSync(resolved)),'INPUT_LINK_OUTSIDE_STAGE');return resolved;
}
function safeWritable(file){
 const resolved=path.resolve(file);ensure(inside(stageRoot,resolved),'OUTPUT_OUTSIDE_STAGE');
 for(let current=resolved;inside(stageRoot,current);current=path.dirname(current))if(fs.existsSync(current)){
  ensure(!fs.lstatSync(current).isSymbolicLink()&&inside(fs.realpathSync(stageRoot),fs.realpathSync(current)),'OUTPUT_LINK_NOT_ALLOWED');
 }
 return resolved;
}
function parseArgs(args){
 const allowed=new Set(['engine','output','version','runtime-manifest','asar','install-root','icon']),options={};
 for(let i=0;i<args.length;i+=2){
  ensure(/^--[a-z-]+$/.test(args[i]||''),'INVALID_ARGUMENT');const key=args[i].slice(2),value=args[i+1];
  ensure(allowed.has(key)&&!Object.hasOwn(options,key)&&typeof value==='string'&&value&&!/[\x00-\x1f"]/.test(value),'INVALID_ARGUMENT');options[key]=value;
 }
 for(const key of ['engine','output','version','runtime-manifest','asar','install-root'])ensure(options[key],'MISSING_ARGUMENT');
 ensure(/^\d+\.\d+\.\d+$/.test(options.version),'INVALID_VERSION');return options;
}
function hash(file){return new Promise((resolve,reject)=>{const digest=crypto.createHash('sha256');fs.createReadStream(file).on('error',reject).on('data',chunk=>digest.update(chunk)).on('end',()=>resolve(digest.digest('hex')));});}
function measureInstall(root){
 let files=0,bytes=0;
 function walk(directory){for(const name of fs.readdirSync(directory)){
  const file=path.join(directory,name),info=fs.lstatSync(file);ensure(!info.isSymbolicLink(),'INSTALL_ROOT_CONTAINS_LINK');
  if(info.isDirectory())walk(file);else{ensure(info.isFile(),'INSTALL_ROOT_NOT_REGULAR');files++;bytes+=info.size;ensure(Number.isSafeInteger(bytes),'INSTALL_SIZE_INVALID');}
 }}walk(root);return {files,bytes};
}
function measureArchive(file){return new Promise((resolve,reject)=>{
 yauzl.open(file,{lazyEntries:true,autoClose:true,validateEntrySizes:true},(error,zip)=>{
  if(error)return reject(Object.assign(new Error('RUNTIME_ARCHIVE_INVALID'),{code:'RUNTIME_ARCHIVE_INVALID'}));
  let bytes=0,entries=0,failed=false;
  zip.once('error',()=>{if(!failed){failed=true;zip.close();reject(Object.assign(new Error('RUNTIME_ARCHIVE_INVALID'),{code:'RUNTIME_ARCHIVE_INVALID'}));}});
  zip.on('entry',entry=>{
   if(!Number.isSafeInteger(entry.uncompressedSize)||entry.uncompressedSize<0||!Number.isSafeInteger(bytes+entry.uncompressedSize)){
    failed=true;zip.close();reject(Object.assign(new Error('RUNTIME_SIZE_INVALID'),{code:'RUNTIME_SIZE_INVALID'}));return;
   }
   bytes+=entry.uncompressedSize;entries++;zip.readEntry();
  });
  zip.once('end',()=>{if(!failed)resolve({bytes,entries});});zip.readEntry();
 });
});}
function verifyGuiExecutable(file){
 const fd=fs.openSync(file,'r');try{
  const header=Buffer.alloc(64);ensure(fs.readSync(fd,header,0,64,0)===64&&header.toString('ascii',0,2)==='MZ','OUTPUT_PE_INVALID');
  const pe=Buffer.alloc(96);ensure(fs.readSync(fd,pe,0,96,header.readUInt32LE(60))===96,'OUTPUT_PE_INVALID');
  ensure(pe.readUInt32LE(0)===0x4550&&pe.readUInt16LE(4)===0x8664&&pe.readUInt16LE(24)===0x20b&&pe.readUInt16LE(24+68)===2,'OUTPUT_NOT_X64_GUI');
 }finally{fs.closeSync(fd);}
}
function compilerDiagnostics(value){
 return [...String(value||'').matchAll(/(?:^|\r?\n)([^\r\n]*?)(?:\((\d+),(\d+)\))?\s*:\s*(?:fatal\s+)?error\s+(CS\d+)/g)].slice(0,20).map(match=>({code:match[4],file:['Setup.cs','BuildInfo.cs'].includes(path.basename(match[1].trim()))?path.basename(match[1].trim()):null,line:match[2]?Number(match[2]):null,column:match[3]?Number(match[3]):null}));
}
async function main(args=process.argv.slice(2)){
 ensure(process.platform==='win32'&&process.arch==='x64','WINDOWS_X64_REQUIRED');const options=parseArgs(args);
 const engine=safeExisting(options.engine),archive=safeExisting(options.asar),installRoot=safeExisting(options['install-root'],true),runtimeFile=safeExisting(options['runtime-manifest']);
 const output=safeWritable(options.output);ensure(path.extname(output).toLowerCase()==='.exe'&&output.toLowerCase()!==engine.toLowerCase(),'INVALID_OUTPUT');
 ensure(path.relative(installRoot,archive).replaceAll('\\','/').toLowerCase()==='resources/app.asar','ASAR_INSTALL_ROOT_MISMATCH');
 ensure(path.basename(inputRoot)==='build-inputs','STAGED_INSTALLER_INPUTS_REQUIRED');
 const setup=safeExisting(path.join(inputRoot,'installer-ui','Setup.cs')),shell=safeExisting(path.join(inputRoot,'installer-ui','Shell.xaml')),manifest=safeExisting(path.join(inputRoot,'installer-ui','installer.manifest'));
 const logo=safeExisting(path.join(stageRoot,'source','public','hamster-logo.png'));
 const icon=options.icon?safeExisting(options.icon):safeExisting(path.join(inputRoot,'icon.ico'));
 ensure(!fs.existsSync(output),'OUTPUT_EXISTS');
 stage='runtime-inputs';const runtime=JSON.parse(fs.readFileSync(runtimeFile,'utf8'));
 ensure(runtime.platform==='win32-x64'&&/^py[\w.-]{1,120}$/.test(runtime.id||'')&&/^[a-f0-9]{64}$/.test(runtime.archiveSha256||''),'RUNTIME_MANIFEST_INVALID');
 const runtimeZip=safeExisting(path.join(installRoot,'resources','python-runtime.zip'));
 const [backendHash,asarHash,runtimeArchiveHash]=await Promise.all([hash(engine),hash(archive),hash(runtimeZip)]);
 ensure(runtimeArchiveHash===runtime.archiveSha256,'RUNTIME_ARCHIVE_HASH_MISMATCH');
 const asar=require('@electron/asar'),runtimePackage=JSON.parse(asar.extractFile(archive,'package.json').toString('utf8'));
 ensure(runtimePackage.version===options.version,'ASAR_VERSION_MISMATCH');
 const installed=measureInstall(installRoot),expanded=await measureArchive(runtimeZip),overheadBytes=1024*1024*1024;
 const requiredBytes=installed.bytes+expanded.bytes+overheadBytes;ensure(Number.isSafeInteger(requiredBytes)&&expanded.entries>0&&expanded.bytes>0,'INSTALL_SIZE_INVALID');
 stage='compiler-inputs';
 const framework=path.join(process.env.WINDIR||process.env.SystemRoot||'C:/Windows','Microsoft.NET','Framework64','v4.0.30319'),compiler=path.join(framework,'csc.exe');
 ensure(fs.existsSync(compiler),'FRAMEWORK_COMPILER_MISSING');
 const references=['System.dll','System.Core.dll','System.Xml.dll','System.Xml.Linq.dll','System.Web.Extensions.dll','System.Xaml.dll','System.Windows.Forms.dll','System.Drawing.dll','WPF/WindowsBase.dll','WPF/PresentationCore.dll','WPF/PresentationFramework.dll'].map(name=>path.join(framework,name));
 ensure(references.every(file=>fs.existsSync(file)),'WPF_REFERENCE_MISSING');
 const infoFile=safeWritable(path.join(buildDirectory,'BuildInfo.cs'));fs.mkdirSync(buildDirectory,{recursive:true});fs.mkdirSync(path.dirname(output),{recursive:true});
 const backendSize=fs.statSync(engine).size;
 const strings={Version:options.version,BackendHash:backendHash,AsarHash:asarHash,RuntimeId:runtime.id,RuntimeArchiveHash:runtimeArchiveHash};
 const generated='// Generated by build-custom-installer.cjs.\nnamespace HamsterSetup { internal static class BuildInfo {\n'+Object.entries(strings).map(([name,value])=>' internal const string '+name+' = '+JSON.stringify(value)+';').join('\n')+'\n internal const long BackendSize = '+backendSize+'L;\n internal const long RequiredInstallBytes = '+requiredBytes+'L;\n} }\n';
 fs.writeFileSync(infoFile,'\ufeff'+generated,'utf8');
 const resources=[{file:engine,name:'HamsterSetup.Engine.exe'},{file:shell,name:'HamsterSetup.Shell.xaml'},...(logo?[{file:logo,name:'HamsterSetup.Logo.png'}]:[])];
 const sourceFiles={setup,shell,manifest,buildInfo:infoFile,icon,...(logo?{logo}:{})};
 const sourceHashes=Object.fromEntries(await Promise.all(Object.entries(sourceFiles).map(async([name,file])=>[name,await hash(file)])));
 const temporary=safeWritable(path.join(path.dirname(output),'.setup-'+crypto.randomUUID()+'.exe')),responseFile=safeWritable(path.join(buildDirectory,'compiler.rsp'));
 const quote=value=>'"'+value+'"';
 const compilerArgs=['/nologo','/target:winexe','/platform:x64','/optimize+','/utf8output','/codepage:65001','/langversion:5','/out:'+quote(temporary),'/win32manifest:'+quote(manifest),'/win32icon:'+quote(icon),...references.map(file=>'/reference:'+quote(file)),...resources.map(resource=>'/resource:'+quote(resource.file)+','+resource.name),quote(setup),quote(infoFile)];
 fs.writeFileSync(responseFile,'\ufeff'+compilerArgs.join('\r\n')+'\r\n','utf8');
 try{
  stage='compile';const compiled=spawnSync(compiler,['@'+responseFile],{windowsHide:true,encoding:'utf8',timeout:180000,maxBuffer:1024*1024,shell:false});
  if(compiled.error||compiled.status!==0){const problem=Object.assign(new Error('COMPILER_FAILED'),{code:'COMPILER_FAILED',compilerExitCode:compiled.status,diagnostics:compilerDiagnostics((compiled.stdout||'')+'\n'+(compiled.stderr||''))});throw problem;}
  stage='verify';verifyGuiExecutable(temporary);
  ensure(await hash(engine)===backendHash&&await hash(archive)===asarHash&&await hash(runtimeZip)===runtimeArchiveHash,'INPUT_CHANGED_DURING_BUILD');
  for(const [name,file]of Object.entries(sourceFiles))ensure(await hash(file)===sourceHashes[name],'INPUT_CHANGED_DURING_BUILD');
  const outputHash=await hash(temporary),outputBytes=fs.statSync(temporary).size;ensure(outputBytes>backendSize,'OUTPUT_RESOURCE_MISSING');
  fs.renameSync(temporary,output);
  const result={format:1,version:options.version,passed:true,checkedAt:new Date().toISOString(),output:relative(output),wrapperSHA256:outputHash,wrapperBytes:outputBytes,engineSHA256:backendHash,engineBytes:backendSize,asarSHA256:asarHash,runtimeId:runtime.id,runtimeArchiveSHA256:runtimeArchiveHash,
   installSize:{regularFiles:installed.files,regularFileBytes:installed.bytes,expandedRuntimeBytes:expanded.bytes,runtimeArchiveEntries:expanded.entries,overheadBytes,requiredInstallBytes:requiredBytes,expandedBytesSource:'verified-runtime-ZIP-central-directory',regularBytesSource:'install-root-regular-files'},
   compiler:{family:'NET-Framework-CLR4-WPF',platform:'x64',gui:true,offline:true},resources:await Promise.all(resources.map(async resource=>({name:resource.name,bytes:fs.statSync(resource.file).size,sha256:await hash(resource.file)}))),sources:{setupSHA256:sourceHashes.setup,shellSHA256:sourceHashes.shell,manifestSHA256:sourceHashes.manifest,buildInfoSHA256:sourceHashes.buildInfo,iconSHA256:sourceHashes.icon},signed:false,published:false};
  fs.writeFileSync(verificationFile,JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));return result;
 }finally{if(fs.existsSync(temporary))fs.unlinkSync(temporary);}
}
if(require.main===module)main().catch(error=>{
 const result={format:1,passed:false,stage,code:/^[A-Z][A-Z0-9_]{1,80}$/.test(error.code||'')?error.code:'SETUP_BUILD_FAILED',compilerExitCode:error.compilerExitCode??null,diagnostics:error.diagnostics||[],published:false};
 try{fs.writeFileSync(verificationFile,JSON.stringify(result,null,2)+'\n');}catch{}
 console.error(JSON.stringify(result));process.exitCode=1;
});
module.exports={main,parseArgs,measureInstall,measureArchive,verifyGuiExecutable};
