import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source=fs.readFileSync(new URL('../canvas/src/main.jsx',import.meta.url),'utf8');
const scope=vm.createContext({});
vm.runInContext(source.slice(source.indexOf('function canvasPreview('),source.indexOf('function PreviewDialog(')),scope);
const id='a'.repeat(32),task='b'.repeat(32);
const trigger=(origin,key,kind)=>({dataset:{canvasPreviewSource:origin,canvasPreviewId:key,canvasPreviewKind:kind}});
const resolve=(button,assets=[],doc={nodes:[],runs:[]})=>{const item=scope.canvasPreviewItem(button,assets,doc);return item&&JSON.parse(JSON.stringify(item));};

test('canvas global preview resolves only current assets and does not trust a DOM title or media URL',()=>{
  const assets=[{id,kind:'image',name:'合成图片.png'}],button=trigger('asset',id,'image');button.dataset.src='https://untrusted.invalid';button.dataset.name='untrusted title';
  assert.deepEqual(resolve(button,assets),{src:'/api/assets/'+id+'/file',kind:'image',name:'合成图片.png',detail:''});
  assert.equal(resolve(button,[]),null);assert.equal(resolve(trigger('asset',id,'video'),assets),null);
  for(const key of ['../config',id+'?x=1','https://untrusted.invalid',id+'\n'])assert.equal(resolve(trigger('asset',key,'image'),assets),null);
});

test('canvas saved task preview follows the current successful run and current node media kind',()=>{
  const run={taskKey:task,nodeId:'node-1',status:'succeeded'},doc={nodes:[{id:'node-1',data:{channel:'main'}}],runs:[run]},button=trigger('task',task,'video');
  assert.deepEqual(resolve(button,[],doc),{src:'/api/tasks/'+task+'/file',kind:'video',name:'已保存结果'});
  for(const status of ['unknown','processing','queued','failed','submitting']){run.status=status;assert.equal(resolve(button,[],doc),null);}
  run.status='succeeded';run.inactiveAccount=true;assert.equal(resolve(button,[],doc),null);
  run.inactiveAccount=false;assert.equal(resolve(trigger('task',task,'image'),[],doc),null);
  doc.nodes=[];assert.equal(resolve(button,[],doc),null);
});

test('audio and video assets use the same fixed local route and carry only available metadata',()=>{
  for(const kind of ['video','audio'])assert.deepEqual(resolve(trigger('asset',id,kind),[{id,kind,name:'合成素材',durationSeconds:12.5}]),{src:'/api/assets/'+id+'/file',kind,name:'合成素材',detail:'12.5 秒'});
  for(const kind of ['document','iframe','html','svg'])assert.equal(resolve(trigger('asset',id,kind),[{id,kind}]),null);
});

test('hover does not replace an inline player that is already playing while explicit preview stays available',()=>{
  const assets=[{id,kind:'video',name:'合成视频'}],media={paused:false,ended:false},button=trigger('asset',id,'video');
  button.closest=()=>({querySelector:()=>media});button.hasAttribute=()=>false;
  assert.equal(resolve(button,assets),null);
  button.hasAttribute=()=>true;assert.equal(resolve(button,assets).kind,'video');
  button.hasAttribute=()=>false;media.paused=true;assert.equal(resolve(button,assets).kind,'video');
});

function playbackFixture(){
  const refs=[],effects=[],calls={claimed:0,released:0,paused:0};let stop;
  const context=vm.createContext({window:{},useRef(value){const ref={current:value};refs.push(ref);return ref;},useEffect(effect){effects.push(effect);},claimMediaPlayback(_window,callback){calls.claimed++;stop=callback;return()=>calls.released++;}});
  vm.runInContext(source.slice(source.indexOf('function useMediaPlayback('),source.indexOf('function Ports(')),context);
  const handlers=context.useMediaPlayback('synthetic-local-asset'),cleanup=effects[0](),media={pause(){calls.paused++;}};
  return {calls,handlers,cleanup,media,stop:()=>stop()};
}

test('canvas native media claims the global player only after explicit playback and releases on pause',()=>{
  const f=playbackFixture();assert.equal(f.calls.claimed,0);
  f.handlers.onPlay({currentTarget:f.media});assert.equal(f.calls.claimed,1);
  f.stop();assert.equal(f.calls.paused,1);
  f.handlers.onPause();assert.equal(f.calls.released,1);
  f.cleanup();assert.equal(f.calls.released,1);
});

test('canvas disposal pauses the actual player even after React has detached its DOM ref',()=>{
  const f=playbackFixture();f.handlers.onPlay({currentTarget:f.media});f.handlers.ref.current=null;
  f.cleanup();assert.equal(f.calls.released,1);assert.equal(f.calls.paused,1);
});

test('canvas uses separate hover and open selectors so native media controls and asset selection remain independent',()=>{
  assert.match(source,/selector:'\[data-canvas-preview\]',openSelector:'\[data-canvas-preview-open\]'/);
  assert.match(source,/<video \{\.\.\.playback\}[^>]*controls/);
  assert.match(source,/className="asset-picker-card"/);assert.match(source,/>使用此素材<\/button>/);
  assert.match(source,/function dragStart\(\)\{previewController\.current\?\.hide\(\)/);
  assert.match(source,/effectiveReducedMotion\?0:220/);
});

test('media dialogs and the asset picker protect background nodes from Delete without blocking text editing',()=>{
  const calls=[],event={key:'Delete',target:{closest:()=>null},preventDefault:()=>calls.push('prevent'),stopPropagation:()=>calls.push('stop')};
  scope.protectCanvasPreviewKeys(event,{querySelector:()=>({})});assert.deepEqual(calls,['prevent','stop']);
  calls.length=0;scope.protectCanvasPreviewKeys(event,{querySelector:()=>null});assert.deepEqual(calls,[]);
  event.key='Escape';scope.protectCanvasPreviewKeys(event,{querySelector:()=>({})});assert.deepEqual(calls,[]);
  event.key='Backspace';event.target.closest=()=>({});scope.protectCanvasPreviewKeys(event,{querySelector:()=>({})});assert.deepEqual(calls,[]);
});
