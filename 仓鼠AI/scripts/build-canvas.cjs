const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {execFileSync}=require('node:child_process');
const root=path.resolve(__dirname,'..');
const nodeVersion='v22.23.3';
const nodeSha256='9c9245166b4a8e182e0b797da9c20136117ff24368eaff1fec8343a123c8db0e';
async function main(){
  const runtime=path.join(root,'build','node-runtime');
  let exe=process.env.HAMSTER_CANVAS_BUILD_NODE;
  if(!exe){
    fs.mkdirSync(runtime,{recursive:true});
    const manifest=path.join(runtime,'runtime.json');
    if(!fs.existsSync(manifest)){
    const version=nodeVersion;
    const base=`https://nodejs.org/dist/${version}/`;
    const sums=await fetch(base+'SHASUMS256.txt').then(r=>r.text());
    const expected=sums.split('\n').find(line=>line.trim().endsWith('win-x64/node.exe'))?.split(/\s+/)[0];
    if(expected!==nodeSha256)throw Error('Node release checksum mismatch');
    const response=await fetch(base+'win-x64/node.exe');if(!response.ok)throw Error('Node download failed');
    const bytes=Buffer.from(await response.arrayBuffer());const sha=crypto.createHash('sha256').update(bytes).digest('hex');
    if(sha!==expected)throw Error('Node checksum mismatch');
    fs.writeFileSync(path.join(runtime,'node.exe'),bytes);fs.writeFileSync(manifest,JSON.stringify({version,sha256:sha}));
    }
    const info=JSON.parse(fs.readFileSync(manifest));exe=path.join(runtime,'node.exe');
    if(info.version!==nodeVersion||info.sha256!==nodeSha256)throw Error('Bundled Node version mismatch');
    if(crypto.createHash('sha256').update(fs.readFileSync(exe)).digest('hex')!==info.sha256)throw Error('Bundled Node checksum mismatch');
    const licensePath=path.join(runtime,'LICENSE');
    if(!fs.existsSync(licensePath) || !fs.statSync(licensePath).size){
      const license=await fetch(`https://raw.githubusercontent.com/nodejs/node/${nodeVersion}/LICENSE`);
      if(!license.ok)throw Error('Node license download failed');
      fs.writeFileSync(licensePath,await license.text());
    }
  }
  const npm=path.join(path.dirname(process.execPath),'node_modules','npm','bin','npm-cli.js');
  const env={...process.env,PATH:path.dirname(exe)+path.delimiter+process.env.PATH};
  const run=args=>execFileSync(exe,[npm,'exec','--yes','--package=pnpm@10.32.1','--','pnpm',...args],{cwd:path.join(root,'canvas'),env,stdio:'inherit'});
  run(['install',...(fs.existsSync(path.join(root,'canvas','pnpm-lock.yaml'))?['--frozen-lockfile']:[])]);
  const notices=[];const seen=new Set();
  function collect(folder){
    if(!fs.existsSync(folder))return;
    for(const name of fs.readdirSync(folder)){
      const file=path.join(folder,name);if(name.startsWith('.'))continue;
      if(name.startsWith('@')){collect(file);continue;}
      const pkg=path.join(file,'package.json');if(!fs.existsSync(pkg))continue;
      const data=JSON.parse(fs.readFileSync(pkg));const key=data.name+'@'+data.version;if(seen.has(key))continue;seen.add(key);
      for(const license of fs.readdirSync(file).filter(n=>/^(license|licence|copying|notice)(\.|$)/i.test(n)))if(fs.statSync(path.join(file,license)).isFile())notices.push(key+'\n'+fs.readFileSync(path.join(file,license),'utf8'));
    }
  }
  const store=path.join(root,'canvas','node_modules','.pnpm');
  for(const name of fs.readdirSync(store))collect(path.join(store,name,'node_modules'));
  fs.writeFileSync(path.join(root,'canvas','public','dependency-licenses.txt'),notices.join('\n\n----------------\n\n'));
  run(['build']);console.log('Canvas production build ready');
}
main().catch(e=>{console.error(e);process.exitCode=1;});
