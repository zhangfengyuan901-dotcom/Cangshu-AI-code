// New releases use PIKNO registration/recharge and protected local Key storage.
// The old account module is loaded only for the unchanged legacy release mode.
const config=await fetch('/api/config',{cache:'no-store'}).then(response=>{
  if(!response.ok)throw Error('无法读取账户配置');return response.json();
}).catch(()=>null);
if(!config){
  document.querySelector('.account-dashboard').textContent='无法读取账户配置，请重新加载应用。';
}else if(!config.relayMode){
  await import('./billing-account.mjs');
}else{
  const dashboard=document.querySelector('.account-dashboard');
  for(const id of ['rechargeGate','rechargeDialog'])document.getElementById(id)?.remove();
  dashboard.innerHTML=`<section class="account-card registration-card relay-account"><span class="eyebrow">PIKNO ACCOUNT</span><h2>连接 PIKNO，开始创作</h2><ol class="relay-steps"><li><strong>注册、充值并创建 Key</strong><p>打开 PIKNO，用同一个账户创建图片 Key、视频 Key 和工具 Key。三个 Key 共用账户余额；数字人和黑白深度视频共用工具 Key。</p><a class="plain-button" href="https://www.piknoai.com" target="_blank" rel="noopener noreferrer">打开 PIKNO · 注册与充值</a></li><li><strong>填写对应 Key，自动检测</strong><p>至少配置一个 Key，然后点击“保存并自动检测”。检测只校验身份和当前可调用线路，不创建生成任务，不扣费。</p><form id="relayKeyForm"><label>图片 Key<input id="relayImageKey" type="password" autocomplete="off" spellcheck="false" maxlength="131" placeholder="填写 PIKNO 图片 Key"></label><label class="relay-key-remove"><input id="removeRelayImageKey" type="checkbox">移除已保存的图片 Key（保存时生效）</label><label>视频 Key<input id="relayVideoKey" type="password" autocomplete="off" spellcheck="false" maxlength="131" placeholder="填写 PIKNO 视频 Key"></label><label class="relay-key-remove"><input id="removeRelayVideoKey" type="checkbox">移除已保存的视频 Key（保存时生效）</label><label>工具 Key（数字人 / 黑白深度视频）<input id="relayToolKey" type="password" autocomplete="off" spellcheck="false" maxlength="131" placeholder="填写 PIKNO 工具 Key"></label><label class="relay-key-remove"><input id="removeRelayToolKey" type="checkbox">移除已保存的工具 Key（保存时生效）</label><button class="plain-button" id="saveRelayKeys" type="submit">保存并自动检测</button></form><p id="relayKeySummary" class="hint"></p><p id="relayStorageWarning" class="relay-storage-warning" hidden>当前为开发模式：Key 仅保存在本次进程内，关闭应用后需要重新填写。</p><p class="hint">空白保留已保存的对应 Key；首次配置时空白表示未配置。替换时填写新 Key；单项移除请勾选该项，再保存。切换 PIKNO 账户时，请同时替换全部已配置 Key，或先移除旧 Key。已保存的 Key 不会回显，也不会写入浏览器存储、任务或诊断。</p></li><li><strong>确认连接，开始使用</strong><div class="relay-connection-grid" aria-live="polite"><p id="relayImageConnection" class="relay-connection" data-state="unconfigured">图片：未配置 Key</p><p id="relayVideoConnection" class="relay-connection" data-state="unconfigured">视频：未配置 Key</p><p id="relayToolConnection" class="relay-connection" data-state="unconfigured">工具：未配置 Key</p></div><p id="relayToolStatus" class="hint">数字人和黑白深度视频使用工具 Key；是否可用以各自已开放线路为准。</p><div class="relay-actions"><button id="recheckRelay" class="plain-button subtle" type="button">重新检测连接</button><button id="startRelay" class="plain-button" type="button" disabled>开始使用</button></div><p class="hint">对话和画布功能保留，未开放的线路会明确提示。对话沿用图片或视频 Key 授权；只有工具 Key 时不会开通对话。对话连接状态由左上角仓鼠图标单独检测，无需额外填写 Key。</p></li></ol><button id="disconnectRelay" class="plain-button subtle" type="button">移除本机 Key</button></section><p id="relayAccountStatus" class="account-feedback" role="status" aria-live="polite"></p><section class="account-card"><h2>充值与任务记录</h2><p>仓鼠展示 PIKNO 已发布线路名称、客户售价和本次预计费用，提交前请确认报价。充值、余额及实际费用明细统一在 PIKNO 查看。</p><a class="plain-button subtle" href="https://www.piknoai.com" target="_blank" rel="noopener noreferrer">到 PIKNO 查看</a></section>`;
  const badge=document.getElementById('billingConnection'),summary=document.getElementById('relayKeySummary'),status=document.getElementById('relayAccountStatus');
  const save=document.getElementById('saveRelayKeys'),recheck=document.getElementById('recheckRelay'),disconnect=document.getElementById('disconnectRelay'),start=document.getElementById('startRelay');
  const image=document.getElementById('relayImageKey'),video=document.getElementById('relayVideoKey'),tool=document.getElementById('relayToolKey');
  const removals=[['image','configured',image,document.getElementById('removeRelayImageKey')],['video','videoConfigured',video,document.getElementById('removeRelayVideoKey')],['tool','toolConfigured',tool,document.getElementById('removeRelayToolKey')]];
  for(const [, ,input,checkbox] of removals)checkbox.onchange=()=>{if(checkbox.checked)input.value='';input.disabled=busy||Boolean(checkbox.checked);};
  const kinds=[['image','图片','configured','relayImageConnection'],['video','视频','videoConfigured','relayVideoConnection'],['tool','工具','toolConfigured','relayToolConnection']];
  let current=config,busy=false,canStart=false,startView='generate';
  const hasConfiguration=()=>Boolean(current.configured||current.videoConfigured||current.toolConfigured);
  function updateSummary(){
    badge.textContent=hasConfiguration()?'已配置 Key':'待配置 Key';badge.dataset.state='';
    summary.textContent=`图片：${current.configured?'已配置':'未配置'}；视频：${current.videoConfigured?'已配置':'未配置'}；工具：${current.toolConfigured?'已配置':'未配置'}。${current.keyStorage==='memory'?'Key 仅保存在本次进程内。':'Key 由系统加密保护，已保存的 Key 不会回显。'}`;
    document.getElementById('relayStorageWarning').hidden=current.keyStorage!=='memory';
    recheck.disabled=!hasConfiguration();disconnect.disabled=!hasConfiguration();canStart=false;start.disabled=true;
    for(const [,field,input,checkbox] of removals){checkbox.checked=false;checkbox.disabled=!current[field];input.disabled=false;}
    for(const [,name,field,id] of kinds){
      const configured=Boolean(current[field]),element=document.getElementById(id);
      element.dataset.state=configured?'pending':'unconfigured';element.textContent=`${name}：${configured?'已配置，等待检测':'未配置 Key'}`;
    }
  }
  function setBusy(value){
    busy=value;save.disabled=value;
    for(const [,field,input,checkbox] of removals){checkbox.disabled=value||!current[field];input.disabled=value||Boolean(checkbox.checked);}
    recheck.disabled=value||!hasConfiguration();disconnect.disabled=value||!hasConfiguration();start.disabled=value||!canStart;
    document.getElementById('relayKeyForm').setAttribute('aria-busy',String(value));recheck.setAttribute('aria-busy',String(value));
  }
  function fixedError(code){
    return {400:'请填写 PIKNO 创建的有效图片、视频或工具 Key。',401:'Key 无效、已过期或账户不可用，请到 PIKNO 检查。',403:'Key 类型或权限不符，请分别填写图片 Key、视频 Key 和工具 Key。',409:'三个 Key 必须属于同一个 PIKNO 账户。请同时替换全部已配置 Key，或先移除旧 Key。'}[code]||'暂时无法完成连接，请稍后重新检测。现有配置未被替换。';
  }
  function renderConnection(result){
    let ready=false,failed=false;
    for(const [kind,name,field,id] of kinds){
      const item=result?.[kind],element=document.getElementById(id);
      const count=Number.isSafeInteger(item?.modelCount)&&item.modelCount>=0&&item.modelCount<=20000?item.modelCount:0;
      const state=item?.configured===false||!item&&!current[field]?'unconfigured':item?.configured===true&&item.state==='ready'&&count>0?'ready':item?.configured===true&&item.state==='unavailable'?'unavailable':item?.state==='forbidden'?'forbidden':'error';
      element.dataset.state=state;
      element.textContent=state==='unconfigured'?`${name}：未配置 Key`:state==='ready'?`${name}：连接正常，已可调用 ${count} 条线路`:state==='unavailable'?`${name}：连接正常，但暂无已开放${name}生成线路`:state==='forbidden'?`${name}：Key 权限不符，请到 PIKNO 检查分组与授权`:`${name}：检测未通过，请检查 Key 或稍后重试`;
      ready||=kind!=='tool'&&state==='ready';failed||=['error','forbidden'].includes(state);
    }
    document.getElementById('relayToolStatus').textContent=`数字人：${result?.tools?.digital===true?'已开放':'尚未开放'}；黑白深度视频：${result?.tools?.depth===true?'已开放':'尚未开放'}。两项工具共用工具 Key，未开放时不能提交任务。`;
    startView=ready?'generate':result?.tools?.digital===true?'digital':result?.tools?.depth===true?'depth':'generate';
    ready ||= result?.tools?.digital===true || result?.tools?.depth===true;
    badge.textContent=ready?'连接正常':failed?'连接未确认':hasConfiguration()?'暂无可用线路':'待配置 Key';
    badge.dataset.state=ready?'connected':failed?'error':'';canStart=ready;start.disabled=busy||!canStart;
    status.className=failed?'account-feedback error':'account-feedback';
    status.textContent=failed?'部分连接未确认，请检查对应 Key 后重新检测。检测没有创建生成任务。':'免费检测完成。仅已开放且此 Key 有权限的线路可用。';
  }
  async function checkConnection({refresh=false}={}){
    status.className='account-feedback';status.textContent='正在免费检测连接与可用线路…';start.disabled=true;
    try{
      const response=await fetch('/api/relay/connection',{cache:'no-store'});if(!response.ok)throw Error('connection');
      renderConnection(await response.json());
      if(refresh)window.dispatchEvent(new Event('hamster-relay-catalog-refresh'));
    }catch{
      renderConnection({image:{configured:Boolean(current.configured),state:'error'},video:{configured:Boolean(current.videoConfigured),state:'error'},tool:{configured:Boolean(current.toolConfigured),state:'error'},tools:{}});
      status.textContent='暂时无法完成检测，请检查网络后重试。已保存的 Key 未被删除，不会自动提交生成任务。';
    }
  }
  async function detect({refresh=true}={}){
    if(busy||!hasConfiguration())return;
    setBusy(true);try{await checkConnection({refresh});}finally{setBusy(false);}
  }
  document.getElementById('relayKeyForm').onsubmit=async event=>{
    event.preventDefault();if(busy)return;
    setBusy(true);status.className='account-feedback';status.textContent='正在验证 Key 与账户归属…';
    try{
      const response=await fetch('/api/config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({piknoImageKey:image.value.trim(),piknoVideoKey:video.value.trim(),piknoToolKey:tool.value.trim(),...Object.fromEntries(removals.filter(([, , ,checkbox])=>checkbox.checked).map(([kind])=>['remove_'+kind,true]))})});
      if(!response.ok){status.className='account-feedback error';status.textContent=fixedError(response.status);return;}
      const result=await response.json();if(result.ok!==true||result.relayMode!==true)throw Error('configuration');
      current=result;image.value='';video.value='';tool.value='';updateSummary();localStorage.removeItem('hamster_wallet_model_cache_v1');
      window.dispatchEvent(new Event('hamster-relay-configured'));
      await checkConnection();
    }catch{
      status.className='account-feedback error';status.textContent='配置结果暂未确认，请重新检测或稍后重试。不要重复提交生成任务。';
    }finally{setBusy(false);}
  };
  recheck.onclick=detect;
  start.onclick=()=>{if(!start.disabled&&!busy)document.querySelector(`.rail-item[data-view="${startView}"]`)?.click();};
  disconnect.onclick=async()=>{
    if(busy||!confirm('移除本机 Key？PIKNO 余额及本地素材、聊天和任务文件不会删除。'))return;
    setBusy(true);
    try{
      const response=await fetch('/api/relay/disconnect',{method:'POST'});if(!response.ok)throw Error('disconnect');
      const result=await response.json();if(result.ok!==true||result.relayMode!==true)throw Error('disconnect');
      current=result;image.value='';video.value='';tool.value='';updateSummary();
      document.getElementById('relayToolStatus').textContent='数字人和黑白深度视频使用工具 Key；是否可用以各自已开放线路为准。';
      window.dispatchEvent(new Event('hamster-session-invalidated'));window.dispatchEvent(new Event('hamster-relay-configured'));
      localStorage.removeItem('hamster_wallet_model_cache_v1');
      status.className='account-feedback';status.textContent='本机 Key 已移除。PIKNO 余额及本地素材、聊天和任务文件保持不变。';
    }catch{
      status.className='account-feedback error';status.textContent='移除结果暂未确认，请重新打开账户页检查。';
    }finally{setBusy(false);}
  };
  updateSummary();
  await detect({refresh:false});
}
