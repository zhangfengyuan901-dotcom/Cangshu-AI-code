import test from 'node:test';
import assert from 'node:assert/strict';
import {installInteractionHost,getInteractionPreferences,setInteractionPreferences,claimMediaPlayback} from '../public/interaction-policy.mjs';

function realm(origin='http://127.0.0.1:12345'){
 const listeners=new Map(),storage=new Map(),sent=[],attrs=new Map();
 const win={location:{origin},document:{documentElement:{setAttribute:(key,value)=>attrs.set(key,value)},addEventListener(){}},localStorage:{getItem:key=>storage.get(key),setItem:(key,value)=>storage.set(key,value)},addEventListener(type,listener){if(!listeners.has(type))listeners.set(type,[]);listeners.get(type).push(listener);},postMessage:(data,target)=>sent.push({data,target}),emit:(type,event={})=>{for(const listener of listeners.get(type)||[])listener(event);}};
 win.parent=win;return {win,sent,attrs,storage};
}
test('preferences persist and combine the app toggle with the system motion preference',()=>{
 const {win,storage,attrs}=realm();win.matchMedia=()=>({matches:true,addEventListener(){}});installInteractionHost({window:win});
 assert.equal(getInteractionPreferences(win).effectiveReducedMotion,true);setInteractionPreferences({hoverVideo:false},win);assert.equal(getInteractionPreferences(win).hoverVideo,false);assert.equal(attrs.get('data-ui-reduced-motion'),'true');
 const saved=JSON.parse([...storage.values()][0]);assert.deepEqual(saved,{hoverVideo:false,reducedMotion:false});
});
test('playback claims stop the previous owner and stale release cannot cancel the new one',()=>{
 const {win}=realm();let a=0,b=0;const old=claimMediaPlayback(win,()=>a++);claimMediaPlayback(win,()=>b++);assert.equal(a,1);old();win.emit('blur');assert.equal(b,1);
});
test('host accepts only current frame source and exact origin, and stops siblings',()=>{
 const {win}=realm(),a=realm('http://127.0.0.1:22222'),b=realm('http://127.0.0.1:33333');
 const frames=[{src:a.win.location.origin+'/chat',contentWindow:a.win},{src:b.win.location.origin+'/',contentWindow:b.win}];installInteractionHost({window:win,getFrames:()=>frames});
 for(const child of [a,b])win.emit('message',{source:child.win,origin:child.win.location.origin,data:{type:'hamster-interaction-policy-v1',action:'ready'}});
 const data={type:'hamster-interaction-policy-v1',action:'claim'};let stops=0;claimMediaPlayback(win,()=>stops++);a.sent.length=b.sent.length=0;
 win.emit('message',{source:a.win,origin:b.win.location.origin,data});assert.equal(stops,0);assert.equal(b.sent.length,0);
 win.emit('message',{source:{},origin:a.win.location.origin,data});assert.equal(stops,0);
 win.emit('message',{source:a.win,origin:a.win.location.origin,data});assert.equal(stops,1);assert.equal(a.sent.length,0);assert.equal(b.sent[0].data.action,'stop');assert.equal(b.sent[0].target,b.win.location.origin);
 setInteractionPreferences({hoverVideo:false},win);assert.equal(a.sent.at(-1).data.preferences.hoverVideo,false);
});
test('child accepts preferences and stop only from its observed loopback parent',()=>{
 const parent=realm(),child=realm('http://127.0.0.1:22222');child.win.parent=parent.win;child.win.location.ancestorOrigins=[parent.win.location.origin];
 let stopped=0;claimMediaPlayback(child.win,()=>stopped++);assert.equal(parent.sent[0].data.action,'ready');assert(parent.sent.every(item=>item.target===parent.win.location.origin));
 const data={type:'hamster-interaction-policy-v1',action:'preferences',preferences:{hoverVideo:false,reducedMotion:true}};
 child.win.emit('message',{source:parent.win,origin:'https://foreign.invalid',data});assert.equal(getInteractionPreferences(child.win).hoverVideo,true);
 child.win.emit('message',{source:parent.win,origin:parent.win.location.origin,data});assert.equal(getInteractionPreferences(child.win).effectiveReducedMotion,true);
 child.win.emit('message',{source:parent.win,origin:parent.win.location.origin,data:{type:data.type,action:'stop'}});assert.equal(stopped,1);
});

test('host waits for a frame readiness handshake before sending messages to a navigating frame',()=>{
 const {win}=realm(),child=realm('http://127.0.0.1:23456');installInteractionHost({window:win,getFrames:()=>[{src:child.win.location.origin+'/',contentWindow:child.win}]});
 claimMediaPlayback(win,()=>{});setInteractionPreferences({hoverVideo:false},win);assert.equal(child.sent.length,0);
 win.emit('message',{source:child.win,origin:child.win.location.origin,data:{type:'hamster-interaction-policy-v1',action:'ready'}});assert.equal(child.sent.length,1);assert.equal(child.sent[0].data.preferences.hoverVideo,false);
});

test('host restores port-independent preferences and serializes subsequent local saves',async()=>{
 const {win}=realm();const writes=[];win.fetch=async(_url,options)=>{if(!options?.method)return {ok:true,json:async()=>({uiPreferences:{hoverVideo:false,reducedMotion:true}})};writes.push(JSON.parse(options.body));return {ok:true};};
 const host=installInteractionHost({window:win});await host.ready;assert.equal(getInteractionPreferences(win).hoverVideo,false);assert.equal(getInteractionPreferences(win).reducedMotion,true);
 setInteractionPreferences({hoverVideo:true},win);setInteractionPreferences({reducedMotion:false},win);await host.queue;assert.deepEqual(writes,[{hoverVideo:true,reducedMotion:true},{hoverVideo:true,reducedMotion:false}]);
});
