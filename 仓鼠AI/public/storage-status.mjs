const kinds=new Set(['image','video','tool','chat','legacy']);
const failures=new Set(['unauthorized','forbidden','account_mismatch']);
const known=new Set(['ready','unconfigured',...failures,'rate_limited','pending']);

export function storageStatusKind(view,type){
  if(view==='generate')return type==='image'?'image':'video';
  if(view==='digital'||view==='depth')return 'tool';
  return null;
}

export function storageStatusView(value={}){
  const {kind=null,state='idle',checking=false}=value;
  if(!kind)return {state:'idle',label:'素材权限不适用',checking:false};
  const name={image:'图片',video:'视频',tool:'工具',chat:'对话',legacy:'对象存储'}[kind]||'素材';
  const subject=kind==='legacy'?name:`${name}素材权限`;
  if(checking&&state==='idle')return {state:'checking',label:`正在检测${subject}`,checking:true};
  if(state==='ready')return {state:'ready',label:kind==='legacy'?'对象存储已连接':`${subject}已验证`,checking};
  if(state==='unconfigured')return {state:'idle',label:`${name}未配置 Key`,checking};
  if(failures.has(state))return {state:'failed',label:state==='forbidden'?`${name} Key 权限不符`:state==='account_mismatch'?`${name} Key 账户不一致`:`${name} Key 验证未通过`,checking};
  if(state==='pending'||state==='rate_limited')return {state:'pending',label:kind==='legacy'?'对象存储连接待确认':`${subject}待确认`,checking};
  return {state:'idle',label:`${subject}待检测`,checking};
}

// This controller only reads permission state. It never creates a quote or task.
export function createStorageStatusController({request,onChange=()=>{},now=Date.now,setTimer=setTimeout,clearTimer=clearTimeout,timeout=25000,successInterval=300000}={}){
  if(typeof request!=='function')throw new TypeError('Storage status request is required');
  const entries=new Map();
  let current=null,epoch=0,timer=null,visible=true,stopped=false;
  const entryFor=kind=>{
    let entry=entries.get(kind);
    if(!entry){entry={kind,state:'idle',checking:false,checkedAt:null,lastSuccessAt:null,failures:0,cooldownUntil:0,nextCheckAt:0,flight:null,controller:null};entries.set(kind,entry);}
    return entry;
  };
  function snapshot(kind=current){
    const entry=entries.get(kind);
    return entry?{kind:entry.kind,state:entry.state,checking:entry.checking,checkedAt:entry.checkedAt,lastSuccessAt:entry.lastSuccessAt,cooldownUntil:entry.cooldownUntil,nextCheckAt:entry.nextCheckAt}:{kind,state:'idle',checking:false,checkedAt:null,lastSuccessAt:null,cooldownUntil:0,nextCheckAt:0};
  }
  const render=()=>{if(!stopped)onChange(snapshot());};
  function schedule(){
    clearTimer(timer);timer=null;
    const entry=entries.get(current);
    if(stopped||!visible||!entry||entry.flight||!entry.nextCheckAt)return;
    timer=setTimer(()=>{timer=null;void check();},Math.min(2147483647,Math.max(1,entry.nextCheckAt-now())));
    timer?.unref?.();
  }
  function check({manual=false}={}){
    if(stopped||!current||!visible&&!manual)return Promise.resolve(snapshot());
    const kind=current,entry=entryFor(kind);
    if(entry.flight)return entry.flight;
    if(now()<entry.cooldownUntil){render();schedule();return Promise.resolve(snapshot());}
    if(!manual&&(entry.nextCheckAt>now()||(failures.has(entry.state)||entry.state==='unconfigured')&&entry.checkedAt&&now()-Date.parse(entry.checkedAt)<successInterval)){render();schedule();return Promise.resolve(snapshot());}
    const generation=epoch,controller=new AbortController();
    entry.controller=controller;entry.checking=true;
    render();
    let deadline;
    const expired=new Promise((_,reject)=>{controller.signal.addEventListener('abort',()=>reject(Error('storage_status_aborted')),{once:true});deadline=setTimer(()=>controller.abort(),timeout);deadline?.unref?.();});
    const execute=Promise.resolve().then(()=>request(kind,{signal:controller.signal}));
    entry.flight=Promise.race([execute,expired]).then(result=>{
      if(stopped||generation!==epoch||entries.get(kind)!==entry)return;
      const status=Number(result?.httpStatus)||0;
      let state=known.has(result?.state)?result.state:status===401?'unauthorized':status===403?'forbidden':status===409?'account_mismatch':status===429?'rate_limited':result?.connected===true?'ready':'pending';
      if(status===429)state='rate_limited';
      if(status===401&&state!=='unconfigured')state='unauthorized';
      if(status===403)state='forbidden';
      if(status===409)state='account_mismatch';
      if(kind!=='legacy'&&result?.kind!==kind)state='pending';
      if(status>=500)state='pending';
      if(state==='ready'&&(result?.connected!==true||status&&status!==200))state='pending';
      const timestamp=value=>typeof value==='string'&&Number.isFinite(Date.parse(value))&&Date.parse(value)<=now()?new Date(value).toISOString():null;
      entry.state=state;entry.checkedAt=timestamp(result?.checkedAt)||new Date(now()).toISOString();
      const lastSuccess=kind==='legacy'||result?.kind===kind?timestamp(result?.lastSuccessAt):null;
      const retry=Number.isSafeInteger(result?.retryAfterMs)&&result.retryAfterMs>0?Math.min(3600000,result.retryAfterMs):0;
      if(lastSuccess&&(!entry.lastSuccessAt||Date.parse(lastSuccess)>Date.parse(entry.lastSuccessAt)))entry.lastSuccessAt=lastSuccess;
      if(state==='ready'){
        entry.lastSuccessAt=lastSuccess||entry.checkedAt;entry.failures=0;entry.cooldownUntil=0;entry.nextCheckAt=Math.max(now()+1,Date.parse(entry.checkedAt)+successInterval);
      }else if(state==='pending'||state==='rate_limited'){
        entry.failures++;
        const delay=Math.max(Math.min(60000,10000*2**Math.min(3,entry.failures-1)),retry);
        entry.cooldownUntil=now()+delay;entry.nextCheckAt=entry.cooldownUntil;
      }else{entry.failures=0;entry.cooldownUntil=retry?now()+retry:0;entry.nextCheckAt=0;}
    },()=>{
      if(stopped||generation!==epoch||entries.get(kind)!==entry)return;
      entry.state='pending';entry.checkedAt=new Date(now()).toISOString();entry.failures++;
      entry.cooldownUntil=now()+Math.min(60000,10000*2**Math.min(3,entry.failures-1));entry.nextCheckAt=entry.cooldownUntil;
    }).finally(()=>{
      clearTimer(deadline);
      if(generation!==epoch||entries.get(kind)!==entry)return;
      entry.flight=null;entry.controller=null;entry.checking=false;
      if(current===kind){render();schedule();}
    });
    return entry.flight;
  }
  function select(kind){
    if(kind!==null&&!kinds.has(kind))throw new TypeError('Invalid storage permission kind');
    if(stopped)return Promise.resolve(snapshot());
    if(current===kind){render();return Promise.resolve(snapshot());}
    current=kind;render();schedule();
    if(!kind)return Promise.resolve(snapshot());
    const entry=entryFor(kind);
    if(entry.flight)return entry.flight;
    if(entry.state==='idle'||entry.nextCheckAt&&now()>=entry.nextCheckAt)return check();
    render();schedule();return Promise.resolve(snapshot());
  }
  function reset(){
    epoch++;clearTimer(timer);timer=null;
    for(const entry of entries.values())entry.controller?.abort();
    entries.clear();current=null;render();
  }
  function wake(){return check();}
  function setVisible(value){
    const changed=visible!==Boolean(value);visible=Boolean(value);
    if(!visible){clearTimer(timer);timer=null;return;}
    if(changed)void wake();else schedule();
  }
  function stop(){if(stopped)return;reset();stopped=true;}
  return {select,check,reset,wake,setVisible,snapshot,stop};
}
