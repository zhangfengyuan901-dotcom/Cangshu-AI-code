const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {normalizeReport,codeFor,framesFromStack}=require('./report-schema.cjs');
const ENDPOINT='https://reports.hamsterai.cc/v1/reports';
function createReporter({dir,version,endpoint=ENDPOINT,fetchImpl=fetch,now=Date.now,enabled=true}={}) {
  const file=path.join(dir,'pending-reports.json');
  let state={pending:[],seen:{}},running=false,timer,closed=false;
  const hour=3600000,retention=30*86400000;
  try {
    const saved=JSON.parse(fs.readFileSync(file,'utf8'));
    state.pending=(saved.pending || []).filter(x=>/^[a-f0-9-]{36}$/.test(x.id)&&now()-x.at<retention).slice(-100)
      .map(x=>({id:x.id,at:x.at,tries:Number(x.tries)||0,next:Number(x.next)||0,report:normalizeReport(x.report)}));
    state.seen=Object.fromEntries(Object.entries(saved.seen || {}).filter(([key,value])=>/^[a-f0-9]{64}$/.test(key)&&Number.isFinite(value)&&now()-value<hour));
  }catch{}
  function persist() {
    try{fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(file+'.tmp',JSON.stringify(state),{mode:0o600});fs.renameSync(file+'.tmp',file);}catch{}
  }
  function capture(module,error={},extra={}) {
    if(!enabled || closed)return;
    try {
      const report=normalizeReport({...extra,version,module,platform:process.platform,arch:process.arch,
        code:extra.code || codeFor(error),httpStatus:extra.httpStatus || Number(error?.statusCode || error?.status_code || error?.status),
        frames:extra.frames || framesFromStack(error?.stack)});
      const fingerprint=crypto.createHash('sha256').update(JSON.stringify(report)).digest('hex');
      if(state.seen[fingerprint]>now()-hour)return;
      state.seen=Object.fromEntries(Object.entries(state.seen).filter(([,at])=>at>now()-hour).slice(-999));
      state.seen[fingerprint]=now();
      state.pending.push({id:crypto.randomUUID(),at:now(),tries:0,next:0,report});state.pending=state.pending.slice(-100);persist();
      void flush();
    }catch{} // Reporting must never change the outcome of the customer's operation.
  }
  async function flush() {
    if(!enabled || running || closed)return;
    running=true;
    try {
      for(const item of [...state.pending]) {
        if(closed)break;
        if(now()-item.at>retention){state.pending=state.pending.filter(x=>x!==item);continue;}
        if(item.next>now())continue;
        try {
          const response=await fetchImpl(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},
            body:JSON.stringify({id:item.id,report:normalizeReport(item.report)}),signal:AbortSignal.timeout(10000)});
          await response.body?.cancel().catch(()=>{});
          if(response.ok || [400,413,422].includes(response.status)){state.pending=state.pending.filter(x=>x!==item);}
          else throw Error('retry');
        }catch{item.tries++;item.next=now()+Math.min(hour,30000*2**Math.min(item.tries,7));}
        persist();
      }
      persist();
    }finally{running=false;}
  }
  if(enabled){timer=setInterval(()=>void flush(),30000);timer.unref?.();void flush();}
  return {capture,flush,close(){if(closed)return;closed=true;clearInterval(timer);persist();},pendingCount:()=>state.pending.length};
}
module.exports={createReporter,ENDPOINT};
