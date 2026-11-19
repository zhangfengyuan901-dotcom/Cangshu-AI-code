import { liteEntryDestination } from "./lib/lite-entry";
import { portalPage } from "./features/portal/route";

// Public account routes do not import the administration application.
const destination = liteEntryDestination(window.location.href);
if (portalPage(window.location.pathname)) {
  void import("./features/portal/entry").catch(() => {
    const root = document.querySelector("#root");
    if (root) root.textContent = "页面加载失败，请刷新重试。";
  });
} else if (destination) {
  window.location.replace(destination);
} else {
  void import("./app").catch(() => {
    const root = document.querySelector("#root");
    if (root) root.textContent = "页面加载失败，请刷新重试。";
  });
}
