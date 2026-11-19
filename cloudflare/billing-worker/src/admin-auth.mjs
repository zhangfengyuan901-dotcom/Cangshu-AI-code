import {one,run,stmt,id,now,fail,hash,equal,randomToken,json,body,audit} from './common.mjs';
import {limit} from './auth.mjs';
import {sendEmail,mailPayload} from './mail.mjs';

const COOKIE='__Host-hamster_admin',SESSION_SECONDS=14400;
const cookie=(token,seconds)=>`${COOKIE}=${token}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${seconds}`;
function allowedEmail(env,value){
 const configured=String(env.ADMIN_EMAIL||'').trim().toLowerCase();
 if(!configured||!env.ADMIN_TOKEN)throw fail('管理员登录尚未配置',503);
 const email=String(value||'').trim().toLowerCase();
 if(email!==configured)throw fail('此邮箱无法登录管理后台',403);
 return email;
}
async function codeHash(env,challenge,email,code){
 const enc=new TextEncoder(),key=await crypto.subtle.importKey('raw',enc.encode(env.ADMIN_TOKEN),{name:'HMAC',hash:'SHA-256'},false,['sign']);
 return [...new Uint8Array(await crypto.subtle.sign('HMAC',key,enc.encode(`admin-login\n${challenge}\n${email}\n${code}`)))].map(n=>n.toString(16).padStart(2,'0')).join('');
}
export function requireAdminOrigin(request){
 if(request.headers.get('origin')!==new URL(request.url).origin||request.headers.get('X-Hamster-Admin')!=='1'||request.headers.get('content-type')?.split(';')[0].trim()!=='application/json')throw fail('请从管理后台页面操作',403);
}
export async function authenticateAdmin(request,env){
 const values=(request.headers.get('cookie')||'').split(';').map(v=>v.trim()).filter(v=>v.startsWith(COOKIE+'='));
 const token=values.length===1?values[0].slice(COOKIE.length+1):'';
 if(!/^adm_[a-f0-9]{64}$/.test(token))throw fail('请使用管理员邮箱验证码登录',401);
 const tokenHash=await hash(token),session=await one(env,'SELECT * FROM admin_sessions WHERE token_hash=? AND revoked_at IS NULL AND expires_at>?',tokenHash,now());
 if(!session||session.email!==String(env.ADMIN_EMAIL||'').trim().toLowerCase())throw fail('管理登录已过期，请重新获取验证码',401);
 return {id:'admin',actor:'admin:'+String(await hash(session.email)).slice(0,12),tokenHash,email:session.email,expires_at:session.expires_at};
}
export async function handleAdminAuth(request,env,fetchImpl=fetch){
 const path=new URL(request.url).pathname;
 if(!path.startsWith('/admin/api/auth/'))return null;
 if(path==='/admin/api/auth/session'&&request.method==='GET'){
  const admin=await authenticateAdmin(request,env);return json({authenticated:true,email:admin.email,expires_at:admin.expires_at});
 }
 if(request.method!=='POST')throw fail('方法不支持',405);
 requireAdminOrigin(request);
 if(path==='/admin/api/auth/logout'){
  const admin=await authenticateAdmin(request,env);
  await env.DB.batch([stmt(env,'UPDATE admin_sessions SET revoked_at=? WHERE token_hash=?',now(),admin.tokenHash),audit(env,admin.actor,'admin-logout','admin',{})]);
  const response=json({ok:true});response.headers.set('set-cookie',cookie('',0));return response;
 }
 if(!['/admin/api/auth/code','/admin/api/auth/verify'].includes(path))throw fail('接口不存在',404);
 const p=await body(request,4096),ip=request.headers.get('CF-Connecting-IP')||'unknown';
 await limit(env,'admin-auth-ip:'+ip,60,3600000);
 const email=allowedEmail(env,p.email);
 if(path.endsWith('/code')){
  if(!env.RESEND_API_KEY||!env.MAIL_FROM)throw fail('邮件服务尚未配置',503);
  await limit(env,'admin-send-minute:'+email,1,60000);
  await limit(env,'admin-send-hour:'+email,5,3600000);
  await limit(env,'admin-send-day',20,86400000);
  let n;do{n=crypto.getRandomValues(new Uint32Array(1))[0];}while(n>=4294000000);
  const code=String(n%1000000).padStart(6,'0'),challenge=id('aotp'),time=now();
  await env.DB.batch([
   stmt(env,'UPDATE admin_challenges SET consumed_at=? WHERE email=? AND consumed_at IS NULL',time,email),
   stmt(env,'INSERT INTO admin_challenges(id,email,code_hash,created_at,expires_at) VALUES (?,?,?,?,?)',challenge,email,await codeHash(env,challenge,email,code),time,time+600000)
  ]);
  try{await sendEmail(env,mailPayload(env,email,'仓鼠AI 管理员登录验证码',`您的管理员登录验证码为：${code}\n\n10 分钟内有效，只能使用一次。请仅在仓鼠AI管理后台输入，不要向任何人提供。\n如非本人操作，请忽略本邮件。`),challenge,fetchImpl);}
  catch(e){await run(env,'UPDATE admin_challenges SET consumed_at=? WHERE id=?',now(),challenge);throw e;}
  return json({challenge_id:challenge,expires_in:600,retry_after:60});
 }
 const challenge=String(p.challenge_id||''),code=String(p.code||'');
 if(!/^aotp_[a-f0-9]{32}$/.test(challenge)||!/^\d{6}$/.test(code))throw fail('请输入六位管理员验证码');
 const row=await one(env,'UPDATE admin_challenges SET attempts=attempts+1 WHERE id=? AND email=? AND consumed_at IS NULL AND expires_at>? AND attempts<5 RETURNING *',challenge,email,now());
 if(!row||!await equal(row.code_hash,await codeHash(env,challenge,email,code)))throw fail('验证码无效、已使用或已过期，请重新获取');
 const consumed=await run(env,'UPDATE admin_challenges SET consumed_at=? WHERE id=? AND consumed_at IS NULL AND expires_at>?',now(),challenge,now());
 if(!consumed.meta.changes)throw fail('验证码已使用，请重新获取');
 const token='adm_'+randomToken().slice(3),time=now(),actor='admin:'+String(await hash(email)).slice(0,12);
 await env.DB.batch([
  stmt(env,'INSERT INTO admin_sessions(token_hash,email,created_at,expires_at) VALUES (?,?,?,?)',await hash(token),email,time,time+SESSION_SECONDS*1000),
  audit(env,actor,'admin-login','admin',{})
 ]);
 const response=json({authenticated:true,expires_at:time+SESSION_SECONDS*1000});
 response.headers.set('set-cookie',cookie(token,SESSION_SECONDS));return response;
}
export async function cleanAdminAuth(env){await env.DB.batch([stmt(env,'DELETE FROM admin_challenges WHERE expires_at<?',now()-86400000),stmt(env,'DELETE FROM admin_sessions WHERE expires_at<? OR revoked_at<?',now()-86400000,now()-86400000)]);}
