'use strict';
// Observation only. Neither a provider usage value nor a caller-supplied
// `verified` flag grants authority to settle a production wallet.
const crypto = require('node:crypto');
function inspect({provider, expectedTaskId, httpStatus, body}) {
  const result = {provider, taskId:expectedTaskId, automaticSettlementAllowed:false, requiresAdminReview:true};
  if (httpStatus !== 200) return {...result, reason:'query_not_successful', httpStatus};
  if (!body || typeof body !== 'object' || Array.isArray(body)) return {...result,reason:'invalid_response'};
  const task = provider === 'sanbao' ? body.data : body;
  if (!task || typeof task !== 'object' || Array.isArray(task) || task.id !== expectedTaskId) return {...result,reason:'task_identity_mismatch'};
  const statuses=provider==='sanbao'?['queued','processing','succeeded','failed']:['queued','running','succeeded','failed'];
  if (!statuses.includes(task.status)) return {...result,reason:'unknown_task_status'};
  result.generationState=task.status;
  result.responseSHA256=crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex');
  if (!['succeeded','failed'].includes(task.status)) return {...result,reason:'task_not_terminal'};
  const media=provider==='sanbao'?task.video_url:task.content?.video_url;
  if (task.status==='succeeded') {
    try { if(new URL(media).protocol!=='https:') throw Error(); }
    catch {return {...result,reason:'success_without_https_result'};}
  }
  if(provider==='sanbao') {
    // Fixed-point integer conversion: accepting only supported whole credits
    // here avoids rounding unknown upstream precision into a wallet charge.
    if(!Number.isSafeInteger(task.cost)||task.cost<0||task.cost>10737) return {...result,reason:'unsupported_cost_value'};
    return {...result,observedCredits:task.cost,creditsPerCNY:10,observedCostQuota:task.cost*100000,
      successfulPriceCandidateQuota:task.status==='succeeded'?task.cost*200000:null,
      reason:'task_cost_observed_finality_and_refunds_need_confirmation'};
  }
  if(provider==='canseedream') {
    const points=task.usage?.points;
    return {...result,observedUsagePoints:Number.isSafeInteger(points)&&points>=0?points:null,
      reason:'usage_is_not_a_final_payment_receipt'};
  }
  return {...result,reason:'unsupported_provider'};
}
module.exports={inspect};
