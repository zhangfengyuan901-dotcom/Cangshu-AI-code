document.documentElement.classList.add("js");
const observer = new IntersectionObserver(
  (entries) => {
    for (const entry of entries)
      if (entry.isIntersecting) {
        entry.target.classList.add("visible");
        observer.unobserve(entry.target);
      }
  },
  { threshold: 0.12 },
);
document.querySelectorAll(".reveal").forEach((item) => observer.observe(item));

const caseDialog = document.querySelector(".case-dialog");
const caseDialogImage = caseDialog?.querySelector("img");

document.querySelectorAll("[data-case]").forEach((card) => {
  card.addEventListener("click", () => {
    if (!caseDialog || !caseDialogImage) return;
    caseDialogImage.src = card.dataset.case;
    caseDialogImage.alt = card.querySelector("img")?.alt || "仓鼠AI创作案例";
    caseDialog.showModal();
  });
});

caseDialog?.querySelector(".dialog-close")?.addEventListener("click", () => {
  caseDialog.close();
});

caseDialog?.addEventListener("click", (event) => {
  if (event.target === caseDialog) caseDialog.close();
});

const videoCaseDialog = document.querySelector(".video-case-dialog");
const videoCasePlayer = videoCaseDialog?.querySelector("video");
document.querySelectorAll("[data-video]").forEach((card) => {
  card.addEventListener("click", () => {
    if (!videoCaseDialog || !videoCasePlayer) return;
    videoCaseDialog.querySelector(".video-case-dialog-title").textContent = card.dataset.title;
    videoCasePlayer.src = card.dataset.video;
    videoCasePlayer.poster = card.querySelector("img")?.src || "";
    videoCaseDialog.showModal();
    videoCasePlayer.play().catch(() => {});
  });
});

videoCaseDialog?.querySelector(".dialog-close")?.addEventListener("click", () => {
  videoCaseDialog.close();
});
videoCaseDialog?.addEventListener("click", (event) => {
  if (event.target === videoCaseDialog) videoCaseDialog.close();
});
videoCaseDialog?.addEventListener("close", () => {
  videoCasePlayer.pause();
  videoCasePlayer.removeAttribute("src");
  videoCasePlayer.load();
});

document.querySelectorAll("[data-copy-prompt]").forEach((button) => {
  button.addEventListener("click", async () => {
    const prompt = document.getElementById(button.dataset.copyPrompt)?.textContent?.trim();
    const status = button.parentElement.querySelector(".tutorial-copy-status");
    if (!prompt || !status) return;
    try {
      await navigator.clipboard.writeText(prompt);
      status.textContent = "已复制，可粘贴到图片生成";
    } catch {
      status.textContent = "复制失败，请手动选择下方文字";
    }
  });
});
