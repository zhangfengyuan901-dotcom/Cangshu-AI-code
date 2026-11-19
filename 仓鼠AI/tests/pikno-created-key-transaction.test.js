const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {Readable}=require('node:stream');
const {createPiknoBridge}=require('../pikno.cjs');
const {createPiknoKeyStore}=require('../pikno-key-store.cjs');
const {createPiknoClient}=require('../pikno-client.cjs');

const kinds=['image','video','tool','chat'];
const fields={image:'piknoImageKey',video:'piknoVideoKey',tool:'piknoToolKey',chat:'piknoChatKey'};
const keys=Object.fromEntries(kinds.map((kind,index)=>[kind,'sk-'+String.fromCharCode(97+index).repeat(48)]));
function fixture(t,{persistent=true,initial={}}={}){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hamster-created-key-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  let available=true;
  const cipher={isEncryptionAvailable:()=>available,encryptString:value=>Buffer.from(value).map(byte=>byte^0xa5),decryptString:value=>Buffer.from(value).map(byte=>byte^0xa5).toString()};
  const file=path.join(dir,'keys.bin'),store=createPiknoKeyStore(persistent?{file,cipher}:{});
  if(Object.keys(initial).length)store.write(initial);
  const calls=[],client={
    invalidate:()=>calls.push(['invalidate']),
    context:async(cfg,kind)=>{calls.push(['context',kind]);return {user_id:7,group:kind+'-standard'};},
    catalog:async()=>{calls.push(['catalog']);return {data:[]};},
    submit:()=>assert.fail('automatic configuration must not submit a task'),
    upload:()=>assert.fail('automatic configuration must not upload material'),
  };
  const bridge=createPiknoBridge({keyStore:store,client,taskStore:()=>({})});
  return {bridge,store,client,calls,file,setAvailable:value=>{available=value;}};
}
const automatic={expectedUserId:7,requireProtected:true};
const gate=()=>{let release,entered;return {waiting:new Promise(resolve=>{release=resolve;}),entered:new Promise(resolve=>{entered=resolve;}),release:()=>release(),enter:()=>entered()};};

test('four manually created Keys merge sequentially into protected storage and preserve one execution scope',async t=>{
  const f=fixture(t),scopes=[];
  for(const kind of kinds){
    const status=await f.bridge.configure({[fields[kind]]:keys[kind]},automatic);
    assert.equal(status.ok,true);assert.equal(status.keyStorage,'protected');
    assert.doesNotMatch(JSON.stringify(status),/sk-|piknoUserId|piknoExecutionScope/);
    scopes.push(f.store.read().piknoExecutionScope);
  }
  assert.equal(new Set(scopes).size,1);assert.match(scopes[0],/^[a-f0-9]{64}$/);
  for(const kind of kinds)assert.equal(f.store.read()[fields[kind]],keys[kind]);
  assert.equal(f.bridge.owner(),'pikno:7');
  assert.deepEqual(f.calls.filter(call=>call[0]==='context').map(call=>call[1]),kinds);
  assert.ok(!fs.readFileSync(f.file).includes(Buffer.from('sk-')));
  assert.equal(f.calls.filter(call=>call[0]==='catalog').length,0);
});

test('automatic import cannot silently replace a different configured account or invalidate its revision',async t=>{
  const initial={piknoUserId:8,piknoImageKey:keys.image,piknoExecutionScope:'a'.repeat(64)},f=fixture(t,{initial});
  const before=f.bridge.executionContext();
  await assert.rejects(f.bridge.configure({piknoVideoKey:keys.video},automatic),error=>error.statusCode===409);
  assert.deepEqual(f.store.read(),initial);assert.deepEqual(f.bridge.executionContext(),before);assert.deepEqual(f.calls,[]);
});

for(const expectedUserId of [0,-1,7.5,'7',null])test('automatic import rejects invalid expected identity '+String(expectedUserId),async t=>{
  const f=fixture(t);
  await assert.rejects(f.bridge.configure({piknoImageKey:keys.image},{...automatic,expectedUserId}),error=>error.statusCode===400);
  assert.deepEqual(f.store.read(),{});assert.deepEqual(f.calls,[]);
});

test('the declared page account must match the real Key identity',async t=>{
  const f=fixture(t);f.client.context=async()=>({user_id:8,group:'image-standard'});
  await assert.rejects(f.bridge.configure({piknoImageKey:keys.image},automatic),error=>error.statusCode===409);
  assert.deepEqual(f.store.read(),{});assert.equal(fs.existsSync(f.file),false);
});

test('every explicitly imported Key is validated and a revoked or foreign new Key cannot be saved',async t=>{
  const initial={piknoUserId:7,piknoImageKey:keys.image,piknoVideoKey:keys.video,piknoExecutionScope:'b'.repeat(64)},f=fixture(t,{initial});
  f.client.context=async(_cfg,kind)=>({user_id:kind==='chat'?8:7,group:kind+'-standard'});
  await assert.rejects(f.bridge.configure({piknoToolKey:keys.tool,piknoChatKey:keys.chat},automatic),error=>error.statusCode===409);
  assert.deepEqual(f.store.read(),initial);
  f.client.context=async()=>{throw Object.assign(Error('synthetic authentication failure'),{statusCode:401});};
  await assert.rejects(f.bridge.configure({piknoToolKey:keys.tool},automatic),error=>error.statusCode===401);
  assert.deepEqual(f.store.read(),initial);
});

test('two expired old Keys can be replaced one at a time without discarding other Keys or their account scope',async t=>{
  const initial={piknoUserId:7,piknoExecutionScope:'d'.repeat(64),...Object.fromEntries(kinds.map(kind=>[fields[kind],keys[kind]]))},f=fixture(t,{initial});
  const replacements=Object.fromEntries(kinds.map((kind,index)=>[kind,'sk-'+String.fromCharCode(109+index).repeat(48)])),checked=[];
  f.client.context=async(cfg,kind)=>{
    checked.push(kind);
    if(cfg[fields[kind]]===keys[kind])throw Object.assign(Error('Synthetic expired old Key'),{statusCode:401});
    return {user_id:7,group:kind+'-standard'};
  };
  for(const [index,kind] of kinds.entries()){
    await f.bridge.configure({[fields[kind]]:replacements[kind]},automatic);
    const stored=f.store.read();assert.equal(stored.piknoUserId,7);assert.equal(stored.piknoExecutionScope,initial.piknoExecutionScope);
    for(const [position,other] of kinds.entries())assert.equal(stored[fields[other]],position<=index?replacements[other]:keys[other]);
  }
  assert.deepEqual(checked,kinds);
});

test('ordinary manual configuration still validates every retained Key',async t=>{
  const initial={piknoUserId:7,piknoImageKey:keys.image,piknoVideoKey:keys.video,piknoExecutionScope:'e'.repeat(64)},f=fixture(t,{initial});
  f.client.context=async(_cfg,kind)=>{if(kind==='video')throw Object.assign(Error('Synthetic expired retained Key'),{statusCode:401});return {user_id:7};};
  await assert.rejects(f.bridge.configure({piknoToolKey:keys.tool}),error=>error.statusCode===401);
  assert.deepEqual(f.store.read(),initial);
});

test('automatic import cannot claim legacy unbound Keys using the page account ID',async t=>{
  const initial={piknoImageKey:keys.image,piknoVideoKey:keys.video},f=fixture(t,{initial}),before=f.bridge.executionContext();
  await assert.rejects(f.bridge.configure({piknoToolKey:keys.tool},automatic),error=>error.statusCode===409);
  assert.deepEqual(f.store.read(),initial);assert.deepEqual(f.bridge.executionContext(),before);assert.deepEqual(f.calls,[]);
});

test('automatic import requires an explicit replacement and cannot remove any old Key',async t=>{
  const initial={piknoUserId:7,piknoImageKey:keys.image,piknoExecutionScope:'f'.repeat(64)},f=fixture(t,{initial}),before=f.bridge.executionContext();
  for(const input of [{},{piknoImageKey:'   '},{piknoVideoKey:keys.video,remove_image:true},{piknoVideoKey:keys.video,remove_image:false}])await assert.rejects(f.bridge.configure(input,automatic),error=>error.statusCode===400);
  assert.deepEqual(f.store.read(),initial);assert.deepEqual(f.bridge.executionContext(),before);assert.deepEqual(f.calls,[]);
});

test('the private transport rejects a Key from the wrong group before protected storage is written',async t=>{
  const f=fixture(t),client=createPiknoClient({fetchImpl:async()=>Response.json({user_id:7,group:'video-standard'})});
  const bridge=createPiknoBridge({keyStore:f.store,client,taskStore:()=>({})});
  await assert.rejects(bridge.configure({piknoImageKey:keys.image},automatic),error=>error.statusCode===403);
  assert.deepEqual(f.store.read(),{});assert.equal(fs.existsSync(f.file),false);
});

test('automatic import rejects process memory storage before network calls or revision changes',async t=>{
  const f=fixture(t,{persistent:false}),before=f.bridge.executionContext();
  await assert.rejects(f.bridge.configure({piknoImageKey:keys.image},automatic),error=>error.statusCode===503);
  assert.deepEqual(f.store.read(),{});assert.deepEqual(f.bridge.executionContext(),before);assert.deepEqual(f.calls,[]);
});

test('losing system encryption while verification is pending preserves the previous protected Keys',async t=>{
  const initial={piknoUserId:7,piknoImageKey:keys.image,piknoExecutionScope:'c'.repeat(64)},f=fixture(t,{initial}),before=fs.readFileSync(f.file);
  f.client.context=async()=>{f.setAvailable(false);return {user_id:7};};
  await assert.rejects(f.bridge.configure({piknoVideoKey:keys.video},automatic),error=>error.statusCode===503);
  assert.deepEqual(f.store.read(),initial);assert.deepEqual(fs.readFileSync(f.file),before);
});

test('a changed native account generation cancels an import after its asynchronous identity check',async t=>{
  const f=fixture(t),g=gate();let current=true;
  f.client.context=async()=>{g.enter();await g.waiting;return {user_id:7};};
  const pending=f.bridge.configure({piknoImageKey:keys.image},{...automatic,assertCurrent:()=>current});
  await g.entered;current=false;g.release();
  await assert.rejects(pending,error=>error.statusCode===409);
  assert.deepEqual(f.store.read(),{});assert.equal(fs.existsSync(f.file),false);
});

test('a stale native account generation is rejected before configuration mutation',async t=>{
  const f=fixture(t),before=f.bridge.executionContext();
  await assert.rejects(f.bridge.configure({piknoImageKey:keys.image},{...automatic,assertCurrent:()=>false}),error=>error.statusCode===409);
  assert.deepEqual(f.bridge.executionContext(),before);assert.deepEqual(f.calls,[]);
});

test('a late automatic import cannot restore Keys removed by an explicit disconnect',async t=>{
  const f=fixture(t),g=gate();
  f.client.context=async()=>{g.enter();await g.waiting;return {user_id:7};};
  const pending=f.bridge.configure({piknoImageKey:keys.image},automatic);await g.entered;
  const req=Readable.from([]);req.method='POST';req.headers={host:'127.0.0.1:12345'};
  const res={writeHead(status){this.status=status;},end(){}};
  await f.bridge.handle(req,res,new URL('http://127.0.0.1:12345/api/relay/disconnect'));
  assert.equal(res.status,200);g.release();await assert.rejects(pending,error=>error.statusCode===409);
  assert.deepEqual(f.store.read(),{});
});

test('late automatic validation cannot overwrite a newer completed configuration',async t=>{
  const f=fixture(t),g=gate();
  f.client.context=async(cfg,kind)=>{if(kind==='image'&&cfg.piknoImageKey===keys.image){g.enter();await g.waiting;}return {user_id:7};};
  const pending=f.bridge.configure({piknoImageKey:keys.image},automatic);await g.entered;
  await f.bridge.configure({piknoVideoKey:keys.video},automatic);
  const completed=f.store.read();g.release();await assert.rejects(pending,error=>error.statusCode===409);
  assert.deepEqual(f.store.read(),completed);assert.equal(completed.piknoVideoKey,keys.video);assert.equal(completed.piknoImageKey,undefined);
});

test('a connection check after import is read-only and does not write protected storage again',async t=>{
  const f=fixture(t);await f.bridge.configure({piknoImageKey:keys.image},automatic);
  const before=fs.readFileSync(f.file),context=f.bridge.executionContext();
  const connection=await f.bridge.connection();
  assert.equal(connection.image.configured,true);assert.equal(connection.image.state,'unavailable');assert.equal(connection.video.state,'unconfigured');
  assert.deepEqual(fs.readFileSync(f.file),before);assert.deepEqual(f.bridge.executionContext(),context);
  assert.doesNotMatch(JSON.stringify(connection),/sk-|piknoUserId|piknoExecutionScope/);
});
