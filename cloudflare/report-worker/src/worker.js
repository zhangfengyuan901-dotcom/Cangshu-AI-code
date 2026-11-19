import schema from '../../../report-schema.cjs';
const {normalizeReport}=schema;
const json=(value,status=200)=>Response.json(value,{status,headers:{'cache-control':'no-store','x-content-type-options':'nosniff'}});
const HOUR=3600000,DAY=86400000;
export async function readReport(request) {
  if(!request.headers.get('content-type')?.startsWith('application/json'))throw Error('invalid');
  const reader=request.body?.getReader();if(!reader)throw Error('invalid');
  const chunks=[];let size=0;
  while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>4096){await reader.cancel();throw Error('large');}chunks.push(value);}
  const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
  const value=JSON.parse(new TextDecoder().decode(bytes));
  if(!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value?.id))throw Error('invalid');
  // Rebuild rather than forwarding arbitrary client properties into storage or email.
  return {id:value.id,report:normalizeReport(value.report)};
}
async function hash(value){return [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)))].map(n=>n.toString(16).padStart(2,'0')).join('');}
export async function receive(request,env) {
  if(!(await env.RATE.limit({key:request.headers.get('cf-connecting-ip') || 'unknown'})).success)return json({retry:true},429);
  if(!(await env.GLOBAL_RATE.limit({key:'all'})).success)return json({retry:true},429);
  let entry;try{entry=await readReport(request);}catch{return json({error:'invalid_report'},400);}
  const now=Date.now(),fingerprint=await hash(JSON.stringify(entry.report)+Math.floor(now/HOUR));
  await env.DB.batch([
    env.DB.prepare('INSERT OR IGNORE INTO receipts(id,fingerprint,created) VALUES(?,?,?)').bind(entry.id,fingerprint,now),
    env.DB.prepare('INSERT INTO incidents(fingerprint,created,updated,payload) SELECT fingerprint,?,?,? FROM receipts WHERE id=? ON CONFLICT(fingerprint) DO UPDATE SET updated=excluded.updated').bind(now,now,JSON.stringify(entry.report),entry.id),
  ]);
  // Use the original grouping when a previously accepted request is retried across an hour boundary.
  const receipt=await env.DB.prepare('SELECT fingerprint FROM receipts WHERE id=?').bind(entry.id).first();
  await env.MAIL_QUEUE.send({fingerprint:receipt.fingerprint});
  return json({accepted:true},202);
}
export async function deliver(fingerprint,env,fetchImpl=fetch) {
  if(!/^[a-f0-9]{64}$/.test(fingerprint))return;
  const item=await env.DB.prepare('SELECT * FROM incidents WHERE fingerprint=?').bind(fingerprint).first();
  if(!item)return;
  const total=await env.DB.prepare('SELECT COUNT(*) AS total FROM receipts WHERE fingerprint=?').bind(fingerprint).first();
  const report={...normalizeReport(JSON.parse(item.payload)),firstSeen:new Date(item.created).toISOString(),lastSeen:new Date(item.updated).toISOString(),reports:total.total};
  const key=`reports/${new Date(item.created).toISOString().slice(0,10)}/${fingerprint}.json`;
  await env.REPORTS.put(key,JSON.stringify(report,null,2),{httpMetadata:{contentType:'application/json'}});
  if(item.notified || Date.now()-item.created>23*HOUR)return;
  // Cap mail volume globally, independent of spoofed versions or report IDs.
  const hour=Math.floor(Date.now()/HOUR);
  await env.DB.prepare('INSERT OR IGNORE INTO mail_slots(fingerprint,hour) SELECT ?,? WHERE (SELECT COUNT(*) FROM mail_slots WHERE hour=?)<20').bind(fingerprint,hour,hour).run();
  const slot=await env.DB.prepare('SELECT fingerprint FROM mail_slots WHERE fingerprint=?').bind(fingerprint).first();
  if(!slot){await env.DB.prepare('UPDATE incidents SET notified=-1 WHERE fingerprint=?').bind(fingerprint).run();return;}
  await env.DB.prepare('UPDATE incidents SET attempts=attempts+1 WHERE fingerprint=?').bind(fingerprint).run();
  const response=await fetchImpl('https://api.resend.com/emails',{method:'POST',headers:{Authorization:`Bearer ${env.MAIL_API_KEY}`,'Content-Type':'application/json','Idempotency-Key':`fault-${fingerprint}`},body:JSON.stringify({
    from:'仓鼠AI故障通知 <alerts@mail.hamsterai.cc>',to:['1060761161@qq.com'],
    subject:`[仓鼠AI ${report.version}] ${report.module} · ${report.code}`,
    text:`收到自动脱敏故障报告（同类问题按小时合并）。\n\n${JSON.stringify({...normalizeReport(JSON.parse(item.payload)),firstSeen:report.firstSeen},null,2)}\n\n报告已存入私有存储。编号：${fingerprint}\n重复报告数在存储中更新。仅包含限定诊断字段，不包含密钥、提示词、聊天内容、素材、路径或原始错误文本。\n本通知为匿名故障定位线索，不代表已确定根因或已验证客户身份。`,
  }),signal:AbortSignal.timeout(15000)});
  await response.body?.cancel().catch(()=>{});
  if(!response.ok)throw Error('mail_delivery_failed');
  await env.DB.prepare('UPDATE incidents SET notified=1 WHERE fingerprint=?').bind(fingerprint).run();
}
export default {
  async fetch(request,env) {
    try {
      const url=new URL(request.url);
      if(request.method==='GET' && url.pathname==='/health')return json({ok:true});
      if(request.method==='POST' && url.pathname==='/v1/reports')return await receive(request,env);
      return json({error:'not_found'},404);
    }catch{return json({error:'temporarily_unavailable'},503);}
  },
  async queue(batch,env) {
    for(const message of batch.messages){try{await deliver(message.body?.fingerprint,env);message.ack();}catch{message.retry({delaySeconds:300});}}
  },
  async scheduled(_event,env) {
    const now=Date.now();
    const rows=await env.DB.prepare('SELECT fingerprint FROM incidents WHERE notified=0 AND created>? ORDER BY created LIMIT 20').bind(now-23*HOUR).all();
    for(const row of rows.results)await env.MAIL_QUEUE.send({fingerprint:row.fingerprint});
    await env.DB.batch([env.DB.prepare('DELETE FROM receipts WHERE created<?').bind(now-30*DAY),env.DB.prepare('DELETE FROM incidents WHERE created<?').bind(now-30*DAY),env.DB.prepare('DELETE FROM mail_slots WHERE hour<?').bind(Math.floor((now-30*DAY)/HOUR))]);
  },
};
