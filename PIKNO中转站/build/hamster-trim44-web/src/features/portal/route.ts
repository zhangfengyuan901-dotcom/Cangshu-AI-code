export type PortalPage = "home" | "models" | "pricing" | "docs" | "dashboard";

export function portalPage(pathname: string): PortalPage | undefined {
  const path = pathname.replace(/\/+$/, "") || "/";
  if (path === "/") return "home";
  if (path === "/hub" || path === "/hub/models" || path === "/models") return "models";
  if (path === "/hub/pricing" || path === "/pricing") return "pricing";
  if (path === "/hub/docs") return "docs";
  if (["/hub/dashboard", "/hub/keys", "/hub/usage", "/hub/billing"].includes(path)) {
    return "dashboard";
  }
}

export function accountPanel(pathname: string): "balance" | "keys" | "usage" | "topup" {
  if (pathname.replace(/\/+$/, "") === "/hub/keys") return "keys";
  if (pathname.replace(/\/+$/, "") === "/hub/usage") return "usage";
  if (pathname.replace(/\/+$/, "") === "/hub/billing") return "topup";
  return "balance";
}
