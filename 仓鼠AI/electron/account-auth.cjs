const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');

const ACTIONS=new Set(['login','verify','register','send-code','forgot']);
const SAFE_CODES=new Set(['INVALID_REQUEST','INVALID_INPUT','INVALID_CODE','AUTH_FLOW_INVALID','METHOD_UNAVAILABLE','CHALLENGE_REQUIRED','CONSENT_REQUIRED','ENCRYPTION_UNAVAILABLE','REQUEST_REJECTED','LOGIN_REQUIRED','ACCOUNT_CHANGED','NETWORK','RATE_LIMITED','RESULT_UNKNOWN','STORAGE_UNAVAILABLE','BUSY','FORBIDDEN']);
const problem=(code,uncertain=false)=>Object.assign(new Error(code),{code,uncertain});
const positive=value=>Number.isSafeInteger(value)&&value>0;
const fields=(value,names)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).every(key=>names.includes(key));
const username=(value,limit=20)=>typeof value==='string'&&value.trim().length>0&&[...value.trim()].length<=limit&&!/[\u0000-\u001f\u007f]/.test(value);
const email=value=>typeof value==='string'&&value.length<=254&&/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);

function encryptedPassword(password,key){
  let plaintext,secret;
  try{
    if(key?.enabled!==true||typeof key.kid!=='string'||!key.kid||key.kid.length>256||typeof key.public_key!=='string'||key.public_key.length>16384)throw Error();
    const publicKey=crypto.createPublicKey(key.public_key),bits=publicKey.asymmetricKeyDetails?.modulusLength;
    if(publicKey.asymmetricKeyType!=='rsa'||!Number.isSafeInteger(bits)||bits<2048)throw Error();
    plaintext=Buffer.from(password,'utf8');
    const rsa={key:publicKey,padding:crypto.constants.RSA_PKCS1_OAEP_PADDING,oaepHash:'sha256'};
    if(plaintext.length<=bits/8-66)return {password_encrypted:crypto.publicEncrypt(rsa,plaintext).toString('base64'),encryption_key_id:key.kid};
    secret=crypto.randomBytes(32);
    const nonce=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',secret,nonce);
    cipher.setAAD(Buffer.from('password-v2:'+key.kid));
    const ciphertext=Buffer.concat([cipher.update(plaintext),cipher.final(),cipher.getAuthTag()]);
    const wrapped=crypto.publicEncrypt({...rsa,oaepLabel:Buffer.from('password-v2')},secret);
    return {password_encrypted:['v2',wrapped.toString('base64'),nonce.toString('base64'),ciphertext.toString('base64')].join('.'),encryption_key_id:key.kid};
  }catch{throw problem('ENCRYPTION_UNAVAILABLE');}
  finally{plaintext?.fill(0);secret?.fill(0);}
}

function createNativeAuth({request,journalFile,now=Date.now,onAuthenticated=()=>{}}){
  if(typeof request!=='function'||typeof journalFile!=='string'||!path.isAbsolute(journalFile)||typeof now!=='function'||typeof onAuthenticated!=='function')throw Error('Invalid native authentication configuration');
  const file=journalFile+'.auth';
  let unknown=null,blocked=false,status=null,question=null,proof=null,verification=null,epoch=0,closed=false,inFlight=false;
  try{
    const info=fs.lstatSync(file);
    if(!info.isFile()||info.isSymbolicLink()||info.size>1024)throw Error();
    const value=JSON.parse(fs.readFileSync(file,'utf8'));
    if(!fields(value,['action','at'])||Object.keys(value).length!==2||!ACTIONS.has(value.action)||!positive(value.at))throw Error();
    unknown={action:value.action,at:value.at};
  }catch(error){if(error.code!=='ENOENT')blocked=true;}

  const current=ticket=>!closed&&ticket===epoch;
  const assertCurrent=ticket=>{if(!current(ticket))throw problem('ACCOUNT_CHANGED',true);};
  const clearMemory=()=>{epoch++;question=null;proof=null;verification=null;status=null;};
  async function savePending(action){
    if(blocked)throw problem('STORAGE_UNAVAILABLE');
    const next={action,at:now()},temporary=file+'.'+crypto.randomUUID()+'.tmp';
    if(!positive(next.at))throw problem('STORAGE_UNAVAILABLE');
    try{
      await fs.promises.mkdir(path.dirname(file),{recursive:true});
      const output=await fs.promises.open(temporary,'wx',0o600);
      try{await output.writeFile(JSON.stringify(next));await output.sync();}finally{await output.close();}
      await fs.promises.rename(temporary,file);unknown=next;
    }catch{throw problem('STORAGE_UNAVAILABLE');}
    finally{await fs.promises.unlink(temporary).catch(()=>{});}
  }
  async function clearPending(){
    if(blocked)throw problem('STORAGE_UNAVAILABLE');
    try{await fs.promises.unlink(file);}catch(error){if(error.code!=='ENOENT')throw problem('STORAGE_UNAVAILABLE');}
    unknown=null;
  }
  async function wire(route,{method='GET',body,headers={},mutation=false}={}){
    const ticket=epoch;
    try{
      const result=await request(route,{method,headers:{...headers,...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});
      assertCurrent(ticket);
      const {response,data}=result||{};
      if(!response||!data)throw problem('NETWORK',mutation);
      if(!response.ok||data.success!==true){
        const code=['AUTH_FLOW_INVALID','AUTH_SESSION_MISMATCH','AUTH_SESSION_REVOKED'].includes(data.code)?'AUTH_FLOW_INVALID':response.status===401?'LOGIN_REQUIRED':response.status===429?'RATE_LIMITED':'REQUEST_REJECTED';
        throw problem(code,mutation&&(response.status>=500||response.status===408));
      }
      return data.data;
    }catch(error){
      if(SAFE_CODES.has(error?.code)){
        if(mutation&&!['RATE_LIMITED','INVALID_REQUEST','FORBIDDEN'].includes(error.code)&&error.uncertain===undefined)error.uncertain=true;
        throw error;
      }
      throw problem('NETWORK',mutation);
    }
  }
  async function loadStatus(){
    const value=await wire('/api/status');
    if(!value||['turnstile_check','password_login_enabled','password_register_enabled','register_enabled','email_verification','password_login_encryption_enabled'].some(key=>typeof value[key]!=='boolean'))throw problem('NETWORK');
    status=Object.fromEntries(['turnstile_check','password_login_enabled','password_register_enabled','register_enabled','email_verification','password_login_encryption_enabled','passkey_login','user_agreement_enabled','privacy_policy_enabled'].map(key=>[key,value[key]===true]));
    status.auth_challenge_provider=['local-image','turnstile'].includes(value.auth_challenge_provider)?value.auth_challenge_provider:'unavailable';
    return status;
  }
  const requireStatus=async()=>status||loadStatus();
  function verificationDisplay(){
    if(verification&&verification.expires_at*1000<=now())verification=null;
    return verification?{required:true,methods:verification.methods.filter(item=>item.available).map(item=>item.method),expiresAt:verification.expires_at}:null;
  }
  function takeProof(){
    if(!status.turnstile_check)return '';
    if(status.auth_challenge_provider!=='local-image')throw problem('METHOD_UNAVAILABLE');
    if(!proof||proof.expires<=now()){proof=null;throw problem('CHALLENGE_REQUIRED');}
    const token=proof.token;proof=null;return token;
  }
  function validBundle(bundle){
    return !!bundle&&typeof bundle.access_token==='string'&&bundle.access_token.length>0&&bundle.token_type==='Bearer'
      &&Number.isFinite(bundle.access_expires_at)&&bundle.access_expires_at>now()/1000&&positive(bundle.user?.id)
      &&typeof bundle.user.username==='string'&&Number.isFinite(bundle.user.role)&&typeof bundle.session?.sid==='string'
      &&bundle.session.sid.length>0&&bundle.session.current===true;
  }
  async function adopt(bundle){
    try{
      if(!validBundle(bundle))throw problem('NETWORK',true);
      const ticket=epoch,user=await wire('/api/user/self',{headers:{Authorization:'Bearer '+bundle.access_token}});
      if(user?.id!==bundle.user.id)throw problem('ACCOUNT_CHANGED',true);
      assertCurrent(ticket);await onAuthenticated(bundle);assertCurrent(ticket);
      verification=null;question=null;proof=null;
      return {ok:true,signedIn:true};
    }catch(error){if(error&&typeof error==='object')error.uncertain=true;throw error;}
  }
  async function mutate(action,run){
    if(inFlight)throw problem('BUSY');
    if(blocked)throw problem('STORAGE_UNAVAILABLE');
    if(unknown)throw problem('RESULT_UNKNOWN');
    const ticket=epoch;inFlight=true;
    try{
      await savePending(action);assertCurrent(ticket);
      const result=await run();assertCurrent(ticket);
      await clearPending();return result;
    }catch(error){if(unknown&&!error?.uncertain&&current(ticket))await clearPending();throw error;}
    finally{inFlight=false;}
  }
  async function run(action,value){
    if(closed)throw problem('FORBIDDEN');
    const contracts={'auth-status':[],challenge:[],answer:['answer'],login:['username','password','consent'],verify:['code'],register:['username','password','email','code','consent'],'send-code':['email'],forgot:['email'],reconcile:[],restart:[],cancel:[]};
    if(!Object.hasOwn(contracts,action)||!fields(value,contracts[action]))throw problem('INVALID_REQUEST');
    if(action==='cancel'){clearMemory();return {ok:true};}
    if(inFlight)throw problem('BUSY');
    if(action==='restart'){if(blocked)throw problem('STORAGE_UNAVAILABLE');clearMemory();await clearPending();return {ok:true};}
    if(action==='auth-status')return {ok:true,status:await loadStatus(),unknown:unknown?{...unknown}:null,verification:verificationDisplay(),storageAvailable:!blocked};
    if(blocked)throw problem('STORAGE_UNAVAILABLE');
    if(action==='reconcile'){
      const prior=unknown;
      const bundle=await wire('/api/user/auth/refresh',{method:'POST'});
      const adopted=await adopt(bundle);
      if(!prior||['login','verify'].includes(prior.action)){await clearPending();return {...adopted,reconciled:!!prior,unknown:null};}
      return {...adopted,reconciled:false,unknown:{...prior}};
    }
    if(unknown)throw problem('RESULT_UNKNOWN');
    await requireStatus();
    if(action==='challenge'){
      question=null;proof=null;
      if(!status.turnstile_check)return {ok:true,required:false};
      if(status.auth_challenge_provider!=='local-image')throw problem('METHOD_UNAVAILABLE');
      const result=await wire('/api/auth/challenge');
      if(!/^[A-Za-z0-9_-]{43}$/.test(result?.id||'')||typeof result.image!=='string'||result.image.length>40000||!/^data:image\/png;base64,[A-Za-z0-9+/]+=*$/.test(result.image)||result.expires_in!==120)throw problem('NETWORK');
      question={id:result.id,expires:now()+120000};
      return {ok:true,required:true,image:result.image,expiresIn:120};
    }
    if(action==='answer'){
      if(typeof value.answer!=='string'||!/^\d{6}$/.test(value.answer))throw problem('INVALID_CODE');
      if(!question||question.expires<=now()){question=null;throw problem('CHALLENGE_REQUIRED');}
      const id=question.id;question=null;proof=null;
      const result=await wire('/api/auth/challenge/verify',{method:'POST',body:{id,answer:value.answer}});
      if(!/^local\.[A-Za-z0-9_-]{43}$/.test(result?.token||'')||result.expires_in!==120)throw problem('NETWORK');
      proof={token:result.token,expires:now()+120000};return {ok:true,verified:true,expiresIn:120};
    }
    if(action==='verify'){
      if(!verificationDisplay())throw problem('AUTH_FLOW_INVALID');
      if(!verification.methods.some(item=>item.method==='2fa'&&item.available))throw problem('METHOD_UNAVAILABLE');
      if(typeof value.code!=='string'||!/^(?:\d{6}|[A-Z\d]{4}-[A-Z\d]{4})$/i.test(value.code.trim()))throw problem('INVALID_CODE');
      return mutate('verify',async()=>adopt(await wire('/api/user/login/verify',{method:'POST',body:{flow_token:verification.flow_token,method:'2fa',code:value.code.trim()},mutation:true})));
    }
    if(action==='login'||action==='register'){
      if(!username(value.username,action==='login'?254:20)||typeof value.password!=='string'||!value.password||[...value.password].length>128)throw problem('INVALID_INPUT');
      if((status.user_agreement_enabled||status.privacy_policy_enabled)&&value.consent!==true)throw problem('CONSENT_REQUIRED');
      if(action==='login'&&!status.password_login_enabled||action==='register'&&(!status.register_enabled||!status.password_register_enabled))throw problem('METHOD_UNAVAILABLE');
      if(action==='register'&&([...value.password].length<8||value.email!==undefined&&value.email!==''&&!email(value.email)
          ||value.code!==undefined&&(typeof value.code!=='string'||value.code.length>128||/[\u0000-\u001f\u007f]/.test(value.code))
          ||status.email_verification&&(!email(value.email)||typeof value.code!=='string'||!value.code.trim())))throw problem('INVALID_INPUT');
      let passwordFields;
      if(action==='login'&&status.password_login_encryption_enabled)passwordFields=encryptedPassword(value.password,await wire('/api/user/login/encryption-key'));
      else passwordFields={password:value.password};
      const token=takeProof(),body={username:value.username.trim(),...passwordFields};
      if(action==='register'){if(value.email)body.email=value.email.trim();if(value.code)body.verification_code=value.code.trim();}
      verification=null;
      try{return await mutate(action,async()=>{
        const result=await wire('/api/user/'+action+'?'+new URLSearchParams({turnstile:token}),{method:'POST',body,mutation:true});
        if(action==='register')return {ok:true,registered:true};
        if(validBundle(result))return adopt(result);
        if(result?.require_verification===true&&typeof result.flow_token==='string'&&result.flow_token.length>0&&Number.isFinite(result.expires_at)&&result.expires_at>now()/1000&&Array.isArray(result.methods)&&result.methods.length>0&&result.methods.every(item=>item&&['2fa','passkey'].includes(item.method)&&typeof item.available==='boolean')){
          verification=result;return {ok:true,signedIn:false,verification:verificationDisplay()};
        }
        throw problem('NETWORK',true);
      });}finally{body.password='';body.password_encrypted='';passwordFields.password='';passwordFields.password_encrypted='';}
    }
    if(action==='send-code'||action==='forgot'){
      if(!email(value.email))throw problem('INVALID_INPUT');
      const token=takeProof(),route=action==='send-code'?'/api/verification':'/api/reset_password';
      return mutate(action,async()=>{await wire(route+'?'+new URLSearchParams({email:value.email.trim(),turnstile:token}),{mutation:true});return {ok:true,sent:true};});
    }
    throw problem('INVALID_REQUEST');
  }
  return {
    async command(action,value={}){
      try{return await run(action,value);}catch(error){
        if(error?.code==='AUTH_FLOW_INVALID')verification=null;
        return {ok:false,code:SAFE_CODES.has(error?.code)?error.code:'NETWORK',...(unknown?{unknown:{...unknown}}:{}),
          ...(error?.code==='RATE_LIMITED'?{retryAfterMs:Math.min(3600000,Math.max(1000,Number(error.retryAfterMs)||60000))}:{})};
      }
    },
    invalidate:clearMemory,
    dispose(){closed=true;clearMemory();},
  };
}
module.exports={createNativeAuth};
