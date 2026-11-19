const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),Module=require('node:module');
const baseRoot=process.env.HAMSTER_KEY_PREFIX_BASE_ROOT||path.resolve(__dirname,'..');
const {createPiknoKeyStore}=require(path.join(baseRoot,'pikno-key-store.cjs'));
const {createPiknoClient}=require(path.join(baseRoot,'pikno-client.cjs'));
const bridgeFile=path.join(baseRoot,'pikno.cjs');
const createPiknoBridge=(()=>{
  if(!process.env.HAMSTER_KEY_PREFIX_MODULE)return require(bridgeFile).createPiknoBridge;
  const loaded=new Module(bridgeFile,module);loaded.filename=bridgeFile;loaded.paths=Module._nodeModulePaths(path.dirname(bridgeFile));
  loaded._compile(fs.readFileSync(process.env.HAMSTER_KEY_PREFIX_MODULE,'utf8'),bridgeFile);
  return loaded.exports.createPiknoBridge;
})();
const kinds=['image','video','tool','chat'];
const fields=Object.fromEntries(kinds.map(kind=>[kind,'pikno'+kind[0].toUpperCase()+kind.slice(1)+'Key']));
const raw=kind=>String.fromCharCode(97+kinds.indexOf(kind)).repeat(48);
const scope='e'.repeat(64),automatic={expectedUserId:7,requireProtected:true};
function fixture(t,initial,clientOverride){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'hamster-retained-key-'));
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  let available=true;
  const cipher={isEncryptionAvailable:()=>available,encryptString:value=>Buffer.from(value).map(byte=>byte^0xa5),decryptString:value=>Buffer.from(value).map(byte=>byte^0xa5).toString()};
  const file=path.join(directory,'keys.bin'),store=createPiknoKeyStore({file,cipher});store.write(initial);
  const calls=[],client=clientOverride||{invalidate(){},context:async(cfg,kind,options)=>{
    calls.push({kind,options,canonical:cfg[fields[kind]]==='sk-'+raw(kind)});
    return {user_id:7,group:kind+'-standard'};
  },submit:()=>assert.fail('configuration must not submit'),upload:()=>assert.fail('configuration must not upload')};
  const bridge=createPiknoBridge({keyStore:store,client,taskStore:()=>({})});
  return {bridge,store,client,calls,file,initialBytes:fs.readFileSync(file),setAvailable:value=>{available=value;}};
}
function unchanged(f,initial){assert.deepEqual(f.store.read(),initial);assert.deepEqual(fs.readFileSync(f.file),f.initialBytes);}

for(const [index,kind] of kinds.entries())test('same-account automatic import repairs retained raw48 '+kind+' only after fresh validation',async t=>{
  const incoming=kinds[(index+1)%kinds.length];
  const initial={piknoUserId:7,piknoExecutionScope:scope,[fields[kind]]:raw(kind)},f=fixture(t,initial);
  const status=await f.bridge.configure({[fields[incoming]]:'sk-'+raw(incoming)},automatic);
  assert.equal(status.ok,true);assert.deepEqual(f.calls.map(call=>call.kind).sort(),[kind,incoming].sort());
  assert.equal(f.calls.every(call=>call.canonical&&call.options.fresh===true&&call.options.accountId===7),true);
  const stored=f.store.read();assert.equal(stored[fields[kind]]==='sk-'+raw(kind),true);assert.equal(stored[fields[incoming]]==='sk-'+raw(incoming),true);
  assert.equal(stored.piknoExecutionScope,scope);assert.equal(stored.piknoUserId,7);
  for(const other of kinds.filter(value=>![kind,incoming].includes(value)))assert.equal(Object.hasOwn(stored,fields[other]),false);
  assert.equal(fs.readFileSync(f.file).includes(Buffer.from(raw(kind))),false);
  assert.doesNotMatch(JSON.stringify(status),/sk-|piknoUserId|piknoExecutionScope/);
});

test('canonical retained Keys are unchanged and need no new validation',async t=>{
  const initial={piknoUserId:7,piknoExecutionScope:scope,piknoImageKey:'sk-'+raw('image')},f=fixture(t,initial);
  await f.bridge.configure({piknoVideoKey:'sk-'+raw('video')},automatic);
  assert.equal(f.store.read().piknoImageKey,initial.piknoImageKey);assert.deepEqual(f.calls.map(call=>call.kind),['video']);
});

test('manual input and manual retained raw Keys keep the original format rejection',async t=>{
  for(const initial of [{piknoUserId:7,piknoExecutionScope:scope},{piknoUserId:7,piknoExecutionScope:scope,piknoImageKey:raw('image')}]){
    const f=fixture(t,initial);
    const input=initial.piknoImageKey?{piknoVideoKey:'sk-'+raw('video')}:{piknoVideoKey:raw('video')};
    await assert.rejects(f.bridge.configure(input),error=>error.statusCode===400);unchanged(f,initial);assert.deepEqual(f.calls,[]);
  }
});

test('automatic raw new input is not mistaken for a retained Key',async t=>{
  const initial={piknoUserId:7,piknoExecutionScope:scope},f=fixture(t,initial);
  await assert.rejects(f.bridge.configure({piknoVideoKey:raw('video')},automatic),error=>error.statusCode===400);
  unchanged(f,initial);assert.deepEqual(f.calls,[]);
});

test('unbound and foreign bound accounts cannot normalize retained values',async t=>{
  for(const initial of [{piknoImageKey:raw('image')},{piknoUserId:8,piknoExecutionScope:scope,piknoImageKey:raw('image')}]){
    const f=fixture(t,initial),before=f.bridge.executionContext();
    await assert.rejects(f.bridge.configure({piknoVideoKey:'sk-'+raw('video')},automatic),error=>error.statusCode===409);
    unchanged(f,initial);assert.deepEqual(f.bridge.executionContext(),before);assert.deepEqual(f.calls,[]);
  }
});

test('malformed retained formats are rejected without persistence or context lookup',async t=>{
  for(const malformed of ['a'.repeat(47),'a'.repeat(49),'a'.repeat(47)+'_','sk-'+raw('image')+'!',' '+raw('image')]){
    const initial={piknoUserId:7,piknoExecutionScope:scope,piknoImageKey:malformed},f=fixture(t,initial);
    await assert.rejects(f.bridge.configure({piknoVideoKey:'sk-'+raw('video')},automatic),error=>error.statusCode===400);
    unchanged(f,initial);assert.deepEqual(f.calls,[]);
  }
});

test('real context transport rejects a repaired Key from another user, purpose, or revoked state',async t=>{
  for(const failure of ['user','group','revoked']){
    let calls=0;
    const client=createPiknoClient({fetchImpl:async(_url,options)=>{
      calls++;const image=options.headers.Authorization==='Bearer sk-'+raw('image');
      if(image&&failure==='revoked')return Response.json({error:'synthetic'},{status:401});
      return Response.json({user_id:image&&failure==='user'?8:7,group:image?(failure==='group'?'video-standard':'image-standard'):'video-standard'});
    }});
    const initial={piknoUserId:7,piknoExecutionScope:scope,piknoImageKey:raw('image')},f=fixture(t,initial,client);
    await assert.rejects(f.bridge.configure({piknoVideoKey:'sk-'+raw('video')},automatic),error=>[401,403,409].includes(error.statusCode));
    assert.equal(calls,2);unchanged(f,initial);
  }
});

test('account change after repaired Key validation preserves exact protected bytes',async t=>{
  let current=true;
  const initial={piknoUserId:7,piknoExecutionScope:scope,piknoImageKey:raw('image')},f=fixture(t,initial);
  f.client.context=async(_cfg,kind)=>{if(kind==='image')current=false;return {user_id:7};};
  await assert.rejects(f.bridge.configure({piknoVideoKey:'sk-'+raw('video')},{...automatic,assertCurrent:()=>current}),error=>error.statusCode===409);
  unchanged(f,initial);
});

test('encryption becoming unavailable during repair preserves exact protected bytes',async t=>{
  const initial={piknoUserId:7,piknoExecutionScope:scope,piknoImageKey:raw('image')},f=fixture(t,initial);
  f.client.context=async()=>{f.setAvailable(false);return {user_id:7};};
  await assert.rejects(f.bridge.configure({piknoVideoKey:'sk-'+raw('video')},automatic),error=>error.statusCode===503);
  assert.deepEqual(fs.readFileSync(f.file),f.initialBytes);
  f.setAvailable(true);assert.deepEqual(f.store.read(),initial);
});
