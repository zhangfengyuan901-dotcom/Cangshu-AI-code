// Desktop bridge. Browser code never receives the account bearer token.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {createClient,enabled,verifyQr}=require('./billing-client.cjs');
const send=(res,status,data)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(data));};
const fail=(text,statusCode=400)=>Object.assign(Error(text),{statusCode});
async function read(req){let size=0;const parts=[];for await(const p of req){size+=p.length;if(size>1024*1024)throw fail('请求过大',413);parts.push(p);}return Buffer.concat(parts);}
function createWallet({load,save,publicDir,taskStore,client=createClient()}){
 const request=(route,options)=>{const cfg=load();if(!enabled(cfg))throw fail('请先用邮箱验证码登录',401);return client.request(cfg,route,options);};
 const status=()=>({walletMode:true,billingConfigured:enabled(load()),configured:enabled(load()),videoConfigured:enabled(load()),rhConfigured:enabled(load()),llmConfigured:enabled(load()),inferenceMode:'cloud-auto'});
 const handles=p=>p.startsWith('/api/billing/')||['/api/models','/api/public-models','/api/canvas/models','/api/images','/api/videos','/api/official-videos','/api/tools/digital','/api/tools/depth'].includes(p)||p.startsWith('/rh/');
 async function handle(req,res,url){
  if(!/^127\.0\.0\.1:\d+$/.test(req.headers.host||'')||req.headers.origin&&req.headers.origin!==`http://${req.headers.host}`)throw fail('请求来源无效',403);
  const p=url.pathname,route=p.slice('/api/billing'.length);
  if(p.startsWith('/rh/'))throw fail('旧版工具入口已停用，请使用新版工具页面',410);
  if(['/api/models','/api/public-models','/api/canvas/models'].includes(p))return send(res,200,await request('/v1/models'));
  if(['/api/images','/api/videos','/api/official-videos','/api/tools/digital','/api/tools/depth'].includes(p)){
   if(req.method!=='POST')throw fail('操作不支持',405);
   const cfg=load();if(!enabled(cfg))throw fail('请先用邮箱验证码登录',401);
   let payload;try{payload=JSON.parse(await read(req));}catch{throw fail('生成参数无效');}
   const models=(await request('/v1/models')).data,model=models.find(m=>m.id===payload.model);
   const tool=p.startsWith('/api/tools/')?p.split('/').pop():'';
   if(!model||model.type!==(p==='/api/images'?'image':'video')||(model.provider==='official')!==(p==='/api/official-videos')||(model.provider==='tool')!==Boolean(tool)||tool&&model.id!=='tool-'+tool)throw fail('请选择当前渠道可用线路');
   const count=Number(payload.concurrency??1);if(![1,2,4].includes(count)||tool&&count!==1)throw fail('任务份数无效');
   const key=String(req.headers['idempotency-key']||'');if(!/^[a-zA-Z0-9:_-]{8,140}$/.test(key))throw fail('提交编号无效');
   const journal=taskStore(),out=[];
   const fingerprint=crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
   for(let i=0;i<count;i++){
    const requestId=key+':'+i,prior=journal.list().find(t=>t.walletUser===cfg.billingUserId&&t.requestId===requestId);
    if(prior){if(prior.walletFingerprint!==fingerprint)throw fail('同一请求编号不能更换生成内容',409);out.push(prior);continue;}
    const item=journal.begin(p,{...payload,concurrency:1},'',requestId);
    journal.annotate(item,{walletUser:cfg.billingUserId,walletFingerprint:fingerprint,modelName:model.name,...(tool?{source:tool}:{})});
    try{const result=await client.request(cfg,'/v1/tasks',{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':requestId},body:JSON.stringify({...payload,concurrency:1})});await journal.capture(item,result,202);}
    catch(e){if(e.statusCode>=400&&e.statusCode<500&&e.statusCode!==408)await journal.capture(item,{error:e.message},e.statusCode);else await journal.capture(item,{id:'pending_'+crypto.createHash('sha256').update(cfg.billingUserId+':'+requestId).digest('hex').slice(0,32),status:'processing'},202);}
    out.push(journal.list().find(t=>t.walletUser===cfg.billingUserId&&t.requestId===requestId));
   }
   return send(res,202,{accepted:true,tasks:out.filter(Boolean),task:out[0]});
  }
  if(route==='/qr'&&req.method==='GET'){const bytes=fs.readFileSync(path.join(publicDir,'billing-alipay.jpg'));if(!verifyQr(bytes))throw fail('收款码校验失败，请联系支持',503);res.writeHead(200,{'Content-Type':'image/jpeg','Cache-Control':'no-store'});return res.end(bytes);}
  if(['/auth/code','/auth/verify'].includes(route)&&req.method==='POST'){
   const result=await client.request({},'/v1'+route,{method:'POST',headers:{'Content-Type':'application/json'},body:await read(req)});
   if(route==='/auth/verify'){if(!/^ha_[a-f0-9]{64}$/.test(result.token||'')||!/^user_[a-f0-9]{32}$/.test(result.user_id||''))throw fail('账户验证结果无效',502);save({...load(),billingApiKey:result.token,billingUserId:result.user_id});return send(res,200,{ok:true,email:result.email});}
   return send(res,200,result);
  }
  if(route==='/auth/logout'&&req.method==='POST'){
   if(enabled(load()))try{await request('/v1/auth/logout',{method:'POST'});}catch(e){if(e.statusCode!==401)throw e;}
   const cfg=load();delete cfg.billingApiKey;delete cfg.billingUserId;save(cfg);return send(res,200,{ok:true});
  }
  if(!(req.method==='GET'&&['/me','/recharges','/ledger'].includes(route)||req.method==='POST'&&(route==='/recharges'||/^\/recharges\/topup_[a-f0-9]{32}\/paid$/.test(route))))throw fail('账户操作不存在',404);
  return send(res,200,await request('/v1'+route,{method:req.method,...(req.method==='POST'?{headers:{'Content-Type':'application/json','Idempotency-Key':String(req.headers['idempotency-key']||'')},body:await read(req)}:{})}));
 }
 return {handles,handle,status,upload:(data,metadata)=>{if(!enabled(load()))throw fail('请先登录账户',401);return client.upload(load(),data,metadata);},deleteObjects:objects=>request('/v1/objects',{method:'DELETE',headers:{'Content-Type':'application/json'},body:JSON.stringify({urls:objects})}),check:()=>request('/v1/status'),
  query:async item=>{if(item.walletUser!==load().billingUserId)throw fail('请登录原任务所属账户',401);return request(item.id.startsWith('pending_')?'/v1/tasks/by-request?key='+encodeURIComponent(item.requestId):'/v1/tasks/'+encodeURIComponent(item.id));}};
}
module.exports={createWallet};
