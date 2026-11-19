const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {pipeline}=require('node:stream/promises');
const {Transform}=require('node:stream');
const {createReverseClient}=require('./reverse-client.cjs');
const {validateReverseVideo}=require('./reverse-media.cjs');

const PRICE_VERSION='reverse-cny-003-v1',MAX_BYTES=500*1024*1024;
const OPTIONS=Object.freeze({video_types:['general','short','dance','ecommerce','script','drama','anime'],target_models:['allRef','firstFrame','firstFrameRef'],task_duration_min:1,task_duration_max:300});
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const idPattern=/^[a-f0-9]{32}$/;
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
const fail=(message,statusCode=400,code='reverse_invalid')=>Object.assign(Error(message),{statusCode,code});
const message={disabled:'视频分析暂未开放，请稍后重新检测',configuration:'账户配置已变更，请重新检测视频分析服务',unknown:'原分析任务结果待确认，请查询原任务，勿重复提交',missing:'分析记录不存在',unavailable:'视频分析服务暂时不可用，请稍后查询原任务'};
const stamp=now=>new Date(now()).toISOString();
const same=(a,b)=>a.owner===b.owner&&a.scope===b.scope&&a.revision===b.revision&&a.keyHash===b.keyHash;
function validPricing(value){return value?.price_version===PRICE_VERSION&&value.currency==='CNY'&&value.unit_price_cny==='0.03'&&value.reservation_cny==='18.00'&&value.max_seconds===600&&value.confirmation_required===true&&value.billing_mode==='actual_seconds_v1';}
function publicBilling(value){
  if(!value||!['reserved','pending','settled','released'].includes(value.status)||value.price_version!==PRICE_VERSION)return undefined;
  const decimal=input=>typeof input==='string'&&/^(?:0|[1-9]\d{0,5})(?:\.\d{1,6})?$/.test(input);
  if(!['reservation_cny','charged_cny','refunded_cny'].every(key=>decimal(value[key])&&Number(value[key])<=18))return undefined;
  const micros=input=>{const [whole,fraction='']=input.split('.');return BigInt(whole)*1000000n+BigInt(fraction.padEnd(6,'0'));};
  const reserved=micros(value.reservation_cny),charged=micros(value.charged_cny),refunded=micros(value.refunded_cny);
  if(charged+refunded>reserved||['settled','released'].includes(value.status)&&charged+refunded!==reserved)return undefined;
  const seconds=typeof value.charged_seconds==='number'?value.charged_seconds:decimal(value.charged_seconds)?Number(value.charged_seconds):NaN;
  return {status:value.status,price_version:PRICE_VERSION,reservation_cny:value.reservation_cny,charged_cny:value.charged_cny,refunded_cny:value.refunded_cny,...(Number.isFinite(seconds)&&seconds>=0&&seconds<=600?{charged_seconds:seconds}:{})};
}
function optionsOf(value){
  if(!value||Object.keys(value).sort().join(',')!=='targetModel,taskDurationSec,videoType'||!OPTIONS.video_types.includes(value.videoType)||!OPTIONS.target_models.includes(value.targetModel)||!Number.isInteger(value.taskDurationSec)||value.taskDurationSec<1||value.taskDurationSec>300)throw fail('请选择有效的分析选项');
  return {videoType:value.videoType,targetModel:value.targetModel,taskDurationSec:value.taskDurationSec};
}
function reverseLink(value){
  const invalid=()=>{throw fail('请粘贴支持平台的单个HTTPS视频链接',400,'reverse_invalid_link');};
  if(typeof value!=='string'||!value||Buffer.byteLength(value,'utf8')>4096||/\s|[\u0000-\u001f\u007f-\u009f\\]/u.test(value))return invalid();
  const raw=/^https:\/\/([^/?#]+)(\/[^?#]*)?(?:\?([^#]*))?$/i.exec(value);
  if(!raw||!/^[A-Za-z0-9.-]+(?::443)?$/.test(raw[1]))return invalid();
  const path=raw[2]||'/',hostname=raw[1].replace(/:443$/,'').toLowerCase();
  // Match the raw authority/path: URL normalization must never turn an unsafe
  // input such as dot segments, escaped path separators or userinfo into a match.
  const rules={
    'douyin.com':['douyin',/^\/video\/[0-9]+\/?$/],
    'www.douyin.com':['douyin',/^\/video\/[0-9]+\/?$/],
    'v.douyin.com':['douyin',/^\/[A-Za-z0-9_-]{1,128}\/?$/],
    'xiaohongshu.com':['xiaohongshu',/^\/(?:explore|discovery\/item)\/[0-9a-fA-F]{24}\/?$/],
    'www.xiaohongshu.com':['xiaohongshu',/^\/(?:explore|discovery\/item)\/[0-9a-fA-F]{24}\/?$/],
    'xhslink.com':['xiaohongshu',/^\/(?:[ao]\/)?[A-Za-z0-9_-]{1,128}\/?$/],
    'bilibili.com':['bilibili',/^\/video\/(?:BV[A-Za-z0-9]+|av[0-9]+)\/?$/],
    'www.bilibili.com':['bilibili',/^\/video\/(?:BV[A-Za-z0-9]+|av[0-9]+)\/?$/],
    'b23.tv':['bilibili',/^\/[A-Za-z0-9_-]{1,128}\/?$/],
  };
  const rule=Object.hasOwn(rules,hostname)?rules[hostname]:null;
  if(!rule||!rule[1].test(path))return invalid();
  let query;
  try{query=decodeURIComponent((raw[3]||'').replace(/\+/g,' '));new URL(value);}catch{return invalid();}
  for(let i=0;i<3;i++){
    if(/https?:\/\//i.test(query)||/[\\\u0000-\u001f\u007f-\u009f]/u.test(query))return invalid();
    let decoded;try{decoded=decodeURIComponent(query.replace(/\+/g,' '));}catch{return invalid();}
    if(decoded===query)return {url:value,platform:rule[0]};query=decoded;
  }
  return invalid();
}
async function readJSON(req){
  const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>16384)throw fail('请求过大',413);chunks.push(chunk);}
  try{const value=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(!value||Array.isArray(value)||typeof value!=='object')throw Error();return value;}catch{throw fail('请求格式无效');}
}
function createReverse({dir,getContext,client=createReverseClient(),now=Date.now}={}){
  const records=new Map(),inflight=new Map(),pending=new Set();let loaded=false,stopped=false;
  const context=()=>{
    const raw=getContext?.()||{};
    return {owner:raw.owner||'',scope:raw.scope||'',revision:raw.revision||0,key:raw.key||'',keyHash:hash(raw.key||'')};
  };
  const assertCurrent=ctx=>{if(stopped||!same(ctx,context()))throw fail(message.configuration,409,'reverse_configuration_changed');};
  const assertHeaders=(req,ctx)=>{if(!ctx.owner||!ctx.key)throw fail('请到账户页开通并启用工具服务',401);if(req.headers['x-hamster-execution-scope']!==ctx.scope||String(req.headers['x-hamster-config-revision'])!==String(ctx.revision))throw fail(message.configuration,409,'reverse_configuration_changed');};
  function load(){
    if(loaded)return;loaded=true;if(!fs.existsSync(dir))return;
    for(const name of fs.readdirSync(dir)){
      if(!/^[a-f0-9]{32}\.json$/.test(name))continue;
      try{const item=JSON.parse(fs.readFileSync(path.join(dir,name),'utf8'));if(idPattern.test(item.id)&&item.id+'.json'===name&&['upload','task'].includes(item.kind)&&typeof item.owner==='string'&&uuid.test(item.operation_id)){if(['uploading','submitting'].includes(item.status))item.status='unknown';records.set(item.id,item);}}catch{}
    }
  }
  function save(item){
    fs.mkdirSync(dir,{recursive:true});item.updated_at=stamp(now);const file=path.join(dir,item.id+'.json'),temp=file+'.tmp';
    const fd=fs.openSync(temp,'w',0o600);try{fs.writeFileSync(fd,JSON.stringify(item),'utf8');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}fs.renameSync(temp,file);records.set(item.id,item);
  }
  const owned=(id,ctx)=>{load();const item=records.get(id);if(!item||item.owner!==ctx.owner||!ctx.owner)throw fail(message.missing,404);return item;};
  const byOperation=(op,ctx)=>{load();return [...records.values()].find(item=>item.owner===ctx.owner&&item.operation_id===op);};
  function view(item){return {id:item.id,operation_id:item.operation_id,status:item.status,progress:item.progress||0,text:item.text||'',error:item.error||'',created_at:item.created_at,updated_at:item.updated_at,...(item.billing?{billing:item.billing}:{})};}
  function publicQuote(value){
    return {available:value?.available===true&&validPricing(value),price_version:PRICE_VERSION,currency:'CNY',unit_price_cny:'0.03',reservation_cny:'18.00',max_seconds:600,confirmation_required:true,billing_mode:'actual_seconds_v1'};
  }
  async function capabilities(ctx){
    const fallback={available:false,reason:'请到账户页开通并启用工具服务',reason_code:'tool_not_configured',input_modes:['file'],supported_platforms:[],limits:{max_bytes:MAX_BYTES,max_seconds:600,extensions:['mp4','mov','webm','m4v']},options:OPTIONS,execution:{scope:ctx.scope,revision:ctx.revision}};
    if(!ctx.owner||!ctx.key)return fallback;
    try{
      const remote=await client.capabilities(ctx.key);assertCurrent(ctx);
      const billing={...publicQuote(remote.billing),available:remote.billing?.configured===true&&validPricing(remote.billing)},available=remote.available===true&&billing.available;
      // The released file-only server has no input_modes. Never infer link support.
      const input_modes=Array.isArray(remote.input_modes)?['file','link'].filter(mode=>remote.input_modes.includes(mode)):['file'];
      const supported_platforms=input_modes.includes('link')&&Array.isArray(remote.supported_platforms)?['douyin','xiaohongshu','bilibili'].filter(platform=>remote.supported_platforms.includes(platform)):[];
      return {...fallback,available,reason:available?'':message.disabled,reason_code:available?'ready':'not_available',billing,input_modes,supported_platforms};
    }catch(error){assertCurrent(ctx);return {...fallback,reason:message.unavailable,reason_code:error.statusCode===401||error.statusCode===403?'authorization_unavailable':'service_unavailable'};}
  }
  async function quote(ctx){
    if(!ctx.owner||!ctx.key)return {...publicQuote(null),execution:{scope:ctx.scope,revision:ctx.revision}};
    const remote=await client.quote(ctx.key);assertCurrent(ctx);return {...publicQuote(remote),execution:{scope:ctx.scope,revision:ctx.revision}};
  }
  async function assertEnabled(ctx,mode='file',platform){
    const value=await capabilities(ctx);assertCurrent(ctx);if(!value.available)throw fail(message.disabled,503,'reverse_disabled');
    if(!value.input_modes.includes(mode))throw fail(mode==='link'?'当前服务尚未开放链接反推，请使用视频文件':'当前服务尚未开放视频文件反推',503,'reverse_input_unavailable');
    if(mode==='link'&&!value.supported_platforms.includes(platform))throw fail('当前服务尚未开放此平台的链接反推',503,'reverse_input_unavailable');
  }
  async function upload(req,ctx){
    assertHeaders(req,ctx);const operation_id=String(req.headers['x-reverse-operation-id']||'');if(!uuid.test(operation_id))throw fail('上传操作编号无效');
    const existing=byOperation(operation_id,ctx);
    if(existing){if(existing.kind==='upload'&&existing.status==='ready')return {upload_id:existing.id,expires_at:existing.expires_at};throw fail(message.unknown,409,'reverse_unknown');}
    const slot=hash(ctx.owner+':'+operation_id);if(pending.has(slot))throw fail(message.unknown,409,'reverse_unknown');pending.add(slot);
    let temp,item;
    try{
      await assertEnabled(ctx);assertCurrent(ctx);
      const size=Number(req.headers['content-length']),contentType=String(req.headers['content-type']||'').split(';')[0].trim().toLowerCase();
      if(!Number.isSafeInteger(size)||size<16||size>MAX_BYTES)throw fail('请选择500MB以内的视频文件',413);
      let filename;try{filename=decodeURIComponent(String(req.headers['x-reverse-filename']||''));}catch{throw fail('视频文件名无效');}
      const ext=/\.([a-z0-9]+)$/i.exec(filename)?.[1]?.toLowerCase();
      if(!filename||filename.length>200||/[\x00-\x1f\x7f\\/]/.test(filename)||!['mp4','mov','webm','m4v'].includes(ext)||!['video/mp4','video/webm','video/quicktime','video/x-m4v'].includes(contentType)||ext==='webm'&&contentType!=='video/webm'||ext!=='webm'&&contentType==='video/webm')throw fail('请选择MP4、MOV、WebM或M4V视频');
      item={id:crypto.randomBytes(16).toString('hex'),kind:'upload',operation_id,owner:ctx.owner,scope:ctx.scope,revision:ctx.revision,keyHash:ctx.keyHash,status:'uploading',created_at:stamp(now)};save(item);
      temp=path.join(dir,item.id+'.video.tmp');let read=0;
      await pipeline(req,new Transform({transform(chunk,_encoding,callback){read+=chunk.length;callback(read>size?fail('视频大小不符合要求',413):null,chunk);}}),fs.createWriteStream(temp,{flags:'wx',mode:0o600}));
      if(read!==size)throw fail('视频上传未完成，请重新选择文件');
      const metadata=validateReverseVideo(temp,{contentType,contentLength:size});assertCurrent(ctx);
      // Browser MIME aliases vary; the provider contract uses one MIME for each extension.
      metadata.content_type={mp4:'video/mp4',mov:'video/quicktime',webm:'video/webm',m4v:'video/x-m4v'}[ext];
      const remote=await client.upload(ctx.key,{filename:'video.'+ext,size_bytes:size,content_type:metadata.content_type,duration_seconds:metadata.duration_seconds,operation_id});assertCurrent(ctx);
      if(!/^rvu_[a-f0-9]{32}$/.test(remote.upload_id||'')||!Number.isSafeInteger(remote.expires_at)||remote.expires_at*1000<=now())throw fail(message.unavailable,502);
      item.remote_upload_id=remote.upload_id;item.expires_at=remote.expires_at;save(item);
      await client.put(remote,temp,{contentType:metadata.content_type,size});assertCurrent(ctx);
      item.status='ready';item.error='';save(item);return {upload_id:item.id,expires_at:item.expires_at};
    }catch(error){if(item){item.status='unknown';item.error=message.unknown;try{save(item);}catch{}}throw error;}
    finally{pending.delete(slot);if(temp){try{fs.unlinkSync(temp);}catch{}}}
  }
  function apply(item,remote){
    const status={queued:'queued',analyzing:'processing',done:'succeeded',error:'failed',cancelled:'failed',unknown:'unknown'}[remote?.status];
    if(!status)throw fail(message.unavailable,502);
    if(remote.id&&!/^rvt_[a-f0-9]{32}$/.test(remote.id))throw fail(message.unavailable,502);
    if(remote.id&&item.remote_task_id&&remote.id!==item.remote_task_id||remote.operation_id&&remote.operation_id!==item.operation_id)throw fail(message.unavailable,502);
    if(status==='succeeded'&&(typeof remote.result?.text!=='string'||!remote.result.text.trim()||remote.result.text.length>500000))throw fail(message.unavailable,502);
    if(remote.id)item.remote_task_id=remote.id;
    if(['queued','processing','succeeded','failed'].includes(status)&&!item.remote_task_id)throw fail(message.unavailable,502);
    item.status=status;item.progress=status==='succeeded'?100:status==='processing'?50:0;item.error=status==='failed'?'本次分析未完成，请核对任务记录':status==='unknown'?message.unknown:'';
    if(status==='succeeded'){
      item.text=remote.result.text;
    }
    const billing=publicBilling(remote.billing);if(billing)item.billing=billing;
  }
  async function submit(req,ctx){
    assertHeaders(req,ctx);const body=await readJSON(req),operation_id=body.operation_id;
    const isLink=Object.hasOwn(body,'url'),isFile=Object.hasOwn(body,'upload_id');
    if(!uuid.test(operation_id||'')||isLink===isFile||isFile&&!idPattern.test(body.upload_id||''))throw fail('请选择视频文件或粘贴视频链接，不能同时提交两种输入');
    const link=isLink?reverseLink(body.url):null;
    const options=optionsOf(body.options);
    if(body.price_version!==PRICE_VERSION||body.billing_confirmed!==true)throw fail('请先确认本次分析价格和18元预占上限',428,'reverse_confirmation_required');
    const source=isLink?{url:link.url}:{upload_id:body.upload_id};
    const fingerprint=hash(JSON.stringify({...source,options,price_version:body.price_version,billing_confirmed:true}));
    const existing=byOperation(operation_id,ctx);if(existing){if(existing.kind!=='task'||existing.fingerprint!==fingerprint)throw fail('同一操作编号不能更换分析内容',409);return {task:view(existing)};}
    const slot=hash(ctx.owner+':'+operation_id);if(pending.has(slot))throw fail(message.unknown,409,'reverse_unknown');pending.add(slot);
    try{
      await assertEnabled(ctx,isLink?'link':'file',link?.platform);assertCurrent(ctx);
      const price=await quote(ctx);if(!price.available)throw fail(message.disabled,503,'reverse_disabled');
      let remoteSource;
      if(isFile){
        const input=owned(body.upload_id,ctx);
        if(input.kind!=='upload'||input.status!=='ready'||!same(input,ctx)||input.expires_at*1000<=now())throw fail('视频授权已失效，请重新上传',409);
        if(input.task_operation_id&&input.task_operation_id!==operation_id)throw fail('该视频已提交分析，请查询原任务',409);
        input.task_operation_id=operation_id;save(input);remoteSource={upload_id:input.remote_upload_id};
      }else remoteSource={url:link.url};
      const item={id:crypto.randomBytes(16).toString('hex'),kind:'task',operation_id,owner:ctx.owner,scope:ctx.scope,revision:ctx.revision,keyHash:ctx.keyHash,fingerprint,options,...(isLink?{input_mode:'link'}:{}),status:'submitting',created_at:stamp(now),progress:0,text:'',error:''};save(item);
      try{
        const remote=await client.submit(ctx.key,{...remoteSource,options,operation_id,price_version:PRICE_VERSION,billing_confirmed:true});
        // Retain the original acceptance even if the active account changed meanwhile.
        apply(item,remote);save(item);assertCurrent(ctx);
      }catch(error){
        if(item.status==='submitting'){
          const insufficient=error?.statusCode===402&&error?.code==='reverse_reservation_insufficient'&&error?.submissionState==='not_submitted';
          item.status=insufficient?'failed':'unknown';item.error=insufficient?'可用余额不足，本次分析未提交，请到账户页补足预占金额':message.unknown;
          if(insufficient)item.submission_state='not_submitted';save(item);
          if(insufficient)throw fail(item.error,402,'reverse_reservation_insufficient');
        }
        if(error?.code==='reverse_configuration_changed')throw error;
      }
      assertCurrent(ctx);return {task:view(item)};
    }finally{pending.delete(slot);}
  }
  async function refresh(item,ctx){
    if(item.kind!=='task'||item.status==='failed'||item.status==='succeeded'&&['settled','released'].includes(item.billing?.status)||item.next_query_at>now())return item;
    if(inflight.has(item.id)){await inflight.get(item.id);assertCurrent(ctx);return item;}
    const run=(async()=>{
      try{
        const remote=item.remote_task_id?await client.task(ctx.key,item.remote_task_id):await client.operation(ctx.key,item.operation_id);
        assertCurrent(ctx);if(remote.kind&&remote.kind!=='task')throw fail(message.unavailable,502);apply(item,remote);item.next_query_at=now()+5000;save(item);
      }catch(error){assertCurrent(ctx);item.error=message.unavailable;item.next_query_at=now()+15000;save(item);}
    })();inflight.set(item.id,run);
    try{await run;return item;}finally{inflight.delete(item.id);}
  }
  async function handle(req,res,url){
    const send=(status,value)=>{if(res.destroyed)return;res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(value));};
    const ctx=context();try{
      const route=url.pathname.slice('/api/reverse'.length);
      if(route==='/capabilities'&&req.method==='GET')return send(200,await capabilities(ctx));
      if(route==='/quote'&&req.method==='GET')return send(200,await quote(ctx));
      if(route==='/uploads'&&req.method==='POST')return send(201,await upload(req,ctx));
      if(route==='/submit'&&req.method==='POST')return send(202,await submit(req,ctx));
      if(!ctx.owner||!ctx.key)throw fail('请登录原任务所属账户后查看分析记录',401);
      if(route==='/tasks'&&req.method==='GET'){
        load();const tasks=[...records.values()].filter(item=>item.kind==='task'&&item.owner===ctx.owner).sort((a,b)=>b.created_at.localeCompare(a.created_at));
        const ready=tasks.filter(item=>item.status!=='failed'&&!(item.status==='succeeded'&&['settled','released'].includes(item.billing?.status))&&!(item.next_query_at>now())).sort((a,b)=>(a.next_query_at||0)-(b.next_query_at||0));
        for(const item of ready.slice(0,2))await refresh(item,ctx);assertCurrent(ctx);return send(200,{tasks:tasks.map(view)});
      }
      const taskMatch=/^\/tasks\/([a-f0-9]{32})$/.exec(route),operationMatch=/^\/operations\/([0-9a-f-]{36})$/i.exec(route);
      if(req.method==='GET'&&(taskMatch||operationMatch)){
        const item=taskMatch?owned(taskMatch[1],ctx):byOperation(operationMatch[1],ctx);if(!item)throw fail(message.missing,404);
        if(item.kind==='upload')return send(200,{upload_id:item.id,status:item.status,expires_at:item.expires_at});
        await refresh(item,ctx);assertCurrent(ctx);return send(200,{task:view(item)});
      }
      send(404,{error:'视频分析接口未开放'});
    }catch(error){
      // Only errors constructed in this module or the media validator are customer text.
      const safe=String(error?.code||'').startsWith('reverse_');
      send(Number.isInteger(error?.statusCode)?error.statusCode:503,{error:safe?error.message:message.unavailable,code:safe?error.code:'reverse_unavailable'});req.resume();
    }
  }
  return {handle,stop:()=>{stopped=true;client.stop?.();}};
}
module.exports={createReverse,optionsOf,reverseLink,publicBilling,validPricing,PRICE_VERSION,MAX_BYTES};
