import { pickAsset } from "/shared/asset-library.mjs";
const $ = (s) => document.querySelector(s);
const make = (tag, text, cls) => {
  const n = document.createElement(tag);
  if (text) n.textContent = text;
  if (cls) n.className = cls;
  return n;
};
let current = null,
  history = [],
  pending = [],
  uploading = false,
  submitting = false,
  ready = false,
  toastTimer,
  dragDepth = 0,
  mentionOpen = false,
  selection = 0;
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
function draft() {
  if (current)
    safeWrite(
      "hamster-chat-draft-" + current.id,
      JSON.stringify({ text: $("#input").value, pending }),
    );
}
function controls() {
  const busy = current?.status === "running";
  $("#send").hidden = !!busy;
  $("#stop").hidden = !busy;
  $("#send").disabled =
    !ready ||
    uploading ||
    submitting ||
    (!$("#input").value.trim() && !pending.length);
  ["#upload", "#asset", "#welcomeAsset"].forEach(
    (s) => ($(s).disabled = uploading || submitting || busy),
  );
  $("#newChat").disabled = uploading || submitting;
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
async function refreshHistory() {
  history = await api("/sessions");
  list();
}
async function select(id) {
  if (uploading || submitting) return;
  draft();
  const token = ++selection;
  const item = await api("/sessions/" + id);
  if (selection !== token) return;
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
  $("#sidebar").classList.remove("open");
  render(true);
  list();
}
async function ensureSession() {
  if (current) return;
  current = await api("/sessions", { method: "POST" });
  safeWrite("hamster-chat-current", current.id);
  await refreshHistory();
}
function fileCard(media, removable = false) {
  const card = make("div", "", "file-card");
  const url = `/chat-api/sessions/${current.id}/media/${media.id}`;
  if (media.kind === "image") {
    const img = make("img");
    img.src = url;
    img.alt = media.name;
    card.append(img);
  } else
    card.append(make("span", media.kind === "video" ? "▷" : "▤", "file-icon"));
  const link = make("a");
  link.href = url;
  link.target = "_blank";
  link.rel = "noopener";
  link.append(
    make("b", media.name),
    make(
      "small",
      `${media.label} · ${(media.size / 1024 / 1024).toFixed(1)} MB`,
    ),
  );
  card.append(link);
  const action = make("button", removable ? "×" : "引用");
  action.type = "button";
  action.title = removable ? "移除本轮附件" : "再次引用此素材";
  action.disabled = uploading || submitting || current.status === "running";
  action.onclick = () => {
    if (removable) pending = pending.filter((x) => x !== media.id);
    else {
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
  $("#attachments").replaceChildren(
    ...pending
      .map((id) => current?.media.find((x) => x.id === id))
      .filter(Boolean)
      .map((m) => fileCard(m, true)),
  );
}
function richText(container, text) {
  // Render a small Markdown subset using text nodes only. No raw HTML or remote embeds.
  const blocks = text.split(/```/);
  blocks.forEach((block, index) => {
    if (index % 2) {
      container.append(make("pre", block.replace(/^\w+\n/, "")));
      return;
    }
    block
      .split(/(\*\*[^*]+\*\*)/g)
      .forEach((part) =>
        container.append(
          part.startsWith("**") && part.endsWith("**")
            ? make("strong", part.slice(2, -2))
            : document.createTextNode(part),
        ),
      );
  });
}
function render(scroll = false) {
  const area = $("#scrollArea"),
    nearBottom = area.scrollHeight - area.scrollTop - area.clientHeight < 100;
  $("#welcome").hidden = !!current?.messages.length;
  const target = $("#messages");
  // Keep nodes stable while polling so selection, previews and scrolling are not reset.
  if (target.dataset.session !== current?.id) {
    target.replaceChildren();
    target.dataset.session = current?.id || "";
  }
  for (const msg of current?.messages || []) {
    let section = document.getElementById("message-" + msg.id);
    if (
      section?.dataset.text === msg.text &&
      section.dataset.status === msg.status
    )
      continue;
    const fresh = !section;
    if (fresh) {
      section = make("article", "", "message " + msg.role);
      section.id = "message-" + msg.id;
    }
    section.replaceChildren();
    section.dataset.text = msg.text;
    section.dataset.status = msg.status;
    if (msg.role === "assistant") {
      const label = make("div", "", "assistant-label"),
        img = make("img");
      img.src = "/hamster-logo.png";
      img.alt = "";
      label.append(img, make("span", "仓鼠AI智能体"));
      section.append(label);
    }
    if (msg.attachments.length) {
      const attachments = make("div", "", "message-attachments");
      for (const id of msg.attachments) {
        const media = current.media.find((x) => x.id === id);
        if (media) attachments.append(fileCard(media));
      }
      section.append(attachments);
    }
    const body = make("div", "", "message-body");
    if (msg.role === "assistant") richText(body, msg.text);
    else body.textContent = msg.text;
    if (msg.status === "running") {
      body.textContent = "正在生成完整回答，审查后展示…";
      body.classList.add("blink");
    }
    section.append(body);
    if (msg.role === "assistant" && msg.status !== "running") {
      const actions = make("div", "", "message-actions"),
        copy = make("button", "复制");
      copy.onclick = async () => {
        try {
          await navigator.clipboard.writeText(msg.text);
          toast("已复制回答");
        } catch {
          toast("复制失败，请选择文字后复制。");
        }
      };
      if (msg.text) actions.append(copy);
      if (["failed", "cancelled", "interrupted"].includes(msg.status)) {
        actions.append(make("span", "本次回答未完成", "error-note"));
        if (msg.id === current.messages.at(-1).id) {
          const retry = make("button", "重新请求");
          retry.onclick = () => send(true);
          actions.append(retry);
        }
      }
      section.append(actions);
    }
    if (fresh) target.append(section);
  }
  $("#notice").hidden = !current?.notice;
  $("#notice").textContent = current?.notice || "";
  $("#taskStatus").hidden = !current?.stage;
  $("#taskStatus").textContent = current?.stage || "";
  $("#taskStatus").classList.toggle("running", current?.status === "running");
  renderAttachments();
  controls();
  if (!current?.messages.length) area.scrollTop = 0;
  else if (scroll || nearBottom) area.scrollTop = area.scrollHeight;
}
async function send(retry = false) {
  if (uploading || submitting || current?.status === "running") return;
  submitting = true;
  controls();
  try {
    await ensureSession();
    const id = current.id;
    const payload = {
      request_id: crypto.randomUUID(),
      parent: current.messages.at(-1)?.id || "",
      text: $("#input").value,
      attachments: pending,
    };
    current = await api(
      `/sessions/${id}/${retry ? "retry" : "messages"}`,
      json("POST", payload),
    );
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
        current = await api("/sessions/" + current.id);
        render();
      } catch {}
    }
  } finally {
    submitting = false;
    controls();
  }
}
async function uploadFiles(files) {
  if (uploading || submitting || current?.status === "running")
    return toast("请等待当前操作结束。");
  if (pending.length + files.length > 6) return toast("每轮最多6份附件。");
  uploading = true;
  controls();
  try {
    await ensureSession();
    for (const file of files) {
      if (file.size > 50 * 1024 * 1024) {
        toast(file.name + " 超过50MB，未添加。");
        continue;
      }
      $("#taskStatus").hidden = false;
      $("#taskStatus").textContent = "正在保存到本地：" + file.name;
      const media = await api(
        `/sessions/${current.id}/media?name=${encodeURIComponent(file.name)}`,
        { method: "POST", body: file },
      );
      current.media.push(media);
      pending.push(media.id);
      draft();
      renderAttachments();
    }
    toast("素材已就绪，发送后开始云端理解。");
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
    const asset = await pickAsset({ base: "/studio-api/assets" });
    if (!asset) return;
    uploading = true;
    controls();
    await ensureSession();
    const media = await api(`/sessions/${current.id}/assets/${asset.id}`, {
      method: "POST",
    });
    current.media.push(media);
    pending.push(media.id);
    $("#input").value = $("#input").value.replace(/@$/, "") + media.label + " ";
    draft();
    render();
    $("#input").focus();
    toast("已加入资产副本，不会修改资产库原文件。");
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
$("#stop").onclick = async () => {
  if (!current) return;
  const id = current.id;
  try {
    const item = await api(`/sessions/${id}/stop`, { method: "POST" });
    if (current?.id === id) {
      current = item;
      render();
    }
  } catch (e) {
    toast(e.message);
  }
};
$("#newChat").onclick = () => {
  draft();
  selection++;
  current = null;
  pending = [];
  $("#input").value = "";
  safeWrite("hamster-chat-current", "");
  render();
  list();
  $("#input").focus();
};
$("#search").oninput = list;
$("#toggleSidebar").onclick = () => $("#sidebar").classList.toggle("open");
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
let pollCount = 0;
async function poll() {
  try {
    if (current && !submitting && !uploading) {
      const id = current.id,
        token = selection,
        item = await api("/sessions/" + id);
      if (
        current?.id === id &&
        token === selection &&
        !submitting &&
        !uploading
      ) {
        current = item;
        render();
      }
    }
    if (++pollCount % 5 === 0) {
      const config = await api("/config");
      ready = config.ready;
      $("#connection").textContent = ready
        ? "● 智能服务已配置"
        : "请在账户页配置智能密钥";
      await refreshHistory();
      controls();
    }
  } catch {
    $("#connection").textContent = "本地连接中断，正在重连";
  }
  setTimeout(poll, current?.status === "running" ? 500 : 2000);
}
async function init() {
  try {
    const config = await api("/config");
    ready = config.ready;
    $("#connection").textContent = ready
      ? "● 智能服务已配置"
      : "请在账户页配置智能密钥";
    await refreshHistory();
    const id = safeRead("hamster-chat-current");
    if (history.some((x) => x.id === id)) await select(id);
  } catch (e) {
    toast(e.message);
  }
  render();
  poll();
}
init();
