// Directory polling is independent of selection and never creates a quote.
export function startVisibleCatalogRefresh({refresh,events=false,enabled=()=>true,document=globalThis.document,window=globalThis.window,interval=60000,now=Date.now,setTimer=setInterval,clearTimer=clearInterval,Observer=globalThis.IntersectionObserver,EventSource=globalThis.EventSource}={}){
  if(typeof refresh!=='function'||!document||!window)throw new TypeError('Directory refresh is required');
  let stopped=false,pending=null,lastStarted=now(),intersecting=window.top===window,stream=null,revision=null,dirty=false;
  const visible=()=>document.visibilityState==='visible'&&intersecting;
  const tick=()=>{
    if(stopped)return pending;
    const active=visible()&&enabled();
    if(!active){stream?.close();stream=null;return pending;}
    if(events&&!stream&&typeof EventSource==='function'){
      stream=new EventSource('/api/relay/catalog/events');
      stream.addEventListener('catalog-change',event=>{
        try{const next=JSON.parse(event.data)?.revision;if(typeof next!=='string'||!/^[a-f0-9]{64}$/.test(next)||next===revision)return;revision=next;dirty=true;void tick();}catch{}
      });
    }
    if(pending||!dirty&&now()-lastStarted<interval)return pending;
    lastStarted=now();dirty=false;
    pending=Promise.resolve().then(refresh).catch(()=>{}).finally(()=>{pending=null;if(dirty)void tick();});
    return pending;
  };
  const observer=typeof Observer==='function'?new Observer(entries=>{const entry=entries.find(entry=>entry.target===document.documentElement);if(entry){intersecting=entry.isIntersecting&&entry.intersectionRatio>0;void tick();}}):null;
  observer?.observe(document.documentElement);
  const timer=setTimer(tick,interval);
  timer?.unref?.();
  document.addEventListener('visibilitychange',tick);window.addEventListener('focus',tick);
  const stop=()=>{if(stopped)return;stopped=true;stream?.close();stream=null;clearTimer(timer);observer?.disconnect();document.removeEventListener('visibilitychange',tick);window.removeEventListener('focus',tick);window.removeEventListener('pagehide',stop);};
  window.addEventListener('pagehide',stop);
  void tick();
  return {tick,stop,isVisible:visible};
}
