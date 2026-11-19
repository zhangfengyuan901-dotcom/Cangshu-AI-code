const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const root=path.resolve(__dirname,'..');
const mainSource=fs.readFileSync(path.join(root,'electron/main.cjs'),'utf8');
const serverSource=fs.readFileSync(path.join(root,'server.js'),'utf8');

async function desktopStartup(mode){
  let ready,options,listen,stored=0;
  const windows=[],external=[];
  const app={isPackaged:true,requestSingleInstanceLock:()=>true,on(){},quit(){},
    whenReady:()=>({then:fn=>{ready=Promise.resolve().then(fn);}}),
    getPath:name=>path.join('candidate-fixture',name),getVersion:()=> '1.7.46'};
  class BrowserWindow {
    constructor(config){this.config=config;this.webContents={setWindowOpenHandler:handler=>{this.openHandler=handler;}};windows.push(this);}
    loadURL(url){this.url=url;}
    static getAllWindows(){return windows;}
  }
  const server={once(){},listen(port,host,resolve){listen={port,host};resolve();},
    address:()=>({port:12345}),close(){}};
  const modules={
    electron:{app,BrowserWindow,dialog:{showMessageBox:async()=>{}},safeStorage:{},shell:{openExternal:async url=>{external.push(url);}}},
    'node:fs':fs,'node:path':path,
    '../server.js':{createApp:input=>{options=input;return server;}},
    '../reporter.cjs':{createReporter:()=>({capture(){},close(){}})},
    '../diagnostics.cjs':{createDiagnostics:()=>({log(){},failure(){}}),classifyFailure:()=>({})},
    '../runtime.cjs':{createRuntimeProvider:()=>()=>{}},
    '../installed-runtime.cjs':{createInstalledRuntimeProvider:()=>()=>{}},
    '../pikno-key-store.cjs':{createPiknoKeyStore:input=>{stored++;return {fixture:true,input};}},
  };
  vm.runInNewContext(mainSource,{
    require:name=>{assert.ok(Object.hasOwn(modules,name),`Unexpected startup module: ${name}`);return modules[name];},
    __dirname:path.join(root,'electron'),URL,
    process:{env:mode===undefined?{}:{HAMSTER_PIKNO_MODE:mode},argv:[],resourcesPath:'candidate-resources',on(){},platform:'win32'},
  },{filename:'electron/main.cjs'});
  await ready;
  return {options,listen,stored,windows,external};
}

function directStartup(mode){
  let options,listen,url;
  const module={exports:{}};
  const require=()=>assert.fail('Entrypoint unexpectedly required a module');
  require.main=module;
  vm.runInNewContext(serverSource.slice(serverSource.indexOf('if (require.main === module)')),
    {require,module,process:{env:mode===undefined?{}:{HAMSTER_PIKNO_MODE:mode}},
      createApp:input=>{options=input;return {listen:(port,host,ready)=>{listen={port,host};ready();}};},
      openBrowser:target=>{url=target;},createSmartVideoLauncher(){},findSmartVideoDir(){},console:{log(){}}},
    {filename:'server.js entrypoint'});
  return {options,listen,url};
}

test('desktop candidate defaults to PIKNO relay without exposing or reading a real Key',async()=>{
  for(const mode of [undefined,'1','','unexpected']){
    const state=await desktopStartup(mode);
    assert.equal(state.options.relayMode,true);assert.equal(state.options.walletMode,false);
    assert.equal(state.stored,1);assert.equal(state.options.relayKeyStore.fixture,true);
    assert.deepEqual(state.listen,{port:0,host:'127.0.0.1'});
    assert.equal(state.windows[0].url,'http://127.0.0.1:12345/');
    assert.equal(state.windows[0].config.webPreferences.contextIsolation,true);
    assert.equal(state.windows[0].config.webPreferences.nodeIntegration,false);
  }
});

test('explicit zero remains an internal desktop legacy override',async()=>{
  const state=await desktopStartup('0');
  assert.equal(state.options.relayMode,false);assert.equal(state.options.walletMode,true);
  assert.equal(state.options.relayKeyStore,undefined);assert.equal(state.stored,0);
});

test('PIKNO registration opens externally without popup or URL credentials; other windows keep existing behavior',async()=>{
  const state=await desktopStartup();
  const open=state.windows[0].openHandler;
  assert.equal(open({url:'https://www.piknoai.com/'}).action,'deny');
  assert.equal(open({url:'https://www.piknoai.com/register'}).action,'deny');
  assert.deepEqual(state.external,['https://www.piknoai.com/','https://www.piknoai.com/register']);
  assert.equal(open({url:'https://fixture:credential@www.piknoai.com/'}).action,'deny');
  assert.equal(state.external.length,2);
  assert.equal(open({url:'http://127.0.0.1:12345/creative/'}).action,'allow');
  assert.equal(open({url:'https://www.piknoai.com.evil.test/'}).action,'allow');
  assert.equal(open({url:'http://www.piknoai.com/'}).action,'allow');
  assert.equal(state.external.length,2);
});

test('direct candidate starts relay mode on loopback with a bridge-compatible browser host',()=>{
  for(const mode of [undefined,'1','','unexpected']){
    const state=directStartup(mode);
    assert.equal(state.options.relayMode,true);assert.equal(state.options.walletMode,false);
    assert.deepEqual(state.listen,{port:8787,host:'127.0.0.1'});
    assert.equal(state.url,'http://127.0.0.1:8787');
  }
  const legacy=directStartup('0');
  assert.equal(legacy.options.relayMode,false);assert.equal(legacy.options.walletMode,true);
  assert.equal(legacy.listen.host,'127.0.0.1');
});

test('factory defaults stay legacy-compatible while candidate package versions agree',()=>{
  const signature=serverSource.slice(serverSource.indexOf('function createApp({'),serverSource.indexOf('} = {}) {',serverSource.indexOf('function createApp({')));
  assert.match(signature,/walletMode = false/);assert.match(signature,/relayMode = false/);
  const pkg=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'));
  const lock=JSON.parse(fs.readFileSync(path.join(root,'package-lock.json'),'utf8'));
  assert.equal(pkg.version,'1.7.49');assert.equal(lock.version,pkg.version);
  assert.equal(lock.packages[''].version,pkg.version);
});
