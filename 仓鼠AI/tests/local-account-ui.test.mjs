import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source=fs.readFileSync(new URL('../public/account.mjs',import.meta.url),'utf8');
const groups=['image-standard','video-standard','tool-standard','chat-standard'];
const signed={ok:true,signedIn:true,user:{id:7,email:'customer@example.test'},balance:149.069966,spent:8.230034,requests:16,groups,pending:[]};
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
async function settled(predicate){for(let i=0;i<50;i++){if(predicate())return;await new Promise(resolve=>setImmediate(resolve));}assert.fail('UI did not settle');}
const guest={ok:true,signedIn:false,groups:[],pending:[]};

function fixture({respond=async()=>signed,active=true,startupState='ready',desktop=true,workDirectory}={}){
  const elements=new Map(),commands=[],listeners=new Map(),documentListeners=new Map();let now=Date.now(),uuid=0;
  class Element{
    constructor(tag='div'){this.tag=tag;this.children=[];this.value='';this.textContent='';this.innerHTML='';this.dataset={};this.hidden=false;this.disabled=false;this.handlers={};}
    setAttribute(name,value){this[name]=value;}
    removeAttribute(name){delete this[name];}
    reportValidity(){return true;}
    append(...children){for(const child of children){child.parent=this;this.children.push(child);}}
    replaceChildren(...children){this.children=[];this.append(...children);}
    remove(){this.removed=true;if(this.parent)this.parent.children=this.parent.children.filter(child=>child!==this);}
    addEventListener(type,fn){this.handlers[type]=fn;}
    showModal(){this.open=true;}close(){this.open=false;}
  }
  const el=id=>{if(!elements.has(id))elements.set(id,new Element());return elements.get(id);};
  const dashboard=el('dashboard'),panel={active,classList:{contains:()=>panel.active}};dashboard.closest=()=>panel;
  const document={body:{dataset:{startupState}},visibilityState:'visible',getElementById:el,createElement:tag=>new Element(tag),querySelector:selector=>selector==='.account-dashboard'?dashboard:null,addEventListener:(type,fn)=>documentListeners.set(type,fn)};
  const window={hamsterWorkDirectory:workDirectory,hamsterDesktopAccount:desktop?{command:async(action,payload)=>{commands.push({action,payload});return respond(action,payload);}}:undefined,addEventListener:(type,fn)=>{if(!listeners.has(type))listeners.set(type,[]);listeners.get(type).push(fn);},dispatchEvent:event=>{for(const fn of listeners.get(event.type)||[])fn(event);}};
  const context={document,window,Date:class extends Date{static now(){return now;}},crypto:{randomUUID:()=>`00000000-0000-4000-8000-${String(++uuid).padStart(12,'0')}`},Event:class{constructor(type){this.type=type;}},CustomEvent:class{constructor(type,options={}){this.type=type;this.detail=options.detail;}},fetch:async()=>Response.json({relayMode:true,keyStorage:'protected'}),localStorage:{removeItem(){},setItem(){assert.fail('account metadata must not be persisted');}},confirm:()=>true};
  const initialized=vm.runInNewContext(`(async()=>{${source.replace("import {reportAccountFailure} from './fault-events.mjs';",'const reportAccountFailure=()=>{};')}\n})()`,context);
  const event=type=>window.dispatchEvent(new context.Event(type));
  return {initialized,el,commands,event,document,advance:ms=>{now+=ms;},activate:()=>{panel.active=true;event('hamster-view-changed');},deactivate:()=>{panel.active=false;event('hamster-view-changed');},ready:()=>{document.body.dataset.startupState='ready';event('hamster-startup-ready');},get dialog(){return dashboard.children.find(node=>node.tag==='dialog');}};
}

test('local account renders safe metadata, rounds card amounts and never loads a remote account frame',async()=>{
  const app=fixture();await app.initialized;await settled(()=>app.el('localAccountBalance').textContent==='¥149.07');
  assert.equal(app.el('localAccountSpent').textContent,'¥8.23');assert.equal(app.el('localAccountIdentity').textContent,'customer@example.test');
  assert.deepEqual(app.commands.map(row=>row.action),['snapshot']);
  assert.doesNotMatch(source,/mountRelayAccountView|relayAccountViewport|<iframe/);
  assert.equal(app.el('createImageKey').hidden,false);assert.equal(app.el('recoverImageKey').hidden,true);
});

test('startup and visibility gate snapshot reads, revisits use only in-memory display results',async()=>{
  const app=fixture({startupState:'loading'});await app.initialized;assert.equal(app.commands.length,0);app.ready();await settled(()=>app.commands.length===1);app.event('hamster-view-changed');assert.equal(app.commands.length,1);
  app.deactivate();app.advance(20000);app.event('hamster-account-updated');assert.equal(app.commands.length,1);assert.equal(app.el('localAccountWallet').hidden,true);
  app.activate();await settled(()=>app.commands.length===2);assert.equal(app.commands.every(row=>row.action==='snapshot'),true);
});

test('work directory loads on the visible account page and announces the next launch destination',async()=>{
  let loads=0,choices=0;
  const activeDirectory='synthetic works',nextDirectory='synthetic next works';
  const app=fixture({active:false,workDirectory:{
    status:async()=>{loads++;return {ok:true,activeDirectory,nextDirectory:activeDirectory,restartRequired:false};},
    choose:async()=>{choices++;return {ok:true,activeDirectory,nextDirectory,restartRequired:true};},
  }});
  await app.initialized;
  assert.equal(loads,0);
  app.activate();
  await settled(()=>app.el('workDirectoryCurrent').textContent.includes(activeDirectory));
  app.deactivate();app.activate();
  assert.equal(loads,1);
  await app.el('chooseWorkDirectory').onclick();
  assert.equal(choices,1);
  assert.match(app.el('workDirectoryStatus').textContent,/重启仓鼠AI后生效/);
  assert.match(app.el('workDirectoryNext').textContent,/synthetic next works/);
  assert.match(app.el('workDirectoryCurrent').textContent,/synthetic works/);
});

test('late snapshot is discarded after account change and one fresh snapshot follows',async()=>{
  const first=deferred();let count=0;
  const app=fixture({respond:()=>++count===1?first.promise:Promise.resolve({ok:true,signedIn:false,groups:[],pending:[]})});await app.initialized;
  app.event('hamster-account-updated');first.resolve(signed);await settled(()=>app.commands.length===2);await settled(()=>app.el('localAccountIdentity').textContent==='登录后开通所需功能');
  assert.equal(app.el('localAccountBalance').textContent,'—');assert.equal(app.el('localAccountWallet').hidden,true);
});

test('creating requires explicit form submission and reuses one request ID after an uncertain response',async()=>{
  const app=fixture({respond:async action=>action==='create'?{ok:false,code:'NETWORK'}:signed});await app.initialized;await settled(()=>app.el('localAccountBalance').textContent==='¥149.07');
  app.el('createImageKey').onclick();assert.equal(app.commands.filter(row=>row.action==='create').length,0);
  const form=app.dialog.children.find(row=>row.tag==='form'),days=form.children[0].children[0],limit=form.children[1].children[0];assert.equal(days.value,'30');assert.equal(limit.placeholder,'不设上限');
  limit.value='20';await form.onsubmit({preventDefault(){}});await form.onsubmit({preventDefault(){}});
  const requests=app.commands.filter(row=>row.action==='create');assert.equal(requests.length,2);assert.equal(requests[0].payload.requestId,requests[1].payload.requestId);assert.equal(requests[0].payload.group,'image-standard');assert.equal(requests[0].payload.limit,'20');assert.equal(requests[0].payload.days,30);
});

test('pending original creation blocks a new create and resumes only the original operation',async()=>{
  const app=fixture({respond:async action=>action==='recover'?{ok:true,code:'SAVED_CHECK_PENDING',saved:true}:{...signed,pending:[{group:'image-standard',name:'original',state:'pending'}]}});await app.initialized;await settled(()=>app.el('recoverImageKey').hidden===false);
  assert.equal(app.el('createImageKey').hidden,true);assert.equal(app.el('selectImageKey').hidden,true);await app.el('recoverImageKey').onclick();
  assert.equal(app.commands.filter(row=>row.action==='recover').length,1);assert.equal(app.commands.filter(row=>row.action==='create').length,0);
});

test('empty filtered key page still permits next page; only a selected active Key can enable',async()=>{
  const app=fixture({respond:async(action,payload)=>action==='keys'?{ok:true,items:payload.page===1?[]:[{id:23,name:'<img onerror=bad>',group:'image-standard',status:1,expiresAt:-1}],total:22,page:payload.page}:action==='enable'?{ok:true,code:'CONNECTED'}:signed});await app.initialized;await settled(()=>app.el('localAccountBalance').textContent==='¥149.07');
  app.el('selectImageKey').onclick();await settled(()=>app.commands.some(row=>row.action==='keys'));
  const list=app.dialog.children[1],pager=app.dialog.children[2];await settled(()=>pager.children[2].disabled===false);assert.match(list.children[0].textContent,/本页没有/);pager.children[2].onclick();await settled(()=>list.children[0]?.className==='local-key-row');
  assert.equal(list.children[0].children[0].children[0].textContent,'<img onerror=bad>');assert.equal(app.commands.some(row=>row.action==='enable'),false);
  await list.children[0].children[1].onclick();assert.deepEqual(JSON.parse(JSON.stringify(app.commands.find(row=>row.action==='enable').payload)),{id:23,group:'image-standard'});
});

test('native update during enable clears stale rows and refreshes after the operation settles',async()=>{
  const pending=deferred();let app;app=fixture({respond:async(action)=>action==='keys'?{ok:true,items:[{id:1,name:'first',status:1,expiresAt:-1}],total:1}:action==='enable'?pending.promise:signed});await app.initialized;await settled(()=>app.el('localAccountBalance').textContent==='¥149.07');
  app.el('selectImageKey').onclick();await settled(()=>app.dialog.children[1].children[0]?.className==='local-key-row');const enabled=app.dialog.children[1].children[0].children[1].onclick();
  app.event('hamster-account-updated');assert.equal(app.dialog,undefined);assert.equal(app.el('localAccountWallet').hidden,true);pending.resolve({ok:true,code:'CONNECTED'});await enabled;await settled(()=>app.el('localAccountWallet').hidden===false);
  assert.equal(app.commands.filter(row=>row.action==='snapshot').length,2);
});

test('usage and task settlements remain separate and reserved funds are visibly marked',async()=>{
  const app=fixture({respond:async(action,payload)=>action==='usage'?{ok:true,items:[{kind:'image-standard',model:'image',createdAt:1700000000,amount:0.123456,state:'reserved'}],total:1,page:payload.page}:signed});await app.initialized;await settled(()=>app.el('localAccountBalance').textContent==='¥149.07');
  app.el('usageLocalAccount').onclick();await settled(()=>app.commands.some(row=>row.action==='usage'));const select=app.dialog.children[1],list=app.dialog.children[2];select.value='settlements';select.onchange();await settled(()=>app.commands.filter(row=>row.action==='usage').length===2);await settled(()=>list.children[0]?.className==='local-usage-row');
  assert.equal(app.commands.filter(row=>row.action==='usage')[1].payload.kind,'settlements');assert.equal(list.children[0].children[1].children[1].textContent,'已预留');assert.equal(list.children[0].children[1].children[0].textContent,'¥0.123456');
});

test('recharge launch reports fixed text without rendering service details',async()=>{
  const app=fixture({respond:async action=>action==='browser-open'
    ?{ok:false,code:'DESKTOP_ACCOUNT_MISMATCH',message:'synthetic-private-detail'}:signed});
  await app.initialized;await settled(()=>app.el('localAccountWallet').hidden===false);
  await app.el('payLocalAccount').onclick();
  assert.match(app.el('localAccountNotice').textContent,/浏览器账号与仓鼠 AI 当前账号不一致/);
  assert.doesNotMatch(app.el('localAccountNotice').textContent,/synthetic-private-detail/);
  assert.equal(app.el('localAccountBalance').textContent,'¥149.07');
  assert.equal(app.dialog,undefined);
});

test('a limited first snapshot keeps both browser entry points usable',async()=>{
  for(const mode of ['register','login']){
    const app=fixture({respond:async action=>action==='snapshot'
      ?{ok:false,code:'RATE_LIMITED',retryAfterMs:1200000}:{ok:true}});
    await app.initialized;await settled(()=>app.el('localAccountNotice').textContent.includes('1200 秒'));
    assert.equal(app.el('localAccountGuest').hidden,false);
    assert.equal(app.el(mode+'LocalAccount').disabled,false);
    await app.el(mode+'LocalAccount').onclick();
    assert.deepEqual(app.commands.map(row=>row.action),['snapshot','browser-open']);
    assert.equal(app.el('localAccountWallet').hidden,true);
  }
});

test('a limited refresh retains the verified balance and permits browser recharge, usage and logout',async()=>{
  let snapshots=0;
  const app=fixture({respond:async action=>{
    if(action==='snapshot')return ++snapshots===1?signed:{ok:false,code:'RATE_LIMITED',retryAfterMs:1200000};
    if(action==='usage')return {ok:true,items:[],total:0,page:1};
    return {ok:true};
  }});
  await app.initialized;await settled(()=>app.el('localAccountBalance').textContent==='¥149.07');
  await app.el('refreshLocalAccount').onclick();
  assert.match(app.el('localAccountNotice').textContent,/此操作请求过于频繁.*1200 秒/);
  assert.equal(app.el('localAccountBalance').textContent,'¥149.07');
  await app.el('payLocalAccount').onclick();
  app.el('usageLocalAccount').onclick();
  await settled(()=>app.commands.some(row=>row.action==='usage'));
  await app.el('logoutLocalAccount').onclick();
  assert.deepEqual(app.commands.map(row=>row.action),['snapshot','snapshot','browser-open','usage','logout']);
  assert.equal(app.el('localAccountWallet').hidden,true);
  assert.equal(app.el('localAccountBalance').textContent,'—');
});

test('guest browser launch forwards no credentials and waits for the verified account snapshot',async()=>{
  const launch=deferred();
  let verified=false;
  const app=fixture({respond:async action=>action==='browser-open'?launch.promise:verified?signed:guest});
  await app.initialized;await settled(()=>app.el('localAccountIdentity').textContent==='登录后开通所需功能');
  const opening=app.el('loginLocalAccount').onclick();
  assert.equal(app.el('loginLocalAccount').disabled,true);
  await app.el('registerLocalAccount').onclick();
  assert.deepEqual(app.commands.map(row=>row.action),['snapshot','browser-open']);
  assert.deepEqual(Object.keys(app.commands[1].payload),[]);
  launch.resolve({ok:true,connectionCode:'ABC123'});
  await opening;
  assert.match(app.el('localAccountNotice').textContent,/核对连接码 ABC123/);
  assert.equal(app.el('localAccountWallet').hidden,true);
  assert.equal(app.dialog,undefined);
  verified=true;
  app.event('hamster-account-updated');
  await settled(()=>app.el('localAccountWallet').hidden===false);
  assert.deepEqual(app.commands.map(row=>row.action),['snapshot','browser-open','snapshot']);
});

test('bridge rejection shows fixed recovery text and retries only on a new click',async()=>{
  const app=fixture({respond:async action=>{
    if(action==='browser-open')throw Error('synthetic-private-bridge-failure');
    return guest;
  }});
  await app.initialized;await settled(()=>app.commands.length===1);
  await app.el('registerLocalAccount').onclick();
  assert.equal(app.el('localAccountNotice').textContent,'暂时无法完成，请稍后重试。');
  assert.equal(app.el('localAccountWallet').hidden,true);
  for(const id of ['registerLocalAccount','loginLocalAccount','refreshLocalAccount'])assert.equal(app.el(id).disabled,false);
  await app.el('refreshLocalAccount').onclick();
  assert.deepEqual(app.commands.map(row=>row.action),['snapshot','browser-open','snapshot']);
  await app.el('loginLocalAccount').onclick();
  assert.deepEqual(app.commands.map(row=>row.action),['snapshot','browser-open','snapshot','browser-open']);
});

test('pending connection preserves the balance of the same verified account',async()=>{
  let pending=false;
  const app=fixture({respond:async()=>pending?{ok:true,signedIn:true,user:{id:7},browserPending:true}:signed});
  await app.initialized;await settled(()=>app.el('localAccountBalance').textContent==='¥149.07');
  pending=true;
  await app.el('refreshLocalAccount').onclick();
  assert.equal(app.el('localAccountBalance').textContent,'¥149.07');
  assert.match(app.el('localAccountNotice').textContent,/手动返回应用/);
  assert.deepEqual(app.commands.map(row=>row.action),['snapshot','snapshot']);
});

test('recharge launch waits for refreshed balance and sends no desktop payment command',async()=>{
  let balance=149.069966;
  const app=fixture({respond:async action=>action==='browser-open'?{ok:true}:{...signed,balance}});
  await app.initialized;await settled(()=>app.el('localAccountBalance').textContent==='¥149.07');
  await app.el('payLocalAccount').onclick();
  assert.match(app.el('localAccountNotice').textContent,/已在浏览器打开中转站/);
  assert.equal(app.el('localAccountBalance').textContent,'¥149.07');
  assert.equal(app.dialog,undefined);
  assert.deepEqual(Object.keys(app.commands[1].payload),[]);
  balance=199.069966;
  app.event('hamster-account-updated');
  await settled(()=>app.el('localAccountBalance').textContent==='¥199.07');
  assert.deepEqual(app.commands.map(row=>row.action),['snapshot','browser-open','snapshot']);
});

test('account mismatch blocks recharge and activation while retaining the displayed balance',async()=>{
  const app=fixture({respond:async()=>({...signed,accountMatched:false})});await app.initialized;await settled(()=>app.el('localAccountWallet').hidden===false);
  assert.equal(app.el('localAccountBalance').textContent,'¥149.07');assert.equal(app.el('localAccountMapping').hidden,false);assert.equal(app.el('payLocalAccount').disabled,true);assert.equal(app.el('createImageKey').disabled,true);
  app.el('payLocalAccount').onclick();app.el('createImageKey').onclick();await app.el('recoverImageKey').onclick();assert.equal(app.dialog,undefined);assert.equal(app.commands.every(row=>row.action==='snapshot'),true);
});

test('late browser launch cannot repaint connection instructions after the account changes',async()=>{
  const launch=deferred();
  let verified=true;
  const app=fixture({respond:async action=>action==='browser-open'?launch.promise:verified?signed:guest});
  await app.initialized;await settled(()=>app.el('localAccountWallet').hidden===false);
  const opening=app.el('payLocalAccount').onclick();
  verified=false;
  app.event('hamster-account-updated');
  launch.resolve({ok:true,connectionCode:'ABC123'});
  await opening;await settled(()=>app.commands.length===3);
  assert.equal(app.el('localAccountWallet').hidden,true);
  assert.doesNotMatch(app.el('localAccountNotice').textContent,/ABC123|浏览器打开/);
  assert.deepEqual(app.commands.map(row=>row.action),['snapshot','browser-open','snapshot']);
});

test('pending guest connection is restored by a read and awaits deliberate browser reopen',async()=>{
  const app=fixture({respond:async action=>action==='snapshot'?{...guest,browserPending:true}:{ok:true,connectionCode:'ABC123'}});
  await app.initialized;
  await settled(()=>app.el('localAccountNotice').textContent.includes('手动返回应用'));
  assert.equal(app.el('localAccountWallet').hidden,true);
  assert.deepEqual(app.commands.map(row=>row.action),['snapshot']);
  await app.el('loginLocalAccount').onclick();
  assert.deepEqual(app.commands.map(row=>row.action),['snapshot','browser-open']);
  assert.match(app.el('localAccountNotice').textContent,/ABC123/);
});

test('an inactive account view neither opens the browser nor reads a snapshot',async()=>{
  const app=fixture({active:false});await app.initialized;
  await app.el('loginLocalAccount').onclick();
  await app.el('payLocalAccount').onclick();
  assert.equal(app.commands.length,0);
  app.activate();
  await settled(()=>app.commands.length===1);
  assert.equal(app.commands[0].action,'snapshot');
});

test('standalone page exposes the account website without attempting a desktop operation',async()=>{
  const app=fixture({desktop:false});await app.initialized;
  assert.equal(app.el('localAccountWeb').hidden,false);
  assert.equal(app.el('localAccountGuest').hidden,true);
  assert.equal(app.commands.length,0);
  assert.doesNotMatch(source,/mountNativeAuth|mountNativePayment|auth-login|payment-create/);
});

