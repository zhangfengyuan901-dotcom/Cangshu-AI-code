const {test}=require('node:test'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events'),http=require('node:http');
const {ACCOUNT_HOME,PARTITION,createAccountView}=require('../electron/account-view.cjs');
const {createAccountViewRoutes}=require('../relay-account-view.cjs');
function desktop(options={}){
  const views=[],loads=[],children=new Set(),remoteSession=new EventEmitter();
  remoteSession.setPermissionRequestHandler=fn=>remoteSession.requestPermission=fn;
  remoteSession.setPermissionCheckHandler=fn=>remoteSession.checkPermission=fn;
  class Contents extends EventEmitter{
    constructor(){super();this.url='';this.destroyed=false;this.mainFrame={url:''};}
    setWindowOpenHandler(fn){this.popup=fn;}
    loadURL(url){this.url=url;this.mainFrame.url=url;loads.push(url);return Promise.resolve();}
    getURL(){return this.url;}getZoomFactor(){return 1;}
    focus(){}
    send(channel){this.lastChannel=channel;}
    isDestroyed(){return this.destroyed;}close(){this.destroyed=true;}
  }
  class View {constructor(options){this.options=options;this.webContents=new Contents();views.push(this);}setBounds(value){this.bounds=value;}setVisible(value){this.visible=value;}}
  const win=new EventEmitter();win.webContents=new Contents();win.destroyed=false;win.isDestroyed=()=>win.destroyed;win.getContentSize=()=>[1200,820];
  win.contentView={addChildView:value=>children.add(value),removeChildView:value=>children.delete(value)};
  const handlers=new Map();
  const electron={ipcMain:{handle:(name,fn)=>handlers.set(name,fn),removeHandler:name=>handlers.delete(name)},WebContentsView:View,BrowserWindow:class{},session:{fromPartition:name=>{assert.equal(name,PARTITION);return remoteSession;}}};
  const controller=createAccountView({window:win,electron,...options}),rect={x:220,y:180,width:940,height:600};
  const invoke=(action,value,event)=>handlers.get('hamster-account-command')(event||{sender:views[0].webContents,senderFrame:views[0].webContents.mainFrame},action,value);
  return {controller,rect,win,views,loads,children,remoteSession,invoke,handlers};
}
function navigation(contents,url,main=true){let blocked=false;contents.emit('will-frame-navigate',{url,isMainFrame:main,preventDefault(){blocked=true;}});return !blocked;}
test('account view owns an isolated sandbox, uses fixed origin and preserves its remote DOM across page switches',()=>{
  const f=desktop();assert.deepEqual(f.loads,[]);assert.equal(f.controller.state().visible,false);
  f.controller.open(f.rect);assert.deepEqual(f.loads,[ACCOUNT_HOME]);assert.equal(f.children.size,1);
  const view=f.views[0],prefs=view.options.webPreferences;
  assert.equal(prefs.nodeIntegration,false);assert.equal(prefs.nodeIntegrationInSubFrames,false);assert.equal(prefs.contextIsolation,true);assert.equal(prefs.sandbox,true);assert.equal(prefs.webSecurity,true);assert.equal(prefs.partition,PARTITION);assert.ok(prefs.preload.endsWith('account-lifecycle.cjs'));
  f.controller.close();assert.equal(f.children.size,0);assert.equal(view.webContents.destroyed,false);assert.equal(view.webContents.lastChannel,'hamster-account-view-hidden');
  f.controller.open({...f.rect,width:1200});assert.equal(f.views.length,1);assert.equal(f.loads.length,1);assert.deepEqual(view.bounds,{x:220,y:180,width:980,height:600});
  f.controller.reload();assert.equal(f.loads.length,2);
  view.webContents.emit('did-stop-loading');assert.equal(f.controller.state().state,'ready');
  f.win.webContents.emit('did-start-loading');assert.equal(f.controller.state().visible,false);
  f.controller.dispose();assert.equal(view.webContents.destroyed,true);assert.equal(f.controller.state().available,false);
});
test('account view permits only its HTTPS origin, challenge subframes, and a fixed same-session payment popup',()=>{
  const f=desktop();f.controller.open(f.rect);const contents=f.views[0].webContents;
  assert.equal(navigation(contents,'https://www.piknoai.com/sign-in'),true);
  assert.equal(navigation(contents,'https://challenges.cloudflare.com/turnstile/',false),true);
  for(const url of ['https://evil.test/','http://127.0.0.1:12345/api/config','file:///C:/private','javascript:alert(1)','https://u:p@www.piknoai.com/','https://www.piknoai.com.evil.test/','https://challenges.cloudflare.com/'])assert.equal(navigation(contents,url),false,url);
  for(const url of ['https://www.piknoai.com/other','https://evil.test/','about:blank','https://www.piknoai.com/pay/lanjing/epay/submit.php?token=x'])assert.equal(contents.popup({url}).action,'deny');
  const allowed=contents.popup({url:'https://www.piknoai.com/pay/lanjing/epay/submit.php'});
  assert.equal(allowed.action,'allow');assert.equal(allowed.overrideBrowserWindowOptions.webPreferences.partition,PARTITION);
  const popup=new EventEmitter();popup.webContents=new (contents.constructor)();popup.isDestroyed=()=>false;popup.destroy=()=>popup.destroyed=true;
  contents.emit('did-create-window',popup);
  assert.equal(navigation(popup.webContents,'https://2347637.pay.lanjingzf.com/pay/'),true);
  assert.equal(navigation(popup.webContents,'https://evil.test/pay'),false);
  assert.equal(popup.webContents.popup({url:ACCOUNT_HOME}).action,'deny');
  assert.equal(f.remoteSession.checkPermission(contents,'clipboard-sanitized-write','https://www.piknoai.com'),true);
  for(const permission of ['clipboard-read','media','geolocation','openExternal'])assert.equal(f.remoteSession.checkPermission(contents,permission,'https://www.piknoai.com'),false);
  let allowedPermission;f.remoteSession.requestPermission(contents,'clipboard-sanitized-write',value=>allowedPermission=value,{isMainFrame:false,requestingUrl:'https://evil.test/'});assert.equal(allowedPermission,false);
  f.controller.dispose();assert.equal(popup.destroyed,true);
});
test('remote load failure is generic and disposed account cannot be reopened',()=>{
  const f=desktop();f.controller.open(f.rect);const contents=f.views[0].webContents;
  contents.emit('did-fail-load',{},-105,'private upstream error','https://private.invalid',true);contents.emit('did-stop-loading');
  assert.deepEqual(f.controller.state(),{available:true,visible:true,state:'error'});
  f.controller.dispose();assert.throws(()=>f.controller.open(f.rect));
});
async function routeFixture(t,view){
  const handler=createAccountViewRoutes({view}),server=http.createServer((req,res)=>void handler(req,res,new URL(req.url,'http://127.0.0.1')));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>{server.closeAllConnections();server.close();});
  const base='http://127.0.0.1:'+server.address().port;
  const request=(route,body,headers={})=>new Promise((resolve,reject)=>{
    const req=http.request(base+'/api/relay/account-view/'+route,{method:body===undefined?'GET':'POST',headers:{...(body===undefined?{}:{'Content-Type':'application/json'}),...headers}},res=>{const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(Buffer.concat(chunks))}));});req.on('error',reject);req.end(body===undefined?undefined:JSON.stringify(body));
  });return {request};
}
test('native bridge exposes only geometry and generic state; rejects cross-origin, URLs and excess body data',async t=>{
  const calls=[],view={state:()=>({available:true,visible:false,state:'closed',url:'private',access_token:'secret'}),...Object.fromEntries(['open','bounds','close','reload'].map(action=>[action,body=>{calls.push([action,body]);return view.state();}]))};
  const f=await routeFixture(t,view),box={x:240,y:200,width:800,height:500};
  assert.deepEqual((await f.request('state')).body,{available:true,visible:false,state:'closed'});
  assert.equal((await f.request('open',box)).status,200);assert.equal((await f.request('bounds',box)).status,200);assert.equal((await f.request('close',{})).status,200);assert.equal((await f.request('reload',{})).status,200);
  for(const value of [{...box,url:'https://evil.test'}, {...box,x:-1}, {...box,height:0}, {url:ACCOUNT_HOME}, [],null])assert.equal((await f.request('open',value)).status,400);
  assert.equal((await f.request('open',{padding:'x'.repeat(1100)})).status,413);
  assert.equal((await f.request('close',{token:'secret'})).status,400);
  for(const headers of [{Origin:'https://evil.test'},{'Sec-Fetch-Site':'cross-site'},{Host:'localhost:12345'}]){assert.equal((await f.request('state',undefined,headers)).status,403);assert.equal((await f.request('open',box,headers)).status,403);}
  assert.equal(calls.length,4);
  view.open=()=>{throw Error('private secret raw error');};const response=await f.request('open',box);assert.equal(response.status,503);assert.doesNotMatch(JSON.stringify(response.body),/private|secret|token/);
});
test('regular browser bridge is unavailable without opening remote pages or creating credentials',async t=>{
  const f=await routeFixture(t);assert.deepEqual((await f.request('state')).body,{available:false,visible:false,state:'closed'});assert.equal((await f.request('open',{x:1,y:1,width:100,height:100})).status,409);
});

const keyInput=(kind='image',id=1)=>({keyId:id,userId:12,group:kind+'-standard',name:'fixture',createdAt:1792700000,key:'sk-'+kind.padEnd(32,'a'),requestId:'fixture-request-'+kind+'-'+id});
test('credential handoff accepts only the owned main frame at its exact account entry',async()=>{
  let imports=0;const f=desktop({connectCreatedKey:async()=>{imports++;return {ok:true,code:'CONNECTED'};}});f.controller.open(f.rect);
  const contents=f.views[0].webContents;
  const denied=[{sender:f.win.webContents,senderFrame:contents.mainFrame},{sender:contents,senderFrame:{url:ACCOUNT_HOME}}];
  for(const event of denied)assert.equal((await f.invoke('context',{userId:12},event)).code,'FORBIDDEN');
  for(const url of [ACCOUNT_HOME+'?x=1',ACCOUNT_HOME+'#x','https://www.piknoai.com/sign-in','https://evil.test/account-lite/index.html']){
    contents.mainFrame.url=url;assert.equal((await f.invoke('context',{userId:12})).code,'FORBIDDEN');
  }
  contents.mainFrame.url=ACCOUNT_HOME;
  assert.equal((await f.invoke('connect',keyInput())).code,'ACCOUNT_CHANGED');
  assert.deepEqual(await f.invoke('context',{userId:12}),{ok:true});
  for(const bad of [{...keyInput(),key:'sk-invalid'},{...keyInput(),userId:0},{...keyInput(),group:'other'}, {...keyInput(),url:'https://evil.test'}])assert.equal((await f.invoke('connect',bad)).code,'INVALID_REQUEST');
  assert.deepEqual(await f.invoke('connect',keyInput()),{ok:true,code:'CONNECTED',connected:true});assert.equal(imports,1);
  f.controller.dispose();assert.equal(f.handlers.size,0);
});
test('four native handoffs serialize, preserve success and reject changed duplicate request payloads',async()=>{
  let active=0,maximum=0,changed=0;const seen=[];
  const f=desktop({connectCreatedKey:async value=>{maximum=Math.max(maximum,++active);await new Promise(resolve=>setImmediate(resolve));seen.push(value.group);active--;return {ok:true,code:value.group==='chat-standard'?'SAVED_CHECK_PENDING':'CONNECTED'};},onConfigured:()=>changed++});
  f.controller.open(f.rect);await f.invoke('context',{userId:12});
  const inputs=['image','video','tool','chat'].map((kind,i)=>keyInput(kind,i+1));
  const results=await Promise.all(inputs.map(value=>f.invoke('connect',value)));
  assert.equal(maximum,1);assert.deepEqual(seen,inputs.map(value=>value.group));assert.equal(changed,4);assert.equal(results[3].code,'SAVED_CHECK_PENDING');
  assert.deepEqual(await f.invoke('connect',inputs[0]),results[0]);assert.equal(changed,4);
  assert.equal((await f.invoke('connect',{...inputs[0],key:'sk-'+ 'b'.repeat(32)})).code,'INVALID_REQUEST');
  f.controller.dispose();
});
test('logout and navigation revoke waiting native transactions before protected writes',async()=>{
  let release,started;const startedPromise=new Promise(resolve=>started=resolve),gate=new Promise(resolve=>release=resolve),writes=[];
  const f=desktop({connectCreatedKey:async(value,{assertCurrent})=>{started();await gate;if(!assertCurrent())return {ok:false,code:'ACCOUNT_CHANGED'};writes.push(value.group);return {ok:true,code:'CONNECTED'};}});
  f.controller.open(f.rect);await f.invoke('context',{userId:12});
  const pending=f.invoke('connect',keyInput()),queued=f.invoke('connect',keyInput('video',2));await startedPromise;
  await f.invoke('context',{userId:null});release();
  assert.equal((await pending).code,'ACCOUNT_CHANGED');assert.equal((await queued).code,'ACCOUNT_CHANGED');assert.deepEqual(writes,[]);
  await f.invoke('context',{userId:12});
  f.views[0].webContents.emit('did-start-navigation',{},ACCOUNT_HOME,false,true);
  assert.equal((await f.invoke('connect',keyInput())).code,'ACCOUNT_CHANGED');f.controller.dispose();
});
test('native errors and feedback pass only fixed categories and bounded numeric status',async()=>{
  const reports=[];const f=desktop({connectCreatedKey:async()=>{throw Error('sk-secret and customer text');},reportFailure:value=>reports.push(value)});
  f.controller.open(f.rect);await f.invoke('context',{userId:12});
  const result=await f.invoke('connect',keyInput());assert.deepEqual(result,{ok:false,code:'CONNECT_FAILED'});
  assert.deepEqual(await f.invoke('failure',{code:'ACCOUNT_PAYMENT_UNKNOWN',httpStatus:503,key:'sk-secret',message:'private'}),{ok:true});
  await f.invoke('failure',{code:'ACCOUNT_PAYMENT_UNKNOWN',httpStatus:503});
  assert.equal((await f.invoke('failure',{code:'PRIVATE_RAW_MESSAGE'})).code,'INVALID_REQUEST');
  assert.deepEqual(reports,[{code:'ACCOUNT_KEY_IMPORT_FAILED',httpStatus:0},{code:'ACCOUNT_PAYMENT_UNKNOWN',httpStatus:503}]);
  f.controller.dispose();
});

test('native rate limits retain only bounded recovery metadata and do not report normal cooldown as failure',async()=>{
  const reports=[],f=desktop({connectCreatedKey:async()=>({ok:false,code:'RATE_LIMITED',httpStatus:429,retryAfterMs:7200000,raw:'private'}),reportFailure:value=>reports.push(value)});
  f.controller.open(f.rect);await f.invoke('context',{userId:12});
  assert.deepEqual(await f.invoke('connect',keyInput()),{ok:false,code:'RATE_LIMITED',httpStatus:429,retryAfterMs:3600000});assert.deepEqual(reports,[]);f.controller.dispose();
  const saved=desktop({connectCreatedKey:async()=>({ok:true,code:'SAVED_CHECK_PENDING',httpStatus:429,retryAfterMs:120000}),reportFailure:value=>reports.push(value)});
  saved.controller.open(saved.rect);await saved.invoke('context',{userId:12});
  assert.deepEqual(await saved.invoke('connect',keyInput()),{ok:true,code:'SAVED_CHECK_PENDING',connected:false,httpStatus:429,retryAfterMs:120000});assert.deepEqual(reports,[]);saved.controller.dispose();
});

test('native failure reports retain safe HTTP status across authentication, account, protocol and network failures',async()=>{
  for(const [httpStatus,code] of [[401,'KEY_INVALID'],[403,'KEY_FORBIDDEN'],[409,'ACCOUNT_MISMATCH'],[502,'CONNECT_FAILED'],[503,'CONNECT_FAILED'],[503,'KEY_STORAGE_UNAVAILABLE']]){
    const reports=[],f=desktop({connectCreatedKey:async()=>({ok:false,code,httpStatus,key:'sk-private',message:'private customer path'}),reportFailure:value=>reports.push(value)});
    f.controller.open(f.rect);await f.invoke('context',{userId:12});
    assert.deepEqual(await f.invoke('connect',keyInput()),{ok:false,code,httpStatus});
    assert.deepEqual(reports,[{code:'ACCOUNT_KEY_IMPORT_FAILED',httpStatus}]);f.controller.dispose();
  }
});

test('native bridge discards invalid HTTP status and unknown error properties',async()=>{
  for(const httpStatus of [99,600,'503',503.5,Infinity,NaN,null,{},undefined]){
    const reports=[],f=desktop({connectCreatedKey:async()=>({ok:false,code:'private_code',httpStatus,raw:'sk-private',stack:'private customer path'}),reportFailure:value=>reports.push(value)});
    f.controller.open(f.rect);await f.invoke('context',{userId:12});
    assert.deepEqual(await f.invoke('connect',keyInput()),{ok:false,code:'CONNECT_FAILED'});
    assert.deepEqual(reports,[{code:'ACCOUNT_KEY_IMPORT_FAILED',httpStatus:0}]);f.controller.dispose();
  }
});

test('normal account cancellation after native validation does not report a Key import failure',async()=>{
  const reports=[],f=desktop({connectCreatedKey:async()=>({ok:false,code:'ACCOUNT_CHANGED',httpStatus:409}),reportFailure:value=>reports.push(value)});
  f.controller.open(f.rect);await f.invoke('context',{userId:12});
  assert.deepEqual(await f.invoke('connect',keyInput()),{ok:false,code:'ACCOUNT_CHANGED',httpStatus:409});
  assert.deepEqual(reports,[]);f.controller.dispose();
});
