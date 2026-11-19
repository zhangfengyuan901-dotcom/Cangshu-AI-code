const fs = require('node:fs');
const path = require('node:path');
const {randomUUID} = require('node:crypto');

const STATUS = 'hamster-work-directory-status';
const CHOOSE = 'hamster-work-directory-choose';
const LIMIT = 64 * 1024;
const MAX_ROOTS = 128;
const RESULT_FOLDER = '仓鼠AI生成结果';
const ASSET_FOLDER = '仓鼠AI资产库';

function within(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}

function absoluteLocal(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 2048 &&
    !/[\x00-\x1f]/.test(value) && path.isAbsolute(value) &&
    (process.platform !== 'win32' || /^[a-z]:[\\/]/i.test(value));
}

function canonicalDirectory(directory) {
  const real = fs.realpathSync(directory);
  if (!fs.statSync(real).isDirectory()) throw new Error('Invalid work directory');
  return real;
}

function optionalDirectory(directory) {
  try { return canonicalDirectory(directory); }
  catch (error) { if (error.code !== 'ENOENT') throw error; return ''; }
}

function managedDirectories(root) {
  return {resultDir:path.join(root,RESULT_FOLDER),assetDir:path.join(root,ASSET_FOLDER)};
}

function findResultFile(file, directories) {
  if (typeof file !== 'string' || !file) return '';
  const requested = path.resolve(file);
  for (const directory of directories) {
    if (path.relative(directory,requested) === '' || !within(directory,requested)) continue;
    try {
      const root = canonicalDirectory(directory);
      if (path.relative(directory,root)) continue;
      const actual = fs.realpathSync(requested);
      if (!within(root,actual)) continue;
      const stat=fs.statSync(actual);
      if (stat.isFile() && stat.size > 0) return actual;
    } catch {}
  }
  return '';
}

function directoryUnreachable(directory) {
  try { return path.relative(directory,canonicalDirectory(directory)) !== ''; }
  catch { return true; }
}

function readPreferences(file) {
  try {
    const stat = fs.lstatSync(file);
    if (stat.isFile() && stat.size <= LIMIT) {
      const value = JSON.parse(fs.readFileSync(file,'utf8'));
      if (value?.format === 1 && absoluteLocal(value.directory) && Array.isArray(value.previous) &&
          value.previous.length <= MAX_ROOTS && value.previous.every(absoluteLocal)) return value;
    }
  } catch {}
  return {format:1,directory:null,previous:[]};
}

function createWorkDirectory({userData,defaultDirectory,protectedDirectories=[]}) {
  const file = path.join(userData,'work-directory.json');
  const defaultRoot = path.resolve(defaultDirectory);
  const protectedRoots = [userData,...protectedDirectories].filter(Boolean).flatMap(directory => {
    const resolved = path.resolve(directory);
    try { return [resolved,optionalDirectory(resolved)].filter(Boolean); }
    catch { return [resolved]; }
  });
  const overlaps = target => protectedRoots.some(root => within(root,target) || within(target,root));
  function pathsFor(root,verify=true) {
    if (protectedRoots.some(protectedRoot => within(protectedRoot,root))) throw new Error('Protected directory');
    const directories = managedDirectories(root);
    for (const directory of Object.values(directories)) {
      if (overlaps(directory)) throw new Error('Protected directory');
      if (!verify) continue;
      const actual = optionalDirectory(directory);
      if (actual && (path.relative(directory,actual) || fs.lstatSync(directory).isSymbolicLink())) throw new Error('Linked work directory');
    }
    return directories;
  }
  function checkDestination(directory, verifyWrites=false) {
    if (!absoluteLocal(directory)) throw new Error('Invalid work directory');
    const root = canonicalDirectory(directory);
    const directories = pathsFor(root);
    fs.accessSync(root,fs.constants.W_OK);
    for (const child of Object.values(directories)) {
      fs.mkdirSync(child,{recursive:true});
      if (path.relative(child,canonicalDirectory(child))) throw new Error('Linked work directory');
      fs.accessSync(child,fs.constants.W_OK);
      if (verifyWrites) {
        const probe=path.join(child,'.hamster-' + randomUUID() + '.tmp');
        fs.writeFileSync(probe,'',{flag:'wx',mode:0o600});
        fs.unlinkSync(probe);
      }
    }
    return {root,...directories};
  }

  let preference = readPreferences(file);
  let active = {root:defaultRoot,...managedDirectories(defaultRoot)},unavailable = false;
  if (preference.directory) {
    try {
      const selected = canonicalDirectory(preference.directory);
      if (path.relative(preference.directory,selected)) throw new Error('Linked work directory');
      active = checkDestination(selected);
    } catch { unavailable = true; }
  }
  const past = [managedDirectories(defaultRoot)];
  for (const directory of [preference.directory,...preference.previous].filter(Boolean)) {
    try { past.push(pathsFor(directory,false)); } catch {}
  }
  const distinct = (directories,current) => [...new Set(directories)].filter(directory => path.relative(current,directory) !== '');
  const resultReadDirs = distinct(past.map(value=>value.resultDir),active.resultDir);
  const assetReadDirs = distinct(past.map(value=>value.assetDir),active.assetDir);
  function status() {
    const nextDirectory = preference.directory || defaultRoot;
    return {ok:true,activeDirectory:active.root,nextDirectory,
      restartRequired:path.relative(active.root,nextDirectory) !== '',unavailable};
  }
  async function choose(directory) {
    const selected = checkDestination(directory,true);
    if (path.relative(status().nextDirectory,selected.root) === '') return status();
    const previous = distinct([...preference.previous,...[preference.directory].filter(Boolean)],selected.root);
    if (previous.length > MAX_ROOTS) throw new Error('Too many work directories');
    const value = {format:1,directory:selected.root,previous};
    const serialized = JSON.stringify(value) + '\n';
    if (Buffer.byteLength(serialized) > LIMIT) throw new Error('Too many work directories');
    const temporary = file + '.' + randomUUID() + '.tmp';
    try {
      await fs.promises.mkdir(userData,{recursive:true});
      await fs.promises.writeFile(temporary,serialized,{flag:'wx',mode:0o600});
      await fs.promises.rename(temporary,file);
      preference = value;
      unavailable = false;
      return status();
    } finally { await fs.promises.unlink(temporary).catch(()=>{}); }
  }
  return {resultDir:active.resultDir,assetDir:active.assetDir,resultReadDirs,assetReadDirs,status,choose};
}

function bindWorkDirectory({window,ipcMain,dialog,appUrl,store}) {
  const contents = window.webContents;
  const current = () => !window.isDestroyed() && !contents.isDestroyed() && contents.getURL() === appUrl;
  const trusted = event => current() && event.sender === contents && event.senderFrame === contents.mainFrame && event.senderFrame?.url === appUrl;
  let choosing = false;
  ipcMain.handle(STATUS,event => trusted(event) ? store.status() : {ok:false,code:'FORBIDDEN'});
  ipcMain.handle(CHOOSE,async event => {
    if (!trusted(event)) return {ok:false,code:'FORBIDDEN'};
    if (choosing) return {ok:false,code:'BUSY'};
    choosing = true;
    try {
      const result = await dialog.showOpenDialog(window,{title:'选择仓鼠AI作品目录',
        defaultPath:store.status().nextDirectory,properties:['openDirectory','createDirectory']});
      if (!trusted(event)) return {ok:false,code:'FORBIDDEN'};
      if (result.canceled) return {...store.status(),canceled:true};
      return await store.choose(result.filePaths[0]);
    } catch { return {ok:false,code:'WORK_DIRECTORY_UNAVAILABLE'}; }
    finally { choosing = false; }
  });
  window.once('closed',()=>{
    ipcMain.removeHandler(STATUS);
    ipcMain.removeHandler(CHOOSE);
  });
}

module.exports = {createWorkDirectory,bindWorkDirectory,findResultFile,directoryUnreachable,within,STATUS,CHOOSE};
