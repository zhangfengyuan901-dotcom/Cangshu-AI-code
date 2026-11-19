import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {startupView,configuredKinds,startupCheckKind,startupGenerationType,needsMainCatalogue,createViewPreferenceWriter} from '../public/startup-ui.mjs';

const image={relayMode:true,configured:true},chat={relayMode:true,chatConfigured:true};
test('first launch and an unconfigured previous feature enter account; partial activation remains sufficient',()=>{
  for(const config of [null,{}, {relayMode:true}, {configured:'true'}])assert.equal(startupView(config,{lastView:'generate'}),'account');
  assert.equal(startupView(image),'generate');assert.equal(startupView(chat),'chat');
  assert.equal(startupView({toolConfigured:true}),'digital');
  assert.equal(startupView(chat,{lastView:'generate'}),'account');
  assert.equal(startupView(image,{lastView:'chat'}),'account');
  assert.equal(startupView(image,{lastView:'history'}),'history');
  assert.equal(startupView(chat,{lastView:'assets'}),'assets');
  assert.equal(startupView(image,{lastView:'account'}),'account');
});
test('untrusted preferences never become a path, internal feature or executable navigation',()=>{
  for(const lastView of ['https://example.test','../config.json','hypit','chatcut','__proto__',{},null])assert.equal(startupView(image,{lastView}),'generate');
  assert.deepEqual(configuredKinds({configured:1,videoConfigured:false,toolConfigured:true,llmConfigured:true}),{image:false,video:false,tool:true,chat:true});
});
test('only the visible creation surfaces require the main catalogue and validation selects one configured purpose',()=>{
  for(const view of ['account','history','assets','chat','canvas'])assert.equal(needsMainCatalogue(view),false);
  assert.equal(needsMainCatalogue('generate'),true);
  assert.equal(startupCheckKind(image,'history'),'image');
  assert.equal(startupCheckKind({...image,videoConfigured:true},'generate'),'video');
  assert.equal(startupCheckKind(chat,'chat'),'chat');assert.equal(startupCheckKind({},'account'),null);
  assert.equal(startupCheckKind(null,'account'),null);
  assert.deepEqual(configuredKinds(null),{image:false,video:false,tool:false,chat:false});
});
test('initial generation purpose follows saved Keys even when the remote catalogue fails',()=>{
  assert.equal(startupGenerationType(image,'video'),'image');
  assert.equal(startupGenerationType({videoConfigured:true},'image'),'video');
  assert.equal(startupGenerationType({...image,videoConfigured:true},'image'),'image');
  assert.equal(startupGenerationType({...image,videoConfigured:true},'video'),'video');
  assert.equal(startupGenerationType({},'video'),'video');
});
test('rapid navigation serializes and coalesces to the newest safe page even when a write fails',async()=>{
  let release;const gate=new Promise(resolve=>release=resolve),writes=[];
  const writer=createViewPreferenceWriter(async value=>{writes.push(value);if(writes.length===1){await gate;throw Error('synthetic local write failure');}});
  const one=writer.remember('generate');writer.remember('history');const last=writer.remember('chat');
  assert.equal(await writer.remember('file:///private'),false);assert.deepEqual(writes,[{lastView:'generate'}]);
  release();await Promise.all([one,last]);assert.deepEqual(writes,[{lastView:'generate'},{lastView:'chat'}]);
  await writer.remember('account');assert.deepEqual(writes.at(-1),{lastView:'account'});
});
test('navigation arriving after drain exits but before promise cleanup is still persisted',async()=>{
  let release;const writes=[],gate=new Promise(resolve=>release=resolve);
  const writer=createViewPreferenceWriter(async value=>{writes.push(value.lastView);if(writes.length===1)await gate;});
  const first=writer.remember('chat');release();
  await Promise.resolve().then(()=>writer.remember('generate'));await first;
  assert.deepEqual(writes,['chat','generate']);
});

function validationFixture(){
  let release;const pending=new Promise(resolve=>release=resolve),calls=[],navigations=[];
  const source=fs.readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
  const start=source.indexOf('async function validateStartupConnection('),end=source.indexOf('function wait(ms)',start);
  const context={startupCheckKind,startupConfig:chat,state:{relayMode:true},activeView:'chat',chatMode:'pikno',relayConfigRevision:1,navigationEpoch:1,document:{visibilityState:'visible'},AbortSignal,
    request:async path=>{calls.push(path);return pending;},switchView:view=>navigations.push(view)};
  vm.createContext(context);vm.runInContext(source.slice(start,end),context);
  return {context,calls,navigations,resolve:release};
}
test('late invalid PIKNO authorization cannot replace a newer page or a local Codex mode',async()=>{
  for(const change of [f=>{f.context.activeView='history';f.context.navigationEpoch++;},f=>{f.context.chatMode='codex';}]){
    const f=validationFixture(),pending=f.context.validateStartupConnection();change(f);f.resolve({state:'unauthorized'});await pending;assert.deepEqual(f.navigations,[]);
  }
  for(const status of [401,403,409]){
    const f=validationFixture();f.context.request=async()=>{throw Object.assign(Error('synthetic'),{status});};
    await f.context.validateStartupConnection();assert.deepEqual(f.navigations,['account']);
  }
});
test('local Codex, missing chat Key, transient errors and cooldown do not invalidate saved configuration',async()=>{
  for(const mode of ['codex','missing-key']){
    const f=validationFixture();if(mode==='codex')f.context.chatMode='codex';else f.context.startupConfig=image;
    await f.context.validateStartupConnection();assert.deepEqual(f.calls,[]);assert.deepEqual(f.navigations,[]);
  }
  for(const status of [0,429,503]){
    const f=validationFixture();f.context.request=async()=>{throw Object.assign(Error('synthetic'),{status});};
    await f.context.validateStartupConnection();assert.deepEqual(f.navigations,[]);assert.equal(f.context.startupConfig.chatConfigured,true);
  }
});
