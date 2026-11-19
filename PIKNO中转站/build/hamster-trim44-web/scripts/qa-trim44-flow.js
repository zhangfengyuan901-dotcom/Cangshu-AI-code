async (page) => {
  const base='http://127.0.0.1:4390';
  const scripts=[]; page.on('request',request=>{if(request.resourceType()==='script')scripts.push(new URL(request.url()).pathname)});
  await page.goto(base+'/sign-in'); await page.getByRole('heading',{name:'登录账户',exact:true}).waitFor();
  await page.getByRole('textbox',{name:'用户名或邮箱',exact:true}).fill('synthetic');
  await page.getByRole('textbox',{name:'密码',exact:true}).fill('synthetic-password');
  await page.getByRole('button',{name:'登录',exact:true}).click();
  await page.waitForURL(base+'/account-lite/index.html'); await page.getByText('¥128.50',{exact:true}).waitFor();
  if(scripts.some(value=>value.includes('/async/')))throw Error('customer flow loaded admin async scripts');
  const result=(await (await page.request.get(base+'/__qa/state')).json()).data;
  if(!result.calls.find(call=>call.path==='/api/user/login')?.encrypted)throw Error('password encryption missing');
  await page.setViewportSize({width:1200,height:820});await page.screenshot({path:'D:/PIKNO/output/playwright/trim44-account-1200.png',fullPage:true});
  return {encryptedLogin:true,account:true,adminChunksLoaded:false,scripts};
}
