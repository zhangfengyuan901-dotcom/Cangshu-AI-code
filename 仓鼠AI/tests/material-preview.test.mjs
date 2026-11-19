import test from 'node:test';
import assert from 'node:assert/strict';
import {safeMaterialPreviewUrl,materialPreviewPosition,mountMaterialPreview} from '../public/material-preview.mjs';
import {setInteractionPreferences} from '../public/interaction-policy.mjs';

test('preview sources stay on the current local origin or its blob URLs',()=>{
 const origin='http://127.0.0.1:12000';
 assert.equal(safeMaterialPreviewUrl('/api/assets/fixture/file',origin),origin+'/api/assets/fixture/file');
 assert.equal(safeMaterialPreviewUrl('blob:'+origin+'/fixture',origin),'blob:'+origin+'/fixture');
 for(const value of ['https://other.test/a.png','http://127.0.0.1:12001/file','blob:http://127.0.0.1:12001/id','javascript:alert(1)','data:image/svg+xml,<svg/>','file:///private/image.png','http://user:password@127.0.0.1:12000/image',null,'x'.repeat(8193)])assert.equal(safeMaterialPreviewUrl(value,origin),null);
});
test('floating previews flip at the right edge and clamp inside the viewport',()=>{
 const size={width:320,height:280},viewport={width:900,height:600};
 assert.deepEqual(materialPreviewPosition({left:50,right:140,top:50,bottom:140},size,viewport),{left:152,top:50});
 assert.deepEqual(materialPreviewPosition({left:800,right:890,top:500,bottom:590},size,viewport),{left:468,top:308});
 const edge=materialPreviewPosition({left:5,right:95,top:5,bottom:95},{width:600,height:550},viewport);
 assert(edge.left>=12&&edge.left+600<=888&&edge.top>=12&&edge.top+550<=588);
});

class Element {
 constructor(tag,document){this.tagName=tag;this.ownerDocument=document;this.children=[];this.attributes=new Map();this.listeners=new Map();this.style={};this.isConnected=true;this.hidden=false;this.rect={left:30,right:120,top:100,bottom:190,width:90,height:90};}
 append(...nodes){for(const node of nodes){node.parent=this;this.children.push(node);}}
 remove(){this.isConnected=false;if(this.parent)this.parent.children=this.parent.children.filter(child=>child!==this);}
 contains(node){return node===this||this.children.some(child=>child.contains(node));}
 closest(selector){return this.attributes.has(selector.slice(1,-1))?this:this.parent?.closest(selector);}
 setAttribute(name,value){this.attributes.set(name,String(value));}getAttribute(name){return this.attributes.get(name)||null;}removeAttribute(name){this.attributes.delete(name);}hasAttribute(name){return this.attributes.has(name);}
 get src(){return this.attributes.get('src');}set src(value){this.setAttribute('src',value);}
 pause(){this.paused=true;this.pauses=(this.pauses||0)+1;}load(){this.loads=(this.loads||0)+1;}play(){this.paused=false;this.plays=(this.plays||0)+1;return Promise.resolve();}
 addEventListener(type,callback){if(!this.listeners.has(type))this.listeners.set(type,new Set());this.listeners.get(type).add(callback);}
 removeEventListener(type,callback){this.listeners.get(type)?.delete(callback);}
 emit(type,extra={}){const event={target:this,preventDefault(){this.defaultPrevented=true;},...extra};for(const callback of this.listeners.get(type)||[])callback(event);return event;}
 getBoundingClientRect(){return this.className==='material-hover-preview'?{width:320,height:280}:this.rect;}
 showModal(){this.previousFocus=this.ownerDocument.activeElement;this.open=true;}
 close(){this.open=false;const previous=this.previousFocus;this.previousFocus=null;if(previous?.isConnected)previous.focus();this.onNativeClose?.();}
 focus(){this.ownerDocument.activeElement=this;this.parent?.emit('focusin',{target:this});}
}
function fixture(options={}){
 const document=new Element('document');document.visibilityState='visible';document.createElement=tag=>new Element(tag,document);document.body=new Element('body',document);
 const window=new Element('window',document);window.location={origin:'http://127.0.0.1:12000'};window.innerWidth=900;window.innerHeight=600;document.defaultView=window;
 const container=new Element('section',document),button=new Element('button',document);button.setAttribute('data-material-preview','');container.append(button);document.body.append(container);
 const timers=new Map(),delays=[];let id=0,item={src:'/api/assets/fixture/file',name:'Synthetic.png'};
 const preview=mountMaterialPreview(container,{resolve:()=>item,document,window,setTimer:(fn,delay)=>{delays.push(delay);timers.set(++id,fn);return id;},clearTimer:key=>timers.delete(key),...options});
 const popup=document.body.children.find(child=>child.className==='material-hover-preview'),modal=document.body.children.find(child=>child.className==='material-image-dialog');
 return {document,window,container,button,popup,modal,preview,timers,delays,setItem:value=>{item=value;},flush(){const callbacks=[...timers.values()];timers.clear();callbacks.forEach(fn=>fn());}};
}
test('hover delays coalesce and movement into the preview preserves the popup',()=>{
 const f=fixture();f.container.emit('pointerover',{target:f.button,pointerType:'mouse'});assert(f.popup.hidden);assert.equal(f.timers.size,1);f.flush();assert.equal(f.popup.hidden,false);
 f.container.emit('pointerout',{target:f.button,relatedTarget:f.popup});assert.equal(f.timers.size,0);
 f.popup.emit('pointerleave',{relatedTarget:null});assert.equal(f.timers.size,1);f.flush();assert(f.popup.hidden);f.preview.destroy();
});
test('a rapid exit cancels pending hover without loading the image',()=>{
 const f=fixture();f.container.emit('pointerover',{target:f.button,pointerType:'mouse'});f.container.emit('pointerout',{target:f.button,relatedTarget:null});f.flush();assert(f.popup.hidden);assert.equal(f.popup.children[0].src,undefined);f.preview.destroy();
});
test('keyboard focus previews; Escape closes the modal without reopening on restored focus',()=>{
 const f=fixture();f.button.focus();f.flush();assert.equal(f.popup.hidden,false);
 f.container.emit('click',{target:f.button});assert.equal(f.modal.open,true);assert(f.popup.hidden);
 f.document.emit('keydown',{key:'Escape'});assert.equal(f.modal.open,false);assert.equal(f.document.activeElement,f.button);assert(f.popup.hidden);assert.equal(f.timers.size,0);f.preview.destroy();
});

test('the close button suppresses native synchronous focus restoration before it can schedule hover again',()=>{
 const f=fixture();f.button.focus();f.container.emit('click',{target:f.button});assert.equal(f.modal.open,true);
 f.modal.children.find(child=>child.className==='material-image-close').onclick();
 assert.equal(f.modal.open,false);assert.equal(f.document.activeElement,f.button);assert.equal(f.timers.size,0);f.flush();assert(f.popup.hidden);f.preview.destroy();
});

test('Escape suppresses native pointer reentry until the source is actually left',()=>{
 const f=fixture(),child=new Element('span',f.document);f.button.append(child);f.button.focus();f.container.emit('click',{target:f.button});
 f.modal.onNativeClose=()=>f.container.emit('pointerover',{target:f.button,pointerType:'mouse'});
 f.document.emit('keydown',{key:'Escape'});assert.equal(f.modal.open,false);assert.equal(f.document.activeElement,f.button);assert.equal(f.timers.size,0);
 f.container.emit('pointerout',{target:f.button,relatedTarget:child});f.container.emit('pointerover',{target:child,pointerType:'mouse'});f.flush();assert(f.popup.hidden);
 f.container.emit('pointerout',{target:f.button,relatedTarget:null});f.container.emit('pointerover',{target:f.button,pointerType:'mouse'});f.flush();assert.equal(f.popup.hidden,false);f.preview.destroy();
});

test('custom dialogs can suppress a pointer source without blocking deliberate keyboard focus',()=>{
 const f=fixture({onOpen(){}});f.container.emit('pointerover',{target:f.button,pointerType:'mouse'});assert.equal(f.timers.size,1);
 f.preview.suppressPointer(f.button);assert.equal(f.timers.size,0);f.container.emit('pointerover',{target:f.button,pointerType:'mouse'});f.flush();assert(f.popup.hidden);
 f.container.emit('focusin',{target:f.button});f.flush();assert.equal(f.popup.hidden,false);f.preview.hide();
 f.container.emit('focusout',{target:f.button,relatedTarget:null});f.container.emit('pointerover',{target:f.button,pointerType:'mouse'});f.flush();assert(f.popup.hidden);
 f.container.emit('pointerout',{target:f.button,relatedTarget:null});f.container.emit('pointerover',{target:f.button,pointerType:'mouse'});f.flush();assert.equal(f.popup.hidden,false);f.preview.destroy();
});

test('closing with the pointer elsewhere allows the first deliberate source entry',()=>{
 const f=fixture();f.button.focus();f.container.emit('click',{target:f.button});
 f.modal.onNativeClose=()=>f.document.emit('pointerover',{target:f.document.body,pointerType:'mouse'});
 f.modal.children.find(child=>child.className==='material-image-close').onclick();assert(f.popup.hidden);assert.equal(f.timers.size,0);
 f.container.emit('pointerover',{target:f.button,pointerType:'mouse'});f.flush();assert.equal(f.popup.hidden,false);f.preview.destroy();assert.equal(f.document.listeners.get('pointerover').size,0);
});

test('removing or replacing the source of an open image dialog closes it and clears its image',()=>{
 for(const change of ['remove','replace']){
  const f=fixture();f.button.focus();f.container.emit('click',{target:f.button});assert.equal(f.modal.open,true);
  const image=f.modal.children.find(child=>child.className==='material-image-full');assert(image.hasAttribute('src'));
  if(change==='remove'){f.setItem(null);f.button.remove();}else f.setItem({src:'/api/assets/replacement/file',name:'replacement.png'});
  f.preview.refresh();assert.equal(f.modal.open,false,change);assert.equal(image.hasAttribute('src'),false,change);assert.equal(f.timers.size,0,change);f.preview.destroy();
 }
});
test('removed or changed source items close stale previews and clear their description',()=>{
 const f=fixture();f.container.emit('focusin',{target:f.button});f.flush();assert(f.button.getAttribute('aria-describedby'));
 f.setItem({src:'/api/assets/replacement/file',name:'next.png'});f.preview.refresh();assert(f.popup.hidden);assert.equal(f.button.getAttribute('aria-describedby'),null);
 f.container.emit('focusin',{target:f.button});f.flush();f.button.isConnected=false;f.preview.refresh();assert(f.popup.hidden);f.preview.destroy();
});
test('click callbacks use current state and page changes close an open preview',()=>{
 const calls=[],f=fixture({onOpen:item=>calls.push(item.src)});f.setItem({src:'/api/assets/new/file'});f.container.emit('click',{target:f.button});assert.deepEqual(calls,['http://127.0.0.1:12000/api/assets/new/file']);
 f.container.emit('focusin',{target:f.button});f.flush();f.window.emit('hamster-view-changed');assert(f.popup.hidden);f.preview.destroy();assert.equal(f.container.listeners.get('pointerover').size,0);
});
test('load failure shows a fixed message and touch does not start hover',()=>{
 const f=fixture();f.container.emit('pointerover',{target:f.button,pointerType:'touch'});assert.equal(f.timers.size,0);
 f.container.emit('focusin',{target:f.button});f.flush();f.popup.children[0].onerror();assert.equal(f.popup.children[1].hidden,false);assert.equal(f.popup.children[1].textContent,'图片暂时无法预览');f.preview.destroy();
});

test('video hover waits 350ms, plays muted and releases its source on exit',()=>{
 const f=fixture();f.setItem({src:'/api/assets/video/file',name:'Synthetic.mp4',kind:'video'});
 const video=f.popup.children.find(child=>child.tagName==='video');assert.equal(video.src,undefined);
 f.container.emit('pointerover',{target:f.button,pointerType:'mouse'});assert.equal(f.delays.at(-1),350);assert.equal(video.src,undefined);f.flush();
 assert.equal(video.muted,true);assert.equal(video.loop,true);assert.equal(video.plays,1);assert.equal(f.popup.hidden,false);
 f.preview.hide();assert.equal(video.src,undefined);assert.equal(video.paused,true);f.preview.destroy();
});

test('disabling hover playback and reduced motion stop active video without fetching another one',()=>{
 const f=fixture();f.setItem({src:'/api/assets/video/file',kind:'video'});f.button.focus();f.flush();const video=f.popup.children.find(child=>child.tagName==='video');
 setInteractionPreferences({hoverVideo:false},f.window);assert(f.popup.hidden);assert.equal(video.src,undefined);
 f.button.focus();f.flush();assert(f.popup.hidden);assert.equal(video.plays,1);
 setInteractionPreferences({hoverVideo:true,reducedMotion:true},f.window);f.button.focus();f.flush();assert(f.popup.hidden);
 f.container.emit('click',{target:f.button});assert(f.modal.open);assert.equal(f.modal.children.find(child=>child.className.includes('material-full-video')).src,'http://127.0.0.1:12000/api/assets/video/file');f.preview.close();assert.equal(f.modal.open,false);f.preview.destroy();
});

test('audio metadata hover does not fetch or play; explicit clicks expose the controlled player',()=>{
 const f=fixture();f.setItem({src:'/api/assets/audio/file',name:'Synthetic.wav',kind:'audio',detail:'音频 · 2 秒'});f.button.focus();f.flush();
 for(const child of f.popup.children)assert.equal(child.src,undefined);assert.equal(f.popup.children.find(child=>child.className==='material-hover-detail').textContent,'音频 · 2 秒');
 f.container.emit('click',{target:f.button});const audio=f.modal.children.find(child=>child.tagName==='audio');assert.equal(audio.controls,true);assert.equal(audio.plays,undefined);assert(audio.src);f.preview.close();assert.equal(audio.src,undefined);f.preview.destroy();
});

test('only one controller owns a visible hover preview within the document',()=>{
 const f=fixture(),other=new Element('button',f.document);other.setAttribute('data-other-preview','');f.container.append(other);
 const second=mountMaterialPreview(f.container,{selector:'[data-other-preview]',resolve:()=>({src:'/api/assets/other/file'}),document:f.document,window:f.window,setTimer:fn=>{fn();return null;}});
 f.button.focus();f.flush();assert.equal(f.popup.hidden,false);other.focus();assert(f.popup.hidden);second.destroy();f.preview.destroy();
});
