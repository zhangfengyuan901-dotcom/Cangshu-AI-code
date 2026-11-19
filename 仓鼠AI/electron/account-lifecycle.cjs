// Only the owning account main frame is accepted by the native handler.
const {ipcRenderer,contextBridge}=require('electron');
ipcRenderer.on('hamster-account-view-hidden',()=>document.dispatchEvent(new Event('hamster-account-view-hidden')));
if(process.isMainFrame){
  const invoke=(action,value)=>ipcRenderer.invoke('hamster-account-command',action,value).catch(()=>({ok:false,code:'CONNECT_FAILED'}));
  contextBridge.exposeInMainWorld('hamsterAccount',Object.freeze({
    setAccountContext:value=>invoke('context',value),
    connectCreatedKey:value=>invoke('connect',value),
    reportFailure:value=>invoke('failure',value),
  }));
}
