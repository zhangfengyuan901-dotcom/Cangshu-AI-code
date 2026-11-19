// CLI run-code page function. Only synthetic loopback fixtures are allowed.
async (page) => {
  const origin = new URL(page.url()).origin;
  if (new URL(origin).hostname !== '127.0.0.1') throw Error('Loopback fixture required');
  const context = page.context(), errors = [], external = [], phases = []; let activePhase = '';
  const observe = target => target.on('pageerror', error => errors.push({ phase: activePhase, primary: target === page, closed: target.isClosed(), path: new URL(target.url()).pathname, name: error.name, message: error.message }));
  observe(page); context.on('page', observe);
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) { external.push(url.origin); return route.abort(); }
    return route.continue();
  });
  const state = async () => (await (await page.request.get(origin + '/__qa/state')).json()).data;
  const initial = await state(), accountFixture = Array.isArray(initial.tokens);
  const counters = data => ({
    creates: data.calls.filter(call => call.path === '/api/token/' && call.method === 'POST').length,
    reveals: data.calls.filter(call => /^\/api\/token\/\d+\/key$/.test(call.path)).length,
    pays: data.calls.filter(call => call.path === '/api/user/pay' && call.method === 'POST').length,
    posts: data.calls.filter(call => call.path === '/pay/lanjing/epay/submit.php' && call.method === 'POST').length,
    refresh: data.calls.filter(call => call.path === '/api/user/auth/refresh').length,
  });
  const assert = (condition, message) => { if (!condition) throw Error(message); };
  const phase = async (name, work) => { activePhase = name; try { const result = await work(); phases.push({ name, passed: true, ...result }); } catch (error) { throw Error(name + ': ' + error.message); } };
  let current = page;
  async function fresh({ missing = false, native = false, storageDenied = false, submitFailure = false, channelDenied = false } = {}) {
    if (current !== page) await current.close();
    current = await context.newPage(); current.setDefaultTimeout(12000);
    await current.addInitScript(({ missing, native, storageDenied, submitFailure, channelDenied }) => {
      if (missing) {
        Object.defineProperty(Object, 'hasOwn', { configurable: true, value: undefined });
        Object.defineProperty(crypto, 'randomUUID', { configurable: true, value: undefined });
        if (window.HTMLDialogElement) Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value: undefined });
      }
      window.__compatQA = { imports: [], failures: [], submitted: [], submitFailure };
      if (channelDenied) window.BroadcastChannel = function () { throw new DOMException('Synthetic channel denied', 'SecurityError'); };
      if (native) window.hamsterAccount = {
        setAccountContext: async () => ({ ok: true }),
        connectCreatedKey: async value => {
          window.__compatQA.imports.push({ keyId: value.keyId, userId: value.userId, group: value.group, requestId: value.requestId, canonical: /^sk-[a-zA-Z0-9]{48}$/.test(value.key) });
          return { ok: true, code: 'CONNECTED' };
        },
        reportFailure: async value => window.__compatQA.failures.push(value),
      };
      if (storageDenied) Object.defineProperty(Storage.prototype, 'setItem', { configurable: true, value() { throw new DOMException('Synthetic storage denied', 'SecurityError'); } });
      const original = HTMLFormElement.prototype.submit;
      HTMLFormElement.prototype.submit = function () {
        if (new URL(this.action).pathname === '/pay/lanjing/epay/submit.php') {
          window.__compatQA.submitted.push({ action: new URL(this.action).pathname, method: this.method, target: this.target, active: navigator.userActivation?.isActive ?? null, fields: Object.fromEntries(new FormData(this)) });
          if (window.__compatQA.submitFailure) throw Error('Synthetic payment popup blocked');
        }
        return original.call(this);
      };
    }, { missing, native, storageDenied, submitFailure, channelDenied });
    return current;
  }
  async function ready(target, tab) {
    await target.goto(origin + '/account-lite/index.html');
    await target.locator('#balance-value').filter({ hasText: '128.50' }).waitFor();
    if (tab) await target.locator(`[data-tab="${tab}"]`).click();
  }
  async function clearStorage() {
    if (new URL(page.url()).pathname !== '/__qa/frame') await page.goto(origin + '/__qa/frame');
    await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
  }
  async function countNow() { return counters(await state()); }
  async function create(target, group) {
    await target.locator('#new-key').click();
    await target.locator('#key-dialog').waitFor({ state: 'visible' });
    await target.locator('#key-form [name="name"]').fill('浏览器兼容合成验收');
    await target.locator('#key-form [name="group"]').selectOption(group);
    await target.locator('#key-form [type="submit"]').click();
    await target.waitForFunction(() => !document.getElementById('key-dialog').open && !document.querySelector('#key-form [type="submit"]').disabled);
    return (await state()).tokens.filter(token => token.user_id === 12).at(-1).id;
  }
  async function lifecycle(target) {
    await target.evaluate(() => {
      const hidden = new Event('pagehide'); Object.defineProperty(hidden, 'persisted', { value: true }); dispatchEvent(hidden);
    });
    await target.evaluate(() => {
      const shown = new Event('pageshow'); Object.defineProperty(shown, 'persisted', { value: true }); dispatchEvent(shown);
    });
  }
  async function widthCheck(target, width) {
    await target.setViewportSize({ width, height: width === 320 ? 568 : 844 });
    const sizes = await target.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth, body: document.body.scrollWidth }));
    assert(sizes.document <= sizes.viewport && sizes.body <= sizes.viewport, `Horizontal overflow ${width}: ${JSON.stringify(sizes)}`);
    return sizes;
  }
  try {
    await page.request.get(origin + (accountFixture ? '/__qa/account?id=12&signedIn=true' : '/__qa/scenario'));
    await context.clearCookies(); await clearStorage();
    await phase('classic-boot-ready-and-readable-module-failures', async () => {
      const entry = accountFixture ? 'account' : 'auth', directory = entry === 'account' ? 'account-lite' : 'auth-lite';
      const target = await fresh(); await target.goto(`${origin}/${directory}/index.html`);
      await target.locator('#boot-status').waitFor({ state: 'hidden' });
      await target.route(`${origin}/${directory}/${entry}.mjs`, route => route.fulfill({ status: 200, contentType: 'text/javascript', body: 'export {};' }));
      await target.reload(); await target.locator('#boot-status').filter({ hasText: '初始化未完成' }).waitFor();
      const initMessage = await target.locator('#boot-status').textContent();
      await target.unroute(`${origin}/${directory}/${entry}.mjs`);
      await target.route(`${origin}/${directory}/${entry}.mjs`, route => route.abort('failed'));
      await target.reload(); await target.locator('#boot-status').filter({ hasText: '资源加载失败' }).waitFor();
      const loadMessage = await target.locator('#boot-status').textContent();
      return { entry, explicitReadyHidesNotice: true, emptyModuleCannotPretendReady: true, initMessage, networkFailureMessage: loadMessage };
    });
    if (accountFixture) {
      await page.request.get(origin + '/__qa/account?id=12&signedIn=true');
      await clearStorage();
      await phase('ordinary-browser-no-secret-read', async () => {
        const target = await fresh({ missing: true, channelDenied: true }); const before = await countNow(); await ready(target, 'keys');
        const disabled = target.locator('[data-action="activate-key"]').first(); await disabled.waitFor();
        assert(await disabled.isDisabled(), 'Ordinary browser exposed native activation');
        const after = await countNow(); assert(after.reveals === before.reveals, 'Ordinary browser read Secret on load');
        const missing = await target.evaluate(() => ({ own: typeof Object.hasOwn, uuid: typeof crypto.randomUUID, modal: typeof HTMLDialogElement.prototype.showModal }));
        assert(Object.values(missing).every(value => value === 'undefined'), 'Missing API simulation failed');
        return { keyReads: 0, capabilitiesRemoved: missing, broadcastChannelRejectedWithoutCrash: true };
      });
      await clearStorage();
      await phase('missing-apis-explicit-activation-and-create', async () => {
        const target = await fresh({ missing: true, native: true }); const before = await countNow(); await ready(target, 'keys');
        const old = (await state()).tokens.find(token => token.user_id === 12 && token.id === 7);
        assert(old, 'Existing synthetic token missing');
        await target.locator('[data-action="activate-key"][data-key-id="7"]').click();
        await target.waitForFunction(() => document.querySelector('[data-key-id="7"]')?.textContent === '已激活');
        for (const group of ['image-standard', 'video-standard', 'tool-standard', 'chat-standard']) {
          const start = await countNow(), id = await create(target, group), created = await countNow();
          assert(created.creates === start.creates + 1 && created.reveals === start.reveals, 'Creating Key read Secret or replayed creation');
          await target.locator(`[data-action="activate-key"][data-key-id="${id}"]`).click();
          await target.waitForFunction(id => document.querySelector(`[data-key-id="${id}"]`)?.textContent === '已激活', id);
          const activated = await countNow(); assert(activated.reveals === created.reveals + 1 && activated.creates === created.creates, 'Activation did not isolate selected Key');
        }
        const imported = await target.evaluate(() => window.__compatQA.imports);
        assert(imported.length === 5 && imported.every(value => value.canonical && value.userId === 12 && /^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i.test(value.requestId)), 'Canonical raw48 activation/secure UUID fallback failed');
        const secretFree = await target.evaluate(() => !/sk-[ivtc]\d{18}q{29}/.test(document.documentElement.outerHTML + JSON.stringify(Object.entries(localStorage))));
        assert(secretFree, 'Secret escaped to page or storage');
        const after = await countNow(); assert(after.creates - before.creates === 4 && after.reveals - before.reveals === 5, 'Unexpected Key call count');
        return { nativeInterfaceSynthetic: true, realNativeStorageTest: false, explicitActivations: 5, creates: 4, creationSecretReads: 0, canonicalKeys: true, secureUUIDFallback: true, dialogFallback: true };
      });
      await clearStorage();
      await phase('persisted-account-restoration-clears-key-and-revalidates', async () => {
        const target = await fresh(); await ready(target, 'keys');
        await target.getByRole('button', { name: '查看 Key', exact: true }).first().click();
        await target.locator('.key-value').first().waitFor(); const before = await countNow();
        await lifecycle(target); await target.waitForFunction(() => document.getElementById('balance-value').textContent.includes('128.50'));
        await target.waitForFunction(() => !document.getElementById('refresh').disabled);
        assert(await target.locator('.key-value').count() === 0, 'Page cache retained visible Secret');
        const after = await countNow(); assert(after.refresh > before.refresh && after.creates === before.creates && after.pays === before.pays && after.reveals === before.reveals, 'Page restore replayed write/read or did not refresh authentication');
        return { simulatedPersistedEvents: true, keyDOMCleared: true, freshSessionCheck: true, writeReplay: 0, keyReadReplay: 0 };
      });
      await clearStorage();
      await phase('storage-rejection-prevents-key-and-payment-writes', async () => {
        const target = await fresh({ storageDenied: true, missing: true, native: true }); await ready(target, 'keys');
        const before = await countNow();
        await target.locator('#new-key').click(); await target.locator('#key-form [name="name"]').fill('存储拒绝合成验收');
        await target.locator('#key-form [type="submit"]').click(); await target.locator('#key-error').filter({ hasText: '存储' }).waitFor();
        await target.locator('#close-key').click();
        await target.locator('[data-action="activate-key"]').first().click();
        await target.locator('#notice').filter({ hasText: '存储' }).waitFor();
        await target.locator('[data-tab="topup"]').click(); await target.waitForFunction(() => !document.getElementById('pay').disabled);
        await target.locator('#pay').click(); await target.locator('#confirm-ok').click();
        await target.locator('#notice').filter({ hasText: '存储' }).waitFor();
        const after = await countNow(); assert(after.creates === before.creates && after.pays === before.pays && after.reveals === before.reveals, 'Storage denial allowed financial write/Key reveal');
        return { creates: 0, payments: 0, selectedKeyReads: 0 };
      });
      await clearStorage();
      await phase('payment-original-signed-post-on-explicit-click', async () => {
        const target = await fresh(); await ready(target, 'topup');
        await target.waitForFunction(() => !document.getElementById('pay').disabled);
        const before = await countNow();
        await target.locator('#pay').click(); await target.locator('#confirm-ok').click();
        const resume = target.getByRole('button', { name: '继续支付', exact: true }); await resume.waitFor();
        const created = await countNow(); assert(created.pays === before.pays + 1, 'Recharge did not create exactly one order');
        const popupPromise = context.waitForEvent('page', { predicate: item => item !== target, timeout: 12000 });
        await resume.click(); const popup = await popupPromise;
        await popup.getByRole('heading', { name: '离线支付示例' }).waitFor();
        const attempts = await target.evaluate(() => window.__compatQA.submitted), after = await countNow();
        assert(attempts.length === 1, 'Signed payment submitted more than once');
        assert(attempts.every(value => value.method.toLowerCase() === 'post' && value.action === '/pay/lanjing/epay/submit.php' && value.active !== false), 'Payment POST was not inside an explicit active gesture');
        assert(after.pays === before.pays + 1 && after.posts === before.posts + 1, 'Payment retry created another order or posted twice');
        assert(Object.keys(attempts[0].fields).includes('sign') && !Object.keys(attempts[0].fields).includes('access_token'), 'Signed payment contract changed');
        const persisted = await target.evaluate(() => JSON.stringify(Object.entries(localStorage)));
        assert(!persisted.includes('"sign"') && !persisted.includes('"pid"'), 'Signed form persisted');
        await popup.close();
        return { syntheticOrdersCreated: 1, successfulBridgePOSTs: 1, activeUserGesture: true, signedFormNotPersisted: true };
      });
      await clearStorage();
      await phase('payment-submit-error-keeps-original-order-locked', async () => {
        const target = await fresh({ submitFailure: true }); await ready(target, 'topup');
        await target.waitForFunction(() => !document.getElementById('pay').disabled);
        const before = await countNow(); await target.locator('#pay').click(); await target.locator('#confirm-ok').click();
        const resume = target.locator('#continue-payment'); await resume.waitFor(); await resume.click();
        await target.waitForFunction(() => window.__compatQA.submitted.length === 1);
        await target.locator('#notice').filter({ hasText: /原订单|待核对|支付状态/ }).waitFor();
        assert(await target.locator('#pay').isDisabled(), 'Failed payment allowed new order');
        assert(!await resume.isVisible() || await resume.isDisabled(), 'Failed payment allowed repeating uncertain signed submission');
        await target.reload(); await target.locator('#balance-value').filter({ hasText: '128.50' }).waitFor(); await target.locator('[data-tab="topup"]').click();
        await target.locator('#order-list .record').first().waitFor();
        const after = await countNow(); assert(after.pays === before.pays + 1 && after.posts === before.posts, 'Failed payment replayed or replaced order');
        assert(await target.locator('#pay').isDisabled(), 'Reload lost pending recharge lock');
        return { syntheticOrdersCreated: 1, submitAttempts: 1, successfulBridgePOSTs: 0, automaticRetry: false, pendingSurvivesReload: true };
      });
      await clearStorage();
      await phase('fallback-modal-keyboard-focus-and-short-viewport', async () => {
        const target = await fresh({ missing: true }); await ready(target, 'keys'); await target.setViewportSize({ width: 320, height: 360 });
        // WebKit pointer clicks deliberately do not focus buttons; keyboard entry
        // gives this accessibility check an actual focused opener to restore.
        await target.locator('#new-key').focus(); await target.locator('#new-key').press('Enter');
        await target.locator('#key-dialog[data-dialog-fallback]').waitFor();
        const keyboard = await target.locator('#key-dialog').evaluate(dialog => {
          const first = dialog.querySelector('#close-key'), last = dialog.querySelector('[type="submit"]');
          last.focus(); return { first: first.id, last: last.type };
        });
        await target.keyboard.press('Tab'); assert(await target.locator('#close-key').evaluate(node => node === document.activeElement), 'Fallback Tab did not wrap to first control');
        await target.keyboard.press('Shift+Tab'); assert(await target.locator('#key-form [type="submit"]').evaluate(node => node === document.activeElement), 'Fallback Shift+Tab did not wrap to last control');
        const box = await target.locator('#key-dialog').boundingBox(), scrolling = await target.locator('#key-dialog').evaluate(node => ({ client: node.clientHeight, scroll: node.scrollHeight }));
        assert(box && box.y >= 0 && box.y + box.height <= 361 && scrolling.scroll > scrolling.client, 'Short viewport modal does not fit/scroll');
        const browser = await target.evaluate(() => /Edg\//.test(navigator.userAgent) ? 'edge' : /Firefox\//.test(navigator.userAgent) ? 'firefox' : /Chrome\//.test(navigator.userAgent) ? 'chrome' : 'webkit');
        await target.screenshot({ path: `D:/PIKNO/output/playwright/compat49/${browser}-dialog-320x360.png`, fullPage: true });
        await target.keyboard.press('Escape'); await target.locator('#key-dialog').waitFor({ state: 'hidden' });
        assert(await target.locator('#new-key').evaluate(node => node === document.activeElement), 'Fallback modal did not restore opener focus');
        assert(await target.locator('.dialog-backdrop').count() === 0 && await target.locator('[inert]').count() === 0, 'Fallback modal leaked blocking state');
        return { keyboard, tabWrap: true, shiftTabWrap: true, escapeCancel: true, openerFocusRestored: true, viewport: { width: 320, height: 360 }, modal: box, scrolling };
      });
      await clearStorage();
      await phase('account-mobile-widths', async () => {
        const target = await fresh({ missing: true }); await ready(target); const dimensions = [];
        for (const width of [390, 320]) {
          for (const tab of ['balance', 'usage', 'topup', 'keys']) { await target.locator(`[data-tab="${tab}"]`).click(); dimensions.push({ tab, ...await widthCheck(target, width) }); }
          await target.locator('#new-key').click(); dimensions.push({ tab: 'key-dialog', ...await widthCheck(target, width) }); await target.locator('#close-key').click();
        }
        return { dimensions, realMobileDevice: false };
      });
    } else {
      async function scenario(query = '') {
        await page.request.get(origin + '/__qa/scenario?' + query); await context.clearCookies(); await clearStorage();
      }
      async function authReady(target, mode = 'login') {
        await target.goto(origin + '/auth-lite/index.html?mode=' + mode); await target.locator('#auth-form').waitFor();
        await target.waitForFunction(() => !document.getElementById('submit').disabled);
      }
      async function login(target) {
        await target.locator('#username').fill('synthetic'); await target.locator('#password').fill('synthetic-password'); await target.locator('#submit').click();
      }
      await phase('encrypted-login-and-two-factor-with-missing-apis', async () => {
        await scenario('challenge=true'); const target = await fresh({ missing: true }); await authReady(target); await login(target);
        await target.getByRole('heading', { name: '验证账户身份' }).waitFor();
        await target.locator('#otp').fill('123456'); await target.locator('#submit').click();
        await target.waitForURL(origin + '/account-lite/index.html'); await target.locator('#balance-value').filter({ hasText: '128.50' }).waitFor();
        const data = await state(); assert(data.calls.some(call => call.path === '/api/user/login' && call.encrypted) && data.calls.some(call => call.path === '/api/user/login/verify' && call.validContract), 'Encrypted login/2FA contract failed');
        return { encryptedPassword: true, validTwoFactorContract: true, plaintextFallback: false };
      });
      await phase('explicit-registration-no-affiliate', async () => {
        await scenario(); const target = await fresh({ missing: true }); await authReady(target, 'register');
        await target.locator('#username').fill('synthetic'); await target.locator('#email').fill('synthetic@example.test');
        await target.locator('#password').fill('synthetic-password'); await target.locator('#confirm').fill('synthetic-password'); await target.locator('#email-code').fill('123456');
        await target.locator('#submit').click(); await target.waitForURL(origin + '/auth-lite/index.html?mode=login');
        const data = await state(), registrations = data.calls.filter(call => call.path === '/api/user/register');
        assert(registrations.length === 1 && registrations[0].affAbsent, 'Registration duplicated or affiliate contract changed');
        return { registrations: 1, realAccount: false };
      });
      await phase('unknown-login-not-replayed-on-reload-or-persisted-restore', async () => {
        await scenario('loseLogin=true'); const target = await fresh(); await authReady(target); await login(target);
        await target.locator('#unknown-actions').waitFor(); await target.reload(); await target.locator('#check-session').waitFor();
        await lifecycle(target); await target.locator('#check-session').waitFor();
        const data = await state(); assert(data.calls.filter(call => call.path === '/api/user/login').length === 1, 'Unknown login replayed');
        return { loginSubmissions: 1, simulatedPersistedEvents: true, automaticReplay: false };
      });
      await phase('auth-page-cache-restores-form-and-clears-secrets', async () => {
        await scenario(); const target = await fresh(); await authReady(target); await target.locator('#password').fill('synthetic-not-submitted');
        await lifecycle(target); await target.waitForFunction(() => !document.getElementById('submit').disabled);
        assert(await target.locator('#password').inputValue() === '', 'Password survived pagehide');
        await login(target); await target.waitForURL(origin + '/account-lite/index.html');
        const data = await state(); assert(data.calls.filter(call => call.path === '/api/user/login').length === 1, 'Restored form did not submit exactly once');
        return { clearSecrets: true, restoredFormUsable: true, simulatedPersistedEvents: true };
      });
      await phase('role-controlled-admin-entry', async () => {
        const roles = [];
        for (const role of [1, 10, 100, 200]) {
          await scenario('signedIn=true&role=' + role + '&hiddenSidebar=true'); const target = await fresh(); await ready(target);
          const home = target.locator('#admin-home'), href = await home.getAttribute('href');
          assert(role < 10 ? !await home.isVisible() && !href : await home.isVisible() && href === (role >= 100 ? '/line-management' : '/channels'), 'Administrator entry role mismatch');
          roles.push({ role, href, visible: await home.isVisible() });
        }
        return { roles, legacyHiddenPreferenceIgnored: true, realAdminWrites: 0 };
      });
      await phase('auth-mobile-widths', async () => {
        await scenario(); const target = await fresh(); const dimensions = [];
        for (const width of [390, 320]) for (const mode of ['login', 'register', 'forgot']) { await authReady(target, mode); dimensions.push({ mode, ...await widthCheck(target, width) }); }
        return { dimensions, realMobileDevice: false };
      });
    }
    assert(errors.length === 0, 'Page errors: ' + JSON.stringify(errors)); assert(external.length === 0, 'Unexpected external attempts: ' + JSON.stringify(external));
    return { format: 1, suite: accountFixture ? 'account' : 'authentication-admin', synthetic: true, browser: await page.evaluate(() => navigator.userAgent), phases, pageErrors: errors, blockedExternalOrigins: external, realPayments: 0, realAccounts: 0, realSafariOrMobileDevice: false };
  } finally { if (current !== page && !current.isClosed()) await current.close(); }
}
