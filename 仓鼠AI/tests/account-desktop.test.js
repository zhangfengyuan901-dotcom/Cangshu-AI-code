const {test}=require('node:test');
const assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const vm=require('node:vm');
const {randomUUID}=require('node:crypto');
const {createDesktopAccount,CHANNEL,PARTITION}=require('../electron/account-desktop.cjs');
const {createAccountPayment}=require('../electron/account-payment.cjs');

const APP='http://127.0.0.1:19862/';
const REMOTE='https://www.piknoai.com';
const FLOW='F'.repeat(43);
const browserTarget=REMOTE+'/hub/billing#desktop='+FLOW;
const groups=['image-standard','video-standard','tool-standard','chat-standard'];
const reply=(data,status=200)=>({ok:status>=200&&status<300,status,headers:{get:()=>null},json:async()=>data});
function fixture(t,{fetchImpl,appUrl=APP,...options}={}){
  const calls=[],windows=[],opened=[],handlers=new Map(),session=new EventEmitter();
  session.setPermissionRequestHandler=handler=>session.requestPermission=handler;
  session.setPermissionCheckHandler=handler=>session.checkPermission=handler;
  session.fetch=async(url,init)=>{calls.push({url,init});return fetchImpl?fetchImpl(url,init):reply({success:false},401);};
  class Contents extends EventEmitter{
    constructor(url=''){super();this.url=url;this.mainFrame={url};this.sent=[];this.destroyed=false;}
    getURL(){return this.url;}
    setURL(url){this.url=url;this.mainFrame.url=url;}
    isDestroyed(){return this.destroyed;}
    send(...values){this.sent.push(values);}
  }
  class Window extends EventEmitter{
    constructor(){super();windows.push(this);}
  }
  const win=new EventEmitter();win.destroyed=false;win.webContents=new Contents(APP);win.isDestroyed=()=>win.destroyed;
  const electron={BrowserWindow:Window,session:{fromPartition:partition=>{assert.equal(partition,PARTITION);return session;}},ipcMain:{handle:(name,handler)=>handlers.set(name,handler),removeHandler:name=>handlers.delete(name)}};
  const journalFile=path.join(os.tmpdir(),`hamster-desktop-boundary-${randomUUID()}.json`);
  const controller=createDesktopAccount({window:win,electron,appUrl,journalFile,browserCipher:{isEncryptionAvailable:()=>true,encryptString:()=>Buffer.from('protected-synthetic')},openExternal:async url=>opened.push(url),connectCreatedKey:async()=>{throw Error('Unexpected key import');},...options});
  t.after(()=>{controller.dispose();for(const suffix of ['','.browser']){const target=path.resolve(journalFile+suffix);assert.equal(path.dirname(target),path.resolve(os.tmpdir()));fs.rmSync(target,{force:true});}});
  const event=()=>({sender:win.webContents,senderFrame:win.webContents.mainFrame});
  const invoke=(action,value={},senderEvent=event())=>handlers.get(CHANNEL)(senderEvent,action,value);
  return {calls,windows,opened,handlers,session,win,controller,invoke,event};
}
const flush=()=>new Promise(resolve=>setImmediate(resolve));
function fakeTimers(){
  const pending=new Map();let next=0;
  return {pending,setTimeout(fn,ms){const id=++next;pending.set(id,{fn,ms});return id;},clearTimeout(id){pending.delete(id);},fire(){const callbacks=[...pending.values()];pending.clear();for(const {fn} of callbacks)fn();}};
}
const signedFetch=async(url,init={})=>{
  const route=new URL(url).pathname;
  if(route==='/api/user/auth/refresh')return reply({success:true,data:{access_token:'fixture-private-access',access_expires_at:Date.now()/1000+120,user:{id:12},session:{sid:'fixture-private-session'}}});
  if(route==='/api/user/self')return reply({success:true,data:{id:12,username:'fixture',email:'fixture@example.test',quota:1000,used_quota:10,request_count:3,key:'private-should-not-cross'}});
  if(route==='/api/status')return reply({success:true,data:{quota_per_unit:100,usd_exchange_rate:1}});
  if(route==='/api/user/self/groups')return reply({success:true,data:{'image-standard':{},'chat-standard':{}}});
  if(route==='/api/user/desktop/start')return reply({success:true,data:{flow_id:FLOW,expires_at:Math.floor(Date.now()/1000)+300,verification_url:browserTarget,interval:3}});
  if(route==='/api/user/desktop/exchange')return reply({success:true,data:{status:'pending'}});
  if(route==='/api/user/auth/logout')return reply({success:true});
  throw Error('Unexpected request');
};
const accountFixture=(t,options={})=>fixture(t,{fetchImpl:signedFetch,...options});
const routes=f=>f.calls.map(call=>new URL(call.url).pathname);
test('local account IPC accepts only the owned exact local main frame',async t=>{
  const f=fixture(t);
  for(const senderEvent of [{sender:{},senderFrame:f.win.webContents.mainFrame},{sender:f.win.webContents,senderFrame:{url:APP}},{sender:f.win.webContents,senderFrame:null}])assert.deepEqual(await f.invoke('snapshot',{},senderEvent),{ok:false,code:'FORBIDDEN'});
  for(const url of [APP+'?x=1',APP+'#account',APP+'other','http://localhost:19862/','http://127.0.0.1:19863/',REMOTE+'/account-lite/index.html']){f.win.webContents.setURL(url);assert.deepEqual(await f.invoke('snapshot'),{ok:false,code:'FORBIDDEN'});}
  f.win.webContents.setURL(APP);assert.deepEqual(await f.invoke('snapshot'),{ok:true,signedIn:false});assert.equal(f.calls.length,1);
});

test('account IPC has no arbitrary URL, legacy auth window or generic request contract',async t=>{
  const f=fixture(t);
  for(const [action,value] of [['fetch',{url:REMOTE}],['auth',{mode:'login'}],['auth',{mode:'register'}],['auth',[]],['payment',{}],['payment-open',{accountId:12,url:REMOTE}],['snapshot',{access_token:'fixture'}],['snapshot',null]])assert.deepEqual(await f.invoke(action,value),{ok:false,code:'INVALID_REQUEST'});
  assert.equal(f.windows.length,0);assert.equal(f.calls.length,0);
});

test('snapshot returns display metadata without bearer, session or key material',async t=>{
  const f=accountFixture(t),result=await f.invoke('snapshot');assert.equal(result.ok,true);assert.equal(result.balance,10);assert.equal(result.user.email,'fixture@example.test');assert.equal(result.accountMatched,true);
  assert.doesNotMatch(JSON.stringify(result),/fixture-private|private-should-not-cross|access_token|session|key/);
  assert.ok(f.calls.every(call=>call.init.credentials==='include'&&call.init.headers.Origin===REMOTE&&call.init.headers.Referer===REMOTE+'/account-lite/index.html'));
});

test('a different local Key owner blocks browser recharge without opening a window or starting a flow',async t=>{
  const f=accountFixture(t,{getConnectedAccountId:()=>99});
  assert.equal((await f.invoke('snapshot')).accountMatched,false);
  assert.deepEqual(await f.invoke('browser-open'),{ok:false,code:'ACCOUNT_MISMATCH'});
  assert.equal(routes(f).includes('/api/user/desktop/start'),false);
  assert.deepEqual(f.opened,[]);
  assert.deepEqual(f.windows,[]);
});

test('all retired desktop authentication and recharge commands are rejected before network access',async t=>{
  const f=accountFixture(t);
  for(const action of ['auth-status','auth-login','auth-register','auth-email','payment-options','payment-quote','payment-create','payment-open','payment-status','browser-poll']){
    assert.deepEqual(await f.invoke(action),{ok:false,code:'INVALID_REQUEST'});
  }
  assert.deepEqual(f.calls,[]);
  assert.deepEqual(f.opened,[]);
  assert.deepEqual(f.windows,[]);
});

test('an explicit browser recharge opens only the fixed system browser URL and sends no payment order',async t=>{
  const timers=fakeTimers();
  const f=accountFixture(t,{timers,getConnectedAccountId:()=>12,getConfiguredGroups:()=>groups});
  assert.deepEqual(f.calls,[]);
  assert.deepEqual(await f.invoke('browser-open'),{ok:true,browserOpened:true,pending:true});
  await flush();
  assert.deepEqual(f.opened,[browserTarget]);
  assert.deepEqual(f.windows,[]);
  assert.deepEqual(routes(f),['/api/user/auth/refresh','/api/user/desktop/start','/api/user/desktop/exchange']);
  const body=JSON.parse(f.calls[1].init.body);
  assert.deepEqual(Object.keys(body).sort(),['challenge','expected_user_id','purpose']);
  assert.equal(body.purpose,'recharge');
  assert.equal(body.expected_user_id,12);
  assert.equal([...timers.pending.values()][0].ms,3000);
});

test('a foreign browser target is rejected and never starts exchange or a payment window',async t=>{
  const f=accountFixture(t,{fetchImpl:async(url,init)=>new URL(url).pathname==='/api/user/desktop/start'?
    reply({success:true,data:{flow_id:FLOW,expires_at:Math.floor(Date.now()/1000)+300,verification_url:'https://untrusted.invalid/',interval:3}}):
    signedFetch(url,init)});
  assert.deepEqual(await f.invoke('browser-open'),{ok:false,code:'NETWORK'});
  assert.equal(routes(f).includes('/api/user/desktop/exchange'),false);
  assert.deepEqual(f.opened,[]);
  assert.deepEqual(f.windows,[]);
});

test('changing the owner frame while a poll is pending invalidates the result and does not rearm polling',async t=>{
  const timers=fakeTimers();
  let release,started;
  const entered=new Promise(resolve=>{started=resolve;});
  const response=new Promise(resolve=>{release=resolve;});
  t.after(()=>release());
  const f=accountFixture(t,{timers,fetchImpl:async(url,init)=>{
    if(new URL(url).pathname!=='/api/user/desktop/exchange')return signedFetch(url,init);
    started();
    await response;
    return reply({success:true,data:{status:'pending'}});
  }});
  assert.equal((await f.invoke('browser-open')).ok,true);
  await entered;
  f.win.webContents.setURL(APP+'elsewhere');
  f.win.webContents.emit('did-start-loading');
  release();
  await flush();
  assert.equal(timers.pending.size,0);
  assert.deepEqual(f.win.webContents.sent,[]);
  assert.deepEqual(await f.invoke('snapshot'),{ok:false,code:'FORBIDDEN'});
});

test('browser poll cooldown and destruction stop further account activity',async t=>{
  const timers=fakeTimers();
  const f=accountFixture(t,{timers,fetchImpl:async(url,init)=>new URL(url).pathname==='/api/user/desktop/exchange'?
    {ok:false,status:429,headers:{get:()=> '9'},json:async()=>({success:false})}:signedFetch(url,init)});
  assert.equal((await f.invoke('browser-open')).ok,true);
  await flush();
  assert.equal([...timers.pending.values()][0].ms,9000);
  const currentHandler=f.handlers.get(CHANNEL);
  f.controller.dispose();
  assert.equal(timers.pending.size,0);
  timers.fire();
  await flush();
  assert.equal(routes(f).filter(route=>route==='/api/user/desktop/exchange').length,1);
  assert.deepEqual(await currentHandler(f.event(),'snapshot',{}),{ok:false,code:'FORBIDDEN'});
});

test('local status page has no privileged bridge, external content, forms or raw error interpolation',()=>{
  const html=fs.readFileSync(path.join(__dirname,'../electron/account-status.html'),'utf8'),script=fs.readFileSync(path.join(__dirname,'../electron/account-status.js'),'utf8');
  assert.match(html,/default-src 'none'/);assert.match(html,/connect-src 'none'/);assert.match(html,/form-action 'none'/);assert.doesNotMatch(html,/<(?:a|form|iframe)\b|https?:/);assert.doesNotMatch(script,/innerHTML|require\(|fetch\(|ipcRenderer|hamsterDesktopAccount/);
  const elements={title:{},message:{},hint:{}},classes=[];vm.runInNewContext(script,{URLSearchParams,window:{location:{search:'?state=failed&error=secret-value'}},document:{body:{classList:{add:value=>classes.push(value)}},getElementById:id=>elements[id]}});
  assert.deepEqual(classes,['failed']);assert.match(elements.message.textContent,/关闭此窗口后重试/);assert.doesNotMatch(JSON.stringify(elements),/secret-value/);
});

test('the isolated account session denies Electron permissions and disposal removes the IPC handler',async t=>{
  const f=accountFixture(t);
  for(const permission of ['clipboard-sanitized-write','clipboard-read','media','geolocation','openExternal']){
    assert.equal(f.session.checkPermission(f.win.webContents,permission,REMOTE),false);
    let allowed=true;
    f.session.requestPermission(f.win.webContents,permission,value=>{allowed=value;},{isMainFrame:true,requestingUrl:REMOTE});
    assert.equal(allowed,false);
  }
  const handler=f.handlers.get(CHANNEL);
  f.controller.dispose();
  assert.equal(f.handlers.has(CHANNEL),false);
  assert.deepEqual(await handler(f.event(),'snapshot',{}),{ok:false,code:'FORBIDDEN'});
});

test('preload exposes only fixed local account commands and payload-free notifications',async()=>{
  const source=fs.readFileSync(path.join(__dirname,'../electron/app-events.cjs'),'utf8');
  function preload(main){const exposed={},handlers=new Map(),calls=[],events=[],ipcRenderer={on:(name,handler)=>handlers.set(name,handler),invoke:async(...args)=>{calls.push(args);return {ok:true};}};vm.runInNewContext(source,{require:name=>{assert.equal(name,'electron');return {ipcRenderer,contextBridge:{exposeInMainWorld:(key,value)=>exposed[key]=value}};},process:{isMainFrame:main},window:{dispatchEvent:event=>events.push(event)},Event:class{constructor(type){this.type=type;}}});return {exposed,handlers,calls,events};}
  const f=preload(true);assert.deepEqual(Object.keys(f.exposed),['hamsterDesktopAccount','hamsterWorkDirectory']);assert.deepEqual(Object.keys(f.exposed.hamsterDesktopAccount),['command']);await f.exposed.hamsterDesktopAccount.command('snapshot');assert.deepEqual(f.calls[0].slice(0,2),[CHANNEL,'snapshot']);
  const invalid=await f.exposed.hamsterDesktopAccount.command('fetch',{url:REMOTE});assert.equal(invalid.code,'INVALID_REQUEST');assert.equal(f.calls.length,1);
  assert.deepEqual(Object.keys(f.exposed.hamsterWorkDirectory),['status','choose']);
  await f.exposed.hamsterWorkDirectory.status();await f.exposed.hamsterWorkDirectory.choose('untrusted-argument');
  assert.deepEqual(f.calls.slice(1),[['hamster-work-directory-status'],['hamster-work-directory-choose']]);
  f.handlers.get('hamster-account-updated')({},'private');f.handlers.get('hamster-relay-configured')({},'private');assert.deepEqual(f.events.map(event=>event.type),['hamster-account-updated','hamster-relay-native-configured','hamster-relay-configured']);assert.ok(f.events.every(event=>Object.keys(event).join(',')==='type'));assert.deepEqual(Object.keys(preload(false).exposed),[]);
});

function paymentFixture(t,{handler,journalFile,connected=12}={}){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'hamster-native-payment-'));
  const file=journalFile||path.join(directory,'operations.json');
  const state={userId:12,sid:'synthetic-private-session',connected,now:1700000000000,status:'pending',calls:[],opened:[],offers:{fixed_cny_topup:true,enable_online_topup:true,payment_compliance_confirmed:true,amount_options:[50,100,200],pay_methods:[{type:'alipay'},{type:'wxpay'}]}};
  const signed=(amount=50,method='alipay',userId=12)=>({message:'success',url:REMOTE+'/pay/lanjing/epay/submit.php',data:{pid:'2347637',type:method,out_trade_no:`USR${userId}NOSYNTHETIC1`,notify_url:REMOTE+'/api/user/epay/notify',return_url:REMOTE+'/account-lite/index.html',name:'TUC'+amount,money:amount.toFixed(2),sign:'c'.repeat(32),sign_type:'MD5',device:'pc'}});
  const request=async(route,options={})=>{
    state.calls.push({route,options});
    const intercepted=await handler?.(route,options,{state,signed,file});if(intercepted!==undefined)return intercepted;
    if(route==='/api/user/self')return {success:true,data:{id:state.userId,email:'synthetic@example.test',private:'should-not-cross'}};
    if(route==='/api/user/topup/info')return {success:true,data:state.offers};
    if(route==='/api/user/amount')return {message:'success',data:options.body.amount.toFixed(2)};
    if(route==='/api/user/pay'){
      const saved=JSON.parse(fs.readFileSync(file+'.payment','utf8'));
      assert.equal(saved.entries.at(-1).action,'pending');assert.equal(saved.entries.at(-1).order,'');
      return signed(options.body.amount,options.body.payment_method,state.userId);
    }
    if(route.startsWith('/api/user/topup/self'))return {success:true,data:{total:1,items:[{user_id:state.userId,trade_no:`USR${state.userId}NOSYNTHETIC1`,status:state.status,money:50,payment_method:'alipay',create_time:1700000000,complete_time:state.status==='success'?1700000001:0,private:'should-not-cross'}]}};
    throw Error('Unexpected synthetic payment route');
  };
  const controller=createAccountPayment({request,journalFile:file,getIdentity:()=>({userId:state.userId,sid:state.sid}),getConnectedAccountId:()=>state.connected,openPayment:async payment=>{state.opened.push(JSON.parse(JSON.stringify(payment)));return {ok:true};},now:()=>state.now});
  const command=(name,value={})=>controller.command(name,{accountId:12,...value});
  t.after(()=>{controller.dispose();const resolved=fs.realpathSync(directory);assert.equal(path.dirname(resolved),fs.realpathSync(os.tmpdir()));assert.match(path.basename(resolved),/^hamster-native-payment-/);fs.rmSync(resolved,{recursive:true,force:true});});
  return {state,file,controller,command,signed,request};
}

test('native recharge offers only supported server-enabled amounts and methods without private fields',async t=>{
  const f=paymentFixture(t);f.state.offers.amount_options.push(1000);f.state.offers.pay_methods.push({type:'arbitrary',secret:'private'});
  assert.deepEqual(await f.command('payment-options'),{ok:true,available:true,amounts:[50,100,200],methods:['alipay','wxpay'],pending:null});
  f.state.offers.payment_compliance_confirmed=false;
  assert.deepEqual(await f.command('payment-options'),{ok:true,available:false,amounts:[],methods:[],pending:null});
  assert.equal(f.state.calls.filter(call=>call.options.method==='POST').length,0);
});

test('native recharge durably binds an explicit quote before one create and never exposes its signed handoff',async t=>{
  const f=paymentFixture(t),quote=await f.command('payment-quote',{amount:50,method:'alipay'});
  assert.equal(quote.ok,true);assert.match(quote.quoteId,/^[a-f0-9-]{36}$/);assert.equal(quote.expiresAt,f.state.now+120000);
  const result=await f.command('payment-create',{quoteId:quote.quoteId,confirmed:true});
  assert.deepEqual(result,{ok:true,pending:true,canContinue:true,amount:50,method:'alipay'});
  assert.doesNotMatch(JSON.stringify(result),/https|USR12|sign|synthetic-private/);
  const journal=JSON.parse(fs.readFileSync(f.file+'.payment','utf8'));
  assert.deepEqual(Object.keys(journal.entries[0]).sort(),['action','amount','at','method','order','userId']);
  assert.equal(journal.entries[0].userId,12);assert.equal(journal.entries[0].order,'USR12NOSYNTHETIC1');
  assert.deepEqual(f.state.calls.find(call=>call.route==='/api/user/pay').options.body,{amount:50,payment_method:'alipay'});
  assert.deepEqual(await f.command('payment-open'),{ok:true,pending:true,paymentOpened:true});
  assert.equal(f.state.opened.length,1);assert.equal(f.state.opened[0].action,REMOTE+'/pay/lanjing/epay/submit.php');
  assert.equal((await f.command('payment-open')).code,'PENDING_OPERATION');
  const orders=await f.command('payment-orders');assert.equal(orders.pending.orderKnown,true);assert.equal(orders.items[0].status,'pending');
  assert.doesNotMatch(JSON.stringify(orders),/USR12|https|sign|private|user_id/);
});

test('duplicate confirmed native recharge clicks produce only one upstream order',async t=>{
  const f=paymentFixture(t),quote=await f.command('payment-quote',{amount:50,method:'alipay'});
  const results=await Promise.all([f.command('payment-create',{quoteId:quote.quoteId,confirmed:true}),f.command('payment-create',{quoteId:quote.quoteId,confirmed:true})]);
  assert.equal(results.filter(row=>row.ok).length,1);assert.equal(results[1].code,'PENDING_OPERATION');
  assert.equal(f.state.calls.filter(call=>call.route==='/api/user/pay').length,1);
});

test('native recharge checks original order remains payable before opening its cashier',async t=>{
  const f=paymentFixture(t),quote=await f.command('payment-quote',{amount:50,method:'alipay'});await f.command('payment-create',{quoteId:quote.quoteId,confirmed:true});
  f.state.sid='different-synthetic-session';assert.equal((await f.command('payment-options')).pending.canContinue,false);
  f.state.sid='synthetic-private-session';f.state.status='expired';
  assert.equal((await f.command('payment-open')).code,'PENDING_OPERATION');assert.equal(f.state.opened.length,0);
  assert.equal((await f.command('payment-options')).pending,null);
  assert.equal(JSON.parse(fs.readFileSync(f.file+'.payment','utf8')).entries[0].action,'expired');
});

test('native recharge rejects account, local-key owner, session and expired quote mismatches before creation',async t=>{
  const f=paymentFixture(t);f.state.connected=99;
  assert.equal((await f.command('payment-options')).code,'ACCOUNT_MISMATCH');
  f.state.connected=12;assert.equal((await f.command('payment-options',{accountId:99})).code,'ACCOUNT_CHANGED');
  let quote=await f.command('payment-quote',{amount:50,method:'alipay'});f.state.sid='different-synthetic-session';
  assert.equal((await f.command('payment-create',{quoteId:quote.quoteId,confirmed:true})).code,'QUOTE_EXPIRED');
  quote=await f.command('payment-quote',{amount:50,method:'alipay'});f.state.now=quote.expiresAt;
  assert.equal((await f.command('payment-create',{quoteId:quote.quoteId,confirmed:true})).code,'QUOTE_EXPIRED');
  assert.equal(f.state.calls.filter(call=>call.route==='/api/user/pay').length,0);
  f.state.connected=null;assert.equal((await f.command('payment-options')).ok,true);
});

test('native recharge keeps unknown creation pending across restart and does not replay it',async t=>{
  const f=paymentFixture(t,{handler:async route=>{if(route==='/api/user/pay')throw Error('synthetic connection lost');}});
  const quote=await f.command('payment-quote',{amount:50,method:'alipay'});
  assert.equal((await f.command('payment-create',{quoteId:quote.quoteId,confirmed:true})).code,'PAYMENT_UNKNOWN');
  f.controller.dispose();
  const restarted=createAccountPayment({request:f.request,journalFile:f.file,getIdentity:()=>({userId:12,sid:f.state.sid}),getConnectedAccountId:()=>12,openPayment:()=>{throw Error('No original signed handoff');},now:()=>f.state.now});t.after(()=>restarted.dispose());
  assert.equal((await restarted.command('payment-quote',{accountId:12,amount:50,method:'alipay'})).code,'PENDING_OPERATION');
  assert.equal((await restarted.command('payment-open',{accountId:12})).code,'PENDING_OPERATION');
  const rows=await restarted.command('payment-orders',{accountId:12});assert.equal(rows.pending.orderKnown,false);
  assert.equal(f.state.calls.filter(call=>call.route==='/api/user/pay').length,1);
});

test('native recharge validates order owner, amount, signature structure, callback and payment destination',async t=>{
  const mutations=[
    value=>value.url='https://evil.test/pay',value=>value.data.out_trade_no='USR99NOSYNTHETIC1',value=>value.data.money='100.00',
    value=>value.data.sign='invalid',value=>value.data.notify_url='https://evil.test/notify',value=>value.data.return_url='https://evil.test/return',
    value=>value.data.injected='untrusted',value=>value.data.type='wxpay',value=>value.url=REMOTE+'/pay/lanjing/epay/submit.php?extra=1',
  ];
  for(const mutate of mutations){
    const f=paymentFixture(t,{handler:async(route,options,{signed})=>{if(route==='/api/user/pay'){const value=signed(options.body.amount,options.body.payment_method);mutate(value);return value;}}});
    const quote=await f.command('payment-quote',{amount:50,method:'alipay'});
    assert.equal((await f.command('payment-create',{quoteId:quote.quoteId,confirmed:true})).code,'PAYMENT_UNKNOWN');
    assert.equal((await f.command('payment-open')).code,'PENDING_OPERATION');assert.equal(f.state.opened.length,0);
    assert.equal((await f.command('payment-options')).pending.orderKnown,false);
  }
});

test('native recharge invalidation during submission preserves its original account record and clears payment capability',async t=>{
  let release,started;const ready=new Promise(resolve=>started=resolve);
  const f=paymentFixture(t,{handler:async(route,options,{signed})=>{if(route==='/api/user/pay'){started();return new Promise(resolve=>release=()=>resolve(signed(options.body.amount,options.body.payment_method)));}}});
  const quote=await f.command('payment-quote',{amount:50,method:'alipay'});
  const submitting=f.command('payment-create',{quoteId:quote.quoteId,confirmed:true});await ready;
  f.controller.invalidate();f.state.userId=99;release();
  assert.equal((await submitting).code,'ACCOUNT_CHANGED');f.state.userId=12;
  assert.equal((await f.command('payment-open')).code,'PENDING_OPERATION');assert.equal((await f.command('payment-options')).pending.orderKnown,true);
  assert.equal(f.state.calls.filter(call=>call.route==='/api/user/pay').length,1);
});

test('native recharge resolves only the exact original order using authoritative account-filtered status',async t=>{
  let queriedOriginal=false;
  const f=paymentFixture(t,{handler:async(route)=>{
    if(route.startsWith('/api/user/topup/self')){
      if(route.includes('keyword=')){queriedOriginal=true;return {data:{items:[{user_id:12,trade_no:'USR12NOSYNTHETIC1',status:'success'}]}};}
      return {data:{total:1,items:[{user_id:12,trade_no:'USR12NOOTHER',money:50,payment_method:'alipay',status:'success'}]}};
    }
  }});
  const quote=await f.command('payment-quote',{amount:50,method:'alipay'});await f.command('payment-create',{quoteId:quote.quoteId,confirmed:true});
  const orders=await f.command('payment-orders');assert.equal(queriedOriginal,true);assert.equal(orders.pending,null);
  const journal=JSON.parse(fs.readFileSync(f.file+'.payment','utf8'));assert.equal(journal.entries[0].action,'success');assert.equal(journal.entries[0].order,'USR12NOSYNTHETIC1');
  assert.equal((await f.command('payment-quote',{amount:100,method:'wxpay'})).ok,true);
});

test('native recharge does not trust another account or an unknown status as payment completion',async t=>{
  const f=paymentFixture(t),quote=await f.command('payment-quote',{amount:50,method:'alipay'});await f.command('payment-create',{quoteId:quote.quoteId,confirmed:true});
  f.state.status='paid';assert.equal((await f.command('payment-orders')).pending.orderKnown,true);
  f.state.userId=99;assert.equal((await f.command('payment-orders')).code,'ACCOUNT_CHANGED');
  f.state.userId=12;assert.equal(JSON.parse(fs.readFileSync(f.file+'.payment','utf8')).entries[0].action,'pending');
});

test('native recharge explicit local resolution keeps order history and never cancels, refunds or creates payment',async t=>{
  const f=paymentFixture(t),quote=await f.command('payment-quote',{amount:50,method:'alipay'});await f.command('payment-create',{quoteId:quote.quoteId,confirmed:true});
  const before=f.state.calls.filter(call=>call.route!=='/api/user/self').length;
  assert.equal((await f.command('payment-resolve',{confirmed:false})).code,'INVALID_REQUEST');
  assert.deepEqual(await f.command('payment-resolve',{confirmed:true}),{ok:true,resolved:true});
  const journal=JSON.parse(fs.readFileSync(f.file+'.payment','utf8'));assert.equal(journal.entries.length,1);assert.equal(journal.entries[0].action,'resolved');assert.equal(journal.entries[0].order,'USR12NOSYNTHETIC1');
  assert.equal(f.state.calls.filter(call=>call.route!=='/api/user/self').length,before);assert.equal((await f.command('payment-open')).code,'PENDING_OPERATION');
});

test('native recharge rejects unsafe contracts and stops before upstream when its write-ahead journal fails',async t=>{
  const f=paymentFixture(t);
  for(const [action,value] of [['fetch',{}],['__proto__',{}],['payment-options',{url:'https://evil.test'}],['payment-quote',{amount:1,method:'alipay'}],['payment-quote',{amount:50,method:'unknown'}],['payment-create',{quoteId:'x',confirmed:1}],['payment-orders',{page:0}],['payment-resolve',{confirmed:'true'}]])assert.equal((await f.command(action,value)).code,'INVALID_REQUEST');
  assert.equal(f.state.calls.length,0);
  const quote=await f.command('payment-quote',{amount:50,method:'alipay'});
  t.mock.method(fs.promises,'rename',async()=>{throw Error('Synthetic disk failure');});
  assert.equal((await f.command('payment-create',{quoteId:quote.quoteId,confirmed:true})).code,'STORAGE_UNAVAILABLE');
  assert.equal(f.state.calls.filter(call=>call.route==='/api/user/pay').length,0);
});

test('native recharge corrupt journals block replay and invalidation never clears an existing pending order',async t=>{
  const f=paymentFixture(t),quote=await f.command('payment-quote',{amount:50,method:'alipay'});await f.command('payment-create',{quoteId:quote.quoteId,confirmed:true});
  f.controller.invalidate();assert.equal((await f.command('payment-open')).code,'PENDING_OPERATION');assert.equal((await f.command('payment-options')).pending.orderKnown,true);
  f.controller.dispose();fs.writeFileSync(f.file+'.payment','corrupt');
  const broken=createAccountPayment({journalFile:f.file,request:f.request,getIdentity:()=>({userId:12,sid:f.state.sid})});t.after(()=>broken.dispose());
  const count=f.state.calls.length;assert.equal((await broken.command('payment-options',{accountId:12})).code,'STORAGE_UNAVAILABLE');assert.equal(f.state.calls.length,count);
});
