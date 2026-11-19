import test from 'node:test';
import assert from 'node:assert/strict';
import {startVisibleCatalogRefresh} from '../public/catalog-refresh.mjs';

const flush=async()=>{for(let i=0;i<8;i++)await Promise.resolve();};
function fixture({iframe=false,events=false}={}){
  const document=new EventTarget(),window=new EventTarget();document.visibilityState='visible';document.documentElement={};window.top=iframe?{}:window;
  const calls=[],timers=[],streams=[];let now=0,resolve,observer;
  class EventSource extends EventTarget{constructor(url){super();this.url=url;streams.push(this);}close(){this.closed=true;}change(revision){const event=new Event('catalog-change');event.data=JSON.stringify({revision,ignored:'private payload'});this.dispatchEvent(event);}}
  class Observer{constructor(callback){this.callback=callback;observer=this;}observe(target){this.target=target;}disconnect(){this.disconnected=true;}}
  const refresh=startVisibleCatalogRefresh({refresh:()=>{calls.push(now);return new Promise(done=>resolve=done);},events,EventSource,document,window,now:()=>now,Observer,setTimer:(fn,ms)=>{timers.push({fn,ms});return timers.length;},clearTimer:id=>timers[id-1].cleared=true});
  return {document,window,calls,timers,streams,refresh,observer,setNow:value=>now=value,complete:()=>resolve?.(),intersect:value=>observer.callback([{target:document.documentElement,isIntersecting:value,intersectionRatio:value?1:0}])};
}
test('directory refresh waits 60 seconds and shares one request across timer, focus and visibility events',async()=>{
  const f=fixture();assert.equal(f.timers[0].ms,60000);f.setNow(59999);await f.refresh.tick();assert.equal(f.calls.length,0);
  f.setNow(60000);const pending=f.refresh.tick();f.window.dispatchEvent(new Event('focus'));f.document.dispatchEvent(new Event('visibilitychange'));await flush();assert.deepEqual(f.calls,[60000]);
  f.setNow(180000);f.timers[0].fn();await flush();assert.equal(f.calls.length,1);f.complete();await pending;
  const second=f.refresh.tick();await flush();assert.deepEqual(f.calls,[60000,180000]);f.complete();await second;f.refresh.stop();
});
test('hidden top-level windows and CSS-hidden cross-origin iframes do not refresh their directory',async()=>{
  for(const iframe of [false,true]){
    const f=fixture({iframe});f.setNow(60000);if(!iframe)f.document.visibilityState='hidden';f.refresh.tick();await flush();assert.equal(f.calls.length,0);
    if(iframe)f.intersect(true);else{f.document.visibilityState='visible';f.document.dispatchEvent(new Event('visibilitychange'));}
    await flush();assert.equal(f.calls.length,1);f.complete();await flush();f.setNow(120000);f.intersect(false);f.refresh.tick();await flush();assert.equal(f.calls.length,1);
    f.intersect(true);await flush();assert.equal(f.calls.length,2);f.complete();await flush();f.refresh.stop();
  }
});
test('stopping the directory monitor removes listeners and disconnects its iframe observer',async()=>{
  const f=fixture({iframe:true});f.refresh.stop();assert.equal(f.timers[0].cleared,true);assert.equal(f.observer.disconnected,true);
  f.setNow(60000);f.intersect(true);f.window.dispatchEvent(new Event('focus'));f.refresh.tick();await flush();assert.equal(f.calls.length,0);
});

test('revision notifications refresh immediately and merge changes received during one pending directory read',async()=>{
  const f=fixture({events:true});assert.equal(f.streams[0].url,'/api/relay/catalog/events');assert.equal(f.calls.length,0);
  f.streams[0].change('a'.repeat(64));await flush();assert.equal(f.calls.length,1);
  for(let i=0;i<20;i++)f.streams[0].change(i.toString(16).padStart(64,'0'));
  await flush();assert.equal(f.calls.length,1);f.complete();await flush();assert.equal(f.calls.length,2);
  f.complete();await flush();f.streams[0].change((19).toString(16).padStart(64,'0'));await flush();assert.equal(f.calls.length,2);
  f.streams[0].change('unsafe-payload');await flush();assert.equal(f.calls.length,2);f.refresh.stop();assert.equal(f.streams[0].closed,true);
});

test('a hidden iframe closes its local subscription and resumes safely without changing the 60-second fallback',async()=>{
  const f=fixture({events:true,iframe:true});assert.equal(f.streams.length,0);f.intersect(true);assert.equal(f.streams.length,1);
  f.streams[0].change('a'.repeat(64));await flush();f.complete();await flush();
  f.intersect(false);assert.equal(f.streams[0].closed,true);f.setNow(2000);f.intersect(true);assert.equal(f.streams.length,2);
  f.streams[1].change('b'.repeat(64));await flush();assert.equal(f.calls.length,2);f.complete();await flush();
  f.setNow(62000);f.refresh.tick();await flush();assert.equal(f.calls.length,3);f.complete();await flush();f.refresh.stop();
});
