import {one,run,stmt,id,now,fail,hash,equal,randomToken} from './common.mjs';
import {sendEmail,mailPayload} from './mail.mjs';

function emailAddress(value){const email=String(value||'').trim().toLowerCase();if(email.length>254||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))throw fail('请输入有效邮箱');return email;}
async function codeHash(env,challenge,email,code){
 const enc=new TextEncoder(),key=await crypto.subtle.importKey('raw',enc.encode(env.KEY_ENCRYPTION_SECRET),{name:'HMAC',hash:'SHA-256'},false,['sign']);
 return [...new Uint8Array(await crypto.subtle.sign('HMAC',key,enc.encode('email-login\n'+challenge+'\n'+email+'\n'+code)))].map(x=>x.toString(16).padStart(2,'0')).join('');
}
export async function limit(env,name,max,windowMs){
 const time=now(),key=await hash(name),row=await one(env,'INSERT INTO auth_limits(id,count,expires_at) VALUES (?,1,?) ON CONFLICT(id) DO UPDATE SET count=CASE WHEN expires_at<=? THEN 1 ELSE count+1 END,expires_at=CASE WHEN expires_at<=? THEN excluded.expires_at ELSE expires_at END WHERE expires_at<=? OR count<? RETURNING count',key,time+windowMs,time,time,time,max);
 if(!row)throw fail('操作过于频繁，请稍后再试',429);
}
export async function requestCode(env,p,ip,fetchImpl=fetch){
 const email=emailAddress(p.email);
 if(!env.RESEND_API_KEY||!env.MAIL_FROM)throw fail('邮件服务尚未配置，请联系管理员',503);
 await limit(env,'send-ip:'+ip,20,3600000);
 await limit(env,'send-global',1000,86400000);
 await limit(env,'send-email-hour:'+email,5,3600000);
 await limit(env,'send-email-minute:'+email,1,60000);
 let n;do{n=crypto.getRandomValues(new Uint32Array(1))[0];}while(n>=4294000000);
 const code=String(n%1000000).padStart(6,'0'),challenge=id('otp'),time=now();
 await env.DB.batch([
  stmt(env,'UPDATE email_challenges SET consumed_at=? WHERE email=? AND consumed_at IS NULL',time,email),
  stmt(env,'INSERT INTO email_challenges(id,email,code_hash,created_at,expires_at) VALUES (?,?,?,?,?)',challenge,email,await codeHash(env,challenge,email,code),time,time+600000)
 ]);
 await sendEmail(env,mailPayload(env,email,'仓鼠AI 邮箱验证码',`您的 仓鼠AI 验证码为：${code}\n\n10 分钟内有效，请勿向任何人提供。新邮箱验证后将自动注册；已有账户的余额和记录保持不变。\n如非本人操作，请忽略本邮件。`),challenge,fetchImpl);
 return {challenge_id:challenge,expires_in:600,retry_after:60};
}
export async function verifyCode(env,p,ip){
 const email=emailAddress(p.email),challenge=String(p.challenge_id||''),code=String(p.code||'');
 if(!/^otp_[a-f0-9]{32}$/.test(challenge)||!/^\d{6}$/.test(code))throw fail('请输入六位验证码');
 await limit(env,'verify-ip:'+ip,60,3600000);
 // Reserve an attempt atomically before checking. Concurrent requests cannot bypass the five-attempt cap.
 const row=await one(env,'UPDATE email_challenges SET attempts=attempts+1 WHERE id=? AND email=? AND consumed_at IS NULL AND expires_at>? AND attempts<5 RETURNING *',challenge,email,now());
 if(!row||!await equal(row.code_hash,await codeHash(env,challenge,email,code)))throw fail('验证码无效、已使用或已过期，请重新获取',400);
 const consumed=await run(env,'UPDATE email_challenges SET consumed_at=? WHERE id=? AND consumed_at IS NULL AND expires_at>?',now(),challenge,now());
 if(!consumed.meta.changes)throw fail('验证码已使用，请重新获取',400);
 const secret=randomToken(),time=now(),keyId=id('key');
 await env.DB.batch([
  stmt(env,"INSERT INTO customers(id,email,name,created_at,email_verified_at) VALUES (?,?,'',?,?) ON CONFLICT(email) DO NOTHING",id('user'),email,time,time),
  stmt(env,"UPDATE customers SET email_verified_at=? WHERE email=? AND status='active'",time,email),
  stmt(env,"INSERT INTO api_keys(id,user_id,name,token_hash,preview,created_at,expires_at) SELECT ?,id,'邮箱登录',?,?,?,? FROM customers WHERE email=? AND status='active'",keyId,await hash(secret),secret.slice(0,8)+'…'+secret.slice(-4),time,time+30*86400000,email)
 ]);
 const account=await one(env,"SELECT id,email FROM customers WHERE email=? AND status='active'",email);
 if(!account)throw fail('账户已停用，请联系管理员',403);
 return {token:secret,user_id:account.id,email:account.email};
}
export async function cleanAuth(env){await env.DB.batch([stmt(env,'DELETE FROM auth_limits WHERE expires_at<?',now()-86400000),stmt(env,'DELETE FROM email_challenges WHERE expires_at<?',now()-86400000)]);}

