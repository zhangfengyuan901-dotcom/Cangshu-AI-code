// Offline candidate validation. Never prints private configuration values.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const asar=require('@electron/asar');
const root=path.resolve(__dirname,'..'),output=path.resolve(process.argv[2]||''),version=process.argv[3];
assert.ok(version&&/^\d+\.\d+\.\d+$/.test(version),'Expected an explicit candidate version');
const resources=path.join(output,'win-unpacked','resources'),archive=path.join(resources,'app.asar');
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
const sourcePackage=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'));
const packagedPackage=JSON.parse(asar.extractFile(archive,'package.json'));
assert.equal(sourcePackage.version,version);assert.equal(packagedPackage.version,version);
assert.equal(packagedPackage.main,sourcePackage.main);assert.deepEqual(packagedPackage.dependencies,sourcePackage.dependencies);
const currentPrivateValues=new Set();
function inspectObject(value,parent=''){
  if(!value||typeof value!=='object')return;
  for(const [key,item] of Object.entries(value)){
    if(typeof item==='string'&&/key|token|password|secret/i.test(key+' '+parent)&&item.length>=12)currentPrivateValues.add(item);
    else if(item&&typeof item==='object')inspectObject(item,key);
  }
}
for(const relative of ['config.json','smart-video-agent/config.yaml','.env','smart-video-agent/.env']){
  const file=path.join(root,relative);if(!fs.existsSync(file))continue;
  const content=fs.readFileSync(file,'utf8');
  if(relative.endsWith('.json'))inspectObject(JSON.parse(content));
  else for(const row of content.split(/\r?\n/)){
    const match=row.match(/^\s*([\w.-]*(?:key|token|password|secret)[\w.-]*)\s*[:=]\s*["']?([^\r\n]+?)\s*$/i);
    if(match){const value=match[2].replace(/["']\s*$/,'');if(value.length>=12&&!/^your[_ -]|<|\$\{|#/.test(value))currentPrivateValues.add(value);}
  }
}
let textFiles=0,matches=0,sourceFiles=0,resourceFiles=0;
function scan(buffer){
  if(!buffer.length||buffer.length>8*1024*1024||buffer.includes(0))return;
  textFiles++;const text=buffer.toString('utf8');
  for(const value of currentPrivateValues)if(text.includes(value))matches++;
}
const entries=asar.listPackage(archive).map(entry=>entry.replace(/^[\\/]+/,'').replace(/\\/g,'/'));
for(const entry of entries){
  const archiveEntry=entry.split('/').join(path.sep);
  const info=asar.statFile(archive,archiveEntry);if(info.files)continue;
  const buffer=asar.extractFile(archive,archiveEntry);scan(buffer);
  if(entry.startsWith('node_modules/'))continue;
  assert.ok(!/^(?:config\.json|\.env|scripts\/|tests\/|output\/|tasks\/|results\/|assets\/|canvas-data\/)/.test(entry),'Private/test data entered the application archive');
  if(entry==='package.json')continue;
  const file=path.join(root,entry);assert.ok(fs.existsSync(file),'Packaged source has no local source');
  assert.equal(hash(buffer),hash(fs.readFileSync(file)),'Packaged application source differs: '+entry);sourceFiles++;
}
function filesUnder(directory){
  return fs.readdirSync(directory,{withFileTypes:true}).flatMap(item=>item.isDirectory()?filesUnder(path.join(directory,item.name)):[path.join(directory,item.name)]);
}
for(const file of filesUnder(path.join(resources,'smart-video-agent'))){
  const relative=path.relative(path.join(resources,'smart-video-agent'),file).replace(/\\/g,'/');
  assert.ok(!/(^|\/)(?:\.env|config\.yaml|\.venv|chat-data|creative-data|studio-data|\.adk|__pycache__)(?:$|\/)/.test(relative),'Private workflow data entered package');
  const source=relative.startsWith('studio-ui/shared/')?path.join(root,'public',path.basename(relative)):path.join(root,'smart-video-agent',relative);
  const buffer=fs.readFileSync(file);assert.equal(hash(buffer),hash(fs.readFileSync(source)),'Packaged workflow differs: '+relative);scan(buffer);resourceFiles++;
}
for(const file of filesUnder(path.join(resources,'hamster-canvas'))){
  const relative=path.relative(path.join(resources,'hamster-canvas'),file),buffer=fs.readFileSync(file);
  assert.equal(hash(buffer),hash(fs.readFileSync(path.join(root,'canvas',relative))),'Packaged canvas differs');scan(buffer);resourceFiles++;
}
for(const file of filesUnder(path.join(resources,'node-runtime'))){
  const relative=path.relative(path.join(resources,'node-runtime'),file),buffer=fs.readFileSync(file);
  assert.equal(hash(buffer),hash(fs.readFileSync(path.join(root,'build','node-runtime',relative))),'Packaged Node runtime differs');scan(buffer);resourceFiles++;
}
for(const [target,source] of [['installed-runtime-check.py','electron/installed-runtime-check.py'],['python-runtime.json','build/python-runtime.json'],['python-runtime.zip','build/python-runtime.zip']]){
  const buffer=fs.readFileSync(path.join(resources,target));
  assert.equal(hash(buffer),hash(fs.readFileSync(path.join(root,source))),'Packaged runtime resource differs: '+target);scan(buffer);resourceFiles++;
}
const manifest=JSON.parse(fs.readFileSync(path.join(resources,'python-runtime.json'),'utf8'));
assert.equal(hash(fs.readFileSync(path.join(resources,'python-runtime.zip'))),manifest.archiveSha256,'Bundled Python archive changed');
assert.equal(matches,0,'Private configuration value found in candidate text');
const artifacts=['仓鼠AI Setup '+version+'.exe','仓鼠AI-'+version+'-便携版.exe'].map(name=>{
  const buffer=fs.readFileSync(path.join(output,name));return {name,bytes:buffer.length,sha256:hash(buffer)};
});
console.log(JSON.stringify({version,sourceBytesMatch:true,asarSourceFilesChecked:sourceFiles,resourceSourceFilesChecked:resourceFiles,
  privateConfigExcluded:true,qaFixtureExcluded:!entries.some(entry=>entry.includes('qa-pikno-ui-server')),
  textFilesCheckedForCurrentPrivateValues:textFiles,currentPrivateValueMatches:matches,
  pythonRuntimeId:manifest.id,pythonRuntimeManifestFiles:Object.keys(manifest.files).length,packagedRuntimeChecksumVerified:true,
  workflowRevision:fs.readFileSync(path.join(resources,'smart-video-agent','.hamster-workflow-version'),'utf8').trim(),
  appAsarSha256:hash(fs.readFileSync(archive)),finalPublicAppJsSha256:hash(asar.extractFile(archive,'public/app.js')),artifacts},null,2));
