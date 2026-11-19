async(page)=>{
  const base='http://127.0.0.1:11248',cases=[],errors=[],external=[];
  const assert=(value,message)=>{if(!value)throw Error(message);};
  const api=async(route,data)=>{const response=data===undefined?await page.request.get(base+route):await page.request.post(base+route,{data});assert(response.ok(),'Fixture control failed');return response.json();};
  page.on('pageerror',()=>errors.push('pageerror'));
  await page.context().route('**/*',async route=>{const url=new URL(route.request().url());if(url.protocol==='http:'&&url.hostname==='127.0.0.1')return route.continue();external.push(url.protocol);return route.abort('blockedbyclient');});
  await page.setViewportSize({width:1200,height:900});
  try{
    for(const fault of [503,'malformed']){
      await page.goto('about:blank');const info=await api('/case',{keys:[],seedLocal:true,startupFailure:fault});
      await page.goto(info.base,{waitUntil:'domcontentloaded'});
      await page.waitForFunction(()=>document.body?.dataset.startupState==='ready');
      await page.locator('#relayImageConnection').waitFor({state:'attached'});
      await page.waitForTimeout(200);
      assert(await page.locator('.view.active').getAttribute('data-panel')==='account','Local startup failure did not fall back to account');
      const initial=await api('/state');
      assert(initial.requests.some(value=>value.path==='/api/startup'&&value.light),'Light startup failure not exercised');
      assert(initial.calls.keyWrites===0&&initial.calls.keyClears===0&&initial.calls.paid===0&&initial.calls.cli===0&&initial.calls.python===0,'Startup fallback triggered an unrequested operation');
      assert(initial.upstream.length===0&&initial.assetReads===0,'Local fallback eagerly loaded assets or relay');
      const performance=await page.evaluate(()=>({fcpMs:window.performance.getEntriesByName('first-contentful-paint')[0]?.startTime??null,localReadyMs:window.performance.getEntriesByName('hamster-local-ready')[0]?.startTime??null}));
      await page.locator('.rail-item[data-view="history"]').click();
      await page.locator('#historyList').waitFor({state:'visible'});
      assert(await page.locator('.view.active').getAttribute('data-panel')==='history','History unavailable after startup failure');
      await page.locator('.rail-item[data-view="assets"]').click();
      await page.getByText('合成本地素材47',{exact:true}).waitFor();
      assert(await page.locator('.view.active').getAttribute('data-panel')==='assets','Assets unavailable after startup failure');
      const end=await api('/state');
      assert(end.upstream.length===0&&end.calls.keyWrites===0&&end.calls.keyClears===0&&end.calls.paid===0&&end.calls.cli===0&&end.calls.python===0,'Manual local navigation initiated a remote or billable operation');
      cases.push({fault,initialView:'account',startupState:'ready',historyAvailable:true,unconfiguredAccountHistoryNotExposed:true,assetsAvailable:true,performance,initialRequests:initial.requests,finalRequests:end.requests,upstream:end.upstream,calls:end.calls,blockedFetches:end.blockedFetches});
    }
    assert(errors.length===0,'Startup null path emitted a pageerror');assert(external.length===0,'External browser request');
    const result={success:true,format:1,scope:'synthetic-loopback-Chrome',cases,pageErrors:errors.length,externalRequests:external.length,realKeyUse:0,realBillableRequests:0,realCli:0,realPython:0,notExecuted:['Real customer login/payment/Key activation','Production deployment','Packaged EXE startup']};
    await api('/result-local-failure',result);return {success:true,cases:cases.length,pageErrors:0,output:'output/hamster-onboarding47-20261023/startup-local-failure.json'};
  }catch(error){let state;try{state=await api('/state');}catch{}await api('/result-local-failure',{success:false,format:1,cases,errors,failure:error.message,state});throw error;}
}
