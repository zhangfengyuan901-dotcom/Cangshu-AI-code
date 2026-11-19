import {mountMaterialPreview} from './material-preview.mjs';

const labels = { talent: "达人", product: "产品", scene: "场景" };
const ASSET_BATCH_SIZE = 48;
const ASSET_CACHE_TTL = 5 * 60 * 1000;
const assetCache = new Map();
const assetInflight = new Map();
export function invalidateAssetsCache(base='/api/assets') {
  for(const cache of [assetCache,assetInflight])for(const key of cache.keys())if(key===base||key.startsWith(base+'/'))cache.delete(key);
}
const el = (tag, text, cls) => {
  const node = document.createElement(tag);
  if (text) node.textContent = text;
  if (cls) node.className = cls;
  return node;
};
export function assetsRequest(base, path = "", options = {}) {
  const method=String(options.method || "GET").toUpperCase(),key=base+path;
  if(method!=="GET") {
    invalidateAssetsCache(base);
    return fetchAsset(key,options).finally(()=>invalidateAssetsCache(base));
  }
  const cached=assetCache.get(key);
  if(options.cache!=="reload" && cached && Date.now()-cached.updatedAt<ASSET_CACHE_TTL)return Promise.resolve(cached.data);
  if(assetInflight.has(key))return assetInflight.get(key);
  const pending=fetchAsset(key,options).then(data=>{if(assetInflight.get(key)===pending)assetCache.set(key,{updatedAt:Date.now(),data});return data;}).finally(()=>{if(assetInflight.get(key)===pending)assetInflight.delete(key);});
  assetInflight.set(key,pending);
  return pending;
}
async function fetchAsset(url,options) {
  const response = await fetch(url,options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || data.detail || "资产操作失败");
  return data;
}
export function assetLibrary(
  container,
  { base = "/api/assets", category = "talent", kinds = null, onSelect = null } = {},
) {
  let current = category,
    categories = new Map(),
    itemsById = new Map(),
    filtered = [],
    visibleLimit = ASSET_BATCH_SIZE,
    loadRevision = 0,
    frame = null,
    needsFilter = true,
    composing = false,
    visible = true,
    disposed = false;
  const allowedKinds = Array.isArray(kinds) && kinds.length ? new Set(kinds) : null;
  const previewObserver = typeof IntersectionObserver === "function"
    ? new IntersectionObserver((entries) => {
        if (!visible || disposed) return;
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const media = entry.target;
          media.src = media.dataset.previewSrc;
          delete media.dataset.previewSrc;
          previewObserver.unobserve(media);
        }
      }, { rootMargin: "320px 0px" })
    : null;
  const loadPreview = (media, url) => {
    if (!previewObserver) media.src = url;
    else {
      media.dataset.previewSrc = url;
      previewObserver.observe(media);
    }
  };
  const stopCard = (card) => {
    card.querySelectorAll("[data-preview-src]").forEach((media) => previewObserver?.unobserve(media));
    card.querySelectorAll('audio,video').forEach(media => { if (!media.paused) media.pause(); });
  };
  const removeCard = (card) => {
    stopCard(card);
    card.remove();
  };
  container.replaceChildren();
  container.classList.add("asset-library");
  const tabs = el("div", null, "asset-tabs"),
    toolbar = el("div", null, "asset-toolbar"),
    grid = el("div", null, "asset-grid"),
    status = el("p", null, "asset-status");
  const scrollHost=container.closest('.view,dialog');
  const leading=el('div',null,'asset-spacer'), trailing=el('div',null,'asset-spacer');
  for(const spacer of [leading,trailing])spacer.setAttribute('aria-hidden','true');
  if(onSelect)grid.classList.add('asset-grid-picker');
  const empty=el('p','暂无素材，点击导入或拖入图片、视频、音频。','asset-empty');
  const more=el('button',null,'asset-button asset-more');more.type='button';more.dataset.assetMore='';
  more.onclick=()=>{visibleLimit+=ASSET_BATCH_SIZE;schedule();};
  status.setAttribute("role", "status");
  const search = el("input");
  search.placeholder = "搜索资产名称";
  search.setAttribute("aria-label", "搜索资产名称");
  const upload = el("button", "导入图片 / 视频 / 音频", "asset-button");
  upload.type = "button";
  const input = el("input");
  input.type = "file";
  const accepts = {
    image: "image/png,image/jpeg,image/webp",
    video: "video/mp4,video/webm,video/quicktime",
    audio: "audio/mpeg,audio/wav,audio/mp4,audio/aac",
  };
  input.accept = [...(allowedKinds || new Set(Object.keys(accepts)))].map((kind) => accepts[kind]).filter(Boolean).join(",");
  input.multiple = true;
  input.hidden = true;
  const refresh = el("button", "刷新", "asset-button");
  refresh.type = "button";
  for (const [key, name] of Object.entries(labels)) {
    const b = el("button", name + "资产", "asset-tab");
    b.type = "button";
    b.dataset.category = key;
    b.onclick = () => {
      current = key;
      visibleLimit = ASSET_BATCH_SIZE;
      needsFilter = true;
      schedule();
    };
    tabs.append(b);
  }
  toolbar.append(search, upload, refresh, input);
  container.append(tabs, toolbar, status, grid);
  const mediaPreview=mountMaterialPreview(grid,{selector:'[data-asset-preview]',resolve:button=>{
    const item=itemsById.get(button.closest('[data-asset-id]')?.dataset.assetId);
    if(!item||!visible||disposed)return null;
    return {src:`${base}/${item.id}/file`,name:item.name,kind:item.kind,detail:`${item.kind==='video'?'视频':item.kind==='audio'?'音频':'图片'} · ${(item.size/1024/1024).toFixed(1)} MB`};
  }});
  const schedule = () => {
    if(disposed || !visible || frame!==null)return;
    frame=requestAnimationFrame(()=>{frame=null;render();});
  };
  const onScroll=()=>{if(visibleLimit>2*ASSET_BATCH_SIZE)schedule();};
  scrollHost?.addEventListener('scroll',onScroll,{passive:true});
  const resize=scrollHost&&typeof ResizeObserver==='function'?new ResizeObserver(onScroll):null;
  resize?.observe(scrollHost);
  function windowRange(count) {
    if(!scrollHost || count<=2*ASSET_BATCH_SIZE)return [0,count,0,0];
    const styles=getComputedStyle(grid);
    const cols=Math.max(1,styles.gridTemplateColumns.trim().split(/\s+/).length);
    const gap=parseFloat(styles.rowGap);
    const rowHeight=parseFloat(styles.getPropertyValue('--asset-card-height'))+gap;
    if(!Number.isFinite(rowHeight)||rowHeight<=0)return [0,count,0,0];
    const gridTop=grid.getBoundingClientRect().top, host=scrollHost.getBoundingClientRect();
    const totalRows=Math.ceil(count/cols);
    let first=Math.max(0,Math.min(totalRows-1,Math.floor((host.top-gridTop)/rowHeight)-3));
    let last=Math.min(totalRows,Math.max(first+1,Math.ceil((host.bottom-gridTop)/rowHeight)+3));
    // A focused native control must stay mounted during mouse-wheel scrolling.
    const focused=document.activeElement?.closest('.asset-card');
    if(focused&&grid.contains(focused)){
      const index=filtered.findIndex(item=>item.id===focused.dataset.assetId);
      if(index>=0&&index<count){const row=Math.floor(index/cols);first=Math.min(first,row);last=Math.max(last,row+1);}
    }
    return [first*cols,Math.min(count,last*cols),first?first*rowHeight-gap:0,last<totalRows?(totalRows-last)*rowHeight-gap:0];
  }
  function placeSpacer(spacer,height,first) {
    if(!height){spacer.remove();return;}
    spacer.style.height=`${height}px`;
    if(first){if(grid.firstElementChild!==spacer)grid.prepend(spacer);}
    else if(spacer.parentNode!==grid)grid.append(spacer);
  }
  function render() {
    if(disposed||!visible)return;
    if(needsFilter){
      needsFilter=false;
      tabs.querySelectorAll('button').forEach(b=>b.classList.toggle('active',b.dataset.category===current));
      const query=search.value.toLowerCase();
      const categoryItems=categories.get(current)||[];
      filtered=query?categoryItems.filter(entry=>entry.searchName.includes(query)).map(entry=>entry.item):categoryItems.map(entry=>entry.item);
    }
    const count=Math.min(visibleLimit,filtered.length);
    const [start,end,above,below]=windowRange(count);
    const shown=filtered.slice(start,end);
    placeSpacer(leading,above,true);
    const cards = [...grid.querySelectorAll(":scope > .asset-card")],
      existing = new Map(cards.map((card) => [card.dataset.assetId, card])),
      wanted = new Set(shown.map((item) => item.id));
    for (const card of cards)
      if (!wanted.has(card.dataset.assetId)) removeCard(card);
    for (const [index, item] of shown.entries()) {
      const position=index+(above?1:0);
      const signature = `${item.name}:${item.kind}:${item.size}`;
      let card = existing.get(item.id);
      if (card?._assetSignature === signature) {
        if (grid.children[position] !== card)
          grid.insertBefore(card, grid.children[position] || null);
        continue;
      }
      const next = el("article", null, "asset-card"),
        cover=el('button',null,'asset-preview-cover'),
        media = el(item.kind === "image" ? "img" : item.kind === "audio" ? "span" : "video");
      next.dataset.assetId = item.id;
      next._assetSignature = signature;
      card = next;
      cover.type='button';cover.dataset.assetPreview='';
      cover.setAttribute('aria-label',`预览素材：${item.name}`);cover.title='悬停预览，点击放大';
      if (item.kind === 'audio') {
        media.className='asset-audio-cover';media.textContent='♫';media.setAttribute('aria-hidden','true');
      } else if (item.kind === 'video') {
        media.src = `${base}/${item.id}/file`;
        media.muted = true;
        media.playsInline = true;
        media.preload = "none";
      } else {
        media.alt = item.name;
        media.loading = "lazy";
        media.decoding = "async";
        media.fetchPriority = "low";
        loadPreview(media, `${base}/${item.id}/file`);
      }
      const title = el("strong", item.name);
      title.title = item.name;
      cover.append(media);
      if(item.kind==='video'){const play=el('span','▷','asset-video-play');play.setAttribute('aria-hidden','true');cover.append(play);}
      card.append(
        cover,
        title,
        el(
          "small",
          `${item.kind === "video" ? "视频" : item.kind === "audio" ? "音频" : "图片"} · ${(item.size / 1024 / 1024).toFixed(1)} MB`,
        ),
      );
      if (onSelect) {
        const select = el("button", "使用此资产", "asset-button");
        select.type = "button";
        select.onclick = () => onSelect(item);
        card.append(select);
      }
      const old = existing.get(item.id);
      if (old) {
        stopCard(old);
        old.replaceWith(card);
      }
      else grid.append(card);
      if (grid.children[position] !== card)
        grid.insertBefore(card, grid.children[position] || null);
    }
    placeSpacer(trailing,below,false);
    if(below && trailing.nextElementSibling!==more && more.parentNode===grid)grid.insertBefore(trailing,more);
    if(count)empty.remove();else if(empty.parentNode!==grid)grid.append(empty);
    if(count<filtered.length){
      const label=`显示更多（剩余 ${filtered.length-count} 项）`;
      if(more.textContent!==label)more.textContent=label;
      if(more.parentNode!==grid)grid.append(more);
    }else more.remove();
    mediaPreview.refresh();
  }
  async function load(force = false) {
    if(disposed)return;
    const revision=++loadRevision;
    try {
      if(force || !status.textContent)status.textContent = "正在读取本地资产…";
      const data = await assetsRequest(base,"",force?{cache:"reload"}:{});
      if(disposed||revision!==loadRevision)return;
      categories=new Map();
      itemsById=new Map();
      for(const item of data.items){
        if(allowedKinds&&!allowedKinds.has(item.kind))continue;
        itemsById.set(item.id,item);
        if(!categories.has(item.category))categories.set(item.category,[]);
        categories.get(item.category).push({item,searchName:item.name.toLowerCase()});
      }
      status.textContent = "本地保存：" + data.root;
      needsFilter=true;schedule();
    } catch (e) {
      if(!disposed&&revision===loadRevision)status.textContent = e.message;
    }
  }
  async function importFiles(files) {
    if(upload.disabled)return;
    const targetCategory = current;
    upload.disabled = true;
    try {
      for (const file of files) {
        if (file.size > 50 * 1024 * 1024)
          throw new Error("单个素材最大支持50MB");
        status.textContent = "正在保存：" + file.name;
        await assetsRequest(
          base,
          `/import?category=${targetCategory}&name=${encodeURIComponent(file.name)}`,
          {
            method: "POST",
            headers: {
              "Content-Type": file.type || "application/octet-stream",
            },
            body: file,
          },
        );
      }
      await load(true);
    } catch (e) {
      await load(true);
      status.textContent = e.message;
    } finally {
      upload.disabled = false;
      input.value = "";
    }
  }
  upload.onclick = () => input.click();
  input.onchange = () => importFiles(Array.from(input.files));
  refresh.onclick = () => load(true);
  const searchChanged = () => {
    visibleLimit = ASSET_BATCH_SIZE;
    needsFilter=true;schedule();
  };
  search.oninput=event=>{if(!composing&&!event.isComposing)searchChanged();};
  search.addEventListener('compositionstart',()=>{composing=true;});
  search.addEventListener('compositionend',()=>{composing=false;searchChanged();});
  container.ondragover = (e) => {
    e.preventDefault();
    container.classList.add("asset-drag");
  };
  container.ondragleave = () => container.classList.remove("asset-drag");
  container.ondrop = (e) => {
    e.preventDefault();
    container.classList.remove("asset-drag");
    importFiles(Array.from(e.dataTransfer.files));
  };
  load();
  return {
    refresh:load,
    setVisible(value){
      if(disposed||visible===value)return;
      visible=value;
      if(visible){
        for(const media of grid.querySelectorAll('[data-preview-src]'))previewObserver?.observe(media);
        void load();
        schedule();
      }else {mediaPreview.close();for(const card of grid.querySelectorAll('.asset-card'))stopCard(card);}
    },
    dispose(){
      if(disposed)return;
      disposed=true;
      if(frame!==null)cancelAnimationFrame(frame);
      scrollHost?.removeEventListener('scroll',onScroll);
      resize?.disconnect();previewObserver?.disconnect();
      mediaPreview.destroy();
      for(const card of grid.querySelectorAll('.asset-card'))stopCard(card);
      container.ondragover=container.ondragleave=container.ondrop=null;
    },
  };
}
export function pickAsset(options = {}) {
  return new Promise((resolve) => {
    const dialog = el("dialog", null, "asset-dialog"),
      head = el("div", null, "asset-dialog-head"),
      body = el("div"),
      close = el("button", "关闭", "asset-button");
    let library;
    const finish = (value) => {
      library?.dispose();
      dialog.close();
      dialog.remove();
      resolve(value);
    };
    close.onclick = () => finish(null);
    head.append(el("h2", "从资产库选择"), close);
    dialog.append(head, body);
    document.body.append(dialog);
    dialog.oncancel = (e) => {
      e.preventDefault();
      finish(null);
    };
    library=assetLibrary(body, { ...options, onSelect: (item) => finish(item) });
    dialog.showModal();
  });
}
export function chooseAssetCategory() {
  return new Promise((resolve) => {
    const dialog = el("dialog", null, "asset-dialog compact");
    dialog.append(el("h2", "收入哪个资产库？"));
    const finish = (value) => {
      dialog.close();
      dialog.remove();
      resolve(value);
    };
    for (const [key, name] of Object.entries(labels)) {
      const b = el("button", name + "资产库", "asset-button");
      b.onclick = () => finish(key);
      dialog.append(b);
    }
    const cancel = el("button", "取消", "asset-button");
    cancel.onclick = () => finish(null);
    dialog.append(cancel);
    dialog.oncancel = (e) => {
      e.preventDefault();
      finish(null);
    };
    document.body.append(dialog);
    dialog.showModal();
  });
}
