// Run with Electron, without creating a browser window. No real Key is needed.
const {app,safeStorage}=require('electron');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
const {createPiknoKeyStore}=require('../pikno-key-store.cjs');
app.whenReady().then(()=>{
 let dir;
 try{
  assert.equal(safeStorage.isEncryptionAvailable(),true);
  dir=fs.mkdtempSync(path.join(os.tmpdir(),'hamster-dpapi-qa-'));
  const file=path.join(dir,'candidate.bin'),values={piknoUserId:7};
  for(const field of ['piknoImageKey','piknoVideoKey','piknoToolKey'])values[field]='sk-'+require('node:crypto').randomBytes(24).toString('hex');
  const store=createPiknoKeyStore({file,cipher:safeStorage});store.write(values);
  for(const field of ['piknoImageKey','piknoVideoKey','piknoToolKey'])assert.equal(fs.readFileSync(file).includes(Buffer.from(values[field])),false);
  assert.deepEqual(createPiknoKeyStore({file,cipher:safeStorage}).read(),values);
  store.clear();assert.equal(fs.existsSync(file),false);
  console.log('PIKNO Key QA: Windows protected storage, restart read and scoped removal passed.');
  app.exit(0);
 }catch{console.error('PIKNO Key QA failed; protected storage unavailable or verification failed.');app.exit(1);}
 finally{if(dir)fs.rmSync(dir,{recursive:true,force:true});}
});
