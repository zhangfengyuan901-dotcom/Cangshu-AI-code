// Copy the submitted snapshot, never the current composer or truncated card text.
export async function copyTaskPrompt(text) {
  if (typeof text !== 'string' || !text.trim()) return 'empty';
  try {
    await navigator.clipboard.writeText(text);
    return 'copied';
  } catch {}
  const dialog = document.createElement('dialog');
  dialog.className = 'task-prompt-dialog';
  dialog.setAttribute('aria-label', '手动复制任务提示词');
  const title = document.createElement('h2');
  title.textContent = '任务原始提示词';
  const note = document.createElement('p');
  note.textContent = '自动复制不可用，已选中完整提示词，请按 Ctrl+C 复制。';
  const field = document.createElement('textarea');
  field.value = text;
  field.readOnly = true;
  field.setAttribute('aria-label', '完整任务提示词');
  const close = document.createElement('button');
  close.textContent = '关闭';
  close.type = 'button';
  close.onclick = () => dialog.close();
  dialog.append(title, note, field, close);
  document.body.append(dialog);
  dialog.addEventListener('close', () => dialog.remove(), { once:true });
  dialog.showModal();
  field.focus();
  field.select();
  return 'manual';
}
