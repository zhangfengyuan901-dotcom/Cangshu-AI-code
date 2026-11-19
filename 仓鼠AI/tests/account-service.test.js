const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {createAccountService,ORIGIN}=require('../electron/account-service.cjs');

const ACCESS='synthetic-access-token-private';
const RAW_KEY='S'.repeat(48);
const REQUEST_ID='12345678-1234-4234-8234-123456789abc';
const IMAGE='image-standard',VIDEO='video-standard';
const json=(data,status=200,headers={})=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json',...headers}});
const ok=data=>json({success:true,data});
function deferred(){let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};}
function temporary(t){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'hamster-account-service-test-'));
  t.after(()=>{
    const resolved=path.resolve(directory),root=path.resolve(os.tmpdir());
    assert.equal(path.dirname(resolved),root);
    assert.match(path.basename(resolved),/^hamster-account-service-test-/);
    fs.rmSync(resolved,{recursive:true,force:true});
  });
  return path.join(directory,'operations.json');
}
function fixture(t,options={}){
  const journalFile=options.journalFile||temporary(t);
  const state={now:1800000000000,userId:9,sid:'synthetic-session-a',rows:[],usage:[],settlements:[],...options.state};
  const calls=[],connections=[],failures=[],configured=[];
  const makeRow=(value={})=>({id:state.rows.length+1,name:'测试 Key',group:IMAGE,created_time:Math.floor(state.now/1000),status:1,expired_time:-1,key:'masked-private-sentinel',...value});
  function dispatch(url,init){
    const route=url.pathname,body=init.body?JSON.parse(init.body):undefined;
    if(route==='/api/user/auth/refresh')return ok({access_token:ACCESS,access_expires_at:state.now/1000+300,user:{id:state.userId,username:'tester'},session:{sid:state.sid}});
    if(route==='/api/user/auth/logout')return ok({revoked_sid:state.sid,cookie_cleared:true});
    if(route==='/api/user/self')return ok({id:state.userId,username:'tester',email:'synthetic@example.invalid',quota:1000000,used_quota:125000,request_count:5,access_token:ACCESS,password:'private-password-sentinel'});
    if(route==='/api/status')return ok({quota_per_unit:500000,usd_exchange_rate:7,private_setting:'private-status-sentinel'});
    if(route==='/api/user/self/groups')return ok({[IMAGE]:{},[VIDEO]:{},'tool-standard':{},'chat-standard':{}});
    if(route==='/api/log/self')return ok({items:state.usage,total:state.usage.length});
    if(route==='/api/pikno/settlements/self')return ok({items:state.settlements,total:state.settlements.length});
    if(route==='/api/token/'&&init.method==='POST'){state.rows.push(makeRow({...body,id:state.rows.length+100}));return json({success:true,message:''});}
    if(route==='/api/token/search'||route==='/api/token/'&&init.method==='GET'){
      // Match the real backend: group is NOT a supported search parameter.
      const keyword=url.searchParams.get('keyword')||'',page=Number(url.searchParams.get('p')||1),size=Number(url.searchParams.get('size')||20);
      const rows=state.rows.filter(row=>row.name.includes(keyword));
      return ok({items:rows.slice((page-1)*size,page*size),total:rows.length});
    }
    const reveal=route.match(/^\/api\/token\/(\d+)\/key$/);
    if(reveal&&init.method==='POST')return ok({key:RAW_KEY});
    const token=route.match(/^\/api\/token\/(\d+)\/?$/);
    if(token)return ok(state.rows.find(row=>row.id===Number(token[1]))||null);
    throw Error('Unexpected synthetic route: '+route);
  }
  const service=createAccountService({journalFile,now:()=>state.now,isCurrent:options.isCurrent||(()=>true),
    getConnectedAccountId:options.getConnectedAccountId,browserCipher:options.browserCipher,
    fetchImpl:async(input,init)=>{
      const url=new URL(input);assert.equal(url.origin,ORIGIN,'a fake fetch must never reach another origin');
      calls.push({url:url.href,route:url.pathname,init});
      const response=await options.fetchHook?.({url,init,state,calls,makeRow,dispatch:()=>dispatch(url,init)});
      return response===undefined?dispatch(url,init):response;
    },
    connectCreatedKey:async(payload,control)=>{connections.push({...payload});return options.connectHook?options.connectHook(payload,control):{ok:true,code:'CONNECTED'};},
    onConfigured:()=>configured.push(true),onFailure:value=>failures.push(value),
  });
  t.after(()=>service.dispose());
  return {service,journalFile,state,calls,connections,failures,configured,makeRow,command:(...args)=>service.command(...args),count:(route,method)=>calls.filter(call=>call.route===route&&(!method||call.init.method===method)).length};
}
const createValue={group:IMAGE,days:30,limit:'',requestId:REQUEST_ID};
const noSecret=value=>{const serialized=JSON.stringify(value);for(const secret of [ACCESS,RAW_KEY,'private-password-sentinel','private-status-sentinel','masked-private-sentinel'])assert.equal(serialized.includes(secret),false,secret+' leaked');};

test('account snapshot uses fixed credentialed same-origin transport and exposes only public fields',async t=>{
  const f=fixture(t),result=await f.command('snapshot');
  assert.deepEqual(result,{ok:true,signedIn:true,accountMatched:true,user:{id:9,username:'tester',email:'synthetic@example.invalid'},balance:14,spent:1.75,requests:5,groups:[IMAGE,VIDEO,'tool-standard','chat-standard'],pending:[]});
  noSecret(result);
  await f.command('snapshot');assert.equal(f.count('/api/user/auth/refresh'),1);
  for(const call of f.calls){assert.equal(call.init.credentials,'include');assert.equal(call.init.cache,'no-store');assert.equal(call.init.redirect,'error');assert.equal(call.init.headers.Origin,ORIGIN);assert.equal(call.init.headers.Referer,ORIGIN+'/account-lite/index.html');assert.ok(call.init.signal instanceof AbortSignal);}
  const logout=await f.command('logout');assert.equal(logout.ok,true);
  const last=f.calls.at(-1);assert.equal(last.init.headers['X-Auth-Session'],'synthetic-session-a');assert.equal(last.init.headers.Authorization,'Bearer '+ACCESS);
});

test('unauthenticated refresh is a guest snapshot and never requests protected account data',async t=>{
  const f=fixture(t,{fetchHook:({url})=>url.pathname==='/api/user/auth/refresh'?json({success:false},401):undefined});
  assert.deepEqual(await f.command('snapshot'),{ok:true,signedIn:false});assert.equal(f.count('/api/user/self'),0);
});

test('unknown or extra command input is rejected before any network request',async t=>{
  const f=fixture(t);
  for(const [action,value] of [['proxy',{url:'https://example.invalid'}],['snapshot',{headers:{}}],['create',{...createValue,key:RAW_KEY}],['keys',{group:'other'}],['keys',{group:IMAGE,page:0}]])assert.equal((await f.command(action,value)).code,'INVALID_REQUEST');
  assert.equal(f.calls.length,0);
});

test('create and enable is one explicit write, normalizes raw48, and stores no secrets',async t=>{
  const f=fixture(t);const result=await f.command('create',{group:IMAGE,days:7,limit:'7.00',requestId:REQUEST_ID});
  assert.equal(result.code,'CONNECTED');assert.equal(f.count('/api/token/','POST'),1);assert.equal(f.connections.length,1);
  const body=JSON.parse(f.calls.find(call=>call.route==='/api/token/').init.body);
  assert.equal(body.remain_quota,500000);assert.equal(body.unlimited_quota,false);assert.equal(body.expired_time,f.state.now/1000+7*86400);
  assert.equal(Buffer.byteLength(body.name),50,'New API caps names at 50 UTF-8 bytes');
  assert.equal(f.connections[0].key,'sk-'+RAW_KEY);assert.equal(f.connections[0].userId,9);
  noSecret(result);noSecret(JSON.parse(fs.readFileSync(f.journalFile,'utf8')));
});

test('duplicate concurrent create clicks create and import only one Key',async t=>{
  const f=fixture(t);const results=await Promise.all([f.command('create',createValue),f.command('create',createValue)]);
  assert.equal(results.every(result=>result.ok),true);assert.equal(f.count('/api/token/','POST'),1);assert.equal(f.connections.length,1);
});

test('create with lost response is recovered after restart without another POST',async t=>{
  const file=temporary(t);let dropped=false;
  const f=fixture(t,{journalFile:file,fetchHook:({url,dispatch})=>{if(url.pathname==='/api/token/'&&!dropped){dropped=true;dispatch();throw Error('synthetic connection closed');}}});
  assert.equal((await f.command('create',createValue)).code,'NETWORK');assert.equal(f.state.rows.length,1);assert.equal(f.connections.length,0);f.service.dispose();
  const resumed=fixture(t,{journalFile:file,state:{rows:f.state.rows}});
  assert.equal((await resumed.command('recover',{group:IMAGE})).code,'CONNECTED');assert.equal(resumed.count('/api/token/','POST'),0);assert.equal(resumed.connections.length,1);
});

test('unresolved creation never retries POST even after repeated create and recover clicks',async t=>{
  const f=fixture(t,{fetchHook:({url})=>{if(url.pathname==='/api/token/')throw Error('unknown before receipt');}});
  assert.equal((await f.command('create',createValue)).code,'NETWORK');
  assert.equal((await f.command('create',createValue)).code,'PENDING_OPERATION');
  assert.equal((await f.command('recover',{group:IMAGE})).code,'PENDING_OPERATION');
  assert.equal(f.count('/api/token/','POST'),1);assert.equal(f.connections.length,0);
});

test('malformed and semantically incomplete journals fail closed before creation or secret read',async t=>{
  const valid={userId:9,group:IMAGE,requestId:REQUEST_ID,startedAt:1800000000000,name:'original',state:'pending'};
  const samples=['{broken',JSON.stringify({format:2,entries:[]}),JSON.stringify({format:1,entries:[{...valid,key:RAW_KEY}]}),JSON.stringify({format:1,entries:[{...valid,state:'saved'}]}),JSON.stringify({format:1,entries:[{...valid,state:'selected'}]})];
  for(const content of samples){const file=temporary(t);fs.writeFileSync(file,content);const f=fixture(t,{journalFile:file});assert.equal((await f.command('create',createValue)).code,'STORAGE_UNAVAILABLE',content);assert.equal(f.count('/api/token/','POST'),0);assert.equal(f.connections.length,0);}
});

test('listing existing Keys never reveals credentials; explicit selection reveals only that Key',async t=>{
  const f=fixture(t);f.state.rows=[f.makeRow({id:41,name:'Selected'}),f.makeRow({id:42,name:'Other'})];
  const listing=await f.command('keys',{group:IMAGE});assert.equal(listing.items.length,2);noSecret(listing);assert.equal(f.calls.some(call=>call.route.endsWith('/key')),false);
  assert.equal((await f.command('enable',{group:IMAGE,id:41})).code,'CONNECTED');assert.equal(f.count('/api/token/41/key','POST'),1);assert.equal(f.count('/api/token/42/key'),0);assert.equal(f.connections[0].keyId,41);
});

test('Key listing preserves backend page and total semantics while allowing later pages to be selected',async t=>{
  const f=fixture(t);f.state.rows=Array.from({length:20},(_,i)=>f.makeRow({id:i+1,group:VIDEO,name:'video-'+i}));f.state.rows.push(f.makeRow({id:99,group:IMAGE,name:'image-on-next-page'}));
  const result=await f.command('keys',{group:IMAGE,page:1});assert.equal(result.ok,true);assert.equal(result.total,21);assert.deepEqual(result.items,[]);
  const next=await f.command('keys',{group:IMAGE,page:2});assert.equal(next.total,21);assert.deepEqual(next.items.map(row=>row.id),[99]);assert.equal(f.calls.filter(call=>call.route==='/api/token/').every(call=>!new URL(call.url).searchParams.has('group')),true);
});

test('explicit selection rejects disabled, expired, mismatched-use and mismatched-id rows',async t=>{
  for(const changes of [{status:2},{expired_time:1799999999},{group:VIDEO},{id:999}]){
    const f=fixture(t,{fetchHook:({url,makeRow})=>url.pathname==='/api/token/41'?ok(makeRow({id:41,...changes})):undefined});
    f.state.rows=[f.makeRow({id:41})];await f.command('keys',{group:IMAGE});
    assert.equal((await f.command('enable',{group:IMAGE,id:41})).code,'KEY_INVALID',JSON.stringify(changes));assert.equal(f.calls.some(call=>call.route.endsWith('/key')),false);
  }
});

test('truncated search results are not treated as uniquely recovered creation',async t=>{
  const f=fixture(t,{fetchHook:({url,state})=>url.pathname==='/api/token/search'?ok({items:state.rows,total:101}):undefined});
  assert.equal((await f.command('create',createValue)).code,'PENDING_OPERATION');assert.equal(f.connections.length,0);assert.equal(f.calls.some(call=>call.route.endsWith('/key')),false);
});

test('invalidating the account discards an in-flight Key read and clears the old selection',async t=>{
  const entered=deferred(),release=deferred();
  t.after(()=>release.resolve());
  const f=fixture(t,{fetchHook:async({url})=>{
    if(url.pathname==='/api/token/41/key'){entered.resolve();await release.promise;return ok({key:RAW_KEY});}
  }});
  f.state.rows=[f.makeRow({id:41})];
  await f.command('keys',{group:IMAGE});
  const activating=f.command('enable',{group:IMAGE,id:41});
  await Promise.race([entered.promise,activating.then(()=>assert.fail('the Key read never started'))]);
  f.service.invalidate();
  release.resolve();
  assert.equal((await activating).code,'ACCOUNT_CHANGED');
  assert.equal(f.connections.length,0);
  assert.equal((await f.command('enable',{group:IMAGE,id:41})).code,'INVALID_REQUEST');
  assert.equal(f.count('/api/token/41/key'),1);
  assert.equal((await f.command('snapshot')).signedIn,true);
});

test('window suspension makes the existing native storage assertCurrent guard false',async t=>{
  const entered=deferred(),release=deferred();let nativeGuard;
  const f=fixture(t,{connectHook:async(_payload,{assertCurrent})=>{nativeGuard=assertCurrent;entered.resolve();await release.promise;return {ok:true,code:'CONNECTED'};}});f.state.rows=[f.makeRow({id:41})];
  await f.command('keys',{group:IMAGE});const activation=f.command('enable',{group:IMAGE,id:41});await Promise.race([entered.promise,activation.then(result=>{throw Error(JSON.stringify(result));})]);assert.equal(nativeGuard(),true);
  const suspended=f.service.suspend();assert.equal(nativeGuard(),false);release.resolve();assert.equal((await activation).code,'ACCOUNT_CHANGED');await suspended;
  assert.equal(JSON.parse(fs.readFileSync(f.journalFile,'utf8')).entries[0].state,'selected');assert.equal(f.configured.length,0);
});

test('changed refresh user or session is rejected before acting under the new identity',async t=>{
  for(const change of [{userId:10},{sid:'synthetic-session-b'}]){const f=fixture(t);assert.equal((await f.command('snapshot')).ok,true);Object.assign(f.state,change,{now:f.state.now+400000});assert.equal((await f.command('create',createValue)).code,'ACCOUNT_CHANGED');assert.equal(f.count('/api/token/','POST'),0);assert.equal(f.connections.length,0);}
});

test('a journal from another account is never resumed for the currently logged-in account',async t=>{
  const file=temporary(t);fs.writeFileSync(file,JSON.stringify({format:1,entries:[{userId:8,group:IMAGE,requestId:REQUEST_ID,startedAt:1800000000000,name:'other-account',state:'pending'}]}));
  const f=fixture(t,{journalFile:file});assert.equal((await f.command('recover',{group:IMAGE})).code,'INVALID_REQUEST');assert.equal(f.calls.some(call=>call.route.startsWith('/api/token/')),false);
});

test('429 Retry-After protects the same secret route while unrelated reads remain available',async t=>{
  let limited=true;const f=fixture(t,{fetchHook:({url})=>url.pathname==='/api/token/41/key'&&limited?(limited=false,json({success:false},429,{'Retry-After':'12'})):undefined});f.state.rows=[f.makeRow({id:41})];
  await f.command('keys',{group:IMAGE});assert.deepEqual(await f.command('enable',{group:IMAGE,id:41}),{ok:false,code:'RATE_LIMITED',retryAfterMs:12000});
  assert.equal((await f.command('recover',{group:IMAGE})).code,'RATE_LIMITED');assert.equal(f.count('/api/token/41/key','POST'),1);assert.equal(f.connections.length,0);assert.equal(f.failures.length,0);
  assert.equal((await f.command('snapshot')).ok,true);assert.equal((await f.command('keys',{group:IMAGE})).ok,true);
  f.state.now+=12001;assert.equal((await f.command('recover',{group:IMAGE})).code,'CONNECTED');assert.equal(f.connections.length,1);
});

test('a limited snapshot does not block logout and its route cooldown survives window and session resets',async t=>{
  let limited=true;const f=fixture(t,{fetchHook:({url})=>url.pathname==='/api/user/self'&&limited?(limited=false,json({success:false},429,{'Retry-After':'1200'})):undefined});
  assert.deepEqual(await f.command('snapshot'),{ok:false,code:'RATE_LIMITED',retryAfterMs:1200000});
  const count=f.calls.length;assert.equal((await f.command('snapshot')).code,'RATE_LIMITED');assert.equal(f.calls.length,count);
  assert.equal((await f.command('keys',{group:IMAGE})).ok,true);
  await f.service.suspend();f.service.resume();
  assert.equal((await f.command('snapshot')).code,'RATE_LIMITED');assert.equal(f.count('/api/user/self'),1);
  assert.equal((await f.command('logout')).ok,true);assert.equal(f.count('/api/user/auth/logout','POST'),1);
  f.state.now+=1199999;
  assert.deepEqual(await f.command('snapshot'),{ok:false,code:'RATE_LIMITED',retryAfterMs:1});assert.equal(f.count('/api/user/self'),1);
  f.state.now+=1;assert.equal((await f.command('snapshot')).ok,true);assert.equal(f.count('/api/user/self'),2);
});

test('route cooldown ignores query pagination and keeps GET listing separate from POST creation',async t=>{
  let limited=true;const f=fixture(t,{fetchHook:({url,init})=>url.pathname==='/api/token/'&&init.method==='GET'&&limited?(limited=false,json({success:false},429,{'Retry-After':'12'})):undefined});
  assert.equal((await f.command('keys',{group:IMAGE,page:1})).code,'RATE_LIMITED');
  assert.equal((await f.command('keys',{group:VIDEO,page:2})).code,'RATE_LIMITED');assert.equal(f.count('/api/token/','GET'),1);
  assert.equal((await f.command('create',createValue)).code,'CONNECTED');assert.equal(f.count('/api/token/','POST'),1);
  f.state.now+=12000;assert.equal((await f.command('keys',{group:IMAGE,page:2})).ok,true);assert.equal(f.count('/api/token/','GET'),2);
});

test('numeric Key IDs share the secret route cooldown without blocking different routes',async t=>{
  let limited=true;const f=fixture(t,{fetchHook:({url})=>url.pathname==='/api/token/41/key'&&limited?(limited=false,json({success:false},429,{'Retry-After':'12'})):undefined});
  f.state.rows=[f.makeRow({id:41,group:IMAGE}),f.makeRow({id:42,group:VIDEO})];
  await f.command('keys',{group:IMAGE});await f.command('keys',{group:VIDEO});
  assert.equal((await f.command('enable',{group:IMAGE,id:41})).code,'RATE_LIMITED');
  assert.equal((await f.command('enable',{group:VIDEO,id:42})).code,'RATE_LIMITED');assert.equal(f.count('/api/token/42/key','POST'),0);
  assert.equal((await f.command('snapshot')).ok,true);assert.equal(f.connections.length,0);
  f.state.now+=12000;assert.equal((await f.command('recover',{group:VIDEO})).code,'CONNECTED');assert.equal(f.count('/api/token/42/key','POST'),1);
});

test('saved but pending detection recovers after restart without revealing or saving the Key again',async t=>{
  const file=temporary(t),f=fixture(t,{journalFile:file,connectHook:()=>({ok:true,code:'SAVED_CHECK_PENDING'})});f.state.rows=[f.makeRow({id:41})];
  await f.command('keys',{group:IMAGE});assert.equal((await f.command('enable',{group:IMAGE,id:41})).code,'SAVED_CHECK_PENDING');f.service.dispose();
  const resumed=fixture(t,{journalFile:file});const result=await resumed.command('recover',{group:IMAGE});assert.equal(result.saved,true);assert.equal(result.code,'SAVED_CHECK_PENDING');assert.equal(resumed.connections.length,0);assert.equal(resumed.calls.some(call=>call.route.endsWith('/key')),false);
});

test('429 received after encrypted storage preserves the saved result without locking account reads',async t=>{
  const f=fixture(t,{connectHook:()=>({ok:true,code:'SAVED_CHECK_PENDING',httpStatus:429,retryAfterMs:9000})});f.state.rows=[f.makeRow({id:41})];
  await f.command('keys',{group:IMAGE});const result=await f.command('enable',{group:IMAGE,id:41});assert.equal(result.ok,true);assert.equal(result.saved,true);assert.equal(result.code,'SAVED_CHECK_PENDING');assert.equal(result.httpStatus,429);assert.equal(result.retryAfterMs,9000);
  assert.equal((await f.command('snapshot')).ok,true);assert.equal((await f.command('recover',{group:IMAGE})).code,'SAVED_CHECK_PENDING');assert.equal(f.count('/api/token/41/key'),1);assert.equal(f.connections.length,1);
});

test('usage and settlement records expose only a fixed display whitelist',async t=>{
  const f=fixture(t);const privateFields={key:RAW_KEY,content:'private-content-sentinel',other:'private-other-sentinel',user_id:9,channel_id:50,ip:'192.0.2.123',model_name:'safe-model'};
  f.state.usage=[{...privateFields,created_at:1800000000,quota:500000,group:IMAGE}];f.state.settlements=[{...privateFields,created_at:1800000000,net_quota:100000,financial_state:'settled',review_required:false,order_id:'private-order-sentinel'}];
  for(const kind of ['usage','settlements']){const result=await f.command('usage',{kind});assert.equal(result.ok,true);assert.deepEqual(Object.keys(result.items[0]).sort(),['amount','createdAt','kind','model','state']);noSecret(result);assert.equal(JSON.stringify(result).includes('private-'),false);assert.ok(Math.abs(result.items[0].amount-(kind==='usage'?7:1.4))<1e-10);}
});

test('failure reports and command errors never expose server text or secrets',async t=>{
  const f=fixture(t,{fetchHook:({url})=>{if(url.pathname==='/api/token/41/key')throw Error(RAW_KEY+' private server failure '+ACCESS);}});f.state.rows=[f.makeRow({id:41})];
  await f.command('keys',{group:IMAGE});const result=await f.command('enable',{group:IMAGE,id:41});assert.deepEqual(result,{ok:false,code:'NETWORK'});assert.deepEqual(f.failures,[{code:'ACCOUNT_KEY_IMPORT_FAILED',httpStatus:0}]);noSecret(result);noSecret(f.failures);
});

test('a new explicit creation intent can replace a completed or known failed selection, never an unknown creation',async t=>{
  const f=fixture(t);
  assert.equal((await f.command('create',createValue)).ok,true);
  assert.equal((await f.command('create',createValue)).ok,true);
  assert.equal(f.count('/api/token/','POST'),1);
  assert.equal((await f.command('create',{...createValue,requestId:'22345678-1234-4234-8234-123456789abc'})).ok,true);
  assert.equal(f.count('/api/token/','POST'),2);
  let rejected=true;
  const other=fixture(t,{connectHook:()=>rejected?{ok:false,code:'KEY_INVALID'}:{ok:true,code:'CONNECTED'}});
  other.state.rows=[other.makeRow({id:51}),other.makeRow({id:52,name:'另一条 Key'})];
  await other.command('keys',{group:IMAGE});
  assert.equal((await other.command('enable',{group:IMAGE,id:51})).code,'KEY_INVALID');
  rejected=false;
  assert.equal((await other.command('enable',{group:IMAGE,id:52})).ok,true);
  assert.equal(other.count('/api/token/','POST'),0);
});


test('usage and settlements display only catalogue labels or fixed functional names',async t=>{
  const usage=[
    {group:IMAGE,model_name:'private-deployment-id',quota:500000,created_at:123},
    {group:VIDEO,model_name:'unpublished-private-id',quota:250000,created_at:124},
    {group:VIDEO,model_name:'bad-name-id',quota:100000,created_at:125},
  ];
  const settlements=[{model:'private-deployment-id',net_quota:100000,created_at:126,financial_state:'settled'}];
  const f=fixture(t,{state:{usage,settlements},fetchHook:({url,init})=>{
    if(url.pathname!=='/api/pikno/catalog')return;
    assert.equal(init.credentials,'omit');
    assert.equal(init.headers.has('Authorization'),false);
    assert.equal(init.headers.has('X-API-Key'),false);
    return ok({models:[
      {id:'private-deployment-id',name:'仓鼠公开图片线路'},
      {id:'bad-name-id',name:'https://private.invalid/'},
    ]});
  }});
  const result=await f.command('usage');
  assert.equal(result.ok,true);
  assert.deepEqual(result.items.map(row=>row.model),['仓鼠公开图片线路','视频生成','视频生成']);
  assert.deepEqual(result.items.slice(0,2).map(row=>row.amount),[7,3.5]);
  assert.ok(Math.abs(result.items[2].amount-1.4)<1e-10);
  const ledger=await f.command('usage',{kind:'settlements'});
  assert.equal(ledger.items[0].model,'仓鼠公开图片线路');
  assert.equal(ledger.items[0].state,'settled');
  assert.ok(Math.abs(ledger.items[0].amount-1.4)<1e-10);
  assert.equal(f.count('/api/pikno/catalog'),1);
  assert.doesNotMatch(JSON.stringify({result,ledger}),/private|deployment|unpublished/);
  assert.equal(f.connections.length,0);
  assert.deepEqual(f.state.usage,usage);
  assert.deepEqual(f.state.settlements,settlements);
});

test('an unavailable catalogue falls back to functional labels and preserves ledger amounts',async t=>{
  const f=fixture(t,{state:{usage:[{group:IMAGE,model_name:'private-deployment-id',quota:500000}]},
    fetchHook:({url})=>url.pathname==='/api/pikno/catalog'?json({success:false},503):undefined});
  const result=await f.command('usage');
  assert.equal(result.ok,true);
  assert.equal(result.items[0].model,'图片生成');
  assert.equal(result.items[0].amount,7);
  assert.doesNotMatch(JSON.stringify(result),/private|deployment/);
});

test('window invalidation or disposal during catalogue lookup discards the previous account ledger',async t=>{
  for(const method of ['invalidate','dispose']){
    const started=deferred(),release=deferred();
    t.after(()=>release.resolve());
    const f=fixture(t,{state:{usage:[{group:IMAGE,model_name:'private',quota:500000}]},
      fetchHook:async({url})=>{
        if(url.pathname!=='/api/pikno/catalog')return;
        started.resolve();
        await release.promise;
        return ok({models:[]});
      }});
    const pending=f.command('usage');
    await Promise.race([started.promise,pending.then(()=>assert.fail('catalogue lookup never started'))]);
    f.service[method]();
    release.resolve();
    assert.deepEqual(await pending,{ok:false,code:'ACCOUNT_CHANGED'});
  }
});

test('account invalidation discards old refresh headers and body before adopting a new session',async t=>{
  for(const phase of ['headers','body']){
    const started=deferred(),release=deferred();let first=true,signal;
    t.after(()=>release.resolve());
    const f=fixture(t,{fetchHook:async({url,init,state})=>{
      if(url.pathname!=='/api/user/auth/refresh'||!first)return;
      first=false;signal=init.signal;
      const previous={success:true,data:{access_token:ACCESS,access_expires_at:state.now/1000+300,user:{id:state.userId},session:{sid:state.sid}}};
      if(phase==='headers'){started.resolve();await release.promise;return json(previous);}
      return {status:200,ok:true,json:async()=>{started.resolve();await release.promise;return previous;}};
    }});
    const reading=f.command('snapshot');
    await Promise.race([started.promise,reading.then(()=>assert.fail('refresh never started'))]);
    f.service.invalidate();
    Object.assign(f.state,{userId:10,sid:'synthetic-new-login-session'});
    const newSnapshot=f.command('snapshot');
    await new Promise(setImmediate);
    assert.equal(signal.aborted,false);
    assert.equal(f.calls.length,1);
    release.resolve();
    assert.deepEqual(await reading,{ok:false,code:'ACCOUNT_CHANGED'});
    const current=await newSnapshot;
    assert.equal(current.signedIn,true);
    assert.equal(current.user.id,10);
    noSecret(current);
    const refreshes=f.calls.filter(call=>call.route==='/api/user/auth/refresh');
    assert.equal(refreshes.length,2);
    assert.equal(refreshes[1].init.headers['X-Auth-Session'],undefined);
    assert.equal(f.count('/api/user/self'),1);
    assert.equal(f.connections.length,0);
    assert.equal(f.failures.length,0);
  }
});

test('invalidating during a dispatched Key creation recovers the original operation without another write',async t=>{
  const started=deferred(),release=deferred();let signal;
  t.after(()=>release.resolve());
  const f=fixture(t,{fetchHook:async({url,init,dispatch})=>{
    if(url.pathname==='/api/token/'&&init.method==='POST'){
      const response=dispatch();signal=init.signal;started.resolve();await release.promise;return response;
    }
  }});
  const creating=f.command('create',createValue);
  await Promise.race([started.promise,creating.then(()=>assert.fail('Key creation never started'))]);
  f.service.invalidate();
  assert.equal(signal.aborted,false);
  assert.equal(f.state.rows.length,1);
  assert.equal(f.count('/api/token/','POST'),1);
  release.resolve();
  assert.deepEqual(await creating,{ok:false,code:'ACCOUNT_CHANGED'});
  assert.equal(f.connections.length,0);
  assert.equal(f.calls.some(call=>call.route.endsWith('/key')),false);
  const pending=JSON.parse(fs.readFileSync(f.journalFile,'utf8')).entries[0];
  assert.equal(pending.state,'pending');assert.equal(pending.requestId,REQUEST_ID);noSecret(pending);
  const recovered=await f.command('recover',{group:IMAGE});
  assert.equal(recovered.code,'CONNECTED');assert.equal(f.count('/api/token/','POST'),1);
  assert.equal(f.connections.length,1);assert.equal(f.connections[0].requestId,REQUEST_ID);
  assert.equal(f.configured.length,1);assert.equal(f.failures.length,0);
});

const {createNativeAuth}=require('../electron/account-auth.cjs');
const AUTH_ID='Q'.repeat(43),AUTH_PROOF='local.'+'P'.repeat(43),AUTH_FLOW='synthetic-private-mfa-flow';
const AUTH_PASSWORD='Native-password-Sentinel';
const AUTH_PNG='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=';
const authReply=(data,status=200,code)=>({response:{ok:status>=200&&status<300,status},data:{success:status>=200&&status<300,data,...(code?{code,message:'private-backend-error-sentinel'}:{})}});
function nativeAuthFixture(t,options={}){
  const journalFile=options.journalFile||temporary(t),calls=[],adopted=[];
  const state={now:1800000000000,userId:9,status:{turnstile_check:true,auth_challenge_provider:'local-image',password_login_enabled:true,password_register_enabled:true,register_enabled:true,email_verification:true,password_login_encryption_enabled:false,passkey_login:false,user_agreement_enabled:false,privacy_policy_enabled:false,private_status:'private-status-sentinel'},...options.state};
  const bundle=()=>({access_token:ACCESS,token_type:'Bearer',access_expires_at:state.now/1000+300,user:{id:state.userId,username:'tester',role:1},session:{sid:'synthetic-private-session',current:true}});
  const dispatch=({url,body})=>{
    if(url.pathname==='/api/status')return authReply(state.status);
    if(url.pathname==='/api/auth/challenge')return authReply({id:AUTH_ID,image:AUTH_PNG,expires_in:120});
    if(url.pathname==='/api/auth/challenge/verify'){assert.equal(body.id,AUTH_ID);return authReply({token:AUTH_PROOF,expires_in:120});}
    if(url.pathname==='/api/user/login/encryption-key')return authReply(state.encryptionKey);
    if(url.pathname==='/api/user/login')return authReply(state.verification||bundle());
    if(url.pathname==='/api/user/login/verify')return authReply(bundle());
    if(url.pathname==='/api/user/auth/refresh')return authReply(bundle());
    if(url.pathname==='/api/user/self')return authReply({id:state.userId,username:'tester'});
    if(['/api/user/register','/api/verification','/api/reset_password'].includes(url.pathname))return authReply();
    throw Error('Unexpected native auth test route');
  };
  const auth=createNativeAuth({journalFile,now:()=>state.now,
    request:async(route,init)=>{
      assert.match(route,/^\/api\//);assert.equal(route.includes('://'),false);
      const url=new URL(route,'https://synthetic.example.invalid'),body=init.body?JSON.parse(init.body):undefined,call={route:url.pathname,url,init,body};calls.push(call);
      if(['/api/user/login','/api/user/login/verify','/api/user/register','/api/verification','/api/reset_password'].includes(url.pathname)){
        const pending=JSON.parse(fs.readFileSync(journalFile+'.auth','utf8'));
        assert.deepEqual(Object.keys(pending).sort(),['action','at'],'pending metadata is durable before dispatch');
        assert.equal(positiveNativeTime(pending.at),true);
      }
      const result=await options.hook?.({...call,state,calls,bundle,dispatch:()=>dispatch(call)});
      return result===undefined?dispatch(call):result;
    },
    onAuthenticated:async value=>{if(options.onAuthenticated)await options.onAuthenticated(value);adopted.push(value);},
  });
  t.after(()=>auth.dispose());
  return {auth,journalFile,state,calls,adopted,bundle,command:(...args)=>auth.command(...args),count:route=>calls.filter(call=>call.route===route).length,
    async solve(){assert.equal((await auth.command('challenge')).ok,true);assert.equal((await auth.command('answer',{answer:'123456'})).ok,true);}};
}
const positiveNativeTime=value=>Number.isSafeInteger(value)&&value>0;
const nativeLogin={username:'tester',password:AUTH_PASSWORD};
const authNoSecrets=value=>{for(const secret of [AUTH_ID,AUTH_PROOF,AUTH_FLOW,ACCESS,AUTH_PASSWORD,'synthetic-private-session','private-status-sentinel','private-backend-error-sentinel'])assert.equal(JSON.stringify(value).includes(secret),false,secret+' leaked from native authentication');};

test('native auth exposes only status, captcha image and fixed public verification metadata',async t=>{
  const f=nativeAuthFixture(t),status=await f.command('auth-status');
  assert.equal(status.ok,true);assert.equal(status.status.auth_challenge_provider,'local-image');assert.equal(status.unknown,null);authNoSecrets(status);
  const challenge=await f.command('challenge');assert.deepEqual(challenge,{ok:true,required:true,image:AUTH_PNG,expiresIn:120});authNoSecrets(challenge);
  const answer=await f.command('answer',{answer:'123456'});assert.deepEqual(answer,{ok:true,verified:true,expiresIn:120});authNoSecrets(answer);
  const result=await f.command('login',nativeLogin);assert.deepEqual(result,{ok:true,signedIn:true});authNoSecrets(result);
  assert.equal(f.adopted.length,1);assert.equal(f.adopted[0].user.id,9);
  assert.equal(f.calls.find(call=>call.route==='/api/user/self').init.headers.Authorization,'Bearer '+ACCESS);
  assert.equal(fs.existsSync(f.journalFile+'.auth'),false);
  assert.equal((await f.command('login',nativeLogin)).code,'CHALLENGE_REQUIRED');assert.equal(f.count('/api/user/login'),1);
});

test('native auth rejects unknown fields, malformed input and unsupported captcha without a bypass',async t=>{
  const f=nativeAuthFixture(t);
  for(const [action,value] of [['proxy',{}],['auth-status',{url:'https://example.invalid'}],['login',{...nativeLogin,url:'https://example.invalid'}],['answer',{answer:'12345'}],['register',{username:'tester',password:'short'}]]){
    assert.equal((await f.command(action,value)).ok,false);
  }
  assert.equal(f.count('/api/user/login'),0);assert.equal(f.count('/api/user/register'),0);assert.equal(f.count('/api/auth/challenge/verify'),0);
  f.state.status.auth_challenge_provider='turnstile';await f.command('auth-status');
  assert.equal((await f.command('challenge')).code,'METHOD_UNAVAILABLE');
  assert.equal((await f.command('login',nativeLogin)).code,'METHOD_UNAVAILABLE');assert.equal(f.count('/api/user/login'),0);
});

test('native captcha question and proof expire and cannot be submitted twice',async t=>{
  const f=nativeAuthFixture(t);await f.command('challenge');f.state.now+=120000;
  assert.equal((await f.command('answer',{answer:'123456'})).code,'CHALLENGE_REQUIRED');assert.equal(f.count('/api/auth/challenge/verify'),0);
  await f.solve();assert.equal((await f.command('answer',{answer:'123456'})).code,'CHALLENGE_REQUIRED');
  f.state.now+=120000;assert.equal((await f.command('login',nativeLogin)).code,'CHALLENGE_REQUIRED');assert.equal(f.count('/api/user/login'),0);
});

test('native MFA flow and access credentials remain in the main process until complete self-identity verification',async t=>{
  const f=nativeAuthFixture(t,{state:{verification:{require_verification:true,flow_token:AUTH_FLOW,expires_at:1800000200,methods:[{method:'2fa',available:true},{method:'passkey',available:false}]}}});
  await f.solve();const result=await f.command('login',nativeLogin);
  assert.deepEqual(result,{ok:true,signedIn:false,verification:{required:true,methods:['2fa'],expiresAt:1800000200}});authNoSecrets(result);assert.equal(f.adopted.length,0);
  assert.equal((await f.command('verify',{code:'12'})).code,'INVALID_CODE');assert.equal(f.count('/api/user/login/verify'),0);
  assert.deepEqual(await f.command('verify',{code:'AB12-CD34'}),{ok:true,signedIn:true});assert.equal(f.adopted.length,1);
  assert.equal(f.calls.find(call=>call.route==='/api/user/login/verify').body.flow_token,AUTH_FLOW);
  assert.equal((await f.command('verify',{code:'123456'})).code,'AUTH_FLOW_INVALID');
});

test('native MFA never downgrades passkey-only verification to a password or a code',async t=>{
  const f=nativeAuthFixture(t,{state:{verification:{require_verification:true,flow_token:AUTH_FLOW,expires_at:1800000200,methods:[{method:'passkey',available:true},{method:'2fa',available:false}]}}});
  await f.solve();assert.equal((await f.command('login',nativeLogin)).signedIn,false);
  assert.equal((await f.command('verify',{code:'123456'})).code,'METHOD_UNAVAILABLE');assert.equal(f.count('/api/user/login/verify'),0);assert.equal(f.adopted.length,0);
  f.state.now+=200000;assert.equal((await f.command('verify',{code:'123456'})).code,'AUTH_FLOW_INVALID');
});

test('native login with a lost response remains durable across invalidation and restart and is reconciled without replay',async t=>{
  const f=nativeAuthFixture(t,{hook:({route})=>{if(route==='/api/user/login')throw Error('private-backend-error-sentinel');}});
  await f.solve();const result=await f.command('login',nativeLogin);assert.equal(result.code,'NETWORK');assert.equal(result.unknown.action,'login');authNoSecrets(result);
  const record=JSON.parse(fs.readFileSync(f.journalFile+'.auth','utf8'));assert.deepEqual(record,{action:'login',at:f.state.now});authNoSecrets(record);
  f.auth.invalidate();assert.equal((await f.command('login',nativeLogin)).code,'RESULT_UNKNOWN');assert.equal(f.count('/api/user/login'),1);f.auth.dispose();
  const resumed=nativeAuthFixture(t,{journalFile:f.journalFile});assert.equal((await resumed.command('login',nativeLogin)).code,'RESULT_UNKNOWN');
  const recovered=await resumed.command('reconcile');assert.deepEqual(recovered,{ok:true,signedIn:true,reconciled:true,unknown:null});authNoSecrets(recovered);
  assert.equal(resumed.count('/api/user/login'),0);assert.equal(resumed.count('/api/user/auth/refresh'),1);assert.equal(resumed.adopted.length,1);assert.equal(fs.existsSync(f.journalFile+'.auth'),false);
});

test('native uncertain registration and email requests stay unresolved after refresh until an explicit restart',async t=>{
  for(const [action,value,route] of [['register',{...nativeLogin,email:'synthetic@example.invalid',code:'123456'},'/api/user/register'],['send-code',{email:'synthetic@example.invalid'},'/api/verification'],['forgot',{email:'synthetic@example.invalid'},'/api/reset_password']]){
    const f=nativeAuthFixture(t,{hook:call=>call.route===route?authReply(undefined,503,'PRIVATE_REJECTED'):undefined});
    await f.solve();const result=await f.command(action,value);assert.equal(result.unknown.action,action);authNoSecrets(result);
    const reconciled=await f.command('reconcile');assert.equal(reconciled.signedIn,true);assert.equal(reconciled.reconciled,false);assert.equal(reconciled.unknown.action,action);
    assert.equal((await f.command(action,value)).code,'RESULT_UNKNOWN');assert.equal(f.count(route),1);
    f.auth.invalidate();assert.equal(JSON.parse(fs.readFileSync(f.journalFile+'.auth','utf8')).action,action);
    assert.deepEqual(await f.command('restart'),{ok:true});assert.equal(f.count(route),1);assert.equal(fs.existsSync(f.journalFile+'.auth'),false);
  }
});

test('native known rejections clear only the pending metadata and never retry the request automatically',async t=>{
  const f=nativeAuthFixture(t,{hook:({route})=>route==='/api/user/login'?authReply(undefined,401,'PRIVATE_BACKEND_CODE'):undefined});
  await f.solve();const result=await f.command('login',nativeLogin);assert.deepEqual(result,{ok:false,code:'LOGIN_REQUIRED'});authNoSecrets(result);
  assert.equal(fs.existsSync(f.journalFile+'.auth'),false);assert.equal(f.count('/api/user/login'),1);assert.equal(f.adopted.length,0);
});

test('native account mismatch or a failed post-login self-check retains the original login intent',async t=>{
  for(const failure of ['mismatch','network']){
    const f=nativeAuthFixture(t,{hook:({route})=>{if(route==='/api/user/self'){if(failure==='network')throw Error('synthetic disconnection');return authReply({id:10});}}});
    await f.solve();const result=await f.command('login',nativeLogin);assert.equal(result.ok,false);assert.equal(result.unknown.action,'login');assert.equal(f.adopted.length,0);
    assert.equal((await f.command('login',nativeLogin)).code,'RESULT_UNKNOWN');assert.equal(f.count('/api/user/login'),1);
  }
});

test('native cancelled navigation cannot adopt a delayed login and preserves the dispatched operation',async t=>{
  const started=deferred(),release=deferred();t.after(()=>release.resolve());
  const f=nativeAuthFixture(t,{hook:async({route,bundle})=>{if(route==='/api/user/login'){started.resolve();await release.promise;return authReply(bundle());}}});
  await f.solve();const pending=f.command('login',nativeLogin);await started.promise;f.auth.invalidate();release.resolve();
  const result=await pending;assert.equal(result.code,'ACCOUNT_CHANGED');assert.equal(result.unknown.action,'login');assert.equal(f.adopted.length,0);assert.equal(f.count('/api/user/self'),0);
});

test('native duplicate login clicks send at most one request even without the outer service queue',async t=>{
  const f=nativeAuthFixture(t);f.state.status.turnstile_check=false;
  const values=await Promise.all([f.command('login',nativeLogin),f.command('login',nativeLogin)]);
  assert.equal(f.count('/api/user/login'),1);assert.equal(f.adopted.length,1);assert.equal(values.filter(value=>value.signedIn).length,1);assert.equal(values.filter(value=>value.code==='BUSY').length,1);
});

test('native registration validates required email proof and never logs in or creates a Key automatically',async t=>{
  const f=nativeAuthFixture(t);f.state.status.user_agreement_enabled=true;
  await f.solve();assert.equal((await f.command('register',nativeLogin)).code,'CONSENT_REQUIRED');
  assert.equal((await f.command('register',{...nativeLogin,consent:true})).code,'INVALID_INPUT');
  const result=await f.command('register',{...nativeLogin,email:'synthetic@example.invalid',code:' 123456 ',consent:true});assert.deepEqual(result,{ok:true,registered:true});authNoSecrets(result);
  const sent=f.calls.find(call=>call.route==='/api/user/register');assert.equal(sent.body.verification_code,'123456');assert.equal(sent.url.searchParams.get('turnstile'),AUTH_PROOF);
  assert.equal(f.count('/api/user/login'),0);assert.equal(f.adopted.length,0);assert.equal(f.calls.some(call=>call.route.startsWith('/api/token')),false);
});

test('native password encryption uses existing RSA-OAEP and long-Unicode AES-GCM envelopes without plaintext fallback',async t=>{
  const crypto=require('node:crypto'),keys=crypto.generateKeyPairSync('rsa',{modulusLength:2048});
  for(const password of [AUTH_PASSWORD,'密'.repeat(128)]){
    const f=nativeAuthFixture(t);Object.assign(f.state.status,{turnstile_check:false,password_login_encryption_enabled:true});f.state.encryptionKey={enabled:true,kid:'synthetic-kid',public_key:keys.publicKey.export({type:'spki',format:'pem'})};
    assert.equal((await f.command('login',{username:'tester',password})).signedIn,true);
    const body=f.calls.find(call=>call.route==='/api/user/login').body;assert.equal(Object.hasOwn(body,'password'),false);assert.equal(body.encryption_key_id,'synthetic-kid');
    if(body.password_encrypted.startsWith('v2.')){
      const [,wrapped,nonce,payload]=body.password_encrypted.split('.'),secret=crypto.privateDecrypt({key:keys.privateKey,oaepHash:'sha256',oaepLabel:Buffer.from('password-v2')},Buffer.from(wrapped,'base64'));
      const bytes=Buffer.from(payload,'base64'),decipher=crypto.createDecipheriv('aes-256-gcm',secret,Buffer.from(nonce,'base64'));decipher.setAAD(Buffer.from('password-v2:synthetic-kid'));decipher.setAuthTag(bytes.subarray(-16));
      assert.equal(Buffer.concat([decipher.update(bytes.subarray(0,-16)),decipher.final()]).toString(),password);
    }else assert.equal(crypto.privateDecrypt({key:keys.privateKey,oaepHash:'sha256'},Buffer.from(body.password_encrypted,'base64')).toString(),password);
  }
  const broken=nativeAuthFixture(t);Object.assign(broken.state.status,{turnstile_check:false,password_login_encryption_enabled:true});broken.state.encryptionKey={enabled:false};
  assert.equal((await broken.command('login',nativeLogin)).code,'ENCRYPTION_UNAVAILABLE');assert.equal(broken.count('/api/user/login'),0);assert.equal(fs.existsSync(broken.journalFile+'.auth'),false);
});

test('native login accepts an existing long email while registration keeps the backend username bound',async t=>{
  const f=nativeAuthFixture(t);f.state.status.turnstile_check=false;
  const account='existing-long-account-identifier@example.invalid';
  assert.equal((await f.command('login',{username:account,password:AUTH_PASSWORD})).signedIn,true);
  assert.equal(f.calls.find(call=>call.route==='/api/user/login').body.username,account);
  assert.equal((await f.command('register',{username:account,password:AUTH_PASSWORD,email:'synthetic@example.invalid',code:'123456'})).code,'INVALID_INPUT');
  assert.equal(f.count('/api/user/register'),0);
});

test('native corrupt or unwritable auth journal fails closed before authentication dispatch',async t=>{
  for(const content of ['{broken',JSON.stringify({action:'login',at:1800000000000,password:AUTH_PASSWORD}),JSON.stringify({action:'other',at:1800000000000})]){
    const journalFile=temporary(t);fs.writeFileSync(journalFile+'.auth',content);const f=nativeAuthFixture(t,{journalFile});
    assert.equal((await f.command('login',nativeLogin)).code,'STORAGE_UNAVAILABLE');assert.equal(f.count('/api/user/login'),0);assert.equal((await f.command('restart')).code,'STORAGE_UNAVAILABLE');
    assert.equal((await f.command('reconcile')).code,'STORAGE_UNAVAILABLE');assert.equal(f.count('/api/user/auth/refresh'),0);
  }
  const f=nativeAuthFixture(t);f.state.status.turnstile_check=false;fs.mkdirSync(f.journalFile+'.auth');
  assert.equal((await f.command('login',nativeLogin)).code,'STORAGE_UNAVAILABLE');assert.equal(f.count('/api/user/login'),0);assert.equal(fs.lstatSync(f.journalFile+'.auth').isDirectory(),true);
});

test('a verified snapshot uses the same account and never dispatches retired authentication actions',async t=>{
  const f=fixture(t,{getConnectedAccountId:()=>9});
  for(const action of ['auth-unknown','auth-login','auth-register','auth-email','auth-status','payment-options','payment-quote','payment-create','payment-open']){
    assert.equal((await f.command(action,{})).code,'INVALID_REQUEST');
  }
  assert.equal(f.calls.length,0);
  const snapshot=await f.command('snapshot');
  assert.equal(snapshot.signedIn,true);assert.equal(snapshot.user.id,9);assert.equal(snapshot.accountMatched,true);noSecret(snapshot);
  assert.equal(f.count('/api/token/','POST'),0);
  assert.equal(f.connections.length,0);
  assert.equal((await f.command('create',createValue)).ok,true);
  assert.equal(f.connections[0].userId,9);
});

test('account mismatch blocks Key writes and browser recharge before dispatch',async t=>{
  const f=fixture(t,{getConnectedAccountId:()=>8,browserCipher:{isEncryptionAvailable:()=>true}});
  const snapshot=await f.command('snapshot');
  assert.equal(snapshot.user.id,9);assert.equal(snapshot.accountMatched,false);
  for(const [action,value] of [['create',createValue],['enable',{group:IMAGE,id:41}],['recover',{group:IMAGE}],['browser-open',{}]]){
    assert.equal((await f.command(action,value)).code,'ACCOUNT_MISMATCH');
  }
  assert.equal(f.connections.length,0);
  assert.equal(f.count('/api/token/','POST'),0);
  assert.equal(f.calls.some(call=>call.route.endsWith('/key')),false);
  assert.equal(f.count('/api/user/desktop/start'),0);
});

test('an account change prevents enabling the previous account’s selected Key',async t=>{
  const f=fixture(t);
  f.state.rows=[f.makeRow({id:41})];
  await f.command('keys',{group:IMAGE});
  f.service.invalidate();
  Object.assign(f.state,{userId:10,sid:'synthetic-other-session'});
  assert.equal((await f.command('snapshot')).user.id,10);
  assert.equal((await f.command('enable',{group:IMAGE,id:41})).code,'INVALID_REQUEST');
  assert.equal(f.count('/api/token/41/key'),0);
  assert.equal(f.connections.length,0);
});
