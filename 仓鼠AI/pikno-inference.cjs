// Paid inference always passes through PIKNO's request ledger. No cloud session
// can substitute for the customer's revocable, captured chat Key.
const {Readable}=require('node:stream');
const {pipeline}=require('node:stream/promises');
const {validateChatActivation,DOUBAO_CHAT_MODEL,DOUBAO_CHAT_PRICE}=require('./pikno-client.cjs');
const error=(message,statusCode=503,code)=>Object.assign(Error(message),{statusCode,...(code?{code}:{})});
const messages={401:'请在账户页配置有效的 PIKNO 对话 Key',402:'对话可用额度不足，请到 PIKNO 检查余额及 Key 额度',403:'此 Key 没有对话权限，请使用 PIKNO 对话 Key',409:'本次请求或价格状态已变化，请核对账单后重试',429:'对话请求过于频繁，请稍后重试'};
async function boundedJson(response,limit=65536){
 const chunks=[];let size=0;
 if(!response.body)throw error('对话服务状态暂时无法确认',502);
 for await(const chunk of response.body){size+=chunk.byteLength;if(size>limit)throw error('对话服务状态暂时无法确认',502);chunks.push(Buffer.from(chunk));}
 try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw error('对话服务状态暂时无法确认',502);}
}
async function checkResponse(response){
 if(response.ok)return;
 let value;try{value=await boundedJson(response);}catch{}
 const code=value?.code||value?.error?.code;
 const safeCode=['assistant_disabled','llm_price_changed','llm_unknown','llm_request_conflict','llm_capability_unavailable','llm_not_submitted'].includes(code)?code:undefined;
 const proof=value?.error;
 const rejectedBeforeExecution=proof?.code==='llm_rejected_before_execution'&&proof?.submission_state==='rejected_before_execution'
  &&(value.code===undefined||value.code===proof.code)&&(value.submission_state===undefined||value.submission_state===proof.submission_state);
 const hasRejectionCode=[value?.code,proof?.code].includes('llm_rejected_before_execution');
 const states=[value?.submission_state,proof?.submission_state].filter(state=>state!==undefined);
 const rejected=!hasRejectionCode&&states.length>0&&states.every(state=>state==='not_submitted');
 const failure=error(rejectedBeforeExecution?'本次请求未执行，未扣费；请重新确认价格后手动再试':rejected&&code==='llm_request_pending'?'账户有一笔对话尚待核对，本次未提交；请先核对原请求':code==='assistant_disabled'?'仓鼠智能服务尚未开放':messages[response.status]||'对话服务请求未完成，请核对请求状态',response.status,rejectedBeforeExecution?'llm_rejected_before_execution':rejected?'llm_not_submitted':safeCode);
 if(rejectedBeforeExecution)failure.submissionState='rejected_before_execution';else if(rejected)failure.submissionState='not_submitted';throw failure;
}
function publicBill(value,id){
 if(!value||value.request_id!==id||!['reserved','dispatching','dispatched','submitted','settled','released','unknown'].includes(value.status)||value.currency!=='CNY'||!/^chat-[a-z0-9-]{1,80}$/.test(value.price_version||''))throw error('对话账单状态暂时无法确认',502);
 const output={request_id:id,status:value.status,currency:'CNY',price_version:value.price_version};
 if(value.billing_mode==='actual_usage_v1')output.billing_mode=value.billing_mode;
 for(const key of ['reserved_quota','charged_quota','refunded_quota'])if(Number.isSafeInteger(value[key])&&value[key]>=0)output[key]=value[key];
 // Only the authenticated server may release an unknown operation's admission
 // slot. Missing/legacy/malformed receipts remain blocking; never infer this
 // from elapsed time, a 404 or a locally cached balance.
 if(value.status==='unknown'&&value.billing_mode==='actual_usage_v1'&&['chat-cny-9-45-actual-v2',DOUBAO_CHAT_PRICE].includes(value.price_version)
  &&['reserved_quota','charged_quota','refunded_quota'].every(name=>value[name]===0)&&typeof value.admission_blocking==='boolean')output.admission_blocking=value.admission_blocking;
 if(value.usage&&['input_tokens','output_tokens','cached_tokens'].every(key=>Number.isSafeInteger(value.usage[key])&&value.usage[key]>=0))output.usage=Object.fromEntries(['input_tokens','output_tokens','cached_tokens'].map(key=>[key,value.usage[key]]));
 return output;
}
function createPiknoInferenceGateway({endpoint,fetchImpl=fetch}){
 const key=value=>{const result=String(value||'').trim();if(!result)throw error(messages[401],401);return result;};
 async function activate(apiKey,{signal}={}){
  let response;
  try{response=await fetchImpl(new URL('/assistant/v2/activate',endpoint),{method:'POST',redirect:'error',headers:{Authorization:'Bearer '+key(apiKey),'X-Hamster-Client':'hamster-desktop-v1'},signal:signal?AbortSignal.any([signal,AbortSignal.timeout(20000)]):AbortSignal.timeout(20000)});}catch(exc){if(exc.statusCode)throw exc;throw error('仓鼠智能服务暂时无法连接，请稍后重试');}
  await checkResponse(response);return validateChatActivation(await boundedJson(response));
 }
 async function status(apiKey,options){
  const result=await activate(apiKey,options);
  const model=result.models?.find(entry=>entry.model===DOUBAO_CHAT_MODEL);
  if(!model)throw error('当前对话 Key 暂不能使用豆包 Seed 2.1 Pro',503,'assistant_disabled');
  if(!result.balance_sufficient)throw error(messages[402],402);
  return {...result,...model,enabled:true,configured:true,mode:'pikno-metered'};
 }
 async function handle(req,res,url,apiKey,{assertCurrent=()=>{},uploadChatMedia}={}){
  assertCurrent();const controller=new AbortController();let changed,dispatched=false;
  const check=()=>{try{assertCurrent();}catch(exc){changed=exc;controller.abort(exc);}};
  const timer=setInterval(check,50),abort=()=>controller.abort();req.once?.('aborted',abort);
  const send=value=>{assertCurrent();res.writeHead(200,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(value));};
  try{
   if(url.pathname==='/api/inference/status'){
    if(req.method!=='GET')throw error('操作不支持',405);
    const activation=await status(apiKey,{signal:controller.signal});
    const model=activation.models?.[0];
    if(model.capabilities.files&&!uploadChatMedia){
     model.capabilities={...model.capabilities,files:false,image:false,video:false};
     model.limits={max_output_tokens:model.limits.max_output_tokens};
     activation.capabilities=model.capabilities;
     activation.limits=model.limits;
    }
    return send(activation);
   }
   if(url.pathname==='/api/inference/api/v3/tos-assets'){
    if(req.method!=='POST'||url.search||!uploadChatMedia)throw error('当前对话线路尚未开放素材',403,'llm_capability_unavailable');
    const model=(await status(apiKey,{signal:controller.signal})).models?.[0];
    assertCurrent();
    if(!model?.capabilities.files)throw error('当前对话线路尚未开放素材',403,'llm_capability_unavailable');
    const contentType=req.headers['content-type'],contentLength=Number(req.headers['content-length']);
    const image=/^image\/(png|jpeg|webp)$/.test(contentType);
    const video=/^video\/(mp4|quicktime)$/.test(contentType);
    if(!(image&&model.capabilities.image||video&&model.capabilities.video))throw error('当前对话线路不支持此素材格式',415);
    const maximum=image?10000000:50000000;
    if(!Number.isSafeInteger(contentLength)||contentLength<12||contentLength>Math.min(maximum,model.limits.max_file_bytes))throw error('素材大小不符合要求',413);
    const receipt=await uploadChatMedia(req,{contentType,contentLength,signal:controller.signal});
    return send({url:receipt.url,expires_at:receipt.expires_at});
   }
   const bill=/^\/api\/inference\/requests\/([a-f0-9]{32})$/.exec(url.pathname);
   if(bill){
    if(req.method!=='GET')throw error('操作不支持',405);
    const response=await fetchImpl(new URL('/assistant/v2/requests/'+bill[1],endpoint),{method:'GET',redirect:'error',headers:{Authorization:'Bearer '+key(apiKey)},signal:AbortSignal.any([controller.signal,AbortSignal.timeout(20000)])});
    await checkResponse(response);return send(publicBill(await boundedJson(response),bill[1]));
   }
   const file=/^\/api\/inference\/api\/v3\/files(?:\/(hf1_[A-Za-z0-9_-]{32,1796}))?$/.exec(url.pathname);
   if(file){
    if(url.search||(!file[1]&&req.method!=='POST')||(file[1]&&!['GET','DELETE'].includes(req.method)))throw error('素材操作不支持',404);
    if(req.method==='POST')throw error('豆包对话不支持此文件上传方式',403,'llm_capability_unavailable');
    const limit=req.method==='DELETE'?2:0;
    const type=String(req.headers['content-type']||'');
    const chunks=[];let size=0;
    for await(const chunk of req){assertCurrent();size+=Buffer.byteLength(chunk);if(size>limit)throw error('素材请求过大',413);chunks.push(Buffer.from(chunk));}
    // The bundled SDK sends {} for DELETE. It grants no options; normalize
    // only that exact empty JSON object to the signed empty-body protocol.
    if(req.method==='DELETE'&&size&&(type!=='application/json'||Buffer.concat(chunks).toString('utf8')!=='{}'))throw error('素材请求格式无效',400);
    assertCurrent();
    let response;
    try{response=await fetchImpl(new URL('/assistant/v2/files'+(file[1]?'/'+file[1]:''),endpoint),{
      method:req.method,redirect:'error',headers:{Authorization:'Bearer '+key(apiKey)},
      signal:AbortSignal.any([controller.signal,AbortSignal.timeout(180000)])});}
    catch{throw changed||error('素材处理未完成，请重新检查；本次未发送模型请求',503,'llm_file_unavailable');}
    assertCurrent();await checkResponse(response);const value=await boundedJson(response);assertCurrent();return send(value);
   }
   if(req.method!=='POST'||url.pathname!=='/api/inference/api/v3/responses')throw error('当前对话线路尚未开放此能力',404,'llm_capability_unavailable');
   const id=String(req.headers['x-pikno-request-id']||''),version=String(req.headers['x-pikno-price-version']||'');
   if(!/^[a-f0-9]{32}$/.test(id)||!/^chat-[a-z0-9-]{1,80}$/.test(version))throw error('缺少有效的请求编号或已确认价格',400);
   const chunks=[];let size=0;for await(const chunk of req){assertCurrent();size+=Buffer.byteLength(chunk);if(size>2*1024*1024)throw error('对话内容过大',413);chunks.push(Buffer.from(chunk));}
   let body;try{body=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw error('对话请求格式无效',400);}
   if(!body||typeof body!=='object'||Array.isArray(body))throw error('对话请求格式无效',400);
   // The locked SDK serializes absent options as null. Absence cannot enable a
   // capability; reject all non-null fields outside this paid text contract.
   for(const [name,value] of Object.entries(body)){
    if(value===null&&!['model','input','max_output_tokens'].includes(name)){delete body[name];continue;}
    if(!['model','input','instructions','max_output_tokens','stream'].includes(name))throw error('当前对话线路尚未开放此参数',400,'llm_capability_unavailable');
   }
   if(body.model!==DOUBAO_CHAT_MODEL&&body.model!=='hamster-auto')throw error('当前对话模型已更新，请刷新后重试',409,'llm_capability_unavailable');
   const capability=await status(apiKey,{signal:controller.signal});assertCurrent();
   if(capability.price_version!==version)throw error('对话价格已变化，请重新确认',409,'llm_price_changed');
   if(!Number.isSafeInteger(body.max_output_tokens)||body.max_output_tokens<1||body.max_output_tokens>capability.limits.max_output_tokens)throw error('本次回答长度超过已开放上限',400);
   const headers=new Headers({'Authorization':'Bearer '+key(apiKey),'Content-Type':'application/json','Accept':body.stream?'text/event-stream':'application/json','X-PIKNO-Request-Id':id,'X-PIKNO-Price-Version':version});
   let response;
   try{dispatched=true;response=await fetchImpl(new URL('/assistant/v2/responses',endpoint),{method:'POST',redirect:'error',headers,body:JSON.stringify({...body,model:capability.model}),signal:AbortSignal.any([controller.signal,AbortSignal.timeout(660000)])});}
   catch{throw changed||error('本次回答状态待核对，不会自动重复提交；请保留原请求编号',503,'llm_unknown');}
   assertCurrent();await checkResponse(response);assertCurrent();
   res.writeHead(response.status,{'Content-Type':response.headers.get('content-type')||'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
   if(!response.body){res.end();return;}await pipeline(Readable.fromWeb(response.body),res,{signal:controller.signal});
  }catch(exc){if(!dispatched)exc.submissionState='not_submitted';throw changed||exc;}finally{clearInterval(timer);req.removeListener?.('aborted',abort);}
 }
 return {activate,status,handle};
}
module.exports={createPiknoInferenceGateway};
