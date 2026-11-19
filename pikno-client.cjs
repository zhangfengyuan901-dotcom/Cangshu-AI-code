// Only published customer names and retail prices cross this transport.
// Private routing, costs and customer credentials never enter the catalogue.
const crypto = require('node:crypto');

const DEFAULT_PIKNO_ENDPOINT = 'https://www.piknoai.com';
const keyFields = {image:'piknoImageKey', video:'piknoVideoKey', tool:'piknoToolKey'};
const lineKeyKind = line => ['pikno-tool-digital','pikno-tool-depth'].includes(line.id) ? 'tool' : line.kind;
const toolTask = item => ['digital','depth'].includes(item.source) || /^(?:pikno-)?tool-(?:digital|depth)$/.test(item.model || '');
const fail = (message, statusCode=400, ambiguous=false) => Object.assign(new Error(message), {statusCode, ambiguous});
const configured = (cfg, kind) => Boolean(String(cfg[keyFields[kind]] || '').trim());
const aliasFor = line => line.id === 'pikno-tool-digital' ? 'tool-digital'
  : line.id === 'pikno-tool-depth' ? 'tool-depth'
  : `main-${line.kind}-${crypto.createHash('sha256').update(line.id).digest('hex').slice(0,16)}`;
// Declared per-kind limits can exceed the service's effective aggregate cap.
const countLimit = value => Number.isSafeInteger(value) && value >= 0 && value <= 1000 ? value : 0;
// .35 did not publish this field, but its quote and submit guards both cap 20.
const totalLimit = line => Math.min(20,Number.isSafeInteger(line.max_media_total)&&line.max_media_total>=0?line.max_media_total:20);
const moneyPattern=/^(?:0|[1-9]\d{0,9})(?:\.\d{1,6})?$/;
const validMoney=value=>typeof value==='string'&&moneyPattern.test(value);
const micros=value=>{const [whole,fraction='']=value.split('.');return BigInt(whole)*1000000n+BigInt(fraction.padEnd(6,'0'));};
const quoteCodes=new Set(['quote_invalid','quote_expired','quote_changed','quote_parameters_changed','quote_already_submitted']);
function publishedName(value,fallback='仓鼠线路') {
  const name=typeof value==='string'?value.trim():'';
  return name&&name.length<=160&&!/[\u0000-\u001f\u007f<>]|https?:|www\.|\b(?:sk|ark)-[a-zA-Z0-9_-]{12,}|\bep-[a-zA-Z0-9_-]{8,}|(?:\.com|\.cn|\.net|\.io)(?:[/:\s]|$)/i.test(name)?name:fallback;
}
const imageSizeRatio = size => {
  if (size==='auto') return 'auto';
  const [w,h]=size.split('x').map(Number);let a=w,b=h;while(b){[a,b]=[b,a%b];}return `${w/a}:${h/a}`;
};
const imageSpecs = line => {
  const sizes=[...new Set((Array.isArray(line.resolutions)?line.resolutions:[]).filter(value=>typeof value==='string'&&/^(?:[1-9]\d{2,3}x[1-9]\d{2,3}|auto)$/.test(value)))];
  const qualities=Array.isArray(line.qualities)?[...new Set(line.qualities.filter(value=>['auto','low','medium','high'].includes(value)))]:['auto'];
  return {sizes,qualities,ratios:[...new Set(sizes.map(imageSizeRatio))]};
};
function quoteParameters(line,payload={}, {actualMedia=false}={}) {
  const media={};
  for(const [kind,limit] of [['images','max_images'],['videos','max_videos'],['audios','max_audio']]){
    const value=actualMedia?(Array.isArray(payload[kind])?payload[kind].length:0):payload.media_counts?.[kind]??(Array.isArray(payload[kind])?payload[kind].length:0);
    if(!Number.isSafeInteger(value)||value<0||value>countLimit(line[limit]))throw fail('参考素材数量不符合当前线路要求');
    media[kind]=value;
  }
  if(media.images+media.videos+media.audios>totalLimit(line))throw fail('参考素材总数最多'+totalLimit(line)+'个');
  const quantity=Number(payload.concurrency??1);
  const tool=/^(?:pikno-)?tool-(digital|depth)$/.exec(line.id||'')?.[1];
  if(!(tool?[1]:[1,2,4]).includes(quantity))throw fail('任务份数无效');
  const result={model:line.id,operation:tool||line.kind,resolution:'',quality:'',ratio:'',seconds:0,reference_images:media.images,reference_videos:media.videos,reference_audio:media.audios,quantity};
  if(tool){
    if(tool==='digital'?media.images!==1||media.videos!==0||media.audios!==1:media.images!==0||media.videos!==1||media.audios!==0)throw fail('请按当前工具要求选择完整素材');
  }else if(line.kind==='video'){
    if(!Number.isSafeInteger(Number(payload.duration))||!line.durations?.includes(Number(payload.duration))||!line.resolutions?.includes(payload.resolution)||!line.ratios?.includes(payload.ratio))throw fail('生成规格不符合当前线路要求');
    Object.assign(result,{seconds:Number(payload.duration),resolution:payload.resolution,ratio:payload.ratio});
  }else if(line.kind==='image'){
    if(media.videos||media.audios)throw fail('图片生成只能使用图片参考');
    const {sizes,qualities}=imageSpecs(line);
    const size=payload.size||sizes.find(value=>imageSizeRatio(value)===(payload.aspect_ratio||imageSizeRatio(sizes[0]||'auto')));
    const quality=payload.quality||(qualities.includes('auto')?'auto':qualities[0]);
    if(!sizes.includes(size)||!qualities.includes(quality)||payload.aspect_ratio&&payload.aspect_ratio!==imageSizeRatio(size))throw fail('图片规格不符合当前线路要求');
    // The image contract derives aspect ratio from size; its canonical ratio is empty.
    Object.assign(result,{operation:media.images?'image_edit':'image',resolution:size,quality,ratio:''});
  }else throw fail('请选择当前功能可用线路');
  if(payload.reference&&!['all','omni'].includes(payload.reference))throw fail('此线路暂不支持当前参考方式');
  return result;
}
function validateRemoteQuote(value,parameters) {
  if(!value||typeof value.quote_id!=='string'||value.quote_id.length<16||value.quote_id.length>8192||publishedName(value.name,'')!==value.name||value.currency!=='CNY'
    ||!['image','second','request'].includes(value.unit)||!Number.isSafeInteger(value.line_revision)||value.line_revision<1
    ||!Number.isSafeInteger(value.units)||value.units<1||value.quantity!==parameters.quantity
    ||!Number.isSafeInteger(value.expires_at)||value.expires_at*1000<=Date.now()||value.expires_at*1000>Date.now()+360000
    ||!['unit_price_cny','reference_surcharge_cny','per_item_cny','total_cny'].every(key=>validMoney(value[key])))throw fail('报价暂时无法确认，请重新获取',502);
  if(micros(value.unit_price_cny)*BigInt(value.units)+micros(value.reference_surcharge_cny)!==micros(value.per_item_cny)||micros(value.per_item_cny)*BigInt(value.quantity)!==micros(value.total_cny))throw fail('报价暂时无法确认，请重新获取',502);
  const operation=parameters.operation;
  const validMeter=operation==='video'?(value.unit==='second'&&value.units===parameters.seconds||value.unit==='request'&&value.units===1)
    :['image','image_edit'].includes(operation)?value.unit==='image'&&value.units===1
    :['digital','depth'].includes(operation)&&value.unit==='request'&&value.units===1;
  if(!validMeter||value.operation!==undefined&&value.operation!==operation)throw fail('报价计费规则不匹配，请重新获取',502);
  return value;
}

function createPiknoClient({endpoint=DEFAULT_PIKNO_ENDPOINT, fetchImpl=fetch}={}) {
  const origin = new URL(endpoint);
  if (origin.username || origin.password || origin.search || origin.hash || origin.pathname !== '/' ||
      !(origin.protocol === 'https:' || origin.protocol === 'http:' && origin.hostname === '127.0.0.1')) throw fail('服务地址无效');
  const base = origin.origin;
  let cacheEpoch=0,publicCache=null;
  const publicInflight=new Map(),readInflight=new Map();
  const invalidate=()=>{cacheEpoch++;publicCache=null;publicInflight.clear();readInflight.clear();};
  async function sharedRead(cfg,kind,route){
    const cacheKey=cacheEpoch+':'+kind+':'+route+':'+crypto.createHash('sha256').update(String(cfg[keyFields[kind]]||'')).digest('hex');
    if(readInflight.has(cacheKey))return readInflight.get(cacheKey);
    const result=request(cfg,kind,route,{readOnly:true,timeout:20000});readInflight.set(cacheKey,result);
    try{return await result;}finally{if(readInflight.get(cacheKey)===result)readInflight.delete(cacheKey);}
  }
  async function publicCatalog(fresh=false){
    if(!fresh&&publicCache&&publicCache.epoch===cacheEpoch&&publicCache.until>Date.now())return publicCache.data;
    const epoch=cacheEpoch;
    if(publicInflight.has(epoch))return publicInflight.get(epoch);
    const result=request({},'', '/api/pikno/catalog',{publicRequest:true,readOnly:true,timeout:20000});publicInflight.set(epoch,result);
    try{const data=await result;if(epoch===cacheEpoch)publicCache={epoch,data,until:Date.now()+2000};return data;}
    finally{if(publicInflight.get(epoch)===result)publicInflight.delete(epoch);}
  }
  const assetUrl = value => {
    try {
      const url = new URL(value);
      if (url.origin !== base || url.username || url.password || url.hash ||
          !/^\/media\/v1\/assets\/[a-f0-9]{32}$/.test(url.pathname)) throw fail('素材地址无效');
      return url;
    } catch { throw fail('素材地址无效'); }
  };
  async function request(cfg, kind, route, {publicRequest=false, readOnly=false, timeout=60000, ...options}={}) {
    if (!route.startsWith('/') || route.startsWith('//') || /[\\\r\n]/.test(route) || new URL(route,base).origin !== base) throw fail('服务请求无效');
    const key = String(cfg[keyFields[kind]] || '').trim();
    if (!publicRequest && !key) throw fail(kind==='image' ? '请先配置图片 Key' : kind==='tool' ? '请先配置工具 Key' : '请先配置视频 Key',401);
    const headers = new Headers(options.headers);
    headers.delete('authorization'); headers.delete('x-api-key');
    if (!publicRequest) headers.set('Authorization', 'Bearer '+key);
    let response;
    try {
      response = await fetchImpl(base+route, {...options, headers, redirect:'error', signal:AbortSignal.timeout(timeout)});
    } catch { throw fail(readOnly?'报价暂时无法连接，请稍后重新获取':'仓鼠服务连接未确认，请核对任务记录，勿重复提交',503,!readOnly&&options.method==='POST'); }
    if (!response.ok) {
      let structured;try{structured=await response.json();}catch{}
      const code=structured?.error?.code;
      if(quoteCodes.has(code)){
        const messages={quote_invalid:'报价无效，请重新获取并确认',quote_expired:'报价已过期，请重新获取并确认',quote_changed:'价格或线路已更新，请重新获取并确认',quote_parameters_changed:'生成参数已变化，请重新获取并确认',quote_already_submitted:'此报价已提交，请查询原任务，勿重复提交'};
        const error=fail(messages[code],response.status,!readOnly&&code==='quote_already_submitted');error.code=code;
        if(['pending','accepted'].includes(structured.error.submission_state))error.submissionState=structured.error.submission_state;
        if(/^[a-zA-Z0-9_-]{1,200}$/.test(structured.error.task_id||''))error.originalTaskId=structured.error.task_id;
        throw error;
      }
      const messages = {401:'Key 无效或已过期，请到 PIKNO 检查',402:'PIKNO 账户余额不足，请前往 PIKNO 充值后重新确认报价',403:'此 Key 没有当前功能权限',404:'此功能或线路尚未开放',429:'请求过于频繁，请稍后再试'};
      const error=fail(readOnly&&(response.status>=500||response.status===404)?'报价暂时不可用，请稍后重新获取':messages[response.status] || (response.status>=500?'服务响应未确认，请核对任务记录，勿重复提交':'请求参数无效，请检查当前线路要求'), response.status, !readOnly&&options.method==='POST' && (response.status>=500 || response.status===408));
      if(response.status===402)error.code='insufficient_balance';
      throw error;
    }
    try { return await response.json(); }
    catch { throw fail(readOnly?'报价暂时无法确认，请重新获取':'服务结果未确认，请核对任务记录，勿重复提交',502,!readOnly&&options.method==='POST'); }
  }
  async function context(cfg, kind) {
    const value = await sharedRead(cfg,kind,'/v1/client/context');
    if (!Number.isSafeInteger(value.user_id) || value.user_id < 1 || value.group !== kind+'-standard') throw fail('请使用对应类型的 PIKNO Key',403);
    return value;
  }
  async function catalog(cfg,{fresh=false}={}) {
    const kinds = ['image','video','tool'].filter(kind=>configured(cfg,kind));
    if (!kinds.length) throw fail('请先配置 PIKNO Key',401);
    const [publicData, results] = await Promise.all([
      publicCatalog(fresh),
      Promise.allSettled(kinds.map(kind=>sharedRead(cfg,kind,'/v1/models'))),
    ]);
    if(results.every(result=>result.status==='rejected'))throw results[0].reason;
    const allowed=results.map(result=>result.status==='fulfilled'?result.value:{data:[]});
    if (!Array.isArray(publicData.data?.models) || allowed.some(value=>!Array.isArray(value.data))) throw fail('线路目录暂不可用',502);
    const permitted = new Map(kinds.map((kind,index)=>[kind,new Set(allowed[index].data.map(model=>model.id))]));
    const lines = publicData.data.models.filter(line=>['image','video'].includes(line.kind) && typeof line.id==='string' && permitted.get(lineKeyKind(line))?.has(line.id));
    const models = lines.map(line=>{
      const id = aliasFor(line), tool = id.startsWith('tool-');
      const resolutions = (Array.isArray(line.resolutions)?line.resolutions:[]).filter(value=>/^(?:\d{3,4}p|\d{3,4}x\d{3,4}|default|auto)$/.test(value));
      const specs = line.kind==='image'?imageSpecs(line):null;
      const prices=(Array.isArray(line.prices)?line.prices:[]).filter(p=>p&&typeof p.resolution==='string'&&/^(?:\d{3,4}p|\d{3,4}x\d{3,4}|default|auto)$/.test(p.resolution)&&['image','second','request'].includes(p.unit)&&validMoney(p.retail_cny)).map(p=>({resolution:p.resolution,unit:p.unit,retail_cny:p.retail_cny}));
      return {id, name:publishedName(line.name,tool?(id==='tool-digital'?'数字人':'黑白深度视频'):`${line.kind==='image'?'图片':'视频'}线路`),
        type:line.kind, provider:tool?'tool':'generate', billing_mode:'relay',
        prices,currency:'CNY',...(Number.isSafeInteger(line.line_revision)&&line.line_revision>0?{line_revision:line.line_revision}:{}),...(validMoney(line.reference_surcharge_cny)?{reference_surcharge_cny:line.reference_surcharge_cny}:{}),
        ...(specs?{aspect_ratios:specs.ratios,size_options:specs.sizes,quality_options:specs.qualities,default_quality:specs.qualities.includes('auto')?'auto':specs.qualities[0]}:{}),
        resolutions, ratios:(Array.isArray(line.ratios)?line.ratios:[]).filter(value=>/^(?:\d{1,2}:\d{1,2}|auto)$/.test(value)),
        durations:(Array.isArray(line.durations)?line.durations:[]).filter(value=>Number.isFinite(value)&&value>0&&value<=120),
        max_images:countLimit(line.max_images), max_videos:countLimit(line.max_videos), max_audios:countLimit(line.max_audio),
        max_media_total:totalLimit(line),max_media_files:Math.min(totalLimit(line),countLimit(line.max_images)+countLimit(line.max_videos)+countLimit(line.max_audio)), concurrency_options:tool?[1]:[1,2,4]};
    });
    const toolIndex=kinds.indexOf('tool'),toolResult=results[toolIndex];
    const toolStates=Object.fromEntries(['digital','depth'].map(kind=>{
      const id='pikno-tool-'+kind;
      const state=toolIndex<0?'unconfigured':toolResult.status==='rejected'?(toolResult.reason.statusCode===403?'forbidden':'error')
        :!publicData.data.models.some(line=>line.id===id)?'unpublished':permitted.get('tool').has(id)?'ready':'forbidden';
      return [kind,state];
    }));
    return {data:models,toolStates, resolve:id=>lines.find(line=>aliasFor(line)===id)};
  }
  async function quote(cfg,line,payload) {
    const parameters=quoteParameters(line,payload);
    const response=await request(cfg,lineKeyKind(line),'/v1/client/quote',{method:'POST',readOnly:true,headers:{'Content-Type':'application/json'},body:JSON.stringify(parameters),timeout:20000});
    return validateRemoteQuote(response.data,parameters);
  }
  function submit(cfg,line,payload,confirmation) {
    const quoteHeaders=confirmation?{'X-PIKNO-Quote':confirmation.quote_id,'X-PIKNO-Quote-Index':String(confirmation.index)}:{};
    const images = Array.isArray(payload.images)?payload.images:[];
    const videos = Array.isArray(payload.videos)?payload.videos:[];
    const audios = Array.isArray(payload.audios)?payload.audios:[];
    if (images.length>countLimit(line.max_images) || videos.length>countLimit(line.max_videos) || audios.length>countLimit(line.max_audio)) throw fail('参考素材超过当前线路限制');
    if(images.length+videos.length+audios.length>totalLimit(line))throw fail('参考素材总数最多'+totalLimit(line)+'个');
    for (const item of [...images,...videos,...audios]) {
      const url = assetUrl(typeof item==='string'?item:item?.url);
      if (!url.searchParams.get('ticket') || [...url.searchParams.keys()].some(key=>key!=='ticket')) throw fail('请重新上传参考素材');
    }
    if (payload.reference && payload.reference!=='all' && payload.reference!=='omni') throw fail('此线路暂不支持当前参考方式，请选择全能参考');
    if (line.id.startsWith('pikno-tool-')) {
      if (!['pikno-tool-digital','pikno-tool-depth'].includes(line.id)) throw fail('当前工具线路无效');
      if (line.id==='pikno-tool-digital' ? images.length!==1 || videos.length!==0 || audios.length!==1 : images.length!==0 || videos.length!==1 || audios.length!==0) throw fail('请按当前工具要求上传完整素材');
      if ([...images,...videos,...audios].some(item=>!item||typeof item!=='object'||typeof item.url!=='string')) throw fail('请重新上传当前工具参考素材');
      if (line.id==='pikno-tool-digital' && (!Number.isFinite(audios[0]?.durationSeconds) || audios[0].durationSeconds<=0 || audios[0].durationSeconds>30)) throw fail('数字人音频时长须在 30 秒以内');
      return request(cfg,'tool','/v1/tools/'+(line.id==='pikno-tool-digital'?'digital':'depth'),{method:'POST',headers:{'Content-Type':'application/json',...quoteHeaders},body:JSON.stringify({model:line.id,images,videos,audios}),timeout:180000});
    }
    let body, route;
    if (line.kind==='video') {
      const seconds = Number(payload.duration);
      if (!line.durations?.includes(seconds) || !line.resolutions?.includes(payload.resolution) || !line.ratios?.includes(payload.ratio)) throw fail('生成规格不符合当前线路要求');
      body = {model:line.id,prompt:String(payload.prompt||''),seconds,resolution:payload.resolution,aspect_ratio:payload.ratio,image_urls:images,video_urls:videos,audio_urls:audios};
      route='/v1/videos';
    } else {
      if (videos.length || audios.length) throw fail('图片生成只能使用图片参考');
      const {sizes,qualities} = imageSpecs(line);
      const size = payload.size || sizes.find(value=>imageSizeRatio(value)===(payload.aspect_ratio||imageSizeRatio(sizes[0]||'auto')));
      if (!size || !sizes.includes(size)) throw fail('当前图片线路不支持此画面比例');
      if (payload.aspect_ratio && payload.aspect_ratio!==imageSizeRatio(size)) throw fail('图片尺寸与画面比例不匹配');
      const quality=payload.quality||(qualities.includes('auto')?'auto':qualities[0]);
      if (!qualities.includes(quality)) throw fail('当前图片线路不支持此画质');
      body = {model:line.id,prompt:String(payload.prompt||''),n:1,size,quality,response_format:'url',...(images.length?{images:images.map(item=>typeof item==='string'?item:item.url)}:{})};
      route='/v1/images/'+(images.length?'edits':'generations');
    }
    return request(cfg,line.kind,route,{method:'POST',headers:{'Content-Type':'application/json',...quoteHeaders},body:JSON.stringify(body),timeout:660000});
  }
  async function upload(cfg,data,{contentType,contentLength,kind}={}) {
    const mime = String(contentType||'').split(';')[0].trim().toLowerCase();
    const limit = /^(image\/(png|jpeg|webp))$/.test(mime)?30<<20:/^(video\/(mp4|webm|quicktime)|audio\/(mpeg|wav|mp4|aac))$/.test(mime)?50<<20:0;
    const length = Number(contentLength ?? data?.byteLength);
    if (!limit) throw fail('请使用 PNG、JPG、WEBP、MP4、MP3 或 WAV 素材',415);
    if (!Number.isSafeInteger(length) || length<12 || length>limit) throw fail('素材大小不符合要求',413);
    if (kind && !['image','video','tool'].includes(kind)) throw fail('素材授权类型无效');
    const keyKind = kind || (mime.startsWith('image/')&&configured(cfg,'image')?'image':configured(cfg,'video')?'video':'tool');
    const ticket = await request(cfg,keyKind,'/v1/media/uploads',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({content_type:mime,size:length})});
    const target = assetUrl(ticket.upload_url);
    if (target.search || ticket.method!=='PUT' || !ticket.upload_ticket || ticket.headers?.Authorization!=='Bearer '+ticket.upload_ticket || ticket.headers?.['Content-Type']!==mime || ticket.expires_at*1000<=Date.now()) throw fail('素材上传授权无效',502);
    let uploaded;
    try {
      uploaded=await fetchImpl(target.href,{method:'PUT',headers:{Authorization:'Bearer '+ticket.upload_ticket,'Content-Type':mime,'Content-Length':String(length)},body:data,...(!Buffer.isBuffer(data)?{duplex:'half'}:{}),redirect:'error',signal:AbortSignal.timeout(180000)});
    } catch { throw fail('素材上传未确认，请重新上传',503); }
    await uploaded.body?.cancel();
    if (!uploaded.ok) throw fail('素材上传失败，请重新上传',502);
    const ready = await request(cfg,keyKind,'/v1/media/complete',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({upload_ticket:ticket.upload_ticket})});
    const readUrl = assetUrl(ready.url);
    if (ready.status!=='ready' || ready.id!==ticket.id || readUrl.pathname!==target.pathname || !readUrl.searchParams.get('ticket') || ready.expires_at*1000<=Date.now()) throw fail('素材确认失败，请重新上传',502);
    return {file:{url:readUrl.href},url:readUrl.href,expires_at:ready.expires_at};
  }
  async function query(cfg,item){
    if(item.walletUser!=='pikno:'+cfg.piknoUserId)throw fail('请配置原任务所属 PIKNO 账户的 Key',401);
    const preferred=toolTask(item)?['tool','video','image']:item.type==='image'?['image']:['video','tool','image'];
    let denied;
    for(const kind of preferred.filter(kind=>configured(cfg,kind))){
      try{
        // Only independently verified, same-account keys are eligible. Each GET
        // remains authorized by the service; this path never creates a task.
        const identity=await context(cfg,kind);
        if(identity.user_id!==cfg.piknoUserId)throw fail('Key 账户不一致，请重新配置',409);
        return await request(cfg,kind,'/v1/videos/'+encodeURIComponent(item.id),{readOnly:true});
      }catch(error){if(![401,403].includes(error.statusCode))throw error;denied=error;}
    }
    throw denied||fail('请配置原任务所属账户的有效 Key',401);
  }
  return {request,context,catalog,quote,submit,upload,query,invalidate,
    configured};
}

module.exports = {DEFAULT_PIKNO_ENDPOINT,configured,createPiknoClient,quoteParameters,validateRemoteQuote,publishedName};
