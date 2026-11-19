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
  // Store only the allowed diagnostic fields.
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
  return json({accepted:true},202);
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
  async scheduled(_event,env) {
    const now=Date.now();
    await env.DB.batch([env.DB.prepare('DELETE FROM receipts WHERE created<?').bind(now-30*DAY),env.DB.prepare('DELETE FROM incidents WHERE created<?').bind(now-30*DAY),env.DB.prepare('DELETE FROM mail_slots WHERE hour<?').bind(Math.floor((now-30*DAY)/HOUR))]);
  },
};
