import test from 'node:test';
import assert from 'node:assert/strict';
import {mountRelayAccountView} from '../public/relay-account-view.mjs';

const tick=()=>new Promise(resolve=>setImmediate(resolve));
async function settle(){for(let i=0;i<12;i++)await tick();}
function fixture({active=true,startupReady=true,respond=()=>({available:true,state:'ready',visible:true})}={}){
  const calls=[],documentEvents=new Map(),windowEvents=new Map(),observers=[];
  let clock=0,timerId=0;const timers=new Map();
  const element=()=>({disabled:false,textContent:'',dataset:{},classList:{toggle(){}},onclick:null});
  const panel={active,getBoundingClientRect:()=>({left:200,top:68,right:1200,bottom:820}),classList:{contains:()=>panel.active}};
  const viewport=element();viewport.rect={left:230.4,top:310.2,right:1170.9,bottom:900};viewport.getBoundingClientRect=()=>viewport.rect;
  const status=element(),openButton=element(),reloadButton=element(),closeButton=element(),badge=element();
  const document={body:{dataset:{startupState:startupReady?'ready':'loading'}},visibilityState:'visible',dialog:false,querySelector:()=>document.dialog?{}:null,
    addEventListener:(name,fn)=>documentEvents.set(name,fn),removeEventListener:name=>documentEvents.delete(name)};
  const window={innerWidth:1200,innerHeight:820,requestAnimationFrame:fn=>setImmediate(fn),addEventListener:(name,fn)=>windowEvents.set(name,fn),removeEventListener:name=>windowEvents.delete(name)};
  class Observer{constructor(fn){this.fn=fn;observers.push(this);}observe(){}disconnect(){this.disconnected=true;}}
  const fetchImpl=async(path,options)=>{const action=path.split('/').pop();calls.push({action,options});const value=await respond(action,options);return value instanceof Response?value:new Response(JSON.stringify(value),{status:200,headers:{'Content-Type':'application/json'}});};
  const view=mountRelayAccountView({panel,viewport,status,openButton,reloadButton,closeButton,badge,enabled:()=>document.body.dataset.startupState==='ready',document,window,fetchImpl,MutationObserver:Observer,ResizeObserver:Observer,
    now:()=>clock,setTimer:(fn,delay)=>{const id=++timerId;timers.set(id,{fn,at:clock+delay});return id;},clearTimer:id=>timers.delete(id)});
  return {view,panel,viewport,status,openButton,reloadButton,closeButton,badge,document,window,calls,observers,
    timers,advance:async ms=>{clock+=ms;for(const [id,timer]of [...timers])if(timer.at<=clock){timers.delete(id);timer.fn();}await settle();},
    documentEvent:name=>documentEvents.get(name)?.(),windowEvent:name=>windowEvents.get(name)?.()};
}

test('account view stays lazy until its panel is visible',async()=>{
  const f=fixture({active:false});await settle();assert.equal(f.calls.length,0);
  f.panel.active=true;f.view.refresh();await settle();
  assert.deepEqual(f.calls.map(v=>v.action),['state','open']);
  assert.deepEqual(JSON.parse(f.calls[1].options.body),{x:231,y:311,width:940,height:509});
  assert.equal(f.calls[0].options.method,'GET');assert.equal(f.calls[1].options.method,'POST');
  assert.equal(f.openButton.disabled,true);assert.equal(f.reloadButton.disabled,false);assert.equal(f.viewport.dataset.attached,'true');
  f.view.close();
});
test('remote account metadata is never read or copied into local UI',async()=>{
  const f=fixture({respond:()=>({available:true,state:'ready',user:'private-user',token:'sk-secret',balance:123,cookie:'secret-cookie'})});await settle();
  assert.doesNotMatch(f.status.textContent,/private-user|sk-secret|123|secret-cookie|已登录/);
  assert.equal(f.status.textContent,'');
  assert.equal(f.badge.textContent,'个人中心');f.view.close();
});
test('hidden window and switched panel hide the remote view without reloading its session',async()=>{
  const f=fixture();await settle();f.document.visibilityState='hidden';f.documentEvent('visibilitychange');await settle();
  assert.equal(f.calls.at(-1).action,'close');assert.equal(f.viewport.dataset.attached,'false');
  f.document.visibilityState='visible';f.documentEvent('visibilitychange');await settle();assert.equal(f.calls.at(-1).action,'open');
  f.panel.active=false;f.view.refresh();await settle();assert.equal(f.calls.at(-1).action,'close');
  assert.equal(f.calls.filter(v=>v.action==='reload').length,0);f.view.close();
});
test('late availability response cannot open the view after leaving the panel',async()=>{
  let release;const f=fixture({respond:action=>action==='state'?new Promise(resolve=>{release=resolve;}):{available:true}});await settle();
  f.panel.active=false;f.view.refresh();release({available:true});await settle();
  assert.deepEqual(f.calls.map(v=>v.action),['state']);f.view.close();
});
test('a view opened during a panel switch is immediately hidden and does not expose stale state',async()=>{
  let release;const f=fixture({respond:action=>action==='open'?new Promise(resolve=>{release=resolve;}):{available:true}});await settle();
  f.panel.active=false;f.view.refresh();release({available:true});await settle();
  assert.deepEqual(f.calls.map(v=>v.action),['state','open','close']);assert.equal(f.viewport.dataset.attached,'false');f.view.close();
});
test('resize and scroll updates are coalesced and unchanged bounds do not write again',async()=>{
  const f=fixture();await settle();f.view.refresh();f.view.refresh();await settle();assert.equal(f.calls.length,2);
  f.viewport.rect={left:250,top:200,right:1100,bottom:700};f.windowEvent('resize');f.windowEvent('scroll');f.windowEvent('scroll');await settle();
  assert.deepEqual(f.calls.map(v=>v.action),['state','open','bounds']);assert.deepEqual(JSON.parse(f.calls.at(-1).options.body),{x:250,y:200,width:850,height:500});f.view.close();
});
test('a dialog hides the remote layer and closing the dialog restores it',async()=>{
  const f=fixture();await settle();f.document.dialog=true;f.observers[1].fn();await settle();assert.equal(f.calls.at(-1).action,'close');
  f.document.dialog=false;f.observers[1].fn();await settle();assert.equal(f.calls.at(-1).action,'open');f.view.close();
});
test('non-desktop environments show a fixed fallback and can retry deliberately',async()=>{
  const f=fixture({respond:()=>({available:false})});await settle();assert.deepEqual(f.calls.map(v=>v.action),['state']);
  assert.match(f.status.textContent,/桌面应用/);assert.equal(f.openButton.disabled,false);assert.equal(f.reloadButton.disabled,true);
  f.openButton.onclick();await settle();assert.deepEqual(f.calls.map(v=>v.action),['state','state']);f.view.close();
});
test('request failure hides the layer and never displays backend exception text',async()=>{
  const f=fixture({respond:action=>{if(action==='open')throw Error('https://secret.test sk-private');return {available:true};}});await settle();
  assert.deepEqual(f.calls.map(v=>v.action),['state','open','close']);assert.match(f.status.textContent,/暂时无法打开/);assert.doesNotMatch(f.status.textContent,/secret|sk-private/);
  f.view.refresh();await settle();assert.equal(f.calls.length,3);f.view.close();
});
test('reload only runs on explicit return action and manual close remains paused',async()=>{
  const f=fixture();await settle();f.reloadButton.onclick();await settle();assert.equal(f.calls.filter(v=>v.action==='reload').length,1);
  f.closeButton.onclick();await settle();assert.equal(f.calls.at(-1).action,'close');f.windowEvent('resize');await settle();assert.equal(f.calls.at(-1).action,'close');
  f.openButton.onclick();await settle();assert.equal(f.calls.at(-1).action,'open');assert.equal(f.calls.filter(v=>v.action==='reload').length,1);f.view.close();
});
test('destroy cancels a pending open and removes lifecycle listeners',async()=>{
  let release;const f=fixture({respond:action=>action==='state'?new Promise(resolve=>{release=resolve;}):{available:true}});await settle();
  f.view.close();release({available:true});await settle();assert.deepEqual(f.calls.map(v=>v.action),['state']);
  assert.ok(f.observers.every(v=>v.disconnected));
});
test('offscreen or too-small account slot never opens a remote layer',async()=>{
  const f=fixture({active:false});f.panel.active=true;f.viewport.rect={left:230,top:900,right:1100,bottom:1000};f.view.refresh();await settle();assert.equal(f.calls.length,0);f.view.close();
});
test('loading checks only public state and stops when ready without reloading',async()=>{
  let ready=false;const f=fixture({respond:()=>({available:true,state:ready?'ready':'loading',visible:true})});await settle();
  assert.match(f.status.textContent,/正在连接/);assert.equal(f.timers.size,1);ready=true;await f.advance(1000);
  assert.deepEqual(f.calls.map(v=>v.action),['state','open','state']);assert.equal(f.timers.size,0);assert.equal(f.status.textContent,'');f.view.close();
});
test('loading stops after thirty seconds and only explicit return can retry',async()=>{
  const f=fixture({respond:()=>({available:true,state:'loading',visible:true})});await settle();
  for(let i=0;i<30;i++)await f.advance(1000);
  assert.equal(f.calls.filter(v=>v.action==='state').length,31);assert.equal(f.timers.size,0);assert.match(f.status.textContent,/仍未完成加载/);
  await f.advance(30000);assert.equal(f.calls.filter(v=>v.action==='state').length,31);assert.equal(f.calls.filter(v=>v.action==='reload').length,0);
  f.reloadButton.onclick();await settle();assert.equal(f.calls.at(-1).action,'reload');assert.equal(f.timers.size,1);f.view.close();
});
test('load failure stops checking but preserves explicit return without exposing raw errors',async()=>{
  let failed=false;const f=fixture({respond:()=>({available:true,state:failed?'error':'loading',visible:true,error:'https://private.test sk-secret'})});await settle();
  failed=true;await f.advance(1000);assert.equal(f.timers.size,0);assert.match(f.status.textContent,/连接失败/);assert.doesNotMatch(f.status.textContent,/private|sk-secret/);assert.equal(f.reloadButton.disabled,false);
  await f.advance(30000);assert.equal(f.calls.length,3);f.view.close();
});
test('hidden and closed panels cancel pending loading checks',async()=>{
  const f=fixture({respond:()=>({available:true,state:'loading',visible:true})});await settle();
  f.document.visibilityState='hidden';f.documentEvent('visibilitychange');await settle();assert.equal(f.timers.size,0);await f.advance(5000);
  assert.deepEqual(f.calls.map(v=>v.action),['state','open','close']);
  f.document.visibilityState='visible';f.documentEvent('visibilitychange');await settle();assert.equal(f.timers.size,1);
  f.closeButton.onclick();await settle();assert.equal(f.timers.size,0);f.view.close();
});

test('startup loading never opens remote account even when the initial account panel is active',async()=>{
  const f=fixture({startupReady:false});await settle();assert.equal(f.calls.length,0);
  f.openButton.onclick();await settle();assert.equal(f.calls.length,0);
  f.panel.active=false;f.document.body.dataset.startupState='ready';f.windowEvent('hamster-startup-ready');await settle();assert.equal(f.calls.length,0);
  f.panel.active=true;f.windowEvent('hamster-view-changed');await settle();assert.deepEqual(f.calls.map(v=>v.action),['state','open']);f.view.close();
});

test('startup completion opens a first account once and destroy removes the new lifecycle listeners',async()=>{
  const f=fixture({startupReady:false});await settle();f.document.body.dataset.startupState='ready';f.windowEvent('hamster-startup-ready');f.windowEvent('hamster-view-changed');await settle();
  assert.deepEqual(f.calls.map(v=>v.action),['state','open']);f.view.close();await settle();const before=f.calls.length;
  f.windowEvent('hamster-startup-ready');f.windowEvent('hamster-view-changed');await settle();assert.equal(f.calls.length,before);
});
