const { app, BrowserWindow, dialog, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

let server = null;

// One writer for the durable journal, including portable launches.
const ownsInstance=app.requestSingleInstanceLock();
if (!ownsInstance) app.quit();
app.on('second-instance', () => {
  const win = BrowserWindow.getAllWindows()[0];
  if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); }
});

function prepareSmartVideoWorkflow() {
  const source = app.isPackaged
    ? path.join(process.resourcesPath, 'smart-video-agent')
    : path.join(__dirname, '..', 'smart-video-agent');
  const target = app.isPackaged
    ? path.join(app.getPath('userData'), 'smart-video-agent')
    : source;
  if (app.isPackaged) {
    const marker = '.hamster-workflow-version';
    const sourceVersion = fs.readFileSync(path.join(source, marker), 'utf8').trim();
    const targetVersion = fs.existsSync(path.join(target, marker))
      ? fs.readFileSync(path.join(target, marker), 'utf8').trim()
      : '';
    if (sourceVersion !== targetVersion) {
      // Commit the version marker only after every workflow file copied successfully.
      fs.cpSync(source, target, { recursive: true, force: true,filter:entry=>path.basename(entry)!==marker });
      fs.copyFileSync(path.join(source,marker),path.join(target,marker));
    }
  }
  const configPath = path.join(target, 'config.yaml');
  if (!fs.existsSync(configPath)) fs.copyFileSync(path.join(target, 'config.yaml.example'), configPath);
  return target;
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
  win.loadURL(`http://127.0.0.1:${port}/`);
  return win;
}

app.whenReady().then(async () => {
  if(!ownsInstance)return;
  const { createApp } = require('../server.js');

  // 打包后 config.json 写到用户数据目录（asar 只读）；开发时写项目根目录
  const configPath = app.isPackaged
    ? path.join(app.getPath('userData'), 'config.json')
    : path.join(__dirname, '..', 'config.json');

  const {createDiagnostics,classifyFailure}=require('../diagnostics.cjs');
  const diagnostics=createDiagnostics({dir:path.join(path.dirname(configPath),'diagnostics'),
    exportDir:path.join(app.getPath('desktop'),'仓鼠AI诊断'),configPath,version:app.getVersion()});
  diagnostics.log('desktop-start',{version:app.getVersion(),packaged:app.isPackaged});
  try {
  const smartVideoDir = prepareSmartVideoWorkflow();
  const {createRuntimeProvider}=require('../runtime.cjs');
  const runtimeProvider=app.isPackaged?createRuntimeProvider({resourcesDir:process.resourcesPath,
    cacheDir:path.join(app.getPath('userData'),'runtimes'),diagnostics}):undefined;
  server = createApp({
    configPath,
    resultDir: path.join(app.getPath('desktop'), '仓鼠AI生成结果'),
    smartVideoDir,
    diagnostics,
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
    const failure=classifyFailure(String(error),'应用初始化失败，请导出诊断信息');diagnostics.failure(failure);
    const result=await dialog.showMessageBox({type:'error',title:'仓鼠AI启动失败',message:failure.message,buttons:['导出诊断信息','关闭'],defaultId:0,cancelId:1});
    if(result.response===0){
      try{const report=diagnostics.exportReport({stage:'desktop-initialization'});shell.showItemInFolder(report.localPath);}
      catch{dialog.showErrorBox('导出失败','无法写入桌面诊断目录，请检查文件夹权限。');}
    }
    server?.close();app.quit();
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    if (server) server.close();
    app.quit();
  }
});
