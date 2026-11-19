// Synthetic local-only acceptance. No desktop configuration, account or customer media is read.
'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http'),crypto=require('node:crypto');
const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
const {createHypitRuntime}=require('../hypit-runtime.cjs');
const {configureProject,localMediaPaths}=require('../hypit-project.cjs');
const execute=promisify(execFile);
const root=path.resolve(__dirname,'..'),hostRoot=path.join(root,'build','hypit-host');
const node=path.join(root,'build','node-runtime','node.exe'),launcher=path.join(hostRoot,'node_modules','@hypit','hypit','bin','hypit.mjs');

async function main({render=process.argv.includes('--render'),storyboard=process.argv.includes('--storyboard')}={}){
  const media=localMediaPaths(hostRoot);
  if(!media||!fs.existsSync(node)||!fs.existsSync(launcher))throw Object.assign(Error('LOCAL_DEPENDENCIES_MISSING'),{code:'LOCAL_DEPENDENCIES_MISSING'});
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'hamster-hypit-preview-'));
  let phase='setup',providerCalls=0,profilePath,host;
  const token=crypto.randomBytes(32).toString('hex');
  const mock=http.createServer((_req,res)=>{providerCalls++;res.writeHead(503,{'Content-Type':'application/json'});res.end('{"error":"synthetic acceptance never invokes video generation"}');});
  await new Promise(resolve=>mock.listen(0,'127.0.0.1',resolve));
  const env={};for(const key of ['SystemRoot','WINDIR','TEMP','TMP'])if(process.env[key])env[key]=process.env[key];
  env.PATH=[path.dirname(node),process.env.SystemRoot&&path.join(process.env.SystemRoot,'System32'),process.env.SystemRoot&&path.join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0')].filter(Boolean).join(path.delimiter);
  env.HAMSTER_HYPIT_BRIDGE_URL=`http://127.0.0.1:${mock.address().port}`;env.HAMSTER_HYPIT_BRIDGE_TOKEN=token;
  const run=async(executable,args,timeout=30000)=>{
    try{return await execute(executable,args,{cwd:temporary,windowsHide:true,env,timeout,maxBuffer:4*1024*1024});}
    catch(error){
      // This bounded debug file contains only synthetic test failures, never customer records.
      fs.writeFileSync(path.join(temporary,'internal-failure.txt'),String(error.stdout||'')+'\n'+String(error.stderr||'')+'\n');
      throw Object.assign(Error('LOCAL_COMMAND_FAILED'),{code:'LOCAL_COMMAND_FAILED',exitCode:Number.isInteger(error.code)?error.code:null});
    }
  };
  const cli=async args=>JSON.parse((await run(node,[launcher,...args])).stdout);
  try{
    host=createHypitRuntime({workspaceRoot:path.join(temporary,'projects'),distributionRoot:path.join(hostRoot,'node_modules','@hypit','hypit'),nodeExecutable:node,metadataPath:path.join(hostRoot,'hypit-install.json'),toolDirectories:[path.join(hostRoot,'bin'),path.dirname(media.ffprobePath)],envProvider:()=>({HAMSTER_HYPIT_BRIDGE_URL:env.HAMSTER_HYPIT_BRIDGE_URL,HAMSTER_HYPIT_BRIDGE_TOKEN:token})});
    const project=host.prepareProject({projectId:'synthetic-preview'}),projectRoot=host.projectDirectory(project.id);
    profilePath=configureProject({projectRoot,projectId:project.id,hostRoot}).profilePath;
    const profile=JSON.parse(fs.readFileSync(profilePath,'utf8'));
    if(profile.endpoints?.['html.local']?.config?.chromePath!==media.chromePath||profile.endpoints?.['html.local']?.config?.browserVersion||profile.endpoints?.['media.local']?.config?.ffprobePath!==media.ffprobePath)throw Object.assign(Error('UNSAFE_LOCAL_PROFILE'),{code:'UNSAFE_LOCAL_PROFILE'});
    fs.mkdirSync(path.join(projectRoot,'assets'));
    const cases=[];
    for(const hasAudio of [false,true]){
      phase=hasAudio?'audio-fixture':'silent-fixture';
      const videoPath=`assets/${hasAudio?'audio':'silent'}.mp4`,absolute=path.join(projectRoot,videoPath);
      await run(media.ffmpegPath,['-hide_banner','-loglevel','error','-f','lavfi','-i','color=c=blue:s=64x64:r=30:d=0.5',...(hasAudio?['-f','lavfi','-i','sine=frequency=440:sample_rate=48000:duration=0.5']:[]),'-c:v','libx264','-pix_fmt','yuv420p',...(hasAudio?['-c:a','aac','-shortest']:['-an']),absolute]);
      const facts=JSON.parse((await run(media.ffprobePath,['-v','error','-show_streams','-show_format','-of','json',absolute])).stdout);
      const video=facts.streams.find(stream=>stream.codec_type==='video'),actualAudio=facts.streams.some(stream=>stream.codec_type==='audio');
      if(actualAudio!==hasAudio)throw Object.assign(Error('SYNTHETIC_STREAM_MISMATCH'),{code:'SYNTHETIC_STREAM_MISMATCH'});
      const before=crypto.createHash('sha256').update(fs.readFileSync(absolute)).digest('hex');
      const preview=host.prepareVideoPreview({projectId:project.id,operationId:hasAudio?'audio':'silent',videoPath,duration:Number(facts.format.duration),width:video.width,height:video.height,hasAudio:actualAudio});
      const source=fs.readFileSync(path.join(projectRoot,preview.sourceRelativePath),'utf8');
      if(/hamster:Video|https?:\/\/|TextVideo/.test(source))throw Object.assign(Error('NONLOCAL_SOURCE_REJECTED'),{code:'NONLOCAL_SOURCE_REJECTED'});
      phase=hasAudio?'audio-check':'silent-check';
      const check=await cli(['check',path.join(projectRoot,preview.runRelativePath),'--project',projectRoot,'--json']);
      if(!check.ok)throw Object.assign(Error('SDK_CHECK_FAILED'),{code:'SDK_CHECK_FAILED'});
      phase=hasAudio?'audio-preview':'silent-preview';
      const studio=await host.startStudio({projectId:project.id,runRelativePath:preview.runRelativePath,runtimeProfilePath:profilePath});
      if(studio.state!=='ready')throw Object.assign(Error('STUDIO_NOT_READY'),{code:studio.code||'STUDIO_NOT_READY'});
      const response=await fetch(new URL('/__studio/session',studio.url),{signal:AbortSignal.timeout(30000)});
      const session=await response.json();
      const facets=(session.tracks||[]).map(track=>track.binding?.facet),audioTracks=facets.filter(facet=>facet==='audio').length;
      if(response.status!==200||audioTracks!==(hasAudio?1:0)||!facets.includes('visual')||session.canvas?.width!==64||session.canvas?.height!==64)throw Object.assign(Error('STUDIO_SESSION_MISMATCH'),{code:'STUDIO_SESSION_MISMATCH'});
      let storyboardBytes;
      if(storyboard&&hasAudio){
        phase='audio-storyboard';
        const resources=[...new Set([...JSON.stringify(session).matchAll(/\/__studio\/material\/(res_[A-Za-z0-9._:-]+)/g)].map(match=>match[1]))];
        let selected;
        for(const resource of resources){
          const material=await fetch(new URL('/__studio/material/'+resource,studio.url),{method:'HEAD',signal:AbortSignal.timeout(5000)});
          if(material.ok&&material.headers.get('content-type')?.startsWith('video/')){selected=resource;break;}
        }
        if(!selected)throw Object.assign(Error('STORYBOARD_RESOURCE_MISSING'),{code:'STORYBOARD_RESOURCE_MISSING'});
        const image=await fetch(new URL('/__studio/storyboard/'+selected,studio.url),{signal:AbortSignal.timeout(15000)});
        const png=Buffer.from(await image.arrayBuffer());
        if(image.status!==200||image.headers.get('content-type')!=='image/png'||!png.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))||Number(image.headers.get('x-hypit-storyboard-count'))<=0)throw Object.assign(Error('STORYBOARD_IMAGE_INVALID'),{code:'STORYBOARD_IMAGE_INVALID'});
        storyboardBytes=png.length;
      }
      await host.stop();
      const result={hasAudio,check:true,preview:true,tracks:facets.length,audioTracks,rendered:false,...(storyboardBytes?{storyboard:true,storyboardBytes}:{})};
      if(render){
        phase=hasAudio?'audio-build':'silent-build';
        const built=JSON.parse((await run(node,[launcher,'build',path.join(projectRoot,preview.runRelativePath),'--project',projectRoot,'--runtime',profilePath,'--follow','--max-wait-ms','60000','--json'],90000)).stdout);
        if(!built.build?.id||built.build?.result?.outcome==='failed'||built.build?.work?.state==='failed')throw Object.assign(Error('LOCAL_BUILD_FAILED'),{code:'LOCAL_BUILD_FAILED'});
        phase=hasAudio?'audio-export':'silent-export';
        const output=path.join(temporary,hasAudio?'export-audio.mp4':'export-silent.mp4');
        await cli(['get',built.build.id,'--output','final.video','--to',output,'--project',projectRoot,'--json']);
        const exported=JSON.parse((await run(media.ffprobePath,['-v','error','-show_streams','-show_format','-of','json',output])).stdout);
        const picture=exported.streams.find(stream=>stream.codec_type==='video'),sound=exported.streams.some(stream=>stream.codec_type==='audio'),seconds=Number(exported.format.duration);
        if(fs.statSync(output).size<=0||picture?.width!==64||picture?.height!==64||Math.abs(seconds-.5)>.1||hasAudio&&!sound)throw Object.assign(Error('LOCAL_EXPORT_MISMATCH'),{code:'LOCAL_EXPORT_MISMATCH'});
        let maxVolumeDb=null;
        if(sound){
          const volume=await run(media.ffmpegPath,['-hide_banner','-i',output,'-vn','-af','volumedetect','-f','null','-']);
          const matched=volume.stderr.match(/max_volume:\s*(-?[\d.]+|-inf) dB/);
          if(!matched)throw Object.assign(Error('LOCAL_AUDIO_UNVERIFIED'),{code:'LOCAL_AUDIO_UNVERIFIED'});
          maxVolumeDb=matched[1]==='-inf'?-Infinity:Number(matched[1]);
          // Hypit's final mux intentionally supplies silence for a Film with no audio Track.
          if(hasAudio&&maxVolumeDb<-60||!hasAudio&&maxVolumeDb>-80)throw Object.assign(Error('LOCAL_AUDIO_MISMATCH'),{code:'LOCAL_AUDIO_MISMATCH'});
        }
        Object.assign(result,{rendered:true,bytes:fs.statSync(output).size,width:picture.width,height:picture.height,duration:seconds,exportHasAudio:sound,...(sound?{maxVolumeDb:Number.isFinite(maxVolumeDb)?maxVolumeDb:'-Infinity'}:{})});
      }
      if(before!==crypto.createHash('sha256').update(fs.readFileSync(absolute)).digest('hex'))throw Object.assign(Error('SOURCE_CHANGED'),{code:'SOURCE_CHANGED'});
      cases.push(result);
    }
    if(providerCalls!==0)throw Object.assign(Error('UNEXPECTED_PROVIDER_CALL'),{code:'UNEXPECTED_PROVIDER_CALL'});
    return {ok:true,syntheticOnly:true,providerCalls,render,cases};
  }catch(error){
    return {ok:false,syntheticOnly:true,providerCalls,phase,code:error.code||'LOCAL_ACCEPTANCE_FAILED',exitCode:error.exitCode??null};
  }finally{
    await host?.dispose();
    if(profilePath)try{await run(node,[launcher,'runtime','down','--runtime',profilePath,'--project',path.dirname(profilePath),'--json'],15000);}catch{}
    mock.closeAllConnections?.();await new Promise(resolve=>mock.close(resolve));
  }
}
if(require.main===module)main().then(result=>{console.log(JSON.stringify(result));if(!result.ok)process.exitCode=1;}).catch(()=>{console.log(JSON.stringify({ok:false,syntheticOnly:true,code:'LOCAL_DEPENDENCIES_MISSING'}));process.exitCode=1;});
module.exports={main};
