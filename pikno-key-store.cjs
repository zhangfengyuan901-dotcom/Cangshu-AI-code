// The release injects Electron safeStorage (Windows DPAPI). Node development
// uses a process-only store; it must never silently fall back to plaintext.
const fs=require('node:fs');
const path=require('node:path');
function createPiknoKeyStore({file,cipher}={}) {
  let current=null;
  const read=()=>{
    if(current)return {...current};
    if(!file||!fs.existsSync(file))return {};
    try {
      if(!cipher?.isEncryptionAvailable()||cipher.getSelectedStorageBackend?.()==='basic_text')return {};
      const value=JSON.parse(cipher.decryptString(fs.readFileSync(file)));
      if(!Number.isSafeInteger(value.piknoUserId)||value.piknoUserId<1)return {};
      current=value;return {...current};
    } catch { return {}; }
  };
  const write=value=>{
    if(file){
      if(!cipher?.isEncryptionAvailable()||cipher.getSelectedStorageBackend?.()==='basic_text')throw Object.assign(Error('系统密钥保护不可用，未保存 Key'),{statusCode:503});
      const bytes=cipher.encryptString(JSON.stringify(value)),temp=file+'.tmp';
      fs.mkdirSync(path.dirname(file),{recursive:true});
      const fd=fs.openSync(temp,'w',0o600);
      try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
      fs.renameSync(temp,file);
    }
    current={...value};
  };
  const clear=()=>{if(file&&fs.existsSync(file))fs.unlinkSync(file);current=null;};
  return {read,write,clear,persistent:Boolean(file)};
}
module.exports={createPiknoKeyStore};
