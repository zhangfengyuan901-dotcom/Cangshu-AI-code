// PIKNO owns retail quotes and settlement; the desktop never holds a wallet.
const crypto=require('node:crypto');
const {createPiknoClient,configured,quoteParameters,validateRemoteQuote}=require('./pikno-client.cjs');
const {createPiknoKeyStore}=require('./pikno-key-store.cjs');
const fail=(message,statusCode=400)=>Object.assign(Error(message),{statusCode});
const send=(res,status,value)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(value));};
const digest=value=>crypto.createHash('sha256').update(value).digest('hex');
async function read(req,limit=65536){let size=0;const chunks=[];for await(const chunk of req){size+=chunk.length;if(size>limit)throw fail('请求过大',413);chunks.push(chunk);}try{return JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}');}catch{throw fail('请求格式无效');}}
function createPiknoBridge({taskStore,client=createPiknoClient(),keyStore=createPiknoKeyStore()}={}) {
  // A stale page must not match a different account after the local service restarts.
  let configRevision=crypto.randomInt(1,2**48);
  const quotes=new Map(),activeBatches=new Set(),runningBatches=new Map();
  const stopBatches=(code,message)=>{for(const {journal,id,user} of runningBatches.values()){const batch=journal.batchGet(id,user);if(batch&&!batch.stopped)journal.batchUpdate(id,user,{status:'stopped',stopped:{code,message,submitted:batch.submitted,total:batch.quantity}});}};
  const legacyScopes=new Map();
  const scopeFor=cfg=>{if(!cfg.piknoUserId)return '';if(/^[a-f0-9]{64}$/.test(cfg.piknoExecutionScope||''))return cfg.piknoExecutionScope;if(!legacyScopes.has(cfg.piknoUserId))legacyScopes.set(cfg.piknoUserId,crypto.randomBytes(32).toString('hex'));return legacyScopes.get(cfg.piknoUserId);};
  const quoteError=(message,code='quote_invalid',statusCode=409)=>Object.assign(fail(message,statusCode),{code});
  const publicQuote=(remote,model,id)=>({id,model,name:remote.name,price_version:remote.line_revision,currency:remote.currency,unit:remote.unit,unit_price_cny:remote.unit_price_cny,units:remote.units,reference_surcharge_cny:remote.reference_surcharge_cny,per_item_cny:remote.per_item_cny,quantity:remote.quantity,total_cny:remote.total_cny,expires_at:remote.expires_at});
  const owner=()=>{const cfg=keyStore.read();return cfg.piknoUserId?'pikno:'+cfg.piknoUserId:'';};
  const status=()=>{
    const cfg=keyStore.read(),image=configured(cfg,'image'),video=configured(cfg,'video'),tool=configured(cfg,'tool');
    return {relayMode:true,walletMode:false,configured:image,videoConfigured:video,toolConfigured:tool,llmConfigured:image||video,revision:configRevision,inferenceMode:'cloud-auto',keyStorage:keyStore.persistent?'protected':'memory'};
  };
  // Read-only checks do not upload material, submit tasks or reserve credit.
  async function connection() {
    const cfg=keyStore.read(),revision=configRevision;
    const checks=await Promise.all(['image','video','tool'].map(async kind=>{
      if(!configured(cfg,kind))return {configured:false,state:'unconfigured',connected:false,modelCount:0,message:'尚未配置 Key',models:[]};
      try {
        const identity=await client.context(cfg,kind);
        if(identity.user_id!==cfg.piknoUserId)throw fail('Key 账户已变更',409);
        const field=kind==='image'?'piknoImageKey':kind==='tool'?'piknoToolKey':'piknoVideoKey';
        const catalog=await client.catalog({[field]:cfg[field]}),models=catalog.data;
        const available=models.filter(model=>kind==='tool'?model.provider==='tool':model.type===kind&&model.provider!=='tool').length;
        return {configured:true,state:available?'ready':'unavailable',connected:true,modelCount:available,message:available?'连接检测通过':'Key 有效，当前没有可调用的生成线路',models,...(kind==='tool'?{toolStates:catalog.toolStates}:{})};
      } catch(error) {
        const messages={401:'Key 无效、已过期或额度不足，请到 PIKNO 检查',403:'请使用对应类型的 PIKNO Key',409:'Key 账户不一致，请重新配置',429:'检测过于频繁，请稍后重试'};
        return {configured:true,state:error.statusCode===403?'forbidden':'error',connected:false,modelCount:0,message:messages[error.statusCode]||'连接检测未完成，请检查网络后重试',models:[]};
      }
    }));
    if(revision!==configRevision)throw fail('配置已变更，请重新检测',409);
    const models=checks.flatMap(check=>check.models);
    const clean=({models,toolStates,...value})=>value;
    const toolStates=checks[2].toolStates||Object.fromEntries(['digital','depth'].map(kind=>[kind,checks[2].state==='unconfigured'?'unconfigured':checks[2].state==='forbidden'?'forbidden':checks[2].state==='error'?'error':models.some(model=>model.id==='tool-'+kind)?'ready':'unavailable']));
    return {checkedAt:new Date().toISOString(),revision,image:clean(checks[0]),video:clean(checks[1]),tool:clean(checks[2]),toolStates,tools:{digital:models.some(model=>model.id==='tool-digital'),depth:models.some(model=>model.id==='tool-depth')}};
  }
  const publicBatch=b=>({id:b.id,requestId:b.requestId,status:b.status,quantity:b.quantity,submitted:b.submitted,remaining:Math.max(0,b.quantity-b.submitted),createdAt:b.createdAt,...(b.stopped?{stopped:b.stopped}:{})});
  const handles=p=>p==='/api/config'||p==='/api/relay/disconnect'||p==='/api/relay/connection'||p==='/api/relay/state'||p==='/api/relay/batches'||/^\/api\/relay\/batches\/[a-f0-9]{32}\/stop$/.test(p)||p.startsWith('/api/billing/')||p.startsWith('/rh/')||['/api/quotes','/api/models','/api/public-models','/api/canvas/models','/api/images','/api/videos','/api/official-videos','/api/tools/digital','/api/tools/depth'].includes(p);
  async function handle(req,res,url) {
    if(!/^127\.0\.0\.1:\d+$/.test(req.headers.host||'')||req.headers.origin&&req.headers.origin!==`http://${req.headers.host}`||req.headers['sec-fetch-site']==='cross-site')throw fail('请求来源无效',403);
    const p=url.pathname;
    if(p.startsWith('/api/billing/')||p.startsWith('/rh/'))throw fail('旧业务入口已停用，请到 PIKNO 管理充值与 Key',410);
    if(p==='/api/config'){
      if(req.method==='GET')return send(res,200,status());
      if(req.method!=='POST')throw fail('操作不支持',405);
      if(!String(req.headers['content-type']||'').startsWith('application/json'))throw fail('请求格式无效',415);
      const input=await read(req,4096),previous=keyStore.read(),cfg={},revision=++configRevision;quotes.clear();client.invalidate?.();stopBatches('configuration_changed','账户配置已变更，剩余份数未提交');
      for(const kind of ['image','video','tool']){
        const field=kind==='image'?'piknoImageKey':kind==='tool'?'piknoToolKey':'piknoVideoKey';
        if(input['remove_'+kind]===true){if(String(input[field]||'').trim())throw fail('同一 Key 不能同时移除和替换');continue;}
        const key=String(input[field]||'').trim()||String(previous[field]||'').trim();
        if(!key)continue;
        if(!/^sk-[a-zA-Z0-9]{20,128}$/.test(key))throw fail('请输入 PIKNO 创建的图片、视频或工具 Key');
        cfg[field]=key;
      }
      const kinds=['image','video','tool'].filter(kind=>configured(cfg,kind));
      if(!kinds.length){if(!['image','video','tool'].some(kind=>input['remove_'+kind]===true))throw fail('请至少填写一个 PIKNO Key');keyStore.clear();client.invalidate?.();return send(res,200,{ok:true,...status()});}
      const identities=await Promise.all(kinds.map(kind=>client.context(cfg,kind)));
      if(identities.some(identity=>identity.user_id!==identities[0].user_id))throw fail('图片、视频和工具 Key 必须属于同一个 PIKNO 账户',409);
      if(revision!==configRevision)throw fail('配置已变更，请重新保存',409);
      cfg.piknoUserId=identities[0].user_id;
      cfg.piknoExecutionScope=cfg.piknoUserId===previous.piknoUserId?scopeFor(previous):crypto.randomBytes(32).toString('hex');
      keyStore.write(cfg);
      client.invalidate?.();
      return send(res,200,{ok:true,...status()});
    }
    if(p==='/api/relay/disconnect'){
      if(req.method!=='POST')throw fail('操作不支持',405);
      configRevision++;quotes.clear();stopBatches('configuration_changed','账户配置已变更，剩余份数未提交');keyStore.clear();client.invalidate?.();return send(res,200,{ok:true,...status()});
    }
    if(p==='/api/relay/connection'){
      if(req.method!=='GET')throw fail('操作不支持',405);
      return send(res,200,await connection());
    }
    if(p==='/api/relay/state'){
      if(req.method!=='GET')throw fail('操作不支持',405);
      return send(res,200,status());
    }
    const cfg=keyStore.read(),revision=configRevision;
    const requestedRevision=req.headers['x-hamster-config-revision'];
    const assertRevision=()=>{
      if(revision!==configRevision || requestedRevision!==undefined&&String(revision)!==requestedRevision)throw fail('配置已变更，请检查当前 Key 后再提交',409);
    };
    assertRevision();
    if(!cfg.piknoUserId)throw fail('请先配置 PIKNO Key',401);
    if(p==='/api/relay/batches'){
      if(req.method!=='GET')throw fail('操作不支持',405);
      return send(res,200,{batches:taskStore().batchList('pikno:'+cfg.piknoUserId).map(publicBatch),revision});
    }
    const stopMatch=p.match(/^\/api\/relay\/batches\/([a-f0-9]{32})\/stop$/);
    if(stopMatch){
      if(req.method!=='POST')throw fail('操作不支持',405);
      const journal=taskStore(),user='pikno:'+cfg.piknoUserId,batch=journal.batchGet(stopMatch[1],user);
      if(!batch)throw fail('批次记录不存在',404);
      const stopped={code:'user_stopped',message:'已停止尚未发送的份数；已提交任务继续查询，未取消或退款',submitted:batch.submitted,total:batch.quantity};
      const updated=['completed','stopped'].includes(batch.status)?batch:journal.batchUpdate(batch.id,user,{status:'stopped',stopped});
      return send(res,200,{batch:publicBatch(updated),revision});
    }
    if(['/api/models','/api/public-models','/api/canvas/models'].includes(p)){
      if(req.method!=='GET')throw fail('操作不支持',405);
      const catalog=await client.catalog(cfg);assertRevision();
      return send(res,200,{data:catalog.data,revision});
    }
    if(p==='/api/official-videos')throw fail('请从主线路列表选择 PIKNO 已开放的视频线路',410);
    if(req.method!=='POST')throw fail('操作不支持',405);
    if(!String(req.headers['content-type']||'').startsWith('application/json'))throw fail('请求格式无效',415);
    if(p==='/api/quotes'){
      const input=await read(req),catalog=await client.catalog(cfg,{fresh:true});assertRevision();
      const line=catalog.resolve(input.model),model=catalog.data.find(m=>m.id===input.model);
      if(!line||!model)throw fail('请选择当前功能可用线路');
      const kind=model.provider==='tool'?'tool':model.type;
      if(!configured(cfg,kind))throw fail('请先配置对应功能的 PIKNO Key',401);
      if(!model.concurrency_options?.includes(Number(input.concurrency??1)))throw fail('任务份数无效');
      if(typeof client.quote!=='function')throw fail('当前服务暂不支持报价，请稍后重试',503);
      const parameters=quoteParameters(line,input),remote=validateRemoteQuote(await client.quote(cfg,line,input),parameters);assertRevision();
      for(const [id,q] of quotes)if(q.remote.expires_at*1000<=Date.now())quotes.delete(id);
      if(quotes.size>=256)quotes.delete(quotes.keys().next().value);
      const id=crypto.randomUUID(),value=publicQuote(remote,model.id,id);
      quotes.set(id,{remote,public:value,revision,user:cfg.piknoUserId,fingerprint:digest(JSON.stringify(parameters)),used:new Set()});
      return send(res,200,{quote:value,revision});
    }
    const requiredKind=p.startsWith('/api/tools/')?'tool':p==='/api/images'?'image':'video';
    if(!configured(cfg,requiredKind))throw fail(requiredKind==='tool'?'请先配置工具 Key':requiredKind==='image'?'请先配置图片 Key':'请先配置视频 Key',401);
    const payload=await read(req);
    const count=Number(payload.concurrency??1),key=String(req.headers['idempotency-key']||'');
    if(![1,2,4].includes(count)||p.startsWith('/api/tools/')&&count!==1)throw fail('任务份数无效');
    if(!/^[a-zA-Z0-9:_-]{8,140}$/.test(key))throw fail('提交编号无效');
    const journal=taskStore(),fingerprint=digest(JSON.stringify(payload)),out=[],user='pikno:'+cfg.piknoUserId;
    const existing=Array.from({length:count},(_,i)=>journal.list().find(item=>item.walletUser===user&&item.requestId===key+':'+i));
    const durableBatch=journal.batchFor(key,user);
    if(durableBatch){
      if(durableBatch.fingerprint!==fingerprint)throw fail('同一请求编号不能更换生成内容',409);
      const tasks=existing.filter(Boolean),batch=publicBatch(durableBatch);
      return send(res,202,{accepted:true,tasks,task:tasks[0],batch,...(batch.stopped?{stopped:batch.stopped}:{})});
    }
    for(const prior of existing)if(prior&&prior.walletFingerprint!==fingerprint)throw fail('同一请求编号不能更换生成内容',409);
    const batchKey=user+':'+key,blocked=existing.find(item=>item&&(['unknown','submitting'].includes(item.status)||item.relayBatchStopped));
    if(blocked||activeBatches.has(batchKey)){
      const tasks=existing.filter(Boolean),stopped=blocked?.relayBatchStopped||{code:'submission_pending',message:'原批次仍在处理或待确认，剩余份数未提交，请查询原任务',submitted:tasks.length,total:count};
      return send(res,202,{accepted:true,tasks,task:tasks[0],stopped});
    }
    // Durable original tasks remain queryable even if their quote expired/restarted.
    if(existing.every(Boolean))return send(res,202,{accepted:true,tasks:existing,task:existing[0]});
    const catalog=await client.catalog(cfg,{fresh:true}),line=catalog.resolve(payload.model);
    assertRevision();
    // Catalog I/O may have allowed another request to finish and clear its task
    // cards. Recheck the durable claim after that await, before using any quote.
    const claimedBatch=journal.batchFor(key,user);
    if(claimedBatch){
      if(claimedBatch.fingerprint!==fingerprint)throw fail('同一请求编号不能更换生成内容',409);
      const tasks=Array.from({length:claimedBatch.quantity},(_,i)=>journal.list().find(item=>item.walletUser===user&&item.requestId===key+':'+i)).filter(Boolean),batch=publicBatch(claimedBatch);
      return send(res,202,{accepted:true,tasks,task:tasks[0],batch,...(batch.stopped?{stopped:batch.stopped}:{})});
    }
    const tool=p.startsWith('/api/tools/')?p.split('/').pop():'';
    const model=catalog.data.find(value=>value.id===payload.model);
    if(!line||!model||line.kind!==(p==='/api/images'?'image':'video')||(model.provider==='tool')!==Boolean(tool)||tool&&model.id!=='tool-'+tool)throw fail('请选择当前功能可用线路');
    if(!model.concurrency_options.includes(count))throw fail('任务份数无效');
    const q=quotes.get(payload.quote_id);
    if(!q||q.user!==cfg.piknoUserId||q.revision!==revision||q.public.model!==payload.model)throw quoteError('请重新获取并确认本次报价','quote_invalid',428);
    if(q.remote.expires_at*1000<=Date.now())throw quoteError('报价已过期，请重新获取并确认','quote_expired');
    if(q.fingerprint!==digest(JSON.stringify(quoteParameters(line,payload,{actualMedia:true}))))throw quoteError('生成参数或素材数量已变化，请重新获取并确认','quote_parameters_changed');
    if(model.line_revision!==undefined&&model.line_revision!==q.remote.line_revision)throw quoteError('价格或线路已更新，请重新获取并确认','quote_changed');
    if(q.used.size)throw quoteError('此报价已提交，请查询原任务，勿重复提交','quote_already_submitted');
    if(activeBatches.has(batchKey))return send(res,202,{accepted:true,tasks:existing.filter(Boolean),task:existing.find(Boolean),stopped:{code:'submission_pending',message:'原批次正在提交，请查询原任务',submitted:existing.filter(Boolean).length,total:count}});
    // Persist a receipt before accepting locally or dispatching any paid slot.
    const batch=journal.batchBegin(key,user,fingerprint,count);
    let stopped,lastRequestId;activeBatches.add(batchKey);runningBatches.set(batchKey,{journal,id:batch.id,user});
    const run=async()=>{
    try{
    for(let i=0;i<count;i++){
      const currentBatch=journal.batchGet(batch.id,user);
      if(currentBatch.stopped){stopped={...currentBatch.stopped,submitted:out.length};break;}
      if(revision!==configRevision){stopped={code:'configuration_changed',message:'账户配置已变更，剩余份数未提交',submitted:out.length,total:count};break;}
      const requestId=key+':'+i,prior=journal.list().find(item=>item.walletUser===user&&item.requestId===requestId);
      if(prior){if(prior.walletFingerprint!==fingerprint)throw fail('同一请求编号不能更换生成内容',409);out.push(prior);continue;}
      if(q.remote.expires_at*1000<=Date.now()||q.used.has(i)){
        const code=q.used.has(i)?'quote_already_submitted':'quote_expired',message=q.used.has(i)?'此报价已提交，请查询原任务，勿重复提交':'报价已过期，剩余份数未提交';
        if(!out.length)throw quoteError(message,code);
        stopped={code,message,submitted:out.length,total:count};break;
      }
      q.used.add(i);
      const {id:ignoredQuoteId,...priceSnapshot}=q.public;
      const item=journal.begin(p,{...payload,concurrency:1},'',requestId,{walletUser:user,walletFingerprint:fingerprint,relay:true,modelName:q.public.name,priceSnapshot,...(tool?{source:tool}:{})});lastRequestId=requestId;
      journal.batchUpdate(batch.id,user,{status:'running',submitted:i+1});
      let acceptedResponse;
      try{
        const response=await client.submit(cfg,line,payload,{quote_id:q.remote.quote_id,index:i});
        if(line.kind==='image'){
          // A local completed ID is not an upstream task ID and is never polled.
          if(!Array.isArray(response.data)||response.data.length!==1||!/^https:\/\//.test(response.data[0]?.url||''))throw fail('图片结果未确认，请核对 PIKNO 任务记录，勿重复提交',502);
          item.relaySynchronous=true;
          acceptedResponse={id:'local_image_'+item.key,status:'succeeded',results:[{url:response.data[0].url,outputType:'png'}]};
          await journal.capture(item,acceptedResponse,200);
        }else{
          if(!/^[a-zA-Z0-9_-]{1,200}$/.test(response.id||'')||!['queued','in_progress','processing','preparing','completed','failed','unknown'].includes(response.status))throw fail('任务结果未确认，请核对 PIKNO 任务记录，勿重复提交',502);
          acceptedResponse=response;await journal.capture(item,response,202);
        }
      }catch(error){
        if(acceptedResponse){
          journal.preserveAccepted(item,acceptedResponse);
          stopped={code:'local_record_pending',message:'服务已受理，本地记录保存待确认；剩余份数未提交，请查询原任务',submitted:out.length+1,total:count};
        }else{
        // .23 has no by-request lookup guarantee. Preserve UNKNOWN locally;
        // neither invent an upstream ID nor retry a potentially paid submission.
        if(error.code==='insufficient_balance')journal.annotate(item,{relayFailureCode:'insufficient_balance'});
        if(error.originalTaskId){
          const original={id:error.originalTaskId,status:'queued'};
          try{await journal.capture(item,original,202);}catch{journal.preserveAccepted(item,original);}
        }
        else if(error.ambiguous||error.statusCode>=500||error.statusCode===408)journal.uncertain(item,'提交结果待确认，请核对 PIKNO 任务记录或联系管理员，勿重复提交');
        else await journal.capture(item,{error:error.statusCode?error.message:'生成请求未完成，请检查当前线路'},error.statusCode||400);
        stopped={code:error.code||'submission_stopped',message:error.ambiguous?'提交结果待确认，剩余份数未提交，请查询原任务':error.code==='insufficient_balance'?'PIKNO 账户余额不足，请前往 PIKNO 充值后重新确认报价':/^quote_(invalid|expired|changed|parameters_changed|already_submitted)$/.test(error.code||'')?error.message:'本次提交已停止，请检查线路或查询原任务',submitted:out.length+1,total:count};
        if(count===1&&error.code?.startsWith('quote_')&&!error.ambiguous&&!out.length)throw error;
        }
      }
      const captured=journal.list().find(value=>value.walletUser===user&&value.requestId===requestId);
      if(captured&&['unknown','submitting','failed'].includes(captured.status)&&!stopped)stopped={code:captured.status==='failed'?'submission_failed':'submission_unconfirmed',message:captured.status==='failed'?'本次生成未完成，剩余份数未提交':'原任务仍待确认，剩余份数未提交，请查询原任务',submitted:out.length+1,total:count};
      out.push(captured);
      if(stopped)break;
    }
    }finally{
      activeBatches.delete(batchKey);runningBatches.delete(batchKey);
      const latest=journal.batchGet(batch.id,user);stopped=latest.stopped||stopped;
      if(stopped&&lastRequestId)journal.annotateRequest(lastRequestId,user,{relayBatchStopped:stopped});
      journal.batchUpdate(batch.id,user,{status:stopped?'stopped':'completed',...(stopped?{stopped}:{})});
    }
    };
    if(count>1){
      // Start the first durable slot now, but never hold the page connection on
      // its upstream response. Stop is an explicit durable operation.
      void run().catch(()=>{
        try{const current=journal.batchGet(batch.id,user);if(!current.stopped)journal.batchUpdate(batch.id,user,{status:'stopped',stopped:{code:'local_processing_stopped',message:'本地处理中断，剩余份数未提交；请查询原任务',submitted:current.submitted,total:count}});}catch{}
      });
      const tasks=journal.list().filter(item=>item.walletUser===user&&Array.from({length:count},(_,i)=>key+':'+i).includes(item.requestId));
      return send(res,202,{accepted:true,tasks,task:tasks[0],batch:publicBatch(journal.batchGet(batch.id,user))});
    }
    await run();
    const visible=revision===configRevision?out.filter(Boolean):[];
    return send(res,202,{accepted:true,tasks:visible,task:visible[0],batch:publicBatch(journal.batchGet(batch.id,user)),...(stopped?{stopped}:{})});
  }
  return {handles,handle,status,owner,executionContext:()=>({owner:owner(),revision:configRevision,scope:scopeFor(keyStore.read())}),
    stop:()=>{configRevision++;quotes.clear();stopBatches('process_stopped','应用已关闭，剩余份数未提交；请核对原任务');client.invalidate?.();},
    upload:async(data,metadata)=>{const cfg=keyStore.read(),revision=configRevision;if(metadata?.revision!==undefined&&String(metadata.revision)!==String(revision))throw fail('配置已变更，请重新上传素材',409);const result=await client.upload(cfg,data,metadata);if(revision!==configRevision)throw fail('配置已变更，请重新上传素材',409);return result;},
    // The relay owns material expiry; the desktop cannot delete by object key.
    deleteObjects:async()=>({deleted:0,managed_by_service:true}),
    check:async()=>{const cfg=keyStore.read(),revision=configRevision;const identity=await client.context(cfg,configured(cfg,'image')?'image':configured(cfg,'video')?'video':'tool');if(identity.user_id!==cfg.piknoUserId)throw fail('Key 账户不一致，请重新配置',409);if(revision!==configRevision)throw fail('配置已变更，请重新检测',409);return {connected:true};},
    inferenceKey:expected=>{const cfg=keyStore.read();if(expected&&(expected.revision!==configRevision||expected.scope!==scopeFor(cfg)))throw fail('账户配置已变更，请重新发起对话',409);return cfg.piknoVideoKey||cfg.piknoImageKey||'';},
    query:async item=>{
      if(item.walletUser!==owner())throw fail('请配置原任务所属 PIKNO 账户的 Key',401);
      if(item.relaySynchronous)return {status:'succeeded',image_url:item.result?.image_url,download_url:item.result?.download_url};
      return client.query(keyStore.read(),item);
    }};
}
module.exports={createPiknoBridge};
