import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source=fs.readFileSync(new URL('../canvas/src/main.jsx',import.meta.url),'utf8');
const refreshSource=source.slice(source.indexOf('  async function checkRelayState('),source.indexOf('  async function open('));
const quoteStateFixture=()=>({setToolCheck:()=>{},quoteRequests:{current:new Map([['stale',Promise.resolve()]])},quoteStates:{current:{stale:{quote:{id:'old'}}}},setNodeQuotes:()=>{},setConfirmation:()=>{}});
function fixture(api){
  const states={models:{digital:[{id:'tool-digital'}]},loading:false,messages:[]};
  let revision=1;
  const context=vm.createContext({...quoteStateFixture(),api:route=>route==='/relay/state'?Promise.resolve({relayMode:true,revision}):api(route),relayState:{current:{relayMode:true,revision:null}},relayStateRequest:{current:{next:0,applied:0}},modelsRequest:{current:null},setConnection:()=>{},setUploadJobs:()=>{},setModels:value=>states.models=value,setModelsLoading:value=>states.loading=value,notify:value=>states.messages.push(value)});
  vm.runInContext(refreshSource,context);
  return {states,refresh:options=>context.refreshModels(options),check:()=>context.checkRelayState(),setRevision:value=>revision=value,quotes:context.quoteStates,quoteRequests:context.quoteRequests};
}
test('canvas refresh follows opened and subsequently closed lines without submitting tasks',async()=>{
  let lines=[{id:'main-image-test',type:'image',billing_mode:'relay'},{id:'main-video-test',type:'video',provider:'generate',billing_mode:'relay'},{id:'tool-digital',type:'video',provider:'tool'},{id:'tool-depth',type:'video',provider:'tool'}];
  const calls=[],f=fixture(async route=>{calls.push(route);return {data:lines};});
  await f.refresh();assert.equal(f.states.models.image.length,1);assert.equal(f.states.models.main.length,1);assert.equal(f.states.models.digital.length,1);assert.equal(f.states.models.depth.length,1);
  lines=[];await f.refresh();assert.equal(f.states.models.digital.length,0);assert.equal(f.states.models.image.length,0);
  assert.deepEqual(calls,['/canvas/models','/canvas/models']);assert.equal(f.states.loading,false);
});
test('canvas failed directory check removes stale availability and shows only safe guidance',async()=>{
  const f=fixture(async()=>{throw Error('sk-private https://private.provider.test');});
  await f.refresh({reportError:true});assert.equal(Object.keys(f.states.models).length,0);assert.equal(f.states.messages.length,1);
  assert.doesNotMatch(f.states.messages[0],/private|sk-|https:/);assert.match(f.states.messages[0],/PIKNO Key/);assert.equal(f.states.loading,false);
});
test('canvas concurrent manual and automatic directory checks share one read-only request',async()=>{
  let resolve,count=0;const f=fixture(()=>{count++;return new Promise(done=>resolve=done);});
  const first=f.refresh(),second=f.refresh();assert.equal(first,second);await new Promise(setImmediate);assert.equal(count,1);assert.equal(f.states.loading,true);
  resolve({data:[]});await first;assert.equal(f.states.loading,false);
  const next=f.refresh();await new Promise(setImmediate);assert.equal(count,2);resolve({data:[]});await next;
});

test('canvas discards an old directory response after the account configuration changes',async()=>{
  let resolve;const f=fixture(()=>new Promise(done=>resolve=done));
  const pending=f.refresh();await new Promise(setImmediate);
  f.setRevision(2);await f.check();assert.equal(Object.keys(f.states.models).length,0);
  assert.equal(Object.keys(f.quotes.current).length,0);assert.equal(f.quoteRequests.current.size,0);
  resolve({revision:1,data:[{id:'tool-digital',type:'video',provider:'tool'}]});await pending;
  assert.equal(Object.keys(f.states.models).length,0);assert.equal(f.states.loading,false);
});

test('canvas refuses a catalogue with a mismatched configuration revision',async()=>{
  const f=fixture(async()=>({revision:0,data:[{id:'tool-depth',type:'video',provider:'tool'}]}));
  await f.refresh({reportError:true});assert.equal(Object.keys(f.states.models).length,0);assert.equal(f.states.messages.length,1);
});

test('a new process may have a smaller revision and still invalidates old availability',async()=>{
  const f=fixture(async()=>({data:[]}));f.setRevision(9000);await f.check();
  f.states.models={digital:[{id:'tool-digital'}]};f.setRevision(12);await f.check();
  assert.equal(Object.keys(f.states.models).length,0);await f.refresh();assert.equal(f.states.loading,false);
});

test('late state requests cannot overwrite an already applied newer request',async()=>{
  const resolvers=[],states={models:{},revision:null};
  const context=vm.createContext({...quoteStateFixture(),api:()=>new Promise(resolve=>resolvers.push(resolve)),relayState:{current:{relayMode:true,revision:null}},relayStateRequest:{current:{next:0,applied:0}},modelsRequest:{current:null},setConnection:value=>states.revision=value.revision,setUploadJobs:()=>{},setModels:value=>states.models=value,setModelsLoading:()=>{},notify:()=>{}});
  vm.runInContext(refreshSource,context);
  const old=context.checkRelayState(),fresh=context.checkRelayState();resolvers[1]({relayMode:true,revision:10});await fresh;
  resolvers[0]({relayMode:true,revision:9000});await assert.rejects(old,/响应已失效/);assert.equal(states.revision,10);
});
