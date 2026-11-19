// Isolated browser fixture. It has no customer Key and cannot call an upstream.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createApp}=require('../server.js'),{createPiknoKeyStore}=require('../pikno-key-store.cjs');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hamster-pikno-ui-'));
const keyStore=createPiknoKeyStore();
const models=[{id:'main-image-1234abcd',name:'主线路 · 图片',type:'image',provider:'generate',aspect_ratios:['1:1','3:2','2:3','16:9','9:16','auto'],size_options:['1024x1024','2048x2048','1536x1024','1024x1536','1536x864','2048x1152','3840x2160','2160x3840','auto'],quality_options:['auto','low','medium','high'],default_quality:'auto',concurrency_options:[1],max_images:5,max_videos:0,max_audios:0,max_media_files:5,billing_mode:'relay'},
 {id:'main-video-5678abcd',name:'主线路 · 视频 · 720p',type:'video',provider:'generate',ratios:['16:9','9:16'],resolutions:['720p'],durations:[4,5],concurrency_options:[1],max_images:9,max_videos:3,max_audios:3,max_media_files:15,billing_mode:'relay'},
 ...(process.env.HAMSTER_QA_TOOLS==='1'?['digital','depth']:[]).map(kind=>({id:'tool-'+kind,name:kind==='digital'?'数字人':'黑白深度视频',type:'video',provider:'tool',concurrency_options:[1],billing_mode:'relay'}))];
const client={context:async(cfg,kind)=>{
 const expected='sk-'+(kind==='image'?'a':kind==='tool'?'c':'b').repeat(48),key=cfg[kind==='image'?'piknoImageKey':kind==='tool'?'piknoToolKey':'piknoVideoKey'];
 if(key!==expected)throw Object.assign(Error('离线测试 Key 类型错误'),{statusCode:403});
 return {user_id:7,group:kind+'-standard'};
},catalog:async cfg=>({data:models.filter(model=>model.provider==='tool'?cfg.piknoToolKey:model.type==='image'?cfg.piknoImageKey:cfg.piknoVideoKey),resolve:id=>models.find(m=>m.id===id)&&{id,kind:id.includes('image')?'image':'video'}}),submit:async()=>{throw Object.assign(Error('此离线页面不生成真实任务'),{statusCode:400})},query:async()=>({status:'queued'}),upload:async(cfg,data,metadata)=>{
 for await(const _ of data){}
 return {file:{url:'https://www.piknoai.com/media/v1/assets/'+require('node:crypto').randomBytes(16).toString('hex')+'?ticket=offline-test-only'}};
}};
const prepared=async()=>({status:'ready',progress:{percent:100}});
const app=createApp({relayMode:true,relayClient:client,relayKeyStore:keyStore,configPath:path.join(dir,'config.json'),resultDir:path.join(dir,'results'),taskDir:path.join(dir,'tasks'),assetDir:path.join(dir,'assets'),canvasDir:path.join(dir,'canvas'),openBrowserImpl:()=>{},smartVideoLauncher:{stop(){},status:prepared,prepare:prepared,open:async()=>({status:'ready',url:'about:blank'})},inferenceGateway:{handle:async(_req,res)=>{res.writeHead(keyStore.read().piknoUserId?503:401,{'Content-Type':'application/json'});res.end(JSON.stringify({error:'离线测试：智能服务尚未开放'}));}}});
app.listen(Number(process.env.HAMSTER_QA_PORT)||0,'127.0.0.1',()=>console.log('PIKNO offline browser fixture: http://127.0.0.1:'+app.address().port));
function close(){app.close(()=>{fs.rmSync(dir,{recursive:true,force:true});process.exit(0);});}
process.on('SIGINT',close);process.on('SIGTERM',close);
