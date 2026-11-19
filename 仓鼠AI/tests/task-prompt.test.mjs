import test from 'node:test';
import assert from 'node:assert/strict';
import { copyTaskPrompt } from '../public/task-prompt.mjs';

test('copyTaskPrompt copies the exact saved prompt through the clipboard API', async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  let copied = '';
  Object.defineProperty(globalThis, 'navigator', { configurable:true, value:{ clipboard:{ writeText:async text => { copied = text; } } } });
  try {
    assert.equal(await copyTaskPrompt('完整\n提示词'), 'copied');
    assert.equal(copied, '完整\n提示词');
    assert.equal(await copyTaskPrompt('   '), 'empty');
  } finally {
    if (original) Object.defineProperty(globalThis, 'navigator', original);
    else delete globalThis.navigator;
  }
});

test('copyTaskPrompt exposes selected read-only text when clipboard access fails', async () => {
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  let appended;
  const createElement = tagName => ({
    tagName, children:[], attributes:{},
    append(...children) { this.children.push(...children); },
    setAttribute(name, value) { this.attributes[name] = value; },
    addEventListener(name, listener) { this[`${name}Listener`] = listener; },
    showModal() { this.open = true; },
    close() { this.closeListener?.(); },
    remove() { this.removed = true; },
    focus() { this.focused = true; },
    select() { this.selected = true; },
  });
  Object.defineProperty(globalThis, 'navigator', { configurable:true, value:{ clipboard:{ writeText:async () => { throw Error('denied'); } } } });
  Object.defineProperty(globalThis, 'document', { configurable:true, value:{ createElement, body:{ append(node) { appended = node; } } } });
  try {
    assert.equal(await copyTaskPrompt('<完整&纯文本>'), 'manual');
    const field = appended.children.find(node => node.tagName === 'textarea');
    assert.equal(field.value, '<完整&纯文本>');
    assert.equal(field.readOnly, true);
    assert.equal(field.selected, true);
    assert.equal(appended.open, true);
  } finally {
    if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator);
    else delete globalThis.navigator;
    if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument);
    else delete globalThis.document;
  }
});
