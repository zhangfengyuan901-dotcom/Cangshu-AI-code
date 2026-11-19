async (page) => {
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.emulateMedia({reducedMotion:'reduce'});
  await page.setViewportSize({width:1280,height:960});
  let configured=false,mode='ready',release,checks=0;
  await page.route('**/api/**',async route=>{
    const endpoint=new URL(route.request().url()).pathname;
    let body={},status=200;
    const config=()=>({configured,billingConfigured:configured,videoConfigured:configured,rhConfigured:configured,llmConfigured:configured});
    if(endpoint==='/api/startup')body={config:config(),assets:{total:0,counts:{talent:0,product:0,scene:0}}};
    else if(endpoint==='/api/config')body=config();
    else if(endpoint==='/api/billing/me')body={email:'fixture@example.test',email_verified:true,balance:0};
    else if(endpoint==='/api/billing/auth/code')body={challenge_id:'otp_fixture'};
    else if(endpoint==='/api/billing/auth/verify'){configured=true;body={ok:true};}
    else if(endpoint==='/api/billing/auth/logout'){configured=false;body={ok:true};}
    else if(endpoint==='/api/inference/status'){
      checks++;if(mode==='pending')await new Promise(resolve=>{release=resolve;});
      if(mode==='rejected'){status=401;body={error:'private endpoint secret'};}
      else if(mode==='error'){status=503;body={error:'private endpoint secret'};}
      else body={configured:true};
    }
    else if(endpoint==='/api/tasks')body={tasks:[]};
    else if(['/api/public-models','/api/models','/api/billing/recharges','/api/billing/ledger'].includes(endpoint))body={data:[]};
    else if(endpoint==='/api/assets')body={items:[]};
    else if(['/api/chat/status','/api/workbench/prepare'].includes(endpoint))body={status:'ready'};
    await route.fulfill({status,json:body});
  });
  await page.reload();
  const logo=page.locator('#inferenceLogo');
  const waitState=status=>page.waitForFunction(s=>document.querySelector('#inferenceLogo').dataset.state===s,status);
  await waitState('signed-out');await logo.hover();
  if(await logo.locator('img').evaluate(el=>getComputedStyle(el).filter)!=='grayscale(1)')throw Error('Offline hover restored color');
  await logo.click();if(checks!==0)throw Error('Unauthenticated check sent request');
  await page.getByRole('button',{name:'账户',exact:true}).click();
  if(await page.locator('.inference-card').count())throw Error('Legacy card still visible');
  await page.screenshot({path:'output/playwright/inference-logo-gray.png'});
  await page.locator('#billingLoginEmail').fill('fixture@example.test');await page.locator('#requestBillingCode').click();await page.locator('#billingLoginCode').fill('123456');
  mode='pending';await page.locator('#loginBilling').click();await waitState('checking');
  if(await logo.getAttribute('aria-busy')!=='true')throw Error('Missing accessible busy state');
  if(await logo.locator('.inference-logo-ring').evaluate(el=>getComputedStyle(el).display)==='none')throw Error('Missing progress ring');
  await logo.dispatchEvent('click');await logo.dispatchEvent('click');if(checks!==1)throw Error('Duplicate check');
  mode='ready';release();await waitState('ready');
  if(!await logo.evaluate(el=>el.classList.contains('is-connected')))throw Error('Successful check stayed gray');
  await page.getByRole('button',{name:'账户',exact:true}).click();const before=checks;
  mode='error';await logo.click();await waitState('error');
  if(checks!==before+1||!await page.locator('[data-panel=account]').evaluate(el=>el.classList.contains('active')))throw Error('Logo failed to recheck or changed view');
  if(!/连接失败/.test(await page.locator('#toast').innerText()))throw Error('Missing safe error toast');
  mode='rejected';await logo.click();await waitState('rejected');
  mode='ready';await logo.focus();await page.keyboard.press('Enter');await waitState('ready');await logo.hover();
  await page.screenshot({path:'output/playwright/inference-logo-connected.png'});
  await page.setViewportSize({width:720,height:900});await logo.focus();
  const box=await page.locator('#inferenceLogoHint').boundingBox();if(box.x<0||box.x+box.width>720)throw Error('Tooltip clips at narrow width');
  await page.screenshot({path:'output/playwright/inference-logo-narrow.png'});
  await page.evaluate(()=>window.dispatchEvent(new Event('offline')));await waitState('error');
  await page.evaluate(()=>window.dispatchEvent(new Event('online')));await waitState('ready');
  page.once('dialog',dialog=>dialog.accept());await page.locator('#logoutBilling').click();await waitState('signed-out');
  if(/ep-|Cloudflare|API Key|接入点|VideoFee|方舟|private endpoint/i.test(await logo.getAttribute('aria-label')))throw Error('Private error exposure');
  if(errors.length)throw Error(errors.join('\n'));
  await page.evaluate(()=>document.documentElement.dataset.inferenceQa='passed');
  console.log('PASS: gray/color, login auto-check, spinner, dedupe, safe errors, keyboard, view preservation, offline recovery, logout, narrow tooltip; mock APIs only.');
}
