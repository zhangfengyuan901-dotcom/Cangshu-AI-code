import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {pathToFileURL,fileURLToPath} from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import {spawnSync} from 'node:child_process';

// Use the untouched, installed SDK and its public Distribution resolution hook.
const root=fileURLToPath(new URL('../../build/hypit-host/node_modules/@hypit/hypit/',import.meta.url));
const require=createRequire(path.join(root,'package.json'));
const {register}=await import(pathToFileURL(require.resolve('tsx/esm/api')).href);register();
const {installDistributionPackageResolution}=await import(pathToFileURL(path.join(root,'packages/loader/src/node/distribution-resolution.ts')).href);
installDistributionPackageResolution([root]);
const {EndpointRegistry,MemoryResourceStore}=await import('@hypit/hypit/executor');
const {generationTypes}=await import(pathToFileURL(require.resolve('@hypit/generation')).href);
// A project package still needs its peer packages in an actual Node resolution
// ancestor. Test against the untouched installed siblings, not patched SDK code.
const temp=fs.mkdtempSync(path.resolve(root,'../../..','.hypit-provider-test-'));
const installed=path.join(temp,'node_modules','@hamster','hypit-video');fs.mkdirSync(installed,{recursive:true});
for(const name of ['package.json','model.js','provider.js','activation.js'])fs.copyFileSync(new URL('../'+name,import.meta.url),path.join(installed,name));
test.after(()=>fs.rmSync(temp,{recursive:true,force:true}));
const {endpoint:model,capability,decodeVideoSurface}=await import(pathToFileURL(path.join(installed,'model.js')).href);
const {createVideoProvider}=await import(pathToFileURL(path.join(installed,'provider.js')).href);
const activation=(await import(pathToFileURL(path.join(installed,'activation.js')).href)).default;
const ports={operationId:['shot-1-v1'],line:['main-video-test'],prompt:['A synthetic scene'],duration:[4],resolution:['720p'],ratio:['16:9']};
const requestId='hypit-'+'a'.repeat(64);
const need={id:'need:video',capability,returns:generationTypes.videoSet,constraints:model.sealRequest(ports),result:'record:video'};

test('package declares real model, admission, producer, markup and runtime facets',()=>{
  assert.equal(activation.format,'hypit.package@1');assert.equal(activation.modules[0].manifest.name,'@hamster/hypit-video');
  assert.ok(activation.facets.length>=5);
  const decoded=decodeVideoSurface({element:{name:'hamster:Video',attributes:{id:'shot-1','operation-id':'shot-1-v1',line:'main-video-test',prompt:'A synthetic scene',duration:'4',resolution:'720p',ratio:'16:9'},children:[]}});
  assert.equal(decoded.records[0].value.value.ports.operationId[0],'shot-1-v1');
  assert.equal(decoded.components[0].outputs.video,'shot-1.video');
});
test('untouched Hypit CLI really loads and checks the project-owned Video markup',()=>{
  fs.writeFileSync(path.join(temp,'package.json'),JSON.stringify({name:'hypit-video-offline-smoke',private:true,type:'module',dependencies:{'@hamster/hypit-video':'0.1.0'}}));
  fs.writeFileSync(path.join(temp,'main.svml'),'<?svml using="@hypit/markup@1"?>\n<svml><import as="hamster" from="@hamster/hypit-video@1"/><hamster:Video id="shot-1" operation-id="shot-1-v1" line="main-video-test" prompt="A synthetic scene" duration="4" resolution="720p" ratio="16:9"/></svml>');
  fs.writeFileSync(path.join(temp,'main.svrun'),'<?svml using="@hypit/markup/run@1"?>\n<svrun version="1"><author source="./main.svml"/><target output="shot-1.video"/></svrun>');
  const run=spawnSync(process.execPath,[path.join(root,'bin/hypit.mjs'),'check','main.svrun','--project',temp,'--json'],{cwd:temp,encoding:'utf8',timeout:30000,windowsHide:true});
  assert.equal(run.status,0,(run.stderr||'')+(run.stdout||''));
  assert.match(run.stdout,/"ok":\s*true/);
  const profile=JSON.parse(fs.readFileSync(new URL('../hypit.runtime.example.json',import.meta.url),'utf8'));profile.endpoints['hamster.video'].config.projectId='offline-project';
  fs.writeFileSync(path.join(temp,'hypit.runtime.json'),JSON.stringify(profile));
  const plan=spawnSync(process.execPath,[path.join(root,'bin/hypit.mjs'),'plan','main.svrun','--runtime','hypit.runtime.json','--project',temp,'--json'],{cwd:temp,encoding:'utf8',timeout:30000,windowsHide:true,env:{...process.env,HAMSTER_HYPIT_BRIDGE_URL:'http://127.0.0.1:12345',HAMSTER_HYPIT_BRIDGE_TOKEN:'synthetic-offline-no-service'}});
  assert.equal(plan.status,0,(plan.stderr||'')+(plan.stdout||''));
  assert.match(plan.stdout,/@hamster\/hypit-video/);
  assert.match(plan.stdout,/hamster\.video/);
});
test('model rejects missing operation identity and unsupported media roles instead of dropping them',()=>{
  const {operationId:ignored,...withoutIdentity}=ports;assert.throws(()=>model.sealRequest(withoutIdentity));
  for(const extra of [{firstFrame:['not supported']},{generateAudio:[true]},{webSearch:[true]}])assert.throws(()=>model.sealRequest({...ports,...extra}));
  assert.throws(()=>model.sealRequest({...ports,referenceAssetIds:['https://example.invalid/image']}));
  assert.throws(()=>decodeVideoSurface({element:{name:'hamster:Video',attributes:{id:'s','operation-id':'s',line:'m',prompt:'p',duration:'4',resolution:'720p',ratio:'16:9','first-frame':'ignored'},children:[]}}));
});
test('real Hypit async endpoint waits for host approval, checkpoints stable receipt and collects local saved file',async()=>{
  let status='awaiting_confirmation',checkpoint;const calls=[];
  const provider=createVideoProvider({instance:'hamster.video',pool:'hamster.video',baseUrl:'http://127.0.0.1:12345',projectId:'project-1',token:'synthetic-local-capability',pollIntervalMs:0,fetch:async(url,init)=>{
    const p=new URL(url).pathname;calls.push({path:p,body:init.body&&JSON.parse(init.body)});
    assert.equal(new Headers(init.headers).get('authorization'),'Bearer synthetic-local-capability');
    if(p.endsWith('/file'))return new Response(new Uint8Array([4,5,6]),{headers:{'content-type':'video/mp4'}});
    if(p.endsWith('/quote')){assert.equal(JSON.parse(init.body).operationId,'shot-1-v1');return Response.json({requestId,status});}
    if(p.endsWith('/start')){assert.equal(status,'confirmed');status='queued';return Response.json({requestId,status});}
    return Response.json({requestId,status,...(status==='succeeded'?{result:{url:'/api/hypit/video/operations/'+requestId+'/file'}}:{})});
  }});
  const registry=new EndpointRegistry();await provider.install(registry);const resolved=registry.resolve(need);assert.equal(resolved.status,'resolved');
  const endpoint=resolved.registration.endpoint,resources=new MemoryResourceStore(),context={need,command:{kind:'fulfill-need',id:'command:video',need},operation:'build-specific-id',resources,credentials:{},checkpoint:async value=>checkpoint=value};
  const first=await endpoint.start(context);assert.equal(first.status,'pending');assert.deepEqual(checkpoint,{handle:{requestId},receipt:{requestId}});
  assert.equal((await endpoint.poll({...context,handle:first.handle})).status,'pending');assert.equal(calls.filter(c=>c.path.endsWith('/start')).length,0);
  status='confirmed';await endpoint.poll({...context,handle:first.handle});assert.equal(calls.filter(c=>c.path.endsWith('/start')).length,1);
  status='unknown';await endpoint.poll({...context,handle:first.handle});assert.equal(calls.filter(c=>c.path.endsWith('/start')).length,1);
  status='succeeded';const ready=await endpoint.poll({...context,handle:first.handle});assert.equal(ready.status,'ready');
  const collected=await endpoint.collect({...context,handle:ready.handle});assert.equal(collected.status,'completed');
  const video=collected.result.value.value.videos[0];assert.deepEqual(await resources.get(video.resource),new Uint8Array([4,5,6]));
  assert.ok(calls.every(c=>c.path.startsWith('/api/hypit/video/')));assert.ok(calls.every(c=>!c.path.endsWith('/confirm')));
});
test('provider does not forward credentials to remote URLs or expose transport error payload',async()=>{
  assert.throws(()=>createVideoProvider({instance:'v',pool:'v',projectId:'p',baseUrl:'https://example.invalid',token:'synthetic'}));
  let called=0;
  const provider=createVideoProvider({instance:'v',pool:'v',projectId:'p',baseUrl:'http://127.0.0.1:12345',token:'synthetic',fetch:async()=>{called++;throw Error('sk-private https://private.invalid private filesystem');}});
  const registry=new EndpointRegistry();await provider.install(registry);const endpoint=registry.resolve(need).registration.endpoint;
  await assert.rejects(endpoint.start({need}),e=>!/(sk-private|private.invalid|filesystem)/.test(e.message));assert.equal(called,1);
});
