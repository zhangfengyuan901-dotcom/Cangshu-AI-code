'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { buildBundle, OUTPUT } = require('../scripts/build-lucide-subset.cjs');
const full = require('../public/vendor/lucide.min.js');

test('shell icon subset is current, uses official SVG nodes and saves over 90% of script bytes', () => {
  const result = buildBundle();
  const source = fs.readFileSync(OUTPUT, 'utf8');
  assert.equal(source, result.source, 'Run node scripts/build-lucide-subset.cjs after adding an icon');
  const fullBytes = fs.statSync(path.join(__dirname, '../public/vendor/lucide.min.js')).size;
  assert.ok(Buffer.byteLength(source) < fullBytes * 0.1);
  assert.match(source, /Permission to use, copy, modify/);
  for (const [name, nodes] of Object.entries(result.icons)) assert.deepEqual(nodes, full.icons[name], name);
  for (const name of ['AudioLines', 'Image', 'Video', 'TriangleAlert', 'ScanText', 'BadgeCheck']) assert.ok(result.icons[name], name);
});

test('subset keeps createIcons root, attributes, classes and dynamic refresh behavior', () => {
  const makeElement = (tagName, attrs = {}) => ({
    tagName,
    attributes: Object.entries(attrs).map(([name, value]) => ({ name, value })),
    children: [],
    setAttribute(name, value) {
      const attr = this.attributes.find(item => item.name === name);
      if (attr) attr.value = value;
      else this.attributes.push({ name, value });
    },
    getAttribute(name) { return this.attributes.find(item => item.name === name)?.value ?? null; },
    appendChild(child) { this.children.push(child); },
  });
  const document = { createElementNS: (_namespace, tag) => makeElement(tag) };
  const context = vm.createContext({ document, console });
  vm.runInContext(fs.readFileSync(OUTPUT, 'utf8'), context);
  const api = context.lucide;
  const replacements = [];
  const placeholder = makeElement('i', { 'data-lucide': 'image-plus', class: 'tile-icon', 'aria-label': '添加图片' });
  placeholder.parentNode = { replaceChild: (svg, previous) => replacements.push({ svg, previous }) };
  const root = { querySelectorAll: selector => selector === '[data-lucide]' ? [placeholder] : [] };
  api.createIcons({ root, icons: api.icons, attrs: { 'stroke-width': 1.8 } });
  assert.equal(replacements.length, 1);
  assert.equal(replacements[0].svg.tagName, 'svg');
  assert.equal(replacements[0].svg.getAttribute('stroke-width'), '1.8');
  assert.equal(replacements[0].svg.getAttribute('aria-label'), '添加图片');
  assert.equal(replacements[0].svg.getAttribute('aria-hidden'), null);
  assert.match(replacements[0].svg.getAttribute('class'), /lucide-image-plus tile-icon/);
  assert.ok(replacements[0].svg.children.length);
  placeholder.setAttribute('data-lucide', 'video');
  api.createIcons({ root });
  assert.equal(replacements[1].svg.getAttribute('data-lucide'), 'video');
  const direct = api.createElement(api.icons.Sparkles, { width: 16 });
  assert.equal(direct.getAttribute('width'), '16');
});
