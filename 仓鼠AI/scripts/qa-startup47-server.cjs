// Disposable loopback-only browser fixture. No real accounts, model runs or CLI.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http'),{fork}=require('node:child_process');
const realFetch=global.fetch;
let blockedFetches=0;
global.fetch=(target,...args)=>{const url=new URL(typeof target==='string'||target instanceof URL?target:target.url);if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'){blockedFetches++;return Promise.reject(Error('External networking is blocked'));}return realFetch(target,...args);};
const json=(res,value,status=200)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(value));};
const read=async req=>{const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>256000)throw Error('Fixture body limit');chunks.push(chunk);}return JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}');};
const listen=app=>new Promise((resolve,reject)=>{app.once('error',reject);app.listen(0,'127.0.0.1',()=>resolve('http://127.0.0.1:'+app.address().port));});
const close=async app=>{if(!app?.listening)return;app.closeAllConnections?.();await new Promise(resolve=>app.close(resolve));};
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aG6kAAAAASUVORK5CYII=','base64');

async function childMain(){
  const profile=process.env.H47_QA_PROFILE,options=JSON.parse(process.env.H47_QA_SCENARIO),keys=options.keys||[];
  const requests=[],upstream=[],calls={keyWrites:0,keyClears:0,cli:0,python:0,launcherPrepare:0,launcherOpen:0,codexStatus:0,accountOpen:0,accountClose:0,paid:0},assetDir=path.join(profile,'assets');
  const configPath=path.join(profile,'config.json');fs.mkdirSync(profile,{recursive:true});
  if(!fs.existsSync(configPath))fs.writeFileSync(configPath,'{}\n');
  if(options.initializePreference&&options.lastView)await require('../startup-preferences.cjs').createStartupPreferences({configPath}).set({lastView:options.lastView});
  if(options.seedLocal){
    const taskDir=path.join(profile,'tasks');fs.mkdirSync(taskDir,{recursive:true});
    const key='1'.repeat(32);fs.writeFileSync(path.join(taskDir,key+'.json'),JSON.stringify({key,id:'qa-local-history47',walletUser:'pikno:900001',relay:true,source:'generate',provider:'generate',type:'image',modelId:'qa-image',modelName:'仓鼠合成图片',prompt:'合成本地历史记录47',status:'failed',createdAt:'2026-10-23T00:00:00.000Z',result:null}));
    const folder=path.join(assetDir,'达人'),id='2'.repeat(32);fs.mkdirSync(folder,{recursive:true});fs.writeFileSync(path.join(folder,id+'.png'),png);
    fs.writeFileSync(path.join(folder,id+'.json'),JSON.stringify({id,category:'talent',name:'合成本地素材47',ext:'png',kind:'image',size:png.length,created:'2026-10-23T00:00:00.000Z'}));
  }
  let assetReads=0;
  for(const name of ['readFileSync','readdirSync']){const original=fs[name];fs[name]=function(target,...args){if(typeof target==='string'&&path.resolve(target).startsWith(assetDir+path.sep)||target===assetDir)assetReads++;return original.call(this,target,...args);};}
  const {createApp}=require('../server.js'),{createPiknoClient}=require('../pikno-client.cjs');
  const fields={image:'piknoImageKey',video:'piknoVideoKey',tool:'piknoToolKey',chat:'piknoChatKey'};
  const syntheticKeys={image:'sk-'+'i'.repeat(48),video:'sk-'+'v'.repeat(48),tool:'sk-'+'t'.repeat(48),chat:'sk-'+'c'.repeat(48)};
  let stored=keys.length?{piknoUserId:900001,...Object.fromEntries(keys.map(kind=>[fields[kind],syntheticKeys[kind]]))}:{};
  const keyStore={persistent:true,read:()=>({...stored}),write:value=>{calls.keyWrites++;stored={...value};},clear:()=>{calls.keyClears++;stored={};}};
  const lines=[{id:'qa-image',name:'仓鼠图片测试线路',kind:'image',line_revision:1,resolutions:['1024x1024'],qualities:['auto'],ratios:['1:1'],max_images:9,max_videos:0,max_audio:0,max_media_total:9,prices:[{resolution:'1024x1024',unit:'image',retail_cny:'1'}]}];
  let fault=options.fault||null,visible=false,app;
  const relay=http.createServer((req,res)=>{
    const route=new URL(req.url,'http://127.0.0.1').pathname;
    if(route==='/chat/'){res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});return res.end('<!doctype html><html lang="zh-CN"><title>合成本地对话页</title><body>合成本地对话页；未启动 Python 或推理。</body></html>');}
    upstream.push({method:req.method,path:route});
    if(!['/v1/client/context','/v1/models','/api/pikno/catalog'].includes(route)){calls.paid++;return json(res,{error:'Forbidden in fixture'},400);}
    if(route==='/api/pikno/catalog')return json(res,{data:{models:lines}});
    const answer=()=>{
      if(fault==='timeout')return; // The real client aborts its 20-second read.
      if(fault==='offline'){req.socket.destroy();return;}
      if([401,403,409,429].includes(fault)){if(fault===429)res.setHeader('Retry-After','60');return json(res,{error:'Synthetic read failure'},fault);}
      const authorization=String(req.headers.authorization||'');
      const kind=Object.keys(syntheticKeys).find(value=>authorization==='Bearer '+syntheticKeys[value]);
      if(!kind)return json(res,{error:'Synthetic unauthorized'},401);
      if(route==='/v1/client/context')return json(res,{user_id:900001,group:kind+'-standard'});
      return json(res,{data:kind==='image'?[{id:'qa-image'}]:[]});
    };
    if(route==='/v1/client/context'&&options.delayIdentity)return setTimeout(answer,options.delayIdentity);
    return answer();
  });
  const relayBase=await listen(relay),client=require('../pikno-client.cjs').createPiknoClient({endpoint:relayBase});
  client.subscribeCatalog=()=>()=>{};
  const viewState=()=>({available:true,visible,state:visible?'ready':'closed'});
  app=createApp({relayMode:true,relayClient:client,relayKeyStore:keyStore,configPath,assetDir,resultDir:path.join(profile,'results'),taskDir:path.join(profile,'tasks'),diagnosticsDir:path.join(profile,'diagnostics'),diagnosticExportDir:path.join(profile,'diagnostic-export'),taskOptions:{tickMs:60000,interval:60000},
    smartVideoLauncher:{prepare:async()=>{calls.launcherPrepare++;return {status:'ready',progress:{percent:100}};},open:async()=>{calls.launcherOpen++;return {status:'ready',url:relayBase+'/chat/'};},status:async()=>({status:'ready',url:relayBase+'/chat/'}),stop(){}},
    codexClient:{status:async()=>{calls.codexStatus++;return {installed:false,available:false};},list:async()=>[],close(){}},hypitOptions:{enabled:false},chatcutOptions:{enabled:false},
    accountView:{state:viewState,open:async()=>{calls.accountOpen++;visible=true;return viewState();},close:async()=>{calls.accountClose++;visible=false;return viewState();},bounds:async()=>viewState(),reload:async()=>viewState()},
    inferenceGateway:{handle:async(_req,res)=>json(res,{configured:false},503)},reporter:{capture(){}}});
  const original=app.listeners('request')[0];app.removeAllListeners('request');
  app.on('request',async(req,res)=>{
    const url=new URL(req.url,'http://127.0.0.1');
    if(url.pathname==='/__qa/state')return json(res,{requests,upstream,calls,assetReads,blockedFetches,keyFlags:Object.fromEntries(Object.entries(fields).map(([kind,field])=>[kind,Boolean(stored[field])])),preference:fs.existsSync(path.join(profile,'ui-preferences.json'))?JSON.parse(fs.readFileSync(path.join(profile,'ui-preferences.json'),'utf8')):{}});
    if(url.pathname==='/__qa/control'){const input=await read(req);fault=input.fault||null;return json(res,{ok:true});}
    const entry={method:req.method,path:url.pathname,light:url.searchParams.get('light')==='1',at:Date.now()};requests.push(entry);res.once('finish',()=>{entry.status=res.statusCode;entry.finished=Date.now();});
    if(url.pathname==='/api/startup'&&options.startupFailure===503)return json(res,{error:'合成启动读取失败'},503);
    if(url.pathname==='/api/startup'&&options.startupFailure==='malformed'){res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});return res.end('{invalid');}
    if(options.preferenceFailure&&url.pathname==='/api/ui-preferences'&&req.method==='POST')return json(res,{error:'页面偏好暂时无法保存'},503);
    if(options.delayStartup&&url.pathname==='/api/startup')return setTimeout(()=>original(req,res),options.delayStartup);
    return original(req,res);
  });
  const base=await listen(app);
  let closing=false;
  async function shutdown(){if(closing)return;closing=true;await close(app);await close(relay);process.exit(0);}
  process.on('message',value=>{if(value==='stop')void shutdown();});process.once('SIGINT',shutdown);process.once('SIGTERM',shutdown);
  process.send?.({base,pid:process.pid});
}

async function parentMain(){
  const output=path.resolve(__dirname,'../../output/hamster-onboarding47-20261023');fs.mkdirSync(output,{recursive:true});
  let child,info,profile,options,run=0;const profiles=[],stderr=[];
  async function stop(){if(!child)return;const active=child;child=null;await new Promise(resolve=>{const timer=setTimeout(()=>{active.kill();resolve();},5000);active.once('exit',()=>{clearTimeout(timer);resolve();});active.send('stop');});}
  async function start(input,{restart=false}={}){
    await stop();if(!restart){options={...input,initializePreference:true};profile=fs.mkdtempSync(path.join(os.tmpdir(),'hamster-startup47-'));profiles.push(profile);}
    const active=child=fork(__filename,['--child'],{windowsHide:true,env:{...process.env,H47_QA_PROFILE:profile,H47_QA_SCENARIO:JSON.stringify({...options,initializePreference:!restart})},stdio:['ignore','pipe','pipe','ipc']});
    active.stdout.on('data',()=>{});active.stderr.on('data',chunk=>stderr.push(String(chunk).slice(0,1000)));
    info=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Fixture startup timeout')),15000);active.once('message',message=>{clearTimeout(timer);resolve(message);});active.once('exit',code=>{clearTimeout(timer);reject(Error('Fixture exited '+code));});});
    return {...info,run:++run};
  }
  const controller=http.createServer(async(req,res)=>{try{
    const route=new URL(req.url,'http://127.0.0.1').pathname;
    if(route==='/case'&&req.method==='POST')return json(res,await start(await read(req)));
    if(route==='/restart'&&req.method==='POST')return json(res,await start(options,{restart:true}));
    if(route==='/state'){const response=await fetch(info.base+'/__qa/state');return json(res,await response.json());}
    if(route==='/control'&&req.method==='POST'){const response=await fetch(info.base+'/__qa/control',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(await read(req))});return json(res,await response.json());}
    if(route==='/result'&&req.method==='POST'){const value=await read(req);fs.writeFileSync(path.join(output,'startup-browser.json'),JSON.stringify(value,null,2)+'\n');return json(res,{ok:true});}
    if(route==='/result-local-failure'&&req.method==='POST'){const value=await read(req);fs.writeFileSync(path.join(output,'startup-local-failure.json'),JSON.stringify(value,null,2)+'\n');return json(res,{ok:true});}
    return json(res,{error:'Fixture control unavailable'},404);
  }catch{json(res,{error:'Fixture control failed',stderr},500);}});
  const port=Number(process.env.H47_QA_PORT||11247);await new Promise(resolve=>controller.listen(port,'127.0.0.1',resolve));
  let closing=false;async function shutdown(){if(closing)return;closing=true;await stop();await close(controller);for(const directory of profiles)fs.rmSync(directory,{recursive:true,force:true});process.exit(0);}
  process.once('SIGINT',shutdown);process.once('SIGTERM',shutdown);
  console.log(JSON.stringify({control:'http://127.0.0.1:'+port,synthetic:true,pid:process.pid}));
}
if(process.argv.includes('--child'))childMain().catch(error=>{console.error(error.message);process.exit(1);});else parentMain().catch(error=>{console.error(error.message);process.exit(1);});
