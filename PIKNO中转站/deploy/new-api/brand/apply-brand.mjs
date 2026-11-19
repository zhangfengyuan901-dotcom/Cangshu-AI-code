import { readFile, writeFile, copyFile } from "node:fs/promises";

const mainPath = new URL("../src/main.tsx", import.meta.url);
const indexPath = new URL("../index.html", import.meta.url);
const zhPath = new URL("../src/i18n/locales/zh.json", import.meta.url);
const constantsPath = new URL('../src/lib/constants.ts', import.meta.url);
const systemBrandPath = new URL('../src/components/layout/components/system-brand.tsx', import.meta.url);

// The configured PIKNO logo is also the local image fallback.
await copyFile(new URL('../public/pikno-logo.png', import.meta.url), new URL('../public/logo.png', import.meta.url));

// Keep first-paint and offline fallbacks on-brand while retaining the upstream
// attribution on the dedicated About page.
const constants = await readFile(constantsPath, 'utf8');
await writeFile(
  constantsPath,
  constants
    .replace("export const DEFAULT_SYSTEM_NAME = 'New API'", "export const DEFAULT_SYSTEM_NAME = 'PIKNO AI'")
    .replace("export const DEFAULT_LOGO = '/logo.png'", "export const DEFAULT_LOGO = '/pikno-logo.png'"),
);

const systemBrand = await readFile(systemBrandPath, 'utf8');
await writeFile(
  systemBrandPath,
  systemBrand.replace("status?.system_name || props.defaultName || 'New API'", "status?.system_name || props.defaultName || 'PIKNO AI'"),
);

const main = await readFile(mainPath, "utf8");
const stylesheetImport = "import './styles/pikno-brand.css'";
if (!main.includes(stylesheetImport)) {
  const anchor = "import './styles/index.css'";
  if (!main.includes(anchor)) throw new Error("Unable to find the main stylesheet import");
  await writeFile(mainPath, main.replace(anchor, `${anchor}\n${stylesheetImport}`));
}

const index = await readFile(indexPath, "utf8");
await writeFile(
  indexPath,
  index
    .replaceAll("<title>New API</title>", "<title>PIKNO AI</title>")
    .replaceAll('content="New API"', 'content="PIKNO AI"')
    .replace('<meta charset="UTF-8" />', '<meta charset="UTF-8" />\n    <link rel="icon" type="image/png" href="/pikno-logo.png" />')
    .replace(
      'content="Unified AI API gateway and admin dashboard."',
      'content="PIKNO AI 统一模型接入与用量管理平台。"',
    ),
);

const zh = JSON.parse(await readFile(zhPath, "utf8"));
if (!zh.translation || typeof zh.translation !== "object") {
  throw new Error("Unable to find the Simplified Chinese translation table");
}
Object.assign(zh.translation, {
  "About PIKNO": "关于 PIKNO",
  "Open-source notices": "开源声明",
  "PIKNO brings image, video, and general-purpose models together through a unified API.": "PIKNO 通过统一 API 连接图片、视频与通用模型，让创作与调用更简单。",
  "PIKNO customizes the interface of New API. Brand and layout changes were made on 2026-10-05.": "PIKNO 基于 New API 定制界面，品牌与布局修改于 2026-10-05。",
  "Original project": "原始项目",
  "License and notices": "许可证与声明",
  "This software is provided without warranty under the GNU AGPL v3. You may redistribute and modify it under that license.": "本软件依 GNU AGPL v3 提供，不附带担保；你可以按该许可证的条款再分发和修改。",
  "One gateway. Every creative possibility.": "一个入口，连接每一种创作可能。",
  "A unified API for image, video, and general-purpose models. Clear pricing, stable routing, and usage records you can review at any time.":
    "为图片、视频与通用模型提供统一 API。清晰计价，稳定转发，调用记录随时可查。",
  "Sign in": "登录控制台",
  "Unified endpoint": "统一端点",
  "Usage-based billing": "按量计费",
  "Live usage records": "实时用量",
  "One API": "一个 API",
  "A consistent request format across supported model services.":
    "用一致的请求格式接入已支持的模型服务。",
  "Clear pricing": "清晰计价",
  "Review model prices and usage before scaling your workflow.":
    "在扩大调用前，先看清模型价格与实际用量。",
  "Operational control": "可控运营",
  "Tokens, permissions, and request records stay in one place.":
    "令牌、权限与调用记录集中管理，状态一目了然。",
  "Create beyond imagination.": "用创意，连接更大的可能。",
});
await writeFile(zhPath, `${JSON.stringify(zh, null, 2)}\n`);

// Relocate the visible upstream attribution to the linked About page.
const footerPath = new URL('../src/components/layout/components/footer.tsx', import.meta.url);
let footer = await readFile(footerPath, 'utf8');
footer = footer.replace("systemName || props.name || 'New API'", "systemName || props.name || 'PIKNO AI'");
if (!footer.includes('function AboutPiknoLink()')) {
  const start = footer.indexOf('const NEW_API_FOOTER_ATTRIBUTION_KEY');
  const end = footer.indexOf('function FooterLinkItem', start);
  const attributionStart = footer.indexOf('function ProjectAttribution(');
  const attributionEnd = footer.indexOf('export function Footer', attributionStart);
  if ([start, end, attributionStart, attributionEnd].some((value) => value < 0)) {
    throw new Error('Unable to locate the upstream footer attribution');
  }
  footer = footer.slice(0, attributionStart) + `function AboutPiknoLink() {
  const { t } = useTranslation()
  return <Link to='/about' className='pikno-about-link'>{t('About PIKNO')}</Link>
}

` + footer.slice(attributionEnd);
  footer = footer.slice(0, start) + footer.slice(end);
  footer = footer.replace(/<ProjectAttribution currentYear=\{currentYear\}(?: inline)? \/>/g, '<AboutPiknoLink />');
  footer = footer.replace('displayColumns.map((column, index)', 'displayColumns.map((column)')
    .replace('<div key={index}>', '<div key={column.title}>')
    .replace('column.links.map((link, linkIndex)', 'column.links.map((link)')
    .replace('<li key={linkIndex}>', '<li key={link.href}>');
  await writeFile(footerPath, footer);
}

const navPath = new URL('../src/hooks/use-top-nav-links.ts', import.meta.url);
const nav = await readFile(navPath, 'utf8');
await writeFile(navPath, nav.replace(/  \/\/ About\r?\n  if \(modules\?\.about !== false\) \{\r?\n    links.push\(\{ title: t\('About'\), href: '\/about' \}\)\r?\n  \}/, '  // About PIKNO is available in the footer.'));

// PIKNO does not expose the built-in Playground. Remove its onboarding link
// as well as the sidebar entry controlled by the production configuration.
const overviewDashboardPath = new URL('../src/features/dashboard/components/overview/overview-dashboard.tsx', import.meta.url);
const overviewDashboard = await readFile(overviewDashboardPath, 'utf8');
const playgroundStep = `      {
        title: t('Send a request'),
        description: t('Verify routing with Playground or your client'),
        to: '/playground',
        icon: TerminalSquare,
        completed: requestCount > 0,
      },
`;
if (!overviewDashboard.includes(playgroundStep)) {
  throw new Error('Unable to find the Playground onboarding step');
}
await writeFile(
  overviewDashboardPath,
  overviewDashboard.replace(playgroundStep, ''),
);

// Keep the existing attribution reachable from the new registration entry too.
const authLayoutPath = new URL('../src/features/auth/auth-layout.tsx', import.meta.url);
let authLayout = await readFile(authLayoutPath, 'utf8');
if (!authLayout.includes('pikno-auth-notices')) {
  authLayout = authLayout.replace("relative grid h-svh max-w-none", "relative grid min-h-svh max-w-none");
  authLayout = authLayout.replace('{children}', `{children}
          <div className='pikno-auth-notices pt-6 text-center text-xs text-muted-foreground'>
            <Link to='/about' className='underline underline-offset-4'>{t('Open-source notices')}</Link>
          </div>`);
  await writeFile(authLayoutPath, authLayout);
}
