async (page) => {
  const base = 'http://127.0.0.1:4395';
  const errors = [], results = [];
  page.on('pageerror', error => errors.push(error.message));
  for (const role of [100, 200, 10, 1]) {
    await page.request.get(base + '/__qa/scenario?role=' + role + '&hiddenSidebar=true');
    await page.context().clearCookies();
    await page.goto(base + '/auth-lite/index.html?mode=login&redirect=%2Faccount-lite%2Findex.html');
    await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
    await page.reload();
    await page.locator('#username').fill('synthetic');
    await page.locator('#password').fill('synthetic-password');
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await page.waitForURL(base + '/account-lite/index.html');
    await page.locator('#signed-in').waitFor({ state: 'visible' });
    const home = page.getByRole('link', { name: '管理后台', exact: true });
    if (role >= 10) {
      await home.waitFor({ state: 'visible' });
      const expected = role >= 100 ? '/line-management' : '/channels';
      if (await home.getAttribute('href') !== expected) throw Error('Wrong operator landing for role ' + role);
      await home.click();
      await page.waitForURL(base + expected);
      await page.getByRole('heading', { name: role >= 100 ? '线路管理' : '上游管理', exact: true }).waitFor();
      await page.getByRole('link', { name: '上游管理', exact: true }).waitFor({ state: 'visible' });
      if (role >= 100) {
        await page.getByRole('link', { name: '线路管理', exact: true }).waitFor({ state: 'visible' });
        await page.getByRole('link', { name: '上游管理', exact: true }).click();
        await page.waitForURL(base + '/channels');
        await page.getByRole('heading', { name: '上游管理', exact: true }).waitFor();
        await page.getByRole('link', { name: '线路管理', exact: true }).click();
        await page.waitForURL(base + '/line-management');
        await page.getByRole('heading', { name: '线路管理', exact: true }).waitFor();
        if (role === 100) await page.screenshot({ path: 'D:/PIKNO/output/playwright/fix45-root-management.png', fullPage: true });
      } else {
        if (await page.getByRole('link', { name: '线路管理', exact: true }).count()) throw Error('Admin gained root navigation');
        await page.goto(base + '/line-management');
        await page.waitForURL(base + '/403');
      }
      await page.goto(base + '/account-lite/index.html');
      await page.locator('#signed-in').waitFor({ state: 'visible' });
      if (role === 100) await page.screenshot({ path: 'D:/PIKNO/output/playwright/fix45-root-account.png', fullPage: true });
      await page.locator('#logout').click();
      await page.locator('#confirm-ok').click();
      await page.locator('#login-panel').waitFor({ state: 'visible' });
      if (await home.isVisible()) throw Error('Operator link survived logout');
    } else {
      if (await home.isVisible()) throw Error('Customer gained operator link');
      for (const path of ['/channels', '/line-management']) {
        await page.goto(base + path);
        await page.waitForURL(base + '/403');
      }
    }
    const state = await (await page.request.get(base + '/__qa/state')).json();
    const writes = state.data.calls.filter(call => call.method !== 'GET' && !['/api/user/login', '/api/user/auth/refresh', '/api/user/auth/logout'].includes(call.path));
    if (writes.length) throw Error('Management QA attempted a mutation: ' + JSON.stringify(writes));
    results.push({ role, hiddenLegacyConfiguration: true, operatorEntry: role >= 10, upstream: role >= 10, lines: role >= 100, noManagementMutation: true });
  }
  if (errors.length) throw Error('Browser errors: ' + JSON.stringify(errors));
  return { synthetic: true, roles: results, browserErrors: 0, realCredentials: false, paidCalls: 0 };
}
