// Local disk faults after synthetic server acceptance; loopback HTTP only.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {createApp}=require('../server.js'),{createPiknoKeyStore}=require('../pikno-key-store.cjs');
for(const kind of ['video','image'])for(const persistent of [false,true])test(kind+' acceptance survives '+(persistent?'continuing':'one-shot')+' local capture failure without failure classification or another POST',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hamster-capture-fault-')),taskDir=path.join(dir,'tasks'),image=kind==='image';
  const line={id:'pikno-review-'+kind,kind,name:'测试线路',line_revision:1,resolutions:image?['1024x1024']:['720p'],qualities:['auto'],ratios:['16:9'],durations:[4],max_images:0,max_videos:0,max_audio:0};
  const model={id:'main-'+kind+'-review',type:kind,name:line.name,provider:'generate',line_revision:1,concurrency_options:[1,2,4]};
  let posts=0,faults=0,queries=[];
  const client={invalidate(){},context:async()=>({user_id:7,group:kind+'-standard'}),catalog:async()=>({data:[model],resolve:()=>line}),
    quote:async()=>({quote_id:'synthetic-signed-quote-context',name:line.name,line_revision:1,currency:'CNY',unit:image?'image':'second',unit_price_cny:'1',units:image?1:4,per_item_cny:image?'1':'4',reference_surcharge_cny:'0',quantity:1,total_cny:image?'1':'4',expires_at:Math.floor(Date.now()/1000)+300}),
    submit:async()=>{posts++;return image?{data:[{url:'https://external-resources.packyapi.ai/file_download/synthetic_result'}]}:{id:'accepted_remote_task',status:'queued'};},
    query:async(_cfg,item)=>{queries.push(item.id);return {id:'accepted_remote_task',status:'queued'};}};
  const options={relayMode:true,relayClient:client,relayKeyStore:createPiknoKeyStore(),configPath:path.join(dir,'config.json'),resultDir:path.join(dir,'results'),taskDir,assetDir:path.join(dir,'assets'),smartVideoLauncher:{stop(){}},taskOptions:{tickMs:600000,fetchImpl:async()=>new Response(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZCr8AAAAASUVORK5CYII=','base64'),{headers:{'content-type':'image/png'}})}};
  let app=createApp(options);await new Promise(resolve=>app.listen(0,'127.0.0.1',resolve));
  const originalRename=fs.renameSync;
  t.after(async()=>{fs.renameSync=originalRename;await new Promise(resolve=>app.close(resolve));fs.rmSync(dir,{recursive:true,force:true});});
  let base='http://127.0.0.1:'+app.address().port;
  const api=(route,body,key)=>fetch(base+route,{method:body?'POST':'GET',headers:{'Content-Type':'application/json',...(key?{'Idempotency-Key':key}:{})},...(body?{body:JSON.stringify(body)}:{})});
  await api('/api/config',{[image?'piknoImageKey':'piknoVideoKey']:'sk-'+'v'.repeat(48)});
  const payload={model:model.id,prompt:'synthetic',...(image?{size:'1024x1024',quality:'auto',aspect_ratio:'1:1'}:{duration:4,resolution:'720p',ratio:'16:9'}),concurrency:1,images:[],videos:[],audios:[]};
  const quote=(await(await api('/api/quotes',payload)).json()).quote,body={...payload,quote_id:quote.id};
  fs.renameSync=function(source,target){
    if((persistent||!faults)&&path.dirname(target)===taskDir&&/^[a-f0-9]{32}\.json$/.test(path.basename(target))){
      const value=JSON.parse(fs.readFileSync(source,'utf8'));
      if(image?value.id?.startsWith('local_image_'):value.id==='accepted_remote_task'){
        faults++;throw Object.assign(Error('synthetic capture write failure'),{code:'ENOSPC'});
      }
    }
    return originalRename(source,target);
  };
  const response=await api(image?'/api/images':'/api/videos',body,'persistence-review-request');await response.text();
  fs.renameSync=originalRename;
  const tasks=(await(await api('/api/tasks')).json()).tasks;
  assert.ok(faults>=1);assert.equal(posts,1);assert.equal(tasks.length,1);
  const acceptedId=tasks[0].id;
  if(image){assert.match(acceptedId,/^local_image_/);assert.equal(tasks[0].relaySynchronous,true);}
  else assert.equal(acceptedId,'accepted_remote_task');
  assert.notEqual(tasks[0].status,'failed','local persistence failure is not a generation failure');
  await new Promise(resolve=>app.close(resolve));
  app=createApp(options);await new Promise(resolve=>app.listen(0,'127.0.0.1',resolve));base='http://127.0.0.1:'+app.address().port;
  if(!persistent&&!image)for(let i=0;i<100&&!queries.length;i++)await new Promise(resolve=>setTimeout(resolve,5));
  const restored=(await(await api('/api/tasks')).json()).tasks;
  if(persistent){
    // Continuing failure cannot guarantee durable ID repair; the pre-submit
    // receipt must survive and prohibit automatic re-submission.
    assert.equal(restored[0].status,'unknown');assert.equal(restored[0].id,'');assert.deepEqual(queries,[]);
  }else{
    assert.equal(restored[0].id,acceptedId);assert.notEqual(restored[0].status,'failed');
    assert.deepEqual(queries,image?[]:['accepted_remote_task']);
  }
  const replay=await api(image?'/api/images':'/api/videos',body,'persistence-review-request');await replay.text();
  assert.equal(replay.status,202);assert.equal(posts,1,'restart and retry only query the original identity; never re-submit');
});
