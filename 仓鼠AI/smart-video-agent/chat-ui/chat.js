import { pickAsset } from "/shared/asset-library.mjs";
import { installFaultEvents } from '/shared/fault-events.mjs';
import { mountMaterialPreview } from '/shared/material-preview.mjs';
import { claimMediaPlayback } from '/shared/interaction-policy.mjs';
import { observeWorkspaceActivity } from './workspace-activity.mjs';
installFaultEvents('/studio-api/error-report');
const $ = (s) => document.querySelector(s);
const make = (tag, text, cls) => {
  const n = document.createElement(tag);
  if (text) n.textContent = text;
  if (cls) n.className = cls;
  return n;
};
const renderedMessages = new WeakMap();
const chatHistoryBatch = 50;
let firstVisibleMessage = 0;
let current = null,
  history = [],
  pending = [],
  uploading = false,
  submitting = false,
  stopping = false,
  ready = false,
  metered = false,
  toastTimer,
  dragDepth = 0,
  mentionOpen = false,
  selection = 0;
const billingChecks = new Map(), billingCheckDelays = [0,2000,5000,10000,20000,30000];
let configurationContext = '', configurationEpoch = 0, attachmentCapabilities = null;
let availableTerms = null;
const safeRead = (key) => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};
const safeWrite = (key, value) => {
  try {
    localStorage.setItem(key, value);
  } catch {}
};
function toast(text) {
  $("#toast").textContent = text;
  $("#toast").hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ($("#toast").hidden = true), 5500);
}
function applyConfiguration(config) {
  const context=/^[a-f0-9]{64}$/.test(config.confirmation_context||'')?config.confirmation_context:'';
  let clearedPreview = false;
  if(context!==configurationContext||ready!==(config.ready===true)||metered!==(config.metered===true)){
    closeMediaPreview();
    configurationEpoch++;
    attachmentCapabilities = null;
    availableTerms = null;
    billingChecks.clear();
    if(current?.messages)current={...current,messages:current.messages.map(message=>{
      let next = message;
      if (message.partial_text) {
        const {partial_text, ...withoutPreview} = message;
        next = withoutPreview;
        clearedPreview = true;
      }
      if(message.billing?.admission_blocking!==false)return next;
      const {admission_blocking,...billing}=message.billing;
      return {...next,billing};
    })};
  }
  configurationContext=context;
  ready = config.ready === true;
  metered = config.metered === true;
  renderAttachmentCapabilities();
  if (clearedPreview) render();
}
function attachmentKind(name) {
  const extension=String(name||'').toLowerCase().split('.').pop();
  return {png:'image',jpg:'image',jpeg:'image',webp:'image',mp4:'video',mov:'video',pdf:'pdf',docx:'text',txt:'text',md:'text'}[extension]||'';
}
function attachmentsEnabled() {
  return ready&&(!metered||attachmentCapabilities?.files===true);
}
function assetKinds() {
  return ['image','video'].filter(kind => !metered || attachmentCapabilities?.[kind]===true);
}
function attachmentSizeLimit(kind) {
  return metered ? attachmentCapabilities?.[`max_${kind}_bytes`] ?? attachmentCapabilities?.max_file_bytes : 50 * 1024 * 1024;
}
function renderAttachmentCapabilities() {
  const enabled=attachmentsEnabled();
  for (const id of ['#welcomeMaterialButton','#upload']) $(id).hidden=!enabled;
  for (const id of ['#asset','#welcomeAsset']) $(id).hidden=!enabled||!assetKinds().length;
  $('#welcomeMaterialButton').disabled=!enabled;
  const extensions=enabled ? ['png','jpg','jpeg','webp','mp4','mov','pdf','docx','txt','md'].filter(extension=>!metered||attachmentCapabilities?.[attachmentKind('file.'+extension)]===true) : [];
  $('#fileInput').accept=extensions.map(extension=>'.'+extension).join(',');
  const kinds = [...new Set(extensions.map(extension => attachmentKind('file.'+extension)))];
  const names = {image:'图片',video:'视频画面',pdf:'PDF',text:'文档'};
  const media = kinds.map(kind => names[kind]).join('、');
  $('#welcomeDescription').textContent=enabled ? `添加${media}，一起聊清楚素材中的细节。` : '豆包 Seed 2.1 Pro 支持文字对话。';
  $('#welcomeMaterialTypes').textContent=enabled ? `${media}，一起看` : '';
  $('#dropDescription').textContent=kinds.map(kind => `${names[kind]}（最大 ${Math.round(attachmentSizeLimit(kind)/100000)/10} MB）`).join(' · ');
  $('#input').placeholder=enabled ? `输入消息，或添加${media}` : '输入消息';
}
function applyAttachmentCapabilities(terms) {
  const caps=terms?.capabilities,limits=terms?.limits;
  attachmentCapabilities=null;
  if(terms?.confirmation_context===configurationContext&&caps?.files===true
    &&Number.isInteger(limits?.max_file_bytes)&&limits.max_file_bytes>0&&limits.max_file_bytes<=50*1024*1024
    &&Number.isInteger(limits?.max_attachments)&&limits.max_attachments>0&&limits.max_attachments<=6
    &&Number.isInteger(limits?.max_history_attachments)&&limits.max_history_attachments>0&&limits.max_history_attachments<=12){
    const kinds = ['text','image','video','pdf'];
    if (kinds.some(kind=>caps[kind]===true)) {
      attachmentCapabilities={files:true,...Object.fromEntries(kinds.map(kind=>[kind,caps[kind]===true])),max_file_bytes:limits.max_file_bytes,max_attachments:limits.max_attachments,max_history_attachments:limits.max_history_attachments};
      for (const key of ['max_image_bytes','max_video_bytes']) {
        if (Number.isInteger(limits[key])&&limits[key]>0&&limits[key]<=limits.max_file_bytes) attachmentCapabilities[key]=limits[key];
      }
    }
  }
  renderAttachmentCapabilities();
}
async function refreshAttachmentCapabilities() {
  if(!metered||!ready){renderAttachmentCapabilities();return;}
  const context=configurationContext,epoch=configurationEpoch;
  try{
    const terms=await api('/capabilities',{signal:AbortSignal.timeout(20000)});
    if(context!==configurationContext||epoch!==configurationEpoch)return;
    availableTerms = terms?.confirmation_context === configurationContext ? terms : null;
    applyAttachmentCapabilities(availableTerms);
  }catch{if(context===configurationContext&&epoch===configurationEpoch){availableTerms=null;attachmentCapabilities=null;renderAttachmentCapabilities();}}
}
async function api(path, options = {}) {
  const response = await fetch("/chat-api" + path, options);
  let data;
  try {
    data = await response.json();
  } catch {
    throw Error("本地服务暂时不可用，请保持仓鼠AI应用开启。");
  }
  if (!response.ok)
    throw Error(
      typeof data.detail === "string"
        ? data.detail
        : "操作未完成，请检查输入后重试。",
    );
  return data;
}
const json = (method, value) => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(value),
});
function billingNotice(bill) {
  return bill && !['settled','released','not_submitted','rejected_before_execution'].includes(bill.status)
    ? '正在核对请求状态，请勿重复发送。' : '';
}
function billingBlocksAdmission(bill) {
  return Boolean(billingNotice(bill))&&!(bill.status==='unknown'&&bill.admission_blocking===false
    &&bill.billing_mode==='actual_usage_v1'&&['chat-cny-9-45-actual-v2','chat-doubao-seed-2-1-pro-cny-30-150-6-v1'].includes(bill.price_version));
}
function usesRetiredModel(message) {
  return metered && message?.model !== 'doubao-seed-2.1-pro';
}
function answerNotice(message) {
  if(message.status==='running')return '';
  if (['failed','cancelled','interrupted'].includes(message.status) && !billingNotice(message.billing) && usesRetiredModel(message))
    return '可以发送一条新消息，继续这段对话。';
  if(message.billing?.status==='not_submitted')return message.reason==='prior_request_pending'
    ? '上一条对话正在后台处理，请稍后发送新消息。'
    : '本次请求未提交，请检查账户状态后手动再试。';
  if(billingNotice(message.billing)&&!billingBlocksAdmission(message.billing)){
    if(['failed','cancelled','interrupted'].includes(message.status))return '本次回答未完成，可继续发送新消息。';
  }else if(billingNotice(message.billing)){
    const check=billingChecks.get(`${current?.id}/${message.billing.request_id}`);
    if(check&&!check.pending&&check.attempts>=billingCheckDelays.length){
      if(!['completed','partial'].includes(message.status))return '本次回答未完成，系统会继续核对原请求。';
    }
    if(!['completed','partial'].includes(message.status))return billingNotice(message.billing);
  }
  if(message.status==='partial')return message.reason==='max_output_tokens'?'已显示本次生成内容，回答因长度限制结束。':'已显示本次生成的部分回答。';
  if(['failed','cancelled','interrupted'].includes(message.status))return message.reason==='max_output_tokens'?'本次未形成可显示的回答，请调整问题后再试。':message.status==='cancelled'?'本次回答已停止。':'本次回答未完成，请调整问题后再试。';
  return '';
}
async function reconcileBills({manual=false,requestId}={}) {
  if(!metered||!ready||!current||current.status==='running'||submitting||uploading)return false;
  const id=current.id,selected=selection;
  const eligible=[...(current.messages||[])].reverse().filter(item=>billingNotice(item.billing)
    &&(manual||billingBlocksAdmission(item.billing))&&/^[a-f0-9]{32}$/.test(item.billing.request_id||'')
    &&(!requestId||item.billing.request_id===requestId));
  if(!manual&&[...billingChecks.values()].some(check=>check.pending))return false;
  const message=eligible.find(item=>manual||Date.now()>=(billingChecks.get(`${id}/${item.billing.request_id}`)?.next??0));
  if(!message)return false;
  const operation=message.billing.request_id,key=`${id}/${operation}`;
  let check=billingChecks.get(key);
  if(!check){if(billingChecks.size>=128)billingChecks.delete(billingChecks.keys().next().value);check={attempts:0,next:0,pending:null,context:configurationContext,epoch:configurationEpoch};billingChecks.set(key,check);}
  if(check.pending)return check.pending;
  check.attempts++;
  // Continue low-frequency reads after transient failures. Only the relay's
  // confirmed admission decision can unblock the composer.
  check.next=Date.now()+(billingCheckDelays[check.attempts]||120000);
  const stillSelected=()=>current?.id===id&&selection===selected&&!submitting&&!uploading
    &&billingChecks.get(key)===check&&configurationContext===check.context&&configurationEpoch===check.epoch;
  check.pending=(async()=>{
    try{
      const config=await api('/config',{signal:AbortSignal.timeout(20000)});
      if(!stillSelected())return false;
      applyConfiguration(config);
      if(!stillSelected()||!ready||!metered||!configurationContext)return false;
      const context=configurationContext,epoch=configurationEpoch;
      const updated=await api(`/sessions/${encodeURIComponent(id)}/billing/${operation}`,{...json('POST',{}),signal:AbortSignal.timeout(20000)});
      const verified=await api('/config',{signal:AbortSignal.timeout(20000)});
      if(!stillSelected())return false;
      applyConfiguration(verified);
      if(!ready||!metered||configurationContext!==context||configurationEpoch!==epoch)return false;
      const original=current.messages.find(item=>item.id===message.id),result=updated?.messages?.find(item=>item.id===message.id);
      if(updated.id!==id||original?.billing?.request_id!==operation||!billingNotice(original.billing)||result?.billing?.request_id!==operation||result.billing.price_version!==message.billing.price_version||!['reserved','dispatching','dispatched','submitted','settled','released','unknown'].includes(result.billing.status))return false;
      // A billing reply may be older than the next local-session poll. Update
      // only its original ledger view, never overwrite newer answer content.
      current={...current,messages:current.messages.map(item=>item.id===message.id?{...item,billing:result.billing}:item)};render();return true;
    }catch{return false;}
    finally{check.pending=null;if(stillSelected())render();}
  })();
  return check.pending;
}
function paidTermsIdentity(terms) {
  const rates=terms?.pricing;
  if(terms?.metered!==true||terms.billing_mode!=='actual_usage_v1'||terms.billing?.allow_debt!==true||terms.billing?.one_inflight_per_user!==true||! /^[a-f0-9]{64}$/.test(terms.confirmation_context||'')||terms.model!=='doubao-seed-2.1-pro'||terms.price_version!=='chat-doubao-seed-2-1-pro-cny-30-150-6-v1'||rates?.currency!=='CNY'||![rates.input_cny_per_million,rates.output_cny_per_million].every(value=>typeof value==='number'&&Number.isFinite(value)&&value>=0&&value<=1e9))return null;
  return JSON.stringify([terms.confirmation_context,terms.price_version,rates.currency,rates.input_cny_per_million,rates.output_cny_per_million]);
}
function draft() {
  if (current)
    safeWrite(
      "hamster-chat-draft-" + current.id,
      JSON.stringify({ text: $("#input").value, pending }),
    );
}
function controls() {
  const busy = current?.status === "running";
  const checking = current?.messages.some(message=>billingBlocksAdmission(message.billing));
  $("#send").hidden = !!busy;
  $("#stop").hidden = !busy;
  $("#send").disabled =
    !ready ||
    uploading ||
    submitting ||
    checking ||
    (!$("#input").value.trim() && !pending.length);
  ["#upload", "#asset", "#welcomeAsset"].forEach(
    (s) => ($(s).disabled = !attachmentsEnabled() || uploading || submitting || busy),
  );
  $("#newChat").disabled = uploading || submitting;
  $("#sessionActions").hidden = !current;
  $("#rename").disabled = !current;
  $("#delete").disabled = !current || uploading || submitting;
  document
    .querySelectorAll("#sessions button")
    .forEach((b) => (b.disabled = uploading || submitting));
  document
    .querySelectorAll(".message-attachments button, .attachments button")
    .forEach((b) => (b.disabled = uploading || submitting || busy));
}
function list() {
  const target = $("#sessions");
  target.replaceChildren();
  for (const item of history.filter((x) =>
    x.title.toLowerCase().includes($("#search").value.toLowerCase()),
  )) {
    const button = make("button", "", item.id === current?.id ? "active" : "");
    button.append(
      make("span", item.status === "running" ? "◌" : "▫"),
      make("span", item.title),
    );
    button.title = item.title;
    button.onclick = () => select(item.id).catch((e) => toast(e.message));
    button.disabled = uploading || submitting;
    target.append(button);
  }
  if (!target.children.length)
    target.append(make("p", "灵感会在这里留下记录", "empty-history"));
}
async function refreshHistory(isCurrent=()=>true) {
  const items = await api("/sessions");
  if(!isCurrent())return;
  history = items;
  list();
}
function setSidebarOpen(open) {
  $("#sidebar").classList.toggle("open", open);
  $("#toggleSidebar").setAttribute("aria-expanded", String(open));
}
async function select(id) {
  if (uploading || submitting) return;
  closeMediaPreview();
  draft();
  const token = ++selection, epoch = configurationEpoch;
  const item = await api("/sessions/" + id);
  if (selection !== token || configurationEpoch !== epoch) return;
  current = item;
  safeWrite("hamster-chat-current", id);
  let saved = {};
  try {
    saved = JSON.parse(safeRead("hamster-chat-draft-" + id) || "{}");
  } catch {}
  pending = (saved.pending || []).filter((x) =>
    item.media.some((m) => m.id === x),
  );
  $("#input").value = saved.text || "";
  const sidebarWasOpen = $("#sidebar").classList.contains("open");
  setSidebarOpen(false);
  if (sidebarWasOpen) $("#input").focus();
  render(true);
  list();
}
async function ensureSession() {
  if (current) return;
  current = await api("/sessions", { method: "POST" });
  safeWrite("hamster-chat-current", current.id);
  await refreshHistory();
}
function localMediaEntry(sessionId,media) {
  if(!/^[a-f0-9]{32}$/.test(sessionId||'')||!media||!/^[a-f0-9]{32}$/.test(media.id||''))return null;
  const mime=typeof media.mime==='string'?media.mime.toLowerCase():'';
  const previewKind=media.kind==='image'&&/^image\/(?:png|jpeg|webp|gif)$/.test(mime)?'image':media.kind==='video'&&/^video\/(?:mp4|webm|quicktime)$/.test(mime)?'video':media.kind==='audio'&&/^audio\/(?:mpeg|mp4|wav|x-wav|ogg|webm|flac)$/.test(mime)?'audio':null;
  return {url:`/chat-api/sessions/${sessionId}/media/${media.id}`,previewKind};
}
function clearMediaPreview() {
  const dialog=$('#mediaPreviewDialog');
  for(const hover of mediaPreviewControllers()){
    if(dialog?._materialPreviewTrigger)hover.suppressPointer?.(dialog._materialPreviewTrigger);
    if(typeof hover.close==='function')hover.close();else hover.hide();
  }
  if(dialog){dialog._materialPreviewTrigger=null;dialog._materialPreviewSource=null;}
  const host=$('#mediaPreviewBody');
  if(host){for(const player of host.querySelectorAll('audio,video')){try{player.pause();player._releasePlayback?.();player.removeAttribute('src');player.load();}catch{}}host.replaceChildren();}
  const download=$('#mediaPreviewDownload');if(download)download.removeAttribute('href');
  const title=$('#mediaPreviewTitle');if(title)title.textContent='附件预览';
}
function closeMediaPreview() {
  const dialog=$('#mediaPreviewDialog');
  if(dialog?._materialPreviewTrigger)for(const hover of mediaPreviewControllers())hover.suppressPointer?.(dialog._materialPreviewTrigger);
  if(dialog?.open)dialog.close();clearMediaPreview();
}
function mediaPreviewControllers() {
  return [$('#attachments')?._materialPreview,$('#messages')?._materialPreview].filter(Boolean);
}
function bindAttachmentPreviews(container) {
  if(!container._materialPreview)container._materialPreview=mountMaterialPreview(container,{resolve:attachmentPreviewItem,onOpen:(_item,button)=>{
    const item=attachmentPreviewItem(button);if(item)openMediaPreview(item.media,item.sessionId,button);
  }});
  return container._materialPreview;
}
function refreshMediaPreview() {
  const dialog=$('#mediaPreviewDialog'),source=dialog?._materialPreviewSource;
  if(!dialog?.open||!source)return;
  const media=current?.id===source.sessionId?current.media.find(item=>item.id===source.mediaId):null;
  const entry=localMediaEntry(current?.id,media);
  if(!entry||entry.url!==source.src||entry.previewKind!==source.kind)closeMediaPreview();
}
function openMediaPreview(media,sessionId,trigger=null) {
  const entry=localMediaEntry(sessionId,media),dialog=$('#mediaPreviewDialog'),host=$('#mediaPreviewBody'),download=$('#mediaPreviewDownload');
  if(!entry||sessionId!==current?.id||!current.media.some(item=>item.id===media.id)||!dialog||!host||!download||typeof dialog.showModal!=='function')return toast('附件暂时无法打开，请重新选择。');
  closeMediaPreview();
  dialog._materialPreviewTrigger=trigger;
  dialog._materialPreviewSource={sessionId,mediaId:media.id,src:entry.url,kind:entry.previewKind};
  $('#mediaPreviewTitle').textContent=typeof media.name==='string'?media.name:'本地附件';
  download.href=entry.url;download.download=(typeof media.name==='string'?media.name:'本地附件').replace(/[\x00-\x1f\\/:*?"<>|]/g,'_').slice(0,180)||'本地附件';
  $('#mediaPreviewNote').textContent=entry.previewKind?'附件仅在本地页面预览，不会发送模型请求。':'此类型不在页面内运行，请下载后使用相应应用打开。';
  if(entry.previewKind){
    const preview=make(entry.previewKind==='image'?'img':entry.previewKind);preview.src=entry.url;
    if(entry.previewKind==='image')preview.alt=typeof media.name==='string'?media.name:'本地图片';else{
      preview.controls=true;preview.preload='metadata';preview.playsInline=true;
      preview.autoplay=entry.previewKind==='video';
      let release=null;
      preview._releasePlayback=()=>{release?.();release=null;};
      preview.addEventListener('play',()=>{
        if(!dialog.open||!host.contains(preview)||sessionId!==current?.id)return;
        preview._releasePlayback();release=claimMediaPlayback(window,()=>preview.pause());
      });
      preview.addEventListener('pause',preview._releasePlayback);preview.addEventListener('ended',preview._releasePlayback);
    }
    preview.onerror=()=>{if(!dialog.open||!host.contains(preview))return;preview.hidden=true;const note=make('p','素材暂时无法预览，请下载后查看。','media-preview-error');note.setAttribute('role','alert');host.append(note);};
    host.append(preview);
  }
  try{dialog.showModal();$('#mediaPreviewClose').focus();}catch{clearMediaPreview();toast('附件预览暂时不可用，请稍后重试。');}
}
function attachmentPreviewItem(button) {
  if($('#mediaPreviewDialog')?.open||!button||button.dataset.sessionId!==current?.id)return null;
  const ident=button.dataset.mediaId;
  if(button.dataset.attachmentPending==='true'?!pending.includes(ident):!current?.messages?.some(message=>message.attachments?.includes(ident)))return null;
  const media=current.media.find(item=>item.id===button.dataset.mediaId),entry=localMediaEntry(current.id,media);
  return entry?{src:entry.url,name:media.name,kind:entry.previewKind||'document',detail:`${media.label||'本地附件'} · ${(media.size / 1024 / 1024).toFixed(1)} MB`,media,sessionId:current.id}:null;
}
function fileCard(media, removable = false) {
  const card = make("div", "", removable ? "file-card attachment-tile" : "file-card");
  const sessionId=current?.id,entry=localMediaEntry(sessionId,media);
  card.dataset.mediaId=media.id;
  card.dataset.sessionId=sessionId;
  card._mediaSignature=JSON.stringify(media);
  card.title=media.name;
  const link = make("button",'',"file-open");
  link.type='button';link.disabled=!entry;
  link.setAttribute('aria-label',`预览附件：${media.name}`);
  if (entry?.previewKind === "image") {
    const img = make("img");
    img.src = entry.url;
    img.alt = media.name;
    img.loading = 'lazy';
    img.decoding = 'async';
    link.append(img);
  } else
    link.append(make("span", media.kind === "video" ? "▷" : "▤", "file-icon"));
  if(entry){
    if(removable&&entry.previewKind==='image')card.className+=' attachment-image';
    link.dataset.materialPreview='';link.dataset.mediaId=media.id;link.dataset.sessionId=sessionId;link.dataset.attachmentPending=String(removable);
  }
  const description=make('span','','file-description');
  description.append(
    make("b", media.name),
    make(
      "small",
      `${media.label} · ${(media.size / 1024 / 1024).toFixed(1)} MB`,
    ),
  );
  link.append(description);
  card.append(link);
  if(removable){
    const reference=make('button','@','file-reference');reference.type='button';reference.title='引用到输入框';
    reference.setAttribute('aria-label',`引用附件：${media.name}`);
    reference.disabled=uploading||submitting||current.status==='running';
    reference.onclick=()=>{
      if(sessionId!==current?.id||!pending.includes(media.id)||!current.media.some(item=>item.id===media.id))return;
      $('#input').value+=` ${media.label} `;$('#input').focus();draft();controls();
    };
    card.append(reference);
  }
  const action = make("button", removable ? "×" : "引用",removable?'file-remove':'');
  action.type = "button";
  action.title = removable ? "移除本轮附件" : "再次引用此素材";
  action.setAttribute('aria-label',`${removable?'移除本轮附件':'再次引用此素材'}：${media.name}`);
  action.disabled = uploading || submitting || current.status === "running";
  action.onclick = () => {
    if (removable) pending = pending.filter((x) => x !== media.id);
    else {
      if (!attachmentsEnabled()) return toast('当前对话暂不能引用附件，仍可在本地预览。');
      if (!pending.includes(media.id)) {
        if (pending.length >= 6) return toast("每轮最多6份附件。");
        pending.push(media.id);
      }
      $("#input").value += ` ${media.label} `;
      $("#input").focus();
    }
    draft();
    renderAttachments();
    controls();
  };
  card.append(action);
  return card;
}
function renderAttachments() {
  const target = $("#attachments");
  bindAttachmentPreviews(target);
  const items = pending.map(id => current?.media.find(media => media.id === id)).filter(Boolean);
  const signature = JSON.stringify([current?.id, items]);
  if (target._signature === signature) {target._materialPreview.refresh();refreshMediaPreview();return;}
  target._signature = signature;
  const existing=new Map([...target.children].map(card=>[`${card.dataset.sessionId}/${card.dataset.mediaId}`,card]));
  const cards=items.map(media=>{
    const card=existing.get(`${current.id}/${media.id}`);
    return card?._mediaSignature===JSON.stringify(media)?card:fileCard(media,true);
  });
  for(const card of [...target.children])if(!cards.includes(card))card.remove();
  cards.forEach((card,index)=>{if(target.children[index]!==card)target.insertBefore(card,target.children[index]||null);});
  target._materialPreview.refresh();
  refreshMediaPreview();
}
function richText(container, text) {
  // Build only known elements. HTML, links and image syntax remain text.
  const inline = (tag, value) => {
    const element = make(tag);
    let end = 0;
    for (const match of value.matchAll(/(?<!`)(`+)([^`\n]+)\1(?!`)|\*\*([^*\n]+)\*\*/g)) {
      if (match.index > end) element.append(document.createTextNode(value.slice(end, match.index)));
      element.append(match[1] ? make('code', match[2]) : make('strong', match[3]));
      end = match.index + match[0].length;
    }
    if (end < value.length) element.append(document.createTextNode(value.slice(end)));
    return element;
  };
  const cells = line => line?.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '')
    .split(/(?<!\\)\|/).map(cell => cell.trim().replaceAll('\\|', '|')) || [];
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  let closed = true;
  const paragraph = [];
  const flushParagraph = () => {
    if (!paragraph.length) return;
    container.append(inline('p', paragraph.join('\n')));
    paragraph.length = 0;
  };
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const fence = /^ {0,3}(`{3,}|~{3,})\s*[^`~]*$/.exec(line);
    if (fence) {
      flushParagraph();
      const marker = fence[1], code = [];
      const close = new RegExp('^ {0,3}' + marker[0] + '{' + marker.length + ',}\\s*$');
      for (++index; index < lines.length && !close.test(lines[index]); index++) code.push(lines[index]);
      if (index === lines.length) closed = false;
      const block = make('pre');
      block.append(make('code', code.join('\n')));
      container.append(block);
      continue;
    }
    const heading = /^ {0,3}(#{1,6})\s+(\S.*)$/.exec(line);
    if (heading) {
      flushParagraph();
      container.append(inline('h' + heading[1].length, heading[2].replace(/\s+#+\s*$/, '')));
      continue;
    }
    const divider = /^\s*[|:\-]/.test(lines[index + 1] || '') ? cells(lines[index + 1]) : [];
    if (line.includes('|') && divider.length && divider.every(cell => /^:?-{3,}:?$/.test(cell))) {
      const headers = cells(line);
      if (headers.length === divider.length) {
        flushParagraph();
        const wrapper = make('div', '', 'message-table'), table = make('table');
        const head = make('thead'), row = make('tr'), body = make('tbody');
        headers.forEach(header => {
          const entry = inline('th', header);
          entry.setAttribute('scope', 'col');
          row.append(entry);
        });
        head.append(row); table.append(head, body); wrapper.append(table); container.append(wrapper);
        index++;
        while (lines[index + 1]?.includes('|')) {
          const values = cells(lines[index + 1]);
          if (values.length !== headers.length || /^ {0,3}(?:#{1,6}\s|`{3,}|~{3,})/.test(lines[index + 1])) break;
          index++;
          const data = make('tr');
          values.forEach(value => data.append(inline('td', value)));
          body.append(data);
        }
        continue;
      }
    }
    if (line.trim()) paragraph.push(line);
    else flushParagraph();
  }
  flushParagraph();
  return closed;
}
function render(scroll = false) {
  const area = $("#scrollArea"),
    nearBottom = area.scrollHeight - area.scrollTop - area.clientHeight < 100;
  const messages=current?.messages||[];
  $("#welcome").hidden = messages.length > 0;
  const target = $("#messages");
  bindAttachmentPreviews(target);
  // Keep nodes stable while polling so selection, previews and scrolling are not reset.
  if (target.dataset.session !== (current?.id || '')) {
    target.replaceChildren();
    target.dataset.session = current?.id || "";
    firstVisibleMessage = Math.max(0, messages.length - chatHistoryBatch);
  }
  const assets = new Map((current?.media || []).map(media => [media.id, media]));
  const existing = new Map(Array.from(target.children, section => [section.id, section]));
  let earlier=existing.get('earlierMessages');
  if(firstVisibleMessage>0&&!earlier){
    earlier=make('button','显示更早消息','earlier-messages');
    earlier.id='earlierMessages';
    earlier.type='button';
    earlier.onclick=()=>{
      const anchor=earlier.nextElementSibling;
      const top=anchor?.getBoundingClientRect().top;
      firstVisibleMessage=Math.max(0,firstVisibleMessage-chatHistoryBatch);
      render();
      if(anchor)area.scrollTop+=anchor.getBoundingClientRect().top-top;
    };
    target.prepend(earlier);
  }
  if(firstVisibleMessage===0&&earlier){earlier.remove();earlier=null;}
  let next=earlier?.nextElementSibling??(earlier?null:target.firstElementChild);
  for (const msg of messages.slice(firstVisibleMessage)) {
    const billingState = answerNotice(msg);
    let section = existing.get("message-" + msg.id);
    if (!section) {
      section = make('article', '', 'message ' + msg.role);
      section.id = "message-" + msg.id;
      if (msg.role === "assistant") {
        const label = make("div", "", "assistant-label"), img = make("img");
        img.src = "/hamster-logo.png";
        img.alt = "";
        label.append(img, make("span", "仓鼠AI智能体"));
        section.append(label);
      }
      const attachments=make('div','','message-attachments'),body=make('div','','message-body');
      const notice=make('p','','notice'),actions=make('div','','message-actions');
      section.append(attachments,body,notice,actions);
      renderedMessages.set(section,{attachments,body,notice,actions});
    }
    if(section!==next)target.insertBefore(section,next??null);
    next=section.nextElementSibling;
    existing.delete(section.id);
    const parts=renderedMessages.get(section);
    const attachments=msg.attachments.map(id=>assets.get(id)).filter(Boolean);
    const attachmentSignature=JSON.stringify(attachments);
    if(parts.attachmentSignature!==attachmentSignature){
      parts.attachments.hidden=!attachments.length;
      parts.attachments.replaceChildren(...attachments.map(media=>fileCard(media)));
      parts.attachmentSignature=attachmentSignature;
    }
    const running=msg.status==='running';
    const preview = running && current.status === 'running' && msg.role === 'assistant' && typeof msg.partial_text === 'string' ? msg.partial_text : '';
    const waiting = running && !preview;
    const bodyText = running ? preview || '仓鼠正在思考…' : msg.text;
    if (parts.text !== bodyText || parts.running !== running || parts.preview !== preview) {
      if (msg.role === 'assistant' && !waiting) {
        const suffix = parts.preview && bodyText.startsWith(parts.preview) ? bodyText.slice(parts.preview.length) : '';
        const boundary = (parts.preview || '').slice(-3) + suffix.slice(0, 3);
        if (suffix && parts.closed && /\r?\n[\t ]*\r?\n/.test(boundary)) parts.closed = richText(parts.body, suffix);
        else if (!parts.preview || bodyText !== parts.preview) {
          parts.body.replaceChildren();
          parts.closed = richText(parts.body, bodyText);
        }
      } else parts.body.textContent = bodyText;
      parts.body.classList.toggle('blink', waiting);
      parts.text = bodyText; parts.running = running; parts.preview = preview;
    }
    if(parts.billingState!==billingState){
      parts.notice.textContent=billingState;
      parts.notice.hidden=!billingState;
      parts.billingState=billingState;
    }
    const assistant=msg.role==='assistant'&&!running;
    const billCheck=billingChecks.get(`${current?.id}/${msg.billing?.request_id}`);
    const slowCheck=billCheck&&!billCheck.pending&&billCheck.attempts>=billingCheckDelays.length;
    const canCheck=Boolean(assistant&&billingNotice(msg.billing)&&(slowCheck||billingBlocksAdmission(msg.billing)&&!['completed','partial'].includes(msg.status)));
    const canRetry=assistant&&['failed','cancelled','interrupted'].includes(msg.status)&&!usesRetiredModel(msg)&&!billingNotice(msg.billing)&&msg.id===messages.at(-1)?.id;
    const actions=parts.actions;
    const canCopy=Boolean(assistant&&msg.text);
    if(parts.copy&&!canCopy){parts.copy.remove();parts.copy=null;}
    if(parts.refresh&&!canCheck){parts.refresh.remove();parts.refresh=null;}
    if(parts.retry&&!canRetry){parts.retry.remove();parts.retry=null;}
    if(!parts.copy&&canCopy){
      const copy=parts.copy=make('button','复制');
      copy.onclick=async()=>{
        try {
          await navigator.clipboard.writeText(parts.text);
          toast("已复制回答");
        } catch {
          toast("复制失败，请选择文字后复制。");
        }
      };
      actions.append(copy);
    }
    if(!parts.refresh&&canCheck){
      const refresh=parts.refresh=make('button','核对状态');
      refresh.onclick = async () => {
        refresh.disabled = true;
        try { await reconcileBills({manual:true,requestId:parts.operation}); }
        finally { refresh.disabled = false; }
      };
      actions.append(refresh);
    }
    if(!parts.retry&&canRetry){
      const retry=parts.retry=make('button','重新回答');
      retry.onclick=()=>send(true);
      actions.append(retry);
    }
    parts.operation=msg.billing?.request_id;
    if(parts.retry)parts.retry.disabled=['reserved','unknown','dispatching','dispatched','submitted'].includes(msg.billing?.status);
    actions.hidden=!(canCopy||canCheck||canRetry);
  }
  for(const section of existing.values())if(section!==earlier&&section.id!=='earlierMessages')section.remove();
  target._materialPreview.refresh();
  // Older saved sessions can still contain internal progress notes.
  const notice = current?.notice?.startsWith("云端上下文已重建") ? "" : current?.notice || "";
  const stage = current?.status !== "running" ? "" : (current?.stage || "").replace(/正在审查完整回答…/g, "正在整理回答…");
  $("#notice").hidden = !notice;
  $("#notice").textContent = notice;
  $("#taskStatus").hidden = !stage;
  $("#taskStatus").textContent = stage;
  $("#taskStatus").classList.toggle("running", current?.status === "running");
  renderAttachments();
  controls();
  if (!current?.messages.length) area.scrollTop = 0;
  else if (scroll || nearBottom) area.scrollTop = area.scrollHeight;
}
async function send(retry = false) {
  if (uploading || submitting || current?.status === "running") return;
  if (!ready)return toast('请先在主应用的个人中心配置对话 Key。');
  if ((retry&&billingNotice(current?.messages.at(-1)?.billing))||current?.messages.some(message=>billingBlocksAdmission(message.billing)))
    return toast('正在核对请求状态，请勿重复发送。');
  if (retry && usesRetiredModel(current?.messages.at(-1))) return toast('可以发送一条新消息，继续这段对话。');
  submitting = true;
  controls();
  try {
    await ensureSession();
    const id = current.id, selected = selection, epoch = configurationEpoch;
    let priceVersion = '', confirmationContext = '';
    if (metered) {
      const terms = await api('/capabilities');
      if(!ready||current?.id!==id||selection!==selected||configurationEpoch!==epoch)throw Error('会话或连接状态已变化，请重新确认后发送。');
      const previous = paidTermsIdentity(availableTerms);
      availableTerms = terms;
      applyAttachmentCapabilities(terms);
      const identity = paidTermsIdentity(terms);
      if (!identity || terms.confirmation_context !== configurationContext || previous && previous !== identity) throw Error('对话计费或连接状态已变化，请重试。');
      if (!retry && pending.length && (!attachmentsEnabled() || pending.some(id => !attachmentCapabilities?.[attachmentKind(current.media.find(media => media.id === id)?.name)])))
        throw Error('当前对话不支持本轮的部分或全部附件，请移除相应附件后重试。');
      priceVersion = terms.price_version;
      confirmationContext = terms.confirmation_context;
    }
    const payload = {
      request_id: crypto.randomUUID(),
      parent: current.messages.at(-1)?.id || "",
      text: $("#input").value,
      attachments: pending,
      ...(priceVersion ? {model:availableTerms.model,price_version:priceVersion,confirmation_context:confirmationContext} : {}),
    };
    const result = await api(
      `/sessions/${id}/${retry ? "retry" : "messages"}`,
      json("POST", payload),
    );
    if (current?.id !== id || selection !== selected || configurationEpoch !== epoch) return;
    current = result;
    if (!retry) {
      $("#input").value = "";
      pending = [];
      draft();
    }
    render(true);
    await refreshHistory();
  } catch (e) {
    toast(e.message);
    if (current) {
      try {
        const previous = current, selected = selection, epoch = configurationEpoch;
        const item = await api("/sessions/" + previous.id);
        if (current === previous && selection === selected && configurationEpoch === epoch) { current = item; render(); }
      } catch {}
    }
  } finally {
    submitting = false;
    controls();
    if(current?.status==='running'){
      if(polling)pollOnReturn=true;
      schedulePoll(0);
    }
  }
}
async function uploadFiles(files) {
  if (!files.length) return;
  if (uploading || submitting || current?.status === "running")
    return toast("请等待当前操作结束。");
  if (pending.length + files.length > 6) return toast("每轮最多6份附件。");
  uploading = true;
  controls();
  try {
    await refreshAttachmentCapabilities();
    if(!attachmentsEnabled())throw Error('当前对话暂不能添加素材，请稍后重试。');
    const maximum=metered?attachmentCapabilities.max_attachments:6;
    if(pending.length+files.length>maximum)throw Error('本轮附件数量超过当前线路限制。');
    await ensureSession();
    const id=current.id,selected=selection,epoch=configurationEpoch;
    for (const file of files) {
      const kind=attachmentKind(file.name);
      if(!kind||metered&&!attachmentCapabilities?.[kind])throw Error('当前对话不支持此附件格式。');
      if(file.size>attachmentSizeLimit(kind))throw Error('附件超过当前线路的大小限制。');
      $("#taskStatus").hidden = false;
      $("#taskStatus").textContent = "正在添加：" + file.name;
      const media = await api(
        `/sessions/${current.id}/media?name=${encodeURIComponent(file.name)}`,
        { method: "POST", body: file },
      );
      if(current?.id!==id||selection!==selected||configurationEpoch!==epoch)throw Error('会话或账户已变化，请重新选择素材。');
      current.media.push(media);
      pending.push(media.id);
      draft();
      renderAttachments();
    }
    toast("素材已添加");
  } catch (e) {
    toast(e.message);
  } finally {
    uploading = false;
    $("#fileInput").value = "";
    render();
  }
}
async function chooseAsset() {
  if (uploading || submitting || current?.status === "running" || mentionOpen)
    return;
  if (pending.length >= 6) return toast("每轮最多6份附件。");
  mentionOpen = true;
  try {
    await refreshAttachmentCapabilities();
    const kinds = assetKinds();
    if(!attachmentsEnabled()||!kinds.length)throw Error('当前对话暂不能添加资产，请稍后重试。');
    const selected = selection, epoch = configurationEpoch;
    const asset = await pickAsset({ base: "/studio-api/assets", ...(metered ? {kinds} : {}) });
    if (!asset) return;
    if(selection!==selected||configurationEpoch!==epoch)throw Error('会话或账户已变化，请重新选择素材。');
    uploading = true;
    controls();
    await ensureSession();
    const id=current.id;
    const media = await api(`/sessions/${id}/assets/${asset.id}`, {
      method: "POST",
    });
    if(current?.id!==id||selection!==selected||configurationEpoch!==epoch)throw Error('会话或账户已变化，请重新选择素材。');
    current.media.push(media);
    pending.push(media.id);
    $("#input").value = $("#input").value.replace(/@$/, "") + media.label + " ";
    draft();
    render();
    $("#input").focus();
    toast("已添加素材");
  } catch (e) {
    toast(e.message);
  } finally {
    mentionOpen = false;
    uploading = false;
    controls();
  }
}
$("#composer").onsubmit = (e) => {
  e.preventDefault();
  send();
};
$("#input").onkeydown = (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    send();
  }
};
$("#input").oninput = (e) => {
  draft();
  controls();
  if (e.data === "@") chooseAsset();
};
$("#upload").onclick = () => $("#fileInput").click();
$("#fileInput").onchange = () => uploadFiles([...$("#fileInput").files]);
$("#asset").onclick = chooseAsset;
$("#welcomeAsset").onclick = chooseAsset;
async function stopCurrent() {
  if (current?.status !== 'running' || stopping) return;
  const id = current.id, token = selection, epoch = configurationEpoch;
  stopping = true;
  $("#stop").disabled = true;
  try {
    const item = await api(`/sessions/${id}/stop`, { method: "POST" });
    if (current?.id === id && token === selection && epoch === configurationEpoch) {
      current = item;
      render();
    }
  } catch (e) {
    if (token === selection && epoch === configurationEpoch) toast(e.message);
  } finally {
    stopping = false;
    $("#stop").disabled = false;
  }
}
$("#stop").onclick = stopCurrent;
$("#newChat").onclick = () => {
  closeMediaPreview();
  draft();
  selection++;
  current = null;
  pending = [];
  $("#input").value = "";
  safeWrite("hamster-chat-current", "");
  setSidebarOpen(false);
  render();
  list();
  $("#input").focus();
};
$("#search").oninput = list;
$("#toggleSidebar").onclick = () => {
  setSidebarOpen(true);
  $("#closeSidebar").focus();
};
$("#closeSidebar").onclick = () => {
  setSidebarOpen(false);
  $("#toggleSidebar").focus();
};
$("#sidebar").onkeydown = (event) => {
  if (event.key === "Escape" && $("#sidebar").classList.contains("open")) $("#closeSidebar").click();
};
$("#rename").onclick = () => {
  if (!current) return;
  $("#titleInput").value = current.title;
  $("#renameDialog").dataset.session = current.id;
  $("#renameDialog").showModal();
};
$("#renameDialog").onclose = async () => {
  if ($("#renameDialog").returnValue !== "save") return;
  const id = $("#renameDialog").dataset.session;
  try {
    const item = await api(
      "/sessions/" + id,
      json("PATCH", { title: $("#titleInput").value }),
    );
    if (current?.id === id) current = item;
    await refreshHistory();
  } catch (e) {
    toast(e.message);
  }
};
$("#delete").onclick = () => {
  if (!current) return;
  $("#deleteDialog").dataset.session = current.id;
  $("#deleteDialog").showModal();
};
$("#deleteDialog").onclose = async () => {
  if ($("#deleteDialog").returnValue !== "delete") return;
  const id = $("#deleteDialog").dataset.session;
  try {
    const result = await api("/sessions/" + id, { method: "DELETE" });
    if (current?.id === id) $("#newChat").click();
    await refreshHistory();
    toast(result.message);
  } catch (e) {
    toast(e.message);
  }
};
$('#mediaPreviewClose').onclick=closeMediaPreview;
$('#mediaPreviewDialog').onclose=()=>{if(!$('#mediaPreviewDialog').open)clearMediaPreview();};
$('#mediaPreviewDialog').oncancel=event=>{event.preventDefault();closeMediaPreview();};
document.querySelectorAll("[data-prompt]").forEach(
  (b) =>
    (b.onclick = () => {
      $("#input").value = b.dataset.prompt;
      draft();
      controls();
      $("#input").focus();
    }),
);
document.addEventListener("dragenter", (e) => {
  if (e.dataTransfer.types.includes("Files")) {
    e.preventDefault();
    if (!attachmentsEnabled()) return;
    dragDepth++;
    $("#dropOverlay").hidden = false;
  }
});
document.addEventListener("dragover", (e) => {
  if (e.dataTransfer.types.includes("Files")) e.preventDefault();
});
document.addEventListener("dragleave", () => {
  if (--dragDepth <= 0) {
    dragDepth = 0;
    $("#dropOverlay").hidden = true;
  }
});
document.addEventListener("drop", (e) => {
  if (e.dataTransfer.files.length) {
    e.preventDefault();
    dragDepth = 0;
    $("#dropOverlay").hidden = true;
    if (!e.target.closest(".asset-dialog"))
      uploadFiles([...e.dataTransfer.files]);
  }
});
document.addEventListener("paste", (e) => {
  const files = [...e.clipboardData.items]
    .filter((x) => x.kind === "file")
    .map((x) => x.getAsFile());
  if (files.length && !document.querySelector("dialog[open]")) {
    e.preventDefault();
    uploadFiles(files);
  }
});
let pollCount = 0, pollTimer = null, polling = false;
let activityEpoch=0, pollOnReturn=false, pollRequest=null, refreshSnapshot=false;
const workspaceActivity=observeWorkspaceActivity('chat',visible=>{
  activityEpoch++;
  if(!visible){
    closeMediaPreview();
    pollRequest?.abort();
    refreshSnapshot=true;
  }
  if(visible){
    if(polling)pollOnReturn=true;
    void refreshAttachmentCapabilities().then(controls);
  }
  schedulePoll(0);
});
function schedulePoll(delay = current?.status === "running" ? 100 : 2000) {
  clearTimeout(pollTimer);
  pollTimer = null;
  if (workspaceActivity.isVisible() && !polling)
    pollTimer = setTimeout(poll, delay);
}
async function poll() {
  pollTimer = null;
  if (polling || !workspaceActivity.isVisible()) return;
  polling = true;
  const epoch=activityEpoch, stillVisible=()=>epoch===activityEpoch&&workspaceActivity.isVisible();
  let readFailed=false;
  try {
    if (current && !submitting && !uploading && !stopping) {
      const session=current, configEpoch=configurationEpoch, selected=selection;
      const stillCurrent=()=>current===session&&selected===selection&&configEpoch===configurationEpoch
        &&stillVisible()&&!submitting&&!uploading&&!stopping;
      const route='/sessions/'+encodeURIComponent(session.id);
      const tail=session.messages.at(-1), offset=[...(tail?.partial_text||'')].length;
      pollRequest=new AbortController();
      const options={signal:AbortSignal.any([pollRequest.signal,AbortSignal.timeout(10000)])};
      let update={kind:'snapshot'};
      if(!refreshSnapshot&&Number.isFinite(session.updated)&&session.updated>0){
        const params=new URLSearchParams({updated:String(session.updated),tail:tail?.id||'',offset:String(offset),
          wait:session.status==='running'?'true':'false'});
        update=await api(`${route}/updates?${params}`,{...options,headers:{'X-Hamster-Chat-Context':configurationContext}});
      }
      if(!stillCurrent())return;
      if(update.kind==='configuration'){
        const config=await api('/config',options);
        if(!stillCurrent())return;
        applyConfiguration(config);
        refreshSnapshot=true;
      }else if(update.kind==='append'||update.kind==='clear'){
        if(session.status!=='running'||tail?.status!=='running'||tail.id!==update.message
            ||update.kind==='append'&&(update.offset!==offset||typeof update.text!=='string'||!update.text)){
          refreshSnapshot=true;
        }else{
          const {partial_text: previous,...message}=tail;
          if(update.kind==='append')message.partial_text=(previous||'')+update.text;
          current={...session,messages:[...session.messages.slice(0,-1),message]};
          render();
        }
      }else{
        if(update.kind!=='none'){
          const item=await api(route,options);
          if(!stillCurrent()||item?.id!==session.id)return;
          refreshSnapshot=false;
          if(JSON.stringify(session)!==JSON.stringify(item)){
            current=item;
            render();
          }
        }
        await reconcileBills();
      }
    }
    if (stillVisible() && ++pollCount % 5 === 0) {
      const config = await api("/config");
      if (!stillVisible()) return;
      const previousConfiguration = configurationEpoch;
      applyConfiguration(config);
      if(previousConfiguration!==configurationEpoch)void refreshAttachmentCapabilities().then(controls);
      await refreshHistory(stillVisible);
      if (!stillVisible()) return;
      controls();
    }
  } catch {
    readFailed=true;
    refreshSnapshot=true;
  } finally {
    pollRequest=null;
    polling = false;
    schedulePoll(pollOnReturn?0:readFailed?1000:undefined);
    pollOnReturn=false;
  }
}
async function init() {
  try {
    const [config] = await Promise.all([api("/config"), refreshHistory()]);
    applyConfiguration(config);
    void refreshAttachmentCapabilities().then(controls);
    const id = safeRead("hamster-chat-current");
    if (history.some((x) => x.id === id)) await select(id);
  } catch (e) {
    toast(e.message);
  }
  render();
  poll();
}
init();
