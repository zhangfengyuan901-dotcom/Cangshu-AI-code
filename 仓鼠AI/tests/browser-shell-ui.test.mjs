import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source=fs.readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
function section(start,end){
  const first=source.indexOf(start),last=source.indexOf(end,first);
  assert.ok(first>=0&&last>first);
  return source.slice(first,last);
}
function animationFrame(){
  let next=0;
  const frames=new Map();
  return {
    frames,
    requestAnimationFrame(callback){frames.set(++next,callback);return next;},
    cancelAnimationFrame(id){frames.delete(id);},
    flush(){const pending=[...frames.values()];frames.clear();pending.forEach(callback=>callback());},
  };
}

test('shell shows a destination immediately, defers initialization, and discards superseded page work',()=>{
  const frame=animationFrame(),calls=[];
  const generate={dataset:{panel:'generate'},classList:{toggle:(_,active)=>{generate.active=active;}},scrollTop:450};
  const history={dataset:{panel:'history'},classList:{toggle:(_,active)=>{history.active=active;}}};
  const tabAttributes=new Map(), utilityAttributes=new Map();
  const tab={dataset:{view:'generate'},tabIndex:0,classList:{toggle(){}},setAttribute:(name,value)=>tabAttributes.set(name,value),removeAttribute:name=>tabAttributes.delete(name)};
  const utility={dataset:{view:'history'},setAttribute:(name,value)=>utilityAttributes.set(name,value),removeAttribute:name=>utilityAttributes.delete(name)};
  const draft={value:'synthetic draft'},title={};
  const context={...frame,document:{visibilityState:'visible'},window:{dispatchEvent:event=>calls.push(event.detail.view)},
    CustomEvent:class{constructor(_name,{detail}){this.detail=detail;}},activeView:'generate',startupHydrated:true,navigationEpoch:0,
    viewPreferences:{remember:name=>calls.push(`remember:${name}`)},syncStorageStatusKind(){},
    $:selector=>selector==='#studioPageTitle'?title:null,
    $$:selector=>selector==='.view'?[generate,history]:selector==='#browserTabs [role="tab"]'?[tab]:selector==='.workspace-link[data-view]'?[utility]:[],
    state:{pendingMedia:[],models:[]},taskViews:new Set(['history','generate']),lastTaskRead:Date.now(),
    renderAllTasks:()=>calls.push('render'),needsMainCatalogue:()=>false,catalogRefresh:null,taskRefreshLoop:null,
    chatWorkspace:null,canvasWorkspace:null,codexWorkspace:null,assetsView:null,reverseWorkspace:null,
  };
  vm.createContext(context);
  vm.runInContext(section('const visitedViews=new Set();','async function validateStartupConnection()'),context);
  context.switchView('history');
  assert.equal(history.active,true);
  assert.equal(title.textContent,'历史');
  assert.equal(utilityAttributes.get('aria-current'),'page');
  assert.equal(tabAttributes.get('aria-selected'),'false');
  assert.equal(tab.tabIndex,0);
  assert.deepEqual(calls,['remember:history','history']);
  frame.flush();
  assert.equal(calls.includes('render'),false);
  context.switchView('generate');
  assert.equal(generate.active,true);
  assert.equal(generate.scrollTop,450);
  assert.equal(draft.value,'synthetic draft');
  assert.equal(utilityAttributes.has('aria-current'),false);
  assert.equal(tabAttributes.get('aria-selected'),'true');
  assert.equal(tab.tabIndex,0);
  frame.flush();frame.flush();
  assert.deepEqual(calls,['remember:history','history','remember:generate','generate','render']);
});

test('upload samples coalesce per card and do not mutate a hidden panel',()=>{
  const frame=animationFrame();
  const text={textContent:''},attrs=new Map();
  const card={querySelector:()=>text,getAttribute:key=>attrs.get(key),setAttribute:(key,value)=>attrs.set(key,value)};
  const context={...frame,performance:{now:()=>1000},KIND_LABEL:{video:'视频'},activeView:'generate',document:{visibilityState:'visible'},card};
  vm.createContext(context);
  vm.runInContext(section('const pendingMediaCards = new Map()','function renderMedia()')+"\npendingMediaCards.set('a',card);",context);
  const pending={uiKey:'a',kind:'video',loaded:1,total:100,startedAt:10};
  context.queueMediaProgress(pending);
  pending.loaded=50;
  context.queueMediaProgress(pending);
  assert.equal(frame.frames.size,1);
  frame.flush();
  assert.match(text.textContent,/^50%/);
  context.activeView='history';pending.loaded=100;
  context.queueMediaProgress(pending);frame.flush();
  assert.match(text.textContent,/^50%/);
  context.activeView='generate';context.queueMediaProgress(pending);frame.flush();
  assert.equal(text.textContent,'服务确认中');
  assert.match(attrs.get('aria-label'),/100%/);
});

test('progress-only task changes preserve the existing card structure',()=>{
  const context=vm.createContext({});
  vm.runInContext(section('const taskDisplayFields=','function updateTaskCard('),context);
  const task={key:'fixture',status:'processing',progress:1,result:{local_url:'/fixture.png'}};
  assert.equal(context.sameTaskDisplay(task,{...task,progress:60}),true);
  assert.equal(context.sameTaskDisplay(task,{...task,status:'succeeded'}),false);
  assert.equal(context.sameTaskDisplay(task,{...task,result:{local_url:'/new.png'}}),false);
});

test('a first pending upload creates its card before applying progress and reuses it on updates',()=>{
  const progress={textContent:''},attributes=new Map();
  const list={children:[],append(card){this.children.push(card);},hidden:true};
  const pending={uiKey:'synthetic-upload',kind:'video',name:'fixture.mp4',loaded:20,total:100,startedAt:10};
  const context={state:{media:[],pendingMedia:[pending]},mediaMentionSignature:'',performance:{now:()=>1000},KIND_LABEL:{video:'视频'},
    document:{createElement:()=>({set innerHTML(html){this.content={firstElementChild:{dataset:{mediaKey:pending.uiKey},querySelector:()=>progress,getAttribute:key=>attributes.get(key),setAttribute:(key,value)=>attributes.set(key,value)}};}})},
    $:()=>list,escapeHtml:String,refreshIcons(){},renderMediaLimits(){},updateMentionMenu(){}};
  vm.createContext(context);
  vm.runInContext(section('const pendingMediaCards = new Map()','// ---- 提示词素材引用 ----'),context);
  context.renderMedia();
  assert.equal(list.children.length,1);assert.equal(list.hidden,false);
  assert.match(progress.textContent,/^20%/);
  const first=list.children[0];pending.loaded=75;context.renderMedia();
  assert.equal(list.children[0],first);assert.equal(list.children.length,1);
  assert.match(progress.textContent,/^75%/);
});
