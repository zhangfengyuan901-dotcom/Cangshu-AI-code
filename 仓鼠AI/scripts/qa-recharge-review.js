async (page)=>{
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.setViewportSize({width:1440,height:1000});
 await page.getByRole('button',{name:'账户',exact:true}).click();
 if(await page.locator('#billingLoginEmail').isVisible()){
  await page.locator('#billingLoginEmail').fill('fixture@example.com');
  await page.locator('#requestBillingCode').click();await page.locator('#billingLoginCode').fill('123456');await Promise.all([page.waitForEvent('load'),page.locator('#loginBilling').click()]);
  await page.getByRole('button',{name:'账户',exact:true}).click();
 }
 await page.locator('#openRecharge').click();await page.locator('#rechargeForm [name=amount]').fill('10');await page.locator('#submitRecharge').click();
 await page.waitForFunction(()=>document.querySelector('#submitRecharge').textContent==='我已确认付款');
 if(await page.locator('#rechargeReference,#copyRechargeReference').count())throw Error('Customer order reference still present');
 if(!/无需填写/.test(await page.locator('#rechargeStatus').innerText()))throw Error('Missing simplified instructions');
 await page.screenshot({path:'output/playwright/recharge-no-order-number.png'});
 await page.locator('#closeRecharge').click();await page.locator('#openRecharge').click();
 if(await page.locator('#rechargeForm [name=amount]').inputValue()!=='10.00')throw Error('Unpaid request not resumable');
 await page.locator('#rechargeForm [name=confirmed]').check();await page.locator('#submitRecharge').click();
 await page.waitForFunction(()=>document.querySelector('#rechargeStatus').textContent.includes('已提交人工审核'));
 if(!await page.locator('#submitRecharge').isDisabled())throw Error('Confirmation repeat not blocked');
 const pending={id:'fixture-order',email_snapshot:'fixture@example.test',amount:10000000,state:'pending',payment_reported:1,created_at:Date.now()-60000,payment_reported_at:Date.now()-30000};
 let orders=[pending],submission=null;
 await page.route('http://127.0.0.1:8792/admin/api/**',async route=>{
  const p=new URL(route.request().url()).pathname.split('/admin/api/')[1];let result={};
  if(p==='overview')result={customers:{count:1,balance:0,held:0},recharges:{count:orders.length},settings:[],tasks:[],channels:[]};
  else if(p==='recharges')result=orders;
  else if(p==='recharge-review'){submission=route.request().postDataJSON();orders=[];result={ok:true,state:'deleted'};}
  await route.fulfill({json:result});
 });
 await page.goto('http://127.0.0.1:8792/');await page.getByRole('button',{name:'充值审核',exact:true}).click();
 await page.getByRole('button',{name:'审核',exact:true}).click();
 if(!await page.getByLabel('实际到账时间（按收款记录，本机时区）').isVisible())throw Error('Missing receipt time');
 await page.screenshot({path:'output/playwright/recharge-admin-approval.png'});
 await page.getByLabel('审核结论').selectOption('reject');
 if(await page.locator('[name=transaction_id]').isVisible()||await page.locator('[name=transaction_id]').isEnabled())throw Error('Reject should not require receipt');
 await page.getByLabel('操作原因').fill('离线测试：未核实到账');
 await page.screenshot({path:'output/playwright/recharge-admin-delete.png'});
 page.once('dialog',d=>d.accept());await page.locator('#submit').click();
 await page.waitForFunction(()=>document.querySelector('#content').textContent.includes('暂无记录'));
 if(!submission||submission.approve!==false||submission.id!=='fixture-order')throw Error('Wrong reject submission');
 if(errors.length)throw Error(errors.join('\n'));
 await page.evaluate(()=>document.documentElement.dataset.rechargeQa='passed');
 console.log('PASS: customer no reference, close/resume unpaid, confirmation, admin times, reject without receipt, confirmation and row disappearance; mock-only.');
}
