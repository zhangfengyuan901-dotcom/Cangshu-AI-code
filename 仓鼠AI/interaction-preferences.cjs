const fs=require('node:fs'),path=require('node:path'),{randomUUID}=require('node:crypto');
const defaults=()=>({hoverVideo:true,reducedMotion:false});
function validInteractionPreferences(value){return value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===2&&Object.hasOwn(value,'hoverVideo')&&Object.hasOwn(value,'reducedMotion')&&typeof value.hoverVideo==='boolean'&&typeof value.reducedMotion==='boolean';}
function createInteractionPreferences({configPath}){
 const file=path.join(path.dirname(path.resolve(configPath)),'interaction-preferences.json');if(file===path.resolve(configPath))throw Error('Invalid preferences location');
 let current=defaults(),queue=Promise.resolve();
 try{const stat=fs.lstatSync(file);if(stat.isFile()&&!stat.isSymbolicLink()&&stat.size<=512){const stored=JSON.parse(fs.readFileSync(file,'utf8'));if(stored?.format===1&&Object.keys(stored).length===3&&validInteractionPreferences({hoverVideo:stored.hoverVideo,reducedMotion:stored.reducedMotion}))current={hoverVideo:stored.hoverVideo,reducedMotion:stored.reducedMotion};}}catch{}
 const get=()=>({...current});
 const set=value=>{
  if(!validInteractionPreferences(value))return Promise.reject(Error('Invalid interaction preferences'));const next={...value};
  const pending=queue.then(async()=>{
   if(next.hoverVideo===current.hoverVideo&&next.reducedMotion===current.reducedMotion)return get();
   const temporary=file+'.'+randomUUID()+'.tmp';try{await fs.promises.mkdir(path.dirname(file),{recursive:true});await fs.promises.writeFile(temporary,JSON.stringify({format:1,...next})+'\n',{encoding:'utf8',mode:0o600,flag:'wx'});await fs.promises.rename(temporary,file);current=next;return get();}finally{await fs.promises.unlink(temporary).catch(()=>{});}
  });queue=pending.catch(()=>{});return pending;
 };return {get,set};
}
module.exports={createInteractionPreferences,validInteractionPreferences};
