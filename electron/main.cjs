const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

let server = null;

// One writer for the durable journal, including portable launches.
if (!app.requestSingleInstanceLock()) app.quit();
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
      fs.cpSync(source, target, { recursive: true, force: true });
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
  const { createApp } = require('../server.js');

  // 打包后 config.json 写到用户数据目录（asar 只读）；开发时写项目根目录
  const configPath = app.isPackaged
    ? path.join(app.getPath('userData'), 'config.json')
    : path.join(__dirname, '..', 'config.json');

  const smartVideoDir = prepareSmartVideoWorkflow();
  server = createApp({
    configPath,
    resultDir: path.join(app.getPath('desktop'), '仓鼠AI生成结果'),
    smartVideoDir,
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  createWindow(port);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow(port);
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    if (server) server.close();
    app.quit();
  }
});
