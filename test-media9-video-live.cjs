'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const base='http://127.0.0.1:3200',dir=path.join(__dirname,'private/media9-video-acceptance'),file=path.join(dir,'result-preflight2.json');
async function main(){
 fs.mkdirSync(dir,{recursive:true});fs.closeSync(fs.openSync(file,'wx'));
 const state={started:new Date().toISOString(),paidAttempts:0};const save=()=>fs.writeFileSync(file,JSON.stringify(state,null,2));save();
 const call=async(route,method='GET',body,headers={})=>{const r=await fetch(base+route,{method,headers:{'Content-Type':'application/json',...headers},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(90000)});return {...await r.json(),http:r.status}};
 let admin,tokenId;
 try{
  const password=crypto.randomBytes(24).toString('base64url')+'Aa1!';assert.equal((await call('/api/setup','POST',{username:'videotest',password,confirmPassword:password})).success,true);
  const login=await call('/api/user/login','POST',{username:'videotest',password});admin={Authorization:'Bearer '+login.data.access_token,'New-Api-User':String(login.data.user.id)};
  const model='sanbao/sd2_480p_real',plugin='pikno-sanbao';
  const source=fs.readFileSync(path.join(__dirname,'plugins/generated/pikno-sanbao.js'),'utf8');
  assert.equal((await call('/api/plugin/task','POST',{source,sourceSha256:crypto.createHash('sha256').update(source).digest('hex'),enabled:false},admin)).success,true);
  assert.equal((await call('/api/plugin/task/'+plugin+'/activate','POST',{version:'0.3.0'},admin)).success,true);
  for(const [key,value] of Object.entries({RetryTimes:'0','billing_setting.plugin_billing_expr':JSON.stringify({[plugin+'::'+model]:'tier("test", u("seconds") * 0.01)'})})){const result=await call('/api/option/','PUT',{key,value},admin);assert.equal(result.success,true,result.message)}
  const cfg=JSON.parse(fs.readFileSync(path.join(__dirname,'private/sanbao-release-key.json'),'utf8'));
  assert.equal((await call('/api/channel/','POST',{mode:'single',channel:{type:61,name:'isolated-video-reference',key:cfg.apiKey,base_url:'https://sanbaobeauty.com',models:model,group:'default',status:1,weight:1,auto_ban:0,setting:JSON.stringify({task_plugin_key:plugin})}},admin)).success,true);
  assert.equal((await call('/api/token/','POST',{name:'video-reference-once',expired_time:Math.floor(Date.now()/1000)+1800,remain_quota:1000000,group:'default'},admin)).success,true);
  tokenId=(await call('/api/token/','GET',undefined,admin)).data.items[0].id;const key=(await call('/api/token/'+tokenId+'/key','POST',undefined,admin)).data.key;const auth={Authorization:'Bearer '+(key.startsWith('sk-')?key:'sk-'+key)};
  const image=fs.readFileSync(path.join(__dirname,'brand/pikno-logo.png'));const ticket=await call('/v1/media/uploads','POST',{content_type:'image/png',size:image.length},auth);assert.equal(ticket.http,201);
  assert.equal((await fetch(ticket.upload_url,{method:'PUT',headers:ticket.headers,body:image})).status,201);
  const complete=await call('/v1/media/complete','POST',{upload_ticket:ticket.upload_ticket},auth);assert.equal(complete.http,200);
  const before=(await call('/api/user/self','GET',undefined,admin)).data.quota;
  state.paidAttempts=1;state.status='submitted_do_not_retry';save();
  const submitted=await call('/v1/videos','POST',{model,prompt:'A slow camera push toward the reference logo on a dark blue background, gentle studio lighting, keep the composition stable.',seconds:4,resolution:'480p',aspect_ratio:'16:9',image_urls:[complete.url]},auth);
  state.submitHTTP=submitted.http;if(!submitted.id){state.error=submitted.error?.message||submitted.message;save();throw new Error('Video not accepted, HTTP '+submitted.http)}
  state.taskId=submitted.id;state.status=submitted.status;save();console.log(JSON.stringify({taskId:state.taskId,status:state.status}));
  const deadline=Date.now()+15*60*1000;let previous='';
  while(Date.now()<deadline){await new Promise(r=>setTimeout(r,10000));const result=await call('/v1/videos/'+state.taskId,'GET',undefined,auth);assert.equal(result.http,200);state.status=result.status;save();if(previous!==state.status){console.log(JSON.stringify({status:state.status}));previous=state.status;}if(result.status==='failed')throw new Error('Upstream video task failed');if(result.status==='completed'){assert.ok(result.outputs?.some(x=>x.type==='video'&&x.url.startsWith('https://')));state.outputUrlReturned=true;await new Promise(r=>setTimeout(r,2000));state.quotaDelta=before-(await call('/api/user/self','GET',undefined,admin)).data.quota;assert.equal(state.quotaDelta,20000);state.status='passed';save();break;}}
  if(state.status!=='passed')throw new Error('Polling deadline reached; do not resubmit');
 }catch(e){state.error=e.message;save();throw e}
 finally{if(tokenId&&admin){state.tokenRemoved=(await call('/api/token/'+tokenId,'DELETE',undefined,admin)).success;save()}console.log(JSON.stringify(state));}
}
main().catch(e=>{console.error(e.message);process.exitCode=1});
