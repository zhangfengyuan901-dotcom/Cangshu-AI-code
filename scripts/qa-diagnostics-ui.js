async (page) => {
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/api/public-models',r=>r.fulfill({json:{data:[]}}));
  await page.emulateMedia({reducedMotion:'reduce'});
  await page.goto('http://127.0.0.1:8790/');await page.setViewportSize({width:1280,height:1000});
  await page.locator('#workbenchButton').click();
  await page.locator('#startupErrorDialog').waitFor();
  const message=await page.locator('#startupErrorMessage').innerText();
  if(!/8000.*4321/.test(message))throw new Error('Conflict message lost port/PID');
  const exportResponse=page.waitForResponse(r=>r.url().endsWith('/api/diagnostics/export'));
  await page.locator('#startupErrorDialog [data-export-diagnostics]').click();
  const exported=await (await exportResponse).json();
  if(!exported.localPath || !exported.fileName.endsWith('.json'))throw new Error('No diagnostic file returned');
  await page.locator('#startupErrorDialog [data-diagnostic-result]').filter({hasText:'已导出'}).waitFor();
  await page.screenshot({path:'output/playwright/startup-error-diagnostics.png',fullPage:true});
  await page.locator('#closeStartupError').click();
  await page.getByRole('button',{name:'账户',exact:true}).click();
  await page.locator('#diagnosticStatus').filter({hasText:'fixture-python'}).waitFor();
  await page.locator('.diagnostic-card').scrollIntoViewIfNeeded();
  await page.screenshot({path:'output/playwright/account-diagnostics.png',fullPage:true});
  if(errors.length)throw new Error(errors.join('\n'));
  console.log('PASS: actionable startup modal, one-click real local export, persistent account diagnostics. No paid calls.');
  await page.unrouteAll({behavior:'wait'});
}
