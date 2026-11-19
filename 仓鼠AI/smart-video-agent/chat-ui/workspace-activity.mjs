const loopbackOrigin=/^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})$/;

export function observeWorkspaceActivity(kind,onChange,{window=globalThis.window,document=globalThis.document,Observer=globalThis.IntersectionObserver}={}) {
  const standalone=window.top===window;
  const parentOrigin=window.location?.ancestorOrigins?.[0];
  const port=Number(loopbackOrigin.exec(parentOrigin)?.[1]);
  const managed=!standalone&&window.parent===window.top&&port>=1024&&port<=65535&&parentOrigin!==window.location?.origin;
  let active=standalone||!managed&&typeof Observer!=='function';
  const isVisible=()=>active&&document.visibilityState!=='hidden';
  let previous=isVisible();
  const mark=visible=>{document.documentElement.dataset.workspaceActive=String(visible);};
  mark(previous);
  function changed(){
    const visible=isVisible();
    if(visible===previous)return;
    previous=visible;
    mark(visible);
    onChange(visible);
  }
  function message(event){
    if(event.source!==window.parent||event.origin!==parentOrigin||event.data?.type!=='hamster-workspace-visibility'||event.data.kind!==kind||typeof event.data.visible!=='boolean')return;
    active=event.data.visible;
    changed();
  }
  document.addEventListener('visibilitychange',changed);
  let observer;
  if(managed){
    window.addEventListener('message',message);
    window.parent.postMessage({type:'hamster-workspace-ready',kind},parentOrigin);
  }else if(!standalone&&typeof Observer==='function'){
    observer=new Observer(entries=>{
      const entry=entries.find(item=>item.target===document.documentElement);
      if(!entry)return;
      active=entry.isIntersecting&&entry.intersectionRatio>0;
      changed();
    });
    observer.observe(document.documentElement);
  }
  return {isVisible,stop(){
    document.removeEventListener('visibilitychange',changed);
    if(managed)window.removeEventListener('message',message);
    observer?.disconnect();
  }};
}
