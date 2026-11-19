const {ORIGIN,createAccountService} = require('./account-service.cjs');
const PARTITION = 'persist:hamster-relay-account';
const CHANNEL = 'hamster-desktop-account';

function createDesktopAccount({window:win,electron,appUrl,journalFile,connectCreatedKey,
  getConnectedAccountId=()=>null,getConfiguredGroups=()=>[],browserCipher=electron.safeStorage,
  openExternal=target=>electron.shell.openExternal(target),onConfigured=()=>{},reportFailure=()=>{},
  origin=ORIGIN,allowLoopbackForTests=false,timers={setTimeout,clearTimeout},now=Date.now}) {
  const local=new URL(appUrl);
  if(local.protocol!=='http:'||local.hostname!=='127.0.0.1'||local.pathname!=='/'||local.search||local.hash||local.username||local.password)throw Error('Invalid local app');
  const remoteSession=electron.session.fromPartition(PARTITION);
  const contents=win.webContents;
  let disposed=false,timer=null,polling=null,lastFocus=0;
  const current=()=>!disposed&&!win.isDestroyed()&&!contents.isDestroyed()&&contents.getURL()===appUrl;
  const trusted=event=>current()&&event.sender===contents
    &&event.senderFrame===contents.mainFrame&&event.senderFrame.url===appUrl;
  const notify=()=>{if(current())contents.send('hamster-account-updated');};
  const service=createAccountService({fetchImpl:(...args)=>remoteSession.fetch(...args),journalFile,
    connectCreatedKey,getConnectedAccountId,getConfiguredGroups,browserCipher,openExternal,
    onConfigured,onFailure:reportFailure,isCurrent:current,origin,allowLoopbackForTests,now});
  remoteSession.setPermissionRequestHandler((_contents,_permission,callback)=>callback(false));
  remoteSession.setPermissionCheckHandler(()=>false);
  function stopTimer(){
    if(timer!==null){timers.clearTimeout(timer);timer=null;}
  }
  function check(){
    stopTimer();
    if(!current()||!service.hasBrowserPending())return Promise.resolve();
    if(polling)return polling;
    const pending=service.command('browser-poll').then(result=>{
      if(!current())return;
      if(result.ok&&!result.pending){notify();return;}
      if(!result.ok&&!['NETWORK','RATE_LIMITED','CONNECT_FAILED','KEY_STORAGE_UNAVAILABLE'].includes(result.code)){
        notify();return;
      }
      const delay=result.code==='RATE_LIMITED'?Math.max(3000,Math.min(60000,result.retryAfterMs||60000)):3000;
      timer=timers.setTimeout(()=>{timer=null;void check();},delay);timer.unref?.();
    }).finally(()=>{if(polling===pending)polling=null;});
    polling=pending;return pending;
  }
  electron.ipcMain.handle(CHANNEL,async(event,action,value={})=>{
    if(!trusted(event))return {ok:false,code:'FORBIDDEN'};
    if(!value||typeof value!=='object'||Array.isArray(value)||action==='browser-poll')return {ok:false,code:'INVALID_REQUEST'};
    const result=await service.command(action,value);
    if(action==='browser-open'&&result.ok)void check();
    return result;
  });
  const invalidate=()=>{stopTimer();service.invalidate();};
  const loaded=()=>{if(current())void check();};
  const focused=()=>{
    if(!current()||now()-lastFocus<1500)return;
    lastFocus=now();
    if(service.hasBrowserPending())void check();else notify();
  };
  contents.on('did-start-loading',invalidate);
  contents.on('render-process-gone',invalidate);
  contents.on('did-finish-load',loaded);
  win.on('focus',focused);
  function dispose(){
    if(disposed)return;disposed=true;stopTimer();service.dispose();
    electron.ipcMain.removeHandler(CHANNEL);
    if(!win.isDestroyed())win.removeListener('focus',focused);
    if(!contents.isDestroyed()){
      contents.removeListener('did-start-loading',invalidate);
      contents.removeListener('render-process-gone',invalidate);
      contents.removeListener('did-finish-load',loaded);
    }
  }
  win.on('closed',dispose);
  return {dispose};
}
module.exports={CHANNEL,PARTITION,createDesktopAccount};
