import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {safeLocalWorkspaceUrl,mountLocalWorkspace} from '../public/local-workspace.mjs';
import {observeWorkspaceActivity} from '../smart-video-agent/chat-ui/workspace-activity.mjs';

class Element {
  constructor(tag,document){this.tagName=tag;this.ownerDocument=document;this.children=[];this.attributes={};this.listeners={};this.textContent='';this.hidden=false;if(tag==='iframe'){this.messages=[];this.contentWindow={postMessage:(...args)=>this.messages.push(args)};}}
  append(...nodes){this.children.push(...nodes);}
  replaceChildren(...nodes){this.children=[...nodes];}
  setAttribute(name,value){this.attributes[name]=value;}
  addEventListener(name,fn){(this.listeners[name]||=[]).push(fn);}
  removeEventListener(name,fn){this.listeners[name]=(this.listeners[name]||[]).filter(item=>item!==fn);}
  emit(name,event={}){for(const fn of this.listeners[name]||[])fn(event);}
  showModal(){this.open=true;}
  close(){this.open=false;this.emit('close');}
  focus(){this.focused=true;}
}
const document={createElement(tag){return new Element(tag,this);}};
const nodes=root=>[root,...root.children.flatMap(nodes)];
const flush=async()=>{for(let i=0;i<12;i++)await Promise.resolve();};
const chatUrl='http://127.0.0.1:22345/chat/';
const chatInstanceUrl=chatUrl+'?instance=12345678-1234-4234-8234-123456789abc';
const canvasUrl='http://127.0.0.1:22346/?token='+'a'.repeat(64);
function fixture(open,extra={}){
  const container=new Element('main',document),window=new Element('window',document),calls=[],timers=new Map();let nextTimer=0;
  const ui=mountLocalWorkspace(container,{kind:'chat',title:'仓鼠AI 对话',window,appOrigin:'http://127.0.0.1:11140',open:async()=>{calls.push('open');return open();},setTimer:fn=>{timers.set(++nextTimer,fn);return nextTimer;},clearTimer:id=>timers.delete(id),...extra});
  return {ui,container,window,calls,timers,frame:()=>nodes(container).find(node=>node.tagName==='iframe'),retry:()=>nodes(container).find(node=>node.tagName==='button'),status:()=>nodes(container).find(node=>node.tagName==='p')};
}

test('entry validation only accepts exact isolated loopback chat and token-authenticated canvas entries',()=>{
  assert.equal(safeLocalWorkspaceUrl('chat',chatUrl),chatUrl);
  assert.equal(safeLocalWorkspaceUrl('chat',chatInstanceUrl),chatInstanceUrl);
  assert.equal(safeLocalWorkspaceUrl('canvas',canvasUrl),canvasUrl);
  const project='12345678-1234-1234-1234-123456789abc';
  assert.equal(safeLocalWorkspaceUrl('canvas',canvasUrl+'&project='+project),canvasUrl+'&project='+project);
  for(const url of ['https://127.0.0.1:22345/chat/','http://localhost:22345/chat/','http://127.1:22345/chat/','http://2130706433:22345/chat/','http://127.0.0.1:80/chat/','http://127.0.0.1:65536/chat/','http://user@127.0.0.1:22345/chat/','http://127.0.0.1:22345/api/config','http://127.0.0.1:22345/api/../chat/',chatUrl+'?key=secret',chatUrl+'#section','/chat/',null])assert.equal(safeLocalWorkspaceUrl('chat',url),null,String(url));
  assert.equal(safeLocalWorkspaceUrl('chat',chatUrl,'http://127.0.0.1:22345'),null);
  for(const url of [chatUrl,canvasUrl+'&token='+'a'.repeat(64),canvasUrl+'&other=x',canvasUrl+'&project=../private',canvasUrl+'&project='+project+'&project='+project,canvasUrl+'#x',canvasUrl.replace('?token=','?bad='),canvasUrl.replace('a'.repeat(64),'short')])assert.equal(safeLocalWorkspaceUrl('canvas',url),null,url);
});

test('chat cache migration accepts only one canonical instance UUID and retains the loopback boundary',()=>{
  const instance='12345678-1234-4234-8234-123456789abc';
  for(const value of [
    '?instance=', '?instance=short', '?instance='+instance+'&instance='+instance,
    '?instance='+instance+'&other=1', '?other=1&instance='+instance, '?instance='+instance+'&',
    '?%69nstance='+instance, '?instance='+instance.toUpperCase(), '?instance=12345678-1234-1234-8234-123456789abc',
    '?instance=12345678-1234-4234-1234-123456789abc', '?instance='+instance+'#fragment',
    '?instance='+instance+'%0a', '?instance='+instance+'%26next=https://foreign.invalid',
  ])assert.equal(safeLocalWorkspaceUrl('chat',chatUrl+value),null,value);
  assert.equal(safeLocalWorkspaceUrl('chat',chatInstanceUrl,'http://127.0.0.1:22345'),null);
  for(const value of [chatInstanceUrl.replace('127.0.0.1','localhost'),chatInstanceUrl.replace('http:','https:'),chatInstanceUrl.replace('/chat/','/api/config'),chatInstanceUrl.replace('127.0.0.1:','user@127.0.0.1:')])assert.equal(safeLocalWorkspaceUrl('chat',value),null,value);
});

test('instance-bound chat entries load in the same retained frame with the existing sandbox',async()=>{
  const f=fixture(()=>({status:'ready',url:chatInstanceUrl}));
  const opening=f.ui.open();await flush();
  assert.equal(f.frame().src,chatInstanceUrl);assert.equal(f.frame().attributes.sandbox,'allow-scripts allow-same-origin allow-forms allow-modals allow-downloads');
  f.frame().emit('load');assert.equal(await opening,true);
  const frame=f.frame();assert.equal(await f.ui.open(),true);assert.equal(f.frame(),frame);assert.equal(f.calls.length,1);
});

test('mount is idle; repeated navigation shares one launch and preserves the loaded iframe',async()=>{
  let resolve;const backend=new Promise(done=>resolve=done),f=fixture(()=>backend);
  assert.deepEqual(f.calls,[]);assert.equal(f.frame(),undefined);
  const first=f.ui.open(),second=f.ui.open();await flush();assert.equal(f.calls.length,1);assert.equal(f.container.attributes['aria-busy'],'true');
  resolve({status:'ready',url:chatUrl});await flush();const frame=f.frame();assert.ok(frame);
  assert.equal(frame.src,chatUrl);assert.equal(frame.attributes.sandbox,'allow-scripts allow-same-origin allow-forms allow-modals allow-downloads');assert.equal(frame.attributes.allow,'clipboard-write');assert.equal(frame.attributes.referrerpolicy,'no-referrer');
  assert.doesNotMatch(frame.attributes.sandbox,/allow-top-navigation|allow-popups/);
  assert.equal(f.status().hidden,false,'server readiness is not page readiness');
  frame.emit('load');assert.equal(await first,true);assert.equal(await second,true);assert.equal(f.status().hidden,true);assert.equal(f.container.attributes['aria-busy'],'false');assert.equal(f.timers.size,0);
  assert.equal(await f.ui.open(),true);assert.equal(f.frame(),frame);assert.equal(f.calls.length,1);
});

test('untrusted service URLs and missing readiness never create a frame or expose response text',async()=>{
  for(const response of [{url:chatUrl},{status:'starting',url:chatUrl},{status:'ready',url:'https://private-provider.example/?secret=x'}]){
    const f=fixture(()=>response);assert.equal(await f.ui.open(),false);assert.equal(f.frame(),undefined);assert.equal(f.retry().hidden,false);assert.doesNotMatch(f.status().textContent,/private-provider|secret|https:/);assert.equal(f.calls.length,1);
  }
});

test('failed startup can retry once in app without automatic or billable requests',async()=>{
  let failed=true;const f=fixture(()=>{if(failed)throw Error('private backend detail');return {status:'ready',url:chatUrl};});
  assert.equal(await f.ui.open(),false);assert.equal(f.calls.length,1);assert.equal(f.retry().hidden,false);assert.doesNotMatch(f.status().textContent,/private backend detail/);
  failed=false;f.retry().emit('click');await flush();assert.equal(f.calls.length,2);f.frame().emit('load');await flush();assert.equal(f.status().hidden,true);
});

test('load error and timeout stay recoverable instead of claiming the page is ready',async()=>{
  for(const failure of ['error','timeout']){
    const f=fixture(()=>({status:'ready',url:chatUrl}));const opening=f.ui.open();await flush();assert.equal(f.status().hidden,false);
    if(failure==='error')f.frame().emit('error');else [...f.timers.values()][0]();
    assert.equal(await opening,false);assert.equal(f.frame(),undefined);assert.equal(f.retry().hidden,false);assert.equal(f.calls.length,1);assert.equal(f.timers.size,0);
  }
});

test('destroying during preparation or frame loading ignores late completion and clears timers',async()=>{
  let resolve;const f=fixture(()=>new Promise(done=>resolve=done));const opening=f.ui.open();f.ui.destroy();resolve({status:'ready',url:chatUrl});assert.equal(await opening,false);assert.equal(f.container.children.length,0);
  const g=fixture(()=>({status:'ready',url:chatUrl}));const loading=g.ui.open();await flush();g.ui.destroy();assert.equal(await loading,false);assert.equal(g.timers.size,0);assert.equal(g.container.children.length,0);
});

test('canvas uses the same on-demand lifecycle without sharing the chat frame',async()=>{
  const f=fixture(()=>({url:canvasUrl}),{kind:'canvas',title:'仓鼠AI 创作画布'});const opening=f.ui.open();await flush();assert.equal(f.frame().src,canvasUrl);f.frame().emit('load');assert.equal(await opening,true);assert.equal(f.frame().title,'仓鼠AI 创作画布');
});

test('retained workspace sends visibility to its exact origin and only trusts the current frame',async()=>{
  const f=fixture(()=>({status:'ready',url:chatUrl}));
  f.ui.setVisible(false);
  assert.equal(f.calls.length,0);
  const opening=f.ui.open();await flush();
  const frame=f.frame(),origin=new URL(chatUrl).origin;
  const ready={source:frame.contentWindow,origin,data:{type:'hamster-workspace-ready',kind:'chat'}};
  f.window.emit('message',{...ready,source:{}});
  f.window.emit('message',{...ready,origin:'http://127.0.0.1:1234'});
  assert.deepEqual(frame.messages,[]);
  f.window.emit('message',ready);
  assert.deepEqual(frame.messages,[[{type:'hamster-workspace-visibility',kind:'chat',visible:false},origin]]);
  frame.emit('load');await opening;
  for(let i=0;i<20;i++){f.ui.setVisible(true);f.ui.setVisible(false);}
  assert.equal(f.frame(),frame);assert.equal(f.calls.length,1);
  assert.deepEqual(frame.messages.at(-2),[{type:'hamster-workspace-visibility',kind:'chat',visible:true},origin]);
  assert.deepEqual(frame.messages.at(-1),[{type:'hamster-workspace-visibility',kind:'chat',visible:false},origin]);
  f.ui.destroy();assert.equal(f.window.listeners.message.length,0);
});

test('embedded activity only accepts the browser-reported shell origin and parent window',()=>{
  const origin='http://127.0.0.1:11140',notifications=[],signals=[];
  const child=new Element('window',document),doc=new Element('document',document);
  doc.documentElement={dataset:{}};doc.visibilityState='visible';
  child.parent=child.top={postMessage:(...args)=>signals.push(args)};
  child.location={ancestorOrigins:[origin],origin:new URL(chatUrl).origin};
  const activity=observeWorkspaceActivity('chat',visible=>notifications.push(visible),{window:child,document:doc});
  const shown={source:child.parent,origin,data:{type:'hamster-workspace-visibility',kind:'chat',visible:true}};
  assert.deepEqual(signals,[[{type:'hamster-workspace-ready',kind:'chat'},origin]]);
  child.emit('message',{...shown,source:{}});
  child.emit('message',{...shown,origin:'http://127.0.0.1:11141'});
  child.emit('message',{...shown,data:{...shown.data,kind:'canvas'}});
  assert.equal(activity.isVisible(),false);
  child.emit('message',shown);child.emit('message',shown);
  assert.equal(doc.documentElement.dataset.workspaceActive,'true');
  doc.visibilityState='hidden';doc.emit('visibilitychange');
  doc.visibilityState='visible';doc.emit('visibilitychange');
  child.emit('message',{...shown,data:{...shown.data,visible:false}});
  assert.deepEqual(notifications,[true,false,true,false]);
  activity.stop();assert.equal(child.listeners.message.length,0);
});

test('explicit reconnect requires HTML consent, preserves a cancelled page and only relaunches once',async()=>{
 const f=fixture(()=>({status:'ready',url:chatUrl}));const opening=f.ui.open();await flush();const original=f.frame();original.emit('load');await opening;
 assert.equal(f.retry().hidden,false);assert.equal(f.retry().textContent,'重新连接');
 const dialog=nodes(f.container).find(node=>node.tagName==='dialog'),buttons=()=>nodes(dialog).filter(node=>node.tagName==='button');
 f.retry().emit('click');assert.equal(dialog.open,true);assert.equal(f.calls.length,1);assert.equal(buttons()[0].focused,true);
 buttons()[0].emit('click');assert.equal(dialog.open,false);assert.equal(f.frame(),original);assert.equal(f.calls.length,1);
 f.retry().emit('click');buttons()[1].emit('click');buttons()[1].emit('click');await flush();assert.equal(f.calls.length,2);assert.notEqual(f.frame(),original);f.frame().emit('load');await flush();
 assert.equal(f.status().hidden,true);assert.equal(f.retry().textContent,'重新连接');
});

test('main navigation activates panels before opening, retains frames, and never prewarms at startup',()=>{
  const app=fs.readFileSync(new URL('../public/app.js',import.meta.url),'utf8'),html=fs.readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
  assert.match(html,/id="workbenchButton" data-view="chat"/);assert.match(html,/id="canvasButton" data-view="canvas"/);
  assert.match(html,/data-panel="chat"[\s\S]*id="chatWorkspace"/);assert.match(html,/data-panel="canvas"[\s\S]*id="canvasWorkspace"/);
  const scheduled=app.slice(app.indexOf('function scheduleView('),app.indexOf('function switchView('));
  assert.match(scheduled,/requestAnimationFrame/);
  assert.match(scheduled,/if\(name==='chat'\)void openWorkbench\(\)/);
  assert.match(scheduled,/if\(name==='canvas'\)void openCanvas\(\)/);
  assert.doesNotMatch(app,/requestIdleCallback\(prewarm|setTimeout\(prewarm|已在浏览器打开|window\.open/);
  assert.doesNotMatch(html,/canvas-launch\.mjs|在浏览器打开对话/);
  const view=app.slice(app.indexOf('function switchView('),app.indexOf('function wait('));assert.doesNotMatch(view,/destroy\(|replaceChildren|\.src\s*=/);
  assert.ok(view.includes("v.classList.toggle('active'")&&view.indexOf("v.classList.toggle('active'")<view.indexOf('scheduleView();'));
  assert.doesNotMatch(html,/id="chatcutButton"|https:\/\/app\.chatcut\.io\//);
});

test('explicit chat reconnect rechecks a stale ready flag and waits for a restarted service in the same attempt',async()=>{
 const source=fs.readFileSync(new URL('../public/app.js',import.meta.url),'utf8'),calls=[],elements=new Map();
 const context={activeView:'chat',document:{visibilityState:'visible'},chatMode:'pikno',workbenchReady:true,preparationPromise:null,preparationError:'',chatWorkspace:null,$:selector=>{if(!elements.has(selector))elements.set(selector,{value:0});return elements.get(selector);},publicText:value=>value,wait:async()=>{},
  mountLocalWorkspace:(_container,options)=>({open:options.open}),
  readSmartVideoResponse:async(route,options)=>{calls.push({route,options});if(route==='/api/workbench/prepare')return {status:'starting'};if(route==='/api/chat/status')return {status:'ready'};if(route==='/api/chat/open')return {status:'ready',url:chatUrl};throw Error('unexpected request');}};
 vm.createContext(context);
 const open=vm.runInContext(source.slice(source.indexOf('function renderWorkbenchPreparation('),source.indexOf('async function openCanvas('))+';openWorkbench;',context);
 const result=await open();assert.equal(result.status,'ready');assert.equal(result.url,chatUrl);
 assert.deepEqual(calls.map(call=>call.route),['/api/workbench/prepare','/api/chat/status','/api/chat/open']);
 assert.equal(context.workbenchReady,true);assert.equal(context.preparationPromise,null);
 assert.equal(calls.filter(call=>call.options?.method==='POST').length,2,'only prepare and local open are posted, never a model message');
});
