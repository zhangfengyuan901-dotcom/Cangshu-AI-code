const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {createInteractionPreferences}=require('../interaction-preferences.cjs'),{createApp}=require('../server.js');
function fixture(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'hamster-interaction-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return {root,configPath:path.join(root,'config.json')};}
test('only two boolean preferences survive a new store; account configuration remains untouched',async t=>{
 const f=fixture(t);fs.writeFileSync(f.configPath,'synthetic-config');const store=createInteractionPreferences(f);assert.deepEqual(store.get(),{hoverVideo:true,reducedMotion:false});
 await Promise.all([store.set({hoverVideo:false,reducedMotion:false}),store.set({hoverVideo:false,reducedMotion:true})]);assert.deepEqual(createInteractionPreferences(f).get(),{hoverVideo:false,reducedMotion:true});assert.equal(fs.readFileSync(f.configPath,'utf8'),'synthetic-config');
 const copy=store.get();copy.hoverVideo=true;assert.equal(store.get().hoverVideo,false);assert.deepEqual(fs.readdirSync(f.root).sort(),['config.json','interaction-preferences.json']);
});
test('unknown fields, non-booleans and corrupt saved preferences fail closed',async t=>{
 const f=fixture(t),store=createInteractionPreferences(f);for(const value of [{},{hoverVideo:1,reducedMotion:false},{hoverVideo:true,reducedMotion:false,key:'synthetic'},null,[]])await assert.rejects(store.set(value));
 fs.writeFileSync(path.join(f.root,'interaction-preferences.json'),JSON.stringify({format:1,hoverVideo:false,reducedMotion:true,extra:'synthetic'}));assert.deepEqual(createInteractionPreferences(f).get(),{hoverVideo:true,reducedMotion:false});
});
test('local preferences API enforces exact Host/Origin and never initializes account or media services',async t=>{
 const f=fixture(t),app=createApp({...f,taskDir:path.join(f.root,'tasks'),assetDir:path.join(f.root,'assets'),resultDir:path.join(f.root,'results'),diagnosticsDir:path.join(f.root,'diagnostics'),smartVideoLauncher:{stop(){}}});await new Promise(resolve=>app.listen(0,'127.0.0.1',resolve));t.after(async()=>{app.closeAllConnections();await new Promise(resolve=>app.close(resolve));});const base='http://127.0.0.1:'+app.address().port,route=base+'/api/interaction-preferences';
 const data={hoverVideo:false,reducedMotion:true};assert.equal((await fetch(route,{method:'POST',headers:{'Content-Type':'application/json',Origin:'https://foreign.invalid'},body:JSON.stringify(data)})).status,403);
 assert.equal((await fetch(route,{method:'POST',headers:{'Content-Type':'application/json',Origin:base},body:JSON.stringify({...data,path:'synthetic'})})).status,400);
 assert.equal((await fetch(route,{method:'POST',headers:{'Content-Type':'application/json',Origin:base},body:JSON.stringify(data)})).status,200);assert.deepEqual((await (await fetch(route)).json()).uiPreferences,data);assert.equal(fs.existsSync(path.join(f.root,'assets')),false);
});
