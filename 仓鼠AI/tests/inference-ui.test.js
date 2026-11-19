const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = name => fs.readFileSync(path.join(__dirname, '..', 'public', name), 'utf8');

test('account page activates inference after email login without upstream fields', () => {
  const html = read('index.html');
  const script = read('app.js');
  assert.match(html, /id="inferenceLogo"/);
  assert.doesNotMatch(html, /inference-card|id="checkInference"|id="llmStatus"/);
  assert.match(script, /signal:AbortSignal\.timeout\(20000\)/);
  for (const forbidden of ['llmKeyInput', 'llmEndpointInput', 'saveLlmKeyButton']) {
    assert.doesNotMatch(html, new RegExp(forbidden));
    assert.doesNotMatch(script, new RegExp(forbidden));
  }
  assert.match(script, /localStorage\.removeItem\('hamster_llm_api_key'\)/);
});

test('logo has accessible states and logout invalidation',()=>{
  const html=read('index.html'),css=read('styles.css'),billing=read('billing-account.mjs');
  assert.match(html,/aria-describedby="inferenceLogoHint"/);
  assert.match(html,/id="inferenceLogoHint" role="status" aria-live="polite"/);
  assert.match(css,/\.inference-logo:not\(\.is-connected\):hover img \{ filter: grayscale\(1\)/);
  assert.match(css,/prefers-reduced-motion: reduce/);
  assert.match(billing,/await api\('\/auth\/logout',[\s\S]*?hamster-session-invalidated[\s\S]*?location.reload/);
});
