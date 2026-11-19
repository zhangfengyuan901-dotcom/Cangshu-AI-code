import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {mediaUploadMetadata} from '../public/media-upload-state.mjs';

const source=fs.readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
function section(start,end){
  const first=source.indexOf(start),last=source.indexOf(end,first);
  assert.ok(first>=0&&last>first,`Missing real application section: ${start}`);
  return source.slice(first,last);
}
const toolFunctions=[
  section('async function pickToolAsset','async function dhSubmit()'),
  section('async function depthPickVideoAsset','async function depthSubmit()'),
].join('\n');
const generationFunctions='let selectingAsset=false;\n'+section('async function useGenerationAsset','async function openGenerationAssets');
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const flush=async()=>{for(let i=0;i<8;i++)await Promise.resolve();};

function elements(){
  const values=new Map();
  return selector=>{
    if(!values.has(selector))values.set(selector,{disabled:false,textContent:'',className:'',classList:{add(){},remove(){}}});
    return values.get(selector);
  };
}
function toolFixture(kind){
  const request=deferred(),calls=[],errors=[],toasts=[],rendered={digital:0,depth:0},$=elements();
  const item={id:'a'.repeat(32),kind,name:`stored-${kind}`};
  const state={dh:{image:{fileName:'current-image',local:'blob:current-image'},audio:{fileName:'current-audio',duration:1}},depth:{video:{fileName:'current-video',local:'blob:current-video'}}};
  const context={state,relayConfigRevision:0,toolUploadVersions:{image:0,audio:0,video:0},RH_MAX_AUDIO_SECONDS:30,KIND_LABEL:{image:'图片',audio:'音频',video:'视频'},$,mediaUploadMetadata,
    requireRhKey:()=>true,requireToolReady:()=>true,pickAsset:async options=>{calls.push({picker:options});return item;},
    assetsRequest:async(...args)=>{calls.push({upload:args});return request.promise;},audioDuration:async()=>12,
    publicText:value=>value,toast:value=>toasts.push(value),handleError:error=>errors.push(error),
    renderDhSlots:()=>rendered.digital++,renderDepthSlot:()=>rendered.depth++,
    URL:{revokeObjectURL(){}},
  };
  vm.createContext(context);vm.runInContext(toolFunctions,context,{filename:'actual tool asset library functions'});
  return {context,state,request,calls,errors,toasts,rendered};
}
const toolCases=[
  ['dhPickImageAsset','image',state=>state.dh.image,'talent'],
  ['dhPickAudioAsset','audio',state=>state.dh.audio,'talent'],
  ['depthPickVideoAsset','video',state=>state.depth.video,'scene'],
];
for(const [method,kind,current,category] of toolCases){
  test(`${method}: stored ${kind} uses video authorization and a late old-account response is ignored`,async()=>{
    const f=toolFixture(kind),before=current(f.state),pending=f.context[method]();await flush();
    assert.equal(f.calls[0].picker.category,category);assert.deepEqual(Array.from(f.calls[0].picker.kinds),[kind]);
    assert.equal(f.calls[1].upload[1],`/${'a'.repeat(32)}/upload?use=video`);
    assert.equal(f.calls[1].upload[2].method,'POST');
    f.context.relayConfigRevision++;f.context.toolUploadVersions[kind]++;
    f.request.resolve({url:'old-account-url'});await pending;
    assert.equal(current(f.state),before);assert.equal(f.errors.length,0);assert.equal(f.toasts.length,0);
    assert.equal(f.rendered.digital+f.rendered.depth,0);
  });
  test(`${method}: current-account stored ${kind} becomes the tool input`,async()=>{
    const f=toolFixture(kind),pending=f.context[method]();await flush();
    f.request.resolve({url:'video-authorized-url'});await pending;
    assert.equal(current(f.state).fileName,'video-authorized-url');
    assert.equal(current(f.state).local,`/api/assets/${'a'.repeat(32)}/file`);
    if(kind==='audio')assert.equal(current(f.state).duration,12);
    assert.equal(f.rendered.digital+f.rendered.depth,1);
  });
}

function generationFixture(type){
  const request=deferred(),calls=[],added=[],toasts=[],$=elements();
  const state={type,model:{},media:[],pendingMedia:[],apiKey:'',relayMode:true};
  const context={state,relayConfigRevision:0,$,hasGenerationKey:()=>true,mediaLimitError:()=>'',
    assetsRequest:async(...args)=>{calls.push(args);return request.promise;},
    addMediaByUrl:(...args)=>added.push(args),switchView(){},toast:value=>toasts.push(value)};
  vm.createContext(context);vm.runInContext(generationFunctions,context,{filename:'actual generation asset function'});
  return {context,state,request,calls,added,toasts};
}
test('video generation uses the video Key domain for a stored image and fences a late account result',async()=>{
  const f=generationFixture('video'),pending=f.context.useGenerationAsset({id:'b'.repeat(32),kind:'image'});await flush();
  assert.equal(f.calls[0][1],`/${'b'.repeat(32)}/upload?use=video`);
  f.context.relayConfigRevision++;f.request.resolve({url:'old-account-url'});await pending;
  assert.equal(f.added.length,0);assert.equal(f.toasts.length,1,'only the initial progress notice is shown');
});
test('image generation keeps the image-only direct asset path',async()=>{
  const f=generationFixture('image'),pending=f.context.useGenerationAsset({id:'c'.repeat(32),kind:'image'});await flush();
  assert.equal(f.calls[0][1],`/${'c'.repeat(32)}/upload-direct`);
  assert.doesNotMatch(f.calls[0][1],/use=video/);
  f.request.resolve({url:'image-authorized-url'});await pending;
  assert.equal(f.added.length,1);
  assert.deepEqual(f.added[0].slice(0,2),['image-authorized-url','image']);
  assert.equal(f.added[0][2].assetId,'c'.repeat(32));assert.equal(f.added[0][2].direct,true);
});
