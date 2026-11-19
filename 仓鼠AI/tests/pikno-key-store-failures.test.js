const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createPiknoKeyStore}=require('../pikno-key-store.cjs');
const initial={piknoUserId:12,piknoImageKey:'sk-'+'a'.repeat(32)};
function fixture(t){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hamster-storage-failure-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const file=path.join(dir,'keys.bin');
  const cipher={isEncryptionAvailable:()=>true,encryptString:value=>Buffer.from(value).map(byte=>byte^0xa5),decryptString:value=>Buffer.from(value).map(byte=>byte^0xa5).toString()};
  const store=createPiknoKeyStore({file,cipher});store.write(initial);
  return {file,cipher,store,before:fs.readFileSync(file)};
}
const storageError=error=>error.code==='KEY_STORAGE_UNAVAILABLE'&&error.statusCode===503&&!/private|customer|sk-|keys\.bin/.test(error.message);
test('encryption unavailable, unsafe backend and cipher exceptions have a fixed safe storage category',t=>{
  const f=fixture(t);
  for(const change of [()=>{f.cipher.isEncryptionAvailable=()=>false;},()=>{f.cipher.isEncryptionAvailable=()=>true;f.cipher.getSelectedStorageBackend=()=>'basic_text';},()=>{delete f.cipher.getSelectedStorageBackend;f.cipher.encryptString=()=>{throw Error('private customer sk-secret C:/private/keys.bin');};}]){
    change();assert.throws(()=>f.store.write({...initial,piknoUserId:13}),storageError);
    assert.deepEqual(f.store.read(),initial);assert.deepEqual(fs.readFileSync(f.file),f.before);
  }
});
test('a protected file write failure preserves the old encrypted file and in-memory configuration',t=>{
  const f=fixture(t);fs.mkdirSync(f.file+'.tmp');
  assert.throws(()=>f.store.write({...initial,piknoUserId:13}),storageError);
  assert.deepEqual(f.store.read(),initial);assert.deepEqual(fs.readFileSync(f.file),f.before);
});
