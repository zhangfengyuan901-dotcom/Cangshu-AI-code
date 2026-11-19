import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {fixture} from './fixture.mjs';
import {handleAdminAuth,authenticateAdmin,requireAdminOrigin,cleanAdminAuth} from '../src/admin-auth.mjs';
import {one,run,hash,authenticate} from '../src/common.mjs';
import {verifyCode} from '../src/auth.mjs';

const origin='https://account.example.test',email='admin@example.test';
function request(path,p,headers={}){return new Request(origin+'/admin/api/'+path,{method:p?'POST':'GET',headers:{origin,'Content-Type':'application/json','X-Hamster-Admin':'1',...headers},...(p?{body:JSON.stringify(p)}:{})});}
async function setup(t){const {env}=await fixture(t);Object.assign(env,{ADMIN_EMAIL:email,ADMIN_TOKEN:'fixture-admin-pepper',RESEND_API_KEY:'fixture-mail',MAIL_FROM:'Test <test@example.test>'});const sent=[];const mail=async(url,options)=>{assert.equal(url,'https://api.resend.com/emails');sent.push(JSON.parse(options.body));return Response.json({id:'fixture-mail-id'});};return {env,sent,mail};}
async function send(f){const response=await handleAdminAuth(request('auth/code',{email}),f.env,f.mail);const data=await response.json();return {...data,code:f.sent.at(-1).text.match(/：([0-9]{6})/)[1]};}
async function verify(f,c){return handleAdminAuth(request('auth/verify',{email,challenge_id:c.challenge_id,code:c.code}),f.env,f.mail);}
async function resetMinute(env){await run(env,'DELETE FROM auth_limits WHERE id=?',await hash('admin-send-minute:'+email));}

test('admin OTP uses hashed storage, secure cookie, independent session and one-use code',async t=>{
 const f=await setup(t),before=await one(f.env,'SELECT COUNT(*) AS n FROM customers'),c=await send(f);
 const row=await one(f.env,'SELECT * FROM admin_challenges WHERE id=?',c.challenge_id);
 assert.equal(row.expires_at-row.created_at,600000);assert.match(row.code_hash,/^[a-f0-9]{64}$/);assert.notEqual(row.code_hash,c.code);
 const response=await verify(f,c),cookie=response.headers.get('set-cookie');assert.match(cookie,/^__Host-hamster_admin=adm_[a-f0-9]{64}; Path=\/; Secure; HttpOnly; SameSite=Strict; Max-Age=14400$/);
 assert.equal((await response.json()).token,undefined);
 const admin=await authenticateAdmin(request('overview',null,{cookie}),f.env);assert.equal(admin.email,email);
 assert.equal((await one(f.env,'SELECT COUNT(*) AS n FROM customers')).n,before.n);
 await assert.rejects(verify(f,c),/验证码/);
 await assert.rejects(authenticateAdmin(request('overview',null,{Authorization:'Bearer fixture-admin-pepper'}),f.env),e=>e.status===401);
 await assert.rejects(authenticateAdmin(request('overview',null,{Authorization:'Bearer ha_fixture'}),f.env),e=>e.status===401);
 await assert.rejects(authenticate(request('overview',null,{Authorization:'Bearer fixture-admin-pepper'}),f.env,true),e=>e.status===401);
 const logout=await handleAdminAuth(request('auth/logout',{}, {cookie}),f.env,f.mail);assert.match(logout.headers.get('set-cookie'),/Max-Age=0/);
 await assert.rejects(authenticateAdmin(request('overview',null,{cookie}),f.env),e=>e.status===401);
 assert.equal((await one(f.env,'SELECT COUNT(*) AS n FROM audit')).n,2);
});
test('only allowlisted email can request or verify and cross-origin writes are rejected',async t=>{
 const f=await setup(t);
 await assert.rejects(handleAdminAuth(request('auth/code',{email:'other@example.test'}),f.env,f.mail),e=>e.status===403);assert.equal(f.sent.length,0);
 for(const headers of [{origin:'https://evil.example'},{origin:''},{'X-Hamster-Admin':''},{'Content-Type':'text/plain'}]){
  assert.throws(()=>requireAdminOrigin(request('pool',{},headers)),e=>e.status===403);
  await assert.rejects(handleAdminAuth(request('auth/code',{email},headers),f.env,f.mail),e=>e.status===403);
 }assert.equal(f.sent.length,0);
 await assert.rejects(handleAdminAuth(request('auth/code',{email}),{...f.env,ADMIN_EMAIL:''},f.mail),e=>e.status===503);
 const c=await send(f);await assert.rejects(handleAdminAuth(request('auth/verify',{...c,email:'other@example.test'}),f.env,f.mail),e=>e.status===403);
 await assert.rejects(verifyCode(f.env,{email,challenge_id:c.challenge_id,code:c.code},'test'),/六位/);
 await assert.rejects(verify(f,{...c,challenge_id:c.challenge_id.replace('aotp_','otp_')}),/六位/);
});
test('five concurrent incorrect attempts exhaust a code, expired code cannot log in',async t=>{
 const f=await setup(t),c=await send(f),wrong=c.code==='000000'?'111111':'000000';
 const attempts=await Promise.allSettled(Array.from({length:8},()=>verify(f,{...c,code:wrong})));assert.ok(attempts.every(x=>x.status==='rejected'));
 assert.equal((await one(f.env,'SELECT attempts FROM admin_challenges WHERE id=?',c.challenge_id)).attempts,5);await assert.rejects(verify(f,c),/验证码/);
 await resetMinute(f.env);const fresh=await send(f);await run(f.env,'UPDATE admin_challenges SET expires_at=0 WHERE id=?',fresh.challenge_id);await assert.rejects(verify(f,fresh),/验证码/);
});
test('concurrent correct verifies create exactly one session; expiry and allowlist change revoke access',async t=>{
 const f=await setup(t),c=await send(f),results=await Promise.allSettled([verify(f,c),verify(f,c)]);
 assert.equal(results.filter(x=>x.status==='fulfilled').length,1);assert.equal((await one(f.env,'SELECT COUNT(*) AS n FROM admin_sessions')).n,1);
 const cookie=results.find(x=>x.status==='fulfilled').value.headers.get('set-cookie');
 await assert.rejects(authenticateAdmin(request('overview',null,{cookie}),{...f.env,ADMIN_EMAIL:'other@example.test'}),e=>e.status===401);
 await run(f.env,'UPDATE admin_sessions SET expires_at=0');await assert.rejects(authenticateAdmin(request('overview',null,{cookie}),f.env),e=>e.status===401);
 await cleanAdminAuth(f.env);assert.equal((await one(f.env,'SELECT COUNT(*) AS n FROM admin_sessions')).n,0);
});
test('resend invalidates previous code; minute, hour and day caps prevent mail floods',async t=>{
 const f=await setup(t),first=await send(f);await assert.rejects(send(f),e=>e.status===429);assert.equal(f.sent.length,1);
 await resetMinute(f.env);const second=await send(f);await assert.rejects(verify(f,first),/验证码/);await verify(f,second);
 for(let i=0;i<3;i++){await resetMinute(f.env);await send(f);}
 await resetMinute(f.env);await assert.rejects(send(f),e=>e.status===429);assert.equal(f.sent.length,5);
 await run(f.env,'DELETE FROM auth_limits');await run(f.env,'INSERT INTO auth_limits VALUES (?,20,?)',await hash('admin-send-day'),Date.now()+86400000);
 await assert.rejects(send(f),e=>e.status===429);assert.equal(f.sent.length,5);
});
test('failed mail invalidates challenge, uses no real notification endpoint, errors do not leak provider details',async t=>{
 const f=await setup(t);await assert.rejects(handleAdminAuth(request('auth/code',{email}),f.env,async()=>Response.json({secret:'private'}, {status:500})),e=>e.status===503&&!e.message.includes('private'));
 const row=await one(f.env,'SELECT consumed_at FROM admin_challenges');assert.ok(row.consumed_at);
});
test('frontend removes static credential input and stores no session token in browser storage',()=>{
 const html=fs.readFileSync(new URL('../public/index.html',import.meta.url),'utf8'),js=fs.readFileSync(new URL('../public/admin.js',import.meta.url),'utf8');
 assert.ok(html.includes('autocomplete="one-time-code"'));assert.ok(!html.includes('id="admin-token"'));assert.doesNotMatch(js,/(?:sessionStorage|localStorage)\.setItem|Authorization\s*:/);assert.ok(js.includes("api('auth/session')"));
});
