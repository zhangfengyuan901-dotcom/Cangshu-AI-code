const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const appRoot = path.resolve(process.env.HAMSTER_TEST_APP_ROOT || path.join(__dirname, '..'));
const {createAccountService} = require(path.join(appRoot, 'electron/account-service.cjs'));
const GROUPS = ['image-standard','video-standard','tool-standard','chat-standard'];
const ORIGIN = 'https://www.piknoai.com';
const json = (data,status=200) => ({ok:status>=200&&status<300,status,headers:{get:()=>null},json:async()=>structuredClone(data)});
const bundle = () => ({access_token:'synthetic-session',token_type:'Bearer',access_expires_at:2000001000,
  session:{sid:'synthetic-desktop-session',current:true},user:{id:42,username:'onboarding-fixture',role:1}});
function fixture(t, options={}) {
  const folder=fs.mkdtempSync(path.join(os.tmpdir(),'hamster-browser-'));
  t.after(()=>fs.rmSync(folder,{recursive:true,force:true}));
  const encryptionKey=crypto.randomBytes(32);
  const cipher={isEncryptionAvailable:()=>true,encryptString(text){const nonce=crypto.randomBytes(12),enc=crypto.createCipheriv('aes-256-gcm',encryptionKey,nonce);return Buffer.concat([nonce,enc.update(text),enc.final(),enc.getAuthTag()]);},decryptString(bytes){const dec=crypto.createDecipheriv('aes-256-gcm',encryptionKey,bytes.subarray(0,12));dec.setAuthTag(bytes.subarray(-16));return Buffer.concat([dec.update(bytes.subarray(12,-16)),dec.final()]).toString();}};
  const calls=[],opened=[],installed=[];
  const configured=new Set(options.configured||[]);
  const state={userId:options.owner||null,authenticated:options.authenticated===true,approved:false,complete:false,created:0,now:2000000000000};
  const keys=GROUPS.map((group,index)=>({id:index+1,group,key:String(index+1).repeat(48)}));
  let service;
  const connect=async(value,{assertCurrent})=>{
    assert.equal(assertCurrent(),true);
    if(options.install)await options.install(value);
    assert.equal(value.userId,42); assert.equal(state.userId===null||state.userId===42,true);
    assert.equal(configured.has(value.group),false);
    installed.push({...value});configured.add(value.group);state.userId=42;
    return {ok:true,code:'SAVED_CHECK_PENDING'};
  };
  const request=async(url,init={})=>{
    const target=new URL(url);assert.equal(target.origin,ORIGIN);
    const body=init.body?JSON.parse(init.body):undefined;
    calls.push({path:target.pathname,body,headers:init.headers});
    if(options.fetch){const result=await options.fetch(target,init,body,state);if(result)return result;}
    if(target.pathname==='/api/user/auth/refresh')return state.authenticated?json({success:true,data:bundle()}):json({success:false},401);
    if(target.pathname==='/api/user/desktop/start'){
      state.created++;state.challenge=body.challenge;state.purpose=body.purpose;
      return json({success:true,data:{flow_id:'F'.repeat(43),expires_at:2000000900,interval:3,verification_url:ORIGIN+'/hub/billing#desktop='+'F'.repeat(43)}});
    }
    if(target.pathname==='/api/user/desktop/exchange'){
      assert.equal(crypto.createHash('sha256').update(body.verifier).digest('base64url'),state.challenge);
      if(state.complete)return json({success:false,code:'DESKTOP_FLOW_COMPLETE'},409);
      if(!state.approved)return json({success:true,data:{status:'pending',expires_at:2000000900}});
      if(state.purpose==='recharge')return json({success:true,data:{status:'ready',user_id:42}});
      state.authenticated=true;return json({success:true,data:{status:'ready',...bundle(),keys}});
    }
    if(target.pathname==='/api/user/desktop/ack'){
      assert.equal(init.headers.Authorization,'Bearer synthetic-session');state.complete=true;
      return json({success:true,data:{status:'complete'}});
    }
    if(target.pathname==='/api/user/self')return json({success:true,data:{id:42,quota:50000000,used_quota:0,request_count:0,username:'onboarding-fixture'}});
    if(target.pathname==='/api/user/self/groups')return json({success:true,data:Object.fromEntries(GROUPS.map(group=>[group,{}]))});
    if(target.pathname==='/api/status')return json({success:true,data:{quota_per_unit:1000000,usd_exchange_rate:1}});
    const key=/^\/api\/token\/(\d+)$/.exec(target.pathname);
    if(key){const row=keys[Number(key[1])-1];return json({success:true,data:{...row,key:undefined,name:'Managed '+row.group,created_time:1999999990,status:1,expired_time:-1}});}
    throw Error('Unexpected synthetic route '+target.pathname);
  };
  const config={fetchImpl:request,journalFile:path.join(folder,'operations.json'),browserCipher:cipher,
    getConfiguredGroups:()=>[...configured],getConnectedAccountId:()=>state.userId,
    connectCreatedKey:connect,openExternal:async url=>opened.push(url),now:()=>state.now};
  const create=()=>{service=createAccountService(config);return service;};
  t.after(()=>service?.dispose());
  return {service:create(),recreate:create,state,calls,opened,installed,configured,keys,config,
    proofFile:config.journalFile+'.browser',folder};
}

test('guest opens one fixed browser flow, proof is encrypted, and renderer receives only a connection code', async t=>{
  const f=fixture(t);
  const result=await f.service.command('browser-open');
  assert.deepEqual(result,{ok:true,browserOpened:true,pending:true,connectionCode:'FFFF-FFFF'});
  assert.equal(f.state.created,1);assert.deepEqual(f.opened,[ORIGIN+'/hub/billing#desktop='+'F'.repeat(43)]);
  const pending=await f.service.command('browser-poll');assert.deepEqual(pending,{ok:true,pending:true});
  const verifier=f.calls.find(call=>call.path.endsWith('/exchange')).body.verifier;
  assert.equal(fs.readFileSync(f.proofFile).includes(verifier),false);
  assert.doesNotMatch(JSON.stringify(result),/verifier|flow_id|challenge|access_token|key/);
  await f.service.command('browser-open');assert.equal(f.state.created,1);assert.equal(f.opened.length,2);
  assert.equal(f.calls.some(call=>call.path==='/api/user/pay'),false);
});

test('registration completion imports four keys in main process, acknowledges, then returns only safe account data',async t=>{
  const f=fixture(t);await f.service.command('browser-open');f.state.approved=true;
  const result=await f.service.command('browser-poll');assert.deepEqual(result,{ok:true,pending:false,connected:true});
  assert.equal(f.installed.length,4);assert.equal(f.state.complete,true);assert.equal(fs.existsSync(f.proofFile),false);
  const snapshot=await f.service.command('snapshot');assert.equal(snapshot.balance,50);assert.equal(snapshot.accountMatched,true);
  assert.doesNotMatch(JSON.stringify(snapshot),/synthetic-session|111111111111|access_token|verifier/);
  assert.equal(f.calls.some(call=>call.path.endsWith('/key')),false);
  assert.equal(f.calls.filter(call=>call.path.endsWith('/ack')).length,1);
});

test('old users recharge without replacing configured keys or creating payment in the application',async t=>{
  const f=fixture(t,{configured:GROUPS,owner:42,authenticated:true});
  const result=await f.service.command('browser-open');assert.equal(result.connectionCode,undefined);
  assert.equal(f.calls.find(call=>call.path.endsWith('/start')).body.purpose,'recharge');
  f.state.approved=true;await f.service.command('browser-poll');assert.equal(f.installed.length,0);
  assert.equal(f.calls.some(call=>call.path.startsWith('/api/token/')),false);
  assert.equal(f.calls.some(call=>call.path==='/api/user/pay'),false);
});

test('an expired local session still constrains the browser to the configured owner',async t=>{
  const f=fixture(t,{owner:42});await f.service.command('browser-open');
  assert.equal(f.calls.find(call=>call.path.endsWith('/start')).body.expected_user_id,42);
});

test('partial protected installation resumes only missing groups before refresh',async t=>{
  let failed=false;
  const f=fixture(t,{install:async value=>{if(value.group==='video-standard'&&!failed){failed=true;throw Error('simulated save failure');}}});
  await f.service.command('browser-open');f.state.approved=true;
  assert.equal((await f.service.command('browser-poll')).ok,false);assert.equal(f.installed.length,1);
  const before=f.calls.filter(call=>call.path.endsWith('/auth/refresh')).length;
  const result=await f.service.command('snapshot');assert.equal(result.signedIn,true);
  assert.equal(f.installed.length,4);assert.equal(f.calls.filter(call=>call.path.endsWith('/auth/refresh')).length,before);
  assert.deepEqual(f.installed.map(row=>row.group),GROUPS);
});

test('encrypted pending enrollment recovers after process restart without another start',async t=>{
  const f=fixture(t);await f.service.command('browser-open');f.service.dispose();
  const restarted=f.recreate();f.state.approved=true;
  assert.equal((await restarted.command('browser-poll')).connected,true);assert.equal(f.state.created,1);
});

test('uncertain acknowledgement recovers completion without another key import',async t=>{
  let failed=false;
  const f=fixture(t,{fetch:async(target,_init,_body,state)=>{
    if(target.pathname.endsWith('/ack')&&!failed){failed=true;state.complete=true;throw Error('lost response');}
  }});
  await f.service.command('browser-open');f.state.approved=true;
  assert.equal((await f.service.command('browser-poll')).ok,false);
  assert.equal(f.installed.length,4);assert.equal((await f.service.command('browser-poll')).pending,false);
  assert.equal(f.installed.length,4);assert.equal(fs.existsSync(f.proofFile),false);
});

test('protected storage and strict IPC contracts block unsafe setup before server mutation',async t=>{
  const f=fixture(t);f.config.browserCipher.isEncryptionAvailable=()=>false;
  assert.equal((await f.service.command('browser-open')).code,'KEY_STORAGE_UNAVAILABLE');
  for(const action of ['payment-create','payment-open','auth-login'])assert.equal((await f.service.command(action)).code,'INVALID_REQUEST');
  assert.equal((await f.service.command('browser-open',{url:'https://other.invalid'})).code,'INVALID_REQUEST');
  assert.equal(f.state.created,0);
});

test('untrusted browser destinations are rejected before opening or persisting the flow',async t=>{
  const f=fixture(t,{fetch:async target=>target.pathname.endsWith('/start')?json({success:true,data:{flow_id:'F'.repeat(43),expires_at:2000000900,interval:3,verification_url:'https://other.invalid/hub/billing'}}):undefined});
  assert.equal((await f.service.command('browser-open')).ok,false);
  assert.equal(f.opened.length,0);assert.equal(fs.existsSync(f.proofFile),false);
});

test('only missing local groups are installed during an authenticated reconnect',async t=>{
  const f=fixture(t,{owner:42,authenticated:true,configured:GROUPS.slice(0,2)});
  await f.service.command('browser-open');assert.equal(f.state.purpose,'connect');f.state.approved=true;
  await f.service.command('browser-poll');assert.deepEqual(f.installed.map(row=>row.group),GROUPS.slice(2));
});

test('recharge acknowledgement loss can be reconciled after restart',async t=>{
  let lost=false;
  const f=fixture(t,{owner:42,authenticated:true,configured:GROUPS,fetch:async(target,_init,_body,state)=>{
    if(target.pathname.endsWith('/ack')&&!lost){lost=true;state.complete=true;throw Error('lost response');}
  }});
  await f.service.command('browser-open');f.state.approved=true;
  assert.equal((await f.service.command('browser-poll')).ok,false);f.service.dispose();
  assert.equal((await f.recreate().command('browser-poll')).pending,false);
  assert.equal(fs.existsSync(f.proofFile),false);assert.equal(f.installed.length,0);
});

test('pending recharge resumes its partition session after restart before acknowledgement',async t=>{
  const f=fixture(t,{owner:42,authenticated:true,configured:GROUPS});
  await f.service.command('browser-open');
  assert.equal(f.state.purpose,'recharge');assert.equal(f.state.approved,false);
  f.service.dispose();const restarted=f.recreate();
  assert.equal((await restarted.command('snapshot')).browserPending,true);
  const refreshesBefore=f.calls.filter(call=>call.path.endsWith('/auth/refresh')).length;
  f.state.approved=true;
  const result=await restarted.command('snapshot');
  assert.equal(result.signedIn,true);assert.equal(result.balance,50);
  assert.equal(f.calls.filter(call=>call.path.endsWith('/auth/refresh')).length,refreshesBefore+1);
  assert.equal(f.state.created,1);assert.equal(f.state.complete,true);assert.equal(f.installed.length,0);
  assert.equal(fs.existsSync(f.proofFile),false);
});

test('recharge refreshes an expiring session before acknowledging the browser result',async t=>{
  let first=true;
  const f=fixture(t,{owner:42,authenticated:true,configured:GROUPS,fetch:async target=>{
    if(target.pathname.endsWith('/auth/refresh')&&first){first=false;return json({success:true,data:{...bundle(),access_expires_at:2000000100}});}
  }});
  await f.service.command('browser-open');
  f.state.now=2000000081000;
  const before=f.calls.filter(call=>call.path.endsWith('/auth/refresh')).length;
  f.state.approved=true;
  const result=await f.service.command('browser-poll');
  assert.equal(result.ok,true);assert.equal(result.pending,false);
  assert.equal(f.calls.filter(call=>call.path.endsWith('/auth/refresh')).length,before+1);
  assert.equal(f.state.complete,true);
});
