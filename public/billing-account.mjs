const $=s=>document.querySelector(s),currency=v=>'¥'+Number(v||0).toFixed(2);
let account=null,configured=false,refreshing=null,challenge=null,cooldown=0,pending=null,order=null;
try{const p=JSON.parse(localStorage.getItem('hamster_recharge_order_draft')||'null');if(p&&typeof p.email==='string'&&typeof p.amount==='string'&&typeof p.key==='string')pending=p;}catch{ /* Damaged drafts must not prevent login. */ }
async function api(path,{method='GET',data,key}={}){
 const response=await fetch('/api/billing'+path,{method,headers:{'Content-Type':'application/json',...(key?{'Idempotency-Key':key}:{})},...(data?{body:JSON.stringify(data)}:{}),signal:AbortSignal.timeout(25000)});
 const result=await response.json();if(!response.ok){if([401,403].includes(response.status)&&!path.startsWith('/auth/'))window.dispatchEvent(new Event('hamster-session-invalidated'));throw Object.assign(Error(result.error||'账户请求失败'),{status:response.status});}return result;
}
function message(text,error=false){$('#billingStatus').textContent=text;$('#billingStatus').classList.toggle('error',error);}
function rows(target,items,text,empty){const root=$(target);root.replaceChildren();if(!items.length){root.textContent=empty;return;}for(const item of items){const p=document.createElement('p');p.textContent=text(item);root.append(p);}}
function unavailable(text){
 account=null;$('#billingAccount').hidden=false;$('#billingWallet').hidden=true;$('#billingRecords').hidden=true;
 $('#openRecharge').hidden=false;
 $('#billingConnection').textContent=configured?'待验证':'未登录';$('#billingConnection').dataset.state=configured?'error':'inactive';
 for(const id of ['#billingBalance','#billingHeld','#billingAvailable'])$(id).textContent='—';
 message(text,configured);
}
function refresh(){
 if(refreshing)return refreshing;
 if(!configured){unavailable('请先验证邮箱，再进入钱包与充值。');return Promise.resolve(false);}
 $('#refreshWallet').disabled=true;
 refreshing=(async()=>{
  try{
   const me=await api('/me');if(!me.email_verified){window.dispatchEvent(new Event('hamster-session-invalidated'));$('#billingLoginEmail').value=me.email;unavailable('请先验证此账户邮箱，已有余额将保持不变。');return false;}
   account=me;$('#billingAccount').hidden=true;$('#billingWallet').hidden=false;$('#billingRecords').hidden=false;
   $('#billingConnection').textContent='已登录';$('#billingConnection').dataset.state='connected';$('#billingEmail').textContent=me.email;
   $('#billingBalance').textContent=currency(me.balance);$('#billingHeld').textContent=currency(me.frozen_balance);$('#billingAvailable').textContent=currency(me.available_balance);
   $('#openRecharge').hidden=Boolean(me.test_account);
   $('#walletHint').textContent=me.test_account?'内部测试额度，不对应实际充值；任务仍按售价冻结与结算。':'任务提交时预冻结，成功交付后结算；失败不扣费，冻结金额自动释放。';message('余额更新于 '+new Date().toLocaleTimeString());
  }catch(e){unavailable(e.message+'。请重试或重新验证邮箱。');return false;}
  const results=await Promise.allSettled([api('/recharges'),api('/ledger')]);
  if(results[0].status==='fulfilled')rows('#rechargeRecords',results[0].value.data.filter(r=>r.state!=='rejected'),r=>new Date(r.created_at).toLocaleString()+' · '+currency(r.amount/1e6)+' · '+(r.state==='pending'?(r.payment_reported?'待人工审核':'待付款 · 点击充值可继续'):'已入账')+(r.note?' · '+r.note:''),'暂无充值记录，点击「支付宝充值」开始。');
  else $('#rechargeRecords').textContent='充值记录加载失败，请刷新重试。';
  if(results[1].status==='fulfilled')rows('#billingLedger',results[1].value.data,r=>new Date(r.created_at).toLocaleString()+' · '+r.note+' · '+currency(r.amount/1e6),'暂无消费记录。');
  else $('#billingLedger').textContent='消费流水加载失败，请刷新重试。';
  return true;
 })().finally(()=>{refreshing=null;$('#refreshWallet').disabled=false;});return refreshing;
}
$('#requestBillingCode').onclick=async()=>{
 const input=$('#billingLoginEmail'),email=input.value.trim().toLowerCase();if(!input.reportValidity())return;
 const button=$('#requestBillingCode');button.disabled=true;message('正在发送验证码…');
 try{const result=await api('/auth/code',{method:'POST',data:{email}});challenge={id:result.challenge_id,email};cooldown=Date.now()+60000;message('验证码已发送，请查收邮箱（也可检查垃圾邮件）。');$('#billingLoginCode').focus();}
 catch(e){message(e.message,true);}finally{button.disabled=Date.now()<cooldown;}
};
setInterval(()=>{const seconds=Math.max(0,Math.ceil((cooldown-Date.now())/1000));if(cooldown){$('#requestBillingCode').textContent=seconds?seconds+' 秒后重发':'重新获取验证码';$('#requestBillingCode').disabled=seconds>0;if(!seconds)cooldown=0;}},1000);
$('#billingLoginForm').onsubmit=async e=>{
 e.preventDefault();if(!challenge||challenge.email!==$('#billingLoginEmail').value.trim().toLowerCase()){message('请先为当前邮箱获取验证码。',true);return;}
 const button=$('#loginBilling');button.disabled=true;message('正在验证邮箱…');
 try{await api('/auth/verify',{method:'POST',data:{email:challenge.email,challenge_id:challenge.id,code:$('#billingLoginCode').value.trim()}});$('#billingLoginCode').value='';localStorage.removeItem('hamster_wallet_model_cache_v1');location.reload();}
 catch(e){message(e.message,true);}finally{button.disabled=false;}
};
$('#logoutBilling').onclick=async()=>{if(!confirm('退出当前账户？余额和任务记录会保留。'))return;$('#logoutBilling').disabled=true;try{await api('/auth/logout',{method:'POST'});window.dispatchEvent(new Event('hamster-session-invalidated'));location.reload();}catch(e){message(e.message,true);}finally{$('#logoutBilling').disabled=false;}};
$('#refreshWallet').onclick=()=>refresh();
function showOrder(){
 const form=$('#rechargeForm');form.elements.amount.value=order?Number(order.amount/1e6).toFixed(2):(pending?.email===account.email?pending.amount:'');form.elements.amount.readOnly=Boolean(order);
 form.elements.confirmed.checked=false;form.elements.confirmed.required=Boolean(order&&!order.payment_reported);$('#rechargePayment').hidden=!order;
 $('#submitRecharge').textContent=order?'我已确认付款':'创建充值申请';$('#submitRecharge').disabled=Boolean(order?.payment_reported);
 $('#rechargeStatus').textContent=order?(order.payment_reported?'已提交人工审核，请勿重复付款。':'请按申请金额扫码付款，付款后点击「我已确认付款」，无需填写付款订单号或备注。'):pending?.email===account.email?'上次创建结果尚未确认，请以原金额重试；无需重复付款。':'先填写金额创建申请，再扫码付款。';
}
$('#openRecharge').onclick=async()=>{
 $('#openRecharge').disabled=true;
 try{
  if(!configured||!await refresh()){$('#rechargeGate').showModal();return;}
  const recharges=(await api('/recharges')).data;order=recharges.find(r=>r.state==='pending'&&!r.payment_reported)||null;
  if(pending?.email!==account.email)pending=null;
  if(order){pending=null;localStorage.removeItem('hamster_recharge_order_draft');}
  $('#rechargeAccountLabel').textContent='充值账户：'+account.email;showOrder();$('#rechargeDialog').showModal();
 }catch(e){message(e.message,true);}finally{$('#openRecharge').disabled=false;}
};
$('#goActivate').onclick=()=>{$('#rechargeGate').close();$('#billingAccount').scrollIntoView({block:'center',behavior:'smooth'});$('#billingLoginEmail').focus();};
$('#closeRechargeGate').onclick=()=>$('#rechargeGate').close();
$('#closeRecharge').onclick=()=>$('#rechargeDialog').close();
$('#rechargeForm').onsubmit=async e=>{
 e.preventDefault();if(!account){$('#rechargeStatus').textContent='账户连接失效，请重新登录。';return;}
 $('#submitRecharge').disabled=true;
 try{
  if(order){
   if(!e.target.elements.confirmed.checked)throw Error('请先按申请金额完成付款并勾选确认。');
   await api('/recharges/'+order.id+'/paid',{method:'POST',data:{payment_confirmed:true}});order.payment_reported=1;showOrder();await refresh();return;
  }
  const raw=e.target.elements.amount.value;if(!/^\d+(\.\d{1,2})?$/.test(raw)||Number(raw)<1||Number(raw)>100000)throw Error('请输入 1—100000 元，最多两位小数。');
  const amount=Number(raw).toFixed(2);if(pending&&pending.amount!==amount)throw Error('上次订单结果未确认，请使用原金额 '+pending.amount+' 重试。');
  pending||={email:account.email,amount,key:crypto.randomUUID()};localStorage.setItem('hamster_recharge_order_draft',JSON.stringify(pending));
  order=await api('/recharges',{method:'POST',key:pending.key,data:{amount:pending.amount}});pending=null;localStorage.removeItem('hamster_recharge_order_draft');
  if(order.state!=='pending'){order=null;throw Error('此订单已审核，请关闭窗口并刷新记录。');}showOrder();await refresh();
 }catch(e){$('#rechargeStatus').textContent=e.message;}finally{$('#submitRecharge').disabled=Boolean(order?.payment_reported);}
};
fetch('/api/config').then(async r=>{if(!r.ok)throw Error('无法读取账户配置');return r.json();}).then(c=>{configured=Boolean(c.billingConfigured);return refresh();}).catch(e=>unavailable(e.message));
setInterval(()=>{if(configured&&!document.hidden)refresh();},30000);
window.addEventListener('hamster-billing-change',()=>{if(configured)refresh();});
