async (page) => {
  const base='http://127.0.0.1:4390', scripts=[];
  await page.request.get(base+'/__qa/scenario?role=100');await page.context().clearCookies();await page.evaluate(()=>sessionStorage.clear());
  page.on('request',request=>{if(request.resourceType()==='script')scripts.push(new URL(request.url()).pathname)});
  await page.goto(base+'/auth-lite/index.html?mode=login&redirect=%2Fsystem-settings%2Fbilling%2Fquota');
  await page.locator('#username').fill('synthetic');await page.locator('#password').fill('synthetic-password');await page.getByRole('button',{name:'登录',exact:true}).click();
  await page.waitForURL(base+'/system-settings/billing/quota');await page.getByRole('heading',{name:'额度设置',exact:true}).waitFor();
  await page.goto(base+'/dashboard/overview');await page.getByText('用户与权限',{exact:true}).first().waitFor();
  await page.screenshot({path:'D:/PIKNO/output/playwright/trim44-admin-1200.png',fullPage:true});
  const html=await page.locator('body').innerText();if(/兑换码|签到奖励|邀请奖励|订阅套餐/.test(html))throw Error('retired admin entry remains');
  await page.goto(base+'/system-settings/billing/quota');await page.getByRole('heading',{name:'额度设置',exact:true}).waitFor();
  const quota=await page.locator('body').innerText();if(/邀请奖励|受邀用户奖励/.test(quota))throw Error('affiliate settings remain');
  await page.screenshot({path:'D:/PIKNO/output/playwright/trim44-settings-1200.png',fullPage:true});
  return {admin:true,settings:true,groups:['用户与权限','渠道与线路','定价与分组','充值与结算','日志与基础安全'].every(group=>html.includes(group)),retiredEntriesAbsent:true,scripts:scripts.length};
}
