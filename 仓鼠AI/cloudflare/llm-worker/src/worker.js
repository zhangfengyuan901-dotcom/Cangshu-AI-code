import { Buffer } from 'node:buffer';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const CLIENT_HEADER = 'hamster-desktop-v1';
const ACTIVATION_TTL_SECONDS = 24 * 60 * 60;
const MAIN_KEY_CHECK_URL = 'https://sanbaobeauty.com/openapi/v1/me';
const INFERENCE_ORIGIN = 'https://ark.cn-beijing.volces.com';
const MAX_JSON_BYTES = 2 * 1024 * 1024;

const json = (body, status = 200) => Response.json(body, { status, headers:{
  'cache-control':'no-store', 'x-content-type-options':'nosniff',
} });

function base64url(bytes) {
  let value = '';
  for (const byte of new Uint8Array(bytes)) value += String.fromCharCode(byte);
  return btoa(value).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function decode64url(value) {
  const padded = value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - value.length % 4) % 4);
  return Uint8Array.from(atob(padded), character => character.charCodeAt(0));
}

async function signingKey(env, usage) {
  if (!env.TOKEN_SIGNING_KEY) throw new Error('Missing signing secret');
  return crypto.subtle.importKey('raw', encoder.encode(env.TOKEN_SIGNING_KEY), {name:'HMAC',hash:'SHA-256'}, false, [usage]);
}

async function createToken(env, subject, piknoUserId=0) {
  const now=Math.floor(Date.now()/1000);
  const claims=piknoUserId?{v:2,aud:'hamster-pikno-inference',uid:piknoUserId,sub:subject,iat:now,exp:now+900}:{v:1,sub:subject,exp:now+ACTIVATION_TTL_SECONDS};
  const payload = base64url(encoder.encode(JSON.stringify(claims)));
  const signature = await crypto.subtle.sign('HMAC', await signingKey(env, 'sign'), encoder.encode(payload));
  return `${payload}.${base64url(signature)}`;
}

async function verifyToken(env, token) {
  const [payload, signature, extra] = String(token || '').split('.');
  if (!payload || !signature || extra || !/^[A-Za-z0-9_-]+$/.test(payload) || !/^[A-Za-z0-9_-]{43}$/.test(signature)) return null;
  const valid = await crypto.subtle.verify('HMAC', await signingKey(env, 'verify'), decode64url(signature), encoder.encode(payload));
  if (!valid) return null;
  try {
    const data = JSON.parse(decoder.decode(decode64url(payload)));
    const now=Math.floor(Date.now()/1000);
    if(!Number.isSafeInteger(data.exp)||data.exp<=now||!/^[a-f0-9]{64}$/.test(data.sub))return null;
    if(data.v===1)return data;
    return data.v===2&&data.aud==='hamster-pikno-inference'&&Number.isSafeInteger(data.uid)&&data.uid>0&&Number.isSafeInteger(data.iat)&&data.iat<=now+5&&data.exp-data.iat<=900&&data.exp>data.iat?data:null;
  } catch { return null; }
}

async function sha256(value) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', typeof value==='string'?encoder.encode(value):value))]
    .map(byte => byte.toString(16).padStart(2, '0')).join('');
}

// Paid inference has no reusable activation token. PIKNO authorizes one exact
// body for actual-usage settlement; this gateway can dispatch it only once.
const PAID_MODEL_ALIAS='pikno-chat-standard';
const PAID_ROUTE_POLICY='pikno-text-three-actual-usage-v2';
const PAID_BILLING_MODE='actual_usage_v1';
const ENDPOINT_LIMIT_CODES=new Set(['RateLimitExceeded.EndpointRPMExceeded','RateLimitExceeded.EndpointTPMExceeded']);
const SHARED_LIMIT_CODES=new Set(['ModelAccountRpmRateLimitExceeded','ModelAccountTpmRateLimitExceeded','APIAccountRpmRateLimitExceeded']);
const paidMode=env=>env.LLM_BILLING_MODE!=='legacy';
function notSubmitted(reason,status=503) {
  const response=json({error:{code:'llm_not_submitted',submission_state:'not_submitted',message:reason==='capability_unavailable'?'该对话能力暂未开放':'对话请求未发送，请检查服务配置'}},status);
  response.headers.set('x-pikno-submission-state','not_submitted');
  return response;
}
const unknownExecution=(status=503,diagnostic={phase:'execution_unknown'})=>{
  console.warn(JSON.stringify({tag:'llm_diagnostic_v1',format:1,status,...diagnostic}));
  return json({error:{code:'llm_execution_unknown',submission_state:'unknown',message:'对话执行状态待核对，请勿重复提交'}},status);
};
function rejectedBeforeExecution() {
  const response=json({error:{code:'llm_rejected_before_execution',submission_state:'rejected_before_execution',message:'对话请求在执行前被拒绝，请稍后重新确认'}},429);
  response.headers.set('x-pikno-execution-state','rejected_before_execution');
  return response;
}

function paidRoutes(env) {
  try {
    const routes=JSON.parse(env.PIKNO_LLM_ROUTES);
    if(!Array.isArray(routes)||routes.length!==3)return null;
    if(!routes.every((route,index)=>route&&typeof route==='object'&&!Array.isArray(route)&&
      Object.keys(route).length===2&&Object.hasOwn(route,'endpoint')&&Object.hasOwn(route,'version')&&
      typeof route.endpoint==='string'&&/^ep-[a-zA-Z0-9-]{5,100}$/.test(route.endpoint)&&route.version===(index<2?'260915':'260628'))||
      new Set(routes.map(route=>route.endpoint)).size!==3)return null;
    return routes;
  }catch{return null;}
}

async function executionTicket(request,env,bytes) {
  const token=(request.headers.get('authorization')||'').match(/^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43})$/)?.[1];
  if(!token||token.length>2048||typeof env.PIKNO_ASSISTANT_BRIDGE_SECRET!=='string'||env.PIKNO_ASSISTANT_BRIDGE_SECRET.length<32)return null;
  try {
    const [payload,signature]=token.split('.');
    const key=await crypto.subtle.importKey('raw',encoder.encode(env.PIKNO_ASSISTANT_BRIDGE_SECRET),{name:'HMAC',hash:'SHA-256'},false,['verify']);
    if(!await crypto.subtle.verify('HMAC',key,decode64url(signature),encoder.encode(payload)))return null;
    const c=JSON.parse(decoder.decode(decode64url(payload))),now=Math.floor(Date.now()/1000);
    if(c.v!==2||c.aud!=='pikno-llm-execute'||c.billing_mode!==PAID_BILLING_MODE||!Number.isSafeInteger(c.uid)||c.uid<1||
       !/^[a-f0-9]{32}$/.test(c.request_id)||c.jti!==c.request_id||!/^[a-f0-9]{64}$/.test(c.body_sha256)||
       c.model_alias!==PAID_MODEL_ALIAS||!Number.isSafeInteger(c.max_output_tokens)||c.max_output_tokens<1||c.max_output_tokens>65536||
       c.route_policy!==PAID_ROUTE_POLICY||Object.hasOwn(c,'input_token_bound')||
       !Number.isSafeInteger(c.iat)||c.iat>now+5||!Number.isSafeInteger(c.exp)||c.exp<=now||c.exp<=c.iat||c.exp-c.iat>60||
       c.body_sha256!==await sha256(bytes))return null;
    return c;
  }catch{return null;}
}

function textInput(input,mediaEnabled=false) {
  if(typeof input==='string')return input.length>0;
  if(!Array.isArray(input)||!input.length||input.length>200)return false;
  const allFiles=new Set();
  return input.every(message=>message&&typeof message==='object'&&!Array.isArray(message)&&
    Object.keys(message).every(key=>['role','content'].includes(key))&&['user','assistant','system','developer'].includes(message.role)&&
    (typeof message.content==='string'||Array.isArray(message.content)&&message.content.length>0&&message.content.length<=128&&(()=>{
      const files=new Set();
      return message.content.every(part=>{
        if(!part||typeof part!=='object'||Array.isArray(part)||Object.keys(part).length!==2)return false;
        if(part.type==='input_text')return typeof part.text==='string';
        if(!mediaEnabled||message.role!=='user'||!['input_image','input_video','input_file'].includes(part.type)||!PAID_FILE_HANDLE.test(part.file_id||''))return false;
        files.add(part.file_id);allFiles.add(part.file_id);
        return files.size<=6&&allFiles.size<=12;
      });
    })()));
}

const MAX_FILE_BYTES=50*1024*1024,MAX_FILE_WIRE_BYTES=MAX_FILE_BYTES+65536;
// A 50 MiB body occupies substantial isolate memory. Reject another upload
// before reading it; GET/DELETE and model requests use independent paths.
let paidUploadActive=false;
const PAID_FILE_HANDLE=/^hf1_([A-Za-z0-9_-]{16})_([A-Za-z0-9_-]{24,1779})$/;
const fileFailure=(status=400,code='llm_file_invalid')=>json({error:{code,message:'素材处理未完成，请核对素材或账户后重试',param:'file_id',submission_state:'not_submitted'}},status);
const paidFilesEnabled=env=>env.PIKNO_LLM_FILES_ENABLED==='true'&&env.LLM_BILLING_MODE===PAID_BILLING_MODE&&env.PIKNO_LLM_MODEL_VERIFIED==='true'&&
  typeof env.ARK_API_KEY==='string'&&Boolean(env.ARK_API_KEY.trim())&&typeof env.TOKEN_SIGNING_KEY==='string'&&env.TOKEN_SIGNING_KEY.length>=32&&Boolean(paidRoutes(env));

async function readBoundedBody(request,limit) {
  if(Number(request.headers.get('content-length')||0)>limit)throw Object.assign(new Error('Body too large'),{fileStatus:413});
  if(!request.body)return Buffer.alloc(0);
  const reader=request.body.getReader(),chunks=[];let size=0;
  try {
    while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>limit)throw Object.assign(new Error('Body too large'),{fileStatus:413});chunks.push(value);}
    return Buffer.concat(chunks,size);
  }finally{reader.cancel().catch(()=>{});}
}

async function fileTicket(request,env) {
  const token=(request.headers.get('authorization')||'').match(/^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43})$/)?.[1];
  if(!token||token.length>4096||typeof env.PIKNO_ASSISTANT_BRIDGE_SECRET!=='string'||env.PIKNO_ASSISTANT_BRIDGE_SECRET.length<32)return null;
  try {
    const [payload,signature]=token.split('.'),key=await crypto.subtle.importKey('raw',encoder.encode(env.PIKNO_ASSISTANT_BRIDGE_SECRET),{name:'HMAC',hash:'SHA-256'},false,['verify']);
    if(!await crypto.subtle.verify('HMAC',key,decode64url(signature),encoder.encode(payload)))return null;
    const c=JSON.parse(decoder.decode(decode64url(payload))),now=Math.floor(Date.now()/1000);
    if(c.v!==2||c.aud!=='pikno-llm-file'||!Number.isSafeInteger(c.uid)||c.uid<1||c.method!==request.method||c.path!==new URL(request.url).pathname||
      c.content_type!==(request.headers.get('content-type')||'')||!Number.isSafeInteger(c.iat)||c.iat>now+5||!Number.isSafeInteger(c.exp)||c.exp<=now||c.exp<=c.iat||c.exp-c.iat>60||
      typeof c.body_sha256!=='string'||!/^[a-f0-9]{64}$/.test(c.body_sha256))return null;
    return c;
  }catch{return null;}
}

async function paidFileKey(env) {
  const bytes=await crypto.subtle.digest('SHA-256',encoder.encode('hamster-paid-file-v1\0'+env.TOKEN_SIGNING_KEY));
  return crypto.subtle.importKey('raw',bytes,{name:'AES-GCM'},false,['encrypt','decrypt']);
}
async function wrapPaidFile(env,uid,kind,id,exp) {
  const iv=crypto.getRandomValues(new Uint8Array(12));
  const encrypted=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:encoder.encode('hamster-paid-file-v1')},await paidFileKey(env),encoder.encode(JSON.stringify({v:1,uid,kind,id,exp})));
  return 'hf1_'+base64url(iv)+'_'+base64url(encrypted);
}
async function unwrapPaidFile(env,uid,handle,kind) {
  const match=typeof handle==='string'&&PAID_FILE_HANDLE.exec(handle);
  if(!match)throw new Error('Invalid file handle');
  const data=JSON.parse(decoder.decode(await crypto.subtle.decrypt({name:'AES-GCM',iv:decode64url(match[1]),additionalData:encoder.encode('hamster-paid-file-v1')},await paidFileKey(env),decode64url(match[2]))));
  if(data.v!==1||!['image','video','file'].includes(data.kind)||kind&&data.kind!==kind||typeof data.id!=='string'||!/^[A-Za-z0-9_-]{1,512}$/.test(data.id)||!Number.isSafeInteger(data.exp)||data.exp<=Math.floor(Date.now()/1000))throw new Error('Invalid file handle');
  if(data.uid!==uid)throw Object.assign(new Error('Foreign file'),{fileStatus:403});
  return data;
}

// A MIME label and ftyp box alone also describe audio-only M4A containers.
// Inspect the bounded ISO BMFF hierarchy for an actual video track.
function hasVideoTrack(bytes) {
  const boxes=(start,end)=>{
    const result=[];
    while(start<end){
      if(end-start<8)throw new Error('Invalid container');
      let size=bytes.readUInt32BE(start),header=8;
      if(size===1){if(end-start<16)throw new Error('Invalid container');const wide=bytes.readBigUInt64BE(start+8);if(wide>BigInt(end-start))throw new Error('Invalid container');size=Number(wide);header=16;}
      else if(size===0)size=end-start;
      if(size<header||size>end-start||result.length>=4096)throw new Error('Invalid container');
      result.push({type:bytes.subarray(start+4,start+8).toString('ascii'),start:start+header,end:start+size});start+=size;
    }
    return result;
  };
  for(const movie of boxes(0,bytes.length).filter(box=>box.type==='moov'))
    for(const track of boxes(movie.start,movie.end).filter(box=>box.type==='trak'))
      for(const media of boxes(track.start,track.end).filter(box=>box.type==='mdia'))
        for(const handler of boxes(media.start,media.end).filter(box=>box.type==='hdlr'))
          if(handler.end-handler.start>=12&&bytes.subarray(handler.start+8,handler.start+12).toString('ascii')==='vide')return true;
  return false;
}

// Parse only the SDK's four-part form. File bytes remain a bounded view of the
// signed body, avoiding a second 50 MiB FormData allocation in the Worker.
function paidFileForm(bytes,contentType) {
  const match=/^multipart\/form-data;\s*boundary=(?:"([A-Za-z0-9'()+_,.\/:=?-]{1,70})"|([A-Za-z0-9'()+_,.\/:=?-]{1,70}))$/i.exec(contentType);
  if(!match)throw new Error('Invalid multipart');
  const boundary=match[1]||match[2],delimiter=Buffer.from('\r\n--'+boundary),opening=Buffer.from('--'+boundary+'\r\n'),fields=new Map();
  if(!bytes.subarray(0,opening.length).equals(opening))throw new Error('Invalid multipart');
  let offset=opening.length,closed=false,expiryBytes;
  while(offset<bytes.length){
    const endHeaders=bytes.indexOf('\r\n\r\n',offset);
    if(endHeaders<0||endHeaders-offset>4096||fields.size>=4)throw new Error('Invalid part');
    const headers=new Map();
    for(const line of bytes.subarray(offset,endHeaders).toString('utf8').split('\r\n')){
      const index=line.indexOf(':');if(index<1)throw new Error('Invalid header');
      const key=line.slice(0,index).toLowerCase(),value=line.slice(index+1).trim();
      if(!['content-disposition','content-type'].includes(key)||headers.has(key))throw new Error('Invalid header');headers.set(key,value);
    }
    const disposition=/^form-data;\s*name="([^"\r\n]{1,64})"(?:;\s*filename="([^"\r\n\\/]{1,180})")?$/.exec(headers.get('content-disposition')||'');
    if(!disposition||fields.has(disposition[1])||!['file','purpose','expire_at','preprocess_configs[video][fps]'].includes(disposition[1]))throw new Error('Invalid field');
    let end=bytes.indexOf(delimiter,endHeaders+4);
    while(end>=0){
      const after=end+delimiter.length,suffix=bytes.subarray(after,after+2).toString();
      if(suffix==='\r\n'||suffix==='--'&&(after+2===bytes.length||after+4===bytes.length&&bytes.subarray(after+2).toString()==='\r\n'))break;
      end=bytes.indexOf(delimiter,end+delimiter.length);
    }
    if(end<0)throw new Error('Invalid multipart');
    const value=bytes.subarray(endHeaders+4,end),name=disposition[1];
    if(name==='file'){
      if(!disposition[2]||!value.length||value.length>MAX_FILE_BYTES)throw Object.assign(new Error('Invalid file'),{fileStatus:value.length>MAX_FILE_BYTES?413:400});
      fields.set(name,{bytes:value,type:headers.get('content-type'),name:disposition[2]});
    }else{
      if(disposition[2]||headers.has('content-type')||value.length>32)throw new Error('Invalid field');fields.set(name,value.toString('utf8'));if(name==='expire_at')expiryBytes=value;
    }
    offset=end+delimiter.length;
    if(bytes.subarray(offset,offset+2).toString()==='--'){
      offset+=2;if(bytes.subarray(offset).toString()!=='\r\n'&&offset!==bytes.length)throw new Error('Invalid trailer');closed=true;break;
    }
    if(bytes.subarray(offset,offset+2).toString()!=='\r\n')throw new Error('Invalid separator');offset+=2;
  }
  const file=fields.get('file'),expiry=fields.get('expire_at'),now=Math.floor(Date.now()/1000);
  if(!closed||fields.get('purpose')!=='user_data'||!file||!/^\d{10,12}$/.test(expiry||'')||Number(expiry)<=now||Number(expiry)>now+3*86400+300)throw new Error('Invalid expiry or purpose');
  const b=file.bytes;
  let kind;
  if(file.type==='image/png'&&b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))&&/\.png$/i.test(file.name))kind='image';
  else if(file.type==='image/jpeg'&&b[0]===255&&b[1]===216&&b[2]===255&&/\.jpe?g$/i.test(file.name))kind='image';
  else if(file.type==='image/webp'&&b.subarray(0,4).toString()==='RIFF'&&b.subarray(8,12).toString()==='WEBP'&&/\.webp$/i.test(file.name))kind='image';
  else if(file.type==='application/pdf'&&b.subarray(0,5).toString()==='%PDF-'&&/\.pdf$/i.test(file.name))kind='file';
  else if(['video/mp4','video/quicktime'].includes(file.type)&&b.length>=16&&b.subarray(4,8).toString()==='ftyp'&&/\.(mp4|mov)$/i.test(file.name)&&hasVideoTrack(b))kind='video';
  if(!kind||kind==='video'&&fields.get('preprocess_configs[video][fps]')!=='2'||kind!=='video'&&fields.has('preprocess_configs[video][fps]'))throw new Error('Unsupported file');
  // The desktop clock can run a few seconds ahead of the signing server.
  // Only shorten the authenticated field in its original bounded buffer;
  // file bytes and multipart length stay unchanged, including at 50 MiB.
  const effectiveExpiry=Math.min(Number(expiry),now+3*86400-60);
  if(effectiveExpiry<Number(expiry))expiryBytes.write(String(effectiveExpiry).padStart(expiryBytes.length,'0'),0,expiryBytes.length,'ascii');
  return {kind,expiry:effectiveExpiry,bytes:b.length};
}

async function paidFileResponse(response,env,claims,handle,metadata,method) {
  if(method==='DELETE'&&response.status===204)return json({object:'file',id:handle,deleted:true});
  const bytes=await readBoundedBody(response,65536),data=JSON.parse(decoder.decode(bytes));
  if(!data||data.object!=='file'||typeof data.id!=='string'||!/^[A-Za-z0-9_-]{1,512}$/.test(data.id)||metadata.id&&data.id!==metadata.id)throw new Error('Invalid file response');
  if(method==='DELETE'){
    if(data.deleted!==true)throw new Error('Invalid deletion');return json({object:'file',id:handle,deleted:true});
  }
  const now=Math.floor(Date.now()/1000),expiry=Math.min(metadata.expiry??metadata.exp,data.expire_at);
  if(data.purpose!=='user_data'||!['processing','active','failed'].includes(data.status)||!Number.isSafeInteger(data.created_at)||data.created_at<0||data.created_at>now+5||
    !Number.isSafeInteger(data.expire_at)||!Number.isSafeInteger(expiry)||expiry<=now||!Number.isSafeInteger(data.bytes)||data.bytes<1||data.bytes>MAX_FILE_BYTES||metadata.bytes&&data.bytes!==metadata.bytes)throw new Error('Invalid file metadata');
  const id=handle||await wrapPaidFile(env,claims.uid,metadata.kind,data.id,expiry);
  return json({object:'file',id,status:data.status,bytes:data.bytes,created_at:data.created_at,expire_at:expiry,purpose:'user_data',filename:'attachment',
    ...(data.status==='failed'?{error:{code:'file_processing_failed',message:'素材解析失败，请检查文件格式。'}}:{})});
}

async function filesPikno(request,env) {
  if(!paidFilesEnabled(env))return fileFailure(503,'llm_capability_unavailable');
  const url=new URL(request.url),isUpload=request.method==='POST'&&url.pathname==='/internal/pikno/files';
  if(url.search||!isUpload&&(!['GET','DELETE'].includes(request.method)||!PAID_FILE_HANDLE.test(url.pathname.slice('/internal/pikno/files/'.length))))return fileFailure(400);
  let bytes,claims,metadata,handle;
  claims=await fileTicket(request,env);if(!claims)return fileFailure(401,'llm_file_auth_required');
  if(isUpload){if(paidUploadActive)return fileFailure(429,'llm_file_busy');paidUploadActive=true;}
  try{
  try{bytes=await readBoundedBody(request,isUpload?MAX_FILE_WIRE_BYTES:0);}catch(error){return fileFailure(error.fileStatus||400);}
  if(claims.body_sha256!==await sha256(bytes))return fileFailure(401,'llm_file_auth_required');
  try{
    if(isUpload)metadata=paidFileForm(bytes,request.headers.get('content-type')||'');
    else{
      if(request.headers.get('content-type'))return fileFailure(400);
      handle=url.pathname.slice('/internal/pikno/files/'.length);metadata=await unwrapPaidFile(env,claims.uid,handle);
    }
  }catch(error){return fileFailure(error.fileStatus||400);}
  if(request.signal.aborted||Math.floor(Date.now()/1000)>=claims.exp)return fileFailure(401,'llm_file_auth_required');
  try{
    const headers={authorization:'Bearer '+env.ARK_API_KEY,...(isUpload?{'content-type':request.headers.get('content-type')}:{} )};
    const response=await fetch(INFERENCE_ORIGIN+'/api/v3/files'+(isUpload?'':'/'+encodeURIComponent(metadata.id)),{method:request.method,headers,redirect:'manual',
      signal:AbortSignal.any([request.signal,AbortSignal.timeout(60000)]),...(isUpload?{body:bytes}:{} )});
    if(!response.ok){if(response.body)await response.body.cancel().catch(()=>{});return fileFailure([400,401,403,404,413,429].includes(response.status)?response.status:502,'llm_file_operation_failed');}
    return await paidFileResponse(response,env,claims,handle,metadata,request.method);
  }catch{return fileFailure(502,'llm_file_operation_failed');}
  }finally{if(isUpload)paidUploadActive=false;}
}

async function resolvePaidFiles(input,env,uid) {
  if(!Array.isArray(input))return {input};
  const resolved=new Map();let expiry;
  const messages=await Promise.all(input.map(async message=>({...message,content:Array.isArray(message.content)?await Promise.all(message.content.map(async part=>{
    if(part.type==='input_text')return part;
    const kind=part.type.slice(6),key=kind+':'+part.file_id;
    if(!resolved.has(key))resolved.set(key,unwrapPaidFile(env,uid,part.file_id,kind));
    const file=await resolved.get(key);expiry=Math.min(expiry??file.exp,file.exp);
    return {...part,file_id:file.id};
  })):message.content})));
  // Bound the response lifetime by authenticated file metadata, with a safety margin.
  return {input:messages,...(expiry===undefined?{}:{expire_at:expiry-60})};
}

// Keep only the text Responses protocol, not arbitrary provider metadata,
// headers, raw error bodies or URLs. Token usage values are copied, not added or
// re-estimated: reasoning_tokens is already part of output_tokens.
const PAID_RESPONSE_FIELDS=new Set(['type','id','object','created_at','model','status','output','usage','input_tokens','output_tokens','total_tokens',
  'input_tokens_details','output_tokens_details','cached_tokens','reasoning_tokens','role','content','text','delta','summary',
  'sequence_number','output_index','content_index','summary_index','item_id','response_id','part','item','response',
  'max_output_tokens','incomplete_details','reason','error']);
async function paidPublicValue(value,env,claims) {
  if(Array.isArray(value))return Promise.all(value.map(item=>paidPublicValue(item,env,claims)));
  if(typeof value==='string') {
    for(const secret of [env.ARK_API_KEY,env.PIKNO_LLM_PRIMARY_ENDPOINT,...endpoints(env),...(paidRoutes(env)||[]).map(route=>route.endpoint),INFERENCE_ORIGIN])if(typeof secret==='string'&&secret)value=value.split(secret).join(PAID_MODEL_ALIAS);
    return value.replace(/ep-[a-zA-Z0-9-]{5,100}/g,PAID_MODEL_ALIAS);
  }
  if(!value||typeof value!=='object')return value;
  const result={};
  for(const [key,item] of Object.entries(value)) {
    if(!PAID_RESPONSE_FIELDS.has(key))continue;
    if(key==='model')result[key]=PAID_MODEL_ALIAS;
    else if(key==='reason')result[key]=['max_output_tokens','content_filter','max_tool_calls'].includes(item)?item:'unknown';
    else if(key==='error'&&item)result[key]={code:'llm_execution_unknown',message:'对话执行状态待核对'};
    else if((key==='item_id'||key==='id')&&typeof item==='string'&&value.object!=='response')result[key]='hi1_'+await sha256(`pikno:${claims.uid}\0${item}`);
    else result[key]=await paidPublicValue(item,env,claims);
  }
  return result;
}
async function paidResponse(response,env,claims) {
  const headers=new Headers({'content-type':/event-stream/i.test(response.headers.get('content-type')||'')?'text/event-stream; charset=utf-8':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'});
  const protect=async value=>protectReferences(await paidPublicValue(value,env,claims),env,{v:2,uid:claims.uid},'');
  if(/event-stream/i.test(headers.get('content-type'))) {
    let carry='';
    const line=async value=>{
      if(value.startsWith('event:'))return /^event: response\.[a-z_.]+\r?$/.test(value)?value:'';
      if(!value.startsWith('data:'))return '';
      const data=value.slice(5).trim();
      if(!data||data==='[DONE]')return 'data: '+data;
      return 'data: '+JSON.stringify(await protect(JSON.parse(data)));
    };
    const body=response.body.pipeThrough(new TextDecoderStream()).pipeThrough(new TransformStream({
      async transform(chunk,controller){
        const lines=(carry+chunk).split('\n');carry=lines.pop()||'';
        for(const value of lines){if(value.length>MAX_JSON_BYTES)throw new Error('Invalid response event');controller.enqueue(await line(value)+'\n');}
        if(carry.length>MAX_JSON_BYTES)throw new Error('Invalid response event');
      },
      async flush(controller){if(carry)controller.enqueue(await line(carry));},
    })).pipeThrough(new TextEncoderStream());
    return new Response(body,{status:response.status,headers});
  }
  const bytes=await response.arrayBuffer();
  if(bytes.byteLength>MAX_JSON_BYTES)return unknownExecution();
  return new Response(JSON.stringify(await protect(JSON.parse(decoder.decode(bytes)))),{status:response.status,headers});
}

// Fixed categories only: never log upstream text, IDs, endpoints or credentials.
async function paidRejectionDiagnostic(response) {
  const result={phase:'upstream_rejected',code:'other',field:'other',body:'unavailable'};
  if(response.bodyUsed||response.body?.locked||!response.body||!/^application\/json(?:;|$)/i.test(response.headers.get('content-type')||''))return result;
  const reader=response.body.getReader(),chunks=[];let size=0,timer;
  try{
    const read=async()=>{while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>16384)throw new Error('bounded');chunks.push(value);}return JSON.parse(Buffer.concat(chunks,size).toString('utf8'));};
    const data=await Promise.race([read(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('deadline')),500);})]);
    result.body='parsed';const error=data?.error;
    const codes=['InvalidParameter','InvalidParameter.InvalidValue','InvalidParameter.UnsupportedParameter','InvalidParameter.MissingParameter','InvalidEndpointOrModel.NotFound','InvalidApiKey','AuthenticationError','AccessDenied','InternalServiceError','QuotaExceeded','ResourceNotFound','InvalidRequest','BadRequest'];
    if(codes.includes(error?.code))result.code=error.code;
    const text=typeof error?.message==='string'?error.message.toLowerCase():'';
    const fields=['file_id','image_url','video_url','max_output_tokens','service_tier','store','instructions','input','model'];
    result.field=fields.find(field=>error?.param===field||text.includes(field))||'other';
    result.flags=['image','video','file','expired','permission','unsupported','invalid','size','not found'].filter(word=>text.includes(word));
    const reasons={
      not_valid:/not valid/,not_exist:/(?:not exist|doesn.t exist|non.existent)/,not_active:/not active/,
      not_supported:/(?:not support|doesn.t support)/,project:/project/,type:/\btype\b/,
      format:/format/,status:/status|state/,processing:/processing|inprogress|pending/,
      access:/access|authoriz|permission/,expired:/expir/,deleted:/delet/,
      mismatch:/mismatch|does not match|inconsistent/,missing:/missing|not provided/,
      required:/required|must |should /,empty:/empty/,limit:/limit|maximum|too many|too large/,
      model:/model/,purpose:/purpose/,parse:/parse|unmarshal|marshal|syntax/,
      opaque_handle:/hf1_/,upstream_id:/file-/,
    };
    result.reasons=Object.keys(reasons).filter(key=>reasons[key].test(text));
  }catch{result.body='unreadable';}
  finally{clearTimeout(timer);reader.cancel().catch(()=>{});}
  return result;
}

async function executePikno(request,env) {
  const routes=paidRoutes(env);
  if(env.LLM_BILLING_MODE!==PAID_BILLING_MODE||env.PIKNO_LLM_MODEL_VERIFIED!=='true'||
    typeof env.ARK_API_KEY!=='string'||!env.ARK_API_KEY.trim()||
    typeof env.TOKEN_SIGNING_KEY!=='string'||env.TOKEN_SIGNING_KEY.length<32||
    !routes||
    !env.LLM_EXECUTIONS?.idFromName||!env.LLM_EXECUTIONS?.get)return notSubmitted('service_disabled');
  if(request.headers.get('content-type')?.split(';')[0].trim()!=='application/json')return notSubmitted('invalid_request',400);
  if(Number(request.headers.get('content-length')||0)>MAX_JSON_BYTES)return notSubmitted('request_too_large',413);
  let bytes;
  try{bytes=await request.arrayBuffer();}catch{return notSubmitted('invalid_request',400);}
  if(bytes.byteLength>MAX_JSON_BYTES)return notSubmitted('request_too_large',413);
  const claims=await executionTicket(request,env,bytes);
  if(!claims)return notSubmitted('invalid_ticket',401);
  let payload;
  try{payload=JSON.parse(decoder.decode(bytes));}catch{return notSubmitted('invalid_request',400);}
  if(!payload||typeof payload!=='object'||Array.isArray(payload)||
    Object.keys(payload).some(key=>!['model','input','instructions','max_output_tokens','stream'].includes(key))||
    payload.model!==PAID_MODEL_ALIAS||payload.max_output_tokens!==claims.max_output_tokens||!textInput(payload.input,paidFilesEnabled(env))||
    Object.hasOwn(payload,'instructions')&&typeof payload.instructions!=='string'||Object.hasOwn(payload,'stream')&&typeof payload.stream!=='boolean')
    return notSubmitted('capability_unavailable',400);
  try{
    Object.assign(payload,await resolvePaidFiles(payload.input,env,claims.uid));
    // The derived expiry must remain valid throughout the signed submission window.
    if(payload.expire_at!==undefined&&payload.expire_at<=claims.exp)return notSubmitted('capability_unavailable',400);
  }catch(error){return notSubmitted('capability_unavailable',error.fileStatus||400);}
  // Keep the v1 object identity and permanent marker. Only this in-memory owner
  // can advance the journal; a restarted Worker must not resume an old attempt.
  let guard,owner;
  const live=()=>!request.signal.aborted&&Date.now()<claims.exp*1000;
  const transition=async(path,slot,outcome)=>{
    const response=await guard.fetch(new Request('https://execution.internal/'+path,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+owner},
      body:JSON.stringify({route_policy:PAID_ROUTE_POLICY,slot,...(outcome?{outcome}:{})})}));
    return response.ok&&(await response.json()).ack===true;
  };
  try {
    const id=env.LLM_EXECUTIONS.idFromName(await sha256(`pikno-llm-execute-v1\0${claims.uid}\0${claims.request_id}`));
    guard=env.LLM_EXECUTIONS.get(id);
    const claim=await guard.fetch(new Request('https://execution.internal/claim',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({route_policy:PAID_ROUTE_POLICY})}));
    if(claim.status===409)return unknownExecution(409);
    const result=await claim.json();owner=result.owner;
    if(!claim.ok||result.claimed!==true||typeof owner!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(owner))return unknownExecution();
  }catch{return unknownExecution(503,{phase:'guard_claim_failed'});}
  let phase='guard_transition';
  try {
    for(let slot=0;slot<routes.length;slot++) {
      if(!live())return await transition('stop',slot)?rejectedBeforeExecution():unknownExecution();
      // Keep the configured older route without silently downgrading history.
      // Actual-usage billing no longer asserts a pre-inference token bound;
      // only the two same-version routes are eligible under this policy.
      if(slot===2) {
        if(!await transition('skip',slot))return unknownExecution();
        continue;
      }
      if(!await transition('intent',slot))return unknownExecution();
      if(!live())return await transition('abandon',slot)?rejectedBeforeExecution():unknownExecution();
      phase='upstream_fetch';
      const response=await fetch(INFERENCE_ORIGIN+'/api/v3/responses',{
        method:'POST',redirect:'manual',signal:request.signal,headers:{'content-type':'application/json',authorization:`Bearer ${env.ARK_API_KEY}`},
        body:JSON.stringify({...payload,model:routes[slot].endpoint,store:false,service_tier:'default'}),
      });
      if(response.ok) {
        phase='accepted_response';
        // Accepted headers permanently close failover, even if storage or the
        // later JSON/SSE stream fails. Never retry a partially consumed stream.
        let accepted=false;
        try{accepted=await transition('accepted',slot);}catch{}
        if(!accepted){if(response.body)await response.body.cancel().catch(()=>{});return unknownExecution();}
        return await paidResponse(response,env,claims);
      }
      phase='upstream_rejection';
      const rejection=await rateLimitRejection(response,request.signal,claims.exp*1000);
      if(!rejection){const diagnostic=await paidRejectionDiagnostic(response);if(response.body&&!response.body.locked)await response.body.cancel().catch(()=>{});return unknownExecution(response.status,diagnostic);}
      phase='guard_transition';
      if(!await transition('rejected',slot,rejection))return unknownExecution();
      if(rejection==='shared_limit')return rejectedBeforeExecution();
    }
    return await transition('finish',routes.length)?rejectedBeforeExecution():unknownExecution();
  }catch{return unknownExecution(503,{phase});}
}

// Only native, complete pre-execution RPM/TPM errors can justify another POST.
// Unknown fields, duplicate keys or acceptance/usage evidence fail closed.
async function rateLimitRejection(response,signal,deadline) {
  if(response.status!==429||response.headers.get('content-type')?.split(';')[0].trim().toLowerCase()!=='application/json'||
    Number(response.headers.get('content-length')||0)>16384||!response.body)return null;
  const reader=response.body.getReader(),chunks=[];let size=0,timer,abort;
  const stopped=new Promise((_,reject)=>{
    const fail=()=>reject(new Error('Rejection unavailable'));
    timer=setTimeout(fail,Math.max(0,deadline-Date.now()));abort=fail;
    signal.addEventListener('abort',abort,{once:true});if(signal.aborted)fail();
  });
  try {
    while(true) {
      const {done,value}=await Promise.race([reader.read(),stopped]);if(done)break;
      size+=value.byteLength;if(size>16384)return null;chunks.push(value);
    }
    const bytes=new Uint8Array(size);let offset=0;
    for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
    const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes),body=JSON.parse(text),error=body?.error;
    const keys=[...text.matchAll(/"((?:\\.|[^"\\])*)"\s*:/g)].map(match=>match[1]);
    if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).length!==1||!error||typeof error!=='object'||Array.isArray(error)||
      Object.keys(error).some(key=>!['code','type','message','param'].includes(key))||error.type!=='TooManyRequests'||typeof error.code!=='string'||
      Object.hasOwn(error,'message')&&typeof error.message!=='string'||Object.hasOwn(error,'param')&&error.param!==null&&typeof error.param!=='string'||
      keys.some(key=>!['error','code','type','message','param'].includes(key))||new Set(keys).size!==keys.length)return null;
    if(ENDPOINT_LIMIT_CODES.has(error.code))return 'endpoint_limit';
    return SHARED_LIMIT_CODES.has(error.code)?'shared_limit':null;
  }catch{return null;}
  finally{clearTimeout(timer);signal.removeEventListener('abort',abort);reader.cancel().catch(()=>{});}
}

// Store only policy/slot/state metadata and a capability digest. Existing v1
// markers remain permanent tombstones; no body, endpoint, uid or Key is stored.
export class LlmExecutionGuard {
  constructor(state){this.state=state;}
  async fetch(request){
    const path=new URL(request.url).pathname;
    if(request.method!=='POST'||!['/claim','/intent','/skip','/stop','/abandon','/rejected','/accepted','/finish'].includes(path))return new Response('Not Found',{status:404});
    let body;
    try{const text=await request.text();if(text.length>1024)return json({ack:false},400);body=JSON.parse(text);}catch{return json({ack:false},400);}
    if(!body||typeof body!=='object'||Array.isArray(body)||body.route_policy!==PAID_ROUTE_POLICY)return json({ack:false},400);
    const policy=await sha256(PAID_ROUTE_POLICY);
    const owner=path==='/claim'?base64url(crypto.getRandomValues(new Uint8Array(32))):(request.headers.get('authorization')||'').match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];
    if(!owner)return json({ack:false},403);
    const ownerHash=await sha256(owner);
    const ack=await this.state.storage.transaction(async txn=>{
      let state=await txn.get('dispatched');
      if(path==='/claim') {
        if(state)return false;
        state={v:2,policy_sha256:policy,owner_sha256:ownerHash,next:0,state:'ready',attempts:[]};
      }else {
        if(!state||state.v!==2||state.policy_sha256!==policy||state.owner_sha256!==ownerHash||body.slot!==state.next)return false;
        state=structuredClone(state);
        if(path==='/intent'&&state.state==='ready'&&state.next<3) {
          state.attempts.push({slot:state.next,state:'intent'});state.state='intent';
        }else if(path==='/skip'&&state.state==='ready'&&state.next<3) {
          state.attempts.push({slot:state.next,state:'skipped'});state.next++;
        }else if(path==='/stop'&&state.state==='ready')state.state='rejected';
        else if(path==='/finish'&&state.state==='ready'&&state.next===3)state.state='rejected';
        else if(['/accepted','/abandon','/rejected'].includes(path)&&state.state==='intent') {
          const attempt=state.attempts.at(-1);
          if(!attempt||attempt.slot!==state.next||attempt.state!=='intent')return false;
          if(path==='/rejected') {
            if(!['endpoint_limit','shared_limit'].includes(body.outcome))return false;
            attempt.state=body.outcome;state.state=body.outcome==='shared_limit'?'rejected':'ready';state.next++;
          }else{attempt.state=path==='/accepted'?'accepted':'not_sent';state.state=path==='/accepted'?'accepted':'rejected';}
        }else return false;
      }
      await txn.put('dispatched',state);return true;
    });
    return path==='/claim'?json(ack?{claimed:true,owner}:{claimed:false},ack?200:409):json({ack},ack?200:409);
  }
}

// PIKNO validates customer credentials, revocation and scope. Only this signed
// server delegation can create the new short-lived inference session; no Key
// or independent wallet lookup reaches this handler.
async function activatePikno(request,env){
  if(typeof env.PIKNO_ASSISTANT_BRIDGE_SECRET!=='string'||env.PIKNO_ASSISTANT_BRIDGE_SECRET.length<32||
     typeof env.TOKEN_SIGNING_KEY!=='string'||env.TOKEN_SIGNING_KEY.length<32||
     typeof env.ARK_API_KEY!=='string'||!env.ARK_API_KEY.trim()||!endpoints(env).length)return json({error:'activation_unavailable'},503);
  const token=(request.headers.get('authorization')||'').replace(/^Bearer /,'');
  const [payload,signature,extra]=token.split('.');
  if(!payload||!signature||extra||token.length>2048||!/^[A-Za-z0-9_-]+$/.test(payload)||!/^[A-Za-z0-9_-]{43}$/.test(signature))return json({error:'activation_failed'},401);
  try{
    const key=await crypto.subtle.importKey('raw',encoder.encode(env.PIKNO_ASSISTANT_BRIDGE_SECRET),{name:'HMAC',hash:'SHA-256'},false,['verify']);
    if(!await crypto.subtle.verify('HMAC',key,decode64url(signature),encoder.encode(payload)))return json({error:'activation_failed'},401);
    const claims=JSON.parse(decoder.decode(decode64url(payload))),now=Math.floor(Date.now()/1000);
    if(claims.v!==1||claims.aud!=='hamster-pikno-activation'||!Number.isSafeInteger(claims.uid)||claims.uid<1||!/^[a-f0-9]{64}$/.test(claims.sub)||!Number.isSafeInteger(claims.iat)||claims.iat>now+5||!Number.isSafeInteger(claims.exp)||claims.exp<=now||claims.exp-claims.iat>60||claims.exp<=claims.iat)return json({error:'activation_failed'},401);
    return json({token:await createToken(env,claims.sub,claims.uid),expiresAt:new Date((now+900)*1000).toISOString()});
  }catch{return json({error:'activation_failed'},401);}
}

async function validateMainKey(key, fetchImpl = fetch) {
  const response = await fetchImpl(MAIN_KEY_CHECK_URL, {
    headers:{Authorization:`Bearer ${key}`,'X-API-Key':key,Accept:'application/json'},
    signal:AbortSignal.timeout(15_000),
  });
  if (response.body) await response.body.cancel().catch(() => {});
  return response.ok;
}

async function activate(request, env) {
  if (request.headers.get('x-hamster-client') !== CLIENT_HEADER) return json({error:'unauthorized_client'}, 401);
  const match = (request.headers.get('authorization') || '').match(/^Bearer\s+(.+)$/i);
  const mainKey = match?.[1]?.trim() || '';
  if (!mainKey || mainKey.length > 500) return json({error:'activation_failed'}, 401);
  let valid = false;
  try {
    if(/^ha_[a-f0-9]{64}$/.test(mainKey)){
      if(!env.BILLING)return json({error:'activation_unavailable'},503);
      const account=await env.BILLING.fetch(new Request('https://account.hamsterai.cc/v1/me',{headers:{Authorization:`Bearer ${mainKey}`}}));
      valid=account.ok&&(await account.json()).email_verified===true;
    }else valid = await validateMainKey(mainKey);
  } catch { return json({error:'activation_unavailable'}, 503); }
  if (!valid) return json({error:'activation_failed'}, 401);
  const subject = await sha256(mainKey);
  const token = await createToken(env, subject);
  return json({token,expiresAt:new Date((Math.floor(Date.now()/1000)+ACTIVATION_TTL_SECONDS)*1000).toISOString()});
}

function endpoints(env) {
  return [...new Set(String(env.LLM_ENDPOINTS || '').split(',').map(value => value.trim()).filter(value => /^ep-[a-zA-Z0-9-]{5,100}$/.test(value)))];
}

function providerHeaders(request, env) {
  const headers = new Headers();
  for (const [name, value] of request.headers) {
    if (['host','authorization','content-length','x-hamster-client','cf-connecting-ip','cf-ray'].includes(name.toLowerCase())) continue;
    headers.set(name, value);
  }
  headers.set('authorization', `Bearer ${env.ARK_API_KEY}`);
  return headers;
}

function publicHeaders(response) {
  const headers = new Headers();
  for (const name of ['content-type','content-length','content-range','accept-ranges','cache-control']) {
    const value = response.headers.get(name);
    if (value) headers.set(name, value);
  }
  headers.set('cache-control', 'no-store');
  headers.set('x-content-type-options', 'nosniff');
  return headers;
}

// Cloud identifiers are capabilities issued to one authenticated account. The
// encrypted envelope needs no public object index and never reveals the uid or
// the provider identifier. Key rotation keeps a PIKNO account's uid unchanged.
const objectOwner = claims => claims.v===2 ? `pikno:${claims.uid}` : `legacy:${claims.sub}`;
async function objectKey(env) {
  if(typeof env.TOKEN_SIGNING_KEY!=='string'||env.TOKEN_SIGNING_KEY.length<32)throw new Error('Missing object secret');
  const bytes=await crypto.subtle.digest('SHA-256',encoder.encode('hamster-cloud-object-v1\0'+env.TOKEN_SIGNING_KEY));
  return crypto.subtle.importKey('raw',bytes,{name:'AES-GCM'},false,['encrypt','decrypt']);
}
async function wrapObject(env,claims,kind,id) {
  if(typeof id!=='string'||!/^[A-Za-z0-9_-]{1,512}$/.test(id))throw new Error('Invalid cloud object');
  const iv=crypto.getRandomValues(new Uint8Array(12));
  const encrypted=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:encoder.encode('hamster-object-v1')},await objectKey(env),encoder.encode(JSON.stringify({v:1,o:objectOwner(claims),k:kind,i:id})));
  return 'ho1_'+base64url(iv)+'_'+base64url(encrypted);
}
async function unwrapObject(env,claims,kind,handle,param) {
  const match=typeof handle==='string'&&/^ho1_([A-Za-z0-9_-]{16})_([A-Za-z0-9_-]{24,1800})$/.exec(handle);
  if(!match)throw Object.assign(new Error('Invalid object reference'),{objectStatus:400,param});
  let data;
  try {
    data=JSON.parse(decoder.decode(await crypto.subtle.decrypt({name:'AES-GCM',iv:decode64url(match[1]),additionalData:encoder.encode('hamster-object-v1')},await objectKey(env),decode64url(match[2]))));
  } catch { throw Object.assign(new Error('Invalid object reference'),{objectStatus:400,param}); }
  if(data.v!==1||data.k!==kind||typeof data.i!=='string'||!/^[A-Za-z0-9_-]{1,512}$/.test(data.i))
    throw Object.assign(new Error('Invalid object reference'),{objectStatus:400,param});
  if(data.o!==objectOwner(claims))throw Object.assign(new Error('Object belongs to another account'),{objectStatus:403,param});
  return data.i;
}
async function resolveReferences(value,env,claims) {
  if(Array.isArray(value))return Promise.all(value.map(item=>resolveReferences(item,env,claims)));
  if(!value||typeof value!=='object')return value;
  // This client uses file capabilities and explicit local message replay only.
  // Alternative provider object references have no account ownership contract.
  if(value.type==='item_reference')throw Object.assign(new Error('Unsupported object reference'),{objectStatus:400,param:'input'});
  const result={};
  for(const [key,item] of Object.entries(value)) {
    // The locked SDK emits omitted optional parameters as null. Null denotes
    // absence, never an alternative authorization path; omit it upstream.
    if(item===null)continue;
    if(['id','file_url','file_data','image_url','video_url','audio_url','conversation','prompt','vector_store_ids','session','context_management'].includes(key) || key==='tools'&&(!Array.isArray(item)||item.length))
      throw Object.assign(new Error('Unsupported object reference'),{objectStatus:400,param:'input'});
    if(key==='file_id')result[key]=await unwrapObject(env,claims,'file',item,'file_id');
    else if(key==='previous_response_id')result[key]=await unwrapObject(env,claims,'response',item,'previous_response_id');
    else result[key]=await resolveReferences(item,env,claims);
  }
  return result;
}
async function protectReferences(value,env,claims,kind='') {
  if(Array.isArray(value))return Promise.all(value.map(item=>protectReferences(item,env,claims)));
  if(!value||typeof value!=='object')return value;
  const result={};
  for(const [key,item] of Object.entries(value)) {
    if(typeof item==='string'&&(key==='response_id'||key==='previous_response_id'))result[key]=await wrapObject(env,claims,'response',item);
    else if(typeof item==='string'&&key==='file_id')result[key]=await wrapObject(env,claims,'file',item);
    else if(key==='id'&&typeof item==='string'&&(kind||value.object==='response'||value.object==='file'))result[key]=await wrapObject(env,claims,kind||value.object,item);
    else result[key]=await protectReferences(item,env,claims,key==='response'?'response':'');
  }
  return result;
}
async function protectedResponse(response,env,claims,ids,kind) {
  const headers=publicHeaders(response);headers.delete('content-length');
  if([204,205].includes(response.status))return new Response(null,{status:response.status,headers});
  const type=response.headers.get('content-type')||'';
  if(/event-stream/i.test(type)) {
    let carry='';
    const line=async value=>{
      if(!value.startsWith('data:'))return value;
      const data=value.slice(5).trim();if(!data||data==='[DONE]')return value;
      const result=await protectReferences(JSON.parse(data),env,claims);
      return 'data: '+JSON.stringify(result);
    };
    const body=hideEndpointStream(response.body,ids).pipeThrough(new TextDecoderStream()).pipeThrough(new TransformStream({
      async transform(chunk,controller) {
        const lines=(carry+chunk).split('\n');carry=lines.pop()||'';
        for(const value of lines)controller.enqueue(await line(value)+'\n');
        if(carry.length>MAX_JSON_BYTES)throw new Error('Oversized stream event');
      },
      async flush(controller) { if(carry)controller.enqueue(await line(carry)); },
    })).pipeThrough(new TextEncoderStream());
    return new Response(body,{status:response.status,headers});
  }
  const data=await response.arrayBuffer();if(data.byteLength>MAX_JSON_BYTES)throw new Error('Oversized cloud response');
  let text=decoder.decode(data);for(const id of ids)text=text.split(id).join('hamster-auto');
  return new Response(JSON.stringify(await protectReferences(JSON.parse(text),env,claims,kind)),{status:response.status,headers});
}

function hideEndpointStream(body, ids) {
  if (!body || !ids.length) return body;
  let carry = '';
  return body.pipeThrough(new TextDecoderStream()).pipeThrough(new TransformStream({
    transform(chunk, controller) {
      const lines = (carry + chunk).split('\n');
      carry = lines.pop() || '';
      let output = lines.join('\n') + (lines.length ? '\n' : '');
      for (const id of ids) output = output.split(id).join('hamster-auto');
      if (output) controller.enqueue(output);
    },
    flush(controller) {
      for (const id of ids) carry = carry.split(id).join('hamster-auto');
      controller.enqueue(carry);
    },
  })).pipeThrough(new TextEncoderStream());
}

async function limitedError(response, limit = 65_536) {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (size < limit) {
      const {done,value} = await reader.read();
      if (done) break;
      const chunk = value.slice(0, limit - size);
      chunks.push(chunk); size += chunk.length;
      if (chunk.length < value.length) break;
    }
  } finally { await reader.cancel().catch(() => {}); }
  const all = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { all.set(chunk, offset); offset += chunk.length; }
  return decoder.decode(all);
}

function retryable(status, message) {
  return [429,502,503,504].includes(status) || (status === 403 && /rate|quota|limit|thrott|flow|限流|频率/i.test(message));
}

async function inference(request, env, tokenData) {
  if (!env.ARK_API_KEY) return json({error:{code:'service_unavailable',message:'仓鼠智能服务暂不可用'}}, 503);
  const url = new URL(request.url);
  const target = new URL(url.pathname + url.search, INFERENCE_ORIGIN);
  const routeEndpoints = endpoints(env);
  if (!routeEndpoints.length) return json({error:{code:'service_unavailable',message:'仓鼠智能服务暂不可用'}}, 503);
  const isResponseCreate = request.method === 'POST' && url.pathname === '/api/v3/responses';
  const isFileOperation = (request.method === 'POST' && url.pathname === '/api/v3/files')
    || (['GET','DELETE'].includes(request.method) && /^\/api\/v3\/files\/[A-Za-z0-9_-]{1,2048}$/.test(url.pathname));
  if (!isResponseCreate && !isFileOperation) return new Response('Not Found', {status:404,headers:{'cache-control':'no-store'}});
  if (!isResponseCreate) {
    if(request.method!=='POST') {
      try { target.pathname='/api/v3/files/'+encodeURIComponent(await unwrapObject(env,tokenData,'file',url.pathname.split('/').pop(),'file_id')); }
      catch(error) { return json({error:{code:'object_access_denied',message:'素材引用无效或不属于当前账户',param:error.param}},error.objectStatus||400); }
    }
    const response = await fetch(target, {method:request.method,redirect:'manual',headers:providerHeaders(request,env),body:['GET','HEAD'].includes(request.method)?undefined:request.body});
    if (!response.ok) {
      if (response.body) await response.body.cancel().catch(() => {});
      return json({error:{code:'file_operation_failed',message:'临时素材处理失败，请稍后重试'}}, response.status);
    }
    return protectedResponse(response,env,tokenData,routeEndpoints,'file');
  }
  const length = Number(request.headers.get('content-length') || 0);
  if (length > MAX_JSON_BYTES) return json({error:{code:'request_too_large',message:'请求内容过大'}}, 413);
  let payload;
  try {
    const body = await request.arrayBuffer();
    if (body.byteLength > MAX_JSON_BYTES) return json({error:{code:'request_too_large',message:'请求内容过大'}}, 413);
    payload = JSON.parse(decoder.decode(body));
  } catch { return json({error:{code:'invalid_request',message:'请求格式不正确'}}, 400); }
  if(!payload||Array.isArray(payload)||typeof payload!=='object')return json({error:{code:'invalid_request',message:'请求格式不正确'}},400);
  try { payload=await resolveReferences(payload,env,tokenData); }
  catch(error) { return json({error:{code:'object_access_denied',message:'上下文或素材引用无效或不属于当前账户',param:error.param}},error.objectStatus||400); }
  const start = Number.parseInt(tokenData.sub.slice(0, 8), 16) % routeEndpoints.length;
  let lastStatus = 429;
  for (let index = 0; index < routeEndpoints.length; index++) {
    const model = routeEndpoints[(start + index) % routeEndpoints.length];
    const response = await fetch(target, {method:'POST',redirect:'manual',headers:providerHeaders(request,env),body:JSON.stringify({...payload,model})});
    if (response.ok) return protectedResponse(response,env,tokenData,routeEndpoints,'response');
    lastStatus = response.status;
    const message = await limitedError(response);
    if([400,404].includes(response.status)) {
      let error;try{error=JSON.parse(message)?.error;}catch{}
      const param=error&&typeof error==='object'&&!Array.isArray(error)?error.param:undefined;
      // Only a structured reference rejection before any accepted response may
      // permit context rebuilding. Ambiguous failures and SSE errors never do.
      if(['previous_response_id','file_id'].includes(param) && !error.response_id && !error.task_id &&
        (!Object.hasOwn(error,'submission_state')||error.submission_state==='not_submitted'))
        return json({error:{code:'object_reference_rejected',message:param==='previous_response_id'?'上下文引用已失效，请重新准备本地上下文':'素材引用已失效，请重新准备本地素材',param,submission_state:'not_submitted'}},response.status);
    }
    if (!retryable(response.status, message)) return json({error:{code:'inference_failed',message:'推理请求失败，请稍后重试'}}, response.status);
  }
  return json({error:{code:'rate_limited',message:'当前请求较多，已自动切换线路，请稍后重试'}}, lastStatus === 429 ? 429 : 503);
}

export { activate, activatePikno, createToken, executePikno, inference, verifyToken };

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/health') return json({ok:true,service:'hamster-ai-inference'});
    if(request.method==='POST'&&url.pathname==='/internal/pikno/responses'&&!url.search)return executePikno(request,env);
    if(url.pathname==='/internal/pikno/files'||url.pathname.startsWith('/internal/pikno/files/'))return filesPikno(request,env);
    if(paidMode(env)&&(['/v1/activate','/internal/pikno/activate'].includes(url.pathname)||url.pathname.startsWith('/api/v3/')))
      return notSubmitted(url.pathname.startsWith('/api/v3/files')?'capability_unavailable':'paid_gateway_required',403);
    if (request.method === 'POST' && url.pathname === '/v1/activate') return activate(request, env);
    if (request.method === 'POST' && url.pathname === '/internal/pikno/activate') return activatePikno(request, env);
    if (!url.pathname.startsWith('/api/v3/')) return new Response('Not Found', {status:404,headers:{'cache-control':'no-store'}});
    const match = (request.headers.get('authorization') || '').match(/^Bearer\s+(.+)$/i);
    const tokenData = await verifyToken(env, match?.[1] || '');
    if (!tokenData || request.headers.get('x-hamster-client') !== CLIENT_HEADER) return json({error:{code:'unauthorized',message:'请重新激活仓鼠智能服务'}}, 401);
    try { return await inference(request, env, tokenData); }
    catch { return json({error:{code:'service_unavailable',message:'仓鼠智能服务暂不可用'}}, 503); }
  },
};
