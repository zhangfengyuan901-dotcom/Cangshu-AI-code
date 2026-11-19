// Isolated local-workspace fixture: synthetic account and model, no cloud calls.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net');
const {spawn}=require('node:child_process');
const root=path.resolve(__dirname,'..');
const nativeFetch=global.fetch;
global.fetch=(input,options)=>{
  const target=new URL(typeof input==='string'?input:input.url||input.href);
  if(target.hostname!=='127.0.0.1')throw Error('Offline fixture blocks external requests');
  return nativeFetch(input,options);
};
const {createApp}=require('../server.js'),{createPiknoKeyStore}=require('../pikno-key-store.cjs');
const {createInferenceGateway}=require('../inference.cjs');
const directory=fs.mkdtempSync(path.join(os.tmpdir(),'hamster-local-workspace-'));
const terms={authorized:true,enabled:true,available:true,balance_sufficient:true,billing_mode:'actual_usage_v1',billing:{allow_debt:true,one_inflight_per_user:true},model:'pikno-chat-standard',price_version:'chat-cny-9-45-actual-v2',
  pricing:{currency:'CNY',input_cny_per_million:9,output_cny_per_million:45},capabilities:{text:true,image:false,pdf:false,video:false,files:false,tools:false,sse:true,verified:true},limits:{max_output_tokens:512,max_request_bytes:2097152}};
const keys=createPiknoKeyStore();keys.write({piknoChatKey:'sk-'+'d'.repeat(48),piknoUserId:7,piknoExecutionScope:'a'.repeat(64)});
const client={context:async()=>({user_id:7,group:'chat-standard'}),activateChat:async()=>structuredClone(terms),catalog:async()=>({data:[],resolve:()=>undefined})};
const gateway=createInferenceGateway({endpoint:'https://offline.invalid',pathPrefix:'/assistant',fetchImpl:async()=>Response.json(terms)});
let app,appBase,chatBase,child,failChat=false,closed=false,chatError=false;
const counts={chatSpawns:0,prepares:0,opens:0,externalOpens:0};
const launcher={
  async status(){
    if(failChat||chatError)return {status:'error',message:'合成本地服务暂不可用'};
    if(!child)return {status:'stopped'};
    try{const response=await fetch(chatBase+'/studio-api/health',{signal:AbortSignal.timeout(500)});if(response.ok)return {status:'ready',url:chatBase,progress:{percent:100}};}catch{}
    return {status:'starting',progress:{percent:40}};
  },
  async prepare(){
    counts.prepares++;
    if(failChat)return {status:'error',message:'合成本地服务暂不可用'};
    if(!child&&!closed){
      chatError=false;counts.chatSpawns++;
      child=spawn(path.join(root,'smart-video-agent','.venv','Scripts','python.exe'),[path.join(root,'scripts','qa-chat-paid-server.py')],{
        cwd:root,windowsHide:true,env:{...process.env,HAMSTER_QA_PORT:new URL(chatBase).port,HAMSTER_WALLET_API:appBase},stdio:['ignore','pipe','pipe'],
      });
      child.on('error',()=>{chatError=true;child=null;});
      child.on('exit',()=>{child=null;});
      child.stdout.on('data',()=>{});child.stderr.on('data',()=>{});
    }
    return this.status();
  },
  async open(){counts.opens++;const state=await this.status();return state.status==='ready'?{status:'ready',url:chatBase+'/chat/'}:state;},
  stop(){closed=true;child?.kill();child=null;},
};
async function freePort(){const probe=net.createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));return port;}
async function main(){
  chatBase='http://127.0.0.1:'+await freePort();
  app=createApp({relayMode:true,relayClient:client,relayKeyStore:keys,inferenceGateway:gateway,
    configPath:path.join(directory,'config.json'),resultDir:path.join(directory,'results'),taskDir:path.join(directory,'tasks'),assetDir:path.join(directory,'assets'),
    smartVideoLauncher:launcher,openBrowserImpl:()=>{counts.externalOpens++;},hypitOptions:{enabled:false},chatcutOptions:{enabled:false}});
  const handlers=app.listeners('request');app.removeAllListeners('request');
  app.on('request',(req,res)=>{
    if(req.url.startsWith('/qa/')){
      const url=new URL(req.url,appBase);
      if(url.pathname==='/qa/fail-chat'&&req.method==='POST')failChat=url.searchParams.get('value')==='1';
      res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify({...counts,failChat,appBase,chatBase}));return;
    }
    for(const handler of handlers)handler(req,res);
  });
  await new Promise(resolve=>app.listen(11140,'127.0.0.1',resolve));appBase='http://127.0.0.1:11140';
  console.log(JSON.stringify({appBase,chatBase,isolated:true}));
}
process.on('SIGINT',()=>app?app.close(()=>process.exit(0)):process.exit(0));
main().catch(error=>{console.error(error.message);launcher.stop();app?.close();process.exitCode=1;});
