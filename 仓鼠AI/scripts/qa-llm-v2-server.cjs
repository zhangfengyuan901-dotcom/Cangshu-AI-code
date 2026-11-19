// Synthetic account/price fixture. No customer files or network inference.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createApp}=require('../server.js');
const {createPiknoKeyStore}=require('../pikno-key-store.cjs');
const {createInferenceGateway}=require('../inference.cjs');
const directory=fs.mkdtempSync(path.join(os.tmpdir(),'hamster-llm-v2-ui-'));
const keyStore=createPiknoKeyStore(),syntheticKey='sk-'+'d'.repeat(48);
const terms={authorized:true,enabled:true,available:true,balance_sufficient:true,billing_mode:'actual_usage_v1',billing:{allow_debt:true,one_inflight_per_user:true},model:'pikno-chat-standard',price_version:'chat-cny-9-45-actual-v2',
 pricing:{currency:'CNY',input_cny_per_million:9,output_cny_per_million:45},
 capabilities:{text:true,image:false,pdf:false,video:false,files:false,tools:false,sse:true,verified:true},
 limits:{max_output_tokens:512,max_request_bytes:2097152}};
keyStore.write({piknoChatKey:syntheticKey,piknoUserId:7,piknoExecutionScope:'a'.repeat(64)});
const client={context:async(cfg,kind)=>{if(kind!=='chat'||cfg.piknoChatKey!==syntheticKey)throw Object.assign(Error('离线合成Key无效'),{statusCode:403});return {user_id:7,group:'chat-standard'};},
 activateChat:async()=>structuredClone(terms),catalog:async()=>({data:[],resolve:()=>undefined})};
const gateway=createInferenceGateway({endpoint:'https://offline.invalid',pathPrefix:'/assistant',fetchImpl:async(url)=>{
 if(String(url).endsWith('/activate'))return Response.json(terms);
 throw Error('offline fixture does not perform inference');
}});
const ready=async()=>({status:'ready',progress:{percent:100}});
const app=createApp({relayMode:true,relayClient:client,relayKeyStore:keyStore,inferenceGateway:gateway,
 configPath:path.join(directory,'config.json'),resultDir:path.join(directory,'results'),taskDir:path.join(directory,'tasks'),assetDir:path.join(directory,'assets'),
 openBrowserImpl:()=>{},smartVideoLauncher:{stop(){},prepare:ready,status:ready,open:async()=>({status:'ready',url:'about:blank'})}});
app.listen(11140,'127.0.0.1',()=>console.log('Synthetic LLM v2 account: http://127.0.0.1:11140'));
process.on('SIGINT',()=>app.close(()=>process.exit(0)));
