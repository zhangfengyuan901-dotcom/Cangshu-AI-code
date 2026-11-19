async (page) => {
  const base = 'http://127.0.0.1:11149', forbidden = [];
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin === base && !/^\/(?:pay\/|api\/user\/(?:pay|amount|topup\/(?:info|checkout))$)/.test(url.pathname)) return route.continue();
    forbidden.push(url.pathname);
    return route.abort();
  });
  await page.goto(base + '/account-lite/index.html');
  await page.getByText('¥128.50', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'API Key', exact: true }).click();
  await page.getByRole('button', { name: '开通 API Key', exact: true }).click();
  await page.getByRole('textbox', { name: '名称', exact: true }).fill('离线验收对话');
  await page.getByRole('combobox', { name: '用途', exact: true }).selectOption('chat-standard');
  await page.getByRole('spinbutton', { name: 'Key 消费上限（元）', exact: true }).fill('50');
  await page.getByRole('button', { name: '确认开通', exact: true }).click();
  await page.getByText(/离线验收对话 ·/).first().waitFor();
  await page.getByRole('button', { name: '查看 Key', exact: true }).first().click();
  await page.getByRole('textbox', { name: /的完整 Key/ }).waitFor();
  await page.getByRole('button', { name: '账户余额', exact: true }).click();
  if (await page.getByRole('textbox', { name: /的完整 Key/ }).count()) throw new Error('Key was not removed');
  await page.getByRole('button', { name: '消费记录', exact: true }).click();
  await page.locator('#usage-list').getByText('我的图片工作台', { exact: false }).waitFor();
  await page.getByRole('combobox', { name: '记录类型', exact: true }).selectOption('settlements');
  await page.getByText('待核对', { exact: true }).waitFor();
  await page.locator('[data-tab="topup"]').click();
  await page.getByRole('heading', { name: '添加管理员充值' }).waitFor();
  const account = page.locator('#manual-recharge-account');
  await account.waitFor();
  if (!(await account.textContent()).includes('用户 ID')) throw Error('Recharge account identity is missing');
  await page.route('**/api/user/self', route => route.fulfill({ json: { success: true, data: { id: 12, quota: 178500000, used_quota: 21500000, request_count: 48 } } }));
  await page.getByRole('button', { name: '刷新余额与记录', exact: true }).click();
  await page.waitForFunction(() => document.getElementById('balance-value').textContent === '¥178.50');
  await page.getByRole('button', { name: '账户余额', exact: true }).click();
  await page.getByText('¥178.50', { exact: true }).waitFor();
  await page.locator('[data-go="topup"]').click();
  await page.getByRole('heading', { name: '添加管理员充值' }).waitFor();
  const qr = page.getByRole('img', { name: '添加充值管理员的微信二维码' });
  const layouts = [];
  for (const width of [1200, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await qr.waitFor();
    await qr.evaluate(image => image.decode());
    const fit = await qr.evaluate(image => {
      const bounds = image.getBoundingClientRect();
      return {
        viewport: innerWidth, document: document.documentElement.scrollWidth,
        qrFits: bounds.width > 0 && bounds.height > 0 && bounds.left >= 0 && bounds.right <= innerWidth,
        naturalWidth: image.naturalWidth, naturalHeight: image.naturalHeight,
        sameOrigin: new URL(image.currentSrc).origin === location.origin,
        react: performance.getEntriesByType('resource').filter(entry => /react|vendor-/.test(entry.name)).length,
      };
    });
    if (fit.document > fit.viewport || !fit.qrFits || !fit.sameOrigin || fit.naturalWidth !== 739 || fit.naturalHeight !== 672 || fit.react) throw Error(JSON.stringify(fit));
    layouts.push(fit);
  }
  if (forbidden.length) throw Error('Unexpected request: ' + forbidden.join(', '));
  return { create: 'passed', fourGroups: 'passed', keyRevealAndTabHide: 'passed', usageAndSettlement: 'passed', manualRechargeAndBalanceRefresh: 'passed', layouts };
}
