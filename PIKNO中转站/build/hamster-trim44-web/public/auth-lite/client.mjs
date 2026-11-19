// Browser-native authentication. No account token, challenge or password is persisted.
export const ACCOUNT_HOME = '/account-lite/index.html';
const ADMIN_PATH = /^\/(?:dashboard(?:\/overview)?|users|channels|line-management|catalog-admin|settlement-admin|usage-logs(?:\/[a-z-]+)?|system-settings(?:\/[a-z-]+){0,2}|security|profile|task-plugins|system-info|developer)\/?$/;
const encoder = new TextEncoder();
export class AuthError extends Error {
  constructor(code, { uncertain = false, status = 0 } = {}) { super(code); this.code = code; this.uncertain = uncertain; this.status = status; }
}
export function safeRedirect(value, origin, role = 0) {
  if (typeof value !== 'string' || /[\\\u0000-\u0020]/.test(value) || value.startsWith('//')) return null;
  try {
    const target = new URL(value, origin);
    if (!['https:', 'http:'].includes(target.protocol) || target.origin !== origin || target.username || target.password || target.search || target.hash) return null;
    return target.pathname === ACCOUNT_HOME || target.pathname === '/hub/billing' || (role >= 10 && ADMIN_PATH.test(target.pathname)) ? target.pathname : null;
  } catch { return null; }
}
export function loginTarget(bundle, value, origin) {
  return safeRedirect(value, origin, bundle?.user?.role) || (bundle?.user?.role >= 10 ? '/dashboard/overview' : ACCOUNT_HOME);
}
export function isBundle(value) {
  return !!value && typeof value.access_token === 'string' && value.access_token.length > 0 && value.token_type === 'Bearer' && Number.isFinite(value.access_expires_at) && value.access_expires_at > Date.now() / 1000 && Number.isInteger(value.user?.id) && value.user.id > 0 && typeof value.user.username === 'string' && Number.isFinite(value.user.role) && typeof value.session?.sid === 'string' && !!value.session.sid && value.session.current === true;
}
export function isChallenge(value) {
  return !!value && value.require_verification === true && typeof value.flow_token === 'string' && value.flow_token.length > 0 && Number.isFinite(value.expires_at) && value.expires_at * 1000 > Date.now() && Array.isArray(value.methods) && value.methods.length > 0 && value.methods.every((item) => item && ['2fa', 'passkey'].includes(item.method) && typeof item.available === 'boolean');
}
export function validPassword(password) { return typeof password === 'string' && [...password].length >= 8 && [...password].length <= 128; }
function base64(bytes) { let binary = ''; for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte); return btoa(binary); }
function der(pem) {
  const binary = atob(pem.replace('-----BEGIN PUBLIC KEY-----', '').replace('-----END PUBLIC KEY-----', '').replace(/\s/g, ''));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}
export async function encryptPassword(password, key, cryptoImpl = globalThis.crypto) {
  if (!cryptoImpl?.subtle || typeof key?.kid !== 'string' || !key.kid || typeof key.public_key !== 'string') throw new AuthError('ENCRYPTION_UNAVAILABLE');
  try {
    const publicKey = await cryptoImpl.subtle.importKey('spki', der(key.public_key), { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['encrypt']);
    const plaintext = encoder.encode(password);
    let encrypted;
    if (plaintext.byteLength > publicKey.algorithm.modulusLength / 8 - 66) {
      const secret = cryptoImpl.getRandomValues(new Uint8Array(32)), nonce = cryptoImpl.getRandomValues(new Uint8Array(12));
      const aes = await cryptoImpl.subtle.importKey('raw', secret, 'AES-GCM', false, ['encrypt']);
      const [wrapped, ciphertext] = await Promise.all([
        cryptoImpl.subtle.encrypt({ name: 'RSA-OAEP', label: encoder.encode('password-v2') }, publicKey, secret),
        cryptoImpl.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: encoder.encode(`password-v2:${key.kid}`) }, aes, plaintext),
      ]);
      secret.fill(0); plaintext.fill(0);
      encrypted = ['v2', base64(wrapped), base64(nonce), base64(ciphertext)].join('.');
    } else { encrypted = base64(await cryptoImpl.subtle.encrypt({ name: 'RSA-OAEP' }, publicKey, plaintext)); plaintext.fill(0); }
    return { password_encrypted: encrypted, encryption_key_id: key.kid };
  } catch { throw new AuthError('ENCRYPTION_UNAVAILABLE'); }
}

// The only persisted field records the type of an unconfirmed operation, never its input.
export function pendingStore(storage) {
  const key = 'hamster-auth-lite:pending';
  return {
    read() { try { const value = JSON.parse(storage?.getItem(key) || 'null'); return ['login', 'verify', 'register', 'reset'].includes(value?.action) && Number.isFinite(value.at) ? { action: value.action, at: value.at } : null; } catch { return null; } },
    save(action) { try { storage?.setItem(key, JSON.stringify({ action, at: Date.now() })); } catch { /* In-memory protection remains active. */ } },
    clear() { try { storage?.removeItem(key); } catch { /* No credentials are stored. */ } },
  };
}

export function createAuthClient({ fetchImpl = globalThis.fetch.bind(globalThis), cryptoImpl = globalThis.crypto, locks = globalThis.navigator?.locks, pending = pendingStore(), timeout = 15000 } = {}) {
  let inFlight = false, unknown = pending.read(), challenge = null, epoch = 0, encryptionKey = null;
  async function wire(path, { method = 'GET', body, mutation = false, signal, desktopFlow = '' } = {}) {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeout);
    const abort = () => controller.abort(); signal?.addEventListener('abort', abort, { once: true });
    try {
      const headers = body === undefined ? {} : { 'Content-Type': 'application/json' };
      if (desktopFlow) headers['X-Hamster-Desktop-Flow'] = desktopFlow;
      const response = await fetchImpl(path, { method, credentials: 'same-origin', redirect: 'error', cache: 'no-store', headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: controller.signal });
      const data = await response.json();
      if (!response.ok || data?.success !== true) throw new AuthError(['AUTH_FLOW_INVALID', 'AUTH_SESSION_MISMATCH', 'AUTH_SESSION_REVOKED', 'DESKTOP_FLOW_INVALID', 'DESKTOP_ACCOUNT_MISMATCH'].includes(data?.code) ? data.code : 'REQUEST_REJECTED', { uncertain: mutation && (response.status >= 500 || response.status === 408), status: response.status });
      return data.data;
    } catch (error) { if (error instanceof AuthError) throw error; throw new AuthError('NETWORK', { uncertain: mutation }); }
    finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
  }
  async function locked(run) {
    if (!locks) return run();
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeout);
    try { return await locks.request('new-api:auth-refresh', { mode: 'exclusive', signal: controller.signal }, () => { clearTimeout(timer); return run(); }); }
    catch (error) { if (error instanceof AuthError) throw error; throw new AuthError('BUSY'); }
    finally { clearTimeout(timer); }
  }
  async function mutate(action, run) {
    if (inFlight) throw new AuthError('BUSY');
    if (unknown) throw new AuthError('RESULT_UNKNOWN', { uncertain: true });
    const ticket = epoch; inFlight = true;
    // Persist before dispatch so a reload cannot replay an unconfirmed POST.
    unknown = { action, at: Date.now() }; pending.save(action);
    try {
      const result = await locked(async () => { if (ticket !== epoch) throw new AuthError('ACCOUNT_CHANGED'); return run(); });
      if (ticket !== epoch) throw new AuthError('ACCOUNT_CHANGED');
      unknown = null; pending.clear(); return result;
    } catch (error) {
      encryptionKey = null;
      if (!error?.uncertain) { unknown = null; pending.clear(); }
      throw error;
    } finally { inFlight = false; }
  }
  async function login({ username, password, turnstile = '', encryption = false }) {
    if (inFlight) throw new AuthError('BUSY');
    if (unknown) throw new AuthError('RESULT_UNKNOWN', { uncertain: true });
    if (!username?.trim() || typeof password !== 'string' || !password) throw new AuthError('INVALID_INPUT');
    let fields;
    // Encryption fails before the login operation is dispatched; never downgrade.
    if (encryption) { try { encryptionKey ||= await wire('/api/user/login/encryption-key'); fields = await encryptPassword(password, encryptionKey, cryptoImpl); } catch (error) { encryptionKey = null; throw error; } }
    else fields = { password };
    return mutate('login', async () => {
      try {
        const value = await wire(`/api/user/login?${new URLSearchParams({ turnstile })}`, { method: 'POST', body: { username: username.trim(), ...fields }, mutation: true });
        if (isBundle(value)) { challenge = null; return { bundle: value }; }
        if (isChallenge(value)) { challenge = value; return { challenge: value }; }
        throw new AuthError('INVALID_LOGIN_RESPONSE', { uncertain: true });
      } finally { if (fields) { fields.password = ''; fields.password_encrypted = ''; } }
    });
  }
  async function verify(code) {
    if (!isChallenge(challenge)) { challenge = null; throw new AuthError('AUTH_FLOW_INVALID'); }
    if (!challenge.methods.some((item) => item.method === '2fa' && item.available)) throw new AuthError('METHOD_UNAVAILABLE');
    if (!/^(?:\d{6}|[A-Z\d]{4}-[A-Z\d]{4})$/i.test(String(code).trim())) throw new AuthError('INVALID_CODE');
    return mutate('verify', async () => {
      const value = await wire('/api/user/login/verify', { method: 'POST', body: { flow_token: challenge.flow_token, method: '2fa', code: String(code).trim() }, mutation: true });
      if (!isBundle(value)) throw new AuthError('INVALID_LOGIN_RESPONSE', { uncertain: true });
      challenge = null; return { bundle: value };
    });
  }
  function register({ username, password, email = '', code = '', turnstile = '', emailRequired = false, desktopFlow = '' }) {
    if (!username?.trim() || !validPassword(password) || (emailRequired && (!email || !code))) throw new AuthError('INVALID_INPUT');
    if (desktopFlow && !/^[A-Za-z0-9_-]{43}$/.test(desktopFlow)) throw new AuthError('INVALID_INPUT');
    return mutate('register', async () => {
      const value = await wire(`/api/user/register?${new URLSearchParams({ turnstile })}`, { method: 'POST', mutation: true, desktopFlow, body: { username: username.trim(), password, ...(email ? { email } : {}), ...(code ? { verification_code: code } : {}), turnstile } });
      if (!desktopFlow) return value;
      if (!isBundle(value)) throw new AuthError('INVALID_LOGIN_RESPONSE', { uncertain: true });
      return { bundle: value };
    });
  }
  function reset(email, token) {
    if (typeof email !== 'string' || !email || typeof token !== 'string' || !token || token.length > 4096) throw new AuthError('INVALID_RESET');
    return mutate('reset', async () => { const value = await wire('/api/user/reset', { method: 'POST', mutation: true, body: { email, token } }); if (typeof value !== 'string' || !value) throw new AuthError('INVALID_RESET_RESPONSE', { uncertain: true }); return value; });
  }
  async function refresh() {
    const ticket = epoch;
    return locked(async () => {
      const value = await wire('/api/user/auth/refresh', { method: 'POST' });
      if (ticket !== epoch) throw new AuthError('ACCOUNT_CHANGED');
      if (!isBundle(value)) throw new AuthError('INVALID_LOGIN_RESPONSE');
      if (['login', 'verify'].includes(unknown?.action)) { unknown = null; pending.clear(); }
      challenge = null; return value;
    });
  }
  return {
    status: () => wire('/api/status'), login, register, verify, reset, refresh,
    sendCode: (email, turnstile = '') => wire(`/api/verification?${new URLSearchParams({ email, turnstile })}`),
    forgot: (email, turnstile = '') => wire(`/api/reset_password?${new URLSearchParams({ email, turnstile })}`),
    unknown: () => unknown?.action || null,
    cancel() { epoch++; challenge = null; encryptionKey = null; },
    restart() { if (inFlight) throw new AuthError('BUSY'); epoch++; challenge = null; encryptionKey = null; unknown = null; pending.clear(); },
  };
}
