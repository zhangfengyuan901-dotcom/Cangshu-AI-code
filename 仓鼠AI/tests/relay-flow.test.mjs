import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const source=fs.readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
test('relay first launch opens Key setup and saved Keys refresh models without reloading the app',()=>{
  assert.match(source,/switchView\('account',\{remember:false\}\)/);
  assert.match(source,/startupView\(d,startup.uiPreferences\)/);
  assert.match(source,/addEventListener\('hamster-relay-configured'/);
  assert.match(source,/if\(document.visibilityState!=='hidden'&&needsMainCatalogue\(activeView\)\)await loadModels\(\);await syncTasks\(\)/);
  assert.match(source,/inflightGets\.clear\(\);uploadReuse\.clear\(\);inferenceIndicator\.reset\(\)/);
  assert.match(source,/if\(!models\.length&&!state\.relayMode\)/);
});
test('relay configuration changes invalidate stale catalog and task responses',()=>{
  assert.match(source,/const revision=relayConfigRevision;[\s\S]*?if\(revision!==relayConfigRevision\)return/);
  assert.match(source,/const d=await requestOnce\('\/config',\{signal:AbortSignal.timeout\(25000\)\}\);if\(revision!==relayConfigRevision\)return/);
  assert.match(source,/resetStorageStatus\(\)/);
  assert.match(source,/if\(revision!==relayConfigRevision\|\|!storageStatusMode\)return/);
});
