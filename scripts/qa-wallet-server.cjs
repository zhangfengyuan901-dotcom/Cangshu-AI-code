// Offline UI fixture: no real mail, upstream generation, notification or payment.
const fs=require('node:fs'),path=require('node:path');
const root=fs.mkdtempSync(path.resolve('output/playwright/wallet-qa-'));
let account=false;const recharges=[];
const models=[{id:'main-video-720',name:'主线路 · 标准720P',type:'video',provider:'generate',resolutions:['720p'],durations:[4,5,10,15],ratios:['16:9','9:16','1:1'],max_images:30,max_videos:10,max_audios:10,max_media_files:50,display_price_yuan:15},
 {id:'main-image-a',name:'主线路图片 · 标准',type:'image',provider:'generate',aspect_ratios:['1:1','16:9','9:16'],quality_options:['auto'],max_images:9,max_media_files:9,display_price_yuan:.1},
 {id:'backup-video-480',name:'官方备选线路 · 480P',type:'video',provider:'official',resolutions:['480p'],durations:[4,5,10],ratios:['16:9','9:16'],max_images:9,max_media_files:15,display_price_yuan_per_second:.55}];
const walletClient={request:async(cfg,p,o={})=>{
 if(p==='/v1/auth/code')return {challenge_id:'otp_fixture',expires_in:600};
 if(p==='/v1/auth/verify'){account=true;return {token:'ha_'+'a'.repeat(64),user_id:'user_'+'b'.repeat(32),email:'fixture@example.com'};}
 if(p==='/v1/auth/logout'){account=false;return {ok:true};}
 if(!account)throw Object.assign(Error('请先登录账户'),{statusCode:401});
 if(p==='/v1/models')return {data:[...models,{id:'tool-digital',name:'数字人',type:'video',provider:'tool',display_price_yuan:5,price_version:1},{id:'tool-depth',name:'黑白深度',type:'video',provider:'tool',display_price_yuan:0,free:true,price_version:1}]};
 if(p==='/v1/status')return {connected:true};
 if(p==='/v1/me')return {email:'fixture@example.com',email_verified:true,balance:100,frozen_balance:15,available_balance:85};
 if(p==='/v1/ledger')return {data:[]};
 if(p==='/v1/recharges'&&o.method==='POST'){const r={id:'topup_'+'c'.repeat(32),state:'pending',amount:Number(JSON.parse(o.body).amount)*1e6,payment_reference:'RQA123456',created_at:Date.now(),payment_reported:0};recharges.push(r);return r;}
 if(p==='/v1/recharges')return {data:recharges};
 if(p.endsWith('/paid')){recharges[0].payment_reported=1;return {ok:true};}
 throw Object.assign(Error('离线验收不提交生成'),{statusCode:503});
}};
const server=require('../server').createApp({walletMode:true,walletClient,configPath:path.join(root,'config.json'),resultDir:path.join(root,'results'),assetDir:path.join(root,'assets'),taskDir:path.join(root,'tasks'),smartVideoLauncher:{prepare:async()=>({status:'ready'}),status:async()=>({status:'ready'}),stop(){}},inferenceGateway:{handle:async(req,res)=>{res.setHeader('Content-Type','application/json');res.end('{"configured":true}');}}});
server.listen(8791,'127.0.0.1',()=>console.log('Offline wallet fixture http://127.0.0.1:8791'));
