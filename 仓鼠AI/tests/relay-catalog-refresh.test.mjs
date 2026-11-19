import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
const first=source.indexOf('async function loadModels('),last=source.indexOf('function pickDefaultModel()',first);
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
function fixture(){
  const pending=[],calls=[],originalTask={id:'existing-task'},originalMedia={local:'blob:local',url:'already-authorized-material'};
  const state={relayMode:true,models:[],toolModels:[],model:null,tasks:[originalTask],media:[originalMedia]};
  const context={state,navigationEpoch:0,activeView:"generate",relayConfigRevision:0,modelLoadRevision:0,MODEL_CACHE_STORAGE:'cache',localStorage:{removeItem(){}},readModelCache:()=>assert.fail('relay must not read legacy cache'),writeModelCache:()=>assert.fail('relay must not write cache'),
    hasRhKey:()=>false,hasKey:()=>false,hasVideoKey:()=>true,mapUpstreamModels:rows=>rows.filter(row=>row.provider!=='tool'),modelsOfType:()=>state.models,videoModels:()=>state.models,setType(){},pickDefaultModel(){},renderComposer(){},dhSetHint(){},depthSetHint(){},
    request:route=>{const result=deferred();pending.push(result);calls.push({route,force:false});return result.promise;},
    requestOnce:route=>{const result=deferred();pending.push(result);calls.push({route,force:true});return result.promise;}};
  vm.createContext(context);vm.runInContext(source.slice(first,last),context);
  return {context,state,pending,calls,originalTask,originalMedia};
}
const flush=async()=>{for(let i=0;i<5;i++)await Promise.resolve();};
test('manual free refresh adopts newly opened or closed tools and preserves customer material and task state',async()=>{
  const f=fixture(),opened=f.context.loadModels(Promise.resolve(),{force:true});await flush();
  f.pending[0].resolve({data:[{id:'tool-digital',provider:'tool',type:'video'}]});await opened;
  assert.equal(f.state.toolModels[0].id,'tool-digital');assert.deepEqual(f.calls,[{route:'/models',force:true}]);
  const closed=f.context.loadModels(Promise.resolve(),{force:true});await flush();f.pending[1].resolve({data:[]});await closed;
  assert.equal(f.state.toolModels.length,0);assert.equal(f.state.tasks[0],f.originalTask);assert.equal(f.state.media[0],f.originalMedia);
  assert.equal(f.calls.length,2);assert.ok(f.calls.every(call=>call.route==='/models'));
});
test('a stale catalog cannot restore closed tools after a newer refresh completes',async()=>{
  const f=fixture(),old=f.context.loadModels();await flush();const fresh=f.context.loadModels(Promise.resolve(),{force:true});await flush();
  f.pending[1].resolve({data:[]});await fresh;f.pending[0].resolve({data:[{id:'tool-digital',provider:'tool',type:'video'}]});await old;
  assert.equal(f.state.toolModels.length,0);assert.equal(f.state.models.length,0);
});
test('failed manual directory fetch removes stale tool availability without deleting task or local material',async()=>{
  const f=fixture();f.state.toolModels=[{id:'tool-depth',provider:'tool'}];f.state.toolStates={depth:'unpublished'};
  const check=f.context.loadModels(Promise.resolve(),{force:true});await flush();f.pending[0].reject(Error('synthetic offline'));await check;
  assert.equal(f.state.toolModels.length,0);assert.equal(f.state.tasks[0],f.originalTask);assert.equal(f.state.media[0],f.originalMedia);
  assert.equal(Object.keys(f.state.toolStates).length,0);assert.equal(f.state.toolConnection,null);assert.equal(f.state.toolCatalogReady,true);
});
test('background refresh shares one directory request, preserves selected options and skips connection probes',async()=>{
  const f=fixture(),old={id:'main-video-old',type:'video',name:'Old name'},options={duration:7,ratio:'9:16',resolution:'720p'};
  f.state.model=old;f.state.models=[old];f.state.options=options;f.state.concurrency=4;f.state.toolConnection={state:'ready'};f.context.hasRhKey=()=>true;
  const first=f.context.loadModels(Promise.resolve(),{preserveSelection:true}),second=f.context.loadModels(Promise.resolve(),{preserveSelection:true});await flush();
  assert.equal(f.calls.length,1);assert.equal(f.calls[0].route,'/models');
  const replacement={...old,name:'Published current name',line_revision:2},tool={id:'tool-depth',provider:'tool',type:'video'};
  f.pending[0].resolve({data:[replacement,tool],toolStates:{depth:'ready'}});await Promise.all([first,second]);
  assert.equal(f.state.model,replacement);assert.equal(f.state.options,options);assert.equal(f.state.concurrency,4);assert.equal(f.state.toolConnection.state,'ready');assert.equal(f.state.toolStates.depth,'ready');
  assert.equal(f.state.tasks[0],f.originalTask);assert.equal(f.state.media[0],f.originalMedia);
});
test('a removed model remains selected without silently falling back to another published model',async()=>{
  const f=fixture(),selected={id:'main-video-removed',type:'video'};f.state.model=selected;f.state.models=[selected];f.state.options={duration:7};f.state.concurrency=4;
  const pending=f.context.loadModels(Promise.resolve(),{preserveSelection:true});await flush();f.pending[0].resolve({data:[{id:'main-video-other',type:'video'}]});await pending;
  assert.equal(f.state.model,selected);assert.equal(f.state.options.duration,7);assert.equal(f.state.concurrency,4);assert.equal(f.state.models[0].id,'main-video-other');
});
test('a background response from the previous account cannot restore its model or cached tool permission',async()=>{
  const f=fixture(),pending=f.context.loadModels(Promise.resolve(),{preserveSelection:true});await flush();
  f.context.relayConfigRevision++;f.state.model=null;f.state.models=[];f.state.toolConnection=null;f.state.toolModels=[];
  f.pending[0].resolve({data:[{id:'main-video-old',type:'video'},{id:'tool-depth',provider:'tool',type:'video'}],toolStates:{depth:'ready'}});await pending;
  assert.equal(f.state.model,null);assert.equal(f.state.models.length,0);assert.equal(f.state.toolModels.length,0);assert.equal(f.state.toolConnection,null);
});
