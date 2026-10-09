'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const secret=fs.readFileSync(path.join(__dirname,'private/media-ticket.env'),'utf8').trim().split('=')[1];
const body=fs.readFileSync(path.join(__dirname,'brand/pikno-logo.png'));
const id=crypto.randomBytes(16).toString('hex'),now=Math.floor(Date.now()/1000);
function sign(op,extra={}){const p=Buffer.from(JSON.stringify({v:1,aud:'pikno-relay-media',uid:1,id,op,iat:now,exp:now+300,mime:'image/png',size:body.length,...extra})).toString('base64url');return p+'.'+crypto.createHmac('sha256',secret).update(p).digest('base64url');}
async function main(){
 const url='https://www.piknoai.com/media/v1/assets/'+id;
 const opts={method:'PUT',headers:{Authorization:'Bearer '+sign('upload'),'Content-Type':'image/png','Content-Length':String(body.length)},body,signal:AbortSignal.timeout(45000)};
 let r=await fetch(url,opts);assert.equal(r.status,201,await r.text());
 r=await fetch(url,{...opts,signal:AbortSignal.timeout(15000)});assert.equal(r.status,409,await r.text());
 r=await fetch(url+'/inspect',{method:'POST',headers:{Authorization:'Bearer '+sign('inspect')},signal:AbortSignal.timeout(15000)});assert.equal(r.status,200,await r.text());
 r=await fetch(url+'?ticket='+sign('read'),{signal:AbortSignal.timeout(20000)});assert.equal(r.status,200);
 const downloaded=Buffer.from(await r.arrayBuffer());assert.equal(crypto.createHash('sha256').update(downloaded).digest('hex'),crypto.createHash('sha256').update(body).digest('hex'));
 r=await fetch(url,{signal:AbortSignal.timeout(10000)});assert.equal(r.status,401);
 r=await fetch(url+'?ticket='+sign('read',{uid:2}),{signal:AbortSignal.timeout(10000)});assert.equal(r.status,404);
 r=await fetch(url+'?ticket='+sign('read',{exp:now-1}),{signal:AbortSignal.timeout(10000)});assert.equal(r.status,403);
 const result={at:new Date().toISOString(),id,bucket:'pikno-relay-inputs',objectKey:'input/1/'+id,bytes:body.length,upload:201,overwrite:409,inspect:200,download:200,sha256Match:true,unauthorized:401,foreignOwner:404,expired:403,ecsControlPlaneTested:false};
 fs.writeFileSync(path.join(__dirname,'../../output/media-edge-live-20261008.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}
main().catch(e=>{console.error('Media edge acceptance failed:',e.message);process.exitCode=1});
