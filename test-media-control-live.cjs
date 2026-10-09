'use strict';
// Isolated local gateway + deployed Cloudflare media; never creates a paid task.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const base='http://127.0.0.1:3198';
async function main(){
 const password=crypto.randomBytes(24).toString('base64url')+'Aa1!';
 async function call(route,method='GET',body,headers={}){const r=await fetch(base+route,{method,headers:{'Content-Type':'application/json',...headers},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(30000)});const j=await r.json();return {...j,status:r.status};}
 const setup=await call('/api/setup','POST',{username:'mediatest',password,confirmPassword:password});assert.equal(setup.success,true,'Use a fresh isolated acceptance container');
 const login=await call('/api/user/login','POST',{username:'mediatest',password});assert.equal(login.success,true);
 const admin={Authorization:'Bearer '+login.data.access_token,'New-Api-User':String(login.data.user.id)};
 const created=await call('/api/token/','POST',{name:'media-acceptance',expired_time:Math.floor(Date.now()/1000)+900,remain_quota:1000,unlimited_quota:false,group:'default'},admin);assert.equal(created.success,true);
 const page=await call('/api/token/','GET',undefined,admin);const token=page.data.items.find(t=>t.name==='media-acceptance');assert.ok(token);
 try {
 const key=(await call('/api/token/'+token.id+'/key','POST',undefined,admin)).data.key;
 const auth={Authorization:'Bearer '+(key.startsWith('sk-')?key:'sk-'+key)};
 const image=fs.readFileSync(path.join(__dirname,'brand/pikno-logo.png'));
 const ticket=await call('/v1/media/uploads','POST',{content_type:'image/png',size:image.length},auth);assert.equal(ticket.status,201);
 let r=await fetch(ticket.upload_url,{method:'PUT',headers:ticket.headers,body:image,signal:AbortSignal.timeout(30000)});assert.equal(r.status,201,await r.text());
 const completed=await call('/v1/media/complete','POST',{upload_ticket:ticket.upload_ticket},auth);assert.equal(completed.status,200,completed.error);
 r=await fetch(completed.url,{signal:AbortSignal.timeout(30000)});assert.equal(r.status,200);assert.deepEqual(Buffer.from(await r.arrayBuffer()),image);
 assert.equal((await call('/v1/media/uploads','POST',{content_type:'image/png',size:image.length})).status,401);
 await call('/api/token/'+token.id,'DELETE',undefined,admin);
 assert.equal((await call('/v1/media/uploads','POST',{content_type:'image/png',size:image.length},auth)).status,401);
 console.log(JSON.stringify({localGateway:true,productionEdge:true,upload:201,complete:200,downloadHashMatches:true,missingAndRevokedToken:401,id:ticket.id}));
 } finally {await call('/api/token/'+token.id,'DELETE',undefined,admin);}
}
main().catch(e=>{console.error(e.message);process.exitCode=1});
