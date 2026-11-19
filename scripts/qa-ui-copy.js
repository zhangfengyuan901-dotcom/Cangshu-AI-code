async (page) => {
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.emulateMedia({reducedMotion:'reduce'});
  await page.setViewportSize({width:1440,height:1000});
  await page.goto('http://127.0.0.1:8006/chat/');
  await page.getByRole('button',{name:/新建对话/}).click();
  await page.locator('#input').fill('离线界面验证：简洁回答');
  await page.locator('#send').click();
  await page.locator('.message.assistant .message-actions').waitFor();
  if(await page.locator('#taskStatus').isVisible())throw Error('Completed answer still shows internal stage');
  let text=await page.locator('body').innerText();
  if(/审查|V1|云端上下文/.test(text))throw Error('Chat contains developer notes');
  if(!text.includes('云端处理')||!text.includes('AI 内容仅供参考'))throw Error('Necessary disclosure missing');
  await page.reload();
  await page.locator('.message.assistant .message-actions').waitFor();
  if(await page.locator('#taskStatus').isVisible())throw Error('Restored session exposes saved internal stage');
  // Simulate the stored stages/notice from older versions, without changing customer data.
  await page.route('**/chat-api/sessions/*',async route=>{
    if(route.request().method()!=='GET')return route.continue();
    const response=await route.fetch();const item=await response.json();
    if(item.messages){item.notice='云端上下文已重建，本次重新读取本地消息和附件。';item.stage='回答已审查并保存到本地';item.status='completed';}
    await route.fulfill({response,json:item});
  });
  await page.reload();
  await page.locator('.message.assistant .message-actions').waitFor();
  if(await page.locator('#notice').isVisible()||await page.locator('#taskStatus').isVisible())throw Error('Legacy notes are visible');
  await page.screenshot({path:'output/playwright/chat-clean-copy.png',fullPage:true});
  await page.unroute('**/chat-api/sessions/*');
  await page.goto('http://127.0.0.1:8006/creative/');
  await page.locator('#connection').waitFor({state:'hidden'});
  text=await page.locator('body').innerText();
  if(/本地保存 ·|分步运行|音画理解|Prompt/.test(text))throw Error('Creative page contains implementation notes');
  if(!text.includes('按用量计费'))throw Error('Cost disclosure missing');
  await page.getByText('它会为你分析什么？',{exact:true}).click();
  if(!(await page.locator('body').innerText()).includes('不识别声音'))throw Error('Input limits help missing');
  await page.screenshot({path:'output/playwright/creative-clean-copy.png',fullPage:true});
  await page.goto('http://127.0.0.1:8006/');
  text=await page.locator('body').innerText();
  if(/按上游|调用大模型/.test(text))throw Error('Studio contains implementation notes');
  if(!text.includes('云端处理'))throw Error('Studio disclosure missing');
  if(errors.length)throw Error(errors.join('\n'));
  console.log('PASS: chat completion + reload + legacy notes, creative help, studio copy; no paid API calls.');
}
