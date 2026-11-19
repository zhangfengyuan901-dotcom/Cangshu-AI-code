import {WorkflowEntrypoint} from 'cloudflare:workers';
import {json,body,fail,id,now,all,one,run,stmt,authenticate,requestId,units,money,signedUrl,validFileUrl,bytesLimited} from './common.mjs';
import {quote,publicModel,createTask,claimKey,publicTask,finishFailure} from './billing.mjs';
import {validateReferences,submitTask,pollTask,transferTask} from './providers.mjs';
import {adminRead,adminWrite} from './admin.mjs';
import {requestCode,verifyCode,cleanAuth} from './auth.mjs';
import {drainMail} from './mail.mjs';
import {reportPayment} from './recharges.mjs';
import {handleAdminAuth,authenticateAdmin,requireAdminOrigin,cleanAdminAuth} from './admin-auth.mjs';

async function startWorkflow(env,taskId){
 try{await env.GENERATION.create({id:taskId,params:{taskId}});}catch(e){const instance=await env.GENERATION.get(taskId);const status=await instance.status();if(['errored','complete','terminated'].includes(status.status))await instance.restart();}
}
export class GenerationWorkflow extends WorkflowEntrypoint {
 async run(event,step){
  const taskId=event.payload.taskId;
  for(let attempt=0;attempt<2000;attempt++){
   const state=await step.do('advance-'+attempt,{retries:{limit:2,delay:'10 seconds',backoff:'exponential'},timeout:'10 minutes'},async()=>{
    let task=await one(this.env,'SELECT * FROM tasks WHERE id=?',taskId);if(!task||['failed','succeeded','cancelled'].includes(task.state))return 'done';
    if(task.state==='queued')await claimKey(this.env,taskId);
    task=await one(this.env,'SELECT * FROM tasks WHERE id=?',taskId);
    if(task.state==='preparing')await submitTask(this.env,taskId);
    else if(task.state==='submitting')await run(this.env,"UPDATE tasks SET state='unknown',error='提交中断，等待人工核查',updated_at=? WHERE id=? AND state='submitting'",now(),taskId);
    else if(['processing','unknown'].includes(task.state)&&task.upstream_id)await pollTask(this.env,taskId);
    else if(task.state==='transferring')await transferTask(this.env,taskId);
    const updated=await one(this.env,'SELECT state,upstream_id FROM tasks WHERE id=?',taskId);
    if(updated.state==='unknown'&&!updated.upstream_id)return 'review';
    return ['failed','succeeded','cancelled'].includes(updated.state)?'done':'wait';
   });
   if(state==='done'||state==='review')return {state};
   await step.sleep('pause-'+attempt,'30 seconds');
  }return {state:'continue_later'};
 }
}
async function fileResponse(request,env,url){
 if(!await validFileUrl(env,url))throw fail('素材链接已过期，请刷新任务',403);
 const object=await env.RESULTS.get(url.pathname.slice('/v1/files/'.length),{range:request.headers});if(!object)throw fail('文件不存在',404);
 const headers=new Headers({'cache-control':'private, max-age=60','x-content-type-options':'nosniff','accept-ranges':'bytes'});object.writeHttpMetadata(headers);headers.set('etag',object.httpEtag);
 let status=200;if(object.range){const {offset=0,length}=object.range;headers.set('content-range',`bytes ${offset}-${offset+length-1}/${object.size}`);headers.set('content-length',String(length));status=206;}else headers.set('content-length',String(object.size));
 return new Response(request.method==='HEAD'?null:object.body,{status,headers});
}
async function handle(request,env,ctx){
 const url=new URL(request.url),path=url.pathname;
 if(path==='/health')return json({service:'hamster-billing',version:'1.0.0'});
 if(path.startsWith('/v1/files/')&&['GET','HEAD'].includes(request.method))return fileResponse(request,env,url);
 if(path.startsWith('/admin/api/auth/'))return handleAdminAuth(request,env);
 if(path.startsWith('/admin/api/')){const admin=await authenticateAdmin(request,env),section=path.slice('/admin/api/'.length);if(request.method==='GET')return json(await adminRead(env,section));if(request.method==='POST'){requireAdminOrigin(request);const result=await adminWrite(env,admin.actor,section,await body(request));if(section==='recharge-review')ctx.waitUntil(drainMail(env).catch(()=>console.error('mail_outbox_pending')));return json(result);}throw fail('方法不支持',405);}
 if(!path.startsWith('/v1/'))return env.ASSETS.fetch(request);
 if(['/v1/auth/code','/v1/auth/verify'].includes(path)&&request.method==='POST'){
  const p=await body(request,4096),ip=request.headers.get('CF-Connecting-IP')||'unknown';
  return json(await (path.endsWith('/code')?requestCode(env,p,ip):verifyCode(env,p,ip)));
 }
 const user=await authenticate(request,env);
 if(path==='/v1/auth/logout'&&request.method==='POST'){await run(env,"UPDATE api_keys SET status='revoked' WHERE id=?",user.key_id);return json({ok:true});}
 if(path==='/v1/status'&&request.method==='GET')return json({connected:true,storage:'临时对象存储'});
 if(path==='/v1/objects'&&request.method==='DELETE'){
  const p=await body(request);const keys=[];for(const value of [...(p.urls||[]),...(p.keys||[])]){let key=String(value);if(key.startsWith('https://')){const u=new URL(key);if(u.origin!==url.origin||!await validFileUrl(env,u))throw fail('素材地址无效',403);key=u.pathname.slice('/v1/files/'.length);}if(!key.startsWith('input/'+user.id+'/')||key.includes('..'))throw fail('无权删除该素材',403);keys.push(key);}
  if(keys.length>100)throw fail('一次最多清理 100 个素材');if(keys.length)await env.RESULTS.delete(keys);return json({deleted:keys.length});
 }
 if(path==='/v1/me'&&request.method==='GET')return json({id:user.id,email:user.email,email_verified:Boolean(user.email_verified_at),name:user.name,test_account:Boolean(user.is_test),balance:money(user.balance),frozen_balance:money(user.held),available_balance:money(user.balance-user.held),payee:env.PAYEE,qr_url:'/alipay.jpg'});
 if(path==='/v1/models'&&request.method==='GET')return json({data:(await all(env,'SELECT * FROM models WHERE enabled=1 AND visible=1')).map(publicModel)});
 if(path==='/v1/models/low-cost'&&request.method==='GET')return json({data:(await all(env,"SELECT * FROM models WHERE enabled=1 AND provider='main'")).map(publicModel)});
 if(path==='/v1/ledger'&&request.method==='GET')return json({data:await all(env,'SELECT kind,amount,balance_delta,held_delta,reference_id,note,created_at FROM ledger WHERE user_id=? ORDER BY created_at DESC LIMIT 200',user.id)});
 if(path==='/v1/recharges'){
  if(request.method==='GET')return json({data:await all(env,"SELECT * FROM recharges WHERE user_id=? AND state IN ('pending','approved') ORDER BY created_at DESC LIMIT 100",user.id)});
  if(request.method==='POST'){
   if(user.is_test)throw fail('内部测试账户不能申请充值',403);
   const p=await body(request),amount=units(p.amount);if(amount<1000000||amount>100000000000||amount%10000)throw fail('充值金额需为 1—100000 元，最多两位小数');const key=requestId(request);
   if(!user.email_verified_at)throw fail('请先验证账户邮箱，再申请充值',403);
   const prior=await one(env,'SELECT * FROM recharges WHERE user_id=? AND request_id=?',user.id,key);if(prior){if(prior.amount!==amount)throw fail('订单金额不能更改',409);return json(prior);}
   const open=await one(env,"SELECT id FROM recharges WHERE user_id=? AND state='pending' AND payment_reported=0",user.id);if(open)throw fail('已有待付款订单，请在充值窗口继续处理',409);
   const orderId=id('topup'),reference='R'+crypto.randomUUID().replaceAll('-','').slice(0,12).toUpperCase();
   await run(env,'INSERT INTO recharges(id,user_id,email_snapshot,amount,request_id,created_at,payment_reference,payment_reported) VALUES (?,?,?,?,?,?,?,0)',orderId,user.id,user.email,amount,key,now(),reference);
   return json(await one(env,'SELECT * FROM recharges WHERE id=?',orderId),201);
  }
 }
 const paid=path.match(/^\/v1\/recharges\/(topup_[a-f0-9]{32})\/paid$/);
 if(paid&&request.method==='POST'){
  return json(await reportPayment(env,user,paid[1],await body(request,4096)));
 }
 if(path==='/v1/upload'&&request.method==='POST'){
  const type=(request.headers.get('content-type')||'').split(';')[0],ext=({'image/png':'png','image/jpeg':'jpg','image/webp':'webp','video/mp4':'mp4','video/webm':'webm','video/quicktime':'mov','audio/mpeg':'mp3','audio/wav':'wav','audio/mp4':'m4a','audio/aac':'aac'})[type];
  if(!ext||!request.body)throw fail('素材类型不支持');const size=Number(request.headers.get('content-length'));if(!Number.isSafeInteger(size)||size<1||size>50*1024*1024)throw fail('素材必须为 1 字节至 50MB',413);
  const key='input/'+user.id+'/'+id('asset')+'.'+ext;await env.RESULTS.put(key,request.body,{httpMetadata:{contentType:type},customMetadata:{user_id:user.id,created_at:String(now())}});
  return json({file:{key,url:await signedUrl(env,url.origin,key,86400),size,contentType:type}},201);
 }
 if(path==='/v1/quote'&&request.method==='POST'){const p=await body(request),model=await one(env,'SELECT * FROM models WHERE id=? AND enabled=1',p.model);if(!model)throw fail('模型未开放');const q=quote(model,p);return json({estimated_cost:money(q.reserved),version:q.version,currency:'CNY'});}
 if(path==='/v1/tasks'&&request.method==='POST'){
  if((await one(env,"SELECT value FROM settings WHERE key='generation_enabled'"))?.value!=='true')throw fail('生成服务尚未开放，请联系管理员；本次未扣费',409);
  const p=await body(request);if(p.concurrency!==undefined&&Number(p.concurrency)!==1)throw fail('每个任务请求仅生成一份结果');await validateReferences(env,user,p,url.origin);
  const task=await createTask(env,user,p,requestId(request));ctx.waitUntil(startWorkflow(env,task.id).catch(()=>console.error(JSON.stringify({event:'workflow_start_pending',task_id:task.id}))));return json(await publicTask(env,task,url.origin),202);
 }
 if(path==='/v1/tasks'&&request.method==='GET'){const tasks=await all(env,'SELECT * FROM tasks WHERE user_id=? ORDER BY created_at DESC LIMIT 100',user.id);return json({data:await Promise.all(tasks.map(t=>publicTask(env,t,url.origin)))});}
 if(path==='/v1/tasks/by-request'&&request.method==='GET'){const task=await one(env,'SELECT * FROM tasks WHERE user_id=? AND request_id=?',user.id,url.searchParams.get('key')||'');if(!task)throw fail('尚未查到该请求，请核查后再决定是否重新提交',404);return json(await publicTask(env,task,url.origin));}
 const match=path.match(/^\/v1\/tasks\/(task_[a-f0-9]+)(\/cancel)?$/);if(match){const task=await one(env,'SELECT * FROM tasks WHERE id=? AND user_id=?',match[1],user.id);if(!task)throw fail('任务不存在',404);if(request.method==='POST'&&match[2]){await finishFailure(env,task.id,'客户取消排队',true);return json({ok:true});}if(request.method==='GET'&&!match[2])return json(await publicTask(env,task,url.origin));}
 throw fail('接口不存在',404);
}
export default {
 async fetch(request,env,ctx){try{return await handle(request,env,ctx);}catch(e){const message=String(e.message||e);const constraint=/UNIQUE constraint|CHECK constraint|CUSTOMER_|KEY_FULL|ACCOUNT_FULL|TASK_TERMINAL|ALREADY_SUBMITTED|RESULT_REQUIRED|RECHARGE_ALREADY_REVIEWED/.test(message);const status=e.status||(constraint?409:500);if(status===500)console.error(JSON.stringify({event:'request_failed',status:500}));return json({error:status===500?'服务暂不可用，请稍后重试':constraint?'操作冲突、余额不足或记录已处理，请刷新后核对':message},status);}},
 async scheduled(controller,env,ctx){
  await drainMail(env,fetch,10);await cleanAuth(env);await cleanAdminAuth(env);
  const tasks=await all(env,"SELECT id FROM tasks WHERE state IN ('queued','preparing','submitting','processing','transferring') OR (state='unknown' AND upstream_id IS NOT NULL) ORDER BY updated_at LIMIT 100");
  for(const task of tasks){try{await startWorkflow(env,task.id);}catch{console.error(JSON.stringify({event:'workflow_recovery_pending',task_id:task.id}));}}
 }
};
