// Independent audit: both requests pass pre-catalog checks before either claims.
// All cloud boundaries are synthetic; only loopback HTTP is used.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createApp}=require('../server.js'),{createPiknoKeyStore}=require('../pikno-key-store.cjs');
const until=async condition=>{for(let i=0;i<200;i++){if(await condition())return;await new Promise(r=>setTimeout(r,5));}throw Error('audit condition timed out');};
test('late catalog cannot claim a completed receipt again after successful task cards are cleared',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hamster-late-claim-')),gates=[];
  let hold=false,posts=0,quoteId=0;
  const line={id:'pikno-review-video',kind:'video',name:'测试线路',line_revision:1,resolutions:['720p'],ratios:['16:9'],durations:[4],max_images:0,max_videos:0,max_audio:0};
  const model={id:'main-video-review',type:'video',name:line.name,provider:'generate',line_revision:1,concurrency_options:[1,2,4]};
  const catalog={data:[model],resolve:()=>line},completed=id=>({id,status:'completed',results:[{url:'https://synthetic.test/result.png',outputType:'png'}]});
  const client={invalidate(){},context:async()=>({user_id:7,group:'video-standard'}),
    catalog:async()=>{if(hold)await new Promise(resolve=>gates.push(resolve));return catalog;},
    quote:async()=>({quote_id:'synthetic-signed-quote-'+(++quoteId),name:line.name,line_revision:1,currency:'CNY',unit:'second',unit_price_cny:'1',units:4,per_item_cny:'4',reference_surcharge_cny:'0',quantity:1,total_cny:'4',expires_at:Math.floor(Date.now()/1000)+300}),
    submit:async()=>completed('task_'+(++posts)),query:async(_cfg,item)=>completed(item.id)};
  const app=createApp({relayMode:true,relayClient:client,relayKeyStore:createPiknoKeyStore(),
    configPath:path.join(dir,'config.json'),resultDir:path.join(dir,'results'),taskDir:path.join(dir,'tasks'),assetDir:path.join(dir,'assets'),smartVideoLauncher:{stop(){}},
    taskOptions:{tickMs:600000,fetchImpl:async()=>new Response(Buffer.from('synthetic-result'),{headers:{'content-type':'image/png'}})}});
  await new Promise(resolve=>app.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{gates.forEach(release=>release());await new Promise(resolve=>app.close(resolve));fs.rmSync(dir,{recursive:true,force:true});});
  const base='http://127.0.0.1:'+app.address().port;
  const api=(route,body,key,method)=>fetch(base+route,{method:method||(body?'POST':'GET'),headers:{'Content-Type':'application/json',...(key?{'Idempotency-Key':key}:{})},...(body?{body:JSON.stringify(body)}:{})});
  await api('/api/config',{piknoVideoKey:'sk-'+'v'.repeat(48)});
  const payload={model:model.id,prompt:'synthetic',duration:4,resolution:'720p',ratio:'16:9',concurrency:1,images:[],videos:[],audios:[]};
  const firstQuote=(await(await api('/api/quotes',payload)).json()).quote,secondQuote=(await(await api('/api/quotes',payload)).json()).quote;
  hold=true;
  const first=api('/api/videos',{...payload,quote_id:firstQuote.id},'late-catalog-request');await until(()=>gates.length===1);
  const second=api('/api/videos',{...payload,quote_id:secondQuote.id},'late-catalog-request');await until(()=>gates.length===2);
  gates[0]();const accepted=await(await first).json();assert.equal(posts,1);
  await api('/api/tasks/'+accepted.task.key+'/retry',{});
  await until(async()=>Boolean((await(await api('/api/tasks')).json()).tasks[0]?.result?.local_url));
  await api('/api/tasks',undefined,undefined,'DELETE');
  assert.equal((await(await api('/api/tasks')).json()).tasks.length,0);
  gates[1]();const late=await second;await late.text();
  assert.equal(posts,1,'an old durable receipt must win over a late fresh quote after task-card cleanup');
  assert.equal(late.status,409,'same request identity cannot change its quote fingerprint');
});
