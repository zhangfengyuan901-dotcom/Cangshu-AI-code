const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {execFile}=require('node:child_process'),{promisify}=require('node:util');
const {createApp}=require('../server.js');
const {createPiknoKeyStore}=require('../pikno-key-store.cjs');
const {createPiknoInferenceGateway}=require('../pikno-inference.cjs');
const root=path.resolve(__dirname,'..'),python=process.env.HAMSTER_TEST_PYTHON||path.join(root,'smart-video-agent/.venv/Scripts/python.exe');
const activation={authorized:true,enabled:true,available:true,balance_sufficient:true,model:'pikno-chat-standard',price_version:'chat-cny-9-45-actual-v2',billing_mode:'actual_usage_v1',billing:{allow_debt:true,one_inflight_per_user:true},pricing:{currency:'CNY',input_cny_per_million:9,output_cny_per_million:45},capabilities:{text:true,image:false,pdf:false,video:false,files:false,tools:false,sse:true,verified:true},limits:{max_output_tokens:512}};
test('actual SDK preserves broker rejection proof; uncertainty and contradictory proof stay unknown',{skip:!fs.existsSync(python),timeout:90000},async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hamster-sdk-contract-')),store=createPiknoKeyStore(),calls=[];
 let reply;
 const gateway=createPiknoInferenceGateway({endpoint:'https://synthetic.invalid',fetchImpl:async(url)=>{calls.push(new URL(url).pathname);return String(url).endsWith('/activate')?Response.json(activation):Response.json(reply,{status:409});}});
 const app=createApp({relayMode:true,relayKeyStore:store,relayClient:{context:async()=>({user_id:7,group:'chat-standard'}),catalog:async()=>({data:[]})},inferenceGateway:gateway,configPath:path.join(dir,'config.json'),resultDir:path.join(dir,'results'),taskDir:path.join(dir,'tasks'),assetDir:path.join(dir,'assets'),smartVideoLauncher:{stop(){}}});
 await new Promise(r=>app.listen(0,'127.0.0.1',r));
 t.after(async()=>{app.closeAllConnections();await new Promise(r=>app.close(r));});
 const base='http://127.0.0.1:'+app.address().port;
 await fetch(base+'/api/config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({piknoChatKey:'sk-'+'a'.repeat(48)})});
 const context=await fetch(base+'/api/inference/context').then(r=>r.json());
 const config={MODEL_AGENT_API_KEY:'synthetic-only',MODEL_AGENT_API_BASE:base+'/api/inference/api/v3',LLM_ENDPOINT_ID:'hamster-auto',PIKNO_LLM_V2:true,EXECUTION_SCOPE:context.scope,CONFIG_REVISION:context.revision};
 const cases=[
  [{error:{code:'llm_request_pending',submission_state:'not_submitted'}},'not_submitted',false],
  [{error:{code:'llm_price_changed',submission_state:'not_submitted'}},'not_submitted',false],
  [{error:{code:'llm_rejected_before_execution',submission_state:'rejected_before_execution'}},'rejected_before_execution',false],
  [{error:{code:'llm_unknown',submission_state:'unknown'}},'unknown',false],
  [{submission_state:'not_submitted',error:{code:'llm_unknown',submission_state:'unknown'}},'unknown',false],
  [{error:{code:'llm_unknown'}},'not_submitted',true],
 ];
 for(const [payload,expected,stale] of cases){
  reply=payload;calls.length=0;
  const r=await promisify(execFile)(python,['-B',path.join(__dirname,'fixtures/paid-sdk-error-contract.py'),path.join(root,'smart-video-agent'),JSON.stringify({...config,...(stale?{CONFIG_REVISION:0}:{})}),expected],{windowsHide:true,timeout:20000,env:{...process.env,PYTHONUTF8:'1',HAMSTER_REPORT_URL:''}});
  const result=JSON.parse(r.stdout.trim());assert.equal(result.billingStatus,expected);assert.equal(result.billReads,expected==='unknown'?1:0);
  assert.equal(calls.filter(p=>p.endsWith('/responses')).length,stale?0:1);
  if(payload.error?.code==='llm_request_pending')assert.match(result.stage,/账户有一笔对话尚待核对，本次未提交/);
 }
 const ordinary=await fetch(base+'/api/config',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'}).then(r=>r.json());
 // Ordinary account routes retain their original string-error contract.
 if(ordinary.error)assert.equal(typeof ordinary.error,'string');
});
