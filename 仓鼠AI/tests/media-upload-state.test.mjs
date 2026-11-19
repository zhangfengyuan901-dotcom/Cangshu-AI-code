import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createUploadGate, fileFingerprint, mediaUploadMetadata, mediaExpiryError, refreshMediaReferences } from '../public/media-upload-state.mjs';

test('upload reservation blocks duplicates before preparation or upload resolves', () => {
  const items = [];
  const gate = createUploadGate(() => items);
  const release = gate.claim('image', 'same');
  assert.equal(typeof release, 'function');
  assert.equal(gate.claim('image', 'same'), null);
  items.push({ kind:'image', fingerprint:'same' });
  release();
  assert.equal(gate.claim('image', 'same'), null);
  items.pop();
  const retry = gate.claim('image', 'same');
  assert.equal(typeof retry, 'function');
  retry();
  assert.equal(typeof gate.claim('image', 'same'), 'function');
});

test('failed uploads can be retried and different contents remain independent', () => {
  const gate = createUploadGate(() => []);
  const failed = gate.claim('image', 'a');
  assert.equal(typeof gate.claim('image', 'b'), 'function');
  failed();
  assert.equal(typeof gate.claim('image', 'a'), 'function');
});

test('fingerprints compare complete content instead of sampled bytes or metadata', async () => {
  const bytes = new Uint8Array(600000);
  const different = bytes.slice();
  different[100000] = 1;
  const file = (content, name, type) => ({ name, type, arrayBuffer:async () => content.slice().buffer });
  const first = await fileFingerprint(file(bytes, 'same.png', 'image/png'));
  assert.equal(first, await fileFingerprint(file(bytes, 'renamed.bin', 'application/octet-stream')));
  assert.notEqual(first, await fileFingerprint(file(different, 'same.png', 'image/png')));
});

const source=fs.readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
function section(start,end){const first=source.indexOf(start),last=source.indexOf(end,first);assert.ok(first>=0&&last>first);return source.slice(first,last);}
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const flush=async()=>{for(let i=0;i<8;i++)await Promise.resolve();};

test('upload metadata only preserves usable numeric duration and Unix expiry',()=>{
  assert.deepEqual(mediaUploadMetadata({durationSeconds:2.5,expires_at:2000000000,file:{},path:'private'}),{durationSeconds:2.5,expires_at:2000000000});
  for(const value of [NaN,Infinity,-1,0,'2'])assert.equal('durationSeconds' in mediaUploadMetadata({durationSeconds:value}),false);
  for(const value of [NaN,Infinity,-1,0,2.5,'2000000000'])assert.equal('expires_at' in mediaUploadMetadata({expires_at:value}),false);
});

test('expiry gate uses a local sixty-second margin and keeps unsigned legacy uploads compatible',()=>{
  const now=1700000000000;
  assert.equal(mediaExpiryError([{expires_at:1700000061}],{required:true,now}),'');
  for(const item of [{expires_at:1700000060},{expires_at:1699999999},{expires_at:'1700000900'},{}])assert.match(mediaExpiryError([item],{required:true,now}),/重新上传/);
  assert.equal(mediaExpiryError([{}],{required:false,now}),'');
});

test('refresh only uploads stale inputs and keeps original order while replacing duration and expiry',async()=>{
  const items=[{kind:'video',tag:'v1',url:'old',durationSeconds:99,expires_at:1700000000},{kind:'audio',tag:'a1',url:'still-valid',expires_at:1700001000}];
  const calls=[];
  assert.equal(await refreshMediaReferences(items,{required:true,now:()=>1700000000000,current:()=>true,upload:async item=>{calls.push(item.tag);return {url:'fresh',durationSeconds:2.5,expires_at:1700007200};}}),true);
  assert.deepEqual(calls,['v1']);assert.deepEqual(items.map(item=>item.tag),['v1','a1']);
  assert.equal(items[0].url,'fresh');assert.equal(items[0].durationSeconds,2.5);assert.equal(items[0].expires_at,1700007200);assert.equal(items[1].url,'still-valid');
});

test('refresh discards old-account results and refuses missing or still-expired replacements',async()=>{
  const pending=deferred(),item={url:'old',expires_at:1};let current=true;
  const refresh=refreshMediaReferences([item],{required:true,current:()=>current,upload:()=>pending.promise});
  current=false;pending.resolve({url:'old-account-result',durationSeconds:3,expires_at:2000000000});
  assert.equal(await refresh,false);assert.equal(item.url,'old');
  for(const fresh of [{},{url:'bad-expiry',expires_at:1},{url:'missing-expiry'}]){
    await assert.rejects(refreshMediaReferences([item],{required:true,current:()=>true,upload:async()=>fresh}),error=>error.code==='media_reference_expired');
    assert.equal(item.url,'old');
  }
});

test('actual selected-media grouping preserves duration and expiry without retaining local File or asset identity',()=>{
  const context={state:{media:[{kind:'video',tag:'v1',url:'signed',durationSeconds:2.5,expires_at:2000000000,file:{private:true},assetId:'private-id'}]},mediaUploadMetadata};
  vm.createContext(context);vm.runInContext(section('function groupMedia()', 'async function refreshGenerationMedia'),context);
  assert.deepEqual(JSON.parse(JSON.stringify(context.groupMedia())),{image:[],video:[{tag:'v1',url:'signed',durationSeconds:2.5,expires_at:2000000000}],audio:[]});
});

test('actual upload cache shares an in-flight request and reuploads an expired completed result exactly once',async()=>{
  const requests=[],context={state:{relayMode:true},relayConfigRevision:0,uploadReuse:new Map(),mediaExpiryError,
    uploadRequest:()=>{const request=deferred();requests.push(request);return request.promise;}};
  vm.createContext(context);vm.runInContext(section('async function uploadFile(', 'let activeView='),context);
  const file={size:16},one=context.uploadFile(file,'video',false,undefined,'same'),two=context.uploadFile(file,'video',false,undefined,'same');
  assert.equal(requests.length,1);
  const value={url:'first',expires_at:Math.floor(Date.now()/1000)+600};requests[0].resolve(value);
  assert.equal(await one,value);assert.equal(await two,value);
  value.expires_at=1;
  const three=context.uploadFile(file,'video',false,undefined,'same'),four=context.uploadFile(file,'video',false,undefined,'same');await flush();
  assert.equal(requests.length,2);const fresh={url:'second',expires_at:Math.floor(Date.now()/1000)+600};requests[1].resolve(fresh);
  assert.equal(await three,fresh);assert.equal(await four,fresh);
  const late=context.uploadFile(file,'video',false,undefined,'other');context.relayConfigRevision++;
  requests[2].resolve(fresh);await assert.rejects(late,error=>error.status===409);assert.equal(context.uploadReuse.has('r2:other'),false);
});

test('actual refresh entry uses a retained File or asset route and fences selection, model, account and pending-upload changes',async()=>{
  for(const change of ['account','model','selection','pending','fingerprinting']){
    const pending=deferred(),item={kind:'video',url:'old',expires_at:1,file:{size:16},fingerprint:'fixture'};
    const context={state:{relayMode:true,model:{id:'one'},media:[item],pendingMedia:[]},activeFileBatches:{image:0,video:0,audio:0},relayConfigRevision:0,modelLoadRevision:0,refreshMediaReferences,uploadFile:()=>pending.promise};
    vm.createContext(context);vm.runInContext(section('async function refreshGenerationMedia(', 'async function onSubmit('),context);
    const refresh=context.refreshGenerationMedia(0);
    if(change==='account')context.relayConfigRevision++;
    if(change==='model')context.modelLoadRevision++;
    if(change==='selection')context.state.media=[];
    if(change==='pending')context.state.pendingMedia.push({kind:'video'});
    if(change==='fingerprinting')context.activeFileBatches.video++;
    pending.resolve({url:'late',expires_at:Math.floor(Date.now()/1000)+600});
    assert.equal(await refresh,false);assert.equal(item.url,'old');
  }
  const calls=[],item={kind:'image',url:'old',expires_at:1,assetId:'a'.repeat(32),direct:true};
  const context={state:{relayMode:true,model:{id:'one'},media:[item],pendingMedia:[],relayServerRevision:7},activeFileBatches:{image:0,video:0,audio:0},relayConfigRevision:0,modelLoadRevision:0,refreshMediaReferences,assetsRequest:async(...args)=>{calls.push(args);return {url:'fresh',expires_at:Math.floor(Date.now()/1000)+600};}};
  vm.createContext(context);vm.runInContext(section('async function refreshGenerationMedia(', 'async function onSubmit('),context);
  assert.equal(await context.refreshGenerationMedia(0),true);assert.equal(calls.length,1);assert.equal(calls[0][1],'/'+item.assetId+'/upload-direct');assert.equal(item.url,'fresh');
});

test('an unresolved generation cannot trigger material refresh or a new request identifier',async()=>{
  const messages=[],context={state:{submitting:false},relayConfigRevision:0,pendingQuotedSubmissions:new Map([['generate','old-operation']]),toast:message=>messages.push(message),refreshGenerationMedia:()=>assert.fail('must not refresh'),crypto:{randomUUID:()=>assert.fail('must not create an ID')}};
  vm.createContext(context);vm.runInContext(section('async function onSubmit(', 'let syncingBatches='),context);
  await context.onSubmit({preventDefault(){}});assert.equal(messages.length,1);assert.match(messages[0],/勿重复提交/);
});


for(const outcome of ['success','expired_refresh','account_change'])test(`new submit checks price and balance before refreshing media, then handles ${outcome}`,async()=>{
  const upload=deferred(),quote=deferred(),events=[],posts=[],messages=[];
  const item={kind:'video',tag:'v1',url:'old',durationSeconds:99,expires_at:1,file:{size:16},fingerprint:'fixture'};
  const state={relayMode:true,submitting:false,model:{id:'fixture'},media:[item],pendingMedia:[],options:{duration:5,resolution:'480p',ratio:'16:9'},concurrency:1,type:'video',batches:[]};
  const context={state,relayConfigRevision:0,modelLoadRevision:0,activeFileBatches:{image:0,video:0,audio:0},refreshMediaReferences,mediaUploadMetadata,mediaExpiryError,
    pendingQuotedSubmissions:new Map(),batchIsActive:()=>false,hasGenerationKey:()=>true,generationSelectionError:()=>'',mediaLimitError:()=>'',
    $:()=>({value:'synthetic'}),renderMediaLimits(){},isVideoType:()=>true,
    uploadFile:()=>{events.push('upload');return upload.promise;},
    buildVideoPayload:input=>{assert.equal(input.videos[0].url,'fresh');assert.equal(input.videos[0].durationSeconds,2.5);return input;},
    generationSnapshot:()=>{events.push('snapshot');return {};},crypto:{randomUUID:()=>{events.push('request_id');return 'new-id';}},
    preparePaidSubmission:()=>{events.push('quote');return quote.promise;},preparedQuoteCurrent:()=>true,
    request:async(...args)=>{posts.push(args);return {accepted:true};},acceptLocalTask:()=>true,noteQuotedResult(){},showStoppedBalance:()=>false,
    submissionMessage:()=> 'submitted',toast:message=>messages.push(message),releaseSubmittedMedia(){state.media=[];},renderAllTasks(){},syncTasks(){},
    quoteSubmissionFailed:()=>false,handleError:error=>messages.push(error.message)};
  vm.createContext(context);vm.runInContext(section('function groupMedia()', 'let syncingBatches='),context);
  const submit=context.onSubmit({preventDefault(){}});await flush();assert.deepEqual(events,['snapshot','quote']);assert.equal(posts.length,0);
  if(outcome==='account_change')context.relayConfigRevision++;
  quote.resolve({id:'quote'});await flush();
  if(outcome==='account_change'){await submit;assert.deepEqual(events,['snapshot','quote']);assert.equal(posts.length,0);return;}
  assert.deepEqual(events,['snapshot','quote','upload']);assert.equal(posts.length,0);
  upload.resolve({url:'fresh',durationSeconds:2.5,expires_at:outcome==='expired_refresh'?1:Math.floor(Date.now()/1000)+600});await submit;
  assert.equal(posts.length,outcome==='success'?1:0);
  if(outcome==='success'){assert.deepEqual(events,['snapshot','quote','upload','request_id']);assert.equal(posts[0][1].json.videos[0].durationSeconds,2.5);assert.equal(posts[0][1].json.quote_id,'quote');}
  else assert.match(messages[0],/重新上传/);
});
