const fs=require('node:fs'),crypto=require('node:crypto');
const manifest=JSON.parse(fs.readFileSync('build/python-runtime.json','utf8'));
const sha=crypto.createHash('sha256').update(fs.readFileSync('build/python-runtime.zip')).digest('hex');
if(sha!==manifest.archiveSha256)throw Error('Runtime missing/corrupt. Run npm run runtime:build before packaging.');
for(const [name,key] of [['smart-video-agent/runtime-requirements.lock','lockSha256'],['scripts/runtime-bootstrap.py','bootstrapSha256']]){
  if(crypto.createHash('sha256').update(fs.readFileSync(name)).digest('hex')!==manifest[key])throw Error('Runtime is stale. Run npm run runtime:build.');
}
console.log('Verified bundled runtime:',manifest.id);
