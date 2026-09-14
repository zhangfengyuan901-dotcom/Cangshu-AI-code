// Real packaged-runtime integration check. No model calls, personal data, or installed Python.
const fs=require('node:fs'),path=require('node:path'),net=require('node:net');
const {execFile}=require('node:child_process'),{promisify}=require('node:util');
const assert=require('node:assert/strict');
const {createRuntimeProvider}=require(process.env.HAMSTER_QA_ASAR?path.join(process.env.HAMSTER_QA_ASAR,'runtime.cjs'):'../runtime.cjs');
const {createSmartVideoLauncher}=require(process.env.HAMSTER_QA_ASAR?path.join(process.env.HAMSTER_QA_ASAR,'server.js'):'../server.js');
const {createDiagnostics}=require('../diagnostics.cjs');
async function main(){
  const root=path.resolve(__dirname,'..'),qa=fs.mkdtempSync(path.join(root,'output','便携 验证-'));
  const workflow=path.join(qa,'工作流');
  const skip=new Set(['.venv','config.yaml','.env','studio-data','creative-data','chat-data','merged_videos','__pycache__','.adk','bin']);
  fs.cpSync(path.join(root,'smart-video-agent'),workflow,{recursive:true,filter:p=>!skip.has(path.basename(p))});
  fs.copyFileSync(path.join(workflow,'config.yaml.example'),path.join(workflow,'config.yaml'));
  const cfg=path.join(qa,'config.json');fs.writeFileSync(cfg,'{}');
  const diag=createDiagnostics({dir:path.join(qa,'diagnostics'),exportDir:path.join(qa,'exports'),configPath:cfg});
  const resourcesDir=process.env.HAMSTER_QA_RESOURCES || path.join(root,'build');
  const provider=createRuntimeProvider({resourcesDir,cacheDir:process.env.HAMSTER_QA_CACHE || path.join(qa,'独立缓存'),diagnostics:diag});
  const start=Date.now(),runtime=await provider();console.log('Extracted and verified in',Math.round((Date.now()-start)/1000),'seconds');
  const blocker=net.createServer();await new Promise(r=>blocker.listen(0,'127.0.0.1',r));
  const preferred=blocker.address().port;let launches=0,opened;
  const launcher=createSmartVideoLauncher({workflowDir:workflow,url:`http://127.0.0.1:${preferred}/`,runtimeProvider:provider,requireIdentity:true,diagnostics:diag,
    spawnImpl:(...args)=>{launches++;return require('node:child_process').spawn(...args);},openExternal:url=>opened=url,
    envProvider:()=>({PATH:path.join(process.env.SystemRoot,'System32'),PYTHONHOME:'Z:/nonexistent-python',PYTHONPATH:'Z:/nonexistent-python',
      HAMSTER_CONFIG_PATH:cfg,HAMSTER_SMART_VIDEO_OUTPUT_DIR:path.join(qa,'results'),SANBAO_API_KEY:'',MODEL_AGENT_API_KEY:'',
      HTTP_PROXY:'http://127.0.0.1:1',HTTPS_PROXY:'http://127.0.0.1:1',NO_PROXY:'127.0.0.1,localhost'})});
  try{
    await Promise.all([launcher.open(),launcher.open(true)]);
    let state;
    for(let i=0;i<120;i++){state=await launcher.status();if(state.status==='ready')break;if(state.status==='error')throw Error(JSON.stringify(state));await new Promise(r=>setTimeout(r,500));}
    assert.equal(state.status,'ready');assert.notEqual(new URL(state.url).port,String(preferred));assert.equal(launches,1);assert.ok(blocker.listening);
    for(const route of ['/','/creative/','/chat/','/chat-api/sessions','/studio-api/jobs'])assert.equal((await fetch(new URL(route,state.url))).status,200);
    await launcher.open(true);assert.equal(opened,new URL('/creative/',state.url).href);assert.equal(launches,1);
    await launcher.open('chat');assert.equal(opened,new URL('/chat/',state.url).href);assert.equal(launches,1);
    const clip=path.join(qa,'ffmpeg-smoke.mp4');
    await promisify(execFile)(runtime.python,['-I','-c',"from moviepy import ColorClip,VideoFileClip;import sys;c=ColorClip((32,32),color=(30,40,50),duration=.2);c.write_videofile(sys.argv[1],fps=5,codec='libx264',audio=False,logger=None);c.close();v=VideoFileClip(sys.argv[1]);assert v.duration>0;v.close()",clip],{windowsHide:true,timeout:30000,env:{...process.env,PATH:path.join(process.env.SystemRoot,'System32')}});
    assert.ok(fs.statSync(clip).size>0);
    const recheckStarted=Date.now();
    const reused=await createRuntimeProvider({resourcesDir,cacheDir:path.dirname(path.dirname(runtime.python)),diagnostics:diag})();
    assert.equal(reused.python,runtime.python);
    assert.ok(!fs.readdirSync(path.dirname(path.dirname(runtime.python))).some(name=>name.startsWith(runtime.id+'-replaced-')),'normal startup must not invalidate runtime');
    console.log('Warm cache verified in',Math.round((Date.now()-recheckStarted)/1000),'seconds');
    if(process.platform==='win32'){
      const probe=net.createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));
      const watchPort=probe.address().port;await new Promise(r=>probe.close(r));
      const parent=require('node:child_process').fork(path.join(__dirname,'qa-runtime-parent.cjs'),[runtime.python,runtime.bootstrap,workflow,String(watchPort)],{windowsHide:true,stdio:['ignore','ignore','ignore','ipc']});
      const ownedPid=await new Promise((resolve,reject)=>{parent.once('message',m=>resolve(m.pid));parent.once('error',reject);});
      const healthURL=`http://127.0.0.1:${watchPort}/studio-api/health`;
      try{
        let ready=false;
        for(let n=0;n<60;n++){try{if((await fetch(healthURL)).ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,250));}
        assert.ok(ready,'watchdog fixture ready');parent.kill();
        let gone=false;
        for(let n=0;n<40;n++){try{process.kill(ownedPid,0);}catch{gone=true;break;}await new Promise(r=>setTimeout(r,100));}
        assert.ok(gone,'Python exits when its parent process dies');
      }finally{parent.kill();try{process.kill(ownedPid);}catch{}}
    }
    console.log(JSON.stringify({passed:true,preferredPort:preferred,actualURL:state.url,launches,isolatedPython:true,ffmpeg:true,parentWatchdog:true,qa}));
  }finally{launcher.stop();await new Promise(r=>blocker.close(r));}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
