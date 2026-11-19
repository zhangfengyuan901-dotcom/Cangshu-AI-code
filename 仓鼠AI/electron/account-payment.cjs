const fs=require('node:fs');
const path=require('node:path');
const {randomUUID}=require('node:crypto');

const ORIGIN='https://www.piknoai.com';
const AMOUNTS=[50,100,200],METHODS=['alipay','wxpay'];
const fail=code=>Object.assign(Error(code),{code});
const positive=value=>Number.isSafeInteger(value)&&value>0;
const orderFor=(order,userId)=>typeof order==='string'&&new RegExp(`^USR${userId}NO[A-Za-z0-9]{1,128}$`).test(order);
const safeCodes=new Set(['INVALID_REQUEST','LOGIN_REQUIRED','ACCOUNT_CHANGED','ACCOUNT_MISMATCH','NETWORK','RATE_LIMITED','STORAGE_UNAVAILABLE','PENDING_OPERATION','QUOTE_EXPIRED','PAYMENT_UNAVAILABLE','PAYMENT_UNKNOWN','WINDOW_OPEN','FORBIDDEN']);

function createAccountPayment({request,journalFile,getIdentity,getConnectedAccountId=()=>null,openPayment,now=Date.now}){
  const file=journalFile+'.payment';
  let entries=[],blocked=false,quote=null,handoff=null,epoch=0,disposed=false,queue=Promise.resolve();
  try{
    const info=fs.lstatSync(file);
    if(!info.isFile()||info.isSymbolicLink()||info.size>1024*1024)throw Error();
    const value=JSON.parse(fs.readFileSync(file,'utf8'));
    if(value?.format!==1||!Array.isArray(value.entries)||value.entries.length>4096)throw Error();
    const pending=new Set(),identities=new Set();
    for(const row of value.entries){
      if(!row||Object.keys(row).sort().join(',')!=='action,amount,at,method,order,userId'||!positive(row.userId)||!positive(row.at)||!AMOUNTS.includes(row.amount)||!METHODS.includes(row.method)||!['pending','resolved','success','expired','failed'].includes(row.action)||row.order!==''&&!orderFor(row.order,row.userId))throw Error();
      if(identities.has(row.userId+':'+row.at)||row.action==='pending'&&pending.has(row.userId))throw Error();
      identities.add(row.userId+':'+row.at);if(row.action==='pending')pending.add(row.userId);
    }
    entries=value.entries;
  }catch(error){if(error.code!=='ENOENT')blocked=true;}
  const pendingFor=userId=>entries.find(row=>row.userId===userId&&row.action==='pending');
  const clearHandoff=()=>{if(handoff)for(const name of Object.keys(handoff.fields))handoff.fields[name]='';handoff=null;};
  function invalidate(){epoch++;quote=null;clearHandoff();}
  function current(ticket,identity){
    const actual=getIdentity();
    return !disposed&&ticket===epoch&&actual?.userId===identity.userId&&actual?.sid===identity.sid;
  }
  function check(ticket,identity){
    if(!current(ticket,identity))throw fail('ACCOUNT_CHANGED');
    const connected=getConnectedAccountId();
    if(connected!==null&&connected!==undefined&&connected!==0&&connected!==identity.userId)throw fail('ACCOUNT_MISMATCH');
  }
  async function identify(accountId){
    if(!positive(accountId))throw fail('INVALID_REQUEST');
    const ticket=epoch,user=(await request('/api/user/self')).data,identity=getIdentity();
    if(!positive(user?.id)||!positive(identity?.userId)||typeof identity.sid!=='string'||!identity.sid)throw fail('LOGIN_REQUIRED');
    if(user.id!==accountId||identity.userId!==accountId)throw fail('ACCOUNT_CHANGED');
    check(ticket,identity);return {ticket,identity:{userId:identity.userId,sid:identity.sid}};
  }
  async function save(next){
    if(blocked||next.length>4096)throw fail('STORAGE_UNAVAILABLE');
    const temporary=file+'.'+randomUUID()+'.tmp';let handle;
    try{
      await fs.promises.mkdir(path.dirname(file),{recursive:true,mode:0o700});
      handle=await fs.promises.open(temporary,'wx',0o600);
      await handle.writeFile(JSON.stringify({format:1,entries:next}));await handle.sync();await handle.close();handle=null;
      await fs.promises.rename(temporary,file);entries=next;
    }catch{throw fail('STORAGE_UNAVAILABLE');}
    finally{await handle?.close().catch(()=>{});await fs.promises.unlink(temporary).catch(()=>{});}
  }
  async function update(record,values){
    await save(entries.map(row=>row.userId===record.userId&&row.at===record.at?{...row,...values}:row));
  }
  function pendingMetadata(userId){
    const row=pendingFor(userId);
    return row?{amount:row.amount,method:row.method,createdAt:row.at,orderKnown:Boolean(row.order),canContinue:handoff?.userId===userId&&handoff.sid===getIdentity()?.sid&&handoff.at===row.at}:null;
  }
  async function options(ticket,identity){
    const data=(await request('/api/user/topup/info')).data;check(ticket,identity);
    const available=data?.fixed_cny_topup===true&&data?.enable_online_topup===true&&data?.payment_compliance_confirmed===true;
    const amounts=available&&Array.isArray(data.amount_options)?AMOUNTS.filter(amount=>data.amount_options.includes(amount)):[];
    const methods=available&&Array.isArray(data.pay_methods)?METHODS.filter(method=>data.pay_methods.some(row=>row?.type===method)):[];
    return {available:available&&amounts.length>0&&methods.length>0,amounts,methods};
  }
  function paymentForm(response,{userId,amount,method}){
    let target,notify,returned;
    try{target=new URL(response?.url||'',ORIGIN);notify=new URL(response?.data?.notify_url||'',ORIGIN);returned=new URL(response?.data?.return_url||'',ORIGIN);}catch{throw fail('PAYMENT_UNKNOWN');}
    if(target.href!==ORIGIN+'/pay/lanjing/epay/submit.php')throw fail('PAYMENT_UNKNOWN');
    const fields=response.data,required=['pid','type','out_trade_no','notify_url','return_url','name','money','sign','sign_type'];
    if(!fields||typeof fields!=='object'||Array.isArray(fields)||required.some(name=>typeof fields[name]!=='string'||!fields[name])||Object.entries(fields).some(([name,value])=>![...required,'device'].includes(name)||typeof value!=='string'||value.length>2048||/[\u0000-\u001f\u007f]/.test(value)))throw fail('PAYMENT_UNKNOWN');
    if(fields.type!==method||fields.money!==amount.toFixed(2)||!orderFor(fields.out_trade_no,userId)||fields.sign_type.toUpperCase()!=='MD5'||!/^[a-f\d]{32}$/i.test(fields.sign)||!/^\d{1,20}$/.test(fields.pid)||notify.href!==ORIGIN+'/api/user/epay/notify'||returned.origin!==ORIGIN||returned.username||returned.password)throw fail('PAYMENT_UNKNOWN');
    return {action:target.href,fields:{...fields}};
  }
  async function run(action,value){
    if(disposed)throw fail('FORBIDDEN');
    const contracts={'payment-options':['accountId'],'payment-quote':['accountId','amount','method'],'payment-create':['accountId','quoteId','confirmed'],'payment-open':['accountId'],'payment-orders':['accountId','page'],'payment-resolve':['accountId','confirmed']};
    if(!value||typeof value!=='object'||Array.isArray(value)||!Object.hasOwn(contracts,action)||Object.keys(value).some(name=>!contracts[action].includes(name)))throw fail('INVALID_REQUEST');
    if(blocked)throw fail('STORAGE_UNAVAILABLE');
    if(action==='payment-orders'&&value.page!==undefined&&(!positive(value.page)||value.page>10000))throw fail('INVALID_REQUEST');
    if(['payment-create','payment-resolve'].includes(action)&&value.confirmed!==true)throw fail('INVALID_REQUEST');
    if(action==='payment-quote'&&(!AMOUNTS.includes(value.amount)||!METHODS.includes(value.method)))throw fail('INVALID_REQUEST');
    const {ticket,identity}=await identify(value.accountId),userId=identity.userId;
    if(action==='payment-options')return {ok:true,...await options(ticket,identity),pending:pendingMetadata(userId)};
    if(action==='payment-quote'){
      if(pendingFor(userId))throw fail('PENDING_OPERATION');
      const offered=await options(ticket,identity);
      if(!offered.available||!offered.amounts.includes(value.amount)||!offered.methods.includes(value.method))throw fail('PAYMENT_UNAVAILABLE');
      const response=await request('/api/user/amount',{method:'POST',body:{amount:value.amount}});check(ticket,identity);
      if(Number(response.data)!==value.amount)throw fail('PAYMENT_UNAVAILABLE');
      quote={id:randomUUID(),...identity,amount:value.amount,method:value.method,expiresAt:now()+120000};
      return {ok:true,quoteId:quote.id,amount:quote.amount,method:quote.method,expiresAt:quote.expiresAt};
    }
    if(action==='payment-create'){
      if(pendingFor(userId))throw fail('PENDING_OPERATION');
      if(!quote||quote.id!==value.quoteId||quote.userId!==userId||quote.sid!==identity.sid||quote.expiresAt<=now())throw fail('QUOTE_EXPIRED');
      const selected=quote;quote=null;
      const offered=await options(ticket,identity);
      if(!offered.available||!offered.amounts.includes(selected.amount)||!offered.methods.includes(selected.method))throw fail('PAYMENT_UNAVAILABLE');
      const response=await request('/api/user/amount',{method:'POST',body:{amount:selected.amount}});check(ticket,identity);
      if(Number(response.data)!==selected.amount)throw fail('PAYMENT_UNAVAILABLE');
      const record={userId,action:'pending',at:Math.max(now(),...entries.map(row=>row.at+1)),order:'',amount:selected.amount,method:selected.method};
      if(!positive(record.at))throw fail('STORAGE_UNAVAILABLE');
      await save([...entries,record]);check(ticket,identity);
      let result;
      try{result=await request('/api/user/pay',{method:'POST',body:{amount:record.amount,payment_method:record.method}});}
      catch(error){if(['ACCOUNT_CHANGED','LOGIN_REQUIRED','STORAGE_UNAVAILABLE'].includes(error?.code))throw error;throw fail('PAYMENT_UNKNOWN');}
      const payment=paymentForm(result,record);
      await update(record,{order:payment.fields.out_trade_no});check(ticket,identity);
      clearHandoff();handoff={...payment,...identity,at:record.at};
      return {ok:true,pending:true,canContinue:true,amount:record.amount,method:record.method};
    }
    if(action==='payment-open'){
      const record=pendingFor(userId);
      if(!record||!handoff||handoff.userId!==userId||handoff.sid!==identity.sid||handoff.at!==record.at||handoff.fields.out_trade_no!==record.order)throw fail('PENDING_OPERATION');
      const response=await request(`/api/user/topup/self?p=1&page_size=20&keyword=${encodeURIComponent(record.order)}`);check(ticket,identity);
      const rows=Array.isArray(response.data?.items)?response.data.items.filter(row=>row?.trade_no===record.order):[];
      if(rows.length!==1||rows[0].user_id!==undefined&&rows[0].user_id!==userId||rows[0].money!==record.amount||rows[0].payment_method!==record.method)throw fail('PAYMENT_UNKNOWN');
      if(rows[0].status!=='pending'){
        if(['success','expired','failed'].includes(rows[0].status))await update(record,{action:rows[0].status});
        check(ticket,identity);clearHandoff();throw fail('PENDING_OPERATION');
      }
      const payment=handoff;handoff=null;
      try{
        const result=await openPayment({action:payment.action,fields:payment.fields});
        if(result?.ok===false)throw fail('NETWORK');
        return {ok:true,pending:true,paymentOpened:true};
      }finally{for(const name of Object.keys(payment.fields))payment.fields[name]='';}
    }
    if(action==='payment-resolve'){
      const record=pendingFor(userId);
      if(record)await update(record,{action:'resolved'});
      check(ticket,identity);quote=null;clearHandoff();return {ok:true,resolved:true};
    }
    const page=value.page||1,response=await request(`/api/user/topup/self?p=${page}&page_size=20`);check(ticket,identity);
    const rows=Array.isArray(response.data?.items)?response.data.items:[];
    if(rows.some(row=>row?.user_id!==undefined&&row.user_id!==userId))throw fail('ACCOUNT_CHANGED');
    const record=pendingFor(userId);
    let original=record?.order?rows.find(row=>row.trade_no===record.order):null;
    if(record?.order&&!original){
      const found=await request(`/api/user/topup/self?p=1&page_size=20&keyword=${encodeURIComponent(record.order)}`);check(ticket,identity);
      const matches=Array.isArray(found.data?.items)?found.data.items.filter(row=>row.trade_no===record.order):[];
      if(matches.some(row=>row.user_id!==undefined&&row.user_id!==userId)||matches.length>1)throw fail('ACCOUNT_CHANGED');
      original=matches[0];
    }
    if(record&&original&&['success','expired','failed'].includes(original.status)){
      await update(record,{action:original.status});check(ticket,identity);clearHandoff();
    }
    return {ok:true,page,total:Math.max(0,Number.isSafeInteger(response.data?.total)?response.data.total:0),
      items:rows.slice(0,20).map(row=>({amount:typeof row.money==='number'&&Number.isFinite(row.money)&&row.money>=0?row.money:null,method:METHODS.includes(row.payment_method)?row.payment_method:'other',status:['pending','success','expired','failed'].includes(row.status)?row.status:'unknown',createdAt:positive(row.create_time)?row.create_time:0,completedAt:positive(row.complete_time)?row.complete_time:0})),
      pending:pendingMetadata(userId),canContinue:pendingMetadata(userId)?.canContinue===true};
  }
  return {
    command(action,value={}){
      const task=queue.then(()=>run(action,value)).catch(error=>({ok:false,code:safeCodes.has(error?.code)?error.code:'NETWORK',...(error?.code==='RATE_LIMITED'?{retryAfterMs:Math.min(3600000,Math.max(1,Number(error.retryAfterMs)||60000))}:{})}));
      queue=task.then(()=>{});return task;
    },
    invalidate,
    dispose(){disposed=true;invalidate();},
  };
}
module.exports={createAccountPayment};
