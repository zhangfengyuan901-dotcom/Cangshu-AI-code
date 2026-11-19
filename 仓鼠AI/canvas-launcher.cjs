const path=require('node:path');
const fs=require('node:fs');
const {spawn}=require('node:child_process');
const crypto=require('node:crypto');
function createCanvasLauncher({baseUrl,resourcesDir=process.resourcesPath,utilityProcess,spawnImpl=spawn,fetchImpl=fetch,startupTimeoutMs=30000,probeIntervalMs=100}){
  let child=null,pending=null,url='',closed=false,cancelStart;
  const token=crypto.randomBytes(32).toString('hex');
  const root=resourcesDir?path.join(resourcesDir,'hamster-canvas'):path.join(__dirname,'canvas');
  const executable=resourcesDir?path.join(resourcesDir,'node-runtime','node.exe'):path.join(__dirname,'build','node-runtime','node.exe');
  const entry=path.join(root,'server.mjs');
  let instance='';
  async function healthy(target,identity){
    try{
      const response=await fetchImpl(target+'/health',{redirect:'manual',signal:AbortSignal.timeout(1500)});
      if(response.status!==200)return false;
      const health=await response.json();
      return health.app==='hamster-canvas'&&health.version===1&&health.instance===identity;
    }catch{return false;}
  }
  function start(){
    if(closed)return Promise.reject(new Error('画布服务已关闭'));
    if(pending)return pending;
    pending=startChecked().finally(()=>pending=null);
    return pending;
  }
  async function startChecked(){
    if(child&&url){
      const current=child,currentUrl=url;
      if(await healthy(currentUrl,instance)){
        if(!closed&&child===current)return currentUrl;
        throw new Error('画布服务已关闭');
      }
      if(child===current){child=null;url='';current.kill();}
    }
    if(closed)throw new Error('画布服务已关闭');
    if((!utilityProcess&&!fs.existsSync(executable))||!fs.existsSync(path.join(root,'dist','index.html')))throw new Error('画布运行组件尚未构建，请运行 npm run canvas:build');
    const upstream=new URL(baseUrl());
    if(upstream.protocol!=='http:'||upstream.hostname!=='127.0.0.1'||!upstream.port||upstream.username||upstream.password||upstream.pathname!=='/'||upstream.search||upstream.hash)throw new Error('本地画布地址无效');
    instance=crypto.randomUUID();
    const identity=instance;
    return new Promise((resolve,reject)=>{
      let buffer='',settled=false,verifying=false,launched,probeTimer;
      const timer=setTimeout(()=>fail(new Error('画布启动超时')),startupTimeoutMs);
      function clear(){clearTimeout(timer);clearTimeout(probeTimer);if(cancelStart===cancel)cancelStart=null;}
      function fail(error){
        clear();
        if(child===launched){child=null;url='';}
        launched?.kill();
        if(!settled){settled=true;reject(error);}
      }
      const cancel=()=>fail(new Error('画布服务已关闭'));
      cancelStart=cancel;
      async function verify(target){
        if(settled||closed||child!==launched)return;
        if(await healthy(target,identity)){
          if(settled||closed||child!==launched)return;
          settled=true;clear();url=target;resolve(url);
        }else if(!settled)probeTimer=setTimeout(()=>verify(target),probeIntervalMs);
      }
      try{
        const env={HAMSTER_CANVAS_API:upstream.origin,HAMSTER_CANVAS_TOKEN:token,HAMSTER_CANVAS_INSTANCE:identity};
        if(utilityProcess){
          // Utility processes only receive canvas configuration and the Windows process environment it needs.
          for(const name of ['SystemRoot','WINDIR','TEMP','TMP'])if(process.env[name])env[name]=process.env[name];
          launched=child=utilityProcess.fork(entry,[],{cwd:root,env,stdio:['ignore','pipe','pipe'],serviceName:'Hamster Canvas'});
        }else{
          launched=child=spawnImpl(executable,[entry],{cwd:root,windowsHide:true,env:{...process.env,...env},stdio:['ignore','pipe','pipe','ipc']});
        }
        launched.once('error',()=>fail(new Error('画布服务启动失败')));
        launched.once('exit',()=>fail(new Error('画布服务已退出')));
        launched.stdout.on('data',chunk=>{
          if(settled||verifying)return;
          buffer=(buffer+chunk).slice(-8192);
          const match=buffer.match(/(?:^|\n)HAMSTER_CANVAS_READY:([^\r\n]*)\r?\n/);
          if(!match)return;
          const port=Number(match[1]);
          if(!/^\d{1,5}$/.test(match[1])||!Number.isInteger(port)||port<1||port>65535){fail(new Error('画布服务地址无效'));return;}
          verifying=true;void verify(`http://127.0.0.1:${port}`);
        });
        launched.stderr.on('data',()=>{});
      }catch{fail(new Error('画布服务启动失败'));}
    });
  }
  return {
    async open(projectId=''){
      const base=await start();
      if(closed)throw new Error('画布服务已关闭');
      return {url:base+'/?token='+token+(projectId?'&project='+encodeURIComponent(projectId):'')};
    },
    stop(){closed=true;cancelStart?.();child?.kill();child=null;url='';},
    start,
  };
}
module.exports={createCanvasLauncher};
