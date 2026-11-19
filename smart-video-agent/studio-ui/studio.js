import {pickAsset,chooseAssetCategory,assetsRequest} from '/shared/asset-library.mjs';
const $ = (id) => document.getElementById(id);
const stageNames = [
  "营销策划",
  "分镜脚本",
  "首帧生成",
  "图片评选",
  "视频生成",
  "视频评选",
  "合成成片",
];
const statuses = {
  running: "制作中",
  success: "已完成",
  failed: "制作失败",
  cancelled: "已停止",
  interrupted: "已中断",
  pending: "等待中",
  complete: "已完成",
};
let config = {},
  current = null,
  imageUrl = "",
  uploading = false,
  submitting = false,
  timer,
  toastTimer;
const form = $("briefForm");
const assetBase='/studio-api/assets';
const chosenAssets={};
const assetBlock=document.createElement('section');
assetBlock.innerHTML='<h3>达人带货素材</h3><p class="muted">每类可选一份图片或视频，开始制作时上传。图片参考形象与外观，视频参考动作和运镜。仅使用有权使用的达人素材。</p>';
for(const [role,label] of Object.entries({talent:'达人',product:'产品',scene:'场景'})){
  const row=document.createElement('div');row.className='asset-reference';
  const title=document.createElement('strong');title.textContent=label+'参考';
  const select=document.createElement('button');select.type='button';select.className='asset-button';select.textContent='选择'+label+'资产';
  const upload=document.createElement('button');upload.type='button';upload.className='asset-button';upload.textContent='临时上传'+label+'素材';
  const remove=document.createElement('button');remove.type='button';remove.className='asset-button';remove.textContent='清除';
  const input=document.createElement('input');input.type='file';input.accept='image/png,image/jpeg,image/webp,video/mp4,video/webm,video/quicktime';input.hidden=true;
  const status=document.createElement('small');status.dataset.assetRole=role;status.textContent='未选择（选填）';
  const apply=value=>{if(submitting)return;chosenAssets[role]=value;status.textContent=value?value.name:'未选择（选填）';};
  select.onclick=async()=>{if(submitting)return;const item=await pickAsset({base:assetBase,category:role});if(item)apply(item);};
  upload.onclick=()=>{if(!submitting)input.click();};
  input.onchange=()=>{const file=input.files[0];if(!file)return;if(file.size>50*1024*1024){toast('素材最大50MB');return;}const kind=file.type.split('/')[0];if(!['image','video'].includes(kind)){toast('请选择图片或视频');return;}apply({file,name:file.name,kind});input.value='';};
  remove.onclick=()=>apply(null);row.append(title,select,upload,remove,input,status);assetBlock.append(row);
}
form.insertBefore(assetBlock,form.querySelector('.label-row'));
function publicText(value) {
  return String(value ?? '').replace(/https?:\/\/[^\s<>"']+/gi, '素材地址')
    .replace(/running\s*hub|三宝(?:影像工坊)?|sanbao(?:beauty)?|火山方舟|方舟|volcengine|veadk|seedance|hailuo|doubao|gpt[- ]?image\S*/gi, '仓鼠服务')
    .replace(/\b(?:sd2\w*|sd25\w*|wan30\w*)\b/gi, '仓鼠视频线路');
}
function syncRoute() {
  if (!form.elements.video_model.value) form.elements.video_model.value = 'sd_2_5_once_720p';
  const line3 = form.elements.video_model.value === 'sd_2_5_once_line3';
  form.elements.resolution.replaceChildren(...(line3 ? ['480p','720p'] : ['720p']).map(value=>new Option(value,value,false,value==='720p')));
  const fixed30 = form.elements.video_model.value === 'sd_2_5_900_30s';
  form.elements.seconds.replaceChildren(...(fixed30
    ? [new Option('固定 30 秒','30')]
    : [new Option('约 20 秒','5'),new Option('约 40 秒','10')]));
}
form.elements.video_model.addEventListener('change', syncRoute);
const icons = () => window.lucide?.createIcons();
function toast(text) {
  $("toast").textContent = publicText(text);
  $("toast").hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ($("toast").hidden = true), 5500);
}
async function api(path, options = {}) {
  const response = await fetch("/studio-api" + path, options);
  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error("服务响应异常，请重新打开智能成片");
  }
  if (!response.ok)
    throw new Error(
      typeof data.detail === "string"
        ? data.detail
        : "请求参数不完整，请检查创作需求",
    );
  return data;
}
function el(tag, text, cls) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (cls) node.className = cls;
  return node;
}
function safeUrl(url) {
  try {
    const parsed = new URL(url, location.origin);
    return ["https:", "http:"].includes(parsed.protocol) ? parsed.href : null;
  } catch {
    return null;
  }
}
function buttons() {
  $("startButton").disabled =
    uploading ||
    submitting ||
    !!config.active ||
    !config.mediaReady ||
    !config.llmReady;
  $("startButton").querySelector("span").textContent = submitting
    ? "正在创建任务…"
    : config.active
      ? "有任务正在制作"
      : "开始制作";
}
async function loadConfig() {
  config = await api("/config");
  const missing = [];
  if (!config.mediaReady) missing.push("图片 / 视频 API Key");
  if (!config.llmReady) missing.push("主线路 API Key（用于自动激活智能服务）");
  $("configNotice").hidden = !missing.length;
  $("configNotice").textContent =
    "还差一步：请在仓鼠AI「账户」页保存 " +
    missing.join("、") +
    "，然后点击右上角「连接状态」刷新。";
  $("outputPath").textContent = "保存位置：" + config.output;
  buttons();
}
function resetImage() {
  imageUrl = "";
  $("fileInput").value = "";
  $("imagePreview").hidden = true;
  $("uploadButton").hidden = false;
  $("previewImage").removeAttribute("src");
}
async function upload(file) {
  if (!file || uploading) return;
  if (!["image/jpeg", "image/png", "image/webp"].includes(file.type))
    return toast("请选择 JPG、PNG 或 WebP 图片");
  if (file.size > 10 * 1024 * 1024) return toast("图片不能超过 10 MB");
  uploading = true;
  buttons();
  $("uploadZone").classList.add("uploading");
  $("uploadTitle").textContent = "正在上传商品参考图…";
  $("uploadButton").disabled = true;
  try {
    const data = await api("/upload?name=" + encodeURIComponent(file.name), {
      method: "POST",
      headers: { "Content-Type": file.type },
      body: file,
    });
    imageUrl = data.url;
    $("previewImage").src = safeUrl(imageUrl);
    $("imageName").textContent = file.name;
    $("imagePreview").hidden = false;
    $("uploadButton").hidden = true;
    toast("商品参考图已就绪");
  } catch (e) {
    toast(e.message);
  } finally {
    uploading = false;
    buttons();
    $("uploadZone").classList.remove("uploading");
    $("uploadTitle").textContent = "拖一张商品图到这里";
    $("uploadButton").disabled = false;
  }
}
$("uploadButton").onclick = () => $("fileInput").click();
$("fileInput").onchange = (e) => upload(e.target.files[0]);
$("removeImage").onclick = resetImage;
let dragDepth = 0;
$("uploadZone").ondragenter = (e) => {
  e.preventDefault();
  dragDepth++;
  $("uploadZone").classList.add("dragover");
};
$("uploadZone").ondragover = (e) => e.preventDefault();
$("uploadZone").ondragleave = () => {
  if (--dragDepth <= 0) $("uploadZone").classList.remove("dragover");
};
$("uploadZone").ondrop = (e) => {
  e.preventDefault();
  dragDepth = 0;
  $("uploadZone").classList.remove("dragover");
  if (e.dataTransfer.files.length > 1)
    return toast("此工作流每次使用一张商品参考图");
  upload(e.dataTransfer.files[0]);
};
function estimate() {
  const count = Number(form.elements.candidates.value) * 4;
  $("estimate").textContent =
    `4 个分镜 · ${count} 张候选图 · ${count} 段候选视频`;
}
form.oninput = () => {
  estimate();
  try {
    const draft = Object.fromEntries(new FormData(form));
    localStorage.setItem("hamster-smart-brief", JSON.stringify(draft));
  } catch {}
};
function renderSteps(
  stages = stageNames.map((title) => ({ title, status: "pending" })),
) {
  const list = $("steps");
  list.replaceChildren();
  stages.forEach((stage, i) => {
    const li = el("li", undefined, stage.status);
    li.append(
      el(
        "span",
        stage.status === "complete" ? "✓" : String(i + 1).padStart(2, "0"),
        "step-number",
      ),
      el("span", stage.title),
    );
    list.append(li);
  });
  const done = stages.filter((s) => s.status === "complete").length;
  $("progressFill").style.width = (done / 7) * 100 + "%";
  $("stageCount").textContent = done + " / 7";
  const running = stages.find((s) => s.status === "running");
  $("stageLabel").textContent = running
    ? "正在" + running.title + "，请稍候…"
    : done === 7
      ? "所有阶段已完成"
      : "从营销策划到最终成片，全流程可追踪";
}
function showMedia(container, media) {
  media.forEach((m, i) => {
    const url = safeUrl(m.url);
    if (!url) return;
    const card = el("div");
    const visual = el(m.kind === "video" ? "video" : "img");
    visual.src = url;
    if (m.kind === "video") {
      visual.controls = true;
      visual.preload = "metadata";
    } else {
      visual.alt = "候选首帧 " + (i + 1);
      visual.loading = "lazy";
    }
    const link = el("a", "打开候选素材 " + (i + 1));
    link.href = url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    card.append(visual, link);
    container.append(card);
  });
}
function renderJob(job) {
  current = job;
  localStorage.setItem("hamster-smart-current", job.id);
  $("jobTitle").textContent = job.brief.product;
  $("jobStatus").textContent = statuses[job.status] || job.status;
  $("jobStatus").className = "tag " + job.status;
  renderSteps(job.stages);
  $("jobError").hidden = !job.error;
  $("jobError").textContent = publicText(job.error);
  $("cancelButton").hidden = job.status !== "running";
  $("reuseButton").hidden = false;
  $("updatedAt").textContent =
    "更新于 " + new Date(job.updated).toLocaleTimeString("zh-CN");
  $("emptyOutput").hidden = true;
  $("waitingOutput").hidden = job.status !== 'running' || job.stages.some(s => s.text || s.media.length);
  for (const stage of job.stages) {
    const key = "output-" + stage.id;
    let details = $(key);
    if (!stage.text && !stage.media.length) continue;
    if (!details) {
      details = el("details", undefined, "stage-output");
      details.id = key;
      details.open = true;
      details.append(
        el("summary", stage.title),
        el("pre"),
        el("div", undefined, "media-grid"),
      );
      $("stageOutputs").append(details);
    }
    const pre = details.querySelector("pre");
    if (pre.textContent !== publicText(stage.text)) pre.textContent = publicText(stage.text);
    const grid = details.querySelector(".media-grid");
    const fingerprint = JSON.stringify(stage.media);
    if (grid.dataset.media !== fingerprint) {
      grid.replaceChildren();
      showMedia(grid, stage.media);
      grid.dataset.media = fingerprint;
    }
    details.querySelector("summary").textContent =
      stage.title + " · " + (statuses[stage.status] || "");
  }
  if (job.result && $("finalResult").dataset.job !== job.id) {
    const wrap = $("finalResult");
    wrap.replaceChildren();
    const card = el("div", undefined, "final-card");
    const video = el("video");
    video.src = job.result.url;
    video.controls = true;
    video.preload = "metadata";
    const bar = el("div", undefined, "final-bar");
    const download = el("a", "下载成片", "download");
    download.href = job.result.url + "?download=true";
    const collect=el('button','收入资产库','asset-button');collect.type='button';
    collect.onclick=async()=>{const category=await chooseAssetCategory();if(!category)return;collect.disabled=true;try{await api('/jobs/'+job.id+'/collect',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({category})});toast('成片已收入本地资产库');}catch(e){toast(e.message);}finally{collect.disabled=false;}};
    bar.append(el("span", "成片已保存到本地"), download,collect);
    card.append(video, bar);
    wrap.append(card);
    wrap.dataset.job = job.id;
    wrap.hidden = false;
  }
  if (job.status !== "running" && config.active === job.id) {
    config.active = null;
    buttons();
    loadHistory().catch(() => {});
  }
}
function clearOutput() {
  $("stageOutputs").replaceChildren();
  $("finalResult").replaceChildren();
  $("finalResult").hidden = true;
  delete $("finalResult").dataset.job;
}
async function selectJob(id) {
  clearTimeout(timer);
  const job = await api("/jobs/" + id);
  clearOutput();
  renderJob(job);
  await loadHistory();
  if (job.status === "running") poll(id);
}
function poll(id) {
  clearTimeout(timer);
  timer = setTimeout(async () => {
    try {
      const job = await api("/jobs/" + id);
      if (current?.id !== id) return;
      renderJob(job);
      if (job.status === "running") poll(id);
    } catch (e) {
      toast("连接暂时中断，正在重连…");
      poll(id);
    }
  }, 1800);
}
async function loadHistory() {
  const items = await api("/jobs");
  const list = $("historyList");
  list.replaceChildren();
  if (!items.length) {
    list.append(
      el("p", "还没有制作记录。完成第一个创意后，会保存在这里。", "muted"),
    );
    return;
  }
  for (const item of items) {
    const button = el(
      "button",
      undefined,
      "history-card" + (current?.id === item.id ? " selected" : ""),
    );
    button.append(
      el("b", item.product),
      el("small", new Date(item.created).toLocaleString("zh-CN")),
      el("span", statuses[item.status] || item.status, "tag " + item.status),
    );
    button.onclick = () => selectJob(item.id).catch((e) => toast(e.message));
    list.append(button);
  }
}
form.onsubmit = async (e) => {
  e.preventDefault();
  if (!form.reportValidity() || uploading || submitting || config.active)
    return;
  submitting = true;
  buttons();
  try {
    const brief = Object.fromEntries(new FormData(form));
    brief.seconds = Number(brief.seconds);
    brief.candidates = Number(brief.candidates);
    brief.image_url = imageUrl;
    const selected=Object.entries(chosenAssets).filter(([,item])=>item);
    if(brief.video_model==='sd_2_5_900_30s'&&selected.some(([,item])=>item.kind==='video'))throw new Error('SD2.5-9图-30秒仅支持图片参考，请替换视频素材');
    brief.references=[];
    for(const [role,item]of selected){
      const uploaded=item.file ? await api('/upload?name='+encodeURIComponent(item.name),{method:'POST',headers:{'Content-Type':item.file.type},body:item.file}) : await assetsRequest(assetBase,`/${item.id}/upload`,{method:'POST'});
      brief.references.push({role,kind:item.kind,name:item.name,url:uploaded.url});
    }
    const job = await api("/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(brief),
    });
    config.active = job.id;
    clearOutput();
    renderJob(job);
    poll(job.id);
    await loadHistory();
  } catch (error) {
    toast(error.message);
    await loadConfig().catch(() => {});
  } finally {
    submitting = false;
    buttons();
  }
};
$("cancelButton").onclick = async () => {
  if (!current) return;
  $("cancelButton").disabled = true;
  try {
    const job = await api("/jobs/" + current.id + "/cancel", {
      method: "POST",
    });
    renderJob(job);
    await loadConfig();
    toast("已停止制作，已开始的任务可能仍会产生费用");
  } catch (e) {
    toast(e.message);
  } finally {
    $("cancelButton").disabled = false;
  }
};
function fillBrief(brief) {
  for (const [key, value] of Object.entries(brief)) {
    if (form.elements[key]) form.elements[key].value = String(value);
  }
  syncRoute();
  estimate();
}
$("reuseButton").onclick = () => {
  if (!current) return;
  fillBrief(current.brief);
  resetImage();
  for(const role of Object.keys(chosenAssets)){chosenAssets[role]=null;document.querySelector(`[data-asset-role="${role}"]`).textContent='请重新选择本地资产或临时上传';}
  toast("已填入历史需求。参考图链接可能过期，请重新上传图片。");
  form.scrollIntoView({ behavior: "smooth", block: "start" });
};
const templates = {
  fashion: {
    product: "轻盈通勤针织开衫",
    selling_points:
      "柔软亲肤面料，简约修身版型，多色可选。适合春秋通勤和日常叠穿。",
    audience: "喜欢简约穿搭的年轻上班族",
    platform: "TikTok Shop",
    style: "自然种草",
    notes: "展示真实穿着效果与面料细节，突出轻松搭配。",
  },
  beauty: {
    product: "温和保湿精华",
    selling_points: "轻盈水润的使用感，简洁包装，适合每日护肤。",
    audience: "重视日常保湿护理的人群",
    platform: "小红书",
    style: "质感广告",
    notes: "干净柔和的画面，突出产品质地，不夸大功效。",
  },
  drink: {
    product: "夏日青柠气泡饮",
    selling_points: "清爽青柠风味，细腻气泡，冰镇饮用更清凉。",
    audience: "喜欢清爽口味的年轻消费者",
    platform: "抖音",
    style: "产品展示",
    notes: "自然光、冰块与气泡特写，带出夏日清爽氛围。",
  },
};
document.querySelectorAll("[data-template]").forEach(
  (button) =>
    (button.onclick = () => {
      fillBrief(templates[button.dataset.template]);
      toast("已填入创作灵感，可继续修改");
    }),
);
$("refreshConfig").onclick = () =>
  loadConfig()
    .then(() => toast("连接配置已刷新"))
    .catch((e) => toast(e.message));
$("refreshHistory").onclick = () =>
  loadHistory().catch((e) => toast(e.message));
(async () => {
  icons();
  renderSteps();
  try {
    const draft = JSON.parse(
      localStorage.getItem("hamster-smart-brief") || "null",
    );
    if (draft) fillBrief(draft);
  } catch {}
  try {
    await loadConfig();
    await loadHistory();
    const id = config.active || localStorage.getItem("hamster-smart-current");
    if (id) await selectJob(id);
  } catch (e) {
    toast(e.message);
  }
  buttons();
  setInterval(() => { if (config.active) loadConfig().catch(() => {}); }, 10000);
})();
