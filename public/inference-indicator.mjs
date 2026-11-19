// Connection is verified remotely; saved login state alone never lights the logo.
export function inferenceView({status='idle',activated=false},authenticated,relayMode=false){
 const connected=authenticated&&activated&&status==='ready';
 const checking=authenticated&&status==='checking';
 const message=!authenticated?(relayMode?'尚未配置 Key，请先到「账户」页填写 PIKNO Key':'尚未登录，请先到「账户」页完成邮箱登录')
  : checking?'正在检测仓鼠智能连接，请稍候'
  : connected?'仓鼠智能已连接'
  : status==='unavailable'?'仓鼠智能尚未开放或暂时不可用，请稍后重新检测'
  : status==='rejected'?(relayMode?'Key 验证未通过，请检查 PIKNO Key':'账户验证未通过，请重新登录')
  : status==='error'?'仓鼠智能连接失败，请检查网络后重试'
  :'仓鼠智能尚未检测';
 return {connected,checking,message,label:message+(checking?'':'；点击重新检测'),status:!authenticated?'signed-out':status};
}
export function createInferenceIndicator({isAuthenticated,request,onChange,notify=()=>{},isRelay=()=>false}){
 let current={status:'idle',activated:false},revision=0,pending=null;
 const view=authenticated=>inferenceView(current,authenticated,isRelay());
 const render=()=>onChange(view(isAuthenticated()));
 function reset(status='idle'){
  revision++;pending=null;
  current={status,activated:status==='error'&&current.activated};render();
 }
 function check({manual=false}={}){
  if(!isAuthenticated()){reset();if(manual)notify(view(false).message);return Promise.resolve();}
  if(pending)return pending;
  const checkId=++revision;current={...current,status:'checking'};render();
  pending=Promise.resolve().then(request).then(result=>{
   if(checkId!==revision||!isAuthenticated())return;
   current={activated:result?.configured===true,status:result?.configured===true?'ready':'rejected'};
  },error=>{
   if(checkId!==revision||!isAuthenticated())return;
   const rejected=[401,403].includes(error?.status);
   current={activated:!rejected&&current.activated,status:rejected?'rejected':isRelay()&&[404,503].includes(error?.status)?'unavailable':'error'};
  }).then(()=>{
   if(checkId!==revision)return;
   if(!isAuthenticated())current={status:'idle',activated:false};
   render();if(manual)notify(view(isAuthenticated()).message);
  }).finally(()=>{if(checkId===revision)pending=null;});
  return pending;
 }
 return {check,reset,render};
}
