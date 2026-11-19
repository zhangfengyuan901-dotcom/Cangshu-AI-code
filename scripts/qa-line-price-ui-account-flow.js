// Continues the local main application browser QA without generating a task.
async page=>{
  const session=await(await page.request.get(new URL('/qa-session',page.url()).href)).json(),control=session.controlBase,checks=[],responses=[];
  const check=(value,name)=>{if(!value)throw Error(name);checks.push(name);};
  const state=async()=>await(await page.request.get(control+'/state')).json();
  const change=async path=>{if(!(await page.request.get(control+path)).ok())throw Error('local control failed');};
  const submissions=async()=>(await state()).events.filter(e=>e.type==='submit').length;
  const before=await submissions();
  const observe=response=>{if(response.url().endsWith('/api/quotes'))responses.push({status:response.status(),revision:response.request().headers()['x-hamster-config-revision']});};
  page.on('response',observe);
  await change('/hold-quote?hold=1');await page.locator('[data-view="generate"]').click();
  await page.locator('#generationQuote [data-quote-refresh]').click();
  await page.waitForFunction(()=>document.querySelector('#generationQuote').dataset.state==='loading');
  check(await page.locator('.send-button').isDisabled(),'in-flight readonly quote disables generation');
  await page.locator('[data-view="account"]').click();await page.getByRole('button',{name:'保存并自动检测',exact:true}).click();
  await page.waitForFunction(()=>!document.querySelector('#saveRelayKeys').disabled);
  await page.getByText('免费检测完成。仅已开放且此 Key 有权限的线路可用。',{exact:true}).waitFor();
  await change('/hold-quote?hold=0');await page.locator('[data-view="generate"]').click();
  await page.waitForFunction(()=>!document.querySelector('.send-button').disabled);
  check(responses.some(r=>r.status===409),'quote from previous local Key revision is rejected after account save');
  check(responses.some(r=>r.status===200),'new account revision obtains its own quote');
  check(await submissions()===before,'account change and delayed readonly quotes create zero paid submits');
  await change('/publish');await page.locator('[data-view="account"]').click();await page.getByRole('button',{name:'保存并自动检测',exact:true}).click();
  await page.getByText('免费检测完成。仅已开放且此 Key 有权限的线路可用。',{exact:true}).waitFor();await page.locator('[data-view="generate"]').click();
  await page.waitForFunction(()=>document.querySelector('#modelLabel').textContent.startsWith('PIKNO 更新线路'));
  check((await page.locator('#generationQuote').innerText()).includes('PIKNO 更新线路'),'new menu and quote adopt current published name');
  check((await page.locator('#taskFeed').innerText()).includes('PIKNO 图片优选'),'old task keeps its saved published name after catalog rename');
  check(await submissions()===before,'catalog rename and quote refresh create zero paid submits');
  await page.locator('#generationQuote').screenshot({path:'output/playwright/line-price-main-1748/renamed-line-quote.png'});
  page.off('response',observe);return {ok:true,checks,responses,paidDelta:(await submissions())-before,syntheticOnly:true};
}
