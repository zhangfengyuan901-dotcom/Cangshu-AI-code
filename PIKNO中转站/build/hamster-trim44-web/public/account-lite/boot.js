// Classic entry: still displays a useful message when modules cannot be loaded.
(function () {
  'use strict';
  var tag = document.currentScript;
  var notice = document.getElementById('boot-status');
  var entries = { account: '/account-lite/account.mjs', auth: '/auth-lite/auth.mjs' };
  var entry = tag && tag.getAttribute('data-entry');
  function failed(message) {
    if (notice) { notice.hidden = false; notice.textContent = message; notice.setAttribute('role', 'alert'); }
  }
  var probe = document.createElement('script');
  if (!('noModule' in probe) || window.isSecureContext === false || !window.fetch || !window.Promise || !window.URL || !window.AbortController || !window.crypto || !window.crypto.getRandomValues) {
    failed('浏览器缺少必要的安全能力，请使用更新的 Chrome、Edge、Firefox 或 Safari。'); return;
  }
  if (entry !== 'account' && entry !== 'auth') { failed('页面未就绪，请刷新后重试。'); return; }
  var ready = false;
  function initialized() {
    ready = true; window.removeEventListener('hamster-lite-ready', initialized);
    if (notice) notice.hidden = true;
  }
  window.addEventListener('hamster-lite-ready', initialized);
  var script = document.createElement('script'); script.type = 'module'; script.src = entries[entry];
  script.addEventListener('load', function () { if (!ready) failed('页面初始化未完成，请刷新后重试或更新浏览器。'); });
  script.addEventListener('error', function () { failed('页面资源加载失败，请检查网络并刷新；若仍无法打开，请更新浏览器。'); });
  document.head.appendChild(script);
}());
