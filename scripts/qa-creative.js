async (page) => {
  // Requires qa-creative-server.py; paid inference is stubbed, all other local paths are real.
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.emulateMedia({reducedMotion:'reduce'});
  await page.goto('http://127.0.0.1:8004/creative/');
  await page.setViewportSize({width:1440,height:1000});
  await page.locator('#sourceInput').setInputFiles('output/playwright/qa-video.mp4');
  await page.getByRole('button',{name:'自动拆解视频 ↗'}).click();
  await page.getByRole('heading',{name:'分镜时间轴',exact:true}).waitFor();
  if(await page.locator('#seconds,#ratio').count())throw new Error('Rewrite duration or ratio selector remains');
  await page.getByRole('button',{name:'生成全能参考提示词 ↗'}).click();
  await page.getByRole('heading',{name:'你的生成方案',exact:true}).waitFor();
  if((await page.locator('#prompt').inputValue()).includes('@图片'))throw new Error('No-asset rewrite invented an image reference');
  if((await page.locator('#prompt').inputValue()).includes('【生成设置】'))throw new Error('Rewrite prompt still forces duration or ratio');
  if(await page.locator('#reviewed').count())throw new Error('Review gate remains');
  if(await page.locator('#scriptEditor,#applyScript,#rawAnalysis,#analysisText,#copyAnalysis,#motion').count())throw new Error('Removed controls remain');
  if(/高级脚本编辑|查看分析原文|保留原片作为/.test(await page.locator('body').innerText()))throw new Error('Removed labels remain');
  if(await page.evaluate(()=>window.untrustedExecuted))throw new Error('Raw text executed');
  await page.locator('.binding').first().locator('input[type=file]').setInputFiles('public/hamster-logo.png');
  await page.locator('.binding').first().locator('img').waitFor();
  await page.locator('.binding').nth(1).locator('input[type=file]').setInputFiles('public/hamster-logo.png');
  await page.locator('.binding').nth(1).locator('img').waitFor();
  await page.locator('#notes').fill('保留字幕，动作自然。');

  await page.getByRole('button',{name:'生成全能参考提示词 ↗'}).click();
  await page.getByRole('heading',{name:'你的生成方案',exact:true}).waitFor();
  const prompt=await page.locator('#prompt').inputValue();
  if(/【|标准单元|不补足|不参考原人物/.test(prompt))throw new Error('Report scaffolding leaked into prompt');
  if(!prompt.includes('抬手示意')||!prompt.includes('字幕“你好”'))throw new Error('Action or dialogue missing');
  await page.context().grantPermissions(['clipboard-read','clipboard-write']);
  await page.getByRole('button',{name:'复制本段',exact:true}).first().click();
  if((await page.evaluate(()=>navigator.clipboard.readText())).replace(/\r\n/g,'\n')!==prompt)throw new Error('Copied text differs from clean prompt');
  if(!prompt.includes('@图片1')||!prompt.includes('@图片2')||!prompt.includes('@视频1'))throw new Error('Reference mapping missing');
  if(await page.locator('#manifest a').count()!==3)throw new Error('Reference download manifest missing');
  const downloading=page.waitForEvent('download');
  await page.getByRole('link',{name:'下载 TXT',exact:true}).click();
  const download=await downloading;await download.saveAs('output/playwright/creative-prompt.txt');
  await page.reload();
  await page.getByRole('heading',{name:'你的生成方案',exact:true}).waitFor();
  if(await page.locator('.binding img').count()!==2)throw new Error('Bindings not restored');
  if(await page.locator('#notes').inputValue()!=='保留字幕，动作自然。')throw new Error('Notes not restored');
  await page.screenshot({path:'output/playwright/creative-workbench.png',fullPage:true});
  await page.setViewportSize({width:390,height:844});
  if(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth))throw new Error('Mobile horizontal overflow');
  await page.screenshot({path:'output/playwright/creative-mobile.png'});
  if(errors.length)throw new Error(errors.join('\n'));
  console.log('PASS: video upload/inspection, removed controls, automatic video reference, image bindings, concise actions/dialogue, clipboard, TXT download, reload and mobile layout. Paid inference mocked.');
}
