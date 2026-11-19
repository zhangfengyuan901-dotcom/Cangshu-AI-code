const assert=require('node:assert/strict');
async function until(check,timeout=3000){const end=Date.now()+timeout;while(Date.now()<end){const result=await check();if(result)return result;await new Promise(resolve=>setTimeout(resolve,10));}assert.fail('offline batch did not reach the expected durable state');}
async function settleBatch(api,response){
  const accepted=response instanceof Response?await response.json():response;
  if(!accepted.batch)return accepted;
  const batch=await until(async()=>{const r=await api('/api/relay/batches'),b=(await r.json()).batches.find(b=>b.id===accepted.batch.id);return b&&['completed','stopped'].includes(b.status)&&b;});
  const tasks=(await(await api('/api/tasks')).json()).tasks.filter(t=>Array.from({length:batch.quantity},(_,i)=>batch.requestId+':'+i).includes(t.requestId));
  // The journal list is sorted newest-first; the protocol returns slot order.
  tasks.sort((a,b)=>a.requestId.localeCompare(b.requestId));
  return {...accepted,batch,tasks,task:tasks[0],...(batch.stopped?{stopped:batch.stopped}:{})};
}
module.exports={until,settleBatch};
