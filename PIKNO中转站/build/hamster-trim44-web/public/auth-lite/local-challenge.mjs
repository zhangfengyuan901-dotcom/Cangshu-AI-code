// Only fixed same-origin endpoints are used. Challenge answers and proofs stay
// in memory; a timeout never retries an answer or an account operation.
export function createLocalChallenge({ fetchImpl = globalThis.fetch.bind(globalThis), onChange = () => {}, timeout = 10000 } = {}) {
  let state = { image: '', token: '', busy: false, error: false }, id = '', epoch = 0, timer, request, disposed = false;
  const emit = (patch) => { state = { ...state, ...patch }; if (!disposed) onChange({ ...state }); };
  const invalidate = () => { epoch++; clearTimeout(timer); request?.abort(); request = null; id = ''; emit({ image: '', token: '', busy: false, error: false }); };
  const expires = (seconds, ticket) => { clearTimeout(timer); timer = setTimeout(() => { if (ticket === epoch) { id = ''; emit({ image: '', token: '', busy: false, error: true }); } }, seconds * 1000); };
  async function wire(path, body) {
    const controller = new AbortController(); request = controller;
    const deadline = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetchImpl(path, { method: body ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'same-origin', headers: body ? { 'Content-Type': 'application/json' } : {}, ...(body ? { body: JSON.stringify(body) } : {}), signal: controller.signal });
      const value = await response.json();
      if (controller.signal.aborted) throw new Error('CHALLENGE_ABORTED');
      if (!response.ok || value?.success !== true) throw new Error('CHALLENGE_REJECTED');
      return value.data;
    } finally { clearTimeout(deadline); if (request === controller) request = null; }
  }
  async function load() {
    if (disposed) return;
    invalidate(); const ticket = epoch; emit({ busy: true });
    try {
      const value = await wire('/api/auth/challenge');
      if (ticket !== epoch || disposed) return;
      if (!/^[A-Za-z0-9_-]{43}$/.test(value?.id || '') || typeof value?.image !== 'string' || value.image.length > 40000 || !/^data:image\/png;base64,[A-Za-z0-9+/]+=*$/.test(value.image) || value.expires_in !== 120) throw new Error('CHALLENGE_INVALID');
      id = value.id; emit({ image: value.image, busy: false }); expires(value.expires_in, ticket);
    } catch { if (ticket === epoch && !disposed) emit({ image: '', token: '', busy: false, error: true }); }
  }
  async function verify(answer) {
    if (disposed || state.busy || !id || !/^\d{6}$/.test(answer)) return;
    const ticket = epoch, submitted = id; id = ''; clearTimeout(timer); emit({ busy: true, token: '', error: false });
    try {
      const value = await wire('/api/auth/challenge/verify', { id: submitted, answer });
      if (ticket !== epoch || disposed) return;
      if (!/^local\.[A-Za-z0-9_-]{43}$/.test(value?.token || '') || value.expires_in !== 120) throw new Error('CHALLENGE_INVALID');
      emit({ image: '', token: value.token, busy: false }); expires(value.expires_in, ticket);
    } catch { if (ticket === epoch && !disposed) emit({ image: '', token: '', busy: false, error: true }); }
  }
  return { load, verify, invalidate, dispose() { disposed = true; invalidate(); } };
}

export function mountLocalChallenge(container, onToken) {
  const doc = container.ownerDocument, wrap = doc.createElement('div'); wrap.className = 'local-challenge';
  const image = doc.createElement('img'); image.alt = '图形验证码'; image.width = 210; image.height = 64;
  const label = doc.createElement('label'); label.textContent = '请输入图片中的 6 位数字';
  const input = doc.createElement('input'); input.inputMode = 'numeric'; input.autocomplete = 'off'; input.maxLength = 6; input.setAttribute('aria-label', '图形验证码'); label.append(input);
  const actions = doc.createElement('div'); actions.className = 'code-row';
  const verify = doc.createElement('button'); verify.type = 'button'; verify.className = 'secondary'; verify.textContent = '验证';
  const refresh = doc.createElement('button'); refresh.type = 'button'; refresh.className = 'text-button'; refresh.textContent = '换一张';
  const message = doc.createElement('p'); message.setAttribute('role', 'status');
  let current;
  const client = createLocalChallenge({ onChange(state) {
    current = state; onToken(state.token); image.hidden = !state.image;
    if (state.image) image.src = state.image; else { image.removeAttribute('src'); input.value = ''; }
    label.hidden = !state.image; input.disabled = state.busy;
    verify.disabled = state.busy || !state.image || !/^\d{6}$/.test(input.value);
    refresh.disabled = state.busy;
    message.textContent = state.busy ? '正在读取安全验证…' : state.token ? '验证通过' : state.error ? '验证未完成或已过期，请换一张重试。' : '';
  } });
  input.addEventListener('input', () => { verify.disabled = current?.busy || !current?.image || !/^\d{6}$/.test(input.value); });
  input.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); if (!verify.disabled) void client.verify(input.value); } });
  verify.addEventListener('click', () => { void client.verify(input.value); }); refresh.addEventListener('click', () => { void client.load(); });
  actions.append(verify, refresh); wrap.append(image, label, actions, message); container.replaceChildren(wrap); void client.load();
  return { reset: () => { void client.load(); }, remove: () => { client.dispose(); wrap.remove(); } };
}
