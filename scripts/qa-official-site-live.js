// Public UI checks only. HTTP metadata and whole-file hashes have separate logs.
async page=>{
  const errors=[],checks=[];
  page.on('pageerror',error=>errors.push(error.message));
  const check=(condition,name)=>{if(!condition)throw Error(name);checks.push(name);};
  const out='output/playwright/official-release-1749/';
  const overflow=()=>page.evaluate(()=>document.documentElement.scrollWidth>innerWidth);
  await page.setViewportSize({width:1440,height:1000});
  check((await page.goto('https://hamsterai.cc/')).status()===200,'live homepage HTTP 200');
  check((await page.locator('main > section').count())===2,'case-first two-section homepage preserved');
  check((await page.locator('main > section').first().getAttribute('id'))==='cases','cases precede download');
  check((await page.locator('#portableDownload').getAttribute('href'))==='/download/HamsterAI-Portable-1.7.49.exe','sole current portable download');
  check((await page.locator('#download').innerText()).includes('1.7.49'),'current release version visible');
  check((await page.locator('#download code').textContent()).toLowerCase().includes('0528b850538d58409a50b9c8d480dd7a38ef24e4cd6df27b5481408861f4b09e'),'release checksum visible');
  check((await page.locator('#download').innerText()).includes('工具 Key'),'three-Key instructions visible');
  check((await page.locator('#download').innerText()).includes('对话服务暂未开放'),'closed chat service described accurately');
  await page.locator('.case-card').first().click();
  check(await page.locator('.case-dialog').evaluate(dialog=>dialog.open),'case viewer works');
  await page.locator('.case-dialog .dialog-close').click();
  await page.locator('#download').scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);check(!await overflow(),'desktop homepage fits');
  await page.screenshot({path:out+'homepage-desktop.png'});
  await page.setViewportSize({width:390,height:844});
  await page.reload();await page.locator('#download').scrollIntoViewIfNeeded();await page.waitForTimeout(300);
  check(!await overflow(),'mobile homepage fits');await page.screenshot({path:out+'homepage-mobile.png'});
  await page.setViewportSize({width:1440,height:1000});
  check((await page.goto('https://hamsterai.cc/tutorials/')).status()===200,'current tutorial HTTP 200');
  check((await page.title()).includes('1.7.49'),'current tutorial title');
  const text=await page.locator('main').innerText();
  check(['图片 Key','视频 Key','工具 Key','报价','停止剩余'].every(value=>text.includes(value)),'three keys, quotes and stop guidance');
  check(text.includes('离线模拟')&&text.includes('示意'),'tutorial screenshots are identified as examples');
  check(text.includes('圈选暂不可用')&&text.includes('对话服务暂未开放'),'unsupported capabilities described');
  check((await page.locator('a[href="/tutorials/1.7.46/"]').count())>0,'versioned old guide remains linked');
  for(const image of await page.locator('main img').all()){
    await image.scrollIntoViewIfNeeded();await image.evaluate(img=>img.complete&&img.naturalWidth?true:new Promise((resolve,reject)=>{img.addEventListener('load',()=>resolve(true),{once:true});img.addEventListener('error',()=>reject(Error('tutorial image failed')),{once:true});}));
  }
  await page.locator('h1').scrollIntoViewIfNeeded();check(!await overflow(),'desktop tutorial fits');await page.screenshot({path:out+'tutorial-desktop.png'});
  await page.setViewportSize({width:390,height:844});await page.reload();await page.locator('#account').scrollIntoViewIfNeeded();await page.waitForTimeout(300);
  check(!await overflow(),'mobile tutorial fits');await page.screenshot({path:out+'tutorial-mobile.png'});
  check(errors.length===0,'no page script errors');
  return {ok:true,checks,realGenerationRequests:0,realInferenceRequests:0,screenshots:['homepage-desktop.png','homepage-mobile.png','tutorial-desktop.png','tutorial-mobile.png']};
}
