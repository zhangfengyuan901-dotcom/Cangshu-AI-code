async (page) => {
  const base = 'http://127.0.0.1:11247', errors = [], blocked = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => {
    if (new URL(route.request().url()).origin !== base) { blocked.push(new URL(route.request().url()).origin); return route.abort(); }
    return route.continue();
  });
  await page.addInitScript(() => {
    window.__setupQA = { imports: [] };
    window.hamsterAccount = {
      setAccountContext: async () => ({ ok: true }),
      connectCreatedKey: async value => { window.__setupQA.imports.push({ userId: value.userId, keyId: value.keyId, group: value.group }); return { ok: true, code: 'CONNECTED' }; },
      reportFailure: async () => ({ ok: true }),
    };
  });
  const server = async () => (await (await page.request.get(base + '/__qa/state')).json()).data;
  const counts = async () => { const state = await server(); return { creates: state.calls.filter(value => value.path === '/api/token/' && value.method === 'POST').length, reads: state.calls.filter(value => /\/\d+\/key$/.test(value.path)).length, pays: state.calls.filter(value => value.path === '/api/user/pay').length }; };
  const ready = () => page.waitForFunction(() => !document.getElementById('refresh').disabled);
  await page.setViewportSize({ width: 1200, height: 820 });
  await page.request.get(base + '/__qa/account?id=13&signedIn=false');
  await page.goto(base + '/account-lite/index.html'); await page.getByRole('heading', { name: '注册仓鼠AI账户' }).waitFor();
  if (!(await page.getByRole('link', { name: '注册账户', exact: true }).getAttribute('href')).includes('mode=register') || !(await page.getByRole('link', { name: '已有账户，登录' }).getAttribute('href')).includes('mode=login')) throw Error('guest registration/login destinations changed');
  await page.screenshot({ path: 'output/playwright/account-guide47/guest-1200.png' });
  await page.request.get(base + '/__qa/account?id=13');
  await page.route('**/api/user/self', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data: { id: 13, quota: 0, used_quota: 0, request_count: 0 } }) }));
  await page.goto(base + '/account-lite/index.html'); await ready();
  if (await page.locator('#setup-action').textContent() !== '联系管理员') throw Error('zero balance did not guide manual recharge');
  const zero = await counts(); await page.locator('#setup-action').click();
  await page.getByRole('heading', { name: '添加管理员充值' }).waitFor();
  if ((await counts()).pays !== zero.pays) throw Error('recharge guide submitted a payment');
  await page.unroute('**/api/user/self');
  await page.getByRole('button', { name: '刷新账户', exact: true }).click(); await ready();
  await page.locator('#setup-action').click();
  await page.getByRole('dialog').getByRole('textbox', { name: '名称', exact: true }).fill('单用途引导验收');
  await page.getByRole('combobox', { name: '用途', exact: true }).selectOption('image-standard');
  const beforeCreate = await counts(); await page.getByRole('button', { name: '确认开通', exact: true }).click();
  await page.waitForFunction(() => !document.getElementById('key-dialog').open && !document.getElementById('new-key').disabled);
  const created = await counts(), token = (await server()).tokens.find(value => value.user_id === 13);
  if (created.creates !== beforeCreate.creates + 1 || created.reads !== beforeCreate.reads || await page.evaluate(() => window.__setupQA.imports.length)) throw Error('creation activated or fetched a complete Key without a click');
  if (await page.locator('#setup-activation-step').getAttribute('data-state') !== 'current') throw Error('created Key was presented as activated');
  await page.locator(`[data-action="activate-key"][data-key-id="${token.id}"]`).click();
  await page.waitForFunction(() => document.getElementById('setup-activation-step').dataset.state === 'done');
  const complete = await counts(), imports = await page.evaluate(() => window.__setupQA.imports);
  if (imports.length !== 1 || imports[0].keyId !== token.id || imports[0].group !== 'image-standard' || complete.reads !== created.reads + 1) throw Error('single-purpose activation was not isolated');
  if (await page.getByRole('textbox', { name: /的完整 Key/ }).count()) throw Error('activation exposed a complete Key in DOM');
  await page.setViewportSize({ width: 390, height: 844 });
  if (await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)) throw Error('390px guide overflows');
  await page.screenshot({ path: 'output/playwright/account-guide47/activated-390.png', fullPage: true });
  await page.reload(); await ready();
  if (await page.locator('#setup-activation-step').getAttribute('data-state') === 'done' || (await counts()).reads !== complete.reads) throw Error('reload invented a native saved-Key binding or replayed activation');
  await page.request.get(base + '/__qa/account?id=12'); await page.reload(); await ready();
  if (await page.locator('#setup-activation-step').getAttribute('data-state') !== 'current' || await page.evaluate(() => window.__setupQA.imports.length)) throw Error('existing Key was silently activated');
  if (errors.length || blocked.length) throw Error('unexpected page errors or external network');
  return { synthetic: true, registrationPrimary: true, existingLoginPreserved: true, zeroBalanceManualRecharge: true, guidePayments: 0, noAutomaticCreation: true, manualCreates: 1, creationKeyReads: 0, selectedSinglePurposeActivation: true, explicitActivations: imports.length, noFourKeyRequirement: true, noCompleteKeyDOM: true, reloadDoesNotClaimPersistedActivation: true, noOldKeyAutoload: true, width390NoOverflow: true, pageErrors: errors, externalRequests: blocked };
}
