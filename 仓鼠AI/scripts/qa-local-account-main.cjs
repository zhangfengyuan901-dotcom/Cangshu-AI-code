// Synthetic loopback-only Electron integration. Never opens a customer profile.
const {app,BrowserWindow,session,safeStorage}=require('electron');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),https=require('node:https');
const root=path.resolve(process.env.HAMSTER_LOCAL_ACCOUNT_QA_ROOT||'');
if(!root.startsWith(path.resolve(os.tmpdir())+path.sep)||!path.basename(root).startsWith('hamster-local-account-'))throw Error('Isolated QA directory required');
const codeRoot=process.env.HAMSTER_LOCAL_ACCOUNT_QA_PACKAGED==='1'?path.resolve(__dirname,'../..',require('../release/current.json').releaseDirectory,'win-unpacked/resources/app.asar'):path.resolve(__dirname,'..');
app.setPath('userData',root);app.setPath('sessionData',path.join(root,'session'));app.disableHardwareAcceleration();
const observed={refresh:0,cookies:0,origins:0,creates:0,reveals:0,configured:0,paid:0,blocked:0,popups:[]};
app.on('web-contents-created',(_event,contents)=>{const install=contents.setWindowOpenHandler.bind(contents);contents.setWindowOpenHandler=handler=>install(details=>{const result=handler(details);observed.popups.push({url:details.url,action:result.action});return result;});});
const block=s=>{s.webRequest.onBeforeRequest((details,callback)=>{const url=new URL(details.url),allowed=url.hostname==='127.0.0.1'||['data:','blob:','devtools:'].includes(url.protocol);if(!allowed)observed.blocked++;callback({cancel:!allowed});});s.setCertificateVerifyProc((request,callback)=>callback(request.hostname==='127.0.0.1'?0:-3));};
app.on('session-created',block);
let server,remote,desktop;const rows=[],cookieName='qa_refresh',access='synthetic-access-token';let cookie='',signed=false,remoteBase;
app.whenReady().then(async()=>{
  block(session.defaultSession);
  remote=https.createServer({key:fs.readFileSync(path.join(root,'key.pem')),cert:fs.readFileSync(path.join(root,'cert.pem'))},async(req,res)=>{
    const url=new URL(req.url,remoteBase||'https://127.0.0.1'),chunks=[];for await(const part of req)chunks.push(part);let body={};try{body=JSON.parse(Buffer.concat(chunks).toString()||'{}');}catch{}
    const json=(data,status=200)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(data));};
    if(url.pathname==='/auth-lite/index.html'){
      signed=true;cookie='qa-start';res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Set-Cookie':`${cookieName}=${cookie}; Path=/api/user/auth; HttpOnly; Secure; SameSite=Strict`});return res.end('<!doctype html><title>合成安全登录</title><button id="finish" onclick="location.href=\'/account-lite/index.html\'">完成合成登录</button>');
    }
    if(url.pathname==='/account-lite/index.html') { res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});return res.end('<!doctype html><title>合成充值窗口</title><form method="POST" target="_blank" action="/pay/lanjing/epay/submit.php"><input name="synthetic" value="1"><button>打开合成支付</button></form>'); }
    if(url.pathname==='/pay/lanjing/epay/submit.php'){observed.paid++;res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});return res.end('<!doctype html><title>合成支付</title>合成支付，没有创建真实订单');}
    if(url.pathname==='/api/user/auth/refresh'){
      observed.refresh++;if(!signed)return json({success:false},401);
      if(req.headers.cookie!==`${cookieName}=${cookie}`)return json({success:false},401);observed.cookies++;
      if(req.headers.origin!==remoteBase)return json({success:false},403);observed.origins++;
      cookie='qa-rotated-'+observed.refresh;res.setHeader('Set-Cookie',`${cookieName}=${cookie}; Path=/api/user/auth; HttpOnly; Secure; SameSite=Strict`);
      return json({success:true,data:{user:{id:12},session:{sid:'synthetic-session'},access_token:access,access_expires_at:Date.now()/1000+3600}});
    }
    if(url.pathname==='/api/status')return json({success:true,data:{quota_per_unit:500000,usd_exchange_rate:7}});
    if(req.headers.authorization!==`Bearer ${access}`)return json({success:false},401);
    if(url.pathname==='/api/user/auth/logout'){signed=false;return json({success:true});}
    if(url.pathname==='/api/user/self')return json({success:true,data:{id:12,username:'合成客户',email:'fixture@example.test',quota:10000000,used_quota:500000,request_count:3}});
    if(url.pathname==='/api/user/self/groups')return json({success:true,data:Object.fromEntries(['image','video','tool','chat'].map(kind=>[kind+'-standard',{}]))});
    if(url.pathname==='/api/token/'&&req.method==='POST'){observed.creates++;rows.push({id:rows.length+1,name:body.name,group:body.group,status:1,created_time:Math.floor(Date.now()/1000),expired_time:body.expired_time});return json({success:true});}
    if(url.pathname==='/api/token/'||url.pathname==='/api/token/search'){const list=url.searchParams.has('keyword')?rows.filter(row=>row.name.includes(url.searchParams.get('keyword'))):rows;return json({success:true,data:{items:list,total:list.length}});}
    const match=/^\/api\/token\/(\d+)(\/key)?$/.exec(url.pathname);if(match){const row=rows.find(row=>row.id===Number(match[1]));if(!row)return json({success:false},404);if(match[2]){observed.reveals++;return json({success:true,data:{key:row.group[0]+'000000012'+String(row.id).padStart(9,'0')+'q'.repeat(29)}});}return json({success:true,data:row});}
    if(url.pathname==='/api/log/self'||url.pathname==='/api/pikno/settlements/self')return json({success:true,data:{items:[],total:0}});
    return json({success:false},404);
  });
  await new Promise(resolve=>remote.listen(0,'127.0.0.1',resolve));remoteBase=`https://127.0.0.1:${remote.address().port}`;
  const fields={image:'piknoImageKey',video:'piknoVideoKey',tool:'piknoToolKey',chat:'piknoChatKey'};
  const relayClient={invalidate(){},subscribeCatalog:()=>()=>{},context:async(config,kind)=>{const value=config[fields[kind]];if(!new RegExp('^sk-'+kind[0]+'000000012').test(value||''))throw Object.assign(Error('Synthetic group mismatch'),{statusCode:403});return {user_id:12,group:kind+'-standard'};},catalog:async config=>{const data=['image','video'].filter(kind=>config[fields[kind]]).map(kind=>({id:'qa-'+kind,name:'合成线路',type:kind,provider:'generate',resolutions:['720p'],qualities:['auto'],ratios:['16:9'],durations:[5],concurrency_options:[1],billing_mode:'relay'}));return {data,toolStates:{digital:'unavailable',depth:'unavailable'},resolve:id=>data.find(row=>row.id===id)};},activateChat:async()=>({authorized:true,enabled:true,available:true,balance_sufficient:true,model:'pikno-chat-standard'}),submit:async()=>{throw Error('Paid calls forbidden');},quote:async()=>{throw Error('Paid calls forbidden');},upload:async()=>{throw Error('Uploads forbidden');}};
  const keyFile=path.join(root,'keys.bin'),keyStore=require(path.join(codeRoot,'pikno-key-store.cjs')).createPiknoKeyStore({file:keyFile,cipher:safeStorage});
  server=require(path.join(codeRoot,'server.js')).createApp({relayMode:true,relayClient,relayKeyStore:keyStore,configPath:path.join(root,'config.json'),resultDir:path.join(root,'results'),taskDir:path.join(root,'tasks'),assetDir:path.join(root,'assets'),diagnosticsDir:path.join(root,'diagnostics'),diagnosticExportDir:path.join(root,'exports'),smartVideoLauncher:{stop(){}},hypitOptions:{enabled:false},chatcutOptions:{enabled:false}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const appUrl=`http://127.0.0.1:${server.address().port}/`;
  const win=new BrowserWindow({width:1200,height:900,show:true,title:'仓鼠AI · 本地账户验收',autoHideMenuBar:true,webPreferences:{sandbox:true,nodeIntegration:false,contextIsolation:true,preload:path.join(codeRoot,'electron/app-events.cjs')}});
  desktop=require(path.join(codeRoot,'electron/account-desktop.cjs')).createDesktopAccount({window:win,electron:require('electron'),appUrl,journalFile:path.join(root,'account-operations.json'),origin:remoteBase,allowLoopbackForTests:true,connectCreatedKey:(value,options)=>server.connectCreatedRelayKey(value,options),onConfigured:()=>{observed.configured++;win.webContents.send('hamster-relay-configured');}});
  global.__localAccountQA={observed,appUrl,remoteBase,root,facts:()=>({encrypted:fs.existsSync(keyFile)&&!fs.readFileSync(keyFile).includes(Buffer.from('sk-')),protected:safeStorage.isEncryptionAvailable(),configured:Boolean(keyStore.read().piknoImageKey),children:win.contentView.children.length})};
  await win.loadURL(appUrl);win.on('closed',()=>app.quit());
}).catch(error=>{console.error(error);app.exit(1);});
app.on('before-quit',()=>{desktop?.dispose();server?.closeAllConnections();server?.close();remote?.closeAllConnections();remote?.close();});
