import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {createUploadGate,createUploadQueue,mediaUploadMetadata} from '../public/media-upload-state.mjs';

const source=fs.readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
const first=source.indexOf('async function handleFiles('),last=source.indexOf('function kindForFile(',first);
assert.ok(first>=0&&last>first);
const actual=source.slice(first,last);
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const flush=async()=>{for(let i=0;i<30;i++)await Promise.resolve();};
const file=(name,fingerprint=name)=>({name,type:'video/mp4',size:100,fingerprint});

function fixture({capacity=20,fingerprint=async file=>file.fingerprint}={}){
  const state={type:'video',model:{id:'fixture-model'},media:[],pendingMedia:[]};
  const uploads=[],revoked=[],errors=[],toasts=[];let currentUploads=0,maxUploads=0,nextId=0,tag=0;
  const gate=createUploadGate(()=>[...state.media,...state.pendingMedia]);
  const element={classList:{add(){},remove(){}}};
  const context={state,relayConfigRevision:0,hasGenerationKey:()=>true,accountHint:()=>'',mediaUploadMetadata,
    $:()=>element,mediaUploadGate:gate,mediaUploadQueue:createUploadQueue(2),uploadReuse:new Map(),
    activeFileBatches:{image:0,video:0,audio:0},renderMediaLimits(){},renderMedia(){},queueMediaProgress(){},
    kindForFile:file=>file.type.split('/')[0],mediaLimitError:(_model,items)=>items.length>capacity?'素材数量超限':'',
    fileFingerprint:fingerprint,performance,crypto:{randomUUID:()=>String(++nextId)},setTimeout:()=>0,
    URL:{createObjectURL:file=>'blob:'+file.name,revokeObjectURL:url=>revoked.push(url)},
    nextTag:kind=>kind+(++tag),toast:value=>toasts.push(value),handleError:error=>errors.push(error.message),
    uploadFile:async(...args)=>{
      const request=deferred();currentUploads++;maxUploads=Math.max(maxUploads,currentUploads);
      uploads.push({args,...request});
      try{return await request.promise;}finally{currentUploads--;}
    }};
  vm.createContext(context);vm.runInContext(actual,context,{filename:'actual handleFiles upload queue'});
  return {context,state,uploads,revoked,errors,toasts,gate,maxUploads:()=>maxUploads};
}

test('first upload starts before the next fingerprint finishes; two slots preserve selection order',async()=>{
  const hash=deferred();
  const f=fixture({fingerprint:async item=>item.name==='two'?hash.promise:item.fingerprint});
  const pending=f.context.handleFiles([file('one'),file('two'),file('three')],'video');
  await flush();
  assert.equal(f.uploads.length,1,'file one starts without waiting for file two to be hashed');
  hash.resolve('two');await flush();
  assert.equal(f.uploads.length,2);
  f.uploads[1].resolve({url:'https://fixture.invalid/two'});await flush();
  assert.equal(f.uploads.length,3,'file three uses the released second slot');
  f.uploads[2].resolve({url:'https://fixture.invalid/three'});await flush();
  assert.equal(f.state.media.length,0,'out-of-order network completion does not reorder input tags');
  f.uploads[0].resolve({url:'https://fixture.invalid/one'});await pending;
  assert.equal(f.maxUploads(),2);
  assert.deepEqual(Array.from(f.state.media,item=>item.name),['one','two','three']);
  assert.deepEqual(Array.from(f.state.media,item=>item.tag),['video1','video2','video3']);
  assert.equal(f.state.pendingMedia.length,0);assert.equal(f.context.activeFileBatches.video,0);
  assert.deepEqual(f.revoked,[]);
});

test('separate picker batches share the same two upload slots',async()=>{
  const f=fixture();
  const one=f.context.handleFiles([file('one'),file('two')],'video');
  const two=f.context.handleFiles([file('three'),file('four')],'video');
  await flush();assert.equal(f.uploads.length,2);
  f.uploads[0].resolve({url:'https://fixture.invalid/one'});
  f.uploads[1].resolve({url:'https://fixture.invalid/three'});await flush();
  assert.equal(f.uploads.length,4);
  f.uploads[2].resolve({url:'https://fixture.invalid/two'});
  f.uploads[3].resolve({url:'https://fixture.invalid/four'});
  await Promise.all([one,two]);assert.equal(f.maxUploads(),2);
});

test('duplicates, mixed types and the total limit are rejected before extra network work',async()=>{
  const f=fixture({capacity:2});
  const pending=f.context.handleFiles([file('one','same'),file('duplicate','same'),{...file('wrong'),type:'image/png'},file('two'),file('over-limit')],'video');
  await flush();
  assert.deepEqual(f.uploads.map(item=>item.args[0].name),['one','two']);
  f.uploads.forEach((item,index)=>item.resolve({url:'https://fixture.invalid/'+index}));await pending;
  assert.equal(f.state.media.length,2);
  assert.equal(f.toasts.length,3);
  assert.equal(f.state.pendingMedia.length,0);
});

for(const change of ['revision','model','type']){
  test(`${change} changes prevent queued uploads and discard late results with object URL cleanup`,async()=>{
    const f=fixture();
    const pending=f.context.handleFiles(['one','two','three','four'].map(name=>file(name)),'video');
    await flush();assert.equal(f.uploads.length,2);
    if(change==='revision')f.context.relayConfigRevision++;
    if(change==='model')f.state.model={id:'different-model'};
    if(change==='type')f.state.type='image';
    f.uploads.forEach(item=>item.resolve({url:'https://fixture.invalid/late'}));
    await pending;
    assert.equal(f.uploads.length,2);assert.equal(f.state.media.length,0);
    assert.equal(f.state.pendingMedia.length,0);assert.equal(f.revoked.length,4);
    assert.equal(new Set(f.revoked).size,4);assert.deepEqual(f.errors,[]);
    const release=f.gate.claim('video','three');assert.equal(typeof release,'function');release();
  });
}

test('one failed upload releases its reservation and URL without preventing the next successful result',async()=>{
  const f=fixture();
  const pending=f.context.handleFiles([file('one'),file('two')],'video');
  await flush();
  f.uploads[0].reject(Error('fixture upload failed'));f.uploads[1].resolve({url:'https://fixture.invalid/two'});
  await pending;
  assert.deepEqual(f.errors,['fixture upload failed']);assert.deepEqual(f.revoked,['blob:one']);
  assert.deepEqual(Array.from(f.state.media,item=>item.name),['two']);assert.equal(f.state.pendingMedia.length,0);
  const release=f.gate.claim('video','one');assert.equal(typeof release,'function');release();
});
