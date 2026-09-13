async (page) => {
  // Browser-only fixtures. Every studio API request is intercepted; no generation
  // request or upload can reach a paid upstream service in this check.
  let job = null;
  let submitted = null;
  const stages = ['market_agent','storyboard_agent','image_agent','image_evaluate_agent','video_agent','video_evaluate_agent','release_agent'];
  const names = ['营销策划','分镜脚本','首帧生成','图片评选','视频生成','视频评选','合成成片'];
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/studio-api/**', async route => {
    const url = { pathname: route.request().url().split('?')[0] };
    if(url.pathname.endsWith('/result')) return route.fulfill({
      path:'output/playwright/qa-video.mp4', contentType:'video/mp4',
      headers:route.request().url().includes('download=true')?{'Content-Disposition':'attachment; filename=qa-video.mp4'}:{}
    });
    let body;
    if (url.pathname.endsWith('/config')) body = {mediaReady:true,llmReady:true,output:'桌面 / 仓鼠AI生成结果 / 智能成片',active:job?.status==='running'?job.id:null};
    else if (url.pathname.endsWith('/upload')) body = {url:'http://127.0.0.1:8003/hamster-logo.png'};
    else if (url.pathname.endsWith('/cancel')) { job.status='cancelled'; job.error='已停止后续流程'; body=job; }
    else if (url.pathname.endsWith('/jobs') && route.request().method()==='POST') {
      submitted = route.request().postDataJSON();
      job = {id:'qa-fixture',brief:submitted,status:'running',created:new Date().toISOString(),updated:new Date().toISOString(),error:'',result:null,
        stages:stages.map((id,i)=>({id,title:names[i],status:i===0?'running':'pending',text:'',media:[]}))};
      body=job;
    } else if (url.pathname.endsWith('/jobs')) body=job?[{id:job.id,product:job.brief.product,status:job.status,created:job.created}]:[];
    else body=job;
    await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(body)});
  });
  await page.goto('http://127.0.0.1:8003/');
  await page.setViewportSize({width:1440,height:1080});
  await page.getByRole('button',{name:'女装穿搭',exact:true}).click();
  await page.getByText('更多创作设置',{exact:true}).click();
  await page.getByLabel('每个分镜的候选数量').selectOption('2');
  const logo = await page.request.get('http://127.0.0.1:8003/hamster-logo.png');
  await page.locator('#fileInput').setInputFiles({name:'商品参考.png',mimeType:'image/png',buffer:await logo.body()});
  await page.getByText('已上传，可用于生成',{exact:true}).waitFor();
  await page.getByRole('button',{name:'开始制作',exact:true}).click();
  await page.locator('#jobStatus').filter({hasText:'制作中'}).waitFor();
  if(submitted.candidates!==2 || submitted.seconds!==5 || !submitted.image_url) throw new Error('Brief or image payload was lost');
  job.stages[0].text='营销策划：自然穿搭，突出面料与版型。';
  job.stages[0].status='complete';job.stages[1].status='running';
  job.stages[1].text='分镜1：通勤全景。\n分镜2：面料细节。\n分镜3：日常搭配。\n分镜4：商品展示。';
  await page.locator('#output-storyboard_agent').waitFor();
  await page.screenshot({path:'output/playwright/smart-studio-running.png',fullPage:true});
  job.status='failed';job.error='离线测试：上游返回失败';job.stages[1].status='failed';
  await page.locator('#jobError').filter({hasText:'离线测试：上游返回失败'}).waitFor();
  await page.reload();
  await page.locator('#jobStatus').filter({hasText:'制作失败'}).waitFor();
  await page.getByRole('button',{name:'复用需求',exact:true}).click();
  await page.getByRole('button',{name:'开始制作',exact:true}).click();
  await page.locator('#jobStatus').filter({hasText:'制作中'}).waitFor();
  await page.getByRole('button',{name:'停止制作',exact:true}).click();
  await page.locator('#jobStatus').filter({hasText:'已停止'}).waitFor();
  await page.getByRole('button',{name:'开始制作',exact:true}).click();
  await page.locator('#jobStatus').filter({hasText:'制作中'}).waitFor();
  job.stages.forEach(stage=>stage.status='complete');
  job.status='success';job.result={name:'qa-video.mp4',url:'/studio-api/jobs/qa-fixture/result'};
  await page.getByRole('link',{name:'下载成片',exact:true}).waitFor();
  await page.waitForFunction(()=>document.querySelector('#finalResult video')?.readyState>=1);
  const downloading=page.waitForEvent('download');
  await page.getByRole('link',{name:'下载成片',exact:true}).click();
  const download=await downloading;
  await download.saveAs('output/playwright/qa-downloaded.mp4');
  await page.setViewportSize({width:390,height:844});
  const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth);
  if(overflow) throw new Error('Mobile layout overflows');
  if(errors.length) throw new Error(errors.join('\n'));
  console.log('PASS: upload, brief payload, seven-stage updates, failure recovery, history reload, cancellation, result playback/download, mobile layout; no paid API calls');
  await page.unroute('**/studio-api/**');
  await page.evaluate(()=>localStorage.clear());
  await page.goto('http://127.0.0.1:8003/');
}
