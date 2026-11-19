import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source=fs.readFileSync(new URL('../public/account.mjs',import.meta.url),'utf8');
const initial={relayMode:true,configured:false,videoConfigured:false,keyStorage:'protected'};
const json=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});
const connection=(image={},video={},tools={})=>({checkedAt:123,image:{configured:false,state:'unconfigured',connected:false,modelCount:0,...image},video:{configured:false,state:'unconfigured',connected:false,modelCount:0,...video},tools:{digital:false,depth:false,...tools}});
const ready={configured:true,state:'ready',connected:true,modelCount:1};

function fixture({config=initial,respond=()=>json(connection()),confirmed=true}={}){
  const elements=new Map(),calls=[],events=[],removed=[];
  let navigated=0;
  const element=id=>{
    if(!elements.has(id))elements.set(id,{id,textContent:'',innerHTML:'',dataset:{},value:'',disabled:false,hidden:false,attributes:{},setAttribute(name,value){this.attributes[name]=value;},remove(){this.removed=true;},click(){navigated++;}});
    return elements.get(id);
  };
  const dashboard=element('dashboard');
  const context={
    document:{getElementById:element,querySelector:selector=>selector==='.account-dashboard'?dashboard:selector.startsWith('.rail-item[data-view="')?element(selector):null},
    fetch:async(path,options={})=>{
      calls.push({path,options});
      if(path==='/api/config'&&!options.method)return json(config);
      return respond(path,options);
    },
    Event:class{constructor(type){this.type=type;}},
    window:{dispatchEvent:event=>{events.push({type:event.type,image:element('relayImageKey').value,video:element('relayVideoKey').value,summary:element('relayKeySummary').textContent});}},
    localStorage:{removeItem:name=>removed.push(name),setItem:()=>assert.fail('Key must not be stored in browser storage')},
    location:{reload:()=>assert.fail('saving Key must not reload the app')},
    confirm:()=>typeof confirmed==='function'?confirmed():confirmed,
  };
  const initialized=vm.runInNewContext(`(async()=>{${source}\n})()`,context);
  return {initialized,element,dashboard,calls,events,removed,get navigated(){return navigated;}};
}
const submit=fixture=>fixture.element('relayKeyForm').onsubmit({preventDefault(){}});

test('recheck refreshes callable lines without saving Keys, and tool-only access can start',async()=>{
  const app=fixture({config:{...initial,videoConfigured:true},respond:()=>json(connection({}, {configured:true,state:'unavailable',modelCount:0},{digital:true,depth:true}))});
  await app.initialized;assert.equal(app.element('startRelay').disabled,false);
  app.element('startRelay').onclick();assert.equal(app.navigated,1);
  const before=app.calls.length;await app.element('recheckRelay').onclick();
  assert.deepEqual(app.calls.slice(before).map(call=>[call.path,call.options.method]),[['/api/relay/connection',undefined]]);
  assert.deepEqual(app.events.map(event=>event.type),['hamster-relay-catalog-refresh']);
  assert.match(app.element('relayToolStatus').textContent,/数字人：已开放；黑白深度视频：已开放/);
});

test('first run provides three steps and no connection or paid request without a Key',async()=>{
  const app=fixture();await app.initialized;
  assert.equal(app.calls.length,1);assert.equal(app.calls[0].path,'/api/config');
  for(const text of ['注册、充值并创建 Key','填写对应 Key，自动检测','确认连接，开始使用','空白保留已保存的对应 Key','不创建生成任务，不扣费'])assert.ok(app.dashboard.innerHTML.includes(text));
  assert.match(app.dashboard.innerHTML,/https:\/\/www\.piknoai\.com/);
  assert.equal(app.element('startRelay').disabled,true);
  assert.equal(app.element('recheckRelay').disabled,true);
  assert.equal(app.element('relayStorageWarning').hidden,true);
  assert.equal(app.element('rechargeDialog').removed,true);
  assert.doesNotMatch(app.dashboard.innerHTML,/支付宝充值|邮箱注册|可用余额（元）/);
});

test('saved Key triggers free detection on opening, with independent image/video and tool states',async()=>{
  const app=fixture({config:{...initial,configured:true,videoConfigured:true},respond:()=>json(connection(ready,{configured:true,state:'error',message:'sanbao sk-secret https://upstream.test'},{}))});
  await app.initialized;
  assert.deepEqual(app.calls.map(call=>call.path),['/api/config','/api/relay/connection']);
  assert.equal(app.calls[1].options.method,undefined);assert.equal(app.calls[1].options.cache,'no-store');
  assert.match(app.element('relayImageConnection').textContent,/已可调用 1 条线路/);
  assert.match(app.element('relayVideoConnection').textContent,/检测未通过/);
  assert.match(app.element('relayToolStatus').textContent,/数字人：尚未开放；黑白深度视频：尚未开放/);
  assert.doesNotMatch(app.element('relayVideoConnection').textContent,/sanbao|sk-|upstream/);
  assert.equal(app.element('startRelay').disabled,false);
});

test('saving one Key trims input, clears fields, preserves the other feature and updates without reload',async()=>{
  const app=fixture({config:{...initial,videoConfigured:true},respond:(path,options)=>path==='/api/config'?json({ok:true,...initial,configured:true,videoConfigured:true}):json(connection(ready,ready))});
  await app.initialized;app.calls.length=0;
  app.element('relayImageKey').value='  image-test-only  ';
  await submit(app);
  assert.deepEqual(app.calls.map(call=>call.path),['/api/config','/api/relay/connection']);
  assert.deepEqual(JSON.parse(app.calls[0].options.body),{piknoImageKey:'image-test-only',piknoVideoKey:'',piknoToolKey:''});
  assert.equal(app.calls[0].options.method,'POST');
  assert.equal(app.element('relayImageKey').value,'');assert.equal(app.element('relayVideoKey').value,'');
  assert.match(app.element('relayKeySummary').textContent,/图片：已配置；视频：已配置/);
  assert.equal(app.events.length,1);assert.equal(app.events[0].type,'hamster-relay-configured');
  assert.equal(app.events[0].image,'');assert.match(app.events[0].summary,/视频：已配置/);
  assert.deepEqual(app.removed,['hamster_wallet_model_cache_v1']);
});

test('blank inputs can validate existing configuration and never imply removal',async()=>{
  const app=fixture({config:{...initial,configured:true},respond:path=>path==='/api/config'?json({ok:true,...initial,configured:true}):json(connection(ready))});
  await app.initialized;app.calls.length=0;await submit(app);
  assert.deepEqual(JSON.parse(app.calls[0].options.body),{piknoImageKey:'',piknoVideoKey:'',piknoToolKey:''});
  assert.match(app.element('relayKeySummary').textContent,/图片：已配置/);
  assert.ok(app.dashboard.innerHTML.includes('首次配置时空白表示未配置'));
});
test('individual removal is explicit and may be combined with replacing another Key',async()=>{
  for(const [kind,field] of [['Image','configured'],['Video','videoConfigured'],['Tool','toolConfigured']]){
    const app=fixture({config:{...initial,configured:true,videoConfigured:true,toolConfigured:true},respond:path=>path==='/api/config'?json({ok:true,...initial,configured:true,videoConfigured:true,toolConfigured:true,[field]:false}):json(connection(ready,ready))});
    await app.initialized;app.calls.length=0;
    const checkbox=app.element('removeRelay'+kind+'Key'),input=app.element('relay'+kind+'Key');input.value='discarded-new-value';checkbox.checked=true;checkbox.onchange();assert.equal(input.value,'');assert.equal(input.disabled,true);
    await submit(app);const payload=JSON.parse(app.calls[0].options.body);assert.equal(payload['remove_'+kind.toLowerCase()],true);assert.equal(payload['pikno'+kind+'Key'],'');assert.equal(app.calls[0].path,'/api/config');assert.equal(checkbox.checked,false);assert.equal(checkbox.disabled,true);assert.equal(app.events[0].type,'hamster-relay-configured');
  }
});

test('invalid Key and mixed account rejection keep current configuration and never expose backend errors',async()=>{
  for(const code of [400,401,403,409,500]){
    const app=fixture({config:{...initial,configured:true},respond:path=>path==='/api/config'?json({error:'packy sk-secret https://private.test'},code):json(connection(ready))});
    await app.initialized;app.calls.length=0;app.element('relayImageKey').value='candidate-only';
    await submit(app);
    assert.equal(app.calls.length,1);assert.equal(app.events.length,0);
    assert.equal(app.element('relayImageKey').value,'candidate-only');
    assert.match(app.element('relayKeySummary').textContent,/图片：已配置/);
    assert.doesNotMatch(app.element('relayAccountStatus').textContent,/packy|sk-|private/);
    assert.equal(app.element('saveRelayKeys').disabled,false);
    if(code===409)assert.match(app.element('relayAccountStatus').textContent,/同时替换全部已配置 Key/);
  }
});

test('recheck is single-flight, prevents save/disconnect races and uses only free GET',async()=>{
  let release,pending=false;
  const app=fixture({config:{...initial,configured:true},respond:()=>pending?new Promise(resolve=>{release=resolve;}):json(connection(ready))});
  await app.initialized;app.calls.length=0;pending=true;
  const checking=app.element('recheckRelay').onclick();
  assert.equal(app.element('recheckRelay').disabled,true);assert.equal(app.element('saveRelayKeys').disabled,true);
  assert.equal(app.element('relayImageKey').disabled,true);
  assert.equal(app.element('startRelay').disabled,true);
  await app.element('recheckRelay').onclick();await submit(app);await app.element('disconnectRelay').onclick();
  assert.equal(app.calls.length,1);assert.equal(app.calls[0].path,'/api/relay/connection');
  assert.equal(app.calls[0].options.method,undefined);
  release(json(connection(ready)));await checking;
  assert.equal(app.element('recheckRelay').disabled,false);assert.equal(app.element('saveRelayKeys').disabled,false);
});

test('closed lines and malformed counts do not enable start; tools are explicitly unavailable',async()=>{
  for(const result of [connection({configured:true,state:'unavailable',connected:true,modelCount:0}),connection({...ready,modelCount:Infinity})]){
    const app=fixture({config:{...initial,configured:true},respond:()=>json(result)});await app.initialized;
    assert.equal(app.element('startRelay').disabled,true);
    assert.match(app.element('relayToolStatus').textContent,/尚未开放/);
    app.element('startRelay').onclick();assert.equal(app.navigated,0);
  }
});

test('detection failures retain configured flags and show fixed safe retry message',async()=>{
  const app=fixture({config:{...initial,videoConfigured:true},respond:()=>{throw Error('runninghub sk-secret https://private.test');}});
  await app.initialized;
  assert.match(app.element('relayKeySummary').textContent,/视频：已配置/);
  assert.match(app.element('relayAccountStatus').textContent,/已保存的 Key 未被删除/);
  assert.doesNotMatch(app.element('relayAccountStatus').textContent,/runninghub|sk-|private/);
  assert.equal(app.element('saveRelayKeys').disabled,false);assert.equal(app.element('startRelay').disabled,true);
});

test('successful save remains confirmed even if subsequent detection cannot connect',async()=>{
  const app=fixture({respond:path=>path==='/api/config'?json({ok:true,...initial,configured:true}):Promise.reject(Error('private endpoint'))});
  await app.initialized;app.element('relayImageKey').value='candidate-only';await submit(app);
  assert.equal(app.element('relayImageKey').value,'');assert.equal(app.events[0].type,'hamster-relay-configured');
  assert.match(app.element('relayKeySummary').textContent,/图片：已配置/);
  assert.match(app.element('relayAccountStatus').textContent,/已保存的 Key 未被删除/);
});

test('memory mode is clearly warned and protected storage hides the warning',async()=>{
  const app=fixture({config:{...initial,keyStorage:'memory'}});await app.initialized;
  assert.equal(app.element('relayStorageWarning').hidden,false);
  assert.ok(app.dashboard.innerHTML.includes('关闭应用后需要重新填写'));
});

test('disconnect requires confirmation, removes both locally and preserves user data without reload',async()=>{
  let allow=false;
  const app=fixture({config:{...initial,configured:true,videoConfigured:true},confirmed:()=>allow,respond:path=>path==='/api/relay/disconnect'?json({ok:true,...initial}):json(connection(ready,ready))});
  await app.initialized;app.calls.length=0;
  await app.element('disconnectRelay').onclick();assert.equal(app.calls.length,0);
  allow=true;await app.element('disconnectRelay').onclick();
  assert.equal(app.calls.length,1);assert.equal(app.calls[0].path,'/api/relay/disconnect');assert.equal(app.calls[0].options.method,'POST');
  assert.match(app.element('relayKeySummary').textContent,/图片：未配置；视频：未配置/);
  assert.deepEqual(app.events.map(event=>event.type),['hamster-session-invalidated','hamster-relay-configured']);
  assert.match(app.element('relayAccountStatus').textContent,/余额及本地素材、聊天和任务文件保持不变/);
  assert.equal(app.element('startRelay').disabled,true);assert.equal(app.element('recheckRelay').disabled,true);
});

test('start navigates to generation only after usable connection and never submits a paid request',async()=>{
  const app=fixture({config:{...initial,configured:true},respond:()=>json(connection(ready))});await app.initialized;
  app.element('startRelay').onclick();assert.equal(app.navigated,1);
  assert.deepEqual(app.calls.map(call=>call.path),['/api/config','/api/relay/connection']);
  assert.equal(app.events.length,0);
  assert.doesNotMatch(source,/(?:image|video|tool)\.on(?:input|change)|location\.reload|\/v1\/images|\/v1\/videos/);
});
