import {one,now,fail} from './common.mjs';

export async function reportPayment(env,user,orderId,payload){
 if(!user.email_verified_at)throw fail('请先验证账户邮箱',403);
 if(payload.payment_confirmed!==true)throw fail('请确认已按申请金额完成付款');
 // The server records the first customer confirmation, never an asserted receipt time.
 const order=await one(env,"UPDATE recharges SET payment_reported_at=CASE WHEN payment_reported=0 THEN ? ELSE payment_reported_at END,payment_reported=1 WHERE id=? AND user_id=? AND state='pending' RETURNING payment_reported_at",now(),orderId,user.id);
 if(!order)throw fail('申请不存在或已处理，请刷新记录',409);
 return {ok:true,state:'pending',payment_reported_at:order.payment_reported_at};
}
