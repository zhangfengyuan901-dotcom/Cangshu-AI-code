const path=require('node:path');
const fs=require('node:fs');
const {spawn}=require('node:child_process');
const crypto=require('node:crypto');
function createCanvasLauncher({baseUrl,openExternal,resourcesDir=process.resourcesPath,spawnImpl=spawn}){
  let child,pending,url='';const token=crypto.randomBytes(32).toString('hex');
  const root=resourcesDir?path.join(resourcesDir,'hamster-canvas'):path.join(__dirname,'canvas');
  const executable=resourcesDir?path.join(resourcesDir,'node-runtime','node.exe'):path.join(__dirname,'build','node-runtime','node.exe');
  async function start(){
    if(child&&url)return url;
    if(pending)return pending;
    pending=new Promise((resolve,reject)=>{
      if(!fs.existsSync(executable)||!fs.existsSync(path.join(root,'dist','index.html'))){reject(new Error('画布运行组件尚未构建，请运行 npm run canvas:build'));return;}
      let buffer='',settled=false,launched;
      const timer=setTimeout(()=>fail(new Error('画布启动超时')),30000);
      function fail(e){clearTimeout(timer);if(child===launched){child=null;url='';}launched?.kill();if(!settled){settled=true;reject(e);}}
      launched=child=spawnImpl(executable,[path.join(root,'server.mjs')],{cwd:root,windowsHide:true,env:{...process.env,HAMSTER_CANVAS_API:baseUrl(),HAMSTER_CANVAS_TOKEN:token},stdio:['ignore','pipe','pipe']});
      child.once('error',fail);child.once('exit',()=>fail(new Error('画布服务已退出')));
      child.stdout.on('data',chunk=>{buffer+=chunk;const match=buffer.match(/HAMSTER_CANVAS_READY:(\d+)/);if(match&&!settled){settled=true;clearTimeout(timer);url=`http://127.0.0.1:${match[1]}`;resolve(url);}});
      child.stderr.on('data',()=>{});
    }).finally(()=>pending=null);
    return pending;
  }
  return {async open(projectId=''){const base=await start();const target=base+'/?token='+token+(projectId?'&project='+encodeURIComponent(projectId):'');await openExternal(target);return {url:target};},stop(){child?.kill();child=null;url='';},start};
}
module.exports={createCanvasLauncher};
