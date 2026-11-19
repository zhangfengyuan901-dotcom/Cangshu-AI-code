const {validBounds}=require('../relay-account-view.cjs');
const path=require('node:path');
const crypto=require('node:crypto');
const {normalizeAccountFailure}=require('../report-schema.cjs');
const CHANNEL='hamster-account-command';
const ACCOUNT_HOME='https://www.piknoai.com/account-lite/index.html';
const PAYMENT_ORIGIN='https://2347637.pay.lanjingzf.com';
const PARTITION='persist:hamster-relay-account';
function parsed(value){try{const url=new URL(value);return url.username||url.password?null:url;}catch{return null;}}
function createAccountView({window:win,electron,homeUrl=ACCOUNT_HOME,allowLoopbackForTests=false,connectCreatedKey,onConfigured=()=>{},reportFailure=()=>{}}={}){
  const home=parsed(homeUrl);
  if(!home||home.href!==ACCOUNT_HOME&&!(allowLoopbackForTests&&home.protocol==='http:'&&home.hostname==='127.0.0.1'&&home.pathname==='/account-lite/index.html'&&!home.search&&!home.hash))throw Error('Invalid account origin');
  const {WebContentsView,session}=electron;
  const remoteSession=session.fromPartition(PARTITION),popups=new Set();
  const preferences={partition:PARTITION,contextIsolation:true,nodeIntegration:false,nodeIntegrationInSubFrames:false,sandbox:true,webSecurity:true,allowRunningInsecureContent:false,webviewTag:false,preload:path.join(__dirname,'account-lifecycle.cjs')};
  let view=null,attached=false,disposed=false,phase='closed',rect=null;
  let contextUserId=null,contextEpoch=0,queue=Promise.resolve();
  const completed=new Map(),reportNext=new Map();
  const resetContext=()=>{contextUserId=null;contextEpoch++;completed.clear();};
  const trusted=event=>{
    try{
      if(disposed||!view||view.webContents.isDestroyed()||event.sender!==view.webContents||event.senderFrame!==view.webContents.mainFrame)return false;
      return parsed(event.senderFrame.url)?.href===home.href;
    }catch{return false;}
  };
  const failure=(code,httpStatus=0)=>{
    const clean=normalizeAccountFailure({code,httpStatus});if(!clean)return;
    const time=Date.now();if((reportNext.get(code)||0)>time)return;
    reportNext.set(code,time+60000);try{reportFailure(clean);}catch{}
  };
  const invalid=()=>({ok:false,code:'INVALID_REQUEST'});
  const validKey=value=>{
    if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!=='createdAt,group,key,keyId,name,requestId,userId')return false;
    return Number.isSafeInteger(value.keyId)&&value.keyId>0&&Number.isSafeInteger(value.userId)&&value.userId>0&&['image-standard','video-standard','tool-standard','chat-standard'].includes(value.group)&&typeof value.name==='string'&&value.name.length>0&&value.name.length<=100&&!/[\u0000-\u001f]/.test(value.name)&&Number.isSafeInteger(value.createdAt)&&value.createdAt>0&&typeof value.key==='string'&&/^sk-[a-zA-Z0-9]{20,128}$/.test(value.key)&&typeof value.requestId==='string'&&/^[a-zA-Z0-9-]{16,80}$/.test(value.requestId);
  };
  async function command(event,action,value){
    if(!trusted(event))return {ok:false,code:'FORBIDDEN'};
    if(action==='context'){
      if(!value||typeof value!=='object'||Object.keys(value).join(',')!=='userId'||value.userId!==null&&(!Number.isSafeInteger(value.userId)||value.userId<1))return invalid();
      if(value.userId!==contextUserId){resetContext();contextUserId=value.userId;}
      return {ok:true};
    }
    if(action==='failure'){
      const clean=normalizeAccountFailure(value);if(!clean)return invalid();
      failure(clean.code,clean.httpStatus);return {ok:true};
    }
    if(action!=='connect'||!validKey(value))return invalid();
    if(!contextUserId||value.userId!==contextUserId)return {ok:false,code:'ACCOUNT_CHANGED'};
    if(typeof connectCreatedKey!=='function')return {ok:false,code:'KEY_STORAGE_UNAVAILABLE'};
    const epoch=contextEpoch,fingerprint=crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
    const assertCurrent=()=>!disposed&&epoch===contextEpoch&&contextUserId===value.userId&&trusted(event);
    const work=async()=>{
      if(!assertCurrent())return {ok:false,code:'ACCOUNT_CHANGED'};
      const prior=completed.get(value.requestId);
      if(prior)return prior.fingerprint===fingerprint?prior.result:invalid();
      let result;
      try{
        result=await connectCreatedKey(value,{assertCurrent});
        const status=Number.isInteger(result?.httpStatus)&&result.httpStatus>=100&&result.httpStatus<=599?{httpStatus:result.httpStatus}:{};
        const metadata=result?.httpStatus===429?{httpStatus:429,retryAfterMs:Number.isFinite(result.retryAfterMs)?Math.max(1000,Math.min(3600000,result.retryAfterMs)):60000}:status;
        if(result?.ok===true&&['CONNECTED','SAVED_CHECK_PENDING'].includes(result.code)){
          result={ok:true,code:result.code,connected:result.code==='CONNECTED',...metadata};
          completed.set(value.requestId,{fingerprint,result});
          if(completed.size>128)completed.delete(completed.keys().next().value);
          try{onConfigured();}catch{}
          if(!result.connected&&result.httpStatus!==429)failure('ACCOUNT_CONNECT_FAILED',result.httpStatus);
        }else{
          const allowed=['ACCOUNT_CHANGED','ACCOUNT_MISMATCH','KEY_STORAGE_UNAVAILABLE','KEY_INVALID','KEY_FORBIDDEN','CONNECT_FAILED','RATE_LIMITED'];
          result={ok:false,code:allowed.includes(result?.code)?result.code:'CONNECT_FAILED',...metadata};
          if(result.code==='RATE_LIMITED'){result.httpStatus=429;result.retryAfterMs=metadata.retryAfterMs||60000;}
          else if(result.code!=='ACCOUNT_CHANGED')failure('ACCOUNT_KEY_IMPORT_FAILED',result.httpStatus);
        }
      }catch{result={ok:false,code:'CONNECT_FAILED'};failure('ACCOUNT_KEY_IMPORT_FAILED');}
      return result;
    };
    const pending=queue.then(work,work);queue=pending.then(()=>{},()=>{});return pending;
  }
  electron.ipcMain?.handle(CHANNEL,command);
  const state=()=>({available:!disposed&&!win.isDestroyed(),visible:attached,state:phase});
  const sameOrigin=value=>parsed(value)?.origin===home.origin;
  const paymentEntry=value=>{const target=parsed(value);return target?.origin===home.origin&&target.pathname==='/pay/lanjing/epay/submit.php'&&!target.search&&!target.hash;};
  const allowedNavigation=(value,payment=false,main=true)=>{
    const target=parsed(value);if(!target)return false;
    if(target.origin===home.origin)return true;
    return target.protocol==='https:'&&(payment&&target.origin===PAYMENT_ORIGIN||!main&&target.origin==='https://challenges.cloudflare.com');
  };
  remoteSession.setPermissionRequestHandler((contents,permission,callback,details)=>callback(permission==='clipboard-sanitized-write'&&sameOrigin(contents.getURL())&&details?.isMainFrame!==false&&sameOrigin(details?.requestingUrl||contents.getURL())));
  remoteSession.setPermissionCheckHandler((contents,permission,origin)=>permission==='clipboard-sanitized-write'&&origin===home.origin&&sameOrigin(contents?.getURL()));
  const blockDownload=event=>event.preventDefault();
  remoteSession.on('will-download',blockDownload);
  function policy(contents,payment=false){
    const guard=(event,url,_inPlace,isMain)=>{if(!allowedNavigation(event.url??url,payment,(event.isMainFrame??isMain)!==false))event.preventDefault();};
    contents.on('will-frame-navigate',guard);contents.on('will-redirect',guard);contents.on('will-navigate',guard);
    contents.setWindowOpenHandler(({url})=>paymentEntry(url)&&!payment?{action:'allow',overrideBrowserWindowOptions:{parent:win,width:760,height:760,minWidth:480,minHeight:600,autoHideMenuBar:true,title:'仓鼠AI · 充值',webPreferences:preferences}}:{action:'deny'});
    contents.on('did-create-window',(child)=>{
      popups.add(child);policy(child.webContents,true);
      child.on('closed',()=>popups.delete(child));
    });
    contents.on('will-attach-webview',event=>event.preventDefault());
  }
  function bounds(next){
    if(!validBounds(next))throw Error('Invalid account bounds');
    rect=next;
    if(!view||!attached)return state();
    const [width,height]=win.getContentSize(),zoom=win.webContents.getZoomFactor();
    const x=Math.max(0,Math.min(width-1,Math.round(next.x*zoom))),y=Math.max(0,Math.min(height-1,Math.round(next.y*zoom)));
    view.setBounds({x,y,width:Math.max(1,Math.min(width-x,Math.round(next.width*zoom))),height:Math.max(1,Math.min(height-y,Math.round(next.height*zoom)))});
    return state();
  }
  function close(){if(attached){if(!view.webContents.isDestroyed())view.webContents.send('hamster-account-view-hidden');view.setVisible(false);if(!win.isDestroyed())win.contentView.removeChildView(view);attached=false;}return state();}
  function loadHome(){
    phase='loading';
    // No remote HTML or auth state is read by the local application.
    void view.webContents.loadURL(home.href).catch(()=>{if(!disposed)phase='error';});
    return state();
  }
  function open(next){
    if(disposed||win.isDestroyed())throw Error('Account view closed');
    if(!validBounds(next))throw Error('Invalid account bounds');
    if(!view){
      view=new WebContentsView({webPreferences:preferences});policy(view.webContents);
      view.webContents.on('did-start-navigation',(_event,_url,inPlace,main)=>{if(main&&!inPlace)resetContext();});
      view.webContents.on('did-start-loading',()=>{phase='loading';});
      view.webContents.on('did-stop-loading',()=>{if(phase!=='error')phase='ready';});
      view.webContents.on('did-fail-load',(_event,code,_description,_url,main)=>{if(main&&code!==-3){phase='error';failure('ACCOUNT_CONNECT_FAILED');}});
      view.webContents.on('render-process-gone',()=>{resetContext();phase='error';});
      loadHome();
    }
    if(!attached){win.contentView.addChildView(view);view.setVisible(true);attached=true;}
    bounds(next);return state();
  }
  function reload(){if(!view)return state();return loadHome();}
  function dispose(){
    if(disposed)return;
    close();disposed=true;phase='closed';resetContext();electron.ipcMain?.removeHandler(CHANNEL);
    remoteSession.removeListener('will-download',blockDownload);
    for(const popup of popups)if(!popup.isDestroyed())popup.destroy();
    popups.clear();if(view&&!view.webContents.isDestroyed())view.webContents.close();view=null;
  }
  win.on('resize',()=>{if(rect&&attached)bounds(rect);});
  win.webContents.on('did-start-loading',close);
  win.webContents.on('render-process-gone',close);
  win.webContents.on('destroyed',close);
  win.on('closed',dispose);
  return {state,open,bounds,close,reload,dispose};
}
module.exports={ACCOUNT_HOME,PARTITION,CHANNEL,createAccountView};
