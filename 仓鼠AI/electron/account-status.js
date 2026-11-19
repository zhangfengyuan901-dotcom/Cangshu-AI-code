'use strict';
if (new URLSearchParams(window.location.search).get('state') === 'failed') {
  document.body.classList.add('failed');
  document.getElementById('title').textContent = '暂时无法打开账户页面';
  document.getElementById('message').textContent = '请检查网络连接，关闭此窗口后重试。';
  document.getElementById('hint').textContent = '本次打开窗口不代表登录或充值成功。';
}
