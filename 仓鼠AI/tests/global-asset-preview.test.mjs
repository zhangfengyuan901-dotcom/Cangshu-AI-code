import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const code=fs.readFileSync(new URL('../public/asset-library.mjs',import.meta.url),'utf8').replace(/^import .*;\r?\n/gm,'').replaceAll('export function ','function ');
const flush=async()=>{for(let i=0;i<12;i++)await Promise.resolve();};
function fixture(){
 const frames=[],calls={close:0,refresh:0,destroy:0,selected:[],writes:0},document={};let mounted;
 class Element{
  constructor(tag){this.tagName=tag.toUpperCase();this.children=[];this.dataset={};this.style={};this.attributes=new Map();this.className='';this.textContent='';this.value='';this.ownerDocument=document;this.events=new Map();this.paused=true;}
  get classList(){const node=this;return {add(...names){node.className=[...new Set([...node.className.split(' '),...names])].filter(Boolean).join(' ');},remove(...names){node.className=node.className.split(' ').filter(value=>!names.includes(value)).join(' ');},toggle(name,on){if(on)this.add(name);else this.remove(name);},contains:name=>node.className.split(' ').includes(name)};}
  append(...nodes){for(const node of nodes){node.remove();this.children.push(node);node.parentNode=this;}}
  prepend(node){node.remove();this.children.unshift(node);node.parentNode=this;}
  insertBefore(node,next){node.remove();this.children.splice(next?this.children.indexOf(next):this.children.length,0,node);node.parentNode=this;}
  remove(){if(this.parentNode){const at=this.parentNode.children.indexOf(this);if(at>=0)this.parentNode.children.splice(at,1);this.parentNode=null;}}
  replaceChildren(...nodes){for(const node of [...this.children])node.remove();this.append(...nodes);}
  replaceWith(node){const parent=this.parentNode;parent?.insertBefore(node,this);this.remove();}
  get firstElementChild(){return this.children[0]||null;}
  get nextElementSibling(){return this.parentNode?.children[this.parentNode.children.indexOf(this)+1]||null;}
  matches(selector){if(selector.startsWith('.'))return this.classList.contains(selector.slice(1));if(selector==='[data-preview-src]')return this.dataset.previewSrc!==undefined;if(selector==='[data-asset-id]')return this.dataset.assetId!==undefined;return selector.split(',').some(tag=>this.tagName===tag.trim().toUpperCase());}
  closest(selector){for(let node=this;node;node=node.parentNode)if(node.matches(selector))return node;return null;}
  querySelectorAll(selector){if(selector.startsWith(':scope > '))return this.children.filter(node=>node.matches(selector.slice(9)));return this.children.flatMap(node=>[...(node.matches(selector)?[node]:[]),...node.querySelectorAll(selector)]);}
  setAttribute(name,value){this.attributes.set(name,value);}
  addEventListener(name,listener){this.events.set(name,listener);}
  removeEventListener(name){this.events.delete(name);}
  pause(){this.paused=true;}
 }
 document.createElement=tag=>new Element(tag);document.activeElement=null;
 const container=new Element('div'),items=[{id:'image',name:'scene.png',kind:'image',category:'talent',size:100},{id:'video',name:'clip.mp4',kind:'video',category:'talent',size:200},{id:'audio',name:'voice.mp3',kind:'audio',category:'talent',size:300}];let uploadDone;
 const context={document,Response,console,fetch:async(_url,options)=>{if(options?.method==='POST'){calls.writes++;await new Promise(resolve=>{uploadDone=resolve;});}return Response.json({items,root:'Synthetic fixture'});},requestAnimationFrame:fn=>{frames.push(fn);return frames.length;},cancelAnimationFrame(){},
  mountMaterialPreview(grid,options){mounted={grid,...options};return {refresh(){calls.refresh++;},close(){calls.close++;},destroy(){calls.destroy++;}};}};
 vm.createContext(context);vm.runInContext(code,context);const api=context.assetLibrary(container,{base:'/api/assets-fixture',onSelect:item=>calls.selected.push(item.id)});
 return {container,items,api,calls,get preview(){return mounted;},frame(){for(const callback of frames.splice(0))callback();},completeUpload(){uploadDone?.();}};
}
test('asset image, video and audio covers share preview resolution while selection remains a separate action',async()=>{
 const f=fixture();await flush();f.frame();const cards=f.preview.grid.querySelectorAll('.asset-card');assert.equal(cards.length,3);
 for(const [index,card]of cards.entries()){
  const cover=card.children[0],item=f.items[index];assert.equal(cover.tagName,'BUTTON');assert.equal(cover.dataset.assetPreview,'');
  const entry=f.preview.resolve(cover);assert.equal(entry.kind,item.kind);assert.equal(entry.name,item.name);assert.equal(entry.src,'/api/assets-fixture/'+item.id+'/file');
  if(item.kind==='video'){const video=cover.children[0];assert.equal(video.preload,'none');assert.equal(video.muted,true);assert.equal(video.playsInline,true);assert.equal(video.controls,undefined);}
  if(item.kind==='audio')assert.equal(cover.querySelectorAll('audio').length,0,'hover metadata does not load an audio element');
 }
 assert.equal(f.calls.selected.length,0);cards[1].children.find(node=>node.textContent==='使用此资产').onclick();assert.deepEqual(f.calls.selected,['video']);
 const first=cards[0];f.api.setVisible(false);assert.equal(f.calls.close,1);assert.equal(f.preview.resolve(first.children[0]),null);
 f.api.dispose();assert.equal(f.calls.destroy,1);
});
test('asset refresh retains cover nodes and removed asset resolvers become invalid',async()=>{
 const f=fixture();await flush();f.frame();const card=f.preview.grid.querySelectorAll('.asset-card')[0],cover=card.children[0];
 await f.api.refresh(true);f.frame();assert.equal(f.preview.grid.querySelectorAll('.asset-card')[0],card);assert.equal(card.children[0],cover);
 f.items.splice(0,1);await f.api.refresh(true);f.frame();assert.equal(f.preview.resolve(cover),null);assert(f.calls.refresh>=3);
});
test('repeated file drops during an active local import do not start duplicate writes',async()=>{
 const f=fixture();await flush();f.frame();const event={preventDefault(){},dataTransfer:{files:[{name:'fixture.png',size:100,type:'image/png'}]}};
 f.container.ondrop(event);f.container.ondrop(event);await flush();assert.equal(f.calls.writes,1);f.completeUpload();await flush();f.frame();
});
