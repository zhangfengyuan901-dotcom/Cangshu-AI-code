const encoder=new TextEncoder();
export const now=()=>Date.now();
export const id=prefix=>prefix+'_'+crypto.randomUUID().replaceAll('-','');
export const fail=(message,status=400)=>Object.assign(new Error(message),{status});
export const json=(data,status=200)=>Response.json(data,{status,headers:{'cache-control':'no-store','x-content-type-options':'nosniff'}});
export const stmt=(env,sql,...args)=>env.DB.prepare(sql).bind(...args);
export const one=(env,sql,...args)=>stmt(env,sql,...args).first();
export const all=async(env,sql,...args)=>(await stmt(env,sql,...args).all()).results;
export const run=(env,sql,...args)=>stmt(env,sql,...args).run();
export async function hash(value){return [...new Uint8Array(await crypto.subtle.digest('SHA-256',encoder.encode(value)))].map(n=>n.toString(16).padStart(2,'0')).join('');}
export function randomToken(){return 'ha_'+[...crypto.getRandomValues(new Uint8Array(32))].map(n=>n.toString(16).padStart(2,'0')).join('');}
export async function equal(a,b){const [x,y]=await Promise.all([hash(a),hash(b)]);let n=0;for(let i=0;i<x.length;i++)n|=x.charCodeAt(i)^y.charCodeAt(i);return n===0;}
export async function crypt(secret,text,decrypt=false){
 const key=await crypto.subtle.importKey('raw',await crypto.subtle.digest('SHA-256',encoder.encode(secret)),{name:'AES-GCM'},false,[decrypt?'decrypt':'encrypt']);
 if(decrypt){const [iv,data]=text.split('.').map(x=>Uint8Array.from(atob(x),c=>c.charCodeAt(0)));return new TextDecoder().decode(await crypto.subtle.decrypt({name:'AES-GCM',iv},key,data));}
 const iv=crypto.getRandomValues(new Uint8Array(12));const data=new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv},key,encoder.encode(text)));
 return btoa(String.fromCharCode(...iv))+'.'+btoa(String.fromCharCode(...data));
}
export async function bytesLimited(stream,max){
 const reader=stream.getReader(),chunks=[];let size=0;
 try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>max)throw fail('内容超过大小限制',413);chunks.push(value);}}catch(e){await reader.cancel().catch(()=>{});throw e;}
 const data=new Uint8Array(size);let offset=0;for(const chunk of chunks){data.set(chunk,offset);offset+=chunk.length;}return data;
}
export async function body(request,max=1024*1024){if(!request.body)return {};try{return JSON.parse(new TextDecoder().decode(await bytesLimited(request.body,max)));}catch(e){if(e.status)throw e;throw fail('请求不是有效 JSON');}}
export function integer(value,min,max,label){const n=Number(value);if(!Number.isSafeInteger(n)||n<min||n>max)throw fail(label+'无效');return n;}
export function units(value){const s=String(value);if(!/^\d{1,7}(\.\d{1,6})?$/.test(s))throw fail('金额格式无效');const [a,b='']=s.split('.');return Number(BigInt(a)*1000000n+BigInt(b.padEnd(6,'0')));}
export const money=n=>Number(n)/1000000;
export function roundSale(cost,bps=12000){return Number((BigInt(cost)*BigInt(bps)+50000000n)/100000000n*10000n);}
export function canonical(value){if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';if(value&&typeof value==='object')return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')+'}';return JSON.stringify(value);}
export function requestId(request){const v=request.headers.get('Idempotency-Key')||'';if(!/^[a-zA-Z0-9:_-]{8,160}$/.test(v))throw fail('需要有效的 Idempotency-Key');return v;}
export async function authenticate(request,env,admin=false){
 const token=(request.headers.get('authorization')||'').replace(/^Bearer\s+/i,'');
 if(admin)throw fail('请使用管理员邮箱验证码登录',401);
 if(!token.startsWith('ha_'))throw fail('请先登录 仓鼠AI 账户',401);
 const row=await one(env,'SELECT k.id AS key_id,k.status AS key_status,k.expires_at,c.* FROM api_keys k JOIN customers c ON c.id=k.user_id WHERE k.token_hash=?',await hash(token));
 if(!row||row.key_status!=='active'||row.status!=='active')throw fail('登录会话已停用或无效，请重新登录',401);
 if(!row.email_verified_at)throw fail('请先完成邮箱验证码验证',403);
 if(row.expires_at!==null&&row.expires_at<=now())throw fail('登录已过期，请重新获取邮箱验证码',401);
 await run(env,'UPDATE api_keys SET last_used_at=? WHERE id=?',now(),row.key_id);return row;
}
export const audit=(env,actor,action,target,detail)=>stmt(env,'INSERT INTO audit VALUES (?,?,?,?,?,?)',id('audit'),actor,action,target,JSON.stringify(detail),now());
export function reason(payload){const value=String(payload.reason||'').trim();if(value.length<2||value.length>300)throw fail('请填写操作原因（2—300 字）');return value;}
export async function signedUrl(env,origin,key,ttl=3600){
 const exp=Math.floor(now()/1000)+ttl;const path='/v1/files/'+key;
 const cryptoKey=await crypto.subtle.importKey('raw',encoder.encode(env.RESULT_SIGNING_SECRET),{name:'HMAC',hash:'SHA-256'},false,['sign']);
 const sig=[...new Uint8Array(await crypto.subtle.sign('HMAC',cryptoKey,encoder.encode(path+'\n'+exp)))].map(n=>n.toString(16).padStart(2,'0')).join('');
 return origin+path+'?exp='+exp+'&sig='+sig;
}
export async function validFileUrl(env,url){
 const exp=Number(url.searchParams.get('exp'));if(!Number.isSafeInteger(exp)||exp<Math.floor(now()/1000)||exp>Math.floor(now()/1000)+86400)return false;
 const key=await crypto.subtle.importKey('raw',encoder.encode(env.RESULT_SIGNING_SECRET),{name:'HMAC',hash:'SHA-256'},false,['verify']);
 const s=url.searchParams.get('sig')||'';if(!/^[a-f0-9]{64}$/.test(s))return false;
 return crypto.subtle.verify('HMAC',key,Uint8Array.from(s.match(/../g),v=>parseInt(v,16)),encoder.encode(url.pathname+'\n'+exp));
}
