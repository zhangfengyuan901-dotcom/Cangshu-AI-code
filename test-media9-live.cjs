'use strict';
// One explicitly authorized paid edit, guarded by an exclusive durable journal.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const referenceCount=process.env.PIKNO_ACCEPTANCE_CASE==='single'?1:5;
const base='http://127.0.0.1:3199',dir=path.join(__dirname,'private/media9-acceptance'),journal=path.join(dir,'result-packy-format-fixed.json');
async function main(){
 fs.mkdirSync(dir,{recursive:true});fs.closeSync(fs.openSync(journal,'wx'));
 const state={started:new Date().toISOString(),paidAttempts:0};const save=()=>fs.writeFileSync(journal,JSON.stringify(state,null,2));save();
 const password=crypto.randomBytes(24).toString('base64url')+'Aa1!';
 const call=async(route,method='GET',body,headers={})=>{const r=await fetch(base+route,{method,headers:{'Content-Type':'application/json',...headers},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(600000)});return {...await r.json(),status:r.status}};
 let admin,tokenId;
 try{
  assert.equal((await call('/api/setup','POST',{username:'media9test',password,confirmPassword:password})).success,true);
  const login=await call('/api/user/login','POST',{username:'media9test',password});assert.equal(login.success,true);
  admin={Authorization:'Bearer '+login.data.access_token,'New-Api-User':String(login.data.user.id)};
  for(const [key,value]of Object.entries({RetryTimes:'0',ModelPrice:JSON.stringify({'gpt-image-2.5-flare':0.02})}))assert.equal((await call('/api/option/','PUT',{key,value},admin)).success,true);
  const cfg=JSON.parse(fs.readFileSync(path.join(__dirname,'private/packy.json'),'utf8'));
  assert.equal(cfg.baseUrl,'https://cf.api.fan');
  assert.equal((await call('/api/channel/','POST',{mode:'single',channel:{type:1,name:'isolated-edge-test',key:cfg.apiKey,base_url:cfg.baseUrl,models:cfg.model,group:'default',status:1,priority:0,weight:1,auto_ban:0}},admin)).success,true);
  assert.equal((await call('/api/token/','POST',{name:'media9-once',expired_time:Math.floor(Date.now()/1000)+1800,remain_quota:1000000,unlimited_quota:false,group:'default'},admin)).success,true);
  tokenId=(await call('/api/token/','GET',undefined,admin)).data.items.find(t=>t.name==='media9-once').id;
  const key=(await call('/api/token/'+tokenId+'/key','POST',undefined,admin)).data.key;const auth={Authorization:'Bearer '+(key.startsWith('sk-')?key:'sk-'+key)};
  const image=fs.readFileSync(path.join(__dirname,'brand/pikno-logo.png'));
  const upload=await call('/v1/media/uploads','POST',{content_type:'image/png',size:image.length},auth);assert.equal(upload.status,201);
  const ur=await fetch(upload.upload_url,{method:'PUT',headers:upload.headers,body:image});assert.equal(ur.status,201);
  const complete=await call('/v1/media/complete','POST',{upload_ticket:upload.upload_ticket},auth);assert.equal(complete.status,200);
  const range=await fetch(complete.url,{headers:{Range:'bytes=0-7'}});assert.equal(range.status,206);assert.deepEqual(Buffer.from(await range.arrayBuffer()),image.subarray(0,8));
  state.uploadBytes=image.length;state.range=206;save();
  const before=(await call('/api/user/self','GET',undefined,admin)).data.quota;
  const invalid=await call('/v1/videos','POST',{model:'sanbao/test',image_urls:['https://example.com/input.png']},auth);assert.equal(invalid.status,403);
  const multipart=await fetch(base+'/v1/images/edits',{method:'POST',headers:{...auth,'Content-Type':'multipart/form-data; boundary=test'},body:'test'});assert.equal(multipart.status,415);
  assert.equal((await call('/api/user/self','GET',undefined,admin)).data.quota,before);
  state.rejectedBeforeBilling=true;state.paidAttempts=1;state.status='submitted_do_not_retry';save();
  console.log(JSON.stringify({status:state.status,referenceCount,uploadBytes:image.length}));
  const result=await call('/v1/images/edits','POST',{model:cfg.model,prompt:'Create a small blue ceramic cup on a white studio background. Use the reference images as a color palette only. No lettering.',n:1,size:'1024x1024',quality:'high',response_format:'url',images:Array(referenceCount).fill(complete.url)},auth);
  state.httpStatus=result.status;save();
  if(result.status!==200){state.errorType=result.error?.type;state.errorCode=result.error?.code;state.errorMessage=result.error?.message;state.quotaDelta=before-(await call('/api/user/self','GET',undefined,admin)).data.quota;save();throw new Error('Paid edit returned HTTP '+result.status+'; do not retry')}
  assert.equal(result.data.length,1);assert.equal(typeof result.data[0].url,'string');assert.equal(result.data[0].b64_json,undefined);
  await new Promise(resolve=>setTimeout(resolve,2000));
  const after=(await call('/api/user/self','GET',undefined,admin)).data.quota;
  state.quotaDelta=before-after;assert.equal(state.quotaDelta,10000,'Expected isolated model price 0.02 * quota unit 500000');
  state.controlResponseBytes=JSON.stringify(result).length;assert.ok(state.controlResponseBytes<32768);
  state.status='passed';state.outputUrlReturned=true;save();
 }catch(e){state.error=e.message;state.status='failed_do_not_retry';save();throw e}
 finally{if(tokenId&&admin){state.tokenRemoved=(await call('/api/token/'+tokenId,'DELETE',undefined,admin)).success;save()}console.log(JSON.stringify(state));}
}
main().catch(e=>{console.error(e.message);process.exitCode=1});
