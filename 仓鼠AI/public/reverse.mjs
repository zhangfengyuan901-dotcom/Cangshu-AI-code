const VIDEO_TYPES = {general:'智能判断',short:'短视频',dance:'跳舞',ecommerce:'带货',script:'剧本',drama:'短剧',anime:'动漫'};
const TARGET_MODELS = {allRef:'全能参考',firstFrame:'首帧',firstFrameRef:'首帧＋参考'};
const STATUS = {uploading:'正在上传',ready:'视频已就绪',submitting:'正在提交',queued:'排队中',processing:'正在反推',succeeded:'已完成',failed:'未完成',unknown:'提交结果待确认'};
const TERMINAL = new Set(['succeeded','failed']);
const money = value => Number(value).toLocaleString('zh-CN',{minimumFractionDigits:2,maximumFractionDigits:6});

export function reverseLinkInput(value) {
  const error = message => ({url:'',platform:'',error:message});
  if (typeof value !== 'string' || value.length > 8192) return error('分享内容过长，请只保留一个视频链接。');
  const links = value.match(/https?:\/\/[^\s<>"'，。！？；、（）【】《》「」]+/gi) || [];
  if (links.length !== 1) return error(links.length ? '每次只能识别一个视频链接，请删除多余链接。' : '请粘贴抖音、小红书或B站视频链接，也可粘贴完整分享文案。');
  const raw = links[0].includes('?') ? links[0] : links[0].replace(/[),.;!\]}>]+$/g,'');
  if (new TextEncoder().encode(raw).length > 4096 || !/^https:\/\//i.test(raw) || /[\\\s\u0000-\u001f\u007f-\u009f]/.test(raw)) return error('请使用有效的 HTTPS 视频链接。');
  let parsed;
  try { parsed = new URL(raw); } catch { return error('链接格式无效，请重新复制。'); }
  const authority = /^https:\/\/([^/?#]+)/i.exec(raw)?.[1] || '';
  const path = raw.slice(8 + authority.length).split(/[?#]/,1)[0] || '/';
  if (!/^[A-Za-z0-9.-]+(?::443)?$/.test(authority) || parsed.username || parsed.password || raw.includes('#') || parsed.hostname.endsWith('.') || /%/.test(path)) return error('链接格式无效，请重新复制。');
  try {
    let query = decodeURIComponent((raw.split('?').slice(1).join('?')).replace(/\+/g,' '));
    let stable = false;
    for (let attempt=0; attempt<3; attempt++) {
      if (/https?:\/\//i.test(query) || /[\\\u0000-\u001f\u007f-\u009f]/.test(query)) return error('请直接粘贴视频页或官方短链。');
      const decoded = decodeURIComponent(query.replace(/\+/g,' '));
      if (decoded === query) { stable = true; break; } query = decoded;
    }
    if (!stable) return error('链接嵌套编码过多，请重新复制官方分享链接。');
  }
  catch { return error('链接编码无效，请重新复制。'); }
  const host = parsed.hostname.toLowerCase(), token = '[A-Za-z0-9_-]{1,128}';
  let platform = '';
  if (['douyin.com','www.douyin.com'].includes(host) && /^\/video\/[0-9]+\/?$/.test(path) || host === 'v.douyin.com' && new RegExp('^/'+token+'/?$').test(path)) platform = 'douyin';
  else if (['xiaohongshu.com','www.xiaohongshu.com'].includes(host) && /^\/(?:explore|discovery\/item)\/[0-9a-fA-F]{24}\/?$/.test(path) || host === 'xhslink.com' && new RegExp('^/(?:a/|o/)?'+token+'/?$').test(path)) platform = 'xiaohongshu';
  else if (['bilibili.com','www.bilibili.com'].includes(host) && /^\/video\/(?:BV[A-Za-z0-9]+|av[0-9]+)\/?$/.test(path) || host === 'b23.tv' && new RegExp('^/'+token+'/?$').test(path)) platform = 'bilibili';
  return platform ? {url:raw,platform,error:''} : error('暂不支持此链接。请使用抖音、小红书、B站视频页或官方短链，其他视频可改用文件上传。');
}

export function reverseFileError(file, seconds, limits = {}) {
  if (!file || !/\.(mp4|mov|webm|m4v)$/i.test(file.name)) return '请选择 MP4、MOV、WebM 或 M4V 视频。';
  if (!Number.isSafeInteger(file.size) || file.size <= 0 || file.size > Math.min(Number(limits.max_bytes) || 524288000, 524288000)) return '视频为空或超过大小限制，请重新选择。';
  if (!Number.isFinite(seconds) || seconds <= 0) return '无法读取视频时长，请检查文件或转换为 MP4 后重试。';
  if (seconds > Math.min(Number(limits.max_seconds) || 600, 600)) return '视频不能超过 10 分钟，请先裁剪。';
  return '';
}

export function reverseQuoteValid(quote) {
    return Boolean(quote && quote.available === true && quote.currency === 'CNY' && quote.confirmation_required === true && quote.billing_mode === 'actual_seconds_v1' && quote.price_version === 'reverse-cny-003-v1' &&
    Number(quote.unit_price_cny) === 0.03 && Number(quote.reservation_cny) === 18 && Number(quote.max_seconds) === 600);
}

function executionHeaders(execution) {
  return {'X-Hamster-Execution-Scope':execution.scope,'X-Hamster-Config-Revision':String(execution.revision)};
}

// This surface retains no credentials, upload URLs, local paths or task results
// in browser storage. Durable tasks belong to the account-bound local service.
export function mountReverse(root, {request,notify = () => {}}) {
  root.innerHTML = `
    <div class="view-heading compact"><span class="eyebrow">VIDEO TO PROMPT</span><h1 class="view-title">视频反推</h1><p>从一段视频提取场景、分镜、动作和台词，整理成可继续创作的提示词。</p></div>
    <form id="reverseForm" class="digital-form reverse-form">
      <div class="reverse-service"><span id="reverseAvailability" role="status" aria-live="polite">正在检查服务…</span><button id="reverseRefresh" class="image-edit-inline" type="button">刷新状态</button></div>
      <div class="reverse-source-tabs" role="tablist" aria-label="视频来源"><button id="reverseFileTab" type="button" role="tab" aria-selected="true" aria-controls="reverseFilePanel">上传视频</button><button id="reverseLinkTab" type="button" role="tab" aria-selected="false" aria-controls="reverseLinkPanel">粘贴链接</button></div>
      <div id="reverseFilePanel" role="tabpanel" aria-labelledby="reverseFileTab">
      <label class="upload-box reverse-upload" id="reverseDrop"><input id="reverseFile" type="file" accept=".mp4,.mov,.webm,.m4v,video/mp4,video/quicktime,video/webm,video/x-m4v" /><span class="upload-placeholder"><b>＋</b><strong>选择或拖入视频</strong><small>MP4 / MOV / WebM / M4V · 最大 500 MB · 最长 10 分钟</small></span></label>
      <p id="reverseFileInfo" class="upload-info" role="status">选择文件后仅在本机预览，确认提交后开始上传。</p>
      <video id="reversePreview" class="reverse-preview" controls preload="metadata" hidden></video>
      </div>
      <div id="reverseLinkPanel" role="tabpanel" aria-labelledby="reverseLinkTab" hidden><label for="reverseLink">视频链接或分享文案</label><textarea id="reverseLink" maxlength="8192" rows="4" placeholder="粘贴抖音、小红书、B站视频页或官方短链，也可粘贴完整分享文案。" spellcheck="false" autocomplete="off"></textarea><p id="reverseLinkInfo" class="hint" role="status" aria-live="polite">仅在本机识别链接，确认费用后才提交解析。</p></div>
      <div class="reverse-options"><label>视频类型<select id="reverseVideoType">${Object.entries(VIDEO_TYPES).map(([v,t])=>`<option value="${v}">${t}</option>`).join('')}</select></label><label>输出格式<select id="reverseTarget">${Object.entries(TARGET_MODELS).map(([v,t])=>`<option value="${v}">${t}</option>`).join('')}</select></label><label>每段目标时长（秒）<input id="reverseDuration" type="number" min="1" max="300" step="1" value="15" /></label></div>
      <p class="hint">每段目标时长用于组织提示词，不改变源视频长度或实际计费时长。</p>
      <p id="reverseBilling" class="reverse-billing" role="status">正在读取价格…</p>
      <div class="digital-actions"><span id="reverseHint" class="cost" role="status" aria-live="polite">请先选择视频</span><button id="reverseSubmit" class="plain-button" type="submit" disabled>开始反推</button></div>
    </form>
    <div class="reverse-results-heading"><h2>反推记录</h2><span>记录随当前账户保存</span></div><p id="reverseEmpty" class="hint">还没有反推记录。</p><div id="reverseResults" class="reverse-results" aria-live="polite"></div>
    <dialog id="reverseConfirm" class="reverse-confirm" aria-labelledby="reverseConfirmTitle"><form method="dialog"><h2 id="reverseConfirmTitle">确认反推费用</h2><p id="reverseConfirmText"></p><div class="reverse-confirm-actions"><button class="plain-button" value="cancel">返回</button><button class="plain-button" id="reverseConfirmAccept" value="confirm">确认并开始反推</button></div></form></dialog>`;
  const $ = selector => root.querySelector(selector);
  let visible = false, epoch = 0, capabilities = null, quote = null, file = null, seconds = 0, previewURL = null, inputMode = 'file', link = {url:'',platform:'',error:''};
  let busy = false, timer = null, flight = null, tasks = [], fileEpoch = 0, taskOperation = null;
  const current = token => token === epoch;
  const hint = message => { $('#reverseHint').textContent = message; };
  function enabled() {
    const valid = capabilities?.available === true && capabilities?.execution?.scope && Number.isSafeInteger(capabilities?.execution?.revision) && reverseQuoteValid(quote);
    const linkSupported = capabilities?.input_modes?.includes('link') === true;
    $('#reverseSubmit').disabled = busy || !valid || (inputMode === 'file' ? !file : !link.url || !linkSupported);
    $('#reverseFile').disabled = busy;
    $('#reverseLink').disabled = busy;
    $('#reverseFileTab').disabled = $('#reverseLinkTab').disabled = busy;
    for (const element of root.querySelectorAll('.reverse-options input,.reverse-options select')) element.disabled = busy;
    $('#reverseRefresh').disabled = busy;
  }
  function billing() {
    if (!reverseQuoteValid(quote)) { $('#reverseBilling').textContent = '价格暂不可用，当前不能提交。'; return; }
    const estimate = inputMode === 'file' && seconds > 0 ? `本地预估约 ¥${(seconds * Number(quote.unit_price_cny)).toFixed(2)}；` : inputMode === 'link' ? '链接视频时长由解析结果确认；' : '';
    $('#reverseBilling').textContent = `¥${Number(quote.unit_price_cny).toFixed(2)}/秒。${estimate}提交时最多预占 ¥${Number(quote.reservation_cny).toFixed(2)}，成功后按实际视频时长结算并释放差额；失败释放预占。`;
  }
  function renderTasks() {
    $('#reverseEmpty').hidden = tasks.length > 0;
    const container = $('#reverseResults');
    const existing = new Map([...container.children].map(node => [node.dataset.task,node]));
    for (const task of tasks) {
      if (!/^[a-f0-9]{32}$/i.test(task.id || '')) continue;
      let card = existing.get(task.id);
      if (!card) {
        card = document.createElement('article'); card.className = 'reverse-result'; card.dataset.task = task.id;
        card.innerHTML = '<header><strong>视频反推</strong><span></span></header><p class="reverse-result-note"></p><pre tabindex="0" hidden></pre><div class="reverse-result-actions"><button class="image-edit-inline" type="button" data-copy hidden>复制提示词</button><button class="image-edit-inline" type="button" data-save hidden>保存 TXT</button><button class="image-edit-inline" type="button" data-query>查询进度</button></div>';
        container.append(card);
      }
      existing.delete(task.id);
      const status = STATUS[task.status] || '状态待确认';
      card.querySelector('header span').textContent = status;
      const accountBilling = task.billing;
      let note = task.status === 'unknown' ? '提交结果尚未确认。这里只查询原任务，不会重复发送。' : task.status === 'failed' ? '本次任务未完成。请检查视频后再创建新任务。' : '';
      if (accountBilling?.status === 'settled' && Number.isFinite(Number(accountBilling.charged_cny))) note += ` 已结算 ¥${money(accountBilling.charged_cny)}。`;
      else if (accountBilling?.status === 'released') note += ' 本次预占已释放。';
      else if (['reserved','pending'].includes(accountBilling?.status)) note += ' 费用预占中，等待核对实际用量。';
      card.querySelector('.reverse-result-note').textContent = note;
      const pre = card.querySelector('pre'), text = task.status === 'succeeded' && typeof task.text === 'string' ? task.text : '';
      if (pre.textContent !== text) pre.textContent = text;
      pre.hidden = !text;
      for (const selector of ['[data-copy]','[data-save]']) card.querySelector(selector).hidden = !text;
      card.querySelector('[data-copy]').onclick = async () => { try { await navigator.clipboard.writeText(text); notify('提示词已复制'); } catch { notify('复制失败，请选择文本后复制'); } };
      card.querySelector('[data-save]').onclick = () => {
        const url = URL.createObjectURL(new Blob([text],{type:'text/plain;charset=utf-8'})), a = document.createElement('a');
        a.href = url; a.download = '视频反推提示词.txt'; a.click(); setTimeout(()=>URL.revokeObjectURL(url),1000);
      };
      card.querySelector('[data-query]').hidden = TERMINAL.has(task.status) && !['reserved','pending'].includes(accountBilling?.status);
      card.querySelector('[data-query]').onclick = () => void refresh();
    }
    for (const node of existing.values()) node.remove();
  }
  function schedule() {
    clearTimeout(timer); timer = null;
    if (visible && document.visibilityState !== 'hidden' && tasks.some(task => !TERMINAL.has(task.status) || ['reserved','pending'].includes(task.billing?.status))) timer = setTimeout(()=>void refresh(),3000);
  }
  async function refresh({configuration = false} = {}) {
    if (flight) return flight;
    const token = epoch;
    flight = (async () => {
      try {
        if (configuration || !capabilities) {
          const cap = await request('/reverse/capabilities'); if (!current(token)) return;
          capabilities = cap;
          $('#reverseAvailability').textContent = cap.available ? '反推服务可用' : cap.reason || '反推服务暂不可用，请检查账户或稍后刷新。';
          quote = cap.available ? await request('/reverse/quote') : null; if (!current(token)) return;
          billing(); enabled();
        }
        const data = await request('/reverse/tasks'); if (!current(token)) return;
        tasks = Array.isArray(data?.tasks) ? data.tasks : []; renderTasks();
      } catch {
        if (current(token)) { if (configuration) { quote = null; capabilities = null; billing(); enabled(); } hint('暂时无法读取服务状态，请稍后刷新。'); }
      } finally { if (current(token)) schedule(); }
    })();
    try { await flight; } finally { if (current(token)) flight = null; }
  }
  async function pick(selected) {
    if (busy || !selected) return;
    const token = ++fileEpoch;
    file = null; seconds = 0; if (previewURL) URL.revokeObjectURL(previewURL);
    previewURL = URL.createObjectURL(selected); $('#reversePreview').src = previewURL; $('#reversePreview').hidden = false;
    enabled(); hint('正在读取视频信息…');
    const video = $('#reversePreview');
    const duration = await new Promise(resolve => {
      const done = value => { clearTimeout(timeout); video.removeEventListener('loadedmetadata',loaded); video.removeEventListener('error',failed); resolve(value); };
      const loaded = () => done(video.duration), failed = () => done(NaN), timeout = setTimeout(()=>done(NaN),15000);
      video.addEventListener('loadedmetadata',loaded,{once:true}); video.addEventListener('error',failed,{once:true});
      if (video.readyState >= 1) done(video.duration);
    });
    if (token !== fileEpoch) return;
    const error = reverseFileError(selected,duration,capabilities?.limits);
    if (error) { hint(error); $('#reverseFileInfo').textContent = '视频未就绪'; }
    else { file = selected; seconds = duration; $('#reverseFileInfo').textContent = `${selected.name} · ${(selected.size / 1048576).toFixed(1)} MB · ${duration.toFixed(1)} 秒`; hint('视频已就绪，开始前会再次确认费用。'); }
    billing(); enabled();
  }
  async function submit(event) {
    event.preventDefault(); if (busy || (inputMode === 'file' ? !file : !link.url)) return;
    busy = true; enabled(); const token = epoch, selected = file, selectedMode = inputMode, selectedLink = link.url;
    try {
      if(flight)await flight;
      await refresh({configuration:true}); if (!current(token) || capabilities?.available !== true || !reverseQuoteValid(quote)) return;
      if (selectedMode === 'link' && !capabilities?.input_modes?.includes('link')) { hint('当前服务尚未开放链接反推，请刷新状态或改用上传视频。'); return; }
      const confirmedQuote = {...quote}, execution = {...capabilities.execution};
      $('#reverseConfirmText').textContent = `本次按 ¥${Number(quote.unit_price_cny).toFixed(2)}/秒收费，最多预占 ¥${Number(quote.reservation_cny).toFixed(2)}。成功后按实际视频时长结算并释放差额，失败释放预占；提交结果待确认时保留预占并继续核对。`;
      const confirmed = await new Promise(resolve => { const dialog = $('#reverseConfirm'); dialog.addEventListener('close',()=>resolve(dialog.returnValue === 'confirm'),{once:true}); dialog.showModal(); });
      if (!confirmed || !current(token)) return;
      let source;
      if (selectedMode === 'file') {
        hint('正在上传视频，请保持应用打开…');
        const uploaded = await request('/reverse/uploads',{method:'POST',raw:selected,contentType:selected.type || ({mov:'video/quicktime',webm:'video/webm',m4v:'video/x-m4v'}[selected.name.split('.').pop().toLowerCase()] || 'video/mp4'),headers:{...executionHeaders(execution),'X-Reverse-Filename':encodeURIComponent(selected.name),'X-Reverse-Operation-Id':crypto.randomUUID()}});
        if (!current(token)) return;
        source = {upload_id:uploaded.upload_id};
      } else source = {url:selectedLink};
      taskOperation = crypto.randomUUID(); hint('正在提交反推任务…');
      const data = await request('/reverse/submit',{method:'POST',headers:executionHeaders(execution),json:{...source,operation_id:taskOperation,options:{videoType:$('#reverseVideoType').value,targetModel:$('#reverseTarget').value,taskDurationSec:Number($('#reverseDuration').value)},price_version:confirmedQuote.price_version,billing_confirmed:true}});
      if (!current(token)) return;
      if (data?.task) { tasks = [data.task,...tasks.filter(task=>task.id !== data.task.id)]; renderTasks(); }
      hint(data?.task?.status === 'unknown' ? '提交结果待确认，请查询原任务。' : '任务已提交，可在反推记录中查看进度。');
      file = null; $('#reverseFile').value = ''; seconds = 0; link = {url:'',platform:'',error:''}; $('#reverseLink').value = ''; billing();
      await refresh();
    } catch (error) {
      if (!current(token)) return;
      hint(taskOperation ? '任务状态待确认，请刷新反推记录；不要重复提交。' : '上传未完成或提交条件已变化，请刷新状态后重试。');
      if (taskOperation) { file = null; $('#reverseFile').value = ''; link = {url:'',platform:'',error:''}; $('#reverseLink').value = ''; void request('/reverse/operations/'+taskOperation).then(()=>refresh()).catch(()=>{}); }
      if (error?.status === 402) hint('可用余额不足，请先到「个人中心」补足本次预占金额。');
    } finally { if (current(token)) { busy = false; taskOperation = null; enabled(); schedule(); } }
  }
  $('#reverseForm').addEventListener('submit',event=>void submit(event));
  function selectMode(mode) {
    if (busy) return;
    inputMode = mode; $('#reversePreview').pause();
    $('#reverseFilePanel').hidden = mode !== 'file'; $('#reverseLinkPanel').hidden = mode !== 'link';
    $('#reverseFileTab').setAttribute('aria-selected',String(mode === 'file')); $('#reverseLinkTab').setAttribute('aria-selected',String(mode === 'link'));
    hint(mode === 'file' ? file ? '视频已就绪，开始前会再次确认费用。' : '请先选择视频' : link.url ? '链接已识别，开始前会再次确认费用。' : '请先粘贴视频链接');
    if (mode === 'link' && !capabilities?.input_modes?.includes('link')) hint('当前服务尚未开放链接反推，请刷新状态或改用上传视频。');
    billing(); enabled();
  }
  $('#reverseFileTab').addEventListener('click',()=>selectMode('file'));
  $('#reverseLinkTab').addEventListener('click',()=>selectMode('link'));
  $('#reverseLink').addEventListener('input',()=>{
    link = reverseLinkInput($('#reverseLink').value);
    const names = {douyin:'抖音',xiaohongshu:'小红书',bilibili:'B站'};
    $('#reverseLinkInfo').textContent = link.url ? `已识别：${names[link.platform]}视频链接。确认费用后提交解析。` : link.error;
    hint(!capabilities?.input_modes?.includes('link') ? '当前服务尚未开放链接反推，请刷新状态或改用上传视频。' : link.url ? '链接已就绪，开始前会再次确认费用。' : '请检查视频链接'); enabled();
  });
  $('#reverseFile').addEventListener('change',event=>void pick(event.target.files?.[0]));
  $('#reverseRefresh').addEventListener('click',()=>void refresh({configuration:true}));
  $('#reverseDrop').addEventListener('dragover',event=>event.preventDefault());
  $('#reverseDrop').addEventListener('drop',event=>{event.preventDefault();if(event.dataTransfer?.files.length === 1)void pick(event.dataTransfer.files[0]);else hint('每次请选择一个视频。');});
  document.addEventListener('visibilitychange',()=>{if(document.visibilityState === 'hidden'){clearTimeout(timer);$('#reversePreview').pause();}else if(visible)void refresh();});
  return {
    async setVisible(value) { visible = value; clearTimeout(timer); if (!visible) { $('#reversePreview').pause(); if ($('#reverseConfirm').open) $('#reverseConfirm').close('cancel'); } else await refresh({configuration:true}); },
    reset() {
      epoch++; fileEpoch++; clearTimeout(timer); capabilities = quote = file = null; seconds = 0; busy = false; flight = null; tasks = []; taskOperation = null; link = {url:'',platform:'',error:''}; $('#reverseLink').value = '';
      if ($('#reverseConfirm').open) $('#reverseConfirm').close('cancel');
      $('#reverseFile').value = ''; $('#reversePreview').pause(); $('#reversePreview').removeAttribute('src'); $('#reversePreview').load(); $('#reversePreview').hidden = true;
      if (previewURL) URL.revokeObjectURL(previewURL); previewURL = null;
      $('#reverseFileInfo').textContent = '选择文件后仅在本机预览，确认提交后开始上传。';
      $('#reverseLinkInfo').textContent = '仅在本机识别链接，确认费用后才提交解析。';
      renderTasks(); billing(); enabled(); hint('账户配置已变化，请重新选择视频或粘贴当前账户的链接。');
      if (visible) void refresh({configuration:true});
    },
  };
}
