// Real Electron smoke test against the synthetic local account fixture only.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const {_electron}=require(process.env.HAMSTER_QA_PLAYWRIGHT||'playwright-core');
const output=path.resolve(process.env.HAMSTER_ACCOUNT_QA_OUTPUT||path.resolve(__dirname,'../../output/hamster-relay-ui43-20261023'));fs.mkdirSync(output,{recursive:true});
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hamster-account-electron-'));
async function run(){
  const onboarding=process.env.HAMSTER_ACCOUNT_QA_STARTUP_GATE==='1';
  if(onboarding){const guest=new URL('/__qa/account?id=12&signedIn=false',process.env.HAMSTER_ACCOUNT_QA_URL);assert.equal(guest.hostname,'127.0.0.1');assert.equal((await fetch(guest)).ok,true);}
  const application=await _electron.launch({executablePath:require('electron'),args:[path.join(__dirname,'qa-account-desktop-main.cjs')],env:{...require('../codex-local.cjs').nativeEnvironment(),HAMSTER_ACCOUNT_QA_ROOT:dir,HAMSTER_ACCOUNT_QA_URL:process.env.HAMSTER_ACCOUNT_QA_URL||'http://127.0.0.1:11169/account-lite/index.html',HAMSTER_ACCOUNT_QA_STARTUP_GATE:onboarding?'1':'0',HAMSTER_ACCOUNT_QA_PACKAGED:process.env.HAMSTER_ACCOUNT_QA_PACKAGED==='1'?'1':'0'},timeout:30000});
  try{
    async function capture(name){
      try{
        const png=await application.evaluate(async({BrowserWindow,desktopCapturer})=>{const win=BrowserWindow.getAllWindows()[0],sources=await desktopCapturer.getSources({types:['window'],thumbnailSize:{width:1200,height:900}}),id=win.getMediaSourceId(),source=sources.find(item=>item.id===id||item.id.split(':')[1]===id.split(':')[1]);if(!source||source.thumbnail.isEmpty())throw Error('Native window capture unavailable');return source.thumbnail.toPNG().toString('base64');});
        fs.writeFileSync(path.join(output,name),Buffer.from(png,'base64'));return 'window';
      }catch{await remote.screenshot({path:path.join(output,name.replace('desktop-','view-')),scale:'css'});return 'remote-webcontents';}
    }
    const page=await application.firstWindow();page.setDefaultTimeout(10000);const pageErrors=[];page.on('pageerror',error=>pageErrors.push({surface:'local',name:error.name}));
    let startupGate=null,registration=null,singleFunction=null,hiddenActivation=null;
    if(onboarding){
      await page.waitForFunction(()=>document.body.dataset.startupState==='loading');
      for(let i=0;i<100;i++){if(await application.evaluate(()=>global.__accountQA.observed.startupPending>0))break;await page.waitForTimeout(30);}
      const before=await application.evaluate(()=>global.__accountQA.observed);
      if(before.startupPending!==1)fs.writeFileSync(path.join(output,'native-startup-failure.json'),JSON.stringify({pageErrors,observed:before,page:await page.evaluate(()=>({scripts:[...document.scripts].map(node=>({src:node.src,type:node.type})),startupState:document.body.dataset.startupState,resources:performance.getEntriesByType('resource').map(item=>({name:item.name,status:item.responseStatus}))}))},null,2));
      assert.equal(before.startupPending,1);assert.equal(before.accountViews.filter(item=>item.action==='open').length,0);assert.equal(before.localRequests.filter(item=>item.path==='/api/relay/connection').length,0);
      assert.equal(await page.locator('[data-panel="account"]').evaluate(element=>element.classList.contains('active')),true);
      await page.screenshot({path:path.join(output,'native-startup-pending.png'),scale:'css'});
      assert.equal(await application.evaluate(()=>global.__accountQA.releaseStartup()),1);
      await page.waitForFunction(()=>document.body.dataset.startupState==='ready');startupGate={initialView:'account',openBeforeReady:0,connectionChecksBeforeReady:0,releasedLocalStartup:true};
    }
    await page.evaluate(()=>{window.__nativeConfigEvents=0;window.addEventListener('hamster-relay-native-configured',()=>window.__nativeConfigEvents++);});await page.getByRole('button',{name:'账户',exact:true}).click();
    await page.locator('#relayAccountViewport[data-attached="true"]').waitFor();
    const remote=await application.context().waitForEvent('page',{predicate:item=>item.url().includes('/account-lite/index.html'),timeout:5000}).catch(()=>application.context().pages().find(item=>item.url().includes('/account-lite/index.html')));
    if(!remote)throw Error('Remote view is missing from isolated Electron targets');
    remote.setDefaultTimeout(10000);remote.on('pageerror',error=>pageErrors.push({surface:'remote',name:error.name}));
    if(onboarding){
      await remote.getByRole('heading',{name:'注册仓鼠AI账户',exact:true}).waitFor();
      const signup=await remote.getByRole('link',{name:'注册账户',exact:true}).getAttribute('href'),login=await remote.getByRole('link',{name:'已有账户，登录',exact:true}).getAttribute('href');
      assert.match(signup,/mode=register/);assert.match(login,/mode=login/);assert.equal(await remote.locator('.guest-steps li').count(),3);
      registration={primaryRegister:true,existingLogin:true,threeSteps:true,registrationSubmitted:false};await remote.screenshot({path:path.join(output,'native-registration-guide.png'),scale:'css'});
      await remote.evaluate(async()=>{await fetch('/__qa/account?id=12&signedIn=true');});await remote.reload();
    }
    await remote.getByRole('button',{name:'账户余额',exact:true}).waitFor();
    await remote.locator('#balance-value').filter({hasText:'128.50'}).waitFor();
    const initial=await application.evaluate(({webContents})=>webContents.getAllWebContents().map(item=>({id:item.id,url:item.getURL(),preferences:item.getLastWebPreferences()})));
    const native=initial.find(item=>item.url.includes('/account-lite/index.html'));
    assert.equal(native.preferences.nodeIntegration,false);assert.equal(native.preferences.contextIsolation,true);assert.equal(native.preferences.sandbox,true);
    assert.equal(await remote.evaluate(()=>typeof require),'undefined');
    const remoteToLocal=await remote.evaluate(async()=>{try{await fetch('http://127.0.0.1:1/api/config');return 'unexpected';}catch{return 'blocked';}});assert.equal(remoteToLocal,'blocked');
    const initialKeys=await page.evaluate(async()=> (await (await fetch('/api/config')).json()));
    assert.equal(initialKeys.keyStorage,'protected');for(const field of ['configured','videoConfigured','toolConfigured','chatConfigured'])assert.equal(initialKeys[field],false);
    await page.waitForFunction(async()=>{const state=await (await fetch('/api/relay/account-view/state')).json();return state.state==='ready'&&state.visible===true;});
    assert.equal(await page.locator('#closeRelayAccountView').isEnabled(),true);
    const captureMethod=await capture('desktop-account-1200.png');
    await remote.screenshot({path:path.join(output,'native-account-page.png'),scale:'css'});
    const rootGeometry=await page.locator('#relayAccountViewport').boundingBox();
    await remote.getByRole('button',{name:'API Key',exact:true}).click();
    await remote.getByRole('button',{name:'查看 Key',exact:true}).first().click();
    await remote.getByRole('textbox',{name:/的完整 Key/}).waitFor();
    await page.getByRole('button',{name:'生成',exact:true}).click();
    await page.waitForFunction(async()=>!(await (await fetch('/api/relay/account-view/state')).json()).visible);
    const hidden=await page.evaluate(async()=> (await (await fetch('/api/relay/account-view/state')).json()).visible);assert.equal(hidden,false);
    await remote.waitForFunction(()=>document.querySelectorAll('.key-value').length===0);
    await page.getByRole('button',{name:'账户',exact:true}).click();
    await page.locator('#relayAccountViewport[data-attached="true"]').waitFor();
    assert.equal(await remote.evaluate(()=>document.querySelector('#balance-value').textContent.includes('128.50')),true);
    await remote.getByRole('button',{name:'账户余额',exact:true}).click();
    await application.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(960,720));
    await page.waitForTimeout(400);
    await capture('desktop-account-960.png');
    const before=await remote.evaluate(async()=> (await (await fetch('/__qa/state')).json()).data.calls.filter(item=>item.path==='/api/user/pay').length);
    await remote.locator('[data-tab="topup"]').click();
    await remote.locator('#pay').waitFor({state:'visible'});
    await remote.waitForFunction(()=>!document.querySelector('#pay').disabled);
    await remote.locator('#pay').click();
    await remote.locator('#confirm-ok').click();
    await remote.locator('#continue-payment').waitFor({state:'visible'});
    const opening=application.context().waitForEvent('page');
    await remote.locator('#continue-payment').click();
    const payment=await opening;await payment.getByRole('heading',{name:'离线支付示例'}).waitFor();
    const paymentBridge=await payment.evaluate(()=>window.hamsterAccount.setAccountContext({userId:12}));assert.deepEqual(paymentBridge,{ok:false,code:'FORBIDDEN'});
    const sharedSession=await application.evaluate(({webContents})=>{const all=webContents.getAllWebContents(),account=all.find(item=>item.getURL().includes('/account-lite/index.html')),popup=all.find(item=>item.getURL().includes('/pay/lanjing/epay/submit.php'));return Boolean(account&&popup&&account.session===popup.session);});
    assert.equal(sharedSession,true);
    const paymentCalls=await remote.evaluate(async()=> (await (await fetch('/__qa/state')).json()).data.calls);
    assert.equal(paymentCalls.filter(item=>item.path==='/api/user/pay').length-before,1);
    const posted=paymentCalls.filter(item=>item.path==='/pay/lanjing/epay/submit.php').at(-1);
    assert.equal(posted.method,'POST');assert.ok(!posted.fields.includes('access_token'));assert.ok(posted.fields.includes('sign'));
    await payment.close();
    await remote.getByRole('button',{name:'API Key',exact:true}).click();
    const groups=['image-standard','video-standard','tool-standard','chat-standard'];
    const labels={ 'image-standard':'图片生成','video-standard':'视频生成','tool-standard':'数字人与工具','chat-standard':'AI 对话' };
    const fixtureState=()=>remote.evaluate(async()=> (await (await fetch('/__qa/state')).json()).data);
    const keyReads=value=>value.calls.filter(item=>/^\/api\/token\/(\d+)\/key$/.test(item.path));
    const factsNow=()=>application.evaluate(()=>global.__accountQA.facts());
    const observations=()=>application.evaluate(()=>global.__accountQA.observed);
    const noKeyDOM=async()=>{assert.equal(await remote.locator('.key-value').count(),0);assert.equal(await remote.evaluate(()=>/sk-[ivtc]\d{18}q{29}/.test(document.documentElement.outerHTML)),false);};
    const activationButton=id=>remote.locator(`[data-action="activate-key"][data-key-id="${id}"]`);
    const beforeKeyCalls=(await fixtureState()).calls;
    const beforeCreate=beforeKeyCalls.filter(item=>item.path==='/api/token/'&&item.method==='POST').length,beforeReveal=beforeKeyCalls.filter(item=>/^\/api\/token\/(\d+)\/key$/.test(item.path)).length;
    await activationButton(7).waitFor();assert.equal(await activationButton(7).isEnabled(),true);
    await activationButton(7).click();
    await remote.waitForFunction(()=>document.querySelector('[data-action="activate-key"][data-key-id="7"]')?.textContent==='已激活');
    await page.waitForFunction(()=>window.__nativeConfigEvents===1);
    let saved=await factsNow();assert.equal(saved.syntheticTokenIds.image,7);assert.equal(saved.protected,true);assert.equal(saved.plaintextKeyInFile,false);
    const afterExisting=await fixtureState();assert.equal(keyReads(afterExisting).length-beforeReveal,1);assert.equal(afterExisting.tokens.find(item=>item.id===7).status,1);
    assert.equal(afterExisting.calls.filter(item=>item.path==='/api/token/'&&item.method==='POST').length,beforeCreate);await noKeyDOM();
    if(onboarding){
      await page.waitForFunction(()=>document.getElementById('relayImageConnection')?.dataset.state==='ready'&&!document.getElementById('startRelay').disabled);
      const partial=await page.evaluate(()=>({badge:document.getElementById('billingConnection').textContent,states:['Image','Video','Tool','Chat'].map(kind=>document.getElementById('relay'+kind+'Connection').textContent)}));
      assert.equal(partial.badge,'已连接 1/4');assert.deepEqual(partial.states,['图片：连接正常','视频：未激活','工具：未激活','对话：未激活']);
      await page.locator('#startRelay').click();await page.locator('[data-panel="generate"].active').waitFor();assert.equal(await page.locator('#typeLabel').textContent(),'图片生成');
      singleFunction={kind:'image',connected:1,required:1,startView:'generate',generationType:'image',paidSubmissions:0};
      await page.getByRole('button',{name:'账户',exact:true}).click();await page.locator('#relayAccountViewport[data-attached="true"]').waitFor();
      await remote.getByRole('button',{name:'API Key',exact:true}).click();
    }
    const activations=[{keyId:7,group:'image-standard',existing:true,systemProtected:saved.protected,freeDetection:true}];
    for(const group of groups){
      const priorState=await fixtureState(),priorFacts=await factsNow(),priorObserved=await observations();
      await remote.getByRole('button',{name:'开通 API Key',exact:true}).click();
      await remote.getByRole('textbox',{name:'名称',exact:true}).fill('桌面隔离验收 '+labels[group]);
      await remote.getByRole('combobox',{name:'用途',exact:true}).selectOption(group);
      await remote.getByRole('button',{name:'确认开通',exact:true}).click();
      await remote.locator('#key-dialog').waitFor({state:'hidden'});
      const createdState=await fixtureState(),token=createdState.tokens.find(item=>!priorState.tokens.some(previous=>previous.id===item.id));
      assert.ok(token);assert.equal(token.group,group);await activationButton(token.id).waitFor();assert.equal(await activationButton(token.id).isEnabled(),true);
      assert.equal(await activationButton(token.id).textContent(),'激活');
      await remote.waitForTimeout(250);
      const beforeActivation=await fixtureState(),unchanged=await factsNow(),notActivated=await observations();
      assert.equal(keyReads(beforeActivation).length,keyReads(priorState).length);assert.deepEqual(unchanged.syntheticTokenIds,priorFacts.syntheticTokenIds);assert.equal(notActivated.configuredEvents,priorObserved.configuredEvents);
      assert.equal(notActivated.context.length,priorObserved.context.length);assert.equal(notActivated.catalog,priorObserved.catalog);assert.equal(notActivated.activateChat,priorObserved.activateChat);await noKeyDOM();
      await activationButton(token.id).click();
      await remote.waitForFunction(id=>document.querySelector(`[data-action="activate-key"][data-key-id="${id}"]`)?.textContent==='已激活',token.id);
      await page.waitForFunction(count=>window.__nativeConfigEvents===count,activations.length+1);
      const activatedState=await fixtureState(),activatedFacts=await factsNow(),activated=await observations(),kind=group.split('-')[0];
      assert.equal(keyReads(activatedState).length-keyReads(beforeActivation).length,1);assert.equal(activatedFacts.syntheticTokenIds[kind],token.id);
      assert.ok(activated.context.filter(item=>item.kind===kind).length>priorObserved.context.filter(item=>item.kind===kind).length);
      assert.ok(kind==='chat'?activated.activateChat>priorObserved.activateChat:activated.catalog>priorObserved.catalog);
      assert.equal(activatedFacts.protected,true);assert.equal(activatedFacts.plaintextKeyInFile,false);assert.equal(activated.paid,0);assert.equal(activated.uploads,0);await noKeyDOM();
      activations.push({keyId:token.id,group,existing:false,creationReadOrSave:false,systemProtected:activatedFacts.protected,freeDetection:true});
    }
    const localConfig=await page.evaluate(async()=> (await (await fetch('/api/config')).json()));
    for(const field of ['configured','videoConfigured','toolConfigured','chatConfigured'])assert.equal(localConfig[field],true);
    await page.waitForFunction(()=>{const text=document.querySelector('#relayKeySummary')?.textContent||'';return ['图片：已配置','视频：已配置','工具：已配置','对话：已配置'].every(part=>text.includes(part));});
    await page.waitForFunction(()=>['relayImageConnection','relayVideoConnection','relayToolConnection','relayChatConnection'].every(id=>document.getElementById(id)?.dataset.state==='ready'));
    const nativeEvents=await page.evaluate(()=>window.__nativeConfigEvents);assert.equal(nativeEvents,5);
    const facts=await application.evaluate(()=>global.__accountQA.facts());
    assert.equal(facts.protected,true);assert.equal(facts.encryptedFilePresent,true);assert.equal(facts.plaintextKeyInFile,false);assert.equal(facts.userId,12);assert.deepEqual(facts.kinds,{image:true,video:true,tool:true,chat:true});
    const afterCreate=await remote.evaluate(async()=> (await (await fetch('/__qa/state')).json()).data.calls);
    assert.equal(afterCreate.filter(item=>item.path==='/api/token/'&&item.method==='POST').length-beforeCreate,4);
    const createdKeyIds=afterCreate.filter(item=>/^\/api\/token\/(\d+)\/key$/.test(item.path)).slice(beforeReveal).map(item=>Number(item.path.split('/')[3]));
    assert.deepEqual(createdKeyIds,activations.map(item=>item.keyId));
    const afterState=await fixtureState();assert.equal(afterState.tokens.find(item=>item.id===7).status,1);
    assert.equal(afterCreate.filter(item=>item.method==='PUT'||item.method==='DELETE').length,0);
    const connectionCard=await page.evaluate(()=>{const ids=['relayImageConnection','relayVideoConnection','relayToolConnection','relayChatConnection','recheckRelay','startRelay','relayAccountStatus'];return {outsideAdvanced:ids.every(id=>!document.getElementById(id).closest('details')),outsideViewport:ids.every(id=>!document.getElementById(id).closest('#relayAccountViewport')),advancedClosed:!document.querySelector('.relay-advanced').open};});
    assert.deepEqual(connectionCard,{outsideAdvanced:true,outsideViewport:true,advancedClosed:true});
    await remote.screenshot({path:path.join(output,'native-account-activated-keys.png'),scale:'css',fullPage:true});
    await remote.locator('#key-connection').screenshot({path:path.join(output,'native-account-activated-status.png'),scale:'css'});
    await page.locator('#startRelay').scrollIntoViewIfNeeded();assert.equal(await page.locator('#startRelay').isEnabled(),true);assert.equal(await page.locator('#startRelay').isVisible(),true);
    await page.locator('.account-card:has(#startRelay)').screenshot({path:path.join(output,'native-application-connection.png'),scale:'css'});
    await capture('desktop-account-activated-960.png');
    await page.locator('#relayAccountViewport').scrollIntoViewIfNeeded();await page.locator('#relayAccountViewport[data-attached="true"]').waitFor();
    await remote.evaluate(()=>{const frame=document.createElement('iframe');frame.id='qa-isolation-frame';frame.src='/__qa/frame';document.body.append(frame);});
    await remote.waitForFunction(()=>document.getElementById('qa-isolation-frame')?.contentWindow?.location.pathname==='/__qa/frame');
    const child=remote.frames().find(frame=>frame.url().endsWith('/__qa/frame'));
    assert.ok(child);const childBridge=await child.evaluate(()=>typeof window.hamsterAccount);assert.equal(childBridge,'undefined');
    await remote.evaluate(()=>document.getElementById('qa-isolation-frame').remove());
    const homeURL=remote.url();
    await remote.evaluate(()=>{location.href='https://account-qa.invalid/untrusted';});
    await remote.waitForTimeout(150);assert.equal(remote.url(),homeURL);
    await remote.goto(new URL('/__qa/frame',homeURL).href);
    const wrongPathBridge=await remote.evaluate(()=>window.hamsterAccount.setAccountContext({userId:12}));assert.deepEqual(wrongPathBridge,{ok:false,code:'FORBIDDEN'});
    await remote.goto(homeURL);await remote.getByRole('button',{name:'账户余额',exact:true}).waitFor();
    const observed=await application.evaluate(()=>global.__accountQA.observed);
    assert.equal(observed.paid,0);assert.equal(observed.uploads,0);assert.equal(observed.configuredEvents,5);assert.ok(observed.context.length>=10);assert.ok(observed.catalog>=3);assert.ok(observed.activateChat>=1);
    if(onboarding){
      await page.getByRole('button',{name:'历史',exact:true}).click();await page.locator('[data-panel="history"].active').waitFor();
      await page.waitForFunction(async()=>!(await (await fetch('/api/relay/account-view/state')).json()).visible);
      // Finish a refresh already started while visible before measuring the
      // hidden-page notification. Its in-flight response is not a new check.
      await page.waitForFunction(()=>document.getElementById('recheckRelay')?.disabled===false);
      const before=await application.evaluate(()=>global.__accountQA.observed),configReads=before.localRequests.filter(item=>item.path==='/api/config').length;
      await page.evaluate(()=>window.dispatchEvent(new Event('hamster-relay-native-configured')));
      for(let i=0;i<100;i++){if(await application.evaluate(count=>global.__accountQA.observed.localRequests.filter(item=>item.path==='/api/config').length>count,configReads))break;await page.waitForTimeout(30);}
      await page.waitForTimeout(250);const after=await application.evaluate(()=>global.__accountQA.observed);
      assert.ok(after.localRequests.filter(item=>item.path==='/api/config').length>configReads);assert.equal(after.localRequests.filter(item=>item.path==='/api/relay/connection').length,before.localRequests.filter(item=>item.path==='/api/relay/connection').length);assert.equal(after.context.length,before.context.length);assert.equal(after.catalog,before.catalog);assert.equal(after.activateChat,before.activateChat);
      hiddenActivation={page:'history',safeConfigRefreshed:true,connectionRequests:0,contextRequests:0,catalogRequests:0,chatChecks:0};
      await page.getByRole('button',{name:'账户',exact:true}).click();await page.waitForFunction(()=>['relayImageConnection','relayVideoConnection','relayToolConnection','relayChatConnection'].every(id=>document.getElementById(id)?.dataset.state==='ready'));
      assert.equal(after.accountViews.filter(item=>item.action==='open'&&item.startupState!=='ready').length,0);
    }
    assert.deepEqual(pageErrors,[]);
    const state=await page.evaluate(async()=> (await (await fetch('/api/relay/account-view/state')).json()));
    const record={synthetic:true,realModelCalls:0,realPayments:0,phase:state,captureMethod,isolatedPreferences:{nodeIntegration:native.preferences.nodeIntegration,contextIsolation:native.preferences.contextIsolation,sandbox:native.preferences.sandbox},requireUnavailable:true,remoteToLocal,rootGeometry,hiddenOnSwitch:!hidden,secretHiddenOnSwitch:true,remoteDOMPreserved:true,paymentPopup:{sharedSession,method:posted.method,signedFieldsPreserved:true,accessTokenInForm:false,syntheticOrdersCreated:1},explicitKeyActivation:{manualCreations:4,explicitActivations:5,existingKeyActivated:true,creationDoesNotReadOrSave:true,previousKeyNotRevoked:true,activations,nativeEvents,systemProtected:facts.protected,encryptedFilePresent:facts.encryptedFilePresent,plaintextKeyInFile:facts.plaintextKeyInFile,allFourConfigured:true,allFourFreeChecksReady:true,noKeyRendered:true,connectionCard,contextChecks:observed.context.length,catalogChecks:observed.catalog,chatActivationChecks:observed.activateChat,paidSubmissions:observed.paid,materialUploads:observed.uploads},senderIsolation:{childFrameBridgeExposed:false,paymentCode:paymentBridge.code,wrongPathCode:wrongPathBridge.code,externalNavigationBlocked:true},blockedRemoteNetwork:observed.blockedNetwork};
    record.onboarding={startupGate,registration,singleFunction,hiddenActivation,pageErrors};
    record.nativeModuleSource=observed.packagedNative?'verified-current-app.asar':'workspace';
    record.packagedExeLaunched=false;
    fs.writeFileSync(path.join(output,'desktop-smoke.json'),JSON.stringify(record,null,2));console.log(JSON.stringify(record));
    fs.writeFileSync(path.join(output,'native-activation.json'),JSON.stringify(record,null,2));
  }catch(error){
    const failure=await application.evaluate(async({BrowserWindow})=>({observed:global.__accountQA?.observed,local:await BrowserWindow.getAllWindows()[0]?.webContents.executeJavaScript('({startupState:document.body.dataset.startupState,active:document.querySelector("[data-panel].active")?.dataset.panel,status:document.getElementById("relayAccountViewStatus")?.textContent,connection:document.getElementById("relayAccountStatus")?.textContent,viewport:document.getElementById("relayAccountViewport")?.getBoundingClientRect().toJSON()})')})).catch(()=>({unavailable:true}));
    fs.writeFileSync(path.join(output,'native-failure.json'),JSON.stringify(failure,null,2));throw error;
  }finally{await application.close();}
}
run().catch(error=>{console.error(error.stack||error.message);process.exitCode=1;});
