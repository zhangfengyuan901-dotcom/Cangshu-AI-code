'use strict';
const fs=require('node:fs');
const path=require('node:path');
const net=require('node:net');
const crypto=require('node:crypto');
const {createRequire}=require('node:module');
const {spawn}=require('node:child_process');

const HYPIT_VERSION='0.3.1';
const HYPIT_SOURCE_COMMIT='0d36de9a9d17562fca0e478969b80eb1c16a7693';
const PROJECT_MARKER='.hamster-hypit-project.json';
// This is a local one-second title card. Opening it does not create a Build.
const TEMPLATE={
  'build.svrun':'<?svml using="@hypit/markup/run@1"?>\n<svrun version="1">\n  <author source="./main.svml"/>\n  <target output="final.video"/>\n</svrun>\n',
  'main.svml':'<?svml using="@hypit/markup@1"?>\n<svml>\n  <import as="time" from="@hypit/timeline-author@1"/>\n  <import as="spatial" from="@hypit/spatial@1"/>\n  <import as="media" from="@hypit/media@1"/>\n  <import as="visual" from="@hypit/visual-track@1"/>\n  <import as="film" from="@hypit/film@1"/>\n  <import as="html" from="@hypit/html-video@1"/>\n  <import as="style" source="./appearance.svs"/>\n  <time:Clock id="clock" frame-rate="30"/>\n  <time:Timeline id="timeline" clock={clock} end="1s"/>\n  <spatial:Canvas id="canvas" width="1280" height="720"/>\n  <spatial:Frame id="full" within={canvas.bounds} left="0%" top="0%" right="100%" bottom="100%"/>\n  <spatial:Extent id="card-extent" width="1280" height="720"/>\n  <media:Image id="card" src="./welcome.svg" media-type="image/svg+xml"/>\n  <visual:Track id="picture" timeline={timeline.timeline}>\n    <visual:Clip id="title" image={card} extent={card-extent} during={timeline.window} frame={full} z="0" fit="contain"/>\n  </visual:Track>\n  <film:Film id="main" canvas={canvas.canvas} timeline={timeline.timeline} appearance={style.film.main}>\n    <film:Track source={picture.visual}/>\n  </film:Film>\n  <html:Video id="final" composition={main.composition} timeline={timeline.timeline}/>\n</svml>\n',
  'appearance.svs':'<?svml using="@hypit/recipe@1"?>\n<sheet version="1">\n  film.main { background: #18212A; }\n</sheet>\n',
  'welcome.svg':'<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720"><rect width="1280" height="720" fill="#18212a"/><text x="640" y="380" text-anchor="middle" fill="#ffffff" font-size="72" font-family="sans-serif">Hypit</text></svg>\n',
};

function failure(code){const error=new Error(code);error.code=code;return error;}
function xmlAttribute(value){return String(value).replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[char]));}
function projectId(value){
  if(typeof value!=='string'||! /^[a-z0-9][a-z0-9_-]{0,79}$/.test(value))throw failure('INVALID_PROJECT');
  return value;
}
function inside(root,target){const relative=path.relative(root,target);return relative!==''&&!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative);}
function noLinks(root,target){
  if(!inside(root,target))throw failure('INVALID_PATH');
  let current=root;
  if(fs.lstatSync(root).isSymbolicLink())throw failure('INVALID_PATH');
  for(const part of path.relative(root,target).split(path.sep)){
    current=path.join(current,part);
    if(fs.lstatSync(current).isSymbolicLink())throw failure('INVALID_PATH');
  }
  if(!inside(fs.realpathSync(root),fs.realpathSync(target)))throw failure('INVALID_PATH');
  return target;
}
function loopbackUrl(value){
  try{
    const url=new URL(value);
    if(url.protocol!=='http:'||!['localhost','127.0.0.1','[::1]'].includes(url.hostname)||url.username||url.password||!url.port||url.pathname!=='/'||url.search)return null;
    const port=Number(url.port);if(!Number.isInteger(port)||port<1||port>65535)return null;
    return url.origin+'/';
  }catch{return null;}
}
function allocateLoopbackPort(){
  return new Promise((resolve,reject)=>{const server=net.createServer();server.unref();server.once('error',reject);server.listen(0,'127.0.0.1',()=>{const port=server.address().port;server.close(error=>error?reject(error):resolve(port));});});
}
async function probeStudio(url){
  const response=await fetch(url,{redirect:'manual',signal:AbortSignal.timeout(1500)});
  if(response.status!==200||!String(response.headers.get('content-type')).includes('text/html'))return false;
  const text=await response.text();return text.length<100000&&/<title>Hypit Studio<\/title>/i.test(text);
}
function childEnvironment(nodeExecutable,toolDirectories=[]){
  const env={NODE_ENV:'development'};
  for(const name of ['SystemRoot','WINDIR','TEMP','TMP'])if(process.env[name])env[name]=process.env[name];
  const available=[];
  for(const directory of toolDirectories){
    let stats;try{stats=fs.lstatSync(directory);}catch(error){if(error.code==='ENOENT')continue;throw failure('INVALID_TOOL_DIRECTORIES');}
    if(stats.isSymbolicLink()||!stats.isDirectory())throw failure('INVALID_TOOL_DIRECTORIES');
    const resolved=fs.realpathSync(directory);
    if(resolved.includes(path.delimiter)||/[\u0000-\u001f]/.test(resolved))throw failure('INVALID_TOOL_DIRECTORIES');
    if(!available.includes(resolved))available.push(resolved);
  }
  env.PATH=[path.dirname(nodeExecutable),process.env.SystemRoot&&path.join(process.env.SystemRoot,'System32'),process.env.SystemRoot&&path.join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0'),...available].filter(Boolean).join(path.delimiter);
  return env;
}

/** Owns only an explicitly provisioned, local Hypit Studio child. It is not an OS sandbox. */
function createHypitRuntime({workspaceRoot,distributionRoot,nodeExecutable=process.execPath,metadataPath,spawnImpl=spawn,envProvider,toolDirectories=[],
  allocatePort=allocateLoopbackPort,probeHttp=probeStudio,startupTimeoutMs=30000,probeIntervalMs=100,stopTimeoutMs=2000}={}){
  if(typeof workspaceRoot!=='string'||!path.isAbsolute(workspaceRoot))throw failure('INVALID_WORKSPACE');
  if(!Array.isArray(toolDirectories)||toolDirectories.length>8)throw failure('INVALID_TOOL_DIRECTORIES');
  const selectedToolDirectories=[];
  for(const directory of toolDirectories){
    if(typeof directory!=='string'||!path.isAbsolute(directory)||directory.length>1000||directory.includes(path.delimiter)||/[\u0000-\u001f]/.test(directory))throw failure('INVALID_TOOL_DIRECTORIES');
    const resolved=path.resolve(directory);if(!selectedToolDirectories.includes(resolved))selectedToolDirectories.push(resolved);
  }
  const workspace=path.resolve(workspaceRoot);
  let child=null,pending=null,pendingInput=null,epoch=0,closed=false,installed=false;
  let state={state:'stopped',code:null,projectId:null,runRelativePath:null,runtimeProfileRelativePath:null,url:null};
  const snapshot=()=>({...state,installed,version:HYPIT_VERSION,sourceCommit:HYPIT_SOURCE_COMMIT});
  function installation(){
    if(!distributionRoot||!metadataPath)throw failure('RUNTIME_NOT_CONFIGURED');
    try{
      const manifest=JSON.parse(fs.readFileSync(metadataPath,'utf8'));
      const root=path.resolve(distributionRoot),pkg=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'));
      if(manifest.format!=='hamster.hypit-runtime@1'||manifest.hypit?.version!==HYPIT_VERSION||manifest.hypit?.sourceCommit!==HYPIT_SOURCE_COMMIT||pkg.name!=='@hypit/hypit'||pkg.version!==HYPIT_VERSION)throw failure('RUNTIME_VERSION_MISMATCH');
      const launcher=path.join(root,'bin','hypit.mjs');
      if(!fs.statSync(launcher).isFile()||!fs.statSync(nodeExecutable).isFile())throw failure('RUNTIME_UNAVAILABLE');
      const resolve=createRequire(path.join(root,'package.json'));
      for(const specifier of ['tsx/esm/api','@hypit/video','@hypit/studio/start'])if(!fs.statSync(resolve.resolve(specifier)).isFile())throw failure('RUNTIME_UNAVAILABLE');
      const studioRequire=createRequire(resolve.resolve('@hypit/studio/start'));
      if(!fs.statSync(studioRequire.resolve('vite')).isFile())throw failure('RUNTIME_UNAVAILABLE');
      installed=true;return {root,launcher};
    }catch(error){installed=false;if(error.code?.startsWith('RUNTIME_'))throw error;throw failure('RUNTIME_UNAVAILABLE');}
  }
  function projectDirectory(id){
    const directory=path.join(workspace,projectId(id));
    try{noLinks(workspace,directory);if(!fs.statSync(directory).isDirectory())throw failure('INVALID_PROJECT');
      const marker=JSON.parse(fs.readFileSync(noLinks(workspace,path.join(directory,PROJECT_MARKER)),'utf8'));
      if(marker.format!=='hamster.hypit-project@1'||marker.id!==id)throw failure('INVALID_PROJECT');
      return directory;
    }catch(error){if(error.code==='INVALID_PATH')throw error;throw failure('INVALID_PROJECT');}
  }
  function prepareProject({projectId:id=crypto.randomUUID(),label='Hypit 项目'}={}){
    if(closed)throw failure('RUNTIME_CLOSED');
    projectId(id);
    if(typeof label!=='string'||!label.trim()||label.length>128||/[\u0000-\u001f]/.test(label))throw failure('INVALID_PROJECT_LABEL');
    fs.mkdirSync(workspace,{recursive:true});
    if(fs.lstatSync(workspace).isSymbolicLink())throw failure('INVALID_PATH');
    const directory=path.join(workspace,id);
    try{fs.mkdirSync(directory);}catch(error){if(error.code==='EEXIST')throw failure('PROJECT_EXISTS');throw failure('PROJECT_CREATE_FAILED');}
    const createdAt=new Date().toISOString();
    // Exclusive creation never replaces a pre-existing project or user source.
    for(const [filename,content] of Object.entries({
      [PROJECT_MARKER]:JSON.stringify({format:'hamster.hypit-project@1',id,label:label.trim(),createdAt},null,2)+'\n',
      'package.json':JSON.stringify({name:'hamster-hypit-project',version:'1.0.0',private:true,type:'module',hypit:{project:true}},null,2)+'\n',
      ...TEMPLATE,
    }))fs.writeFileSync(path.join(directory,filename),content,{flag:'wx'});
    return {id,label:label.trim(),createdAt,runRelativePath:'build.svrun'};
  }
  function listProjects(){
    if(!fs.existsSync(workspace))return [];
    if(fs.lstatSync(workspace).isSymbolicLink())throw failure('INVALID_PATH');
    const projects=[];
    for(const entry of fs.readdirSync(workspace,{withFileTypes:true})){
      if(!entry.isDirectory()||! /^[a-z0-9][a-z0-9_-]{0,79}$/.test(entry.name))continue;
      try{const directory=projectDirectory(entry.name),marker=JSON.parse(fs.readFileSync(path.join(directory,PROJECT_MARKER),'utf8'));
        if(typeof marker.label==='string'&&marker.label.length<=128&&typeof marker.createdAt==='string')projects.push({id:entry.name,label:marker.label,createdAt:marker.createdAt,runRelativePath:'build.svrun'});
      }catch{/* Unowned, partial and linked directories are not exposed. */}
    }
    return projects.sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
  }
  function selectedRun(id,relative='build.svrun'){
    const directory=projectDirectory(id);
    if(typeof relative!=='string'||relative.length>500||relative.includes('\\')||path.isAbsolute(relative)||relative.split('/').some(part=>part===''||part==='.'||part==='..')||!relative.endsWith('.svrun')||/[\u0000-\u001f:]/.test(relative))throw failure('INVALID_RUN_PATH');
    const run=path.join(directory,relative);
    try{noLinks(workspace,run);if(!fs.statSync(run).isFile()||fs.statSync(run).size>1024*1024)throw failure('INVALID_RUN');}
    catch(error){if(error.code==='INVALID_PATH')throw error;throw failure('INVALID_RUN');}
    return {directory,run,relative};
  }
  function selectedProfile(directory,value){
    if(value===undefined)return {absolute:null,relative:null};
    if(typeof value!=='string'||!path.isAbsolute(value)||!value.endsWith('.json')||value.length>1000||/[\u0000-\u001f]/.test(value))throw failure('INVALID_RUNTIME_PROFILE');
    const absolute=path.resolve(value);
    if(!inside(directory,absolute))throw failure('INVALID_RUNTIME_PROFILE');
    try{noLinks(workspace,absolute);if(!fs.statSync(absolute).isFile()||fs.statSync(absolute).size>1024*1024)throw failure('INVALID_RUNTIME_PROFILE');}
    catch{throw failure('INVALID_RUNTIME_PROFILE');}
    return {absolute,relative:path.relative(directory,absolute).split(path.sep).join('/')};
  }
  function prepareVideoPreview({projectId:id,operationId,videoPath,duration,width,height,hasAudio}={}){
    if(closed)throw failure('RUNTIME_CLOSED');
    const directory=projectDirectory(id);
    if(typeof operationId!=='string'||! /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(operationId)||typeof hasAudio!=='boolean'||!Number.isFinite(duration)||duration<=0||duration>86400||![width,height].every(value=>Number.isInteger(value)&&value>=2&&value<=16384))throw failure('INVALID_PREVIEW_METADATA');
    if(typeof videoPath!=='string'||videoPath.length>500||!videoPath.startsWith('assets/')||videoPath.includes('\\')||videoPath.split('/').some(part=>part===''||part==='.'||part==='..')||/[\u0000-\u001f:]/.test(videoPath)||! /\.(mp4|webm|mov|m4v)$/i.test(videoPath))throw failure('INVALID_PREVIEW_PATH');
    try{
      const source=noLinks(workspace,path.join(directory,videoPath)),stats=fs.statSync(source);
      if(!stats.isFile()||stats.size<=0||stats.size>512*1024*1024)throw failure('INVALID_PREVIEW_PATH');
      const appearance=noLinks(workspace,path.join(directory,'appearance.svs'));
      if(!fs.statSync(appearance).isFile())throw failure('INVALID_PREVIEW_PATH');
    }catch{throw failure('INVALID_PREVIEW_PATH');}
    const identity=crypto.createHash('sha256').update(JSON.stringify([id,operationId,videoPath,duration,width,height,hasAudio])).digest('hex');
    const stem='result-'+identity,runRelativePath=stem+'.svrun',sourceRelativePath=stem+'.svml';
    const author='<?svml using="@hypit/markup@1"?>\n<svml>\n'+[
      '  <import as="time" from="@hypit/timeline-author@1"/>',
      '  <import as="spatial" from="@hypit/spatial@1"/>',
      '  <import as="media" from="@hypit/media@1"/>',
      '  <import as="mediaop" from="@hypit/media-operations@1"/>',
      '  <import as="visual" from="@hypit/visual-track@1"/>',
      ...(hasAudio?['  <import as="audio" from="@hypit/audio-track@1"/>']:[]),
      '  <import as="film" from="@hypit/film@1"/>',
      '  <import as="html" from="@hypit/html-video@1"/>',
      '  <import as="style" source="./appearance.svs"/>',
      '  <time:Clock id="clock" frame-rate="30"/>',
      `  <media:Video id="saved" src="./${xmlAttribute(videoPath)}"/>`,
      `  <mediaop:Normalize id="prepared" source={saved} video="primary-moving" audio="${hasAudio?'default':'none'}" span-authority="video" clock={clock}/>`,
      '  <time:Timeline id="timeline" clock={clock} end="clip.end">',
      '    <time:Window id="clip" from="start" for={prepared.extent}/>',
      '  </time:Timeline>',
      `  <spatial:Canvas id="canvas" width="${width}" height="${height}"/>`,
      '  <spatial:Frame id="full" within={canvas.bounds} left="0%" top="0%" right="100%" bottom="100%"/>',
      '  <visual:Track id="picture" timeline={timeline.timeline}>',
      '    <visual:Clip id="saved-picture" media={prepared.media} during={timeline.clip} frame={full} z="0" fit="contain"/>',
      '  </visual:Track>',
      ...(hasAudio?['  <audio:Track id="sound" timeline={timeline.timeline}>','    <audio:Clip id="saved-sound" source={prepared.media} during={timeline.clip}/>','  </audio:Track>']:[]),
      '  <film:Film id="main" canvas={canvas.canvas} timeline={timeline.timeline} appearance={style.film.main}>',
      '    <film:Track source={picture.visual}/>',
      ...(hasAudio?['    <film:Track source={sound.audio}/>']:[]),
      '  </film:Film>',
      '  <html:Video id="final" composition={main.composition} timeline={timeline.timeline}/>',
    ].join('\n')+'\n</svml>\n';
    const run=`<?svml using="@hypit/markup/run@1"?>\n<svrun version="1">\n  <author source="./${sourceRelativePath}"/>\n  <target output="final.video"/>\n</svrun>\n`;
    const files=[[sourceRelativePath,author],[runRelativePath,run]];
    // Repeated explicit imports reuse the same Source, but never replace user edits.
    for(const [name,content] of files){
      const target=path.join(directory,name);
      if(fs.existsSync(target)){
        try{noLinks(workspace,target);if(!fs.statSync(target).isFile()||fs.readFileSync(target,'utf8')!==content)throw failure('PREVIEW_SOURCE_CONFLICT');}
        catch{throw failure('PREVIEW_SOURCE_CONFLICT');}
      }
    }
    for(const [name,content] of files)if(!fs.existsSync(path.join(directory,name)))fs.writeFileSync(path.join(directory,name),content,{flag:'wx'});
    return {runRelativePath,sourceRelativePath,duration,width,height,hasAudio};
  }
  async function stop(){
    epoch++;
    const owned=child;child=null;
    state={state:'stopped',code:null,projectId:null,runRelativePath:null,runtimeProfileRelativePath:null,url:null};
    if(owned&&owned.exitCode===null){
      await new Promise(resolve=>{
        const timer=setTimeout(resolve,stopTimeoutMs);
        owned.once('close',()=>{clearTimeout(timer);resolve();});
        try{owned.kill();}catch{clearTimeout(timer);resolve();}
      });
    }
    return snapshot();
  }
  async function launch(input){
    const selected=selectedRun(input.projectId,input.runRelativePath);
    const profile=selectedProfile(selected.directory,input.runtimeProfilePath);
    const installed=installation();
    const env=childEnvironment(nodeExecutable,selectedToolDirectories);
    await stop();
    if(closed)throw failure('RUNTIME_CLOSED');
    const token=epoch,port=await allocatePort();
    if(token!==epoch||closed)return snapshot();
    if(!Number.isInteger(port)||port<1||port>65535)throw failure('PORT_UNAVAILABLE');
    state={state:'starting',code:null,projectId:input.projectId,runRelativePath:selected.relative,runtimeProfileRelativePath:profile.relative,url:null};
    if(envProvider){
      try{
        const provided=await envProvider();
        if(provided&&Object.keys(provided).length){
          const bridge=new URL(provided.HAMSTER_HYPIT_BRIDGE_URL);
          if(bridge.protocol!=='http:'||!['localhost','127.0.0.1','[::1]'].includes(bridge.hostname)||bridge.username||bridge.password||!bridge.port||bridge.hash||bridge.search||typeof provided.HAMSTER_HYPIT_BRIDGE_TOKEN!=='string'||! /^[A-Za-z0-9_.-]{24,256}$/.test(provided.HAMSTER_HYPIT_BRIDGE_TOKEN))throw failure('INVALID_BRIDGE_CONFIGURATION');
          env.HAMSTER_HYPIT_BRIDGE_URL=bridge.href;
          env.HAMSTER_HYPIT_BRIDGE_TOKEN=provided.HAMSTER_HYPIT_BRIDGE_TOKEN;
        }
      }catch{
        if(token===epoch)state={...state,state:'error',code:'INVALID_BRIDGE_CONFIGURATION',url:null};
        return snapshot();
      }
    }
    if(token!==epoch||closed)return snapshot();
    let owned;
    try{owned=spawnImpl(nodeExecutable,['--dns-result-order=ipv4first',installed.launcher,'studio','--run',selected.run,'--project',selected.directory,'--package-root',selected.directory,'--port',String(port),...(profile.absolute?['--runtime',profile.absolute]:[])],{
      cwd:selected.directory,windowsHide:true,shell:false,env,stdio:['ignore','pipe','pipe'],
    });}catch{state={...state,state:'error',code:'STUDIO_START_FAILED'};return snapshot();}
    child=owned;
    return await new Promise(resolve=>{
      let settled=false,candidate=null,tail='',checking=false,failureCode=null,ipv6Announcement=false;
      const finish=()=>{if(settled)return;settled=true;clearTimeout(timeout);clearInterval(interval);resolve(snapshot());};
      const fail=code=>{if(token!==epoch)return finish();failureCode=code;state={...state,state:'error',code,url:null};if(child===owned)child=null;try{owned.kill();}catch{}finish();};
      const check=async()=>{
        if(token!==epoch||closed)return finish();
        if(!candidate||checking||settled)return;
        checking=true;
        try{if(await probeHttp(candidate)&&token===epoch&&!settled&&owned.exitCode===null){state={...state,state:'ready',code:null,url:candidate};finish();}}
        catch{/* Retry health probes only; never retry generation or process submission. */}
        finally{checking=false;}
      };
      const consume=chunk=>{
        // Child output is never logged, stored or returned. Only a loopback URL is retained.
        tail=(tail+String(chunk).replace(/\u001b\[[0-9;]*m/g,'')).slice(-4096);
        for(const match of tail.matchAll(/https?:\/\/[^\s<>"']+/g)){
          const valid=loopbackUrl(match[0]);if(!valid)continue;
          const announced=new URL(valid);ipv6Announcement=announced.hostname==='[::1]';
          // UI uses one explicit IPv4 loopback origin. It is returned only after probing this exact URL.
          candidate=`http://127.0.0.1:${announced.port}/`;
        }
        void check();
      };
      const interval=setInterval(check,probeIntervalMs);
      const timeout=setTimeout(()=>fail(ipv6Announcement?'STUDIO_IPV4_UNAVAILABLE':'STUDIO_START_TIMEOUT'),startupTimeoutMs);
      owned.stdout?.on('data',consume);
      owned.stderr?.on('data',()=>{});
      owned.once('error',()=>fail('STUDIO_START_FAILED'));
      owned.once('close',()=>{
        if(token!==epoch)return finish();
        if(child===owned)child=null;
        state={...state,state:'error',code:failureCode??'STUDIO_EXITED',url:null};finish();
      });
    });
  }
  function startStudio(input={}){
    if(closed)return Promise.reject(failure('RUNTIME_CLOSED'));
    let profile;
    try{profile=selectedProfile(projectDirectory(input.projectId),input.runtimeProfilePath);}catch(error){return Promise.reject(error);}
    if(pending){
      if(pendingInput.projectId===input.projectId&&(input.runRelativePath??'build.svrun')===pendingInput.runRelativePath&&pendingInput.runtimeProfileRelativePath===profile.relative)return pending;
      return Promise.reject(failure('STUDIO_BUSY'));
    }
    if(state.state==='ready'&&state.projectId===input.projectId&&state.runRelativePath===(input.runRelativePath??'build.svrun')&&state.runtimeProfileRelativePath===profile.relative&&child?.exitCode===null)return Promise.resolve(snapshot());
    pendingInput={projectId:input.projectId,runRelativePath:input.runRelativePath??'build.svrun',runtimeProfileRelativePath:profile.relative};
    pending=launch(input).finally(()=>{pending=null;pendingInput=null;});return pending;
  }
  function status(){
    try{installation();}catch(error){return {...snapshot(),state:'unavailable',code:error.code,url:null};}
    return snapshot();
  }
  async function dispose(){closed=true;return await stop();}
  return {prepareProject,prepareVideoPreview,listProjects,projectDirectory,startStudio,status,stop,dispose};
}
module.exports={createHypitRuntime,loopbackUrl,HYPIT_VERSION,HYPIT_SOURCE_COMMIT};
