async (page) => {
  const base = 'http://127.0.0.1:11196', errors = [], blocked = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => {
    if (new URL(route.request().url()).origin !== base) { blocked.push(new URL(route.request().url()).origin); return route.abort(); }
    return route.continue();
  });
  const server = async () => (await (await page.request.get(base + '/__qa/state')).json()).data;
  const counts = async () => { const state = await server(); return { creates: state.calls.filter(value => value.path === '/api/token/' && value.method === 'POST').length, reads: state.calls.filter(value => /\/\d+\/key$/.test(value.path)).length }; };
  const refresh = async () => { await page.getByRole('button', { name: '刷新账户', exact: true }).click(); await page.waitForFunction(() => !document.getElementById('refresh').disabled); };
  const keys = () => page.getByRole('button', { name: 'API Key', exact: true }).click();
  const activate = id => page.locator(`button[data-action="activate-key"][data-key-id="${id}"]`);
  const create = async group => {
    await page.getByRole('button', { name: '开通 API Key', exact: true }).click();
    await page.getByRole('textbox', { name: '名称', exact: true }).fill('逐项激活验收');
    await page.getByRole('combobox', { name: '用途', exact: true }).selectOption(group);
    await page.getByRole('button', { name: '确认开通', exact: true }).click();
    await page.waitForFunction(() => !document.getElementById('key-dialog').open && !document.getElementById('key-form').querySelector('[type=submit]').disabled);
    const state = await server(); return state.tokens.at(-1).id;
  };
  await page.goto(base + '/account-lite/index.html'); await page.getByText('¥128.50', { exact: true }).waitFor(); await keys();
  await activate(7).waitFor();
  if (!await activate(7).isDisabled() || await activate(7).textContent() !== '在应用中激活' || (await counts()).reads) throw Error('ordinary browser exposed activation or fetched a Key');
  const old = (await server()).tokens[0];
  await page.evaluate(old => {
    const metadata = { userID: 12, name: old.name, group: old.group, startedAt: old.created_time * 1000, keyId: old.id, createdAt: old.created_time, requestId: 'bb83a81b-4b35-445e-8558-24433fc7042a' };
    localStorage.setItem('hamster-account-lite:pending-handoff-image-standard:12', JSON.stringify(metadata));
    localStorage.setItem('hamster-account-lite:pending-key:12', JSON.stringify(metadata));
  }, old);
  await page.addInitScript(() => {
    const realNow = Date.now; window.__qaOffset = 0; Date.now = () => realNow() + window.__qaOffset;
    window.__activationQA = { imports: [], failures: [] };
    window.hamsterAccount = {
      setAccountContext: async () => ({ ok: true }),
      connectCreatedKey: async value => {
        window.__activationQA.imports.push({ keyId: value.keyId, userId: value.userId, group: value.group, requestId: value.requestId, hasKey: /^sk-/.test(value.key) });
        const mode = sessionStorage.getItem('qa-activation-mode');
        if (mode === 'mismatch') return { ok: false, code: 'ACCOUNT_MISMATCH' };
        if (mode === 'limited' && !sessionStorage.getItem('qa-already-limited')) { sessionStorage.setItem('qa-already-limited', 'yes'); return { ok: false, code: 'RATE_LIMITED', httpStatus: 429, retryAfterMs: 60000 }; }
        return value.group === 'chat-standard' ? { ok: true, code: 'SAVED_CHECK_PENDING', httpStatus: 429, retryAfterMs: 1000 } : { ok: true, code: 'CONNECTED' };
      },
      reportFailure: async value => window.__activationQA.failures.push(value),
    };
  });
  await page.reload(); await page.getByText('¥128.50', { exact: true }).waitFor(); await keys();
  if ((await counts()).reads || await page.evaluate(() => window.__activationQA.imports.length)) throw Error('legacy automatic handoff or unknown creation activated a Key');
  await activate(7).click(); await page.waitForFunction(() => document.querySelector('[data-key-id="7"]')?.textContent === '已激活');
  const oldCounts = await counts(); if (oldCounts.reads !== 1 || oldCounts.creates) throw Error('old Key activation created or read another Key');
  for (const group of ['image-standard', 'video-standard', 'tool-standard', 'chat-standard']) {
    const before = await counts(), imported = await page.evaluate(() => window.__activationQA.imports.length), id = await create(group);
    const created = await counts();
    if (created.reads !== before.reads || created.creates !== before.creates + 1 || await page.evaluate(() => window.__activationQA.imports.length) !== imported) throw Error('creation automatically fetched or activated a Key');
    await activate(id).click();
    const expected = group === 'chat-standard' ? '已保存，待检测' : '已激活';
    await page.waitForFunction(({ id, expected }) => document.querySelector(`[data-key-id="${id}"]`)?.textContent === expected, { id, expected });
    const after = await counts(); if (after.reads !== created.reads + 1 || after.creates !== created.creates) throw Error('activation did not isolate its selected Key');
  }
  if (await page.getByRole('textbox', { name: /的完整 Key/ }).count()) throw Error('activation displayed complete Key');
  const completed = await counts(), successes = await page.evaluate(() => window.__activationQA.imports);
  if (successes.length !== 5 || successes.some(value => value.userId !== 12 || !value.hasKey)) throw Error('wrong explicit native activation');
  await refresh(); await page.reload(); await page.getByText('¥128.50', { exact: true }).waitFor(); await keys();
  if ((await counts()).reads !== completed.reads || await page.evaluate(() => window.__activationQA.imports.length)) throw Error('refresh replayed a completed activation');
  await page.evaluate(() => { window.__qaOffset = 2000; sessionStorage.setItem('qa-activation-mode', 'limited'); });
  await activate(8).click(); await page.getByText(/图片生成：激活暂受限/).waitFor();
  const pending = await page.evaluate(() => JSON.parse(localStorage.getItem('hamster-account-lite:pending-activate-image-standard:12')));
  if (pending.intent !== 'activate-selected-key-v1' || pending.keyId !== 8 || !pending.retryAt) throw Error('activation intent/cooldown not persisted');
  const limited = await counts(); await refresh(); await page.reload(); await page.getByText('¥128.50', { exact: true }).waitFor(); await keys();
  if ((await counts()).reads !== limited.reads) throw Error('reload bypassed activation cooldown');
  await page.evaluate(() => { window.__qaOffset = 63000; }); await refresh();
  await page.getByText('图片生成：已激活', { exact: true }).waitFor();
  const recovered = await page.evaluate(() => ({ imported: window.__activationQA.imports, pending: localStorage.getItem('hamster-account-lite:pending-activate-image-standard:12') }));
  if (recovered.pending || recovered.imported.length !== 1 || recovered.imported[0].keyId !== 8 || recovered.imported[0].requestId !== pending.requestId || (await counts()).creates !== limited.creates) throw Error('recovery replaced the original selection/operation or created a Key');
  await page.evaluate(() => { sessionStorage.setItem('qa-activation-mode', 'mismatch'); }); await activate(9).click();
  await page.getByText('视频生成：本机已连接其他账户，请先移除本机 Key', { exact: true }).waitFor();
  const beforeSwitch = await counts(); await page.request.get(base + '/__qa/account?id=13'); await refresh(); await refresh();
  await page.waitForFunction(() => !document.getElementById('signed-in').hidden);
  if ((await counts()).reads !== beforeSwitch.reads || (await page.locator('#key-connection').textContent()).includes('其他账户')) throw Error('pending activation crossed accounts');
  const persisted = await page.evaluate(() => Object.entries(localStorage).filter(([key]) => key.startsWith('hamster-account-lite:pending-')));
  if (/"key":|access_token|cookie|sk-/.test(JSON.stringify(persisted))) throw Error('Secret in recovery metadata');
  if (errors.length || blocked.length) throw Error('unexpected page error or non-loopback request');
  return { synthetic: true, ordinaryWebDoesNotActivate: true, legacyAutomaticHandoffIgnored: true, originalUnknownCreationDoesNotActivate: true, existingKeyExplicitActivation: true, fourManualCreates: 4, creationKeyReads: 0, explicitActivations: successes.length, selectedKeyOnly: true, noCompleteKeyDOMOrStorage: true, savedPendingNotReplayed: true, cooldownSurvivesRefreshAndReload: true, sameOriginalKeyAndOperationRecovery: true, accountSwitchDiscardsPendingActivation: true, pageErrors: errors, externalRequests: blocked };
}
