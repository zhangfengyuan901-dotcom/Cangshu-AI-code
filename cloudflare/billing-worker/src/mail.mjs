import {all,one,run,now,id,fail,bytesLimited,money} from './common.mjs';

export async function sendEmail(env,payload,key,fetchImpl=fetch){
 if(!env.RESEND_API_KEY||!env.MAIL_FROM)throw fail('邮件服务尚未配置，请联系管理员',503);
 let response;
 try{response=await fetchImpl('https://api.resend.com/emails',{method:'POST',headers:{Authorization:'Bearer '+env.RESEND_API_KEY,'Content-Type':'application/json','Idempotency-Key':key},body:JSON.stringify(payload),signal:AbortSignal.timeout(15000)});}catch{throw fail('邮件发送结果暂未确认，请稍后重试',503);}
 // Never log 邮件服务's body: it may contain personal data or the submitted code.
 if(!response.ok){await response.body?.cancel();throw fail('邮件服务暂不可用（'+response.status+'）',503);}
 const result=JSON.parse(new TextDecoder().decode(await bytesLimited(response.body,16384)));
 if(typeof result.id!=='string')throw fail('邮件发送结果暂未确认',503);
 return result.id;
}
export function mailPayload(env,to,subject,text){return {from:env.MAIL_FROM,to:[to],subject,text,...(env.MAIL_REPLY_TO?{reply_to:env.MAIL_REPLY_TO}:{})};}

// The transactional outbox is created by the same D1 transaction as the credit.
// Durable cron recovery + a lease covers crashes; 邮件服务 deduplicates the identical payload.
export async function drainMail(env,fetchImpl=fetch,limit=1){
 const rows=await all(env,"SELECT id FROM mail_outbox WHERE state IN ('pending','retry','sending') AND next_attempt<=? AND lease_until<=? ORDER BY created_at LIMIT ?",now(),now(),limit);
 for(const row of rows){
  const lease=id('mail');
  const claimed=await one(env,"UPDATE mail_outbox SET state='sending',lease_id=?,lease_until=?,first_attempt=COALESCE(first_attempt,?),attempts=attempts+1 WHERE id=? AND state IN ('pending','retry','sending') AND lease_until<=? RETURNING *",lease,now()+120000,now(),row.id,now());
  if(!claimed)continue;
  // 邮件服务's idempotency window is 24h. Stop automatic retries before it expires.
  if(now()-claimed.first_attempt>=23*3600000){await run(env,"UPDATE mail_outbox SET state='needs_review',last_error='超过安全重试窗口，请核对 邮件服务 邮件记录',lease_until=0 WHERE id=? AND lease_id=?",row.id,lease);continue;}
  try{
   const ledger=await one(env,"SELECT id FROM ledger WHERE id=? AND kind='recharge'",row.id);
   if(!ledger)throw fail('入账流水未确认',503);
   const payload=claimed.payload||JSON.stringify(mailPayload(env,claimed.recipient,'仓鼠AI 充值到账通知',`您好，您的充值已由管理员核实并入账。\n\n到账金额：¥${money(claimed.amount).toFixed(2)}\n订单备注号：${claimed.payment_reference}\n\n请打开 仓鼠AI 账户中心查看余额和流水。如有疑问，请联系管理员。`));
   await run(env,'UPDATE mail_outbox SET payload=? WHERE id=? AND lease_id=?',payload,row.id,lease);
   const providerId=await sendEmail(env,JSON.parse(payload),row.id,fetchImpl);
   await run(env,"UPDATE mail_outbox SET state='sent',provider_id=?,sent_at=?,last_error='',lease_until=0 WHERE id=? AND lease_id=?",providerId,now(),row.id,lease);
  }catch(e){await run(env,"UPDATE mail_outbox SET state='retry',next_attempt=?,last_error=?,lease_until=0 WHERE id=? AND lease_id=?",now()+Math.min(3600000,60000*2**Math.min(claimed.attempts,6)),e.status?e.message:'邮件发送结果未确认',row.id,lease);}
 }
}

