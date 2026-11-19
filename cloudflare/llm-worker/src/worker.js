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
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)))]
    .map(byte => byte.toString(16).padStart(2, '0')).join('');
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

export { activate, activatePikno, createToken, inference, verifyToken };

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/health') return json({ok:true,service:'hamster-ai-inference'});
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
