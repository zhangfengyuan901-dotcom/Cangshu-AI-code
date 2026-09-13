const labels = { talent: "达人", product: "产品", scene: "场景" };
const el = (tag, text, cls) => {
  const node = document.createElement(tag);
  if (text) node.textContent = text;
  if (cls) node.className = cls;
  return node;
};
export async function assetsRequest(base, path = "", options = {}) {
  const response = await fetch(base + path, options);
  const data = await response.json();
  if (!response.ok)
    throw new Error(data.error || data.detail || "资产操作失败");
  return data;
}
export function assetLibrary(
  container,
  { base = "/api/assets", category = "talent", onSelect = null } = {},
) {
  let current = category,
    items = [];
  container.replaceChildren();
  container.classList.add("asset-library");
  const tabs = el("div", null, "asset-tabs"),
    toolbar = el("div", null, "asset-toolbar"),
    grid = el("div", null, "asset-grid"),
    status = el("p", null, "asset-status");
  status.setAttribute("role", "status");
  const search = el("input");
  search.placeholder = "搜索资产名称";
  search.setAttribute("aria-label", "搜索资产名称");
  const upload = el("button", "导入图片 / 视频", "asset-button");
  upload.type = "button";
  const input = el("input");
  input.type = "file";
  input.accept =
    "image/png,image/jpeg,image/webp,video/mp4,video/webm,video/quicktime";
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
      render();
    };
    tabs.append(b);
  }
  toolbar.append(search, upload, refresh, input);
  container.append(tabs, toolbar, status, grid);
  function render() {
    tabs
      .querySelectorAll("button")
      .forEach((b) =>
        b.classList.toggle("active", b.dataset.category === current),
      );
    grid.replaceChildren();
    const filtered = items.filter(
      (x) =>
        x.category === current &&
        x.name.toLowerCase().includes(search.value.toLowerCase()),
    );
    if (!filtered.length)
      grid.append(
        el("p", "暂无素材，点击导入或拖入图片、视频。", "asset-empty"),
      );
    for (const item of filtered) {
      const card = el("article", null, "asset-card"),
        media = el(item.kind === "video" ? "video" : "img");
      media.src = `${base}/${item.id}/file`;
      if (item.kind === "video") {
        media.controls = true;
        media.preload = "metadata";
      } else {
        media.alt = item.name;
        media.loading = "lazy";
      }
      const title = el("strong", item.name);
      title.title = item.name;
      card.append(
        media,
        title,
        el(
          "small",
          `${item.kind === "video" ? "视频" : "图片"} · ${(item.size / 1024 / 1024).toFixed(1)} MB`,
        ),
      );
      if (onSelect) {
        const select = el("button", "使用此资产", "asset-button");
        select.type = "button";
        select.onclick = () => onSelect(item);
        card.append(select);
      }
      grid.append(card);
    }
  }
  async function load() {
    try {
      status.textContent = "正在读取本地资产…";
      const data = await assetsRequest(base);
      items = data.items;
      status.textContent = "本地保存：" + data.root;
      render();
    } catch (e) {
      status.textContent = e.message;
    }
  }
  async function importFiles(files) {
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
      await load();
    } catch (e) {
      await load();
      status.textContent = e.message;
    } finally {
      upload.disabled = false;
      input.value = "";
    }
  }
  upload.onclick = () => input.click();
  input.onchange = () => importFiles(Array.from(input.files));
  refresh.onclick = load;
  search.oninput = render;
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
  return { refresh: load };
}
export function pickAsset(options = {}) {
  return new Promise((resolve) => {
    const dialog = el("dialog", null, "asset-dialog"),
      head = el("div", null, "asset-dialog-head"),
      body = el("div"),
      close = el("button", "关闭", "asset-button");
    const finish = (value) => {
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
    assetLibrary(body, { ...options, onSelect: (item) => finish(item) });
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
