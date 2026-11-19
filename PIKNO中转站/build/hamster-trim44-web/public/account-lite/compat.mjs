// Small capability fallbacks; credentials and operation state never live here.
export const hasOwn = (value, key) => value != null && Object.prototype.hasOwnProperty.call(value, key);

// Only the public flow reference crosses pages. Its verifier stays in the app.
export function desktopFlowContext(storage, hash = '') {
  const key = 'hamster-desktop-flow';
  try {
    if (hash.startsWith('#desktop=')) {
      const value = /^#desktop=([A-Za-z0-9_-]{43})$/.exec(hash)?.[1] || 'invalid';
      storage.setItem(key, value);
      return value;
    }
    const value = storage?.getItem(key);
    return value ? (/^[A-Za-z0-9_-]{43}$/.test(value) ? value : 'invalid') : '';
  } catch { return 'invalid'; }
}

export function secureUUID(cryptoImpl = globalThis.crypto) {
  if (typeof cryptoImpl?.randomUUID === 'function') return cryptoImpl.randomUUID();
  if (typeof cryptoImpl?.getRandomValues !== 'function') throw new Error('安全随机数不可用，请使用 HTTPS 和受支持的浏览器。');
  const bytes = cryptoImpl.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const dialogs = new WeakMap();
const focusable = 'button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),a[href],[tabindex]:not([tabindex="-1"])';
function focusTargets(dialog) {
  return Array.from(dialog.querySelectorAll(focusable)).filter((node) => !node.hidden && !node.closest('[hidden]') && node.getClientRects().length);
}
export function openDialog(dialog) {
  if (typeof dialog.showModal === 'function') { dialog.showModal(); return; }
  if (dialogs.has(dialog)) return;
  const doc = dialog.ownerDocument, view = doc.defaultView, previous = doc.activeElement;
  const backdrop = doc.createElement('div'); backdrop.className = 'dialog-backdrop'; backdrop.setAttribute('aria-hidden', 'true');
  const siblings = Array.from(doc.body.children).filter((node) => node !== dialog);
  const prior = siblings.map((node) => [node, node.hasAttribute('inert')]);
  const role = dialog.getAttribute('role'), modal = dialog.getAttribute('aria-modal'), tabindex = dialog.getAttribute('tabindex');
  const focus = () => (focusTargets(dialog)[0] || dialog).focus();
  const keydown = (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      if (dialog.dispatchEvent(new view.Event('cancel', { cancelable: true }))) closeDialog(dialog);
    } else if (event.key === 'Tab') {
      const nodes = focusTargets(dialog), first = nodes[0] || dialog, last = nodes[nodes.length - 1] || dialog;
      if (!nodes.length || (event.shiftKey ? doc.activeElement === first : doc.activeElement === last) || !dialog.contains(doc.activeElement)) {
        event.preventDefault(); (event.shiftKey ? last : first).focus();
      }
    }
  };
  const focusin = (event) => { if (!dialog.contains(event.target)) focus(); };
  for (const [node] of prior) node.setAttribute('inert', '');
  dialog.setAttribute('open', ''); dialog.setAttribute('data-dialog-fallback', '');
  dialog.setAttribute('role', 'dialog'); dialog.setAttribute('aria-modal', 'true'); dialog.setAttribute('tabindex', '-1');
  // Unknown dialog elements in older engines need the same .open contract.
  if (!('open' in dialog)) Object.defineProperty(dialog, 'open', { configurable: true, get: () => dialog.hasAttribute('open') });
  doc.body.append(backdrop); doc.documentElement.classList.add('dialog-fallback-open');
  doc.addEventListener('keydown', keydown, true); doc.addEventListener('focusin', focusin, true);
  dialogs.set(dialog, () => {
    doc.removeEventListener('keydown', keydown, true); doc.removeEventListener('focusin', focusin, true);
    backdrop.remove(); doc.documentElement.classList.remove('dialog-fallback-open');
    for (const [node, inert] of prior) if (!inert) node.removeAttribute('inert');
    for (const [name, value] of [['role', role], ['aria-modal', modal], ['tabindex', tabindex]]) {
      if (value == null) dialog.removeAttribute(name); else dialog.setAttribute(name, value);
    }
    if (previous?.isConnected) previous.focus();
  });
  focus();
}
export function closeDialog(dialog, returnValue = '') {
  const cleanup = dialogs.get(dialog);
  if (!cleanup) { if (dialog.open && typeof dialog.close === 'function') dialog.close(returnValue); return; }
  dialogs.delete(dialog); dialog.returnValue = String(returnValue);
  dialog.removeAttribute('open'); dialog.removeAttribute('data-dialog-fallback'); cleanup();
  dialog.dispatchEvent(new dialog.ownerDocument.defaultView.Event('close'));
}
