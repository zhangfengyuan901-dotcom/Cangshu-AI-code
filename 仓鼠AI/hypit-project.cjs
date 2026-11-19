const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const os=require('node:os');
const FILES=['package.json','activation.js','model.js','provider.js','README.md'];
function fail(){throw Object.assign(Error('内部视频适配组件未准备完成'),{statusCode:503,publicMessage:'内部视频适配组件未准备完成'});}
function noLink(value){if(fs.existsSync(value)&&fs.lstatSync(value).isSymbolicLink())fail();}
function installAdapter({hostRoot,sourceRoot=path.join(__dirname,'hypit-provider')}={}){
  const parent=path.join(hostRoot,'node_modules','@hamster'),target=path.join(parent,'hypit-video');
  for(const dir of [hostRoot,path.join(hostRoot,'node_modules'),parent,target])noLink(dir);
  fs.mkdirSync(target,{recursive:true});
  for(const name of FILES){
    const source=path.join(sourceRoot,name),destination=path.join(target,name);noLink(source);noLink(destination);
    const bytes=fs.readFileSync(source);if(!fs.existsSync(destination)||!fs.readFileSync(destination).equals(bytes))fs.writeFileSync(destination,bytes);
  }
  prepareMediaTools(hostRoot);
  return target;
}
function prepareMediaTools(hostRoot){
  const media=localMediaPaths(hostRoot);if(!media)return;
  const directory=path.join(hostRoot,'bin'),alias=path.join(directory,'ffmpeg.exe');
  noLink(directory);fs.mkdirSync(directory,{recursive:true});noLink(alias);
  if(!fs.existsSync(alias))fs.copyFileSync(media.ffmpegPath,alias,fs.constants.COPYFILE_EXCL);
  else if(crypto.createHash('sha256').update(fs.readFileSync(alias)).digest('hex')!==crypto.createHash('sha256').update(fs.readFileSync(media.ffmpegPath)).digest('hex'))fail();
  const notice=path.join(directory,'README.txt');
  if(!fs.existsSync(notice))fs.writeFileSync(notice,'Internal local runtime only. ffmpeg.exe is an unchanged copy of the existing imageio-ffmpeg Windows binary. FFmpeg copyright and license: https://ffmpeg.org/legal.html . No public redistribution is performed by this integration.\n',{flag:'wx'});
}
function configureProject({projectRoot,projectId,hostRoot}={}){
  const adapter=installAdapter({hostRoot}),modules=path.join(projectRoot,'node_modules'),scope=path.join(modules,'@hamster'),link=path.join(scope,'hypit-video');
  noLink(modules);noLink(scope);fs.mkdirSync(scope,{recursive:true});
  if(fs.existsSync(link)){
    if(fs.realpathSync(link)!==fs.realpathSync(adapter))fail();
  }else fs.symlinkSync(adapter,link,process.platform==='win32'?'junction':'dir');
  // New files only: never replace a user's active Profile or package manifest.
  const manifestPath=path.join(projectRoot,'package.json');noLink(manifestPath);
  const manifest=JSON.parse(fs.readFileSync(manifestPath,'utf8'));
  if(manifest.dependencies?.['@hamster/hypit-video']&&manifest.dependencies['@hamster/hypit-video']!=='0.1.0')fail();
  if(!manifest.dependencies?.['@hamster/hypit-video']){
    manifest.dependencies={...manifest.dependencies,'@hamster/hypit-video':'0.1.0'};
    fs.writeFileSync(manifestPath,JSON.stringify(manifest,null,2)+'\n');
  }
  const profilePath=path.join(projectRoot,'hamster.runtime.json');noLink(profilePath);
  if(!fs.existsSync(profilePath)){
    const profile=JSON.parse(fs.readFileSync(path.join(__dirname,'hypit-provider','hypit.runtime.example.json'),'utf8'));
    profile.endpoints['hamster.video'].config.projectId=projectId;
    const media=localMediaPaths(hostRoot);
    if(media){
      profile.endpoints['media.local']={use:'@hypit/media-local',config:{ffmpegPath:media.ffmpegPath,ffprobePath:media.ffprobePath,defaultConcurrency:1}};
      profile.endpoints['html.local']={use:'@hypit/provider-html-local',config:{...media,nodePath:path.join(__dirname,'build','node-runtime','node.exe'),workers:1,maxWorkers:1,browserCapacity:1,defaultConcurrency:1,browserGpu:'software'}};
    }
    fs.writeFileSync(profilePath,JSON.stringify(profile,null,2)+'\n',{flag:'wx'});
  }
  const marker=path.join(projectRoot,'.hamster-hypit-adapter.json');noLink(marker);
  if(!fs.existsSync(marker))fs.writeFileSync(marker,JSON.stringify({format:'hamster.hypit-adapter@1',projectId,version:'0.1.0',profile:'hamster.runtime.json',packageHash:crypto.createHash('sha256').update(FILES.map(name=>fs.readFileSync(path.join(adapter,name))).join('')).digest('hex')},null,2)+'\n',{flag:'wx'});
  return {profilePath};
}
function localMediaPaths(hostRoot){
  if(process.platform!=='win32'||process.arch!=='x64')return null;
  const value={ffmpegPath:path.join(__dirname,'smart-video-agent','.venv','Lib','site-packages','imageio_ffmpeg','binaries','ffmpeg-win-x86_64-v7.1.exe'),ffprobePath:path.join(hostRoot,'node_modules','@ffprobe-installer','win32-x64','ffprobe.exe'),chromePath:'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'};
  // A verified developer headless runtime is preferred; desktop Chrome on Windows
  // does not reliably implement the original distribution's --version probe.
  const headless=path.join(os.homedir(),'AppData','Local','ms-playwright','chromium_headless_shell-1228','chrome-headless-shell-win64','chrome-headless-shell.exe');
  if(fs.existsSync(headless)&&fs.statSync(headless).isFile())value.chromePath=headless;
  return Object.values(value).every(file=>fs.existsSync(file)&&fs.statSync(file).isFile())?value:null;
}
module.exports={installAdapter,configureProject,localMediaPaths,prepareMediaTools};
