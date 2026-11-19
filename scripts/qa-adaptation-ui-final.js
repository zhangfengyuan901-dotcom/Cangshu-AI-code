// Read-only follow-up after final copy/layout and unlimited active batch controls.
async page=>{
  const base=new URL(page.url()).origin,checks=[],check=(ok,name)=>{if(!ok)throw Error(name);checks.push(name);};
  await page.goto(base);await page.getByRole('button',{name:'账户',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('#saveRelayKeys').disabled);
  check(await page.locator('#relayKeyForm input[type="checkbox"]').count()===3,'final source renders all three explicit remove controls');
  const direction=await page.locator('.relay-key-remove').first().evaluate(element=>getComputedStyle(element).flexDirection);check(direction==='row','removal checkbox and label align horizontally');
  await page.locator('.account-dashboard').screenshot({path:'output/playwright/adaptation-1749/three-key-account.png'});
  await page.locator('#globalImageEdit').click();check(await page.locator('#imageEditBrush').isDisabled(),'final editor disables unsupported marks');check(await page.locator('#imageEditMarkBadge').innerText()==='文字编辑','final editor labels supported editing mode');await page.locator('#closeImageEdit').click();
  await page.getByRole('button',{name:'生成',exact:true}).click();await page.waitForFunction(()=>document.querySelector('#relayBatchControls').textContent.includes('已停止剩余份数'));
  check(await page.locator('#relayBatchControls [data-stop-relay-batch]').count()===0,'stopped batch remains stopped after loading final source');
  const session=await(await page.request.get(base+'/qa-session')).json(),state=await(await page.request.get(session.controlBase+'/state')).json();check(state.events.filter(event=>event.type==='submit').length===1,'read-only final follow-up creates no additional submit');
  return {ok:true,checks,readOnly:true,syntheticOnly:true,realGeneration:0,realInference:0};
}
