async (page) => {
  const base='http://127.0.0.1:4390';
  await page.request.get(base+'/__qa/scenario?turnstile=true');await page.context().clearCookies();await page.evaluate(()=>sessionStorage.clear());
  await page.route('https://challenges.cloudflare.com/**', route=>route.fulfill({contentType:'text/javascript',body:"window.turnstile={render:(_element,options)=>{window.__turnstileQA=options.callback;return 1;},reset:()=>{}}"}));
  await page.goto(base+'/auth-lite/index.html?mode=login');await page.waitForFunction(()=>typeof window.__turnstileQA==='function');
  if(!await page.getByRole('button',{name:'登录',exact:true}).isDisabled())throw Error('challenge bypass');
  await page.evaluate(()=>window.__turnstileQA('synthetic-turnstile-proof'));
  await page.getByRole('button',{name:'登录',exact:true}).waitFor();if(await page.getByRole('button',{name:'登录',exact:true}).isDisabled())throw Error('challenge not accepted');
  await page.unroute('https://challenges.cloudflare.com/**');
  await page.request.get(base+'/__qa/scenario?signedIn=true');await page.goto(base+'/keys');await page.getByRole('heading',{name:'连接你的创作工具'}).waitFor();if(page.url()!==base+'/account-lite/index.html')throw Error('account URL not canonical');
  await page.goto(base+'/wallet');await page.getByRole('heading',{name:'为灵感续航'}).waitFor();
  await page.request.get(base+'/__qa/scenario');await page.goto(base+'/auth-lite/index.html?mode=login');await page.getByRole('link',{name:'使用其他安全登录方式'}).click();await page.getByRole('heading',{name:'登录控制台'}).waitFor();
  if(!page.url().includes('compat=1'))throw Error('explicit alternative entry lost');
  return {turnstileRequiredBeforeSubmit:true,turnstileStubOnly:true,legacyKeysAndWalletTab:true,nativeAccountURLCanonical:true,alternativeLoginPreserved:true,realChallengeCalls:0};
}
