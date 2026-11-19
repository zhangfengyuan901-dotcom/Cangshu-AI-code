import {all,one,run,stmt,id,now,fail,hash,randomToken,crypt,integer,units,money,audit,reason} from './common.mjs';
export async function issueKey(env,userId,name){const secret=randomToken(),keyId=id('key');await run(env,'INSERT INTO api_keys(id,user_id,name,token_hash,preview,created_at) VALUES (?,?,?,?,?,?)',keyId,userId,name||'仓鼠AI 客户端',await hash(secret),secret.slice(0,8)+'…'+secret.slice(-4),now());return {id:keyId,secret};}
export async function adminRead(env,section){
 if(section==='overview')return {customers:await one(env,'SELECT COUNT(*) AS count,SUM(balance) AS balance,SUM(held) AS held FROM customers WHERE is_test=0'),tasks:await all(env,'SELECT state,COUNT(*) AS count FROM tasks GROUP BY state'),recharges:await one(env,"SELECT COUNT(*) AS count FROM recharges WHERE state='pending' AND payment_reported=1"),settings:await all(env,'SELECT * FROM settings'),channels:await all(env,"SELECT a.provider,COUNT(k.id) AS active_keys FROM provider_accounts a LEFT JOIN provider_keys k ON k.account_id=a.id AND k.provider=a.provider AND k.status='active' GROUP BY a.provider")};
 if(section==='customers')return all(env,'SELECT * FROM customers ORDER BY created_at DESC LIMIT 500');
 if(section==='keys')return all(env,'SELECT k.id,k.user_id,c.email,k.name,k.preview,k.status,k.created_at,k.last_used_at,k.version FROM api_keys k JOIN customers c ON c.id=k.user_id ORDER BY k.created_at DESC LIMIT 500');
 if(section==='pool')return {accounts:await all(env,'SELECT a.*,(SELECT COUNT(*) FROM key_leases l JOIN provider_keys k ON k.id=l.key_id WHERE k.account_id=a.id) AS inflight FROM provider_accounts a'),keys:await all(env,'SELECT k.id,k.account_id,k.provider,k.name,k.preview,k.status,k.max_concurrency,k.priority,k.cooldown_until,k.last_error,(SELECT COUNT(*) FROM key_leases WHERE key_id=k.id) AS inflight FROM provider_keys k')};
 if(section==='recharges')return all(env,"SELECT r.*,c.email FROM recharges r JOIN customers c ON c.id=r.user_id WHERE r.payment_reported=1 AND r.state IN ('pending','approved') ORDER BY COALESCE(r.payment_reported_at,r.created_at) DESC LIMIT 500");
 if(section==='tasks')return all(env,'SELECT t.id,t.user_id,c.email,t.provider,t.model_id,t.state,t.reserved,t.charged,t.provider_key_id,t.upstream_id,t.error,t.created_at FROM tasks t JOIN customers c ON c.id=t.user_id ORDER BY t.created_at DESC LIMIT 500');
 if(section==='ledger')return all(env,'SELECT l.*,c.email FROM ledger l JOIN customers c ON c.id=l.user_id ORDER BY l.created_at DESC LIMIT 500');
 if(section==='models')return all(env,'SELECT * FROM models');
 if(section==='audit')return all(env,'SELECT * FROM audit ORDER BY created_at DESC LIMIT 500');
 if(section==='notifications')return all(env,'SELECT id,order_id,recipient,state,attempts,provider_id,last_error,created_at,sent_at FROM mail_outbox ORDER BY created_at DESC LIMIT 500');
 throw fail('管理接口不存在',404);
}
export async function adminWrite(env,actor,section,p){
 const note=reason(p);
 if(section==='customers'){
  const email=String(p.email||'').trim().toLowerCase();if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||email.length>254)throw fail('请填写有效邮箱');
  const userId=id('user');await env.DB.batch([stmt(env,'INSERT INTO customers(id,email,name,max_concurrency,created_at,is_test) VALUES (?,?,?,?,?,?)',userId,email,String(p.name||'').slice(0,100),integer(p.max_concurrency??100,1,1000,'客户并发'),now(),p.is_test===true?1:0),audit(env,actor,'customer.create',userId,{email,is_test:p.is_test===true,reason:note})]);
  return {user_id:userId};
 }
 if(section==='test-credit'){
  const customer=await one(env,'SELECT id,is_test FROM customers WHERE id=?',p.id);
  if(!customer||customer.is_test!==1)throw fail('仅内部测试账户可发放测试额度',403);
  await env.DB.batch([
   stmt(env,"INSERT INTO ledger(id,user_id,kind,amount,held_delta,balance_delta,reference_id,note,created_at) VALUES (?,?,'test_credit',22300000,0,22300000,?,'内部测试额度，不对应实际收款',?)",'test-credit:'+customer.id,customer.id,customer.id,now()),
   audit(env,actor,'test.credit',customer.id,{amount:'22.30',reason:note})
  ]);
  return {ok:true};
 }
 if(section==='customer-status'){
  if(!['active','disabled'].includes(p.status))throw fail('状态无效');
  await env.DB.batch([stmt(env,'UPDATE customers SET status=?,max_concurrency=? WHERE id=?',p.status,integer(p.max_concurrency??100,1,1000,'客户并发'),p.id),audit(env,actor,'customer.status',p.id,{status:p.status,reason:note})]);return {ok:true};
 }
 if(section==='keys'){
  throw fail('客户请通过邮箱验证码登录，不能手动签发登录凭证',405);
 }
 if(section==='key-action'){
  if(p.action==='rotate')throw fail('请撤销旧会话后由客户重新验证邮箱',405);
  const key=await one(env,'SELECT * FROM api_keys WHERE id=?',p.id);if(!key)throw fail('Key 不存在',404);
  if(key.status==='revoked')throw fail('Key 已永久撤销',409);if(Number(p.version)!==key.version)throw fail('Key 已更新，请刷新',409);
  const status=({pause:'paused',resume:'active',revoke:'revoked',rotate:key.status})[p.action];if(!status)throw fail('操作无效');
  const secret=p.action==='rotate'?randomToken():null;
  const results=await env.DB.batch([stmt(env,'UPDATE api_keys SET status=?,token_hash=?,preview=?,version=version+1 WHERE id=? AND version=?',status,secret?await hash(secret):key.token_hash,secret?secret.slice(0,8)+'…'+secret.slice(-4):key.preview,p.id,key.version),audit(env,actor,'key.'+p.action,p.id,{reason:note})]);
  if(!results[0].meta.changes)throw fail('Key 已更新，请刷新',409);return {ok:true,...(secret?{secret}:{})};
 }
 if(section==='provider-account'){
  if(!['backup','image','main','tool'].includes(p.provider))throw fail('渠道无效');const accountId=id('pa');
  await env.DB.batch([stmt(env,'INSERT INTO provider_accounts VALUES (?,?,?,?)',accountId,p.provider,String(p.name||p.provider).slice(0,100),integer(p.max_concurrency??100,1,1000,'账户并发')),audit(env,actor,'provider.account',accountId,{provider:p.provider,reason:note})]);return {id:accountId};
 }
 if(section==='pool'){
  const account=await one(env,'SELECT * FROM provider_accounts WHERE id=?',p.account_id);if(!account)throw fail('请先建立上游账户分组');
  const secret=String(p.secret||'').trim();if(secret.length<8||secret.length>1024)throw fail('上游密钥格式无效');const keyId=id('upkey');
  await env.DB.batch([stmt(env,'INSERT INTO provider_keys(id,account_id,provider,name,encrypted_secret,fingerprint,preview,max_concurrency,priority,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',keyId,account.id,account.provider,String(p.name||account.name).slice(0,100),await crypt(env.KEY_ENCRYPTION_SECRET,secret),await hash(secret),secret.slice(0,4)+'…'+secret.slice(-4),integer(p.max_concurrency??100,1,100,'Key 并发'),integer(p.priority??0,0,100,'优先级'),now()),audit(env,actor,'pool.create',keyId,{provider:account.provider,reason:note})]);return {id:keyId};
 }
 if(section==='pool-update'){
  if(!['active','paused'].includes(p.status))throw fail('状态无效');
  await env.DB.batch([stmt(env,'UPDATE provider_keys SET status=?,max_concurrency=?,priority=? WHERE id=?',p.status,integer(p.max_concurrency??100,1,100,'Key 并发'),integer(p.priority??0,0,100,'优先级'),p.id),audit(env,actor,'pool.update',p.id,{status:p.status,reason:note})]);return {ok:true};
 }
 if(section==='provider-account-update'){
  await env.DB.batch([stmt(env,'UPDATE provider_accounts SET max_concurrency=? WHERE id=?',integer(p.max_concurrency,1,1000,'账户并发'),p.id),audit(env,actor,'provider.account.update',p.id,{max_concurrency:p.max_concurrency,reason:note})]);return {ok:true};
 }
 if(section==='refund'){
  const task=await one(env,"SELECT * FROM tasks WHERE id=? AND state='succeeded'",p.id);if(!task||task.charged<=0)throw fail('任务没有可退回的费用');
  await env.DB.batch([stmt(env,"INSERT OR IGNORE INTO ledger VALUES (?,?,'refund',?,0,?,?,?,?)",'refund:'+task.id,task.user_id,task.charged,task.charged,task.id,note,now()),audit(env,actor,'task.refund',task.id,{amount:money(task.charged),reason:note})]);return {ok:true};
 }
 if(section==='recharge-review'){
  if(typeof p.approve!=='boolean')throw fail('请选择审核结论');
  const order=await one(env,'SELECT * FROM recharges WHERE id=?',p.id);if(!order)throw fail('充值订单不存在',404);
  if(order.state!=='pending'){if(p.approve&&order.state==='approved')return {ok:true,state:'approved'};throw fail('已处理的充值不能删除或再次审核',409);}
  if(order.payment_reported!==1)throw fail('请核实已付款订单并二次确认入账',409);
  const reviewedAt=now(),transaction=p.approve?String(p.transaction_id||'').trim():null;
  let receivedAt=null;
  if(p.approve){
   if(!/^[a-zA-Z0-9_-]{6,100}$/.test(transaction)||units(p.confirmed_amount)!==order.amount)throw fail('请核实交易号，实际到账金额必须与订单一致');
   if(p.manual_confirmed!==true)throw fail('请核实已付款订单并二次确认入账');
   receivedAt=integer(p.received_at,1,reviewedAt,'实际到账时间');
  }
  // Conditional audit + mutation are one transaction; a concurrent reviewer cannot
  // delete a credited order, create a second audit entry, or credit twice.
  const results=await env.DB.batch([
   stmt(env,"INSERT INTO audit(id,actor,action,target,detail,created_at) SELECT ?,?,?,?,?,? FROM recharges WHERE id=? AND state='pending' AND payment_reported=1",id('audit'),actor,p.approve?'recharge.approved':'recharge.deleted',p.id,JSON.stringify(p.approve?{transaction_id:transaction,received_at:receivedAt,reason:note}:{reason:note}),reviewedAt,p.id),
   p.approve?stmt(env,"UPDATE recharges SET state='approved',transaction_id=?,note=?,reviewed_by=?,reviewed_at=?,received_at=? WHERE id=? AND state='pending' AND payment_reported=1",transaction,note,actor,reviewedAt,receivedAt,p.id):stmt(env,"DELETE FROM recharges WHERE id=? AND state='pending' AND payment_reported=1",p.id)
  ]);
  if(!results[1].meta.changes)throw fail('申请已被其他操作处理，请刷新',409);
  return {ok:true,state:p.approve?'approved':'deleted'};
 }
 if(section==='sync-prices')throw fail('售价必须由管理员确认，禁止自动覆盖',409);
 if(section==='model-update'){
  const model=await one(env,'SELECT * FROM models WHERE id=?',p.id);if(!model)throw fail('模型不存在',404);

  const cost=p.cost_rate===undefined?model.cost_rate:units(p.cost_rate); const sale=p.sale_rate===undefined?model.fixed_sale:units(p.sale_rate); if(!(sale>0)&&!(model.id==='tool-depth'&&sale===0)&&p.enabled!==false)throw fail('请先确认售价');
  await env.DB.batch([stmt(env,'UPDATE models SET cost_rate=?,fixed_sale=?,enabled=?,version=version+1,updated_at=? WHERE id=?',cost,sale,p.enabled===false?0:1,now(),p.id),audit(env,actor,'price.update',p.id,{cost_rate:money(cost),reason:note})]);return {ok:true};
 }
 if(section==='generation-switch'){
  if(p.enabled===true){const ready=await all(env,"SELECT DISTINCT k.provider FROM provider_keys k JOIN provider_accounts a ON a.id=k.account_id WHERE a.provider=k.provider AND k.status='active'");if(!['main','backup'].every(p=>ready.some(k=>k.provider===p)))throw fail('请先配置并启用主线路和官方备选线路密钥',409);}
  await env.DB.batch([stmt(env,"UPDATE settings SET value=? WHERE key='generation_enabled'",p.enabled===true?'true':'false'),audit(env,actor,'generation.switch','platform',{enabled:p.enabled===true,reason:note})]);return {ok:true};
 }
 if(section==='task-reconcile'){
  const task=await one(env,'SELECT * FROM tasks WHERE id=?',p.id);if(!task||!['unknown','submitting'].includes(task.state))throw fail('此任务无需提交核查',409);
  if(p.upstream_id){if(!/^[a-zA-Z0-9_-]{1,200}$/.test(p.upstream_id))throw fail('上游任务编号无效');
   await env.DB.batch([stmt(env,"UPDATE tasks SET upstream_id=?,state='processing',error='',updated_at=? WHERE id=? AND state IN ('unknown','submitting')",p.upstream_id,now(),p.id),audit(env,actor,'task.reconcile',p.id,{upstream_id:p.upstream_id,reason:note})]);
  }else if(p.confirmed_failed===true){await env.DB.batch([stmt(env,"UPDATE tasks SET state='failed',error=?,updated_at=? WHERE id=? AND state IN ('unknown','submitting')",'人工核实失败：'+note,now(),p.id),audit(env,actor,'task.failure',p.id,{reason:note})]);}
  else throw fail('请填写已核实的上游任务编号，或确认失败');return {ok:true};
 }
 throw fail('管理操作不存在',404);
}
