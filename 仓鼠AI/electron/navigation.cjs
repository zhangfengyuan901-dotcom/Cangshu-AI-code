const EXTERNAL_ORIGINS = new Set(['https://www.piknoai.com']);

function parseUrl(value) {
  try {
    const target = new URL(value);
    return target.username || target.password ? null : target;
  } catch { return null; }
}

function localPage(value) {
  const target = parseUrl(value);
  return target?.protocol === 'http:' && target.hostname === '127.0.0.1'
    && /^\d+$/.test(target.port) && Number(target.port) >= 1024 && Number(target.port) <= 65535;
}

// Self-owned pages stay in the existing window. Only explicit approved external
// links may use the OS browser; renderer code cannot create another app window.
function installNavigationPolicy(contents, {appUrl, openExternal}) {
  if (!localPage(appUrl)) throw Error('Invalid local application URL');
  const appOrigin = new URL(appUrl).origin;
  const allowed = (value, mainFrame) => localPage(value)
    && (!mainFrame || new URL(value).origin === appOrigin);
  contents.setWindowOpenHandler(({url}) => {
    const target = parseUrl(url);
    if (target && EXTERNAL_ORIGINS.has(target.origin)) {
      Promise.resolve().then(() => openExternal(target.href)).catch(() => {});
    }
    return {action:'deny'};
  });
  contents.on('will-frame-navigate', event => {
    if (!allowed(event.url, event.isMainFrame !== false)) event.preventDefault();
  });
  contents.on('will-redirect', (event, url, _inPlace, isMainFrame) => {
    if (!allowed(event.url ?? url, (event.isMainFrame ?? isMainFrame) !== false)) event.preventDefault();
  });
}

module.exports = {installNavigationPolicy};
