const $=s=>document.querySelector(s),esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const tabs={overview:'经营概览',customers:'客户管理',recharges:'充值审核',notifications:'到账邮件',keys:'登录会话',pool:'线路配置',tasks:'生成任务',ledger:'钱包流水',models:'价格配置',audit:'操作审计'};
const labels={active:'启用',disabled:'禁用',paused:'停用',revoked:'已撤销',pending:'待审核',approved:'已入账',rejected:'已驳回',queued:'排队',preparing:'准备素材',submitting:'提交中',unknown:'待核查',processing:'生成中',transferring:'转存中',succeeded:'成功',failed:'失败',cancelled:'已取消',hold:'冻结',settle:'扣费',release:'解冻',recharge:'充值',refund:'退款',test_credit:'测试额度'};
const channels={main:'主线路',backup:'官方备选线路',tool:'仓鼠工具服务',image:'图片专用线路'};
// Discard the legacy credential; management sessions now use HttpOnly cookies only.
try{sessionStorage.removeItem('hamster_admin');}catch{}
let loggedIn=false,challenge=null,section='overview',data,editAction,sendAfter=0;
const yuan=n=>'¥'+(Number(n||0)/1e6).toFixed(2),date=n=>n?new Date(n).toLocaleString('zh-CN'):'—';
async function api(path,body){const r=await fetch('/admin/api/'+path,{method:body?'POST':'GET',credentials:'same-origin',headers:{'Content-Type':'application/json','X-Hamster-Admin':'1'},...(body?{body:JSON.stringify(body)}:{})});const d=await r.json();if(!r.ok){if(r.status===401){loggedIn=false;showLogin();}throw Object.assign(Error(d.error||'请求失败'),{status:r.status});}return d;}
function showLogin(){$('#login').hidden=loggedIn;$('#content').hidden=!loggedIn;$('#logout').hidden=!loggedIn;$('#refresh').hidden=!loggedIn;if(!loggedIn){$('#content').innerHTML='';data=null;if($('#editor').open)$('#editor').close();}}
const tag=s=>'<span class="tag">'+esc(labels[s]||s)+'</span>';
const btn=(label,action,row={})=>`<button data-action="${action}" data-row="${esc(JSON.stringify(row))}">${label}</button>`;
function table(headers,rows){return '<div class="table-wrap"><table><thead><tr>'+headers.map(h=>'<th>'+h+'</th>').join('')+'</tr></thead><tbody>'+ (rows.length?rows.map(r=>'<tr>'+r.map(c=>'<td>'+c+'</td>').join('')+'</tr>').join(''):'<tr><td class="empty" colspan="'+headers.length+'">暂无记录</td></tr>')+'</tbody></table></div>';}
function input(name,label,value='',type='text'){return `<label>${label}<input name="${name}" type="${type}" value="${esc(value)}" required></label>`;}
function select(name,label,choices,value){return `<label>${label}<select name="${name}">${choices.map(([v,t])=>`<option value="${esc(v)}" ${v===value?'selected':''}>${esc(t)}</option>`).join('')}</select></label>`;}
async function load(){
 $('#title').textContent=tabs[section];showLogin();if(!loggedIn)return;
 try{data=await api(section);$('#notice').textContent='';render();}catch(e){$('#notice').textContent=e.message;}
}
function render(){
 let html='';
 if(section==='overview'){
  const enabled=data.settings.find(s=>s.key==='generation_enabled')?.value==='true';
  html='<div class="cards">'+[['正式客户数量',data.customers.count],['正式客户余额',yuan(data.customers.balance)],['正式客户冻结',yuan(data.customers.held)],['待审核充值',data.recharges.count]].map(([a,b])=>`<div class="card">${a}<strong>${b}</strong></div>`).join('')+'</div>';
  html+=`<div class="panel"><h2>生成服务 ${enabled?'已开放':'未开放'}</h2><p>先在「线路配置」保存主线路和官方备选线路密钥，再开放服务。工具服务另需配置工具密钥。失败任务不扣费，生成成功且结果转存完成后结算。</p>${btn(enabled?'暂停新任务':'开放生成服务','generation-switch',{enabled:!enabled})}</div>`;
  html+='<div class="channel-cards">'+['main','backup','tool'].map(p=>{const n=data.channels?.find(c=>c.provider===p)?.active_keys||0;return '<div class="panel"><span class="eyebrow">线路就绪检查</span><h2>'+channels[p]+'</h2><p class="'+(n?'ready':'missing')+'">'+(n?'已配置 · '+n+' 个有效密钥':'未配置 · 无法提交任务')+'</p><button data-tab="pool">前往配置 →</button></div>';}).join('')+'</div>';
  html+=table(['任务状态','数量'],data.tasks.map(t=>[tag(t.state),t.count]));
 }
 if(section==='customers'){html='<div class="toolbar">'+btn('新增客户','customers')+'</div>';html+=table(['客户 / 邮箱','状态','余额 / 冻结','客户并发','操作'],data.map(r=>[esc(r.name)+`<small>${esc(r.email)}</small><small>${esc(r.id)}</small>`,tag(r.status)+(r.is_test?' · 内部测试':''),yuan(r.balance)+`<small>冻结 ${yuan(r.held)}</small>`,r.max_concurrency,btn('账户设置','customer-status',r)+(r.is_test?btn('发放 ¥22.30 测试额度','test-credit',r):'')]));}
 if(section==='keys')html=table(['客户 / 登录会话','状态','最近使用','操作'],data.map(r=>[esc(r.email)+`<small>${esc(r.name)} · ${esc(r.preview)}</small>`,tag(r.status),date(r.last_used_at),r.status==='revoked'?'—':btn(r.status==='active'?'停用':'启用','key-action',{...r,action:r.status==='active'?'pause':'resume'})+btn('撤销','key-action',{...r,action:'revoke'})]));
 if(section==='pool'){
  html='<div class="panel"><h2>线路密钥与并发</h2><p>主线路密钥用于图片与主线路视频，官方备选线路密钥用于备选视频，工具服务密钥用于数字人与黑白深度。密钥加密保存在云端，客户无需填写；同一服务账户的多个密钥应放入同一分组，共享并发上限。</p><div class="toolbar">'+btn('新增账户分组','provider-account')+btn('添加线路密钥','pool')+'</div>'+table(['账户','渠道','在途 / 上限','操作'],data.accounts.map(a=>[esc(a.name),esc(channels[a.provider]||'仓鼠服务'),a.inflight+' / '+a.max_concurrency,btn('设置上限','provider-account-update',a)]))+'</div>';
  html+=table(['Key','渠道 / 账户','状态','在途 / 上限','异常','操作'],data.keys.map(k=>[esc(k.name)+`<small>${esc(k.preview)}</small>`,esc(channels[k.provider]||'仓鼠服务')+`<small>${esc(data.accounts.find(a=>a.id===k.account_id)?.name)}</small>`,tag(k.status),k.inflight+' / '+k.max_concurrency,esc(k.last_error||'—'),btn('设置','pool-update',k)]));
 }
 if(section==='recharges')html='<p>收款方：鹿鸣一方传媒。仅客户点击「我已确认付款」后进入审核，未付款申请不显示。请人工核对真实到账时间、金额及收款交易号；客户确认时间不等于到账时间，截图不能代替到账记录。不通过的申请直接删除，已入账记录保留。</p>'+table(['客户邮箱','申请金额','申请时间','客户确认付款时间','实际到账时间','状态','收款交易号','操作'],data.map(r=>[esc(r.email_snapshot),yuan(r.amount),date(r.created_at),r.payment_reported_at?date(r.payment_reported_at):'历史未记录',date(r.received_at),tag(r.state),esc(r.transaction_id||'—'),r.state==='pending'?btn('审核','recharge-review',r):esc(r.note)]));
 if(section==='notifications')html='<p>邮件失败不会撤销或重复入账。「已提交 邮件服务」表示服务商已接收，不代表收件箱已送达。超过安全重试窗口需在 邮件服务 核对记录，禁止重新审核入账。</p>'+table(['订单 / 邮箱','邮件状态','尝试次数','服务商编号','说明','时间'],data.map(r=>[esc(r.order_id)+`<small>${esc(r.recipient)}</small>`,esc(({pending:'待发送',sending:'发送中',sent:'已提交 邮件服务',retry:'等待重试',needs_review:'需人工核查'})[r.state]||r.state),r.attempts,esc(r.provider_id||'—'),esc(r.last_error||'—'),date(r.sent_at||r.created_at)]));
 if(section==='tasks')html=table(['任务 / 客户','模型','状态','冻结 / 扣费','说明','操作'],data.map(t=>[esc(t.id)+`<small>${esc(t.email)}</small>`,esc(t.model_id),tag(t.state),yuan(t.reserved)+' / '+yuan(t.charged),esc(t.error||'—'),['unknown','submitting'].includes(t.state)?btn('核查处理','task-reconcile',t):t.state==='succeeded'?btn('退回钱包','refund',t):'—']));
 if(section==='ledger')html=table(['客户','类型','金额','余额变化','冻结变化','关联记录','时间'],data.map(r=>[esc(r.email),tag(r.kind),yuan(r.amount),yuan(r.balance_delta),yuan(r.held_delta),esc(r.reference_id),date(r.created_at)]));
 if(section==='models'){html='<p>售价由管理员确认，价格变更只影响新任务；未定价项目不能开放扣费。</p>'+table(['线路','计费','客户单价','版本','操作'],data.map(r=>[esc(r.name),r.billing==='per_second'?'按秒':'按次',r.fixed_sale===0?'免费':r.fixed_sale!=null?yuan(r.fixed_sale):'待确认',r.version,btn('设置','model-update',r)]));}
 if(section==='audit')html=table(['操作','对象','操作者','详情','时间'],data.map(r=>[esc(r.action),esc(r.target),esc(r.actor),esc(r.detail),date(r.created_at)]));
 $('#content').innerHTML=(section==='overview'?'':'<div class="toolbar"><input id="search" placeholder="搜索当前列表中的邮箱、名称或编号"></div>')+html;
 $('#search')?.addEventListener('input',e=>{for(const tr of $('#content').querySelectorAll('tbody tr'))tr.hidden=!tr.textContent.toLowerCase().includes(e.target.value.toLowerCase());});
}
function edit(action,row){
 editAction={action,row};$('#edit-title').textContent=({customers:'新增客户',keys:'创建客户 Key','customer-status':'客户账户设置','test-credit':'发放内部测试额度','key-action':'管理登录会话','provider-account':'新增账户分组',pool:'添加线路密钥','pool-update':'线路密钥设置','recharge-review':'审核充值','task-reconcile':'核查任务','model-update':'价格设置','sync-prices':'同步上游价格','generation-switch':'生成服务开关'})[action];
 let f='';if(action==='customers')f=input('email','客户注册邮箱','','email')+input('name','客户名称')+input('max_concurrency','客户最大在途任务',100,'number')+'<label><input name="is_test" type="checkbox"> 内部测试账户（不计入正式客户余额，不能申请充值）</label>';
 if(action==='test-credit')f='<p>仅向此内部测试账户发放一次 ¥22.30 测试额度，不创建充值订单，也不代表实际收款。</p>';
 
 if(action==='customer-status')f=select('status','账户状态',[['active','启用'],['disabled','禁用']],row.status)+input('max_concurrency','最大在途任务',row.max_concurrency,'number');
 if(action==='key-action')f='<p>操作：'+esc({pause:'停用',resume:'启用',rotate:'轮换',revoke:'永久撤销'}[row.action])+'。已受理的任务继续处理，余额与历史记录保留。</p>';
 if(action==='provider-account')f=select('provider','渠道',[['main','主线路 · 图片与视频'],['backup','官方备选线路'],['tool','仓鼠工具服务']])+input('name','账户分组名称')+input('max_concurrency','整个服务账户并发上限',100,'number');
 if(action==='pool')f=select('account_id','所属线路分组',data.accounts.map(a=>[a.id,(channels[a.provider]||'仓鼠服务')+' · '+a.name]))+input('name','密钥备注名称')+input('secret','线路密钥','','password')+input('max_concurrency','单 Key 并发上限（1—100）',100,'number')+input('priority','优先级（0—100）',0,'number');
 if(action==='pool-update')f=select('status','状态',[['active','启用'],['paused','停用']],row.status)+input('max_concurrency','单 Key 并发上限（1—100）',row.max_concurrency,'number')+input('priority','优先级',row.priority,'number');
 if(action==='provider-account-update')f=input('max_concurrency','账户总并发上限',row.max_concurrency,'number');
 if(action==='refund')f='<p>将本次消耗 '+yuan(row.charged)+' 全额退回客户钱包，同一任务仅退一次。这不会自动退回支付宝。</p>';
 if(action==='provider-account-update')$('#edit-title').textContent='账户总并发设置';
 if(action==='refund')$('#edit-title').textContent='退回客户钱包';
 if(action==='recharge-review')f='<p>'+esc(row.email_snapshot)+' · '+yuan(row.amount)+'<br>客户确认付款：'+(row.payment_reported_at?date(row.payment_reported_at):'历史未记录')+'<br>请以真实收款记录为准，不要求客户填写付款订单号。</p>'+select('decision','审核结论',[['approve','确认实际到账，入账'],['reject','不通过并删除申请']])+input('transaction_id','收款交易号（管理员核对，用于防重复入账）')+input('confirmed_amount','实际到账金额（元）','','number')+input('received_at','实际到账时间（按收款记录，本机时区）','','datetime-local');
 if(action==='task-reconcile')f='<p>仅在上游后台核实后处理。禁止为状态不明的任务重新生成。</p>'+select('decision','处理方式',[['link','关联已存在的上游视频任务'],['failed','已核实任务失败，解冻']])+input('upstream_id','上游任务 ID（确认失败可留空）');
 if(action==='model-update')f=select('enabled','是否开放新任务',[['true','开放'],['false','关闭']],row.enabled?'true':'false')+input('sale_rate','已确认的客户售价（元）',(row.fixed_sale||0)/1e6,'number');
 if(action==='generation-switch')f='<p>确认'+(row.enabled?'开放':'暂停')+'新生成任务？已受理任务将继续处理。</p>';
 f+='<label>操作原因<textarea name="reason" required minlength="2" maxlength="300"></textarea></label>';
 $('#fields').innerHTML=f;for(const e of $('#fields').querySelectorAll('input[type=number]'))e.step='any';
 if(action==='task-reconcile')$('#fields [name=upstream_id]').required=false;
 if(action==='recharge-review'){const decision=$('#fields [name=decision]');$('#fields [name=received_at]').step='1';decision.onchange=e=>{for(const name of ['transaction_id','confirmed_amount','received_at']){const field=$('#fields [name='+name+']');field.required=e.target.value==='approve';field.disabled=e.target.value!=='approve';field.closest('label').hidden=e.target.value!=='approve';}};decision.onchange({target:decision});}
 $('#edit-error').textContent='';$('#editor').showModal();
}
$('#nav').innerHTML=Object.entries(tabs).map(([k,v])=>`<button data-tab="${k}" class="${k==='overview'?'active':''}">${v}</button>`).join('');
$('#nav').onclick=e=>{const b=e.target.closest('[data-tab]');if(!b)return;section=b.dataset.tab;for(const x of $('#nav').children)x.classList.toggle('active',x===b);load();};
$('#content').onclick=e=>{const tab=e.target.closest('[data-tab]');if(tab){$('#nav [data-tab="'+tab.dataset.tab+'"]').click();return;}const b=e.target.closest('[data-action]');if(b)edit(b.dataset.action,JSON.parse(b.dataset.row));};
$('#admin-email').oninput=()=>{challenge=null;$('#admin-code').value='';$('#login-submit').disabled=true;};
function updateSendButton(){const left=Math.max(0,Math.ceil((sendAfter-Date.now())/1000));$('#send-code').disabled=left>0;$('#send-code').textContent=left?`${left} 秒后重发`:'获取验证码';}
setInterval(updateSendButton,1000);
$('#send-code').onclick=async()=>{
 const input=$('#admin-email');if(!input.reportValidity())return;
 const email=input.value.trim().toLowerCase();sendAfter=Date.now()+60000;updateSendButton();$('#login-status').textContent='正在发送验证码…';
 try{const r=await api('auth/code',{email});challenge={id:r.challenge_id,email};$('#login-submit').disabled=false;$('#admin-code').value='';$('#admin-code').focus();$('#login-status').textContent='验证码已发送，请查收邮箱（也请检查垃圾邮件），10 分钟内有效。';}
 catch(e){$('#login-status').textContent=e.message;}
};
$('#login-form').onsubmit=async e=>{e.preventDefault();if(!challenge||challenge.email!==$('#admin-email').value.trim().toLowerCase())return;$('#login-submit').disabled=true;
 try{await api('auth/verify',{email:challenge.email,challenge_id:challenge.id,code:$('#admin-code').value.trim()});loggedIn=true;challenge=null;$('#admin-code').value='';$('#login-status').textContent='验证码 10 分钟内有效，仅可使用一次。';await load();}
 catch(e){$('#login-status').textContent=e.message;}finally{$('#login-submit').disabled=!challenge;}
};
$('#logout').onclick=async()=>{try{await api('auth/logout',{});loggedIn=false;challenge=null;showLogin();$('#notice').textContent='已安全退出管理';}catch(e){$('#notice').textContent=e.message;}};$('#refresh').onclick=load;$('#cancel').onclick=()=>$('#editor').close();
$('#edit-form').onsubmit=async e=>{e.preventDefault();const {action,row}=editAction,p={...Object.fromEntries(new FormData(e.target)),...(row.id?{id:row.id}:{}),...(row.user_id?{user_id:row.user_id}:{})};
 if(action==='customers')p.is_test=p.is_test==='on';
 if(action==='key-action'){p.action=row.action;p.version=row.version;}if(action==='generation-switch')p.enabled=row.enabled;if(action==='recharge-review')p.approve=p.decision==='approve';if(action==='task-reconcile')p.confirmed_failed=p.decision==='failed';if(action==='model-update')p.enabled=p.enabled==='true';
 if(action==='recharge-review'&&p.approve){p.received_at=new Date(p.received_at).getTime();if(!confirm('请再次核对真实到账后确认：\n邮箱：'+row.email_snapshot+'\n入账金额：'+yuan(row.amount)+'\n实际到账时间：'+date(p.received_at)+'\n收款交易号：'+p.transaction_id+'\n确认将立即入账，并发送到账通知邮件。'))return;p.manual_confirmed=true;}
 if(action==='recharge-review'&&!p.approve&&!confirm('确定不通过并删除此充值申请？\n'+row.email_snapshot+' · '+yuan(row.amount)+'\n删除后不再展示，不会入账，也不会自动退回已支付款项。'))return;
 $('#submit').disabled=true;try{const r=await api(action,p);$('#editor').close();await load();}catch(e){$('#edit-error').textContent=e.message;}finally{$('#submit').disabled=false;}};
showLogin();
api('auth/session').then(()=>{loggedIn=true;return load();}).catch(e=>{if(e.status!==401)$('#login-status').textContent=e.message;});
