const fs = require('node:fs');
const path = require('node:path');
const {randomBytes, createHash, randomUUID} = require('node:crypto');

const GROUPS = ['image-standard', 'video-standard', 'tool-standard', 'chat-standard'];
const FLOW = /^[A-Za-z0-9_-]{43}$/;
const VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;
const fail = code => Object.assign(new Error(code), {code});

function createBrowserAccount({request, file, cipher, origin, getBundle, getConnectedAccountId,
  getConfiguredGroups, install, adopt, ensureBundle, openExternal, isCurrent, now = Date.now}) {
  let pending = null;
  let blocked = false;
  const protectedStorage = () => cipher?.isEncryptionAvailable?.() === true
    && cipher.getSelectedStorageBackend?.() !== 'basic_text';
  function validate(value) {
    return value?.format === 1 && FLOW.test(value.flowId) && VERIFIER.test(value.verifier)
      && ['connect', 'recharge'].includes(value.purpose) && Number.isSafeInteger(value.expiresAt)
      && value.expiresAt > 0 && typeof value.requestId === 'string'
      && /^[a-f\d-]{36}$/i.test(value.requestId)
      && (value.userId === null || Number.isSafeInteger(value.userId) && value.userId > 0)
      && typeof value.installed === 'boolean';
  }
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8192 || !protectedStorage()) throw Error();
    const value = JSON.parse(cipher.decryptString(fs.readFileSync(file)));
    if (!validate(value)) throw Error();
    pending = value;
  } catch (error) { if (error.code !== 'ENOENT') blocked = true; }
  async function save(value) {
    if (blocked || !protectedStorage()) throw fail('KEY_STORAGE_UNAVAILABLE');
    const temporary = file + '.' + randomUUID() + '.tmp';
    let bytes;
    try {
      bytes = cipher.encryptString(JSON.stringify(value));
      await fs.promises.mkdir(path.dirname(file), {recursive: true});
      const output = await fs.promises.open(temporary, 'wx', 0o600);
      try { await output.writeFile(bytes); await output.sync(); } finally { await output.close(); }
      await fs.promises.rename(temporary, file);
      pending = value;
    } catch (error) {
      if (error.code === 'KEY_STORAGE_UNAVAILABLE') throw error;
      throw fail('KEY_STORAGE_UNAVAILABLE');
    } finally { bytes?.fill(0); await fs.promises.unlink(temporary).catch(() => {}); }
  }
  async function clear() {
    try { await fs.promises.unlink(file); } catch (error) { if (error.code !== 'ENOENT') throw fail('STORAGE_UNAVAILABLE'); }
    pending = null;
  }
  async function post(route, body, authorization) {
    const headers = {'Content-Type': 'application/json'};
    if (authorization) headers.Authorization = 'Bearer ' + authorization;
    const {response, data} = await request('/api/user/desktop/' + route,
      {method: 'POST', headers, body: JSON.stringify(body)});
    if (!response?.ok || data?.success !== true) {
      const code = ['DESKTOP_FLOW_INVALID', 'DESKTOP_ACCOUNT_MISMATCH', 'DESKTOP_FLOW_COMPLETE', 'DESKTOP_SETUP_FAILED'].includes(data?.code) ? data.code : response?.status === 401 ? 'LOGIN_REQUIRED' : 'NETWORK';
      throw fail(code);
    }
    return data.data;
  }
  const live = () => { if (!isCurrent()) throw fail('ACCOUNT_CHANGED'); };
  const browserUrl = flowId => origin + '/hub/billing#desktop=' + flowId;
  async function open() {
    live();
    if (blocked) throw fail('STORAGE_UNAVAILABLE');
    if (!protectedStorage()) throw fail('KEY_STORAGE_UNAVAILABLE');
    if (pending && pending.expiresAt * 1000 <= now()) await clear();
    if (!pending) {
      const bundle = getBundle();
      const owner = getConnectedAccountId();
      if (bundle && owner && owner !== bundle.user.id) throw fail('ACCOUNT_MISMATCH');
      const purpose = bundle && GROUPS.every(group => getConfiguredGroups().includes(group)) ? 'recharge' : 'connect';
      const verifier = randomBytes(32).toString('base64url');
      const challenge = createHash('sha256').update(verifier).digest('base64url');
      const result = await post('start', {challenge, purpose,...(owner?{expected_user_id:owner}:{})}, bundle?.access_token);
      live();
      if (!FLOW.test(result?.flow_id) || !Number.isSafeInteger(result.expires_at)
        || result.expires_at * 1000 <= now() || result.expires_at * 1000 > now() + 16 * 60 * 1000
        || result.verification_url !== browserUrl(result.flow_id) || result.interval !== 3) throw fail('NETWORK');
      await save({format: 1, flowId: result.flow_id, verifier, purpose, expiresAt: result.expires_at,
        requestId: randomUUID(), userId: bundle?.user.id || owner || null, installed: false});
    }
    live();
    await openExternal(browserUrl(pending.flowId));
    const connectionCode=pending.flowId.slice(0,8).toUpperCase();
    return {ok: true, browserOpened: true, pending: true,
      ...(pending.purpose==='connect'?{connectionCode:connectionCode.slice(0,4)+'-'+connectionCode.slice(4)}:{})};
  }
  async function poll() {
    live();
    if (blocked) throw fail('STORAGE_UNAVAILABLE');
    if (!pending) return {ok: true, pending: false};
    if (pending.expiresAt * 1000 <= now()) { await clear(); return {ok: true, pending: false, code: 'DESKTOP_FLOW_INVALID'}; }
    const record = pending;
    let result;
    try { result = await post('exchange', {flow_id: record.flowId, verifier: record.verifier}); }
    catch (error) {
      if (error.code === 'DESKTOP_FLOW_COMPLETE' && record.installed) { await clear(); return {ok: true, pending: false, connected: true}; }
      if (error.code === 'DESKTOP_FLOW_INVALID') await clear();
      throw error;
    }
    live();
    if (result?.status === 'pending') return {ok: true, pending: true};
    if (result?.status !== 'ready') throw fail('NETWORK');
    try {
      if (record.purpose === 'recharge') {
        if(!getBundle()||getBundle().access_expires_at<now()/1000+20)await ensureBundle();
        if (result.user_id !== record.userId || getBundle()?.user.id !== record.userId) throw fail('ACCOUNT_MISMATCH');
        await save({...record, installed: true});
      } else {
        const userId = result.user?.id;
        if (!Number.isSafeInteger(userId) || userId < 1 || record.userId && record.userId !== userId
          || getConnectedAccountId() && getConnectedAccountId() !== userId) throw fail('ACCOUNT_MISMATCH');
        const keys = result.keys;
        if (!Array.isArray(keys) || keys.length !== GROUPS.length
          || GROUPS.some(group => keys.filter(row => row?.group === group).length !== 1)
          || keys.some(row => !Number.isSafeInteger(row.id) || row.id < 1 || typeof row.key !== 'string' || !/^[a-zA-Z0-9]{48}$/.test(row.key))) throw fail('KEY_INVALID');
        await adopt(result);
        live();
        for (const row of keys) {
          if (getConfiguredGroups().includes(row.group)) continue;
          await install(row, record.requestId);
          live();
        }
        await save({...record, userId, installed: true});
      }
      const bundle = getBundle();
      if (!bundle || bundle.user.id !== pending.userId) throw fail('ACCOUNT_CHANGED');
      await post('ack', {flow_id: record.flowId, verifier: record.verifier}, bundle.access_token);
      live();
      await clear();
      return {ok: true, pending: false, connected: record.purpose === 'connect'};
    } finally {
      if (result) {
        result.access_token = '';
        if (Array.isArray(result.keys)) for (const row of result.keys) row.key = '';
      }
    }
  }
  return {open, poll, hasPending: () => pending !== null, async cancel() { await clear(); }};
}

module.exports = {createBrowserAccount};
