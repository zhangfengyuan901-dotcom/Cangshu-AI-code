import {one,run,now,fail,crypt,bytesLimited,units,validFileUrl} from './common.mjs';
import {upstreamModel} from './routes.mjs';
import {finishFailure,settle} from './billing.mjs';
export const BASES={backup:'https://seedance2026.vip',main:'https://sanbaobeauty.com',image:'https://sanbaobeauty.com',tool:'https://www.runninghub.cn/openapi/v2'};
const sizes={'auto':'auto','1:1':'1024x1024','16:9':'1536x864','9:16':'864x1536','3:2':'1536x1024','2:3':'1024x1536'};
export function safeRemote(value){
 let u;try{u=new URL(value);}catch{throw fail('结果 URL 无效',502);}
 if(u.protocol!=='https:'||u.username||u.password||u.port||!u.hostname.includes('.')||/^[\d.]+$/.test(u.hostname)||u.hostname.includes(':')||/(^|\.)(localhost|local|internal|test|invalid)$/.test(u.hostname))throw fail('结果 URL 不允许',502);
 return u;
}
async function remote(url,options={}){
 let u=safeRemote(url);for(let i=0;i<5;i++){
  const response=await fetch(u,{...options,redirect:'manual',signal:AbortSignal.timeout(540000)});
  if(![301,302,303,307,308].includes(response.status))return response;
  const next=safeRemote(new URL(response.headers.get('location'),u).href);if(next.origin!==u.origin)options={...options,headers:{}};await response.body?.cancel();u=next;
 }throw fail('结果地址重定向过多',502);
}
async function api(provider,secret,path,options={}){
 const response=await fetch(BASES[provider]+path,{...options,headers:{Authorization:'Bearer '+secret,...options.headers},redirect:'error',signal:AbortSignal.timeout(540000)});
 if(!response.ok){await response.body?.cancel();throw fail('生成服务请求失败（HTTP '+response.status+'）',response.status);}
 if(!response.body)throw fail('生成服务响应为空',502);
 let data;try{data=JSON.parse(new TextDecoder().decode(await bytesLimited(response.body,32*1024*1024)));}catch{throw fail('生成服务响应格式异常',502);}return data;
}
export async function validateReferences(env,user,payload,origin){
 for(const field of ['images','videos','audios','mask'])for(const item of field==='mask'?(payload.mask?[payload.mask]:[]):payload[field]||[]){
  const value=typeof item==='string'?item:item?.url;const url=safeRemote(value);
  const own=url.origin===origin&&url.pathname.startsWith('/v1/files/input/'+user.id+'/');
  if(!own||!await validFileUrl(env,url))throw fail('请使用当前客户账户上传的 素材');
  const object=await env.RESULTS.head(url.pathname.slice('/v1/files/'.length));if(!object)throw fail('素材不存在或已过期');
  const expected=field==='videos'?'video/':field==='audios'?'audio/':'image/';if(!object.httpMetadata?.contentType?.startsWith(expected))throw fail('素材类型与引用不一致');
 }
}
async function keyFor(env,task){const key=await one(env,'SELECT * FROM provider_keys WHERE id=?',task.provider_key_id);if(!key)throw fail('任务关联的渠道 Key 不存在',503);return {...key,secret:await crypt(env.KEY_ENCRYPTION_SECRET,key.encrypted_secret,true)};}
const post=data=>({method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
function multipart(object,name){
 const boundary='hamster-'+crypto.randomUUID(),encoder=new TextEncoder();
 const safeName=name.replace(/[^a-zA-Z0-9._-]/g,'_').slice(-120)||'media';
 const prefix=encoder.encode('--'+boundary+'\r\nContent-Disposition: form-data; name="file"; filename="'+safeName+'"\r\nContent-Type: '+object.httpMetadata.contentType+'\r\n\r\n'),suffix=encoder.encode('\r\n--'+boundary+'--\r\n');
 const reader=object.body.getReader();
 const body=new ReadableStream({start(c){c.enqueue(prefix);},async pull(c){const part=await reader.read();if(part.done){c.enqueue(suffix);c.close();}else c.enqueue(part.value);},cancel(reason){return reader.cancel(reason);}});
 return {method:'POST',headers:{'Content-Type':'multipart/form-data; boundary='+boundary,'Content-Length':String(prefix.length+object.size+suffix.length)},body,duplex:'half'};
}
async function certify(secret,url){
 const result=await api('backup',secret,'/api/real-person-assets/import-url',post({url}));let row=result.row;
 const assetKey=row?.assetKey||row?.asset_key,ref=row?.assetRef||row?.asset_ref;if(!assetKey||!ref?.startsWith('asset://'))throw fail('真人素材认证未返回引用',422);
 for(let n=0;n<90;n++){
  const states=[row.status,row.assetCertification?.status,...(row.certifications||[]).map(x=>x.status)].map(x=>String(x).toLowerCase());
  if(states.some(x=>['failed','blocked'].includes(x)))throw fail('真人素材认证失败',422);
  if(states.includes('active')&&!states.includes('certifying'))return ref;
  await new Promise(r=>setTimeout(r,5000));row=(await api('backup',secret,'/api/assets/'+encodeURIComponent(assetKey))).row||{};
 }throw fail('真人素材认证超时，未提交生成',422);
}
async function prepare(task,secret,env){
 if(task.provider==='tool'){
  const p=JSON.parse(task.payload_json),fields=[];
  for(const [field,nodeId,kind]of [['images','133','image'],['audios','125','audio'],['videos','183','video']])for(const item of p[field]||[]){
   const url=new URL(typeof item==='string'?item:item.url),prefix='/v1/files/input/'+task.user_id+'/';
   if(!url.pathname.startsWith(prefix)||!await validFileUrl(env,url))throw fail('素材已失效，请重新上传',422);
   const object=await env.RESULTS.get(url.pathname.slice('/v1/files/'.length));
   if(!object||object.size>50*1024*1024||!object.httpMetadata?.contentType?.startsWith(kind+'/'))throw fail('工具素材不存在或超过50MB限制',422);
   const uploaded=await api('tool',secret,'/media/upload/binary',multipart(object,url.pathname.split('/').pop()));
   const handle=uploaded.data?.fileName||uploaded.data?.download_url;
   if(!handle||(uploaded.code!==undefined&&Number(uploaded.code)!==0))throw fail('工具素材准备失败',422);
   fields.push({nodeId,fieldName:kind,fieldValue:handle});
  }
  const workflow=({'tool-digital':'2087890031699648513','tool-depth':'2089021172049596418'})[task.model_id];
  if(!workflow)throw fail('工具服务未开放',422);
  return {path:'/run/ai-app/'+workflow,...post({nodeInfoList:fields,instanceType:'default',usePersonalQueue:false})};
 }
 const p=JSON.parse(task.payload_json);if(task.provider==='backup'){
  const content=[{type:'text',text:p.prompt}];
  for(const [field,kind]of [['images','image'],['videos','video'],['audios','audio']])for(const [i,item]of (p[field]||[]).entries()){
   let url=typeof item==='string'?item:item.url;
   if(kind!=='audio'&&(p.reference==='face'||p.real_person===true||item.requiresCertification))url=await certify(secret,url);
   const role=kind==='image'?(p.reference==='startEnd'?(i===0?'first_frame':'last_frame'):'reference_image'):'reference_'+kind;
   content.push({type:kind+'_url',role,[kind+'_url']:{url}});
  }return {path:'/v1/video/generations',...post({model:upstreamModel(p.model),duration:Number(p.duration||5),resolution:p.resolution||'480p',ratio:p.ratio||'16:9',return_last_frame:p.return_last_frame===true,content})};
 }
 const payload={model:upstreamModel(p.model),prompt:p.prompt,concurrency:1};
 for(const field of task.kind==='image'?['aspect_ratio','quality','images']:['ratio','resolution','duration','reference','images','videos','audios'])if(p[field]!==undefined)payload[field]=p[field];
 return {path:'/openapi/v1/'+(task.kind==='image'?'images':'videos'),...post(payload)};
}

function normalize(task,response){
 let data=response.data||response;if(Array.isArray(data.tasks))data=data.tasks[0]||{};if(task.provider==='tool'&&response.errorCode&&String(response.errorCode)!=='0')data={...data,status:'failed'}; if(!data.status&&(data.id||data.task_id||data.taskId))data={...data,status:'queued'};
 const state=({queued:'processing',pending:'processing',running:'processing',processing:'processing',in_progress:'processing',succeeded:'transferring',success:'transferring',failed:'failed',failure:'failed',cancelled:'failed'})[String(data.status).toLowerCase()];
 if(!state)throw fail('生成服务未返回可识别的状态',502);
 const result=data.content?.video_url||data.video_url||data.image_url||data.result_url||data.data?.url||data.results?.find(r=>r.url)?.url;
 return {state,id:data.id||data.task_id||data.taskId,url:result?new URL(result,BASES[task.provider]).href:'',progress:Number.isFinite(Number(data.progress))?Math.max(0,Math.min(99,Number(data.progress))):null,error:state==='failed'?'生成服务生成失败，未扣费':''};
}
export async function applyUpstream(env,task,response){
 const data=normalize(task,response);if(data.state==='failed'){await finishFailure(env,task.id,data.error);return;}
 if(data.state==='transferring'&&!data.url)throw fail('生成服务标记成功但未返回结果，继续核查',502);
 if(data.url)safeRemote(data.url);
 const upstreamId=data.id||task.upstream_id;if(!upstreamId)throw fail('生成服务未返回任务编号',502);
 await run(env,"UPDATE tasks SET state=?,upstream_id=?,upstream_url=?,progress=?,error='',updated_at=? WHERE id=? AND state NOT IN ('succeeded','failed','cancelled')",data.state,String(upstreamId),data.url||null,data.progress,now(),task.id);
}
export async function submitTask(env,taskId){
 let task=await one(env,'SELECT * FROM tasks WHERE id=?',taskId);if(task.state!=='preparing')return;
 const key=await keyFor(env,task);let prepared;
 try{prepared=await prepare(task,key.secret,env);}catch(e){await finishFailure(env,taskId,'素材准备失败，未提交生成；请检查素材后重试');return;}
 const claimed=await run(env,"UPDATE tasks SET state='submitting',updated_at=? WHERE id=? AND state='preparing'",now(),taskId);if(!claimed.meta.changes)return;
 try{
  const {path,...options}=prepared;options.headers={...options.headers,'Idempotency-Key':task.id};
  const response=await api(task.provider,key.secret,path,options);
  await applyUpstream(env,task,response);
 }catch(e){
  if([400,401,403,404,422,429].includes(e.status)){
   if([401,403].includes(e.status))await run(env,"UPDATE provider_keys SET status='paused',last_error=? WHERE id=?",e.message,key.id);
   if(e.status===429)await run(env,'UPDATE provider_keys SET cooldown_until=?,last_error=? WHERE id=?',now()+60000,e.message,key.id);
   await finishFailure(env,taskId,e.message);
  }else await run(env,"UPDATE tasks SET state='unknown',error='提交结果待核查，不会自动重复生成',updated_at=? WHERE id=? AND state='submitting'",now(),taskId);
 }
}
export async function pollTask(env,taskId){
 const task=await one(env,'SELECT * FROM tasks WHERE id=?',taskId);if(!['processing','unknown'].includes(task.state)||!task.upstream_id)return;
 const key=await keyFor(env,task),path=task.provider==='backup'?'/v1/video/generations/':'/openapi/v1/'+(task.kind==='image'?'images/':'videos/');
 if(task.provider==='tool'){await applyUpstream(env,task,await api('tool',key.secret,'/query',post({taskId:task.upstream_id})));return;}
 await applyUpstream(env,task,await api(task.provider,key.secret,path+encodeURIComponent(task.upstream_id)));
}
export async function transferTask(env,taskId){
 const task=await one(env,'SELECT * FROM tasks WHERE id=?',taskId);if(task.state!=='transferring')return;
 const resultKey=task.result_key||'result/'+task.user_id+'/'+task.id+(task.kind==='image'?'.png':'.mp4');
 if(!await env.RESULTS.head(resultKey)){
  if(!task.upstream_url)throw fail('等待有效结果链接',503);
  const key=await keyFor(env,task);const url=safeRemote(task.upstream_url);
  const response=await remote(url,{headers:url.origin===BASES[task.provider]?{Authorization:'Bearer '+key.secret}:{}});
  const type=response.headers.get('content-type')?.split(';')[0]||'';
  if(!response.ok||!response.body||!type.startsWith(task.kind+'/'))throw fail('生成结果暂不可读取，将重试转存',502);
  const length=Number(response.headers.get('content-length'));if(length>1024*1024*1024)throw fail('结果超过 1GB，需人工处理',413);
  await env.RESULTS.put(resultKey,response.body,{httpMetadata:{contentType:type}});
 }
 await settle(env,taskId,resultKey);
}
