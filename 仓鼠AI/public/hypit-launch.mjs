const button=document.querySelector('#hypitButton');
const container=document.querySelector('#hypitWorkspace');
let workspace,opening,closed=false;
if(button&&container){
  // This is a local capability read only. It never starts a child, installs or logs in.
  fetch('/api/hypit/status',{credentials:'same-origin'}).then(response=>response.ok?response.json():null).then(status=>{
    button.hidden=!(status?.enabled===true&&status?.internalOnly===true);
  }).catch(()=>{button.hidden=true;});
  button.addEventListener('click',()=>{
    if(workspace)return workspace.refresh();
    if(opening)return opening;
    container.textContent='正在准备工作区…';
    opening=import('./hypit.mjs').then(({mountHypit})=>{if(!closed)workspace=mountHypit(container);})
      .catch(()=>{if(!closed)container.textContent='界面未能加载，请重新打开工作区。';}).finally(()=>{opening=null;});
    return opening;
  });
  globalThis.addEventListener('pagehide',()=>{closed=true;workspace?.destroy();},{once:true});
}
