const { app, BrowserWindow, dialog, safeStorage, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

let server = null;
let reporter;
process.on('uncaughtExceptionMonitor',error=>reporter?.capture('desktop',error,{code:'PROCESS_CRASH'}));
app.on('render-process-gone',(_event,_contents,details)=>reporter?.capture('desktop',{}, {code:'RENDERER_CRASH',exitCode:details.exitCode}));
app.on('before-quit',()=>reporter?.close());
let smartVideoWorkflowPromise = null;

// One writer for the durable journal, including portable launches.
const installingRuntime=app.isPackaged && process.argv.includes('--hamster-prepare-installed-runtime');
const removingRuntime=app.isPackaged && process.argv.includes('--hamster-remove-installed-runtime');
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
  const target = app.isPackaged
    ? path.join(app.getPath('userData'), 'smart-video-agent')
    : source;
  if (app.isPackaged) {
    await require('./workflow-sync.cjs').syncWorkflow(source, target, app.getVersion());
  }
  const configPath = path.join(target, 'config.yaml');
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

function createWindow(port) {
  const win = new BrowserWindow({
    width: 1200,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    autoHideMenuBar: true,
    title: '仓鼠AI',
    icon: path.join(__dirname, '..', 'public', 'hamster-logo.png'),
    backgroundColor: '#f4f5f2',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.webContents.setWindowOpenHandler(({url}) => {
    let target;
    try { target = new URL(url); } catch { return {action:'allow'}; }
    if (target.origin !== 'https://www.piknoai.com') return {action:'allow'};
    if (!target.username && !target.password) {
      void shell.openExternal(target.href).catch(() => {});
    }
    return {action:'deny'};
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
  const { createApp } = require('../server.js');
  reporter=require('../reporter.cjs').createReporter({dir:path.join(app.getPath('userData'),'fault-reports'),version:app.getVersion(),enabled:app.isPackaged});

  // 打包后 config.json 写到用户数据目录（asar 只读）；开发时写项目根目录
  const configPath = app.isPackaged
    ? path.join(app.getPath('userData'), 'config.json')
    : path.join(__dirname, '..', 'config.json');

  const {createDiagnostics,classifyFailure}=require('../diagnostics.cjs');
  const diagnostics=createDiagnostics({dir:path.join(path.dirname(configPath),'diagnostics'),
    exportDir:path.join(app.getPath('desktop'),'仓鼠AI诊断'),configPath,version:app.getVersion(),reporter});
  diagnostics.log('desktop-start',{version:app.getVersion(),packaged:app.isPackaged});
  try {
  const {createRuntimeProvider}=require('../runtime.cjs');
  const {createInstalledRuntimeProvider}=require('../installed-runtime.cjs');
  const installed=app.isPackaged && !process.env.PORTABLE_EXECUTABLE_FILE;
  const runtimeProvider=app.isPackaged?(installed
    ?createInstalledRuntimeProvider({resourcesDir:process.resourcesPath,diagnostics})
    :createRuntimeProvider({resourcesDir:process.resourcesPath,cacheDir:path.join(app.getPath('userData'),'runtimes'),diagnostics})):undefined;
  // The PIKNO candidate defaults to relay mode; '0' is an internal legacy override.
  const relayMode=process.env.HAMSTER_PIKNO_MODE!=='0';
  const relayKeyStore=relayMode?require('../pikno-key-store.cjs').createPiknoKeyStore({
    file:path.join(app.getPath('userData'),'pikno-keys.bin'),cipher:safeStorage,
  }):undefined;
  server = createApp({
    walletMode:!relayMode,
    relayMode,
    relayKeyStore,
    configPath,
    resultDir: path.join(app.getPath('desktop'), '仓鼠AI生成结果'),
    smartVideoDir: getSmartVideoWorkflow,
    diagnostics,
    reporter,
    runtimeProvider,
  });
  await new Promise((resolve,reject) => {server.once('error',reject);server.listen(0, '127.0.0.1', resolve);});
  const port = server.address().port;
  createWindow(port);
  diagnostics.log('desktop-ready',{port});

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow(port);
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
