// The host controls only visibility and geometry. Remote account data stays in
// its isolated desktop view; this module never reads its page or credentials.
export function mountRelayAccountView({panel,viewport,status,openButton,reloadButton,closeButton,badge,enabled=()=>true,
  document=panel?.ownerDocument,window=document?.defaultView,fetchImpl=globalThis.fetch,
  MutationObserver=window?.MutationObserver,ResizeObserver=window?.ResizeObserver,
  requestFrame=callback=>window.requestAnimationFrame(callback),setTimer=setTimeout,clearTimer=clearTimeout,now=Date.now}={}) {
  if(!panel||!viewport||!status||!openButton||!reloadButton||!closeButton||!document||!window)throw new TypeError('Account view is required');
  let supported=null,attached=false,blocked=false,paused=false,reload=false,lastBounds='',running=null,dirty=false,scheduled=false,destroyed=false;
  let pollTimer=null,pollUntil=0,checkState=false;
  const say=(text,error=false)=>{status.textContent=text;status.classList.toggle('error',error);};
  const controls=()=>{openButton.disabled=attached&&!blocked;reloadButton.disabled=supported===false||!attached;closeButton.disabled=!attached;viewport.dataset.attached=String(attached);};
  async function api(action,bounds){
    const response=await fetchImpl('/api/relay/account-view/'+action,{method:action==='state'?'GET':'POST',cache:'no-store',credentials:'same-origin',
      ...(action==='state'?{}:{headers:{'Content-Type':'application/json'},body:JSON.stringify(bounds||{})}),signal:AbortSignal.timeout(15000)});
    if(!response.ok)throw Error('account_view_unavailable');
    const value=await response.json();
    if(!value||typeof value.available!=='boolean')throw Error('account_view_invalid');
    return value;
  }
  function bounds(){
    const rect=viewport.getBoundingClientRect(),parent=panel.getBoundingClientRect();
    const x=Math.max(0,rect.left,parent.left),y=Math.max(0,rect.top,parent.top);
    const right=Math.min(window.innerWidth,rect.right,parent.right),bottom=Math.min(window.innerHeight,rect.bottom,parent.bottom);
    return right-x>=48&&bottom-y>=48?{x:Math.ceil(x),y:Math.ceil(y),width:Math.max(1,Math.floor(right-x)),height:Math.max(1,Math.floor(bottom-y))}:null;
  }
  const visibleBounds=()=>!destroyed&&enabled()&&!paused&&panel.classList.contains('active')&&document.visibilityState!=='hidden'&&!document.querySelector('dialog[open]')&&bounds();
  function stopPolling(){if(pollTimer!==null)clearTimer(pollTimer);pollTimer=null;pollUntil=0;checkState=false;}
  function phase(value,start=false){
    if(value.state==='error'){
      stopPolling();blocked=true;controls();say('账户页面连接失败，请点击“返回个人中心”重试，或使用网页版。',true);return;
    }
    if(value.state!=='loading'){
      stopPolling();say('');return;
    }
    if(start){stopPolling();pollUntil=now()+30000;}
    if(!pollUntil||now()>=pollUntil){
      stopPolling();blocked=true;controls();say('账户页面仍未完成加载，请检查网络后点击“返回个人中心”。',true);return;
    }
    say('正在连接个人中心，请稍候…');
    if(pollTimer===null)pollTimer=setTimer(()=>{pollTimer=null;checkState=true;schedule();},Math.min(1000,Math.max(1,pollUntil-now())));
  }
  async function sync(){
    let box=visibleBounds();
    if(!box){
      reload=false;stopPolling();
      if(attached){try{await api('close');}catch{}attached=false;lastBounds='';controls();}
      return;
    }
    if(blocked)return;
    try{
      let result=null,startPolling=false;
      if(supported===null)supported=(await api('state')).available;
      if(!supported){say('请在仓鼠AI桌面应用中打开个人中心，或使用下方网页版入口。');controls();return;}
      box=visibleBounds();if(!box)return;
      if(!attached){
        result=await api('open',box);supported=result.available;startPolling=true;
        if(!supported){say('当前环境暂不支持应用内个人中心，请使用网页版入口。');controls();return;}
        attached=true;lastBounds=JSON.stringify(box);controls();
      }else if(lastBounds!==JSON.stringify(box)){await api('bounds',box);lastBounds=JSON.stringify(box);}
      if(reload){reload=false;stopPolling();result=await api('reload');startPolling=true;}
      else if(checkState){checkState=false;result=await api('state');}
      if(!visibleBounds()){stopPolling();await api('close');attached=false;lastBounds='';controls();return;}
      if(result){if(!result.available)throw Error('account_view_unavailable');phase(result,startPolling);}
      if(badge){badge.textContent='个人中心';badge.dataset.state='';}
    }catch{
      blocked=true;stopPolling();try{await api('close');}catch{}attached=false;lastBounds='';controls();
      say('个人中心暂时无法打开，请重试或使用网页版。已保存的连接 Key 保持不变。',true);
    }
  }
  function schedule(){
    if(destroyed)return;
    dirty=true;if(scheduled||running)return;scheduled=true;
    requestFrame(()=>{scheduled=false;if(destroyed)return;
      running=(async()=>{while(dirty&&!destroyed){dirty=false;await sync();}})().finally(()=>{running=null;if(dirty&&!destroyed)schedule();});
    });
  }
  openButton.onclick=()=>{paused=false;blocked=false;supported=null;say('正在打开个人中心…');schedule();};
  reloadButton.onclick=()=>{if(!attached)return;paused=false;blocked=false;reload=true;say('正在返回个人中心…');schedule();};
  closeButton.onclick=()=>{paused=true;say('已收起');schedule();};
  const panelObserver=MutationObserver?new MutationObserver(()=>{if(!panel.classList.contains('active'))paused=false;schedule();}):null;
  panelObserver?.observe(panel,{attributes:true,attributeFilter:['class','hidden']});
  const dialogObserver=MutationObserver?new MutationObserver(schedule):null;
  dialogObserver?.observe(document.body,{subtree:true,attributes:true,attributeFilter:['open']});
  const resizeObserver=ResizeObserver?new ResizeObserver(schedule):null;resizeObserver?.observe(viewport);
  document.addEventListener('visibilitychange',schedule);window.addEventListener('resize',schedule);window.addEventListener('scroll',schedule,true);
  window.addEventListener('hamster-startup-ready',schedule);window.addEventListener('hamster-view-changed',schedule);
  const close=()=>{destroyed=true;stopPolling();panelObserver?.disconnect();dialogObserver?.disconnect();resizeObserver?.disconnect();
    document.removeEventListener('visibilitychange',schedule);window.removeEventListener('resize',schedule);window.removeEventListener('scroll',schedule,true);
    window.removeEventListener('hamster-startup-ready',schedule);window.removeEventListener('hamster-view-changed',schedule);
    if(attached){attached=false;void api('close').catch(()=>{});}
  };
  window.addEventListener('pagehide',close,{once:true});controls();schedule();
  return {refresh:schedule,close};
}
