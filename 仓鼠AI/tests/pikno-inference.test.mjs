import {test} from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {activatePikno,verifyToken} from '../cloudflare/llm-worker/src/worker.js';
import gatewayModule from '../inference.cjs';
const secret='test-only-pikno-delegation-secret-32bytes';
const env={LLM_BILLING_MODE:'legacy',PIKNO_ASSISTANT_BRIDGE_SECRET:secret,TOKEN_SIGNING_KEY:'test-only-inference-signing-secret',ARK_API_KEY:'test-only-protected-inference-key',LLM_ENDPOINTS:'ep-test-only-readiness'};
const now=()=>Math.floor(Date.now()/1000);
const sign=(claims,key=secret)=>{const payload=Buffer.from(JSON.stringify(claims)).toString('base64url');return payload+'.'+crypto.createHmac('sha256',key).update(payload).digest('base64url');};
const claims=()=>({v:1,aud:'hamster-pikno-activation',uid:7,sub:'a'.repeat(64),iat:now(),exp:now()+60});
const request=token=>new Request('https://inference.test/internal/pikno/activate',{method:'POST',headers:{Authorization:'Bearer '+token}});
test('PIKNO delegation issues a scoped 15-minute token without legacy wallet or customer credential',async()=>{
  const response=await activatePikno(request(sign(claims())),env);assert.equal(response.status,200);
  const body=await response.json(),token=await verifyToken(env,body.token);
  assert.equal(token.uid,7);assert.equal(token.v,2);assert.equal(token.aud,'hamster-pikno-inference');assert.equal(token.exp-token.iat,900);
  assert.doesNotMatch(JSON.stringify(body),/sk-|ha_|ARK_API_KEY|PIKNO_ASSISTANT_BRIDGE_SECRET/);
});
test('delegation rejects forged, expired, wrong-audience, future, oversized and foreign-scope claims',async()=>{
  for(const patch of [{exp:now()-1},{aud:'other-service'},{uid:0},{iat:now()+120,exp:now()+180},{exp:now()+3600},{sub:'sk-customer-key'}])assert.equal((await activatePikno(request(sign({...claims(),...patch})),env)).status,401);
  assert.equal((await activatePikno(request(sign(claims(),'wrong-secret')),env)).status,401);
  assert.equal((await activatePikno(request('sk-customer-key'),env)).status,401);
  assert.equal((await activatePikno(request(sign(claims())),{TOKEN_SIGNING_KEY:env.TOKEN_SIGNING_KEY})).status,503);
});
test('PIKNO activation requires configured protected inference but never sends a paid request',async()=>{
  const original=globalThis.fetch;globalThis.fetch=()=>assert.fail('readiness must not request inference');
  try{
    for(const patch of [{ARK_API_KEY:''},{ARK_API_KEY:'   '},{ARK_API_KEY:undefined},{LLM_ENDPOINTS:''},{LLM_ENDPOINTS:'private-invalid-model'},{PIKNO_ASSISTANT_BRIDGE_SECRET:''},{TOKEN_SIGNING_KEY:''},{TOKEN_SIGNING_KEY:'too-short'}]){
      const response=await activatePikno(request(sign(claims())),{...env,...patch});
      assert.equal(response.status,503);assert.deepEqual(await response.json(),{error:'activation_unavailable'});
    }
    assert.equal((await activatePikno(request(sign(claims())),env)).status,200);
  }finally{globalThis.fetch=original;}
});
test('new inference sessions reject expired and overlong lifetimes even with valid signature',async()=>{
  const tokenClaims={v:2,aud:'hamster-pikno-inference',uid:7,sub:'a'.repeat(64),iat:now(),exp:now()+900};
  for(const patch of [{exp:now()-1},{exp:now()+901},{aud:'other-service'},{uid:0}])assert.equal(await verifyToken(env,sign({...tokenClaims,...patch},env.TOKEN_SIGNING_KEY)),null);
});
test('desktop uses free PIKNO v2 metadata, never the old cloud session',async()=>{
  const calls=[],gateway=gatewayModule.createInferenceGateway({endpoint:'https://www.piknoai.com',pathPrefix:'/assistant',fetchImpl:async(url,options)=>{
    calls.push({url:String(url),options});return Response.json({authorized:true,enabled:true,available:true,balance_sufficient:true,model:'pikno-chat-standard',billing_mode:'actual_usage_v1',billing:{allow_debt:true,one_inflight_per_user:true},price_version:'chat-cny-9-45-actual-v2',pricing:{currency:'CNY',input_cny_per_million:9,output_cny_per_million:45},capabilities:{text:true,image:false,pdf:false,video:false,files:false,tools:false,sse:true,verified:true},limits:{max_output_tokens:512}});
  }});
  await gateway.activate('sk-test-customer');assert.equal(calls[0].url,'https://www.piknoai.com/assistant/v2/activate');assert.equal(calls[0].options.redirect,'error');
  assert.doesNotMatch(JSON.stringify(await gateway.status('sk-test-customer')),/sk-test|short-session/);
});
test('desktop rejects missing PIKNO Key before any activation request',async()=>{
  const gateway=gatewayModule.createInferenceGateway({endpoint:'https://www.piknoai.com',pathPrefix:'/assistant',fetchImpl:()=>assert.fail('must not fetch')});
  await assert.rejects(gateway.status(''),error=>error.statusCode===401&&/PIKNO 对话 Key/.test(error.message));
});
test('desktop identifies only the explicit disabled response as an expected unavailable state',async()=>{
  const disabled=gatewayModule.createInferenceGateway({endpoint:'https://www.piknoai.com',pathPrefix:'/assistant',fetchImpl:async()=>Response.json({error:'Assistant unavailable',code:'assistant_disabled'},{status:503})});
  await assert.rejects(disabled.status('sk-test-customer'),error=>error.statusCode===503&&error.code==='assistant_disabled'&&/尚未开放/.test(error.message));
  for(const response of [Response.json({error:'Assistant unavailable'},{status:503}),Response.json(null,{status:503}),new Response('not json',{status:503})]){
    const unavailable=gatewayModule.createInferenceGateway({endpoint:'https://www.piknoai.com',pathPrefix:'/assistant',fetchImpl:async()=>response});
    await assert.rejects(unavailable.status('sk-test-customer'),error=>error.statusCode===503&&!error.code&&/请求未完成/.test(error.message));
  }
});
