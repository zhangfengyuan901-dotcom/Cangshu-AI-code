// Internal-only developer setup. Never invoked by the application or public installer.
const fs=require('node:fs');
const path=require('node:path');
const {execFileSync}=require('node:child_process');
const root=path.resolve(__dirname,'..');
const target=path.join(root,'build','hypit-host');
const manifest={format:'hamster.hypit-runtime@1',hypit:{version:'0.3.1',sourceCommit:'0d36de9a9d17562fca0e478969b80eb1c16a7693',integrity:'sha512-FI54GPQRB9uXSTRmCt8fngzWH/YEEasOIuYhwsEh9G2v92L50N/TdcMiLgDT1KfRjt+C1/HXcG28Bai6HMEDQQ=='},codex:{version:'0.163.0'},internalOnly:true,chatgptEligibility:'unverified'};
function main(){
  if(!process.argv.includes('--internal-only'))throw Error('Only available with --internal-only; not for public redistribution');
  fs.mkdirSync(target,{recursive:true});
  const source=path.join(root,'integrations','hypit-runtime');
  for(const name of ['package.json','package-lock.json'])if(fs.existsSync(path.join(source,name)))fs.copyFileSync(path.join(source,name),path.join(target,name));
  const npm=path.join(path.dirname(process.execPath),'node_modules','npm','bin','npm-cli.js');
  if(!fs.existsSync(npm))throw Error('Run with a developer Node installation that includes npm');
  execFileSync(process.execPath,[npm,fs.existsSync(path.join(target,'package-lock.json'))?'ci':'install','--ignore-scripts','--no-audit','--no-fund'],{cwd:target,stdio:'inherit',windowsHide:true});
  const lock=JSON.parse(fs.readFileSync(path.join(target,'package-lock.json'),'utf8'));
  if(lock.packages?.['node_modules/@hypit/hypit']?.integrity!==manifest.hypit.integrity)throw Error('Hypit package integrity does not match the approved runtime');
  if(lock.packages?.['node_modules/@ffprobe-installer/win32-x64']?.integrity!=='sha512-jMGYeAgkrdn4e2vvYt/qakgHRE3CPju4bn5TmdPfoAm1BlX1mY9cyMd8gf5vSzI8gH8Zq5WQAyAkmekX/8TSTg==')throw Error('FFprobe package integrity mismatch');
  for(const [name,version] of [['@hypit/hypit',manifest.hypit.version],['@openai/codex',manifest.codex.version]]){
    if(JSON.parse(fs.readFileSync(path.join(target,'node_modules',name,'package.json'),'utf8')).version!==version)throw Error('Unexpected runtime package version');
  }
  fs.writeFileSync(path.join(target,'hypit-install.json'),JSON.stringify(manifest,null,2)+'\n');
  require('../hypit-project.cjs').installAdapter({hostRoot:target});
  console.log('Internal Hypit runtime installed. No login, inference, media generation or render was performed.');
}
if(require.main===module)try{main();}catch{console.error('Internal Hypit setup failed; existing projects and credentials were not modified.');process.exitCode=1;}
module.exports={manifest};
