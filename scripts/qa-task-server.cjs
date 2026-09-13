// Isolated, offline task lifecycle fixture. All upstream traffic stays on loopback.
const fs=require('node:fs'), path=require('node:path'), http=require('node:http');
const root=fs.mkdtempSync(path.resolve('output/playwright/task-qa-'));
const configPath=path.join(root,'config.json');
fs.writeFileSync(configPath,JSON.stringify({apiKey:'offline-fixture'}));
const tasks=new Map();
const models=[{id:'image_2_5_flare',name:'Image 2.5 Flare',type:'image',aspect_ratios:['1:1'],quality_options:['auto'],default_quality:'auto'},
  {id:'hailuo_h3_2k_line2',name:'MinimaxH3',type:'video',ratios:['9:16'],durations:[5]}];
const mock=http.createServer(async(req,res)=>{
  if(req.url==='/fixture.png'){res.setHeader('Content-Type','image/png');fs.createReadStream('public/hamster-logo.png').pipe(res);return;}
  res.setHeader('Content-Type','application/json');
  if(req.url.includes('models'))return res.end(JSON.stringify({data:models}));
  if(req.method==='POST'){
    const chunks=[];for await(const c of req)chunks.push(c);
    const payload=JSON.parse(Buffer.concat(chunks).toString());
    const id='offline-'+Date.now();tasks.set(id,{polls:0,payload});
    res.statusCode=201;return res.end(JSON.stringify({task_id:id,status:'preparing'}));
  }
  const id=req.url.split('/').pop(),task=tasks.get(id);
  if(!task){res.statusCode=404;return res.end('{}');}
  task.polls++;
  const done=task.polls>=4;
  res.end(JSON.stringify({data:{task_id:id,status:done?'succeeded':'processing',progress:done?100:task.polls*20,
    image_url:done?`http://127.0.0.1:${mock.address().port}/fixture.png`:'',link_expires_in:60}}));
});
mock.listen(0,'127.0.0.1',()=>{
  require('../server').createApp({upstream:`http://127.0.0.1:${mock.address().port}`,configPath,resultDir:path.join(root,'results'),taskDir:path.join(root,'journal'),taskOptions:{interval:1500,tickMs:200}})
    .listen(8789,'127.0.0.1',()=>console.log('Offline task UI QA :8789'));
});
