async (page) => {
  await page.emulateMedia({reducedMotion:'reduce'});
  let ready=false, fail=false, starts=0, opens=0;
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/api/**',async route=>{
    const endpoint=route.request().url().replace(/^https?:\/\/[^/]+/,'').split('?')[0];
    let body={};let status=200;
    if(endpoint==='/api/workbench/prepare'){starts++;body={status:'starting',progress:{percent:35,stage:'释放内置环境'}};}
    else if(endpoint==='/api/chat/status'){
      body=fail?{status:'error',message:'测试环境准备失败'}:ready?{status:'ready',progress:{percent:100,stage:'工作台已就绪'}}:{status:'starting',progress:{percent:35,stage:'释放内置环境'}};
      if(fail)status=503;
    }
    else if(endpoint==='/api/chat/open'){opens++;body={status:'ready'};}
    else if(endpoint==='/api/config')body={configured:false,llmConfigured:false};
    else if(endpoint==='/api/tasks')body={tasks:[]};
    else if(endpoint==='/api/assets')body={items:[]};
    else if(endpoint==='/api/public-models')body={data:[]};
    await route.fulfill({status,json:body});
  });
  await page.goto('http://127.0.0.1:8790/');
  await page.setViewportSize({width:1200,height:820});
  await page.locator('#workbenchProgressText').filter({hasText:'35%'}).waitFor();
  if(!await page.locator('#workbenchButton').isDisabled()||opens||starts!==1)throw Error('Preparation must start once, locked, without browser open');
  await page.getByRole('button',{name:'账户',exact:true}).click();
  await page.locator('#apiKeyInput').fill('offline-fixture-key');
  await page.screenshot({path:'output/playwright/workbench-preparing.png'});
  fail=true;
  await page.locator('#retryWorkbench').waitFor();
  if(!await page.locator('#workbenchButton').isDisabled())throw Error('Failure unlocked entry');
  fail=false;
  await page.locator('#retryWorkbench').click();
  ready=true;
  await page.locator('#workbenchProgressText').filter({hasText:'已就绪'}).waitFor();
  if(await page.locator('#workbenchButton').isDisabled()||opens||starts!==2)throw Error('Readiness must unlock without opening');
  if(await page.locator('#apiKeyInput').inputValue()!=='offline-fixture-key')throw Error('Preparation interrupted Key entry');
  await page.locator('#workbenchButton').click();
  if(opens!==1)throw Error('Explicit click did not open');
  if(errors.length)throw Error(errors.join('\n'));
  console.log('PASS: auto prepare, true progress, locked entry, parallel Key input, failure/retry, explicit open only');
  await page.unrouteAll({behavior:'wait'});
}
