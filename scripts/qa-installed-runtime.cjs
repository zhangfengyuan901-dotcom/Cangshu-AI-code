// Exercise the real NSIS hook using a validation-only app ID and no shortcuts.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {execFile}=require('node:child_process'),{promisify}=require('node:util');
const {MARKER,createInstalledRuntimeProvider}=require('../installed-runtime.cjs');
const {createSmartVideoLauncher}=require('../server.js');
const run=promisify(execFile);
async function main(){
  const root=path.resolve(__dirname,'..');
  const installer=process.argv[2] ? path.resolve(process.argv[2]) : path.join(root,'output/installer-qa-package/仓鼠AI Setup 1.7.9.exe');
  if(!fs.existsSync(installer))throw Error(`Installer does not exist: ${installer}`);
  const qa=fs.mkdtempSync(path.join(root,'output/install-validation-'));
  const installed=path.join(qa,'中文 安装','仓鼠AI');
  const resourcesDir=path.join(installed,'resources');
  const data=path.join(qa,'customer-data');fs.mkdirSync(data);
  const configPath=path.join(data,'config.json');fs.writeFileSync(configPath,'{}');
  const sentinel=path.join(data,'会话与资产.txt');fs.writeFileSync(sentinel,'must survive install and repair');
  console.log(JSON.stringify({qa,step:'install'}));
  const install=()=>run(installer,['/S',`/D=${installed}`],{windowsHide:true,windowsVerbatimArguments:true,timeout:900000});
  await install();
  const marker=()=>JSON.parse(fs.readFileSync(path.join(resourcesDir,MARKER),'utf8'));
  assert.equal(marker().state,'ready');
  console.log('PASS: NSIS returned only after full extraction, verification and Python smoke check');
  const runtime=await createInstalledRuntimeProvider({resourcesDir})();
  assert.ok(runtime.python.startsWith(installed));
  // A broken entry executable must fail fast; running the installer again repairs it.
  fs.writeFileSync(runtime.python,'damaged QA executable');
  await assert.rejects(createInstalledRuntimeProvider({resourcesDir})(),/重新运行安装包/);
  console.log('Repairing through repeat NSIS installation');
  await install();assert.equal(marker().state,'ready');assert.equal(fs.readFileSync(sentinel,'utf8'),'must survive install and repair');
  const workflow=path.join(data,'workflow');fs.cpSync(path.join(resourcesDir,'smart-video-agent'),workflow,{recursive:true});
  fs.copyFileSync(path.join(workflow,'config.yaml.example'),path.join(workflow,'config.yaml'));
  const events=[];
  const provider=createInstalledRuntimeProvider({resourcesDir,diagnostics:{log:event=>events.push(event)}});
  const started=Date.now();await provider();console.log('Installed environment quick check ms:',Date.now()-started);
  const launcher=createSmartVideoLauncher({workflowDir:workflow,runtimeProvider:provider,requireIdentity:true,
    envProvider:()=>({HAMSTER_CONFIG_PATH:configPath,HAMSTER_SMART_VIDEO_OUTPUT_DIR:path.join(data,'results'),MODEL_AGENT_API_KEY:'',SANBAO_API_KEY:'',
      PYTHONHOME:'Z:/not-installed',PYTHONPATH:'Z:/not-installed',PATH:path.join(process.env.SystemRoot,'System32')})});
  try{
    await launcher.prepare();let status;
    for(let n=0;n<120;n++){
      status=await launcher.status();if(status.status==='ready')break;if(status.status==='error')throw Error(JSON.stringify(status));
      await new Promise(r=>setTimeout(r,500));
    }
    assert.equal(status.status,'ready');
    for(const route of ['/','/chat/','/creative/'])assert.equal((await fetch(new URL(route,status.url))).status,200);
    assert.deepEqual(events,['installed-runtime-reuse']);
    assert.ok(!fs.existsSync(path.join(data,'runtimes')));
    console.log('PASS: installed workbench health + all three pages, without runtime extraction or paid calls');
  }finally{launcher.stop();}
  // Exact generated install target, validation registry identity only; keep test customer data.
  assert.ok(path.resolve(installed).startsWith(path.resolve(qa)+path.sep));
  const uninstaller=fs.readdirSync(installed).find(name=>/^Uninstall.*\.exe$/.test(name));assert.ok(uninstaller);
  await run(path.join(installed,uninstaller),['/S','/KEEP_APP_DATA',`_?=${installed}`],{windowsHide:true,windowsVerbatimArguments:true,timeout:120000});
  assert.equal(fs.readFileSync(sentinel,'utf8'),'must survive install and repair');
  console.log(JSON.stringify({passed:true,install:true,repair:true,health:true,retainedData:true,qa}));
}
main().catch(error=>{console.error(error);process.exitCode=1;});
