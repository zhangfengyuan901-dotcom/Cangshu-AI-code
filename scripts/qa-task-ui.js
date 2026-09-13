async (page) => {
  const errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.emulateMedia({reducedMotion:'reduce'});
  await page.goto('http://127.0.0.1:8789/');
  await page.setViewportSize({width:1440,height:1050});
  await page.locator('#modelLabel').filter({hasText:'MinimaxH3'}).waitFor();
  await page.locator('[data-menu="type"]').click();
  await page.getByText('图片生成',{exact:true}).click();
  await page.locator('#prompt').fill('离线验证：提交后重开页面，任务持续保存');
  await page.getByRole('button',{name:'发送',exact:true}).click();
  await page.locator('#taskFeed .task-card').waitFor();
  const pending=await page.locator('#taskFeed').innerText();
  if(!/任务 ID：offline-/.test(pending))throw new Error('Task ID not shown');
  // Simulate loss of all browser-local history, then reopen while still running.
  await page.evaluate(()=>localStorage.clear());
  await page.reload();
  await page.locator('#taskFeed .task-card').waitFor();
  await page.getByRole('button',{name:'历史',exact:true}).click();
  await page.locator('#historyList .task-card').waitFor();
  await page.locator('#historyList a').filter({hasText:'下载本地文件'}).waitFor();
  const image=page.locator('#historyList .task-result img').first();
  const src=await image.getAttribute('src');
  if(!src.startsWith('/api/tasks/'))throw new Error('Preview did not use local file');
  await image.evaluate(el=>{if(!el.complete||!el.naturalWidth)throw new Error('Local preview not loaded');el.dataset.playbackSentinel='preserved';});
  const refreshed = page.waitForResponse(response=>response.url().endsWith('/api/tasks'));
  await page.evaluate(()=>window.dispatchEvent(new Event('online')));
  await refreshed;
  await page.locator('#taskPersistenceNote').filter({hasText:'任务记录保存在本机'}).waitFor({state:'attached'});
  if(await image.getAttribute('data-playback-sentinel')!=='preserved')throw new Error('Stable completed preview was recreated');
  await page.screenshot({path:'output/playwright/persistent-task-history.png',fullPage:true});
  const list=await (await page.request.get('http://127.0.0.1:8789/api/tasks')).json();
  if(!list.tasks[0].result.local_path)throw new Error('No durable local path');
  if(errors.length)throw new Error(errors.join('\n'));
  console.log('PASS: real local journal + offline upstream fixture; submitting, reload without localStorage, resumed history, saved preview. No paid API calls.');
}
