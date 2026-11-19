const { app, BrowserWindow, dialog, ipcMain, net, safeStorage, shell, utilityProcess } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

// Internal candidates never reuse the public application's local data.
const candidateMetadata=app.isPackaged?require('../package.json'):{};
const internalCandidate=app.isPackaged && candidateMetadata.hamsterInternalCandidate===true;
if(internalCandidate){
  if(!/^\d+\.\d+\.\d+-internal\.\d{8}\.\d+$/.test(app.getVersion()))throw Error('Invalid internal candidate version');
  // Only this known internal profile may be reused; never accept a path from metadata.
  const profile=candidateMetadata.hamsterInternalProfile??app.getVersion();
  if(profile!==app.getVersion() && profile!=='1.7.49-internal.20261021.2')throw Error('Invalid internal candidate profile');
  const directory=path.join(app.getPath('appData'),'hamster-ai-internal',profile);
  fs.mkdirSync(path.join(directory,'session'),{recursive:true});
  app.setPath('userData',directory);
  app.setPath('sessionData',path.join(directory,'session'));
}
const internalDataRoot=internalCandidate?app.getPath('userData'):null;

let server = null;
let desktopAccount = null;
let reporter;
process.on('uncaughtExceptionMonitor',error=>reporter?.capture('desktop',error,{code:'PROCESS_CRASH'}));
app.on('render-process-gone',(_event,_contents,details)=>reporter?.capture('desktop',{}, {code:'RENDERER_CRASH',exitCode:details.exitCode}));
app.on('before-quit',()=>{desktopAccount?.dispose();if(server?.listening)server.close();reporter?.close();});
let smartVideoWorkflowPromise = null;

// One writer for the durable journal, including portable launches.
const installingRuntime=app.isPackaged && process.argv.includes('--hamster-prepare-installed-runtime');
const removingRuntime=app.isPackaged && process.argv.includes('--hamster-remove-installed-runtime');
const installed=app.isPackaged && !process.env.PORTABLE_EXECUTABLE_FILE;
const ownsInstance=installingRuntime || removingRuntime || app.requestSingleInstanceLock();
if (!ownsInstance) app.quit();
app.on('second-instance', () => {
  const win = BrowserWindow.getAllWindows()[0];
  if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); }
});

async function prepareSmartVideoWorkflow() {
  const source = app.isPackaged
    ? path.join(process.resourcesPath, 'smart-video-agent')
    : path.join(__dirname, '..', 'smart-video-agent');
  if (installed) return source;
  const target = app.isPackaged
    ? path.join(app.getPath('userData'), 'smart-video-agent')
    : source;
  if (app.isPackaged) {
    await require('./workflow-sync.cjs').syncWorkflow(source, target, app.getVersion());
  }
  const localWorkflowData = app.isPackaged ? target : path.join(require('../server.js').workspaceDataDir(), 'smart-video-agent');
  await fs.promises.mkdir(localWorkflowData, {recursive:true});
  const configPath = path.join(localWorkflowData, 'config.yaml');
  try { await fs.promises.access(configPath); }
  catch { await fs.promises.copyFile(path.join(target, 'config.yaml.example'), configPath); }
  return target;
}

function getSmartVideoWorkflow() {
  if (!smartVideoWorkflowPromise) {
    smartVideoWorkflowPromise = Promise.resolve().then(prepareSmartVideoWorkflow).catch((error) => {
      smartVideoWorkflowPromise = null;
      throw error;
    });
  }
  return smartVideoWorkflowPromise;
}

function createWindow(port,workDirectory) {
  const win = new BrowserWindow({
    width: 1200,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    autoHideMenuBar: true,
    ...(process.platform === 'win32' ? {
      titleBarStyle: 'hidden',
      titleBarOverlay: {color:'#eef3f8',symbolColor:'#53616f',height:46},
    } : {}),
    title: '仓鼠AI',
    icon: path.join(__dirname, '..', 'public', 'hamster-logo.png'),
    backgroundColor: '#f8fafc',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname,'app-events.cjs'),
    },
  });
  require('./navigation.cjs').installNavigationPolicy(win.webContents, {
    appUrl:`http://127.0.0.1:${port}/`,openExternal:target=>shell.openExternal(target),
  });
  if(workDirectory)require('./work-directory.cjs').bindWorkDirectory({window:win,ipcMain,dialog,
    appUrl:`http://127.0.0.1:${port}/`,store:workDirectory});
  desktopAccount=require('./account-desktop.cjs').createDesktopAccount({window:win,electron:require('electron'),appUrl:`http://127.0.0.1:${port}/`,journalFile:path.join(app.getPath('userData'),'account-operations.json'),
    connectCreatedKey:(value,options)=>server.connectCreatedRelayKey(value,options),
    getConnectedAccountId:()=>server.getConnectedRelayAccountId(),
    getConfiguredGroups:()=>server.getConnectedRelayGroups(),
    browserCipher:safeStorage,openExternal:target=>shell.openExternal(target),
    onConfigured:()=>{if(!win.isDestroyed()&&!win.webContents.isDestroyed())win.webContents.send('hamster-relay-configured');},
    reportFailure:clean=>reporter?.capture('account',{},clean),
  });
  win.loadURL(`http://127.0.0.1:${port}/`);
  return win;
}

app.whenReady().then(async () => {
  if(!ownsInstance)return;
  if(installingRuntime || removingRuntime){
    // Invoked synchronously by NSIS before the finish page, without a window,
    // singleton ownership, browser launch, or access to the customer's config.
    const logFile=path.join(process.resourcesPath,'runtime-install.log');
    const diagnostics={log:(event,data={})=>fs.appendFileSync(logFile,JSON.stringify({time:new Date().toISOString(),event,...data})+'\n')};
    try{
      diagnostics.log(removingRuntime?'uninstall-runtime-start':'install-start',{version:app.getVersion()});
      const runtime=require('../installed-runtime.cjs');
      if(removingRuntime)await runtime.removeInstalledRuntime({resourcesDir:process.resourcesPath});
      else await runtime.prepareInstalledRuntime({resourcesDir:process.resourcesPath,diagnostics});
      app.exit(0);
    }catch(error){
      try{diagnostics.log('install-failed',{code:error.code || 'INSTALL_RUNTIME_FAILED'});}catch{}
      app.exit(1);
    }
    return;
  }
  const { createApp, workspaceDataDir } = require('../server.js');
  const developmentData = !app.isPackaged ? workspaceDataDir() : null;
  if (developmentData) fs.mkdirSync(developmentData, {recursive:true});
  reporter=require('../reporter.cjs').createReporter({
    dir:app.isPackaged?path.join(app.getPath('userData'),'fault-reports'):path.join(developmentData,'diagnostics','fault-reports'),
    version:app.getVersion(),enabled:!internalCandidate,uploadEnabled:app.isPackaged&&!internalCandidate,
  });

  // 开发数据和已安装用户数据走各自的数据目录。
  const configPath = app.isPackaged
    ? path.join(app.getPath('userData'), 'config.json')
    : path.join(developmentData, 'config.json');

  const {createDiagnostics,classifyFailure}=require('../diagnostics.cjs');
  const diagnostics=createDiagnostics({dir:path.join(path.dirname(configPath),'diagnostics'),
    exportDir:internalCandidate?path.join(internalDataRoot,'diagnostic-exports'):path.join(app.getPath('desktop'),'仓鼠AI诊断'),configPath,version:app.getVersion(),reporter});
  diagnostics.log('desktop-start',{version:app.getVersion(),packaged:app.isPackaged});
  try {
  const {createRuntimeProvider}=require('../runtime.cjs');
  const {createInstalledRuntimeProvider}=require('../installed-runtime.cjs');
  const runtimeProvider=app.isPackaged?(installed
    ?createInstalledRuntimeProvider({resourcesDir:process.resourcesPath,diagnostics})
    :createRuntimeProvider({resourcesDir:process.resourcesPath,cacheDir:path.join(app.getPath('userData'),'runtimes'),diagnostics})):undefined;
  const relayMode=app.isPackaged || process.env.HAMSTER_PIKNO_MODE!=='0';
  const relayKeyStore=relayMode?require('../pikno-key-store.cjs').createPiknoKeyStore({
    file:path.join(app.getPath('userData'),'pikno-keys.bin'),cipher:safeStorage,
  }):undefined;
  const desktop=app.getPath('desktop');
  const workDirectory=internalCandidate?null:require('./work-directory.cjs').createWorkDirectory({
    userData:app.getPath('userData'),defaultDirectory:desktop,protectedDirectories:[
      app.isPackaged?path.dirname(process.resourcesPath):path.join(__dirname,'..'),
    ],
  });
  server = createApp({
    // Internal development only; never enable or bundle Hypit in the public release.
    hypitOptions:{enabled:!app.isPackaged},
    walletMode:!relayMode,
    relayMode,
    relayKeyStore,
    relayClient:relayMode?require('../pikno-client.cjs').createPiknoClient({
      uploadFetchImpl:require('./reference-upload.cjs').createReferenceUpload(net),
    }):undefined,
    configPath,
    resultDir: internalCandidate?path.join(internalDataRoot,'results'):workDirectory.resultDir,
    assetDir: internalCandidate?path.join(internalDataRoot,'assets'):workDirectory.assetDir,
    resultReadDirs:workDirectory?.resultReadDirs,
    assetReadDirs:workDirectory?.assetReadDirs,
    smartVideoDir: getSmartVideoWorkflow,
    chatDataDir: installed || developmentData ? path.join(developmentData || app.getPath('userData'), 'smart-video-agent', 'chat-data') : undefined,
    diagnostics,
    reporter,
    runtimeProvider,
    canvasUtilityProcess:app.isPackaged && process.platform==='win32'?utilityProcess:undefined,
  });
  await new Promise((resolve,reject) => {server.once('error',reject);server.listen(0, '127.0.0.1', resolve);});
  const port = server.address().port;
  createWindow(port,workDirectory);
  diagnostics.log('desktop-ready',{port});

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow(port,workDirectory);
  });
  } catch(error) {
    diagnostics.log('desktop-start-error',String(error));
    const failure=classifyFailure(String(error),'应用初始化失败，请稍后重试或联系支持');diagnostics.failure(failure);
    await dialog.showMessageBox({type:'error',title:'仓鼠AI启动失败',message:failure.message,detail:'故障信息会在后台脱敏反馈，网络恢复后自动补报。',buttons:['关闭']});
    server?.close();app.quit();
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    if (server) server.close();
    app.quit();
  }
});
