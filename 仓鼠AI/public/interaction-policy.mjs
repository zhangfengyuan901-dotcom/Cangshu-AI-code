const contexts=new WeakMap(),storageKey='hamster-interaction-preferences-v1';
const messageType='hamster-interaction-policy-v1';
let sequence=0;
const clean=value=>({hoverVideo:value?.hoverVideo!==false,reducedMotion:value?.reducedMotion===true});
function localOrigin(value){try{const url=new URL(value);return url.protocol==='http:'&&['127.0.0.1','localhost'].includes(url.hostname)&&!url.username&&!url.password?url.origin:null;}catch{return null;}}
function context(win=globalThis.window){
 if(!win)return null;if(contexts.has(win))return contexts.get(win);
 let prefs;try{prefs=JSON.parse(win.localStorage?.getItem(storageKey)||'null');}catch{}
 const state={win,prefs:clean(prefs),listeners:new Set(),active:null,getFrames:()=>[],parentOrigin:null,readyFrames:new WeakMap()};contexts.set(win,state);
 const parent=win.parent&&win.parent!==win?win.parent:null;
 if(parent)state.parentOrigin=localOrigin(win.location?.ancestorOrigins?.[0]||win.document?.referrer);
 const motion=win.matchMedia?.('(prefers-reduced-motion: reduce)');state.motion=motion;
 state.send=(target,origin,action,extra={})=>{try{target?.postMessage({type:messageType,action,...extra},origin);}catch{}};
 state.frames=()=>Array.from(state.getFrames()||[]).flatMap(frame=>{try{const origin=localOrigin(frame.src);return origin&&frame.contentWindow?[{window:frame.contentWindow,origin}]:[];}catch{return [];}});
 state.stop=()=>{const previous=state.active;state.active=null;try{previous?.stop();}catch{}};
 state.publish=()=>{
  const value=getInteractionPreferences(win),root=win.document?.documentElement;
  root?.setAttribute('data-ui-reduced-motion',String(value.effectiveReducedMotion));
  for(const listener of state.listeners)listener(value);
  try{if(win.CustomEvent)win.dispatchEvent(new win.CustomEvent('hamster-interaction-preferences',{detail:value}));}catch{}
 };
 state.broadcast=(action,except,extra)=>{for(const frame of state.frames())if(frame.window!==except&&state.readyFrames.get(frame.window)===frame.origin)state.send(frame.window,frame.origin,action,extra);};
 win.addEventListener?.('message',event=>{
  const data=event.data;if(!data||data.type!==messageType)return;
  if(parent){
   if(event.source!==parent||event.origin!==state.parentOrigin)return;
   if(data.action==='preferences'){state.prefs=clean(data.preferences);state.publish();}
   else if(data.action==='stop')state.stop();
   return;
  }
  const frame=state.frames().find(frame=>frame.window===event.source&&frame.origin===event.origin);if(!frame)return;
  if(data.action==='ready'){state.readyFrames.set(frame.window,frame.origin);state.send(frame.window,frame.origin,'preferences',{preferences:state.prefs});}
  else if(data.action==='claim'&&state.readyFrames.get(frame.window)===frame.origin){state.stop();state.broadcast('stop',frame.window);}
 });
 motion?.addEventListener?.('change',()=>state.publish());
 win.addEventListener?.('storage',event=>{if(event.key===storageKey&&!parent){try{state.prefs=clean(JSON.parse(event.newValue));}catch{state.prefs=clean(null);}state.publish();state.broadcast('preferences',null,{preferences:state.prefs});}});
 win.addEventListener?.('pagehide',()=>state.stop());
 win.addEventListener?.('blur',()=>state.stop());
 win.document?.addEventListener?.('visibilitychange',()=>{if(win.document.visibilityState==='hidden')state.stop();});
 // Native titles and visible focus use one rule without allocating a tooltip per row.
 const describe=event=>{const item=event.target?.closest?.('button[aria-label],a[aria-label],.task-prompt,.media-name,.file-name');if(item&&!item.hasAttribute('title'))item.setAttribute('title',item.getAttribute('aria-label')||item.textContent||'');};
 win.document?.addEventListener?.('pointerover',describe);win.document?.addEventListener?.('focusin',describe);
 state.publish();if(parent&&state.parentOrigin)state.send(parent,state.parentOrigin,'ready');return state;
}
export function getInteractionPreferences(win=globalThis.window){const state=context(win);return {...(state?.prefs||clean(null)),effectiveReducedMotion:Boolean(state?.prefs.reducedMotion||state?.motion?.matches),loading:state?.serverLoading===true,saveError:state?.saveError===true};}
export function observeInteractionPreferences(listener,win=globalThis.window){const state=context(win);state?.listeners.add(listener);return()=>state?.listeners.delete(listener);}
export function setInteractionPreferences(value,win=globalThis.window){
 const state=context(win);if(!state||win.parent&&win.parent!==win)return;
 state.prefs=clean({...state.prefs,...value});state.revision=(state.revision||0)+1;try{win.localStorage?.setItem(storageKey,JSON.stringify(state.prefs));}catch{}
 state.publish();state.broadcast('preferences',null,{preferences:state.prefs});state.save?.();return getInteractionPreferences(win);
}
export function installInteractionHost({getFrames=()=>[],window=globalThis.window}={}){
 const state=context(window);if(!state)return state;state.getFrames=getFrames;
 if(window.fetch&&!state.ready){
  state.serverLoading=true;const revision=state.revision||0;
  state.ready=window.fetch('/api/interaction-preferences',{cache:'no-store'}).then(async response=>{if(!response.ok)throw Error('preferences_unavailable');const value=(await response.json()).uiPreferences;if(typeof value?.hoverVideo!=='boolean'||typeof value?.reducedMotion!=='boolean')throw Error('preferences_invalid');if((state.revision||0)===revision)state.prefs=clean(value);}).catch(()=>{state.saveError=true;}).finally(()=>{state.serverLoading=false;state.publish();state.broadcast('preferences',null,{preferences:state.prefs});});
  state.queue=state.ready;state.save=()=>{const preferences={...state.prefs};state.queue=state.queue.catch(()=>{}).then(()=>window.fetch('/api/interaction-preferences',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(preferences),keepalive:true})).then(response=>{if(!response.ok)throw Error('preferences_save');state.saveError=false;}).catch(()=>{state.saveError=true;}).finally(()=>state.publish());};
  state.publish();
 }
 return state;
}
export function claimMediaPlayback(win,stop){
 const state=context(win);if(!state)return()=>{};state.stop();const token=++sequence;state.active={token,stop};
 if(state.parentOrigin)state.send(win.parent,state.parentOrigin,'claim');else state.broadcast('stop');
 return()=>{if(state.active?.token===token)state.active=null;};
}
export function mountInteractionSettings(host){
 if(!host||host.querySelector?.('[data-interaction-settings]'))return;
 const doc=host.ownerDocument,win=doc.defaultView,field=doc.createElement('fieldset');field.className='interaction-settings';field.setAttribute('data-interaction-settings','');
 const title=doc.createElement('legend');title.textContent='界面交互';field.append(title);
 const controls={};for(const [key,label]of [['hoverVideo','鼠标悬停时静音预览视频'],['reducedMotion','减少界面动画']]){
  const row=doc.createElement('label'),input=doc.createElement('input'),text=doc.createElement('span');input.type='checkbox';input.name=key;input.setAttribute('data-interaction-preference',key);text.textContent=label;row.append(input,text);field.append(row);controls[key]=input;
  input.addEventListener('change',()=>setInteractionPreferences({[key]:input.checked},win));
 }
 const note=doc.createElement('p');note.textContent='设置适用于全部功能页。开启减少动画，或系统要求减少动态效果时，视频改为点击播放。';field.append(note);
 const sync=value=>{for(const key of Object.keys(controls)){controls[key].checked=value[key];controls[key].disabled=value.loading;}note.textContent=value.saveError?'设置尚未保存，请稍后重新设置。':'设置适用于全部功能页。开启减少动画，或系统要求减少动态效果时，视频改为点击播放。';note.setAttribute('role',value.saveError?'alert':'status');};sync(getInteractionPreferences(win));observeInteractionPreferences(sync,win);host.append(field);
}
