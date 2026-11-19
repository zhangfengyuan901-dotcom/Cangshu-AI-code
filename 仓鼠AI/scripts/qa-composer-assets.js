async (page) => {
  const errors = [];
  let uploads = 0;
  page.on('pageerror', e => errors.push(e.message));
  await page.emulateMedia({reducedMotion:'reduce'});
  await page.route('**/api/config', r => r.fulfill({json:{configured:true,rhConfigured:true}}));
  const models = [{id:'sd_2_5_once_720p',name:'SD2.5-按次-720P',type:'video',ratios:['9:16'],resolutions:['720p'],durations:[5]}];
  await page.route('**/api/models', r => r.fulfill({json:{data:models}}));
  await page.route('**/api/public-models', r => r.fulfill({json:{data:models}}));
  // Asset import/list/file use the real isolated local API. Cloud upload is mocked.
  await page.route('**/api/assets/*/upload', r => {
    uploads++;
    return r.fulfill({json:{url:'http://127.0.0.1:8788/hamster-logo.png'}});
  });
  await page.goto('http://127.0.0.1:8788/');
  await page.setViewportSize({width:1440,height:1000});
  await page.locator('#assetTile').click();
  await page.getByRole('dialog').waitFor();
  await page.getByRole('button',{name:'关闭',exact:true}).click();
  if(uploads || await page.locator('.media-chip').count()) throw new Error('Cancel changed media');
  await page.locator('#assetTile').click();
  const logo = await page.request.get('http://127.0.0.1:8788/hamster-logo.png');
  const name = 'QA-composer-' + Date.now() + '.png';
  await page.locator('dialog input[type=file]').setInputFiles({name,mimeType:'image/png',buffer:await logo.body()});
  const card = page.locator('dialog .asset-card').filter({hasText:name});
  await card.waitFor();
  await page.screenshot({path:'output/playwright/composer-asset-picker.png',fullPage:true});
  await card.getByRole('button',{name:'使用此资产',exact:true}).click();
  await page.locator('.media-chip').waitFor();
  if(uploads!==1) throw new Error('Expected exactly one mocked upload');
  await page.screenshot({path:'output/playwright/composer-no-credits.png',fullPage:true});
  for(const [view,button] of [['digital','#dhSubmit'],['depth','#depthSubmit']]) {
    await page.locator('[data-view="'+view+'"]').click();
    await page.locator(button).waitFor();
    if(await page.locator('[data-panel="'+view+'"] .lucide-zap, [data-panel="'+view+'"] .digital-cost').count()) throw new Error('Credit badge remains in '+view);
    await page.screenshot({path:'output/playwright/'+view+'-no-credits.png',fullPage:true});
  }
  if(errors.length) throw new Error(errors.join('\n'));
  await page.unrouteAll({behavior:'wait'});
  console.log('PASS: shared asset picker, cancel, local import, mocked upload, media chip, digital/depth without credit badges. No paid calls.');
}
