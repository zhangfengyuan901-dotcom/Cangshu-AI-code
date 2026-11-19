// Hypit uses the existing local quote, submission and durable task journal.
// This receipt binds a Source operation across Builds; it is not another wallet.
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const idPattern=/^hypit-[a-f0-9]{64}$/;
const tokenPattern=/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,119}$/;
const assetPattern=/^[a-f0-9]{32}$/;
const digest=value=>crypto.createHash('sha256').update(value).digest('hex');
const errors={
  invalid:'Hypit 视频请求无效',account_changed:'账户配置已变更，请重新检查后确认费用',
  not_found:'视频操作不存在',confirmation_required:'请先在仓鼠界面确认本次费用',
  quote_invalid:'报价已失效，请重新获取并确认费用',parameters_changed:'生成参数或素材已变化，请重新获取并确认',
  operation_locked:'此操作已有提交记录；请查询原任务，不要重复提交',
  service_unavailable:'视频服务暂不可用，请稍后重新检查',
  submission_unknown:'提交结果待确认；只会查询原任务，请勿重复提交',
  generation_failed:'视频生成未完成，请到 PIKNO 任务记录核对结果',
  result_pending:'结果尚未保存，请稍后查询原任务',
  interrupted:'上次素材准备已中断，请重新获取并确认费用',
  receipt_invalid:'视频操作记录读取失败，已停止提交；请保留记录并联系支持',
};
const fail=(code,status=400)=>Object.assign(new Error(errors[code]||errors.invalid),{code,status,statusCode:status});

function createHypitVideoBridge({dir,getAssets,taskStore,baseUrl,getExecutionContext,fetchImpl=fetch}){
  fs.mkdirSync(dir,{recursive:true});
  const records=new Map(),broken=new Set(),locks=new Set();
  const context=()=>({...getExecutionContext()});
  const assertContext=expected=>{
    const current=context();
    if(!current.owner)throw fail('account_changed',401);
    if(expected&&(current.owner!==expected.owner||current.revision!==expected.revision))throw fail('account_changed',409);
    return current;
  };
  const file=id=>{if(!idPattern.test(id))throw fail('not_found',404);return path.join(dir,id+'.json');};
  const save=record=>{
    const target=file(record.requestId),temp=target+'.tmp';
    record.updatedAt=new Date().toISOString();
    const fd=fs.openSync(temp,'w',0o600);
    try{fs.writeFileSync(fd,JSON.stringify(record));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
    fs.renameSync(temp,target);records.set(record.requestId,record);return record;
  };
  for(const name of fs.readdirSync(dir).filter(name=>/^hypit-[a-f0-9]{64}\.json$/.test(name))){
    const id=name.slice(0,-5);
    try{
      const record=JSON.parse(fs.readFileSync(path.join(dir,name),'utf8'));
      if(record.requestId!==id||typeof record.owner!=='string'||!tokenPattern.test(record.projectId)||!tokenPattern.test(record.operationId))throw fail('receipt_invalid');
      if(record.status==='submitting'){record.status='unknown';record.errorCode='submission_unknown';}
      if(['preparing','confirmed'].includes(record.status)){record.status='awaiting_confirmation';record.confirmed=false;record.errorCode='interrupted';}
      records.set(id,record);
    }catch{broken.add(id);}
  }
  const snapshotQuote=q=>Object.fromEntries(['id','model','name','price_version','currency','unit','unit_price_cny','units','reference_surcharge_cny','per_item_cny','quantity','total_cny','expires_at'].filter(key=>q?.[key]!==undefined).map(key=>[key,q[key]]));
  const visible=record=>({requestId:record.requestId,projectId:record.projectId,operationId:record.operationId,
    status:record.status,model:record.input.model,name:record.quote?.name||'视频线路',prompt:record.input.prompt,
    options:{...record.input.options},assetIds:[...record.input.assetIds],
    createdAt:record.createdAt,updatedAt:record.updatedAt,
    ...(record.quote?{quote:snapshotQuote(record.quote)}:{}),
    ...(record.taskKey?{taskKey:record.taskKey}:{}),
    ...(record.status==='succeeded'&&record.localFile?{result:{url:`/api/hypit/video/operations/${record.requestId}/file`,mediaType:'video/mp4'}}:{}),
    ...(record.errorCode?{code:record.errorCode,message:errors[record.errorCode]||errors.service_unavailable}:{})});
  function get(requestId,projectId){
    const expected=assertContext();
    if(broken.has(requestId))throw fail('receipt_invalid',409);
    const record=records.get(requestId);
    if(!record||record.owner!==expected.owner||projectId&&record.projectId!==projectId)throw fail('not_found',404);
    return record;
  }
  function reconcile(record){
    if(['awaiting_confirmation','confirmed','preparing'].includes(record.status))return record;
    const task=taskStore().list().find(t=>t.walletUser===record.owner&&t.requestId===record.requestId+':0');
    if(task){
      const next=['queued','processing','succeeded','failed','unknown','submitting'].includes(task.status)?task.status:'unknown';
      const changes={status:next,taskKey:task.key,localFile:Boolean(task.result?.local_url)};
      if(next==='unknown'||next==='submitting')changes.errorCode='submission_unknown';
      else if(next==='failed')changes.errorCode='generation_failed';
      else if(next==='succeeded'&&!changes.localFile)changes.errorCode='result_pending';
      else changes.errorCode='';
      if(Object.entries(changes).some(([key,value])=>record[key]!==value))save(Object.assign(record,changes));
    }
    return record;
  }
  async function local(route,body,expected,requestId){
    assertContext(expected);
    const base=new URL(baseUrl());
    if(base.protocol!=='http:'||base.hostname!=='127.0.0.1'||!base.port||base.username||base.password)throw fail('service_unavailable',503);
    let response,data;
    try{
      response=await fetchImpl(new URL(route,base),{method:body===undefined?'GET':'POST',headers:{
        'Content-Type':'application/json','X-Hamster-Config-Revision':String(expected.revision),
        ...(requestId?{'Idempotency-Key':requestId,Prefer:'respond-async'}:{}),
      },...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(requestId?125000:30000)});
      data=await response.json();
    }catch{throw fail(requestId?'submission_unknown':'service_unavailable',503);}
    assertContext(expected);
    if(!response.ok){
      const code=/^quote_(invalid|expired|changed|parameters_changed|already_submitted)$/.test(data?.code||'')?'quote_invalid':response.status===401||response.status===403?'account_changed':requestId&&response.status>=500?'submission_unknown':'service_unavailable';
      throw fail(code,response.status);
    }
    return data;
  }
  async function catalog(){
    const expected=assertContext(),data=await local('/api/canvas/models',undefined,expected);
    if(data.revision!==expected.revision||!Array.isArray(data.data))throw fail('account_changed',409);
    // Catalog is already client-redacted by the existing PIKNO adapter.
    return {revision:expected.revision,models:data.data.filter(m=>m.type==='video'&&m.provider==='generate').map(m=>Object.fromEntries(
      ['id','name','ratios','resolutions','durations','max_images','max_videos','max_audios','max_media_total','max_media_files','prices','currency','line_revision'].filter(key=>m[key]!==undefined).map(key=>[key,m[key]])))};
  }
  function normalize(input){
    if(!input||!tokenPattern.test(input.projectId||'')||!tokenPattern.test(input.operationId||'')||typeof input.model!=='string'||!tokenPattern.test(input.model)||typeof input.prompt!=='string'||!input.prompt.trim()||input.prompt.length>30000)throw fail('invalid');
    if(Object.keys(input).some(key=>!['projectId','operationId','revision','model','prompt','options','assetIds'].includes(key)))throw fail('invalid');
    if(!input.options||Object.keys(input.options).some(key=>!['ratio','resolution','duration'].includes(key)))throw fail('invalid');
    const {ratio,resolution,duration}=input.options;
    if(typeof ratio!=='string'||typeof resolution!=='string'||!Number.isFinite(duration)||duration<=0)throw fail('invalid');
    const ids=input.assetIds??[];
    if(!Array.isArray(ids)||ids.length>20||new Set(ids).size!==ids.length||ids.some(id=>typeof id!=='string'||!assetPattern.test(id)))throw fail('invalid');
    return {model:input.model,prompt:input.prompt,options:{ratio,resolution,duration},assetIds:[...ids]};
  }
  function assetsFor(input){
    try{return input.assetIds.map(id=>{const a=getAssets().get(id);return {id:a.id,kind:a.kind,size:a.size,...(a.durationSeconds?{durationSeconds:a.durationSeconds}:{})};});}
    catch{throw fail('parameters_changed',409);}
  }
  const signature=(input,assets)=>digest(JSON.stringify({input,assets}));
  async function validateInput(input,expected){
    const directory=await catalog();assertContext(expected);
    const model=directory.models.find(m=>m.id===input.model),assets=assetsFor(input);
    const {modelOptionsError}=await import('./public/canvas-core.mjs');
    const {mediaLimitError}=await import('./public/core.mjs');assertContext(expected);
    if(modelOptionsError(model,input.options,'main')||mediaLimitError(model,assets))throw fail('parameters_changed',409);
    return {model,assets,fingerprint:signature(input,assets)};
  }
  async function quote(input){
    const expected=assertContext();
    if(input.revision!==undefined&&input.revision!==expected.revision)throw fail('account_changed',409);
    const value=normalize(input),requestId='hypit-'+digest(JSON.stringify([expected.owner,input.projectId,input.operationId]));
    if(broken.has(requestId))throw fail('receipt_invalid',409);
    if(locks.has(requestId))throw fail('operation_locked',409);
    locks.add(requestId);
    try{
      const old=records.get(requestId);
      if(old&&!['awaiting_confirmation','confirmed'].includes(old.status)){
        // Historic receipts do not depend on today's catalogue, material files
        // or pricing. A removed line must not prevent recovering its old task.
        if(JSON.stringify(old.input)!==JSON.stringify(value))throw fail('operation_locked',409);
        return visible(reconcile(old));
      }
      const checked=await validateInput(value,expected);
      const media_counts={images:0,videos:0,audios:0};
      for(const asset of checked.assets){const field={image:'images',video:'videos',audio:'audios'}[asset.kind];if(!field)throw fail('invalid');media_counts[field]++;}
      const response=await local('/api/quotes',{...value.options,model:value.model,concurrency:1,media_counts},expected);
      const {quoteValid}=await import('./public/canvas-pricing.mjs');assertContext(expected);
      if(response.revision!==expected.revision||!quoteValid(response.quote,{model:value.model,quantity:1}))throw fail('quote_invalid',409);
      const record={requestId,projectId:input.projectId,operationId:input.operationId,owner:expected.owner,revision:expected.revision,
        input:value,fingerprint:checked.fingerprint,status:'awaiting_confirmation',confirmed:false,quote:snapshotQuote(response.quote),
        createdAt:old?.createdAt||new Date().toISOString()};
      return visible(save(record));
    }finally{locks.delete(requestId);}
  }
  async function confirm(input){
    const expected=assertContext(),record=get(input.requestId,input.projectId);
    if(locks.has(record.requestId))throw fail('operation_locked',409);
    if(input.confirmed!==true||input.quoteId!==record.quote?.id)throw fail('confirmation_required',428);
    if(input.revision!==expected.revision||record.revision!==expected.revision)throw fail('account_changed',409);
    if(!['awaiting_confirmation','confirmed'].includes(record.status))return visible(reconcile(record));
    locks.add(record.requestId);
    try{
      const {quoteValid}=await import('./public/canvas-pricing.mjs');assertContext(expected);
      if(!quoteValid(record.quote,{model:record.input.model,quantity:1}))throw fail('quote_invalid',409);
      const checked=await validateInput(record.input,expected);
      if(checked.fingerprint!==record.fingerprint||checked.model.line_revision!==undefined&&checked.model.line_revision!==record.quote.price_version)throw fail('parameters_changed',409);
      return visible(save(Object.assign(record,{confirmed:true,status:'confirmed',errorCode:''})));
    }finally{locks.delete(record.requestId);}
  }
  async function start(input){
    const expected=assertContext(),record=get(input.requestId,input.projectId);
    if(input.revision!==undefined&&input.revision!==expected.revision)throw fail('account_changed',409);
    if(!['awaiting_confirmation','confirmed'].includes(record.status))return visible(reconcile(record));
    if(locks.has(record.requestId))throw fail('operation_locked',409);
    if(record.status!=='confirmed'||!record.confirmed)throw fail('confirmation_required',428);
    if(record.revision!==expected.revision)throw fail('account_changed',409);
    locks.add(record.requestId);
    try{
      const {quoteValid}=await import('./public/canvas-pricing.mjs');
      const assertQuote=()=>{assertContext(expected);if(!quoteValid(record.quote,{model:record.input.model,quantity:1}))throw fail('quote_invalid',409);};
      assertQuote();
      const checked=await validateInput(record.input,expected);
      if(checked.fingerprint!==record.fingerprint||checked.model.line_revision!==undefined&&checked.model.line_revision!==record.quote.price_version)throw fail('parameters_changed',409);
      save(Object.assign(record,{status:'preparing',errorCode:''}));
      const uploaded=[];
      for(const asset of checked.assets){
        assertQuote();
        let remote;try{remote=await getAssets().upload(asset.id,{kind:'video',revision:expected.revision});}catch{throw fail('service_unavailable',503);}
        assertQuote();
        if(!/^https:\/\//.test(remote?.url||'')||remote.kind!==asset.kind)throw fail('service_unavailable',503);
        uploaded.push({...remote});
      }
      if(signature(record.input,assetsFor(record.input))!==record.fingerprint)throw fail('parameters_changed',409);
      const body={...record.input.options,model:record.input.model,prompt:record.input.prompt,concurrency:1,
        quote_id:record.quote.id,price_version:record.quote.price_version,images:[],videos:[],audios:[]};
      for(const asset of uploaded){const field={image:'images',video:'videos',audio:'audios'}[asset.kind];body[field].push({url:asset.url,tag:'@'+({image:'图片',video:'视频',audio:'音频'}[asset.kind])+(body[field].length+1),...(asset.durationSeconds?{durationSeconds:asset.durationSeconds}:{})});}
      // Uploads may outlive the approved quote. Reject before marking a paid
      // attempt; once submitting is saved, any uncertainty stays conservative.
      assertQuote();
      // The host receipt is durable before the one paid-capable local API call.
      save(Object.assign(record,{status:'submitting',confirmed:false}));
      try{await local('/api/videos',body,expected,record.requestId);}
      catch(e){record.errorCode=e.code==='account_changed'?'account_changed':'submission_unknown';}
      save(Object.assign(record,{status:'unknown',errorCode:record.errorCode||'submission_unknown'}));
      assertContext(expected);return visible(reconcile(record));
    }catch(e){
      if(record.status==='preparing'){save(Object.assign(record,{status:'awaiting_confirmation',confirmed:false,errorCode:e.code||'service_unavailable'}));}
      throw e;
    }finally{locks.delete(record.requestId);}
  }
  function poll(requestId,projectId){return visible(reconcile(get(requestId,projectId)));}
  function list(projectId){
    const expected=assertContext();
    if(projectId!==undefined&&!tokenPattern.test(projectId))throw fail('invalid');
    return [...records.values()].filter(r=>r.owner===expected.owner&&(!projectId||r.projectId===projectId)).map(r=>visible(reconcile(r))).sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
  }
  async function handle(req,res,url,{isProvider=false,projectId}={}){
    const reply=(status,data)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(data));};
    const route=url.pathname.replace(/^\/api\/hypit\/video/,'');
    const read=async()=>{let size=0,chunks=[];for await(const part of req){size+=part.length;if(size>128*1024)throw fail('invalid',413);chunks.push(part);}try{return JSON.parse(Buffer.concat(chunks).toString()||'{}');}catch{throw fail('invalid');}};
    if(route==='/models'&&req.method==='GET')return reply(200,await catalog());
    if(route==='/operations'&&req.method==='GET')return reply(200,{operations:list(projectId||url.searchParams.get('projectId')||undefined)});
    if(route==='/quote'&&req.method==='POST'){
      const input=await read();if(projectId&&input.projectId!==projectId)throw fail('not_found',404);
      return reply(200,await quote(input));
    }
    if(['/confirm','/start'].includes(route)&&req.method==='POST'){
      if(route==='/confirm'&&isProvider)throw fail('confirmation_required',403);
      const input=await read();get(input.requestId,projectId);input.projectId=projectId||input.projectId;
      return reply(200,route==='/confirm'?await confirm(input):await start(input));
    }
    const match=route.match(/^\/operations\/(hypit-[a-f0-9]{64})(\/file)?$/);
    if(match&&['GET','HEAD'].includes(req.method)){
      const record=reconcile(get(match[1],projectId));
      if(!match[2])return reply(200,visible(record));
      if(record.status!=='succeeded'||!record.localFile||!assetPattern.test(record.taskKey||''))throw fail('result_pending',409);
      return taskStore().handle(req,res,new URL('/api/tasks/'+record.taskKey+'/file',url));
    }
    throw fail('not_found',404);
  }
  return {catalog,quote,confirm,start,poll,list,handle};
}
module.exports={createHypitVideoBridge};
