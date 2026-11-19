// Local-only manual browser fixture. Never deployed; never sends real mail.
import http from 'node:http';
import fs from 'node:fs';
import {fixture} from './fixture.mjs';
import {handleAdminAuth,authenticateAdmin,requireAdminOrigin} from '../src/admin-auth.mjs';
import {adminRead} from '../src/admin.mjs';
const cleanup=[],{env}=await fixture({after:fn=>cleanup.push(fn)});
Object.assign(env,{ADMIN_EMAIL:'admin@example.test',ADMIN_TOKEN:'test-admin-only',RESEND_API_KEY:'test-mail-only',MAIL_FROM:'test@example.test'});
let lastCode='';
const server=http.createServer(async(req,res)=>{
 try{
  const origin='http://127.0.0.1:8796',path=new URL(req.url,origin).pathname;
  if(path==='/__test/code'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({code:lastCode}));return;}
  if(!path.startsWith('/admin/api/')){
   const file=path==='/'?'index.html':path.slice(1);if(!['index.html','admin.js','admin.css','favicon.svg'].includes(file)){res.writeHead(404).end();return;}
   res.setHeader('Content-Type',({'html':'text/html; charset=utf-8','js':'text/javascript; charset=utf-8','css':'text/css','svg':'image/svg+xml'})[file.split('.').pop()]);
   res.end(fs.readFileSync(new URL('../public/'+file,import.meta.url)));return;
  }
  const chunks=[];for await(const chunk of req)chunks.push(chunk);
  const request=new Request(origin+req.url,{method:req.method,headers:req.headers,...(chunks.length?{body:Buffer.concat(chunks)}:{})});
  let response=await handleAdminAuth(request,env,async(url,options)=>{lastCode=JSON.parse(options.body).text.match(/：([0-9]{6})/)[1];return Response.json({id:'test-mail'});});
  if(!response){await authenticateAdmin(request,env);if(req.method!=='GET'){requireAdminOrigin(request);throw Object.assign(Error('测试环境禁止业务写入'),{status:403});}response=Response.json(await adminRead(env,path.slice('/admin/api/'.length)));}
  res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));
 }catch(e){res.writeHead(e.status||500,{'Content-Type':'application/json'});res.end(JSON.stringify({error:e.status?e.message:'测试服务异常'}));}
});
server.listen(8796,'127.0.0.1',()=>console.log('Admin OTP fixture: http://127.0.0.1:8796 (mock email only)'));
async function close(){server.close();await Promise.all(cleanup.map(fn=>fn()));process.exit();}process.on('SIGINT',close);process.on('SIGTERM',close);
