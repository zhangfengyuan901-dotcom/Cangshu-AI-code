// Only published customer names and retail prices cross this transport.
// Private routing, costs and customer credentials never enter the catalogue.
const crypto = require('node:crypto');
const {createDirectMedia,localMediaID}=require('./direct-media.cjs');
const {bufferReferenceMedia,validateTosTicket,readPresignJSON}=require('./reference-media-upload.cjs');

const DEFAULT_PIKNO_ENDPOINT = 'https://www.piknoai.com';
const MEDIA_SUBMISSION_MARGIN_SECONDS = 60;
const keyFields = {image:'piknoImageKey', video:'piknoVideoKey', tool:'piknoToolKey',chat:'piknoChatKey'};
const lineKeyKind = line => ['pikno-tool-digital','pikno-tool-depth'].includes(line.id) ? 'tool' : line.kind;
const toolTask = item => ['digital','depth'].includes(item.source) || /^(?:pikno-)?tool-(?:digital|depth)$/.test(item.model || '');
const fail = (message, statusCode=400, ambiguous=false) => Object.assign(new Error(message), {statusCode, ambiguous});
const configured = (cfg, kind) => Boolean(String(cfg[keyFields[kind]] || '').trim());
const DOUBAO_CHAT_MODEL='doubao-seed-2.1-pro';
const DOUBAO_CHAT_PRICE='chat-doubao-seed-2-1-pro-cny-30-150-6-v1';
function validateChatActivation(value){
  const invalid=()=>{throw fail('对话服务状态暂时无法确认，请稍后重新检测',502);};
  if(!value||typeof value!=='object'||Array.isArray(value)||value.authorized!==true||typeof value.enabled!=='boolean'||typeof value.available!=='boolean'||typeof value.balance_sufficient!=='boolean'||value.model!=='pikno-chat-standard'||!/^chat-[a-z0-9-]{1,80}$/.test(value.price_version||''))return invalid();
  const pricing=value.pricing,limits=value.limits,capabilities=value.capabilities;
  if(value.billing_mode!=='actual_usage_v1'||value.billing?.allow_debt!==true||value.billing?.one_inflight_per_user!==true)return invalid();
  if(!pricing||pricing.currency!=='CNY'||!['input_cny_per_million','output_cny_per_million'].every(key=>Number.isFinite(pricing[key])&&pricing[key]>=0&&pricing[key]<=1e9))return invalid();
  const capabilityKeys=['text','image','pdf','video','files','tools','sse','verified'];
  if(!capabilities||!capabilityKeys.every(key=>typeof capabilities[key]==='boolean'))return invalid();
  const limitKeys=['max_output_tokens'];
  if(!limits||!limitKeys.every(key=>Number.isSafeInteger(limits[key])&&limits[key]>=0&&limits[key]<=1e12))return invalid();
  if(capabilities.files){
    for(const [name,maximum] of Object.entries({max_file_bytes:50*1024*1024,max_attachments:6,max_history_attachments:12})){
      if(!Number.isSafeInteger(limits[name])||limits[name]<1||limits[name]>maximum)return invalid();
      limitKeys.push(name);
    }
  }else if(capabilities.image||capabilities.pdf||capabilities.video)return invalid();
  if(value.available&&(!value.enabled||!capabilities.verified||!capabilities.text||!limits.max_output_tokens))return invalid();
  const matches = Array.isArray(value.models) ? value.models.filter(entry => entry?.model === DOUBAO_CHAT_MODEL) : [];
  const optional = matches.length === 1 ? matches[0] : undefined;
  const modelRates=optional?.pricing, modelCaps=optional?.capabilities, modelLimits=optional?.limits;
  const mediaLimits={max_file_bytes:50*1024*1024,max_attachments:6,max_history_attachments:12};
  const mediaAvailable=modelCaps?.files===true && modelCaps.image===true && modelCaps.video===true &&
    Object.entries(mediaLimits).every(([name,max])=>Number.isSafeInteger(modelLimits?.[name])&&modelLimits[name]>=1&&modelLimits[name]<=max);
  const textOnly=['image','video','files'].every(key=>modelCaps?.[key]===false);
  const models = optional?.model===DOUBAO_CHAT_MODEL && optional.price_version===DOUBAO_CHAT_PRICE && optional.available===true &&
    optional.billing_mode==='actual_usage_v1' && modelRates?.currency==='CNY' && modelRates.input_cny_per_million===30 && modelRates.output_cny_per_million===150 && modelRates.cached_input_cny_per_million===6 &&
    modelCaps?.text===true && modelCaps.sse===true && modelCaps.verified===true && modelCaps.pdf===false && modelCaps.tools===false && (mediaAvailable||textOnly) &&
    Number.isSafeInteger(modelLimits?.max_output_tokens) && modelLimits.max_output_tokens>=1 && modelLimits.max_output_tokens<=8000 ? [{model:DOUBAO_CHAT_MODEL,price_version:DOUBAO_CHAT_PRICE,available:true,billing_mode:'actual_usage_v1',
    pricing:{currency:'CNY',input_cny_per_million:30,output_cny_per_million:150,cached_input_cny_per_million:6},
    limits:{max_output_tokens:modelLimits.max_output_tokens,...(mediaAvailable?Object.fromEntries(Object.keys(mediaLimits).map(name=>[name,modelLimits[name]])):{})},
    capabilities:Object.fromEntries(capabilityKeys.map(key=>[key,modelCaps[key]]))}] : [];
  return {authorized:true,enabled:value.enabled,available:value.available,balance_sufficient:value.balance_sufficient,model:'pikno-chat-standard',price_version:value.price_version,
    billing_mode:'actual_usage_v1',billing:{allow_debt:true,one_inflight_per_user:true},
    pricing:{currency:'CNY',input_cny_per_million:pricing.input_cny_per_million,output_cny_per_million:pricing.output_cny_per_million},
    capabilities:Object.fromEntries(capabilityKeys.map(key=>[key,capabilities[key]])),limits:Object.fromEntries(limitKeys.map(key=>[key,limits[key]])),...(models.length?{models}:{})};
}
const aliasFor = line => line.id === 'pikno-tool-digital' ? 'tool-digital'
  : line.id === 'pikno-tool-depth' ? 'tool-depth'
  : `main-${line.kind}-${crypto.createHash('sha256').update(line.id).digest('hex').slice(0,16)}`;
// Per-kind and aggregate capabilities are independent published limits.
const countLimit = value => Number.isSafeInteger(value) && value >= 0 && value <= 1000 ? value : 0;
// Older catalogues omit this field and retain their transport limit of 20.
const totalLimit = line => line.max_media_total===undefined?20:countLimit(line.max_media_total);
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
function validateRemoteQuote(value,parameters,{checkBalance=false}={}) {
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
  if(checkBalance&&value.balance_checked!==true)throw fail('暂时无法核对可用余额，请稍后再试',503);
  return value;
}

function createPiknoClient({endpoint=DEFAULT_PIKNO_ENDPOINT, fetchImpl=fetch, uploadFetchImpl=fetchImpl,setTimer=setTimeout,clearTimer=clearTimeout,now=Date.now}={}) {
  const origin = new URL(endpoint);
  if (origin.username || origin.password || origin.search || origin.hash || origin.pathname !== '/' ||
      !(origin.protocol === 'https:' || origin.protocol === 'http:' && origin.hostname === '127.0.0.1')) throw fail('服务地址无效');
  const base = origin.origin;
  const directMedia=createDirectMedia({now});
  let cacheEpoch=0,accountEpoch=0,publicCache=null;
  const publicInflight=new Map(),readInflight=new Map(),readCache=new Map(),readCooldown=new Map(),verifiedAccounts=new Map();
  const invalidate=(catalogChange=false)=>{cacheEpoch++;if(!catalogChange)accountEpoch++;publicCache=null;publicInflight.clear();readInflight.clear();readCache.clear();if(!catalogChange)verifiedAccounts.clear();};
  // This public stream carries revisions only, never account keys or model data.
  const catalogListeners=new Set();
  let eventController=null,eventRetry=null,eventRevision=null,eventFailures=0,eventsStopped=false;
  const revisionValue=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value)?value:null;
  function catalogChanged(value){
    const revision=revisionValue(value);
    if(revision===null)return;
    eventFailures=0;
    if(revision===eventRevision)return;
    eventRevision=revision;invalidate(true);
    for(const listener of catalogListeners){try{listener({revision});}catch{}}
  }
  async function readCatalogEvents(controller){
    let watchdog;
    const armWatchdog=ms=>{clearTimeout(watchdog);watchdog=setTimeout(()=>controller.abort(),ms);watchdog.unref?.();};
    armWatchdog(20000);
    try{
      const response=await fetchImpl(base+'/api/pikno/catalog/events',{method:'GET',headers:{Accept:'text/event-stream'},credentials:'omit',redirect:'error',signal:controller.signal});
      if(!response.ok||!/^text\/event-stream(?:;|$)/i.test(response.headers.get('content-type')||'')||!response.body)throw Error('Catalog notification unavailable');
      armWatchdog(45000);
      const decoder=new TextDecoder();let buffer='',event='',data=[];
      for await(const chunk of response.body){
        if(controller.signal.aborted)return;
        armWatchdog(45000);buffer+=decoder.decode(chunk,{stream:true});
        if(buffer.length>32768)throw Error('Catalog notification too large');
        let end;
        while((end=buffer.indexOf('\n'))>=0){
          const line=buffer.slice(0,end).replace(/\r$/,'');buffer=buffer.slice(end+1);
          if(!line){
            if(event==='catalog-change'&&data.length){try{catalogChanged(JSON.parse(data.join('\n')).revision);}catch{}}
            event='';data=[];
          }else if(line.startsWith('event:'))event=line.slice(6).trim();
          else if(line.startsWith('data:')){data.push(line.slice(5).trimStart());if(data.join('\n').length>16384)throw Error('Catalog notification too large');}
        }
      }
    }finally{clearTimeout(watchdog);controller.abort();}
  }
  function startCatalogEvents(){
    if(eventsStopped||eventController||eventRetry||!catalogListeners.size)return;
    const controller=eventController=new AbortController();
    void readCatalogEvents(controller).catch(()=>{}).finally(()=>{
      if(eventController!==controller)return;
      eventController=null;
      if(!eventsStopped&&catalogListeners.size){
        const delay=Math.min(30000,1000*2**Math.min(eventFailures++,5));
        eventRetry=setTimer(()=>{eventRetry=null;startCatalogEvents();},delay);eventRetry?.unref?.();
      }
    });
  }
  function stopCatalogEvents(){
    if(eventRetry){clearTimer(eventRetry);eventRetry=null;}
    const controller=eventController;eventController=null;controller?.abort();
  }
  function subscribeCatalog(listener){
    if(typeof listener!=='function')throw TypeError('Catalog listener required');
    if(eventsStopped)return ()=>{};
    catalogListeners.add(listener);
    if(eventRevision!==null)listener({revision:eventRevision});
    startCatalogEvents();
    return ()=>{catalogListeners.delete(listener);if(!catalogListeners.size)stopCatalogEvents();};
  }
  function stop(){eventsStopped=true;catalogListeners.clear();stopCatalogEvents();invalidate();directMedia.close();}
  async function sharedRead(cfg,kind,route,{fresh=true,method,accountId}={}){
    const cacheKey=cacheEpoch+':'+kind+':'+route+':'+crypto.createHash('sha256').update(String(cfg[keyFields[kind]]||'')).digest('hex');
    const keyHash=crypto.createHash('sha256').update(String(cfg[keyFields[kind]]||'')).digest('hex');
    const user=accountId||cfg.piknoUserId||verifiedAccounts.get(keyHash);
    const scope=Number.isSafeInteger(user)&&user>0?'user:'+user:'key:'+keyHash;
    const until=readCooldown.get(scope)||0;
    if(until>now())throw Object.assign(fail('检测过于频繁，请等待后重试',429),{retryAfterMs:until-now(),retryMs:until-now()});
    const cached=readCache.get(cacheKey);
    // Only explicitly requested display reads may reuse this short-lived state.
    // Configuration verification and execution paths remain fresh by default.
    if(!fresh&&cached?.until>now())return cached.value;
    if(readInflight.has(cacheKey))return readInflight.get(cacheKey);
    const epoch=cacheEpoch,result=request(cfg,kind,route,{...(method?{method}:{}),readOnly:true,timeout:20000});readInflight.set(cacheKey,result);
    try{
      const value=await result;
      if(epoch===cacheEpoch){readCache.set(cacheKey,{value,until:now()+15000});if(readCache.size>64)readCache.delete(readCache.keys().next().value);}
      return value;
    }catch(error){
      if(error.statusCode===429){
        const retry=Number.isFinite(error.retryAfterMs)?Math.max(1000,Math.min(3600000,error.retryAfterMs)):60000;
        for(const [key,time] of readCooldown)if(time<=now())readCooldown.delete(key);
        readCooldown.set(scope,Math.max(readCooldown.get(scope)||0,now()+retry));
        if(readCooldown.size>128)readCooldown.delete(readCooldown.keys().next().value);
      }
      throw error;
    }finally{if(readInflight.get(cacheKey)===result)readInflight.delete(cacheKey);}
  }
  async function publicCatalog(fresh=false, options={}){
    if(!fresh&&publicCache&&publicCache.epoch===cacheEpoch&&publicCache.until>Date.now())return publicCache.data;
    const epoch=cacheEpoch;
    if(publicInflight.has(epoch))return publicInflight.get(epoch);
    const result=request({},'', '/api/pikno/catalog',{timeout:20000,...options,publicRequest:true,readOnly:true});publicInflight.set(epoch,result);
    try{const data=await result;if(epoch===cacheEpoch)publicCache={epoch,data,until:Date.now()+2000};return data;}
    finally{if(publicInflight.get(epoch)===result)publicInflight.delete(epoch);}
  }
  const assetUrl = value => {
    try {
      const url = new URL(value);
      if (url.origin !== base || url.username || url.password || url.hash ||
          !/^\/media\/v1\/(?:assets|tool-inputs)\/[a-f0-9]{32}$/.test(url.pathname)) throw fail('素材地址无效');
      return url;
    } catch { throw fail('素材地址无效'); }
  };
  function directToolReference(value,cfg,kind){
    const url=assetUrl(value),ticket=url.searchParams.get('ticket');
    if(!url.pathname.startsWith('/media/v1/tool-inputs/')||!ticket||ticket.length>8192||[...url.searchParams.keys()].some(key=>key!=='ticket'))throw fail('请重新上传当前工具素材');
    let claims;try{claims=JSON.parse(Buffer.from(ticket.split('.')[0],'base64url').toString('utf8'));}catch{throw fail('工具素材授权无效');}
    if(!claims||typeof claims!=='object'||Array.isArray(claims)||claims.v!==1||claims.aud!=='pikno-tool-input'||claims.uid!==cfg?.piknoUserId||claims.id!==url.pathname.split('/').at(-1)||typeof claims.mime!=='string'||!claims.mime.startsWith(kind+'/')||!Number.isSafeInteger(claims.exp)||claims.exp*1000<=now()+MEDIA_SUBMISSION_MARGIN_SECONDS*1000)throw fail('工具素材授权已失效，请重新选择当前账户的素材',409);
    return claims;
  }
  async function request(cfg, kind, route, {publicRequest=false, readOnly=false, timeout=60000, responseLimit, signal, ...options}={}) {
    if (!route.startsWith('/') || route.startsWith('//') || /[\\\r\n]/.test(route) || new URL(route,base).origin !== base) throw fail('服务请求无效');
    const key = String(cfg[keyFields[kind]] || '').trim();
    if (!publicRequest && !key) throw fail(kind==='image' ? '请先配置图片 Key' : kind==='tool' ? '请先配置工具 Key' :kind==='chat'?'请先配置对话 Key': '请先配置视频 Key',401);
    const headers = new Headers(options.headers);
    headers.delete('authorization'); headers.delete('x-api-key');
    if (!publicRequest) headers.set('Authorization', 'Bearer '+key);
    const toolUpload = route === '/v1/media/direct-uploads' && kind === 'tool';
    const readUnavailable = toolUpload ? '工具素材上传暂不可用，任务尚未提交。' : '报价暂时不可用，请稍后重新获取';
    let response;
    try {
      const deadline=AbortSignal.timeout(timeout);
      response = await fetchImpl(base+route, {...options, headers, redirect:'error', signal:signal?AbortSignal.any([signal,deadline]):deadline});
    } catch { throw fail(readOnly?(toolUpload?readUnavailable:'报价暂时无法连接，请稍后重新获取'):'仓鼠服务连接未确认，请核对任务记录，勿重复提交',503,!readOnly&&options.method==='POST'); }
    if (!response.ok) {
      const retryHeader=String(response.headers?.get?.('retry-after')||'').trim();
      const retryDelay=retryHeader.length<=128&&retryHeader?(/^\d+$/.test(retryHeader)?Number(retryHeader)*1000:Date.parse(retryHeader)-Date.now()):NaN;
      const retryMetadata=error=>{
        if(Number.isFinite(retryDelay)&&retryDelay>=0){error.retryAfterMs=Math.min(3600000,retryDelay);error.retryMs=error.retryAfterMs;}
        return error;
      };
      let structured;try{structured=await response.json();}catch{}
      const code=structured?.error?.code??structured?.code;
      if(quoteCodes.has(code)){
        const messages={quote_invalid:'报价无效，请重新获取并确认',quote_expired:'报价已过期，请重新获取并确认',quote_changed:'价格或线路已更新，请重新获取并确认',quote_parameters_changed:'生成参数已变化，请重新获取并确认',quote_already_submitted:'此报价已提交，请查询原任务，勿重复提交'};
        const error=fail(messages[code],response.status,!readOnly&&code==='quote_already_submitted');error.code=code;
        if(['pending','accepted'].includes(structured.error.submission_state))error.submissionState=structured.error.submission_state;
        if(/^[a-zA-Z0-9_-]{1,200}$/.test(structured.error.task_id||''))error.originalTaskId=structured.error.task_id;
        throw retryMetadata(error);
      }
      const imageUsage=headers.get('X-Pikno-Image-Billing')==='usage-v1';
      if(imageUsage&&response.status===409&&code==='image_already_submitted'){
        const error=fail('图片请求已提交或状态待核对，请保留原任务，勿重复提交',409,true);
        error.code=code;
        throw retryMetadata(error);
      }
      const insufficientBalance=response.status===402&&(code==='insufficient_balance'||!imageUsage&&headers.get('X-Pikno-Check-Balance')!=='1');
      const messages = {401:'Key 无效或已过期，请到 PIKNO 检查',402:insufficientBalance?'PIKNO 账户余额不足，请前往账户页充值':'服务返回费用限制，请检查账户或线路',403:'此 Key 没有当前功能权限',404:'此功能或线路尚未开放',429:'请求过于频繁，请稍后再试'};
      const error=fail(readOnly&&(response.status>=500||response.status===404)?readUnavailable:messages[response.status] || (response.status>=500?'服务响应未确认，请核对任务记录，勿重复提交':'请求参数无效，请检查当前线路要求'), response.status, !readOnly&&options.method==='POST' && (response.status>=500 || response.status===408));
      if(insufficientBalance)error.code='insufficient_balance';
      throw retryMetadata(error);
    }
    try {
      if(responseLimit){
        const reader=response.body?.getReader();if(!reader)throw Error('missing response');
        const chunks=[];let total=0;
        try{
          for(;;){const {done,value}=await reader.read();if(done)break;total+=value.byteLength;if(total>responseLimit){await reader.cancel();throw Error('oversized response');}chunks.push(Buffer.from(value));}
        }finally{reader.releaseLock();}
        return JSON.parse(Buffer.concat(chunks).toString('utf8'));
      }
      return await response.json();
    }
    catch { throw fail(readOnly?(toolUpload?readUnavailable:'报价暂时无法确认，请重新获取'):'服务结果未确认，请核对任务记录，勿重复提交',502,!readOnly&&options.method==='POST'); }
  }
  async function context(cfg, kind,options={}) {
    const epoch=accountEpoch,value = await sharedRead(cfg,kind,'/v1/client/context',options);
    if (!Number.isSafeInteger(value.user_id) || value.user_id < 1 || value.group !== kind+'-standard') throw fail('请使用对应类型的 PIKNO Key',403);
    if(epoch===accountEpoch){verifiedAccounts.set(crypto.createHash('sha256').update(String(cfg[keyFields[kind]]||'')).digest('hex'),value.user_id);if(verifiedAccounts.size>64)verifiedAccounts.delete(verifiedAccounts.keys().next().value);}
    return value;
  }
  async function activateChat(cfg,options={}){
    return validateChatActivation(await sharedRead(cfg,'chat','/assistant/v2/activate',{...options,method:'POST'}));
  }
  async function catalog(cfg,{fresh=false,retry=true}={}) {
    const epoch=cacheEpoch,account=accountEpoch;
    const kinds = ['image','video','tool'].filter(kind=>configured(cfg,kind));
    if (!kinds.length) throw fail('请先配置 PIKNO Key',401);
    const [publicData, results] = await Promise.all([
      publicCatalog(fresh),
      Promise.allSettled(kinds.map(kind=>sharedRead(cfg,kind,'/v1/models'))),
    ]);
    if(account!==accountEpoch)throw fail('账户配置已变更，请重新刷新',409);
    if(epoch!==cacheEpoch){if(retry)return catalog(cfg,{fresh:true,retry:false});throw fail('线路已更新，请重新刷新',409);}
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
        ...(line.kind==='image'&&line.image_billing==='usage-v1'?{image_billing:'usage-v1'}:{}),
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
    const parameters=quoteParameters(line,payload),checkBalance=payload.check_balance===true;
    const response=await request(cfg,lineKeyKind(line),'/v1/client/quote',{method:'POST',readOnly:true,headers:{'Content-Type':'application/json',...(checkBalance?{'X-Pikno-Check-Balance':'1'}:{})},body:JSON.stringify(parameters),timeout:20000});
    return validateRemoteQuote(response?.data,parameters,{checkBalance});
  }
  function validateReferences(line,payload,{cfg,revision}={}) {
    for (const field of ['images','videos','audios']) {
      for (const item of Array.isArray(payload[field])?payload[field]:[]) {
        const value=typeof item==='string'?item:item?.url;
        if(localMediaID(value)){
          if(line.kind!=='image'||lineKeyKind(line)==='tool')throw fail('此素材不适用于当前功能');
          directMedia.get(value,{user:cfg?.piknoUserId,revision});
          continue;
        }
        if(lineKeyKind(line)==='image')throw fail('请重新选择本地参考图片后生成',409);
        const url=assetUrl(value);
        if(lineKeyKind(line)==='tool'&&!url.pathname.includes('/tool-inputs/'))throw fail('请重新选择当前工具的原始素材',409);
        if(url.pathname.includes('/tool-inputs/')&&lineKeyKind(line)!=='tool')throw fail('此素材不适用于当前功能');
        if(url.pathname.includes('/tool-inputs/'))directToolReference(value,cfg,{images:'image',videos:'video',audios:'audio'}[field]);
        const ticket=url.searchParams.get('ticket');
        if(!ticket||[...url.searchParams.keys()].some(key=>key!=='ticket'))throw fail('请重新上传参考素材');
        // Expiry is only an early rejection hint. The relay still verifies the
        // signed ticket and ownership; decoding here never grants authority.
        let expires=item&&typeof item==='object'?item.expires_at:undefined;
        if(expires!==undefined&&(!Number.isSafeInteger(expires)||expires<=0))
          throw Object.assign(fail('参考素材已过期或即将到期，请重新上传'),{code:'media_reference_expired'});
        try {
          const claims=JSON.parse(Buffer.from(ticket.split('.')[0],'base64url').toString('utf8'));
          if(Number.isSafeInteger(claims.exp))expires=expires===undefined?claims.exp:Math.min(expires,claims.exp);
        } catch {}
        if(expires!==undefined&&(!Number.isSafeInteger(expires)||expires*1000<=now()+MEDIA_SUBMISSION_MARGIN_SECONDS*1000))
          throw Object.assign(fail('参考素材已过期或即将到期，请重新上传'),{code:'media_reference_expired'});
        if(line.provider==='canseedream'&&line.kind==='video'&&field!=='images'&&
          (!item||typeof item!=='object'||!Number.isFinite(item.durationSeconds)||item.durationSeconds<=0||item.durationSeconds>86400))
          throw Object.assign(fail('无法读取参考素材时长，请重新选择有效的视频或音频'),{code:'media_duration_required'});
      }
    }
  }
  function submit(cfg,line,payload,confirmation) {
    if(!configured(cfg,lineKeyKind(line)))throw fail('请先配置对应功能的 PIKNO Key',401);
    validateReferences(line,payload,{cfg,revision:confirmation?.revision});
    const quoteHeaders=confirmation?.quote_id?{'X-PIKNO-Quote':confirmation.quote_id,'X-PIKNO-Quote-Index':String(confirmation.index),...(confirmation.balanceChecked===true?{'X-Pikno-Check-Balance':'1'}:{})}:{};
    const clean=field=>(Array.isArray(payload[field])?payload[field]:[]).map(item=>{
      if(!item||typeof item!=='object')return item;
      const {expires_at,...reference}=item;return reference;
    });
    const images = clean('images');
    const videos = clean('videos');
    const audios = clean('audios');
    if (images.length>countLimit(line.max_images) || videos.length>countLimit(line.max_videos) || audios.length>countLimit(line.max_audio)) throw fail('参考素材超过当前线路限制');
    if(images.length+videos.length+audios.length>totalLimit(line))throw fail('参考素材总数最多'+totalLimit(line)+'个');
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
      quoteHeaders['X-Pikno-Media-Transport']='direct-v1';
      if(confirmation?.requestId){
        if(line.image_billing!=='usage-v1'||confirmation.quote_id||!/^[a-zA-Z0-9:_-]{8,140}:[0-3]$/.test(confirmation.requestId))throw fail('当前图片线路不可用，请刷新线路后重试',409);
        quoteHeaders['X-Pikno-Image-Billing']='usage-v1';
        quoteHeaders['Idempotency-Key']=confirmation.requestId;
      }
      if(images.length){
        const form=directMedia.multipart({model:line.id,prompt:String(payload.prompt||''),n:1,size,quality,output_format:'png'},images,{user:cfg.piknoUserId,revision:confirmation?.revision});
        return request(cfg,'image','/v1/images/edits',{method:'POST',...form,headers:{...form.headers,...quoteHeaders},timeout:660000,responseLimit:24<<20});
      }
      body = {model:line.id,prompt:String(payload.prompt||''),n:1,size,quality,output_format:'png'};
      route='/v1/images/'+(images.length?'edits':'generations');
    }
    return request(cfg,line.kind,route,{method:'POST',headers:{'Content-Type':'application/json',...quoteHeaders},body:JSON.stringify(body),timeout:660000,...(line.kind==='image'?{responseLimit:24<<20}:{})});
  }
  async function upload(cfg,data,{contentType,contentLength,kind,revision,directOnly=false,signal}={}) {
    const mime = String(contentType||'').split(';')[0].trim().toLowerCase();
    const limit = /^(image\/(png|jpeg|webp))$/.test(mime)?30<<20:/^(video\/(mp4|webm|quicktime)|audio\/(mpeg|wav|mp4|aac))$/.test(mime)?50<<20:0;
    const length = Number(contentLength ?? data?.byteLength);
    if (!limit) throw fail('请使用 PNG、JPG、WEBP、MP4、MP3 或 WAV 素材',415);
    if (!Number.isSafeInteger(length) || length<12 || length>limit) throw fail('素材大小不符合要求',413);
    if (kind && !['image','video','tool'].includes(kind)) throw fail('素材授权类型无效');
    const keyKind = kind || (mime.startsWith('image/')&&configured(cfg,'image')?'image':configured(cfg,'video')?'video':'tool');
    if(!configured(cfg,keyKind))throw fail('请先配置对应功能的 PIKNO Key',401);
    if(keyKind==='image')return directMedia.stage(data,{contentType:mime,contentLength:length,user:cfg.piknoUserId,revision});
    if(keyKind==='tool'){
      const ready=await request(cfg,'tool','/v1/media/direct-uploads',{method:'POST',readOnly:true,headers:{'Content-Type':mime,'Content-Length':String(length)},body:data,...(!Buffer.isBuffer(data)?{duplex:'half'}:{}),timeout:180000});
      const remote=assetUrl(ready.file?.url||ready.url),expires_at=ready.file?.expires_at??ready.expires_at;
      if(!remote.pathname.startsWith('/media/v1/tool-inputs/')||!remote.searchParams.get('ticket')||[...remote.searchParams.keys()].some(key=>key!=='ticket')||!Number.isSafeInteger(expires_at)||expires_at*1000<=now()+MEDIA_SUBMISSION_MARGIN_SECONDS*1000)throw fail('工具素材上传未确认，请重新选择',502);
      const claims=directToolReference(remote.href,cfg,mime.split('/')[0]);
      if(claims.mime!==mime||claims.size!==length||claims.exp!==expires_at)throw fail('工具素材上传未确认，请重新选择',502);
      return {file:{url:remote.href,expires_at},url:remote.href,expires_at};
    }
    function uploadError(stage,message,status=502){
      return Object.assign(fail(message,status),{code:'media_upload_'+stage});
    }
    async function mediaRequest(stage,route,payload,timeout=60000){
      try{
        return await request(cfg,keyKind,route,{method:'POST',timeout,signal,headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
      }catch(error){
        // These endpoints only issue a ticket or inspect an existing asset.
        if([401,429].includes(error.statusCode)||(stage==='ticket'&&error.statusCode===403))throw error;
        if(stage==='ticket'&&error.statusCode===415)throw uploadError(stage,'申请上传凭证失败，请检查视频 Key 的功能权限',415);
        throw uploadError(stage,stage==='ticket'?'未能取得素材上传凭证，请稍后重新选择素材':'未能确认素材已就绪，请稍后重新选择素材',error.statusCode);
      }
    }
    const timeout=ms=>signal?AbortSignal.any([signal,AbortSignal.timeout(ms)]):AbortSignal.timeout(ms);
    let prepared;
    try{prepared=await bufferReferenceMedia(data,length,mime,timeout(180000));data=prepared.bytes;}
    catch{throw uploadError('transfer','素材读取未完成，请重新选择素材');}
    const ticket = await mediaRequest('ticket','/v1/media/uploads',{content_type:mime,size:length});
    let target;
    try{target=assetUrl(ticket?.upload_url);}catch{throw uploadError('ticket','素材上传授权无效，请重新选择素材');}
    if (!/^[a-f0-9]{32}$/.test(ticket.id) || target.pathname!=='/media/v1/assets/'+ticket.id || target.search || ticket.method!=='PUT' || !ticket.upload_ticket || ticket.headers?.Authorization!=='Bearer '+ticket.upload_ticket || ticket.headers?.['Content-Type']!==mime || !Number.isSafeInteger(ticket.expires_at) || ticket.expires_at*1000<=Date.now()) throw uploadError('ticket','素材上传授权无效，请重新选择素材');
    let uploadHeaders={Authorization:'Bearer '+ticket.upload_ticket,'Content-Type':mime,'Content-Length':String(length)},tos=false;
    {
      let response;
      try{
        response=await fetchImpl(target.href+'/presign',{method:'POST',headers:{Authorization:'Bearer '+ticket.upload_ticket,'Content-Type':'application/json'},body:JSON.stringify({sha256:prepared.sha256}),redirect:'error',credentials:'omit',signal:timeout(8000)});
        if([404,405].includes(response.status)){try{await response.body?.cancel();}catch{}}
        else{
          if(!response.ok){try{await response.body?.cancel();}catch{};throw uploadError('ticket',response.status===429?'素材上传过于频繁，请稍后再试':'未能取得素材上传凭证，请稍后重新选择素材',response.status);}
          const signed=await readPresignJSON(response);
          if(signed?.id!==ticket.id)throw Error('Invalid presign response');
          const checked=validateTosTicket({...signed,upload_ticket:ticket.upload_ticket},{uid:cfg.piknoUserId,mime,length,sha256:prepared.sha256,ticketExpires:ticket.expires_at,now:now()});
          target=checked.target;uploadHeaders=checked.headers;tos=true;
        }
      }catch(error){if(error?.code==='media_upload_ticket')throw error;throw uploadError('ticket','未能取得素材上传凭证，请稍后重新选择素材');}
    }
    if(directOnly&&!tos)throw uploadError('ticket','当前对话素材直传暂不可用，请稍后重试',503);
    let uploaded,transferError;
    try {
      uploaded=await uploadFetchImpl(target.href,{method:'PUT',headers:uploadHeaders,body:data,...(!Buffer.isBuffer(data)?{duplex:'half'}:{}),redirect:'error',credentials:'omit',signal:timeout(180000)});
    } catch { transferError=uploadError('transfer','素材传输连接中断，请检查网络后重试',503); }
    // Releasing the unused response body must not turn a successful PUT into a
    // failed upload or suppress the original HTTP status.
    if(uploaded){
      try{await uploaded.body?.cancel();}catch{}
      if(!uploaded.ok){
        const status=uploaded.status, messages={400:'素材传输参数不匹配，请重新选择文件',401:'素材上传凭证未通过验证，请重新选择素材',403:'素材上传请求被拒绝，请重新选择素材或检查网络',413:'素材文件超过大小限制',415:'文件内容与所选格式不匹配，请检查文件格式',429:'素材上传过于频繁，请稍后再试'};
        transferError=uploadError('transfer',messages[status]||'素材传输失败，请稍后重试',status>=400&&status<=599?status:502);
        if(status!==408&&status!==409&&!(tos&&status===412)&&status<500)throw transferError;
      }
    }
    // The store may have accepted the only PUT before its acknowledgement was
    // lost. Confirm that exact ticket once; never send the file bytes again.
    let ready;
    signal?.throwIfAborted();
    try{
      ready=await mediaRequest('confirm','/v1/media/complete',{upload_ticket:ticket.upload_ticket},transferError?15000:60000);
    }catch(error){throw transferError||error;}
    let readUrl;
    try{readUrl=assetUrl(ready?.url);}catch{throw uploadError('confirm','素材确认结果无效，请重新选择素材');}
    if (ready.status!=='ready' || ready.id!==ticket.id || readUrl.pathname!=='/media/v1/assets/'+ticket.id || !readUrl.searchParams.get('ticket') || !Number.isSafeInteger(ready.expires_at) || ready.expires_at*1000<=Date.now()) throw uploadError('confirm','素材确认结果无效，请重新选择素材');
    return {file:{url:readUrl.href,expires_at:ready.expires_at},url:readUrl.href,expires_at:ready.expires_at};
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
  return {request,context,catalog,readLedgerCatalog:()=>publicCatalog(false,{timeout:3000,credentials:'omit'}),quote,validateReferences,submit,upload,query,invalidate,activateChat,subscribeCatalog,stop,
    configured};
}

module.exports = {DEFAULT_PIKNO_ENDPOINT,configured,createPiknoClient,quoteParameters,validateRemoteQuote,publishedName,validateChatActivation,DOUBAO_CHAT_MODEL,DOUBAO_CHAT_PRICE};
