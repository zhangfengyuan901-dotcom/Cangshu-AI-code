const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),asar=require('@electron/asar');
const root=path.resolve(process.argv[2] || 'dist/release-1.6.1/win-unpacked/resources');
const manifest=JSON.parse(fs.readFileSync(path.join(root,'python-runtime.json'),'utf8'));
if(crypto.createHash('sha256').update(fs.readFileSync(path.join(root,'python-runtime.zip'))).digest('hex')!==manifest.archiveSha256)throw Error('Packaged runtime checksum mismatch');
const app=path.join(root,'app.asar');
const pkg=JSON.parse(asar.extractFile(app,'package.json'));
const runtime=asar.extractFile(app,'runtime.cjs').toString(),server=asar.extractFile(app,'server.js').toString();
if(!runtime.includes('length:8')||!server.includes("['-I','-B'"))throw Error('Stale packaged launcher');
if(!runtime.includes('extractRuntimeZip')||runtime.includes('powershell.exe'))throw Error('Stale long-path extraction');
if(JSON.parse(asar.extractFile(app,path.join('node_modules','yauzl','package.json'))).version!=='3.4.0')throw Error('Production ZIP reader missing or stale');
if(fs.existsSync(path.join(root,'smart-video-agent/bin/uv.exe')))throw Error('Customer package contains online bootstrap');
console.log(JSON.stringify({version:pkg.version,runtime:manifest.id,files:Object.keys(manifest.files).length,archiveVerified:true,
  workflow:fs.readFileSync(path.join(root,'smart-video-agent/.hamster-workflow-version'),'utf8').trim()}));
