// Internal local integration only. Hypit itself is an unmodified, separately installed distribution.
const fs=require('node:fs');
const path=require('node:path');
const http=require('node:http');
const crypto=require('node:crypto');
const {pipeline}=require('node:stream/promises');
const {Readable,Transform}=require('node:stream');
const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
const runFile=promisify(execFile);

const send=(res,status,data)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','Referrer-Policy':'no-referrer'});res.end(JSON.stringify(data));};
const failure=(code,message,statusCode=400)=>Object.assign(Error(message),{code,publicMessage:message,statusCode});
async function read(req){
  if(!String(req.headers['content-type']||'').startsWith('application/json'))throw failure('hypit_invalid_request','请求格式无效',415);
  const chunks=[];let size=0;
  for await(const chunk of req){size+=chunk.length;if(size>65536)throw failure('hypit_request_large','请求内容过长',413);chunks.push(chunk);}
  try{const value=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(!value||typeof value!=='object'||Array.isArray(value))throw Error();return value;}catch{throw failure('hypit_invalid_request','请求格式无效');}
}
function localRequest(req,{requireOrigin=false}={}){
  const host=String(req.headers.host||'');
  return /^127\.0\.0\.1:\d+$/.test(host)&&req.headers['sec-fetch-site']!=='cross-site'&&
    (!requireOrigin&&!req.headers.origin||req.headers.origin===`http://${host}`);
}
function createHypit({enabled=true,dir,runtime,video,getAssets,taskStore,baseUrl,getExecutionContext,distributionRoot,nodeExecutable,metadataPath,runtimeFactory}={}){
  if(!dir)throw Error('Hypit private directory is required');
  const runtimeRoot=path.join(__dirname,'build','hypit-host');
  let providerServer=null,providerReady=null,providerUrl='',closed=false,activeProjectId=null,providerContext=null,studioOpening=false;
  let providerToken=crypto.randomBytes(32).toString('hex');
  const host=runtime||(runtimeFactory||require('./hypit-runtime.cjs').createHypitRuntime)({
    workspaceRoot:path.join(dir,'projects'),distributionRoot:distributionRoot||path.join(runtimeRoot,'node_modules','@hypit','hypit'),
    nodeExecutable:nodeExecutable||path.join(__dirname,'build','node-runtime','node.exe'),
    metadataPath:metadataPath||path.join(runtimeRoot,'hypit-install.json'),
    expectedCommit:'0d36de9a9d17562fca0e478969b80eb1c16a7693',
    toolDirectories:[path.join(runtimeRoot,'bin'),path.join(runtimeRoot,'node_modules','@ffprobe-installer','win32-x64')],
    envProvider:()=>({HAMSTER_HYPIT_BRIDGE_URL:providerUrl,HAMSTER_HYPIT_BRIDGE_TOKEN:providerToken}),
  });
  const bridge=video||require('./hypit-video.cjs').createHypitVideoBridge({dir:path.join(dir,'operations'),getAssets,taskStore,baseUrl,getExecutionContext});
  const handles=p=>p==='/api/hypit'||p.startsWith('/api/hypit/');
  const projects=async()=> (await host.listProjects()).map(p=>({id:p.id||p.projectId,name:p.label||p.name||'未命名项目'}));
  async function status(){
    const value=await host.status();
    const context=getExecutionContext?.()||{owner:'',revision:0,scope:''};
    const installed=value.installed===true||value.state==='ready';
    return {enabled:enabled===true,internalOnly:true,runtime:{state:installed?'ready':'missing',items:[{name:'hypit',state:installed?'ready':'missing'},{name:'ffmpeg',state:'unverified'},{name:'chrome',state:'unverified'}]},
      account:{state:'unavailable',loginAvailable:false,message:'尚未确认个人 ChatGPT 应用接入资格，登录与推理保持关闭。'},
      agent:{available:false},execution:{scope:typeof context.scope==='string'?context.scope:'',revision:Number.isSafeInteger(context.revision)?context.revision:0},projects:await projects(),...(value.url?{studio:{projectId:value.projectId,url:value.url}}:{}),
      video:{available:Boolean(context.owner)},message:'本地集成阶段；未启用 GPT 推理，也未代表真实视频生成验收通过。'};
  }
  function assertProject(projectId){if(typeof projectId!=='string')throw failure('hypit_project_invalid','请选择本地项目');return host.projectDirectory(projectId);}
  async function videoRoute(req,res,url,{provider=false}={}){
    const route=url.pathname.replace(/^\/api\/hypit\/video/,'');
    if(provider){
      if(!activeProjectId||typeof bridge.handle!=='function')throw failure('hypit_provider_inactive','项目连接已失效',403);
      return bridge.handle(req,res,url,{isProvider:true,projectId:activeProjectId});
    }
    if(route==='/models'&&req.method==='GET')return send(res,200,await bridge.catalog());
    if(route==='/operations'&&req.method==='GET'){
      const projectId=url.searchParams.get('projectId');assertProject(projectId);return send(res,200,{operations:await bridge.list(projectId)});
    }
    if(route==='/quote'&&req.method==='POST'){
      const input=await read(req);assertProject(input.projectId);return send(res,200,await bridge.quote(input));
    }
    if(route==='/confirm'&&req.method==='POST'){
      if(provider||!localRequest(req,{requireOrigin:true}))throw failure('hypit_confirmation_denied','必须在仓鼠界面中确认本次费用',403);
      return send(res,200,await bridge.confirm(await read(req)));
    }
    if(route==='/start'&&req.method==='POST')return send(res,200,await bridge.start(await read(req)));
    if(route==='/import-result'&&req.method==='POST'){
      const input=await read(req),item=await bridge.poll(input.requestId);
      if(item.status!=='succeeded'||item.result?.url!==`/api/hypit/video/operations/${item.requestId}/file`)throw failure('hypit_result_pending','原视频尚未保存完成',409);
      const projectRoot=assertProject(item.projectId),before={...getExecutionContext()};
      const media=require('./hypit-project.cjs').localMediaPaths(runtimeRoot);
      if(!media||!host.prepareVideoPreview)throw failure('hypit_media_missing','本地媒体组件尚未准备完成',503);
      const assets=path.join(projectRoot,'assets');
      if(fs.existsSync(assets)&&fs.lstatSync(assets).isSymbolicLink())throw failure('hypit_invalid_path','项目目录无效',409);
      fs.mkdirSync(assets,{recursive:true});
      let videoPath=['mp4','webm','mov'].map(ext=>`assets/${item.requestId}.${ext}`).find(file=>fs.existsSync(path.join(projectRoot,file)));
      let target=videoPath&&path.join(projectRoot,videoPath);
      const assertCurrent=()=>{const now=getExecutionContext();if(now.owner!==before.owner||now.revision!==before.revision)throw failure('hypit_account_changed','账户配置已变化，请重新核对本地结果',409);};
      if(!target){
        const response=await fetch(new URL(item.result.url,baseUrl()),{redirect:'error',signal:AbortSignal.timeout(120000)});
        assertCurrent();
        if(!response.ok||!response.body||!String(response.headers.get('content-type')).startsWith('video/'))throw failure('hypit_result_pending','原视频尚未保存完成',409);
        const mime=String(response.headers.get('content-type')).split(';')[0];
        const extension={'video/mp4':'mp4','video/webm':'webm','video/quicktime':'mov'}[mime];
        if(!extension)throw failure('hypit_media_invalid','本地视频格式尚未支持，原视频仍保留',422);
        videoPath=`assets/${item.requestId}.${extension}`;target=path.join(projectRoot,videoPath);
        let size=0;const temp=target+'.'+crypto.randomUUID()+'.part';
        try{await pipeline(Readable.fromWeb(response.body),new Transform({transform(chunk,_encoding,callback){size+=chunk.length;callback(size>512*1024*1024?Error('limit'):null,chunk);}}),fs.createWriteStream(temp,{flags:'wx'}));assertCurrent();fs.renameSync(temp,target);}catch(error){try{fs.unlinkSync(temp);}catch{}throw error;}
      }
      if(fs.lstatSync(target).isSymbolicLink())throw failure('hypit_invalid_path','项目结果文件无效',409);
      let info;
      try{const output=await runFile(media.ffprobePath,['-v','error','-show_streams','-show_format','-of','json',target],{windowsHide:true,shell:false,timeout:15000,maxBuffer:1024*1024});info=JSON.parse(output.stdout);}catch{throw failure('hypit_media_invalid','无法读取本地视频规格，原视频仍保留',422);}
      assertCurrent();const stream=info.streams?.find(s=>s.codec_type==='video'),duration=Number(info.format?.duration||stream?.duration);
      if(!stream||!Number.isFinite(duration)||duration<=0)throw failure('hypit_media_invalid','无法读取本地视频规格，原视频仍保留',422);
      const preview=await host.prepareVideoPreview({projectId:item.projectId,operationId:item.requestId,videoPath,duration,width:stream.width,height:stream.height,hasAudio:info.streams.some(s=>s.codec_type==='audio')});
      const profile=require('./hypit-project.cjs').configureProject({projectRoot,projectId:item.projectId,hostRoot:runtimeRoot});
      assertCurrent();
      const studio=await openStudio(item.projectId,preview.runRelativePath,profile.profilePath);
      if(studio.state!=='ready'||!studio.url)throw failure('hypit_preview_failed','本地预览未完成，原视频仍保留',503);
      return send(res,200,{projectId:item.projectId,url:studio.url});
    }
    const match=route.match(/^\/operations\/([a-zA-Z0-9_-]{1,100})(\/file)?$/);
    if(match&&req.method==='GET'){
      if(!match[2])return send(res,200,await bridge.poll(match[1]));
      if(typeof bridge.handle==='function')return bridge.handle(req,res,url,{isProvider:provider});
      const file=await bridge.file(match[1]);
      res.writeHead(200,{'Content-Type':file.contentType||'video/mp4','Cache-Control':'no-store','Referrer-Policy':'no-referrer'});
      fs.createReadStream(file.path).on('error',()=>res.destroy()).pipe(res);return;
    }
    throw failure('hypit_route_not_found','功能接口未开放',404);
  }
  async function ensureProvider(projectId){
    const context=getExecutionContext?.()||{owner:'',revision:0};
    if(activeProjectId!==projectId||providerContext?.owner!==context.owner||providerContext?.revision!==context.revision){activeProjectId=projectId;providerContext={...context};providerToken=crypto.randomBytes(32).toString('hex');}
    if(providerReady)return providerReady;
    providerReady=new Promise((resolve,reject)=>{
      providerServer=http.createServer((req,res)=>{
        const current=getExecutionContext?.()||{owner:'',revision:0};
        if(!providerContext||current.owner!==providerContext.owner||current.revision!==providerContext.revision){send(res,403,{error:'账户配置已变化，请重新打开工作区'});return;}
        if(!localRequest(req)||req.headers.origin||req.headers.authorization!==`Bearer ${providerToken}`){send(res,403,{error:'访问无效'});return;}
        const url=new URL(req.url,'http://127.0.0.1');
        const route=url.pathname.replace(/^\/api\/hypit\/video/,'');
        const allowed=(req.method==='GET'&&['/models','/operations'].includes(route))||
          (req.method==='POST'&&['/quote','/start'].includes(route))||
          (['GET','HEAD'].includes(req.method)&&/^\/operations\/hypit-[a-f0-9]{64}(?:\/file)?$/.test(route));
        if(!url.pathname.startsWith('/api/hypit/video/')||!allowed){send(res,403,{error:'此连接不允许该操作'});return;}
        videoRoute(req,res,url,{provider:true}).catch(error=>send(res,error.statusCode||500,{error:error.publicMessage||'本地视频连接暂不可用',code:error.code||'hypit_video_error'}));
      });
      providerServer.once('error',()=>{providerReady=null;reject(failure('hypit_bridge_failed','本地视频连接启动失败',503));});
      providerServer.listen(0,'127.0.0.1',()=>{providerUrl=`http://127.0.0.1:${providerServer.address().port}`;resolve(providerUrl);});
    });
    return providerReady;
  }
  async function openStudio(projectId,runRelativePath,runtimeProfilePath){
    if(studioOpening)throw failure('hypit_studio_busy','正在打开工作区，请稍后操作',409);
    studioOpening=true;
    try{await ensureProvider(projectId);return await host.startStudio({projectId,runRelativePath,...(runtimeProfilePath?{runtimeProfilePath}:{})});}
    finally{studioOpening=false;}
  }
  async function handle(req,res,url){
    if(closed)throw failure('hypit_closed','本地工作区已关闭',503);
    if(!localRequest(req))throw failure('hypit_origin_denied','请求来源无效',403);
    if(!enabled)return send(res,url.pathname==='/api/hypit/status'?200:404,{enabled:false,internalOnly:true});
    const p=url.pathname;
    if(p==='/api/hypit/status'&&req.method==='GET')return send(res,200,await status());
    if(p==='/api/hypit/projects'&&req.method==='GET')return send(res,200,{projects:await projects()});
    if(req.method!=='GET'&&!localRequest(req,{requireOrigin:true}))throw failure('hypit_origin_denied','请在仓鼠界面操作',403);
    if(p==='/api/hypit/projects'&&req.method==='POST'){
      const value=await read(req),label=String(value.name||'').trim();
      if(!label||label.length>80)throw failure('hypit_name_invalid','项目名称需为1至80个字符');
      const project=await host.prepareProject({label}),id=project.id||project.projectId;
      if(!runtime&&!runtimeFactory)require('./hypit-project.cjs').configureProject({projectRoot:host.projectDirectory(id),projectId:id,hostRoot:runtimeRoot});
      return send(res,201,{project:{id,name:project.label||label}});
    }
    if(p==='/api/hypit/studio/open'&&req.method==='POST'){
      const input=await read(req);const projectRoot=assertProject(input.projectId);
      const profile=!runtime&&!runtimeFactory?require('./hypit-project.cjs').configureProject({projectRoot,projectId:input.projectId,hostRoot:runtimeRoot}):null;
      const studio=await openStudio(input.projectId,'build.svrun',profile?.profilePath);
      if(studio.state&&studio.state!=='ready'||!studio.url)throw failure('hypit_studio_failed','Studio 启动未完成，请检查内部运行组件',503);
      return send(res,200,{projectId:studio.projectId,url:studio.url});
    }
    if(p==='/api/hypit/studio/close'&&req.method==='POST'){activeProjectId=null;providerToken=crypto.randomBytes(32).toString('hex');await host.stop();return send(res,200,{ok:true});}
    if(p==='/api/hypit/account/login'&&req.method==='POST')throw failure('hypit_account_eligibility','尚未确认应用接入资格，个人账户登录未启用',409);
    if(p.startsWith('/api/hypit/video/'))return videoRoute(req,res,url);
    throw failure('hypit_route_not_found','功能接口未开放',404);
  }
  function stop(){closed=true;Promise.resolve(host.dispose?host.dispose():host.stop?.()).catch(()=>{});providerServer?.closeAllConnections?.();providerServer?.close();}
  return {handles,handle,status,stop};
}
module.exports={createHypit,localRequest};
