// Isolated real-browser fixture: three synthetic Keys, no outbound network.
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),https=require('node:https'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {execFileSync}=require('node:child_process');
const root=path.resolve(__dirname,'..'),dir=path.join(root,'output','playwright','three-key-canvas'),dataDir=path.join(dir,'fixture-data');
fs.mkdirSync(dataDir,{recursive:true});
const nativeFetch=global.fetch;
global.fetch=(target,options)=>{const u=new URL(typeof target==='string'?target:target.url||target.href);assert.equal(u.hostname,'127.0.0.1','offline fixture blocks all external requests');return nativeFetch(target,options);};
const {createApp}=require('../server.js'),{createPiknoKeyStore}=require('../pikno-key-store.cjs');
const ffmpeg=path.join(root,'build','python-stage-T8O67k','Lib','site-packages','imageio_ffmpeg','binaries','ffmpeg-win-x86_64-v7.1.exe');
for(const [name,args] of [['image.png',['-f','lavfi','-i','color=c=0x5b8cdb:s=320x240','-frames:v','1']],['voice.wav',['-f','lavfi','-i','sine=frequency=440:duration=1','-c:a','pcm_s16le']],['video.mp4',['-f','lavfi','-i','color=c=0x3fbc8a:s=320x240:r=12:d=1','-c:v','libx264','-pix_fmt','yuv420p','-movflags','+faststart']]])execFileSync(ffmpeg,['-y','-loglevel','error',...args,path.join(dataDir,name)],{windowsHide:true});
const keyFor=kind=>'sk-'+({image:'a',video:'b',tool:'c'}[kind]).repeat(48),keyField=kind=>'pikno'+({image:'Image',video:'Video',tool:'Tool'}[kind])+'Key';
const models=[{id:'main-image-1234abcd',name:'主线路 · 图片',type:'image',provider:'generate',aspect_ratios:['1:1','4:3'],size_options:['1024x1024','2048x2048','1024x768'],quality_options:['auto','medium','high'],default_quality:'auto',max_images:3,max_videos:0,max_audios:0,max_media_files:3,concurrency_options:[1],billing_mode:'relay'},
{id:'main-video-5678abcd',name:'主线路 · 视频 · 720p',type:'video',provider:'generate',ratios:['16:9','9:16'],resolutions:['720p','480p'],durations:[4,5],max_images:3,max_videos:1,max_audios:1,max_media_files:5,concurrency_options:[1],billing_mode:'relay'},
{id:'tool-digital',name:'数字人',type:'video',provider:'tool',max_images:1,max_videos:0,max_audios:1,max_media_files:2,concurrency_options:[1],billing_mode:'relay'},
{id:'tool-depth',name:'黑白深度视频',type:'video',provider:'tool',max_images:0,max_videos:1,max_audios:0,max_media_files:1,concurrency_options:[1],billing_mode:'relay'}];
const uploads=new Map(),jobs=new Map(),events=[];let mediaBase,appBase,app,mode='success',toolsOpen=true,holdDirectory=false,directoryResolvers=[];
const record=(type,value)=>{events.push({type,...value});fs.writeFileSync(path.join(dir,'events.json'),JSON.stringify(events,null,2));};
const checkKey=(cfg,kind)=>assert.equal(cfg[keyField(kind)],keyFor(kind),'the selected function must use its dedicated synthetic Key');
const client={context:async(cfg,kind)=>{checkKey(cfg,kind);return {user_id:7,group:kind+'-standard'};},catalog:async cfg=>{
  const available=models.filter(m=>(m.provider!=='tool'||toolsOpen)&&cfg[keyField(m.provider==='tool'?'tool':m.type)]);
  if(holdDirectory)await new Promise(resolve=>directoryResolvers.push(resolve));
  return {data:available,resolve:id=>{const model=available.find(m=>m.id===id);return model?{id,kind:model.type,tool:model.provider==='tool'}:undefined;}};
},upload:async(cfg,stream,metadata)=>{const kind=metadata.kind;checkKey(cfg,kind);const chunks=[];for await(const chunk of stream)chunks.push(chunk);const id=crypto.randomBytes(16).toString('hex');uploads.set(id,{kind,bytes:Buffer.concat(chunks),mime:metadata.contentType});record('upload',{kind,mime:metadata.contentType});return {file:{url:mediaBase+'/media/'+id+'?ticket=synthetic-only'}};},submit:async(cfg,line,payload)=>{
  const kind=line.tool?'tool':line.kind;checkKey(cfg,kind);
  for(const media of [...payload.images||[],...payload.videos||[],...payload.audios||[]]){const id=new URL(media.url).pathname.split('/').pop();assert.equal(uploads.get(id)?.kind,kind,'reference authorization must match the destination');}
  record('submit',{model:line.id,kind,prompt:payload.prompt||'',size:payload.size,quality:payload.quality,ratio:payload.ratio,resolution:payload.resolution,duration:payload.duration,images:payload.images?.length||0,videos:payload.videos?.length||0,audios:payload.audios?.length||0,mode});
  if(mode==='ambiguous')throw Object.assign(Error('runninghub private.example sk-secret upstream error'),{statusCode:503,ambiguous:true});
  if(mode==='failed')throw Object.assign(Error('runninghub private.example sk-secret upstream error'),{statusCode:400});
  if(line.kind==='image')return {data:[{url:mediaBase+'/result/image.png'}]};
  const id='synthetic_'+crypto.randomBytes(6).toString('hex');jobs.set(id,{kind,polls:0,mode});return {id,status:mode==='unknown'?'unknown':'queued'};
},query:async(cfg,item)=>{const job=jobs.get(item.id);checkKey(cfg,job.kind);job.polls++;record('query',{id:item.id,kind:job.kind});return job.mode==='unknown'&&job.polls<3?{id:item.id,status:'unknown'}:{id:item.id,status:'completed',outputs:[{type:'video',url:mediaBase+'/result/video.mp4'}]};}};
const send=(res,value,status=200)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(value));};
const certDir=path.join(root,'build','qa-localhost-tls');
const media=https.createServer({key:fs.readFileSync(path.join(certDir,'fixture.key')),cert:fs.readFileSync(path.join(certDir,'fixture.crt'))},(req,res)=>{
  const name=req.url?.startsWith('/result/image.png')?'image.png':req.url?.startsWith('/result/video.mp4')?'video.mp4':'';
  if(name){res.writeHead(200,{'Content-Type':name.endsWith('.png')?'image/png':'video/mp4'});return res.end(fs.readFileSync(path.join(dataDir,name)));}
  res.writeHead(404).end();
});
const control=http.createServer(async(req,res)=>{
  const url=new URL(req.url,'http://127.0.0.1');
  if(url.pathname==='/state')return send(res,{mode,toolsOpen,events,appBase,assets:[...uploads.values()].map(v=>({kind:v.kind,mime:v.mime}))});
  if(url.pathname==='/mode'){mode=url.searchParams.get('value')||'success';return send(res,{mode});}
  if(url.pathname==='/tools'){toolsOpen=url.searchParams.get('open')!=='0';return send(res,{toolsOpen});}
  if(url.pathname==='/hold-directory'){holdDirectory=url.searchParams.get('hold')==='1';if(!holdDirectory){for(const resolve of directoryResolvers)resolve();directoryResolvers=[];}return send(res,{holdDirectory});}
  if(url.pathname==='/rotate'){const r=await fetch(appBase+'/api/config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({piknoToolKey:keyFor('tool')})});return send(res,{status:r.status});}
  if(url.pathname==='/close'){send(res,{closed:true});setImmediate(()=>{app.close(()=>media.close(()=>control.close(()=>process.exit(0))));});return;}
  send(res,{error:'fixture control route missing'},404);
});
async function listen(server){return new Promise(resolve=>server.listen(0,'127.0.0.1',()=>resolve(server.address().port)));}
(async()=>{
  mediaBase='https://127.0.0.1:'+await listen(media);const controlBase='http://127.0.0.1:'+await listen(control);
  app=createApp({relayMode:true,relayClient:client,relayKeyStore:createPiknoKeyStore(),openBrowserImpl:()=>{},configPath:path.join(dataDir,'config.json'),resultDir:path.join(dataDir,'results'),taskDir:path.join(dataDir,'tasks'),assetDir:path.join(dataDir,'assets'),smartVideoLauncher:{stop(){},status:async()=>({running:false})},inferenceGateway:{handle:async(_req,res)=>send(res,{configured:false},503)},taskOptions:{tickMs:50,interval:100}});
  appBase='http://127.0.0.1:'+await listen(app);
  const configured=await fetch(appBase+'/api/config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({piknoImageKey:keyFor('image'),piknoVideoKey:keyFor('video'),piknoToolKey:keyFor('tool')})});assert.equal(configured.status,200);
  const opened=await fetch(appBase+'/api/canvas/open',{method:'POST'});assert.equal(opened.status,200);const {url}=await opened.json();
  fs.writeFileSync(path.join(dir,'session.json'),JSON.stringify({appBase,controlBase,url,dataDir},null,2));console.log(JSON.stringify({appBase,controlBase,url,dataDir}));
})().catch(e=>{console.error(e.message);process.exitCode=1;});
