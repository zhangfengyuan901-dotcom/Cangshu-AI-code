const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http');
const {createStartupPreferences,MAX_BYTES}=require('../startup-preferences.cjs');
const {createApp}=require('../server.js');

function directory(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'hamster-ui-preferences-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root;}
const preferencePath=root=>path.join(root,'ui-preferences.json');
const configPath=root=>path.join(root,'config.json');
const request=(base,route,options={})=>new Promise((resolve,reject)=>{
  const body=options.body===undefined?undefined:typeof options.body==='string'?options.body:JSON.stringify(options.body);
  const req=http.request(base+route,{method:options.method||'GET',headers:{...(body===undefined?{}:{'Content-Type':'application/json'}),...options.headers}},res=>{
    const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>{const text=Buffer.concat(chunks).toString('utf8');resolve({status:res.statusCode,headers:res.headers,text,data:JSON.parse(text)});});
  });req.on('error',reject);req.end(body);
});
async function server(t,root,options={}){
  const calls=[];
  const app=createApp({configPath:configPath(root),assetDir:path.join(root,'assets'),resultDir:path.join(root,'results'),taskDir:path.join(root,'tasks'),diagnosticsDir:path.join(root,'diagnostics'),smartVideoLauncher:{stop(){}},relayMode:true,
    relayClient:new Proxy({},{get:(_target,property)=>['stop','invalidate'].includes(property)?()=>{}:()=>{calls.push(property);throw Error('Upstream must not be called');}}),
    relayKeyStore:{persistent:true,read:()=>({piknoUserId:7,piknoChatKey:'sk-'+'a'.repeat(32)})},...options});
  await new Promise(resolve=>app.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{if(app.listening){app.closeAllConnections();await new Promise(resolve=>app.close(resolve));}});
  return {app,calls,base:`http://127.0.0.1:${app.address().port}`};
}

test('preferences persist only a safe page beside config and survive a new store',async t=>{
  const root=directory(t),cfg=configPath(root),secret='private-configuration-unchanged';fs.writeFileSync(cfg,secret);
  const store=createStartupPreferences({configPath:cfg});assert.deepEqual(store.get(),{lastView:null});
  for(const view of ['generate','chat','digital','depth','assets','canvas','history','account'])assert.deepEqual(await store.set({lastView:view}),{lastView:view});
  assert.deepEqual(JSON.parse(fs.readFileSync(preferencePath(root))),{format:1,lastView:'account'});
  assert.equal(fs.readFileSync(cfg,'utf8'),secret);
  assert.deepEqual(createStartupPreferences({configPath:cfg}).get(),{lastView:'account'});
  const returned=store.get();returned.lastView='chat';assert.deepEqual(store.get(),{lastView:'account'});
  assert.throws(()=>createStartupPreferences({configPath:preferencePath(root)}),/Invalid preferences location/);
});

test('invalid, oversized and unknown-format saved state fail closed without rewriting it',t=>{
  const root=directory(t),file=preferencePath(root);
  for(const value of ['{bad',JSON.stringify({format:2,lastView:'chat'}),JSON.stringify({format:1,lastView:'hypit'}),JSON.stringify({format:1,lastView:'chat',token:'private'}),' '.repeat(MAX_BYTES+1)]){
    fs.writeFileSync(file,value);assert.deepEqual(createStartupPreferences({configPath:configPath(root)}).get(),{lastView:null});assert.equal(fs.readFileSync(file,'utf8'),value);
  }
});

test('invalid input cannot cache credentials, paths, internal tools or arbitrary fields',async t=>{
  const root=directory(t),store=createStartupPreferences({configPath:configPath(root)});
  for(const value of [null,[],{},'chat',{lastView:null},{lastView:'CHAT'},{lastView:'hypit'},{lastView:'chatcut'},{lastView:'../config.json'},{lastView:'https://private.invalid'},{lastView:'chat',key:'sk-private'},{lastView:'chat',accountId:7},{lastView:'chat',path:'C:/private'},{lastView:'chat',activated:true},JSON.parse('{"lastView":"chat","__proto__":{}}')])await assert.rejects(store.set(value),/Invalid preferences/);
  assert.equal(fs.existsSync(preferencePath(root)),false);
});

test('serialized atomic saves preserve call order even if the first write is delayed',async t=>{
  const root=directory(t);let release,started;
  const firstStarted=new Promise(resolve=>{started=resolve;}),gate=new Promise(resolve=>{release=resolve;});let writes=0;
  const fsImpl={...fs,promises:{...fs.promises,writeFile:async(...args)=>{if(++writes===1){started();await gate;}return fs.promises.writeFile(...args);}}};
  const store=createStartupPreferences({configPath:configPath(root),fsImpl});
  const first=store.set({lastView:'chat'});await firstStarted;const second=store.set({lastView:'canvas'});
  assert.equal(writes,1);assert.deepEqual(store.get(),{lastView:null});assert.equal(fs.existsSync(preferencePath(root)),false);
  release();assert.deepEqual(await first,{lastView:'chat'});assert.deepEqual(await second,{lastView:'canvas'});
  assert.deepEqual(createStartupPreferences({configPath:configPath(root)}).get(),{lastView:'canvas'});
  assert.deepEqual(fs.readdirSync(root).filter(name=>name.startsWith('ui-preferences')),['ui-preferences.json']);
});

test('failed atomic replacement keeps old preference and permits a later successful save',async t=>{
  const root=directory(t);fs.writeFileSync(preferencePath(root),JSON.stringify({format:1,lastView:'chat'}));let fail=true;
  const fsImpl={...fs,promises:{...fs.promises,rename:async(...args)=>{if(fail)throw Error('private location');return fs.promises.rename(...args);}}};
  const store=createStartupPreferences({configPath:configPath(root),fsImpl});
  await assert.rejects(store.set({lastView:'canvas'}),/private location/);assert.deepEqual(store.get(),{lastView:'chat'});
  assert.deepEqual(JSON.parse(fs.readFileSync(preferencePath(root))),{format:1,lastView:'chat'});assert.deepEqual(fs.readdirSync(root),['ui-preferences.json']);
  fail=false;await store.set({lastView:'digital'});assert.deepEqual(createStartupPreferences({configPath:configPath(root)}).get(),{lastView:'digital'});
});

test('GET and light startup use only local state and defer asset initialization',async t=>{
  const root=directory(t);fs.writeFileSync(configPath(root),JSON.stringify({private:'unchanged'}));
  const f=await server(t,root);const first=await request(f.base,'/api/startup?light=1');
  assert.equal(first.status,200);assert.equal(first.headers['cache-control'],'no-store');assert.equal(first.data.config.chatConfigured,true);
  assert.deepEqual(first.data.uiPreferences,{lastView:null});assert.equal(Object.hasOwn(first.data,'assets'),false);
  const prefs=await request(f.base,'/api/ui-preferences');assert.deepEqual(prefs.data,{uiPreferences:{lastView:null}});assert.equal(prefs.headers['cache-control'],'no-store');
  assert.deepEqual(f.calls,[]);assert.equal(fs.existsSync(path.join(root,'assets')),false);assert.equal(fs.existsSync(path.join(root,'tasks')),false);
  assert.doesNotMatch(first.text+prefs.text,/sk-|piknoUserId|private|accountId|authorized|connected/);
  const full=await request(f.base,'/api/startup');assert.equal(full.status,200);assert.deepEqual(Object.keys(full.data).sort(),['assets','config']);
  assert.deepEqual(full.data.assets,{total:0,counts:{talent:0,product:0,scene:0}});assert.equal(fs.existsSync(path.join(root,'assets')),true);assert.deepEqual(f.calls,[]);
});

test('stored page survives closing and reopening the server on a different loopback port',async t=>{
  const root=directory(t),first=await server(t,root);
  const saved=await request(first.base,'/api/ui-preferences',{method:'POST',headers:{Origin:first.base},body:{lastView:'canvas'}});
  assert.equal(saved.status,200);assert.deepEqual(saved.data,{uiPreferences:{lastView:'canvas'}});assert.equal(saved.headers['cache-control'],'no-store');
  const second=await server(t,root);assert.notEqual(second.base,first.base);
  first.app.closeAllConnections();await new Promise(resolve=>first.app.close(resolve));
  assert.deepEqual((await request(second.base,'/api/startup?light=1')).data.uiPreferences,{lastView:'canvas'});
  assert.deepEqual((await request(second.base,'/api/ui-preferences')).data,{uiPreferences:{lastView:'canvas'}});
  assert.deepEqual(first.calls,[]);assert.deepEqual(second.calls,[]);
});

test('preferences enforce same loopback host and origin even outside relay mode',async t=>{
  const root=directory(t),f=await server(t,root,{relayMode:false});
  for(const headers of [{Host:'evil.invalid'},{Host:'127.0.0.1:1'},{Origin:'https://evil.invalid'},{'Sec-Fetch-Site':'cross-site'}]){
    for(const route of ['/api/ui-preferences','/api/startup?light=1']){
      const result=await request(f.base,route,{headers});assert.equal(result.status,403);assert.equal(result.headers['cache-control'],'no-store');
    }
    assert.equal((await request(f.base,'/api/ui-preferences',{method:'POST',headers,body:{lastView:'chat'}})).status,403);
  }
  assert.equal(fs.existsSync(preferencePath(root)),false);
});

test('HTTP malformed or oversized bodies never alter preferences and expose only safe errors',async t=>{
  const root=directory(t),f=await server(t,root);
  assert.equal((await request(f.base,'/api/ui-preferences',{method:'POST',body:{lastView:'chat'}})).status,200);
  for(const body of ['{bad','',null,[],{}, {lastView:'chat',token:'private'}, {lastView:'hypit'},{lastView:'../config.json'}]){
    const result=await request(f.base,'/api/ui-preferences',{method:'POST',body:body===null?'null':body});assert.equal(result.status,400);assert.equal(result.headers['cache-control'],'no-store');assert.deepEqual(result.data,{error:'页面偏好无效'});
  }
  for(const headers of [{},{'Content-Length':String(MAX_BYTES+1)}])assert.equal((await request(f.base,'/api/ui-preferences',{method:'POST',headers,body:' '.repeat(MAX_BYTES+1)})).status,413);
  assert.equal((await request(f.base,'/api/ui-preferences',{method:'POST',headers:{'Content-Type':'text/plain'},body:'{"lastView":"chat"}'})).status,415);
  assert.equal((await request(f.base,'/api/ui-preferences',{method:'DELETE'})).status,405);
  assert.deepEqual((await request(f.base,'/api/ui-preferences')).data,{uiPreferences:{lastView:'chat'}});
  assert.deepEqual(JSON.parse(fs.readFileSync(preferencePath(root))),{format:1,lastView:'chat'});
});

test('HTTP write failures retain live state and never return filesystem errors or locations',async t=>{
  const root=directory(t),f=await server(t,root);fs.mkdirSync(preferencePath(root));
  const failed=await request(f.base,'/api/ui-preferences',{method:'POST',body:{lastView:'chat'}});
  assert.equal(failed.status,503);assert.equal(failed.headers['cache-control'],'no-store');assert.deepEqual(failed.data,{error:'页面偏好暂时无法保存'});
  assert.doesNotMatch(failed.text,/ENOENT|EPERM|EISDIR|ui-preferences|hamster-ui-preferences/);
  assert.deepEqual((await request(f.base,'/api/ui-preferences')).data,{uiPreferences:{lastView:null}});
  assert.deepEqual(fs.readdirSync(root).filter(name=>name.startsWith('ui-preferences')),['ui-preferences.json']);
  fs.rmdirSync(preferencePath(root));assert.equal((await request(f.base,'/api/ui-preferences',{method:'POST',body:{lastView:'chat'}})).status,200);
});
