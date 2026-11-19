const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const root=path.resolve(__dirname,'..');
const mainSource=fs.readFileSync(path.join(root,'electron/main.cjs'),'utf8');
const serverSource=fs.readFileSync(path.join(root,'server.js'),'utf8');
const releaseSpec=JSON.parse(fs.readFileSync(path.join(root,'release/current.json'),'utf8'));

async function desktopStartup(mode,metadata={}){
  let ready,options,listen,stored=0,reporterOptions,diagnosticOptions,closed=0,accountOptions;
  const windows=[],external=[];
  const configuredPaths={},createdDirectories=[];
  const version=metadata.version||releaseSpec.version;
  const events={};
  const app={isPackaged:true,requestSingleInstanceLock:()=>true,on(name,handler){events[name]=handler;},quit(){},
    whenReady:()=>({then:fn=>{ready=Promise.resolve().then(fn);}}),
    getPath:name=>configuredPaths[name]||path.join('candidate-fixture',name),setPath:(name,value)=>{configuredPaths[name]=value;},getVersion:()=>version};
  class BrowserWindow {
    constructor(config){this.config=config;this.webContents={on(){},setWindowOpenHandler:handler=>{this.openHandler=handler;}};windows.push(this);}
    loadURL(url){this.url=url;}
    setMenu(){} setMenuBarVisibility(){}
    static getAllWindows(){return windows;}
  }
  const server={listening:false,once(){},listen(port,host,resolve){listen={port,host};this.listening=true;resolve();},
    address:()=>({port:12345}),close(){this.listening=false;closed++;}};
  const modules={
    electron:{app,BrowserWindow,dialog:{showMessageBox:async()=>{}},safeStorage:{},shell:{openExternal:async url=>{external.push(url);}}},
    'node:fs':{...fs,mkdirSync:(directory)=>{createdDirectories.push(directory);}},'node:path':path,
    '../package.json':metadata,
    './navigation.cjs':require('../electron/navigation.cjs'),
    './work-directory.cjs':{createWorkDirectory:({defaultDirectory})=>({resultDir:path.join(defaultDirectory,'仓鼠AI生成结果'),assetDir:path.join(defaultDirectory,'仓鼠AI资产库')}),bindWorkDirectory(){}},
    './account-desktop.cjs':{createDesktopAccount:input=>{accountOptions=input;return {dispose(){}};}},
    '../server.js':{createApp:input=>{options=input;return server;}},
    '../reporter.cjs':{createReporter:input=>{reporterOptions=input;return {capture(){},close(){}};}},
    '../diagnostics.cjs':{createDiagnostics:input=>{diagnosticOptions=input;return {log(){},failure(){}};},classifyFailure:()=>({})},
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
  return {options,listen,stored,windows,external,configuredPaths,createdDirectories,reporterOptions,diagnosticOptions,events,accountOptions,closed:()=>closed};
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
    assert.equal(state.options.accountView,undefined);
    assert.equal(state.accountOptions.appUrl,'http://127.0.0.1:12345/');
    assert.equal(state.accountOptions.journalFile,path.join('candidate-fixture','userData','account-operations.json'));
  }
});

test('explicit zero remains an internal desktop legacy override',async()=>{
  const state=await desktopStartup('0');
  assert.equal(state.options.relayMode,false);assert.equal(state.options.walletMode,true);
  assert.equal(state.options.relayKeyStore,undefined);assert.equal(state.stored,0);
});

test('internal metadata isolates configuration, sessions, workflow, assets, results and disables real reporting',async()=>{
  const version='1.7.49-internal.20261021.1';
  const state=await desktopStartup(undefined,{hamsterInternalCandidate:true,version});
  const directory=path.join('candidate-fixture','appData','hamster-ai-internal',version);
  assert.equal(state.configuredPaths.userData,directory);
  assert.equal(state.configuredPaths.sessionData,path.join(directory,'session'));
  assert.deepEqual(state.createdDirectories,[path.join(directory,'session')]);
  assert.equal(state.options.configPath,path.join(directory,'config.json'));
  assert.equal(state.options.relayKeyStore.input.file,path.join(directory,'pikno-keys.bin'));
  assert.equal(state.options.resultDir,path.join(directory,'results'));
  assert.equal(state.options.assetDir,path.join(directory,'assets'));
  assert.equal(state.diagnosticOptions.dir,path.join(directory,'diagnostics'));
  assert.equal(state.diagnosticOptions.exportDir,path.join(directory,'diagnostic-exports'));
  assert.equal(state.reporterOptions.dir,path.join(directory,'fault-reports'));
  assert.equal(state.reporterOptions.enabled,false);
  assert.equal(state.options.hypitOptions.enabled,false);
  assert.equal(Object.hasOwn(state.options,'chatcutOptions'),false);
  assert.match(mainSource,/path\.join\(app\.getPath\('userData'\), 'smart-video-agent'\)/);
});

test('public package data paths and automatic reporting stay unchanged',async()=>{
  const state=await desktopStartup();
  assert.deepEqual(state.configuredPaths,{});assert.deepEqual(state.createdDirectories,[]);
  assert.equal(state.options.configPath,path.join('candidate-fixture','userData','config.json'));
  assert.equal(state.options.resultDir,path.join('candidate-fixture','desktop','仓鼠AI生成结果'));
  assert.equal(state.options.assetDir,path.join('candidate-fixture','desktop','仓鼠AI资产库'));
  assert.equal(state.reporterOptions.enabled,true);
  assert.equal(state.diagnosticOptions.exportDir,path.join('candidate-fixture','desktop','仓鼠AI诊断'));
});

test('internal metadata rejects a non-internal version before touching local paths',async()=>{
  await assert.rejects(desktopStartup(undefined,{hamsterInternalCandidate:true,version:'1.7.49'}),/Invalid internal candidate version/);
});

test('only explicit approved external shortcuts open the OS browser and all popup windows are denied',async()=>{
  const state=await desktopStartup();
  const open=state.windows[0].openHandler;
  assert.equal(open({url:'https://www.piknoai.com/'}).action,'deny');
  assert.equal(open({url:'https://www.piknoai.com/register'}).action,'deny');
  await Promise.resolve();
  assert.deepEqual(state.external,['https://www.piknoai.com/','https://www.piknoai.com/register']);
  assert.equal(open({url:'https://fixture:credential@www.piknoai.com/'}).action,'deny');
  assert.equal(state.external.length,2);
  assert.equal(open({url:'http://127.0.0.1:12345/creative/'}).action,'deny');
  assert.equal(open({url:'https://www.piknoai.com.evil.test/'}).action,'deny');
  assert.equal(open({url:'http://www.piknoai.com/'}).action,'deny');
  await Promise.resolve();
  assert.equal(state.external.length,2);
});

test('quitting the desktop closes its owned local services once, including menu quit',async()=>{
  const state=await desktopStartup();
  state.events['before-quit']();state.events['before-quit']();
  assert.equal(state.closed(),1);
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
  assert.equal(pkg.version,releaseSpec.version);assert.equal(lock.version,pkg.version);
  assert.equal(lock.packages[''].version,pkg.version);
});
