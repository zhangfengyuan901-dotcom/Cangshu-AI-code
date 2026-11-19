async (page) => {
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/api/public-models',r=>r.fulfill({json:{data:[]}}));
  await page.emulateMedia({reducedMotion:'reduce'});
  await page.goto('http://127.0.0.1:8790/');await page.setViewportSize({width:1280,height:1000});
  await page.locator('#workbenchDiagnostic').click();
  await page.locator('#startupErrorDialog').waitFor();
  const message=await page.locator('#startupErrorMessage').innerText();
  if(!/8000.*4321/.test(message))throw new Error('Conflict message lost port/PID');
  if(await page.locator('[data-export-diagnostics]').count())throw Error('Manual diagnostic exports remain');
  if(!(await page.locator('#startupErrorDialog').innerText()).includes('后台脱敏反馈'))throw Error('Missing fault feedback notice');
  await page.locator('#closeStartupError').click();
  await page.getByRole('button',{name:'账户',exact:true}).click();
  if(await page.locator('.diagnostic-card,#checkDiagnostics,#diagnosticStatus').count())throw Error('Startup diagnostic UI remains');
  await page.locator('.fault-privacy summary').click();
  await page.locator('.fault-privacy').scrollIntoViewIfNeeded();
  const text=await page.locator('body').innerText();
  if(/VideoFee|三宝|R2|Cloudflare|Resend|Packy|ark-|ep-20/i.test(text))throw Error('Provider exposure');
  const sent=page.waitForRequest(r=>r.url().endsWith('/api/error-report'));
  await page.evaluate(()=>window.dispatchEvent(new ErrorEvent('error',{message:'PRIVATE CUSTOMER PROMPT',filename:'https://private.example/key'})));
  const payload=(await sent).postDataJSON();
  if(JSON.stringify(payload)!==JSON.stringify({module:'interface',code:'UNEXPECTED'}))throw Error('Fault upload included exception content');
  await page.screenshot({path:'output/playwright/account-auto-feedback.png',fullPage:true});
  if(errors.length)throw new Error(errors.join('\n'));
  console.log('PASS: no startup diagnostics; privacy disclosure; generic silent error upload; no provider exposure. No real email.');
  await page.unrouteAll({behavior:'wait'});
}
