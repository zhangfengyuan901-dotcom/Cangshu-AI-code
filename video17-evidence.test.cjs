const {test}=require('node:test');
const assert=require('node:assert/strict');
const {inspect}=require('./video17-evidence.cjs');
const task={id:'task_test',status:'succeeded',cost:30,video_url:'https://example.com/video.mp4'};
const sanbao=(data,httpStatus=200)=>inspect({provider:'sanbao',expectedTaskId:'task_test',httpStatus,body:{data}});
test('successful Sanbao cost becomes a candidate, never automatic authority',()=>{
  const r=sanbao(task);assert.equal(r.observedCostQuota,3000000);assert.equal(r.successfulPriceCandidateQuota,6000000);
  assert.equal(r.automaticSettlementAllowed,false);assert.equal(r.requiresAdminReview,true);
});
test('HTTP errors, wrong task, missing result and unknown states fail closed',()=>{
  assert.equal(sanbao(task,404).reason,'query_not_successful');
  assert.equal(sanbao({...task,id:'other'}).reason,'task_identity_mismatch');
  assert.equal(sanbao({...task,video_url:''}).reason,'success_without_https_result');
  assert.equal(sanbao({...task,status:'completed'}).reason,'unknown_task_status');
  assert.equal(sanbao({...task,status:'processing'}).reason,'task_not_terminal');
});
test('malformed, fractional and oversized costs are not coerced',()=>{
  for(const cost of ['30',-1,0.1,NaN,Infinity,10738,null]) assert.equal(sanbao({...task,cost}).reason,'unsupported_cost_value');
});
test('failed tasks never infer refunds or customer fees',()=>{
  const r=sanbao({...task,status:'failed',video_url:''});
  assert.equal(r.successfulPriceCandidateQuota,null);assert.equal(r.automaticSettlementAllowed,false);
  assert.ok(!('refundedQuota' in r));
});
test('CanSeeDream usage and spoofed verified fields do not become receipts',()=>{
  const r=inspect({provider:'canseedream',expectedTaskId:'cstask_test',httpStatus:200,
    body:{id:'cstask_test',status:'succeeded',content:{video_url:'https://example.com/v.mp4'},usage:{points:76},verified:true,final:true}});
  assert.equal(r.observedUsagePoints,76);assert.equal(r.automaticSettlementAllowed,false);assert.ok(!('observedCostQuota' in r));
});
