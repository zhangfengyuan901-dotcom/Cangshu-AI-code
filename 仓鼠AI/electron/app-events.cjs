// The main process owns credentials; only fixed account actions and sanitized
// display metadata cross this bridge. Never expose generic IPC or HTTP calls.
const {ipcRenderer,contextBridge}=require('electron');
if(process.isMainFrame){
  const actions=new Set(['snapshot','logout','keys','create','enable','recover','usage','browser-open']);
  contextBridge.exposeInMainWorld('hamsterDesktopAccount',Object.freeze({command:(action,payload={})=>actions.has(action)?ipcRenderer.invoke('hamster-desktop-account',action,payload):Promise.resolve({ok:false,code:'INVALID_REQUEST'})}));
  contextBridge.exposeInMainWorld('hamsterWorkDirectory',Object.freeze({
    status:()=>ipcRenderer.invoke('hamster-work-directory-status'),
    choose:()=>ipcRenderer.invoke('hamster-work-directory-choose'),
  }));
}
ipcRenderer.on('hamster-account-updated',()=>window.dispatchEvent(new Event('hamster-account-updated')));
ipcRenderer.on('hamster-relay-configured',()=>{
  window.dispatchEvent(new Event('hamster-relay-native-configured'));
  window.dispatchEvent(new Event('hamster-relay-configured'));
});
