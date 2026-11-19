import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {createStorageStatusController,storageStatusKind,storageStatusView} from '../public/storage-status.mjs';

const flush=async()=>{for(let count=0;count<16;count++)await Promise.resolve();};
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
function clock(){
  let now=1800000000000,id=0;const timers=new Map();
  return {now:()=>now,setTimer:(callback,delay)=>{timers.set(++id,{callback,at:now+delay});return id;},clearTimer:key=>timers.delete(key),
    async advance(delay){const end=now+delay;for(let rounds=0;rounds<200;rounds++){const due=[...timers].filter(([,item])=>item.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];if(!due)break;now=due[1].at;timers.delete(due[0]);due[1].callback();await flush();}now=end;await flush();},count:()=>timers.size};
}
function fixture(){
  const time=clock(),calls=[],changes=[],responses=new Map();
  const controller=createStorageStatusController({...time,onChange:value=>changes.push(value),request:(kind,{signal})=>{
    calls.push({kind,signal});const queued=responses.get(kind)?.shift();
    if(queued instanceof Error)return Promise.reject(queued);
    return queued??{kind,state:'ready',connected:true,httpStatus:200,checkedAt:new Date(time.now()).toISOString()};
  }});
  return {time,calls,changes,controller,queue:(kind,...items)=>responses.set(kind,[...(responses.get(kind)||[]),...items])};
}

test('functional mapping does not probe a media Key from chat or unrelated pages',()=>{
  assert.equal(storageStatusKind('generate','video'),'video');assert.equal(storageStatusKind('generate','official-video'),'video');
  assert.equal(storageStatusKind('generate','image'),'image');assert.equal(storageStatusKind('digital','video'),'tool');assert.equal(storageStatusKind('depth','image'),'tool');
  for(const view of ['chat','canvas','account','history','assets'])assert.equal(storageStatusKind(view,'video'),null);
  assert.deepEqual(storageStatusView({kind:null}),{state:'idle',label:'素材权限不适用',checking:false});
});

test('100 same-kind video selections and focus events cause no additional permission request',async()=>{
  const f=fixture();await f.controller.select('video');
  for(let index=0;index<100;index++){await f.controller.select(storageStatusKind('generate',index%2?'video':'official-video'));await f.controller.wake();}
  assert.equal(f.calls.length,1);assert.equal(f.controller.snapshot().state,'ready');
  await f.time.advance(299999);assert.equal(f.calls.length,1);
  await f.time.advance(1);assert.equal(f.calls.length,2);f.controller.stop();
});

test('image rate limiting cannot contaminate the independent ready video state',async()=>{
  const f=fixture();f.queue('image',{kind:'image',state:'rate_limited',connected:false,httpStatus:429,retryAfterMs:60000});
  await f.controller.select('image');assert.equal(storageStatusView(f.controller.snapshot()).state,'pending');
  await f.controller.select('video');assert.equal(f.controller.snapshot().state,'ready');
  assert.equal(f.controller.snapshot('image').state,'rate_limited');assert.deepEqual(f.calls.map(call=>call.kind),['image','video']);
  await f.controller.select('image');await f.controller.select('video');assert.equal(f.calls.length,2);f.controller.stop();
});

test('an old-kind response is cached without replacing the currently selected light',async()=>{
  const f=fixture(),late=deferred();f.queue('video',late.promise);
  const pending=f.controller.select('video');await flush();await f.controller.select('image');
  late.resolve({kind:'video',state:'forbidden',connected:false,httpStatus:403});await pending;
  assert.equal(f.controller.snapshot().kind,'image');assert.equal(f.controller.snapshot().state,'ready');
  assert.equal(f.changes.at(-1).kind,'image');assert.equal(f.controller.snapshot('video').state,'forbidden');f.controller.stop();
});

test('configuration reset aborts pending reads and discards old account state, success time and cooldown',async()=>{
  const f=fixture(),late=deferred();f.queue('video',late.promise);
  const pending=f.controller.select('video');await flush();f.controller.reset();
  assert.equal(f.calls[0].signal.aborted,true);assert.equal(f.controller.snapshot('video').lastSuccessAt,null);
  await f.controller.select('video');late.resolve({kind:'video',state:'forbidden',connected:false,httpStatus:403});await pending;
  assert.equal(f.controller.snapshot().state,'ready');assert.equal(f.calls.length,2);
  f.controller.reset();await flush();assert.equal(f.time.count(),0);assert.equal(f.controller.snapshot('video').cooldownUntil,0);f.controller.stop();
});

test('503 becomes pending, does not turn red and recovers with bounded read-only retry',async()=>{
  const f=fixture();f.queue('video',{kind:'video',state:'pending',connected:false,httpStatus:503});
  await f.controller.select('video');assert.equal(storageStatusView(f.controller.snapshot()).state,'pending');
  await f.controller.check({manual:true});await f.time.advance(9999);assert.equal(f.calls.length,1);
  await f.time.advance(1);assert.equal(f.calls.length,2);assert.equal(storageStatusView(f.controller.snapshot()).state,'ready');f.controller.stop();
});

test('transient retries use 10, 20, 40 and then 60 second delays',async()=>{
  const f=fixture();for(let index=0;index<5;index++)f.queue('video',new Error('synthetic network failure'));
  await f.controller.select('video');
  for(const delay of [10000,20000,40000,60000]){const count=f.calls.length;await f.time.advance(delay-1);assert.equal(f.calls.length,count);await f.time.advance(1);assert.equal(f.calls.length,count+1);}
  f.controller.stop();
});

test('401, 403, account mismatch and unconfigured state do not start recurring retries',async()=>{
  for(const [state,status,display] of [['unauthorized',401,'failed'],['forbidden',403,'failed'],['account_mismatch',409,'failed'],['unconfigured',401,'idle']]){
    const f=fixture();f.queue('video',{kind:'video',state,connected:false,httpStatus:status});await f.controller.select('video');
    assert.equal(storageStatusView(f.controller.snapshot()).state,display);await f.controller.wake();
    await f.time.advance(1800000);assert.equal(f.calls.length,1);f.controller.stop();
  }
});

test('manual requests respect authentication cooldown without scheduling an automatic retry',async()=>{
  const f=fixture();f.queue('video',{kind:'video',state:'unauthorized',connected:false,httpStatus:401,retryAfterMs:30000});
  await f.controller.select('video');await f.controller.check({manual:true});assert.equal(f.calls.length,1);
  await f.time.advance(30000);assert.equal(f.calls.length,1);await f.controller.check({manual:true});assert.equal(f.calls.length,2);f.controller.stop();
});

test('Retry-After survives selection changes and cannot be bypassed by manual checks or focus',async()=>{
  const f=fixture();f.queue('video',{kind:'video',state:'rate_limited',connected:false,httpStatus:429,retryAfterMs:90000});
  await f.controller.select('video');await f.controller.select('image');await f.controller.select('video');
  await f.controller.check({manual:true});await f.controller.wake();assert.equal(f.calls.length,2);
  await f.time.advance(89999);assert.equal(f.calls.length,2);await f.time.advance(1);assert.equal(f.calls.length,3);f.controller.stop();
});

test('excessive retry values are bounded to one hour',async()=>{
  const f=fixture();f.queue('video',{kind:'video',state:'rate_limited',connected:false,httpStatus:429,retryAfterMs:Number.MAX_SAFE_INTEGER});
  await f.controller.select('video');assert.equal(f.controller.snapshot().cooldownUntil-f.time.now(),3600000);f.controller.stop();
});

test('hidden pages stop retry timers and return to one merged read when visible and due',async()=>{
  const f=fixture();f.queue('video',{kind:'video',state:'pending',connected:false,httpStatus:503});await f.controller.select('video');
  f.controller.setVisible(false);await f.time.advance(60000);assert.equal(f.calls.length,1);
  f.controller.setVisible(true);const first=f.controller.wake(),second=f.controller.check();await Promise.all([first,second]);
  assert.equal(f.calls.length,2);assert.equal(f.controller.snapshot().state,'ready');f.controller.stop();
});

test('a hung local read is cancelled at 25 seconds and a late reply cannot restore green',async()=>{
  const f=fixture(),late=deferred();f.queue('video',late.promise);const pending=f.controller.select('video');await flush();
  await f.time.advance(24999);assert.equal(f.calls[0].signal.aborted,false);await f.time.advance(1);await pending;
  assert.equal(f.calls[0].signal.aborted,true);assert.equal(f.controller.snapshot().state,'pending');
  late.resolve({kind:'video',state:'ready',connected:true,httpStatus:200});await flush();assert.equal(f.controller.snapshot().state,'pending');f.controller.stop();
});

test('cached backend timestamps retain the actual prior verification time',async()=>{
  const f=fixture(),earlier=new Date(f.time.now()-15000).toISOString();f.queue('video',{kind:'video',state:'ready',connected:true,httpStatus:200,checkedAt:earlier,lastSuccessAt:earlier});
  await f.controller.select('video');assert.equal(f.controller.snapshot().lastSuccessAt,earlier);assert.equal(f.controller.snapshot().checkedAt,earlier);
  assert.equal(f.controller.snapshot().nextCheckAt-f.time.now(),285000);f.controller.stop();
});

test('the actual app reads non-2xx state bodies, bounds headers and never probes storage from setModel',async()=>{
  const source=fs.readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
  const first=source.indexOf("let activeView='account'"),last=source.indexOf('async function handleFiles',first);
  const time=clock(),calls=[],element={dataset:{},classList:{toggle(){}},setAttribute(){},title:'',disabled:false};
  const context={state:{type:'video'},startupHydrated:true,startupPending:false,relayConfigRevision:0,createStorageStatusController:options=>createStorageStatusController({...options,...time}),storageStatusKind,storageStatusView,
    $:()=>element,AbortController,AbortSignal,Date,Promise,fetch:async path=>{calls.push(path);return {status:429,headers:{get:()=> '99999999999999999'},json:async()=>({kind:'video',state:'rate_limited',connected:false})};}};
  vm.createContext(context);vm.runInContext(source.slice(first,last)+"\n activeView='generate'; storageStatusMode='relay'; globalThis.controller=storageStatusController;",context);
  await context.checkStorageStatus();assert.equal(element.dataset.state,'pending');assert.deepEqual(calls,['/api/uploads/status?kind=video']);
  assert.equal(context.controller.snapshot().cooldownUntil-time.now(),3600000);
  const start=source.indexOf('function setModel(model)'),end=source.indexOf('function clampConcurrency()',start);
  context.isVideoType=()=>true;context.defaultVideoOptions=()=>({});context.clampConcurrency=()=>{};context.renderComposer=()=>{};
  vm.runInContext(source.slice(start,end),context);for(let index=0;index<100;index++)context.setModel({id:'video-'+index});
  assert.equal(calls.length,1);context.controller.stop();
});
