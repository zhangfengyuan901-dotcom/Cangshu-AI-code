import ReactDOM from "react-dom/client";
import { TooltipProvider } from "@/components/ui/tooltip";
import { i18nReady } from "@/i18n/config";
import { PortalApp } from "./app";
import "@/styles/index.css";
import "@/styles/portal.css";

void Promise.resolve(i18nReady).then(() => {
  const root = document.querySelector("#root");
  if (root) {
    ReactDOM.createRoot(root).render(
      <TooltipProvider>
        <PortalApp />
      </TooltipProvider>,
    );
  }
});
