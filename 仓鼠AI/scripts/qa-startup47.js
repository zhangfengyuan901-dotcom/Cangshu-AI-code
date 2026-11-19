async (page) => {
  const control='http://127.0.0.1:11247',results=[],failures=[],pageErrors=[],external=[];
  const assert=(value,message)=>{if(!value)throw Error(message);};
  const api=async(route,body)=>{const response=body===undefined?await page.request.get(control+route):await page.request.post(control+route,{data:body});const value=await response.json();assert(response.ok(),'Fixture '+route+' failed');return value;};
  const counts=state=>({accountOpen:state.calls.accountOpen,accountClose:state.calls.accountClose,connections:state.requests.filter(value=>value.path==='/api/relay/connection').length,models:state.requests.filter(value=>value.path==='/api/models').length,identity:state.upstream.filter(value=>value.path==='/v1/client/context').length,modelPermissions:state.upstream.filter(value=>value.path==='/v1/models').length,publicCatalog:state.upstream.filter(value=>value.path==='/api/pikno/catalog').length,paid:state.calls.paid,keyWrites:state.calls.keyWrites,keyClears:state.calls.keyClears,assetReads:state.assetReads,cli:state.calls.cli,python:state.calls.python,syntheticLauncherPrepare:state.calls.launcherPrepare,syntheticLauncherOpen:state.calls.launcherOpen,syntheticCodexStatus:state.calls.codexStatus});
  const current=()=>page.locator('.view.active').getAttribute('data-panel');
  await page.context().route('**/*',async route=>{const url=new URL(route.request().url());if(url.protocol==='http:'&&url.hostname==='127.0.0.1')return route.continue();external.push({protocol:url.protocol});return route.abort('blockedbyclient');});
  page.on('pageerror',()=>pageErrors.push('pageerror'));
  await page.addInitScript(()=>{
    if(window.__startupQa47)return;
    window.__startupQa47={transitions:[],ready:[],first:null};let last='';
    const record=()=>{const active=document.querySelector('.view.active')?.dataset.panel||null,state=document.body?.dataset.startupState||null,key=state+':'+active;if(key!==last){last=key;window.__startupQa47.transitions.push({view:active,state,at:Date.now()});}};
    new MutationObserver(record).observe(document,{childList:true,subtree:true,attributes:true,attributeFilter:['class','data-startup-state']});
    document.addEventListener('DOMContentLoaded',()=>{record();window.__startupQa47.first={view:document.querySelector('.view.active')?.dataset.panel,state:document.body?.dataset.startupState};});
    window.addEventListener('hamster-startup-ready',event=>{window.__startupQa47.ready.push({view:event.detail?.view,at:Date.now()});record();});
  });
  await page.setViewportSize({width:1200,height:900});
  const inspect=()=>page.evaluate(()=>({view:document.querySelector('.view.active')?.dataset.panel,state:document.body?.dataset.startupState,storageState:document.querySelector('#storageStatus')?.dataset.state,storageLabel:document.querySelector('#storageStatus')?.getAttribute('aria-label'),connection:document.querySelector('#relayAccountStatus')?.textContent,progress:document.querySelector('#billingConnection')?.textContent||null,generateButtonDisabled:document.querySelector('#generationForm button[type=submit]')?.disabled,advancedOpen:document.querySelector('.relay-advanced')?.open,performance:{fcpMs:performance.getEntriesByName('first-contentful-paint')[0]?.startTime??null,localReadyMs:performance.getEntriesByName('hamster-local-ready')[0]?.startTime??null},trace:window.__startupQa47}));
  const ready=async()=>{await page.waitForFunction(()=>document.body?.dataset.startupState==='ready');await page.locator('#relayImageConnection').waitFor({state:'attached'});await page.waitForTimeout(350);};
  const start=async input=>{await page.goto('about:blank');const info=await api('/case',input);await page.goto(info.base,{waitUntil:'domcontentloaded'});await ready();return info;};
  const save=async(name,extra={})=>{const ui=await inspect(),state=await api('/state');const count=counts(state);assert(count.paid===0&&count.keyWrites===0&&count.keyClears===0&&count.cli===0&&count.python===0,'Unrequested operation in '+name);assert(state.blockedFetches===0,'External fixture fetch in '+name);results.push({name,ui,counts:count,keyFlags:state.keyFlags,requests:state.requests,upstream:state.upstream,...extra});return {ui,state,count};};
  try {
    let info=await start({keys:[]});
    assert(await current()==='account','New user must start on account');
    let item=await save('new-customer');
    assert(!item.ui.trace.transitions.some(value=>value.view==='generate'),'New user generation flash');
    assert(item.count.assetReads===0&&item.count.models===0&&item.count.connections===0&&item.count.identity===0,'New user eager operations');
    assert(item.state.requests.filter(value=>value.path==='/api/startup').every(value=>value.light),'Heavy startup used');
    const opened=item.state.requests.filter(value=>value.path==='/api/relay/account-view/open');assert(opened.length===1,'Visible new account should open exactly once');
    assert(item.ui.trace.ready.length===1&&opened[0].at>=item.ui.trace.ready[0].at,'Account opened before local startup was ready');
    await page.screenshot({path:'D:/PIKNO/output/playwright/startup47-new-account.png',fullPage:true});

    info=await start({keys:['image'],lastView:'history',seedLocal:true});
    assert(await current()==='history','Configured history was not restored');
    await page.getByText('合成本地历史记录47',{exact:true}).first().waitFor({state:'attached'});
    item=await save('cold-history');
    assert(item.count.accountOpen===0&&item.count.connections===0&&item.count.models===0&&item.count.identity===0&&item.count.assetReads===0,'History eagerly connected unrelated modules');
    await page.screenshot({path:'D:/PIKNO/output/playwright/startup47-history.png',fullPage:true});

    await page.locator('.rail-item[data-view="assets"]').click();
    await page.getByText('合成本地素材47',{exact:true}).waitFor();
    await page.waitForFunction(()=>document.querySelector('.view.active')?.dataset.panel==='assets');
    await page.waitForTimeout(100);
    let prefs=await (await page.request.get(info.base+'/api/ui-preferences')).json();
    assert(prefs.uiPreferences.lastView==='assets','Visible navigation was not persisted');
    const old=info;await page.goto('about:blank');info=await api('/restart',{});
    assert(info.base!==old.base&&info.pid!==old.pid,'Fixture did not exit and restart on a new process/port');
    await page.goto(info.base,{waitUntil:'domcontentloaded'});await ready();
    assert(await current()==='assets','Cross-process random-port page restore failed');
    await page.getByText('合成本地素材47',{exact:true}).waitFor();
    item=await save('new-process-port-restore',{differentPort:true,differentPid:true});
    assert(item.count.accountOpen===0&&item.count.identity===0&&item.count.models===0&&item.count.connections===0,'Restored local assets forced authentication');

    info=await start({keys:['image'],lastView:'generate'});
    await page.waitForFunction(()=>document.querySelector('#typeLabel')?.textContent==='图片生成'&&document.querySelector('#modelLabel')?.textContent==='仓鼠图片测试线路');
    await page.waitForFunction(()=>document.querySelector('#storageStatus')?.dataset.state==='ready');
    assert(await current()==='generate','Image-only user cannot enter generation');
    item=await save('image-only-generation');
    assert(item.state.keyFlags.image&&!item.state.keyFlags.video&&!item.state.keyFlags.tool&&!item.state.keyFlags.chat,'Fixture key scope wrong');
    assert(item.count.models>0&&item.count.accountOpen===0,'Image-only function did not load independently');
    await page.screenshot({path:'D:/PIKNO/output/playwright/startup47-image-only.png',fullPage:true});

    info=await start({keys:['image'],lastView:'chat'});
    assert(await current()==='account','Unconfigured saved chat must enter account');
    item=await save('missing-chat-key');
    assert(item.count.models===0&&item.count.python===0&&item.count.cli===0,'Missing chat started a runtime');

    for(const status of [401,403,409]){
      info=await start({keys:['image'],lastView:'generate',fault:status});
      await page.waitForFunction(()=>document.querySelector('.view.active')?.dataset.panel==='account');
      item=await save('invalid-key-'+status);
      assert(item.state.keyFlags.image,'Invalid Key was deleted');assert(item.count.accountOpen===1,'Invalid Key account view missing');
      assert(item.ui.trace.transitions.some(value=>value.view==='account'&&value.state==='ready'),'Invalid Key was not redirected after validation');
    }

    info=await start({keys:['image'],lastView:'generate',fault:429});
    await page.waitForFunction(()=>document.querySelector('#storageStatus')?.dataset.state==='pending');
    item=await save('rate-limit');assert(item.ui.view==='generate'&&item.state.keyFlags.image,'429 falsely invalidated Key or forced registration');
    assert(item.count.accountOpen===0&&item.ui.storageState!=='ready','429 used stale authorization');

    info=await start({keys:['image'],lastView:'generate',fault:'timeout'});
    await page.waitForFunction(()=>document.querySelector('#storageStatus')?.dataset.state==='pending',{timeout:28000});
    item=await save('real-client-read-timeout');assert(item.ui.view==='generate'&&item.state.keyFlags.image,'Timeout falsely invalidated Key');
    assert(item.count.accountOpen===0&&item.ui.storageState!=='ready','Timeout granted authorization');

    await page.goto('about:blank');info=await api('/case',{keys:['image'],lastView:'generate',delayStartup:1300});
    await page.goto(info.base,{waitUntil:'domcontentloaded'});
    await page.locator('.rail-item[data-view="history"]').click();
    await ready();assert(await current()==='history','Late startup response overwrote user navigation');
    item=await save('late-startup-manual-navigation');assert(item.count.accountOpen===0&&item.count.models===0,'Late response mounted an unwanted page');

    info=await start({keys:['image'],lastView:'history',seedLocal:true,fault:'offline'});
    await page.getByText('合成本地历史记录47',{exact:true}).first().waitFor({state:'attached'});
    await page.locator('.rail-item[data-view="assets"]').click();await page.getByText('合成本地素材47',{exact:true}).waitFor();
    item=await save('offline-local-content');assert(item.ui.view==='assets'&&item.ui.storageState!=='ready'&&item.count.identity===0&&item.count.accountOpen===0,'Offline local pages required account or claimed authorization');

    info=await start({keys:['image'],lastView:'history',seedLocal:true,preferenceFailure:true});
    await page.locator('.rail-item[data-view="assets"]').click();await page.getByText('合成本地素材47',{exact:true}).waitFor();
    await page.waitForTimeout(100);item=await save('preference-save-failure');
    assert(item.ui.view==='assets'&&item.state.requests.some(value=>value.path==='/api/ui-preferences'&&value.status===503),'Preference write failure blocked navigation or was not exercised');

    for(const destination of ['history','codex']){
      info=await start({keys:['chat'],lastView:'chat',fault:401,delayIdentity:1800});
      const delayed=page.waitForResponse(response=>response.url().startsWith(info.base+'/api/uploads/status')&&response.status()===401);
      if(destination==='history')await page.locator('.rail-item[data-view="history"]').click();else await page.locator('#codexChatMode').click();
      await delayed;await page.waitForTimeout(100);item=await save('late-chat-401-'+destination);
      assert(item.ui.view===(destination==='history'?'history':'chat'),'Late chat 401 replaced explicit navigation');
      if(destination==='codex')assert(await page.locator('#codexChatMode').getAttribute('aria-pressed')==='true','Late chat response changed mode');
      assert(item.count.accountOpen===0,'Late chat validation opened account');
    }

    assert(pageErrors.length===0,'Browser runtime errors');assert(external.length===0,'Browser attempted nonloopback networking');
    const result={success:true,format:1,scope:'synthetic-loopback-Chrome',cases:results,pageErrors:pageErrors.length,externalRequests:external.length,realCustomerLogins:0,realPayments:0,realKeyCreation:0,realBillableGeneration:0,realCli:0,realPython:0,performanceScope:'Measured FCP and local-ready of loopback fixture only; no acceleration ratio claimed.',notExecuted:['Real customer login/payment/Key activation','Real model generation','Production deployment','Packaged EXE startup']};
    await api('/result',result);return {success:true,cases:results.length,pageErrors:0,output:'output/hamster-onboarding47-20261023/startup-browser.json'};
  } catch(error) {
    failures.push(String(error.message));
    let currentCase;try{currentCase={ui:await inspect(),state:await api('/state')};}catch{}
    await api('/result',{success:false,format:1,cases:results,failures,pageErrors:pageErrors.length,externalRequests:external.length,currentCase});
    throw error;
  }
}
