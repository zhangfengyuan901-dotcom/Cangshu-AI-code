async (page) => {
  const base = 'http://127.0.0.1:11189', errors = [], blocked = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', async (route) => {
    if (new URL(route.request().url()).origin !== base) { blocked.push(new URL(route.request().url()).origin); return route.abort(); }
    return route.continue();
  });
  let role = 200;
  await page.route('**/api/user/auth/refresh', async (route) => {
    const response = await route.fetch(), body = await response.json();
    if (body.data?.user) body.data.user.role = role;
    await route.fulfill({ response, json: body });
  });
  await page.addInitScript(() => {
    const originalNow = Date.now;
    window.__qaOffset = 0; Date.now = () => originalNow() + window.__qaOffset;
    window.__keyQA = { imports: [], failures: [] };
    window.hamsterAccount = {
      setAccountContext: async () => ({ ok: true }),
      connectCreatedKey: async (value) => {
        window.__keyQA.imports.push({ keyId: value.keyId, userId: value.userId, requestId: value.requestId, group: value.group });
        if (value.group === 'chat-standard') return { ok: true, code: 'SAVED_CHECK_PENDING', httpStatus: 429, retryAfterMs: 60000 };
        if (value.group === 'tool-standard' || !sessionStorage.getItem('qa-first-rate-limited')) { sessionStorage.setItem('qa-first-rate-limited', 'yes'); return { ok: false, code: 'RATE_LIMITED', httpStatus: 429, retryAfterMs: 60000 }; }
        return { ok: true, code: 'CONNECTED' };
      },
      reportFailure: async (value) => window.__keyQA.failures.push(value),
    };
  });
  const serverState = async () => (await (await page.request.get(base + '/__qa/state')).json()).data;
  const counts = async () => { const state = await serverState(); return { creates: state.calls.filter(value => value.path === '/api/token/' && value.method === 'POST').length, reads: state.calls.filter(value => /\/\d+\/key$/.test(value.path)).length }; };
  const refresh = async () => { await page.getByRole('button', { name: '刷新账户', exact: true }).click(); await page.waitForFunction(() => !document.getElementById('refresh').disabled); };
  const create = async (group) => {
    await page.getByRole('button', { name: '开通 API Key', exact: true }).click();
    await page.getByRole('textbox', { name: '名称', exact: true }).fill('限流恢复验收');
    await page.getByRole('combobox', { name: '用途', exact: true }).selectOption(group);
    await page.getByRole('button', { name: '确认开通', exact: true }).click();
    await page.waitForFunction(() => !document.getElementById('key-dialog').open && !document.getElementById('key-form').querySelector('[type=submit]').disabled);
  };
  await page.goto(base + '/account-lite/index.html'); await page.getByText('¥128.50', { exact: true }).waitFor();
  await page.getByRole('link', { name: '管理后台', exact: true }).waitFor();
  if (await page.locator('#admin-home').getAttribute('href') !== '/line-management') throw Error('root entry lost');
  role = 10; await refresh();
  if (await page.locator('#admin-home').getAttribute('href') !== '/channels') throw Error('admin entry lost');
  role = 1; await refresh();
  if (await page.locator('#admin-home').isVisible() || await page.locator('#admin-home').getAttribute('href')) throw Error('customer saw admin entry');
  const before = await counts();
  if ((await serverState()).calls.some(value => value.path === '/api/token/7/key')) throw Error('old key read at login');
  await page.getByRole('button', { name: 'API Key', exact: true }).click(); await create('image-standard');
  await page.getByText(/图片生成：已开通，应用接入暂受限/).waitFor();
  const pending = await page.evaluate(() => JSON.parse(localStorage.getItem('hamster-account-lite:pending-handoff-image-standard:12')));
  const first = await counts();
  if (first.creates !== before.creates + 1 || first.reads !== before.reads + 1 || !pending.retryAt || !pending.requestId) throw Error('invalid first limited state');
  await refresh(); await page.reload(); await page.getByText('¥128.50', { exact: true }).waitFor(); await page.getByRole('button', { name: 'API Key', exact: true }).click();
  const cooled = await counts();
  if (cooled.creates !== first.creates || cooled.reads !== first.reads) throw Error('cooldown was bypassed by refresh/reload');
  await page.evaluate(() => { window.__qaOffset = 61000; }); await refresh();
  await page.getByText(/图片生成：已接入并通过免费连接检测/).waitFor();
  const recovered = await page.evaluate(() => ({ imported: window.__keyQA.imports[0], pending: localStorage.getItem('hamster-account-lite:pending-handoff-image-standard:12'), failures: window.__keyQA.failures }));
  if (recovered.pending || recovered.imported?.requestId !== pending.requestId || recovered.imported?.keyId !== pending.keyId || recovered.failures.length) throw Error('original handoff was not safely resumed');
  const resumed = await counts(); if (resumed.creates !== first.creates || resumed.reads !== first.reads + 1) throw Error('recovery recreated a key');
  await page.reload(); await page.getByText('¥128.50', { exact: true }).waitFor(); await page.getByRole('button', { name: 'API Key', exact: true }).click();
  await create('chat-standard'); await page.getByText(/AI 对话：已安全保存，免费检测暂受限/).waitFor();
  const saved = await counts();
  await refresh(); await page.reload(); await page.getByText('¥128.50', { exact: true }).waitFor();
  if ((await counts()).reads !== saved.reads) throw Error('saved pending key was reread');
  await page.getByRole('button', { name: 'API Key', exact: true }).click(); await create('tool-standard');
  await page.getByText(/数字人与工具：已开通，应用接入暂受限/).waitFor(); const beforeSwitch = await counts();
  await page.request.get(base + '/__qa/account?id=13'); await refresh(); await refresh();
  await page.waitForFunction(() => !document.getElementById('signed-in').hidden);
  if ((await counts()).reads !== beforeSwitch.reads || await page.locator('#key-connection').textContent().then(value => value.includes('暂受限'))) throw Error('old account handoff crossed identity');
  await page.request.get(base + '/__qa/account?id=13&signedIn=false'); await refresh();
  if (await page.locator('#admin-home').isVisible() || await page.locator('#admin-home').getAttribute('href')) throw Error('logged-out admin entry visible');
  if (errors.length || blocked.length) throw Error('unexpected page error or external request');
  const persisted = await page.evaluate(() => Object.entries(localStorage).filter(([key]) => key.startsWith('hamster-account-lite:pending-')));
  if (/"key":|access_token|cookie|sk-/.test(JSON.stringify(persisted))) throw Error('secret in recovery storage');
  return { synthetic: true, administratorEntry: { root: '/line-management', admin: '/channels', customerHidden: true, loggedOutHidden: true }, cooldownSurvivesRefreshAndReload: true, recoveryCreates: resumed.creates - first.creates, sameOriginalKeyAndOperation: true, savedPendingNotReread: true, accountSwitchDiscardsHandoff: true, secretPersisted: false, pageErrors: errors, externalRequests: blocked };
}
