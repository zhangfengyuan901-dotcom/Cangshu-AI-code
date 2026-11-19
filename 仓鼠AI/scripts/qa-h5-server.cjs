// Local-only UI fixture. No customer configuration, credentials or remote calls.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto'),{spawn}=require('node:child_process');
const root=path.resolve(__dirname,'..'),dir=fs.mkdtempSync(path.join(os.tmpdir(),'hamster-h5-ui-'));
const requested=Number(process.env.H5_QA_PORT||11145),requests=[],calls={quotes:0,submits:0,uploads:0,codexSend:0,codexStop:0},sessions=[];
const realFetch=global.fetch;
global.fetch=(target,...args)=>{const url=new URL(typeof target==='string'||target instanceof URL?target:target.url);if(url.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(url.hostname))throw Error('UI fixture blocks external fetch');return realFetch(target,...args);};
const {createApp}=require('../server.js'),{createPiknoClient}=require('../pikno-client.cjs'),{createPiknoKeyStore}=require('../pikno-key-store.cjs'),{syntheticQuote}=require('../tests/support/relay-quote.cjs');
const keyStore=createPiknoKeyStore();keyStore.write({piknoUserId:900001,piknoImageKey:'sk-'+'i'.repeat(48),piknoVideoKey:'sk-'+'v'.repeat(48),piknoToolKey:'sk-'+'t'.repeat(48),piknoChatKey:'sk-'+'c'.repeat(48)});
const lines=[{id:'qa-video',name:'PIKNO 视频 · 演示线路',kind:'video',line_revision:1,resolutions:['720p','1080p'],ratios:['16:9','9:16','1:1'],durations:[5,10],max_images:9,max_videos:3,max_audio:3,max_media_total:20,prices:[{resolution:'720p',unit:'second',retail_cny:'1'},{resolution:'1080p',unit:'second',retail_cny:'1'}]},
{id:'qa-image',name:'PIKNO 图片 · 演示线路',kind:'image',line_revision:1,resolutions:['1024x1024','1536x1024','1024x1536'],qualities:['auto','high'],ratios:['1:1','3:2','2:3'],max_images:9,max_videos:0,max_audio:0,max_media_total:9,prices:[{resolution:'1024x1024',unit:'image',retail_cny:'1'},{resolution:'1536x1024',unit:'image',retail_cny:'1'},{resolution:'1024x1536',unit:'image',retail_cny:'1'}]}];
const activation={authorized:true,enabled:true,available:true,balance_sufficient:true,model:'pikno-chat-standard',price_version:'chat-cny-9-45-actual-v2',billing_mode:'actual_usage_v1',billing:{allow_debt:true,one_inflight_per_user:true},pricing:{currency:'CNY',input_cny_per_million:9,output_cny_per_million:45},capabilities:{text:true,image:false,pdf:false,video:false,files:false,tools:false,sse:false,verified:true},limits:{max_output_tokens:8000}};
let base,chatBase;
const client=createPiknoClient({fetchImpl:async(target,init={})=>{
 const route=new URL(target).pathname,auth=new Headers(init.headers).get('authorization')||'';
 if(route==='/v1/client/context')return Response.json({user_id:900001,group:auth.includes('i'.repeat(48))?'image-standard':auth.includes('v'.repeat(48))?'video-standard':auth.includes('t'.repeat(48))?'tool-standard':'chat-standard'});
 if(route==='/api/pikno/catalog')return Response.json({data:{models:lines}});
 if(route==='/v1/models')return Response.json({data:lines.filter(m=>auth.includes((m.kind==='image'?'i':'v').repeat(48))).map(m=>({id:m.id}))});
 if(route==='/v1/client/chat/activate')return Response.json({success:true,data:activation});
 if(route==='/v1/client/quote'){calls.quotes++;const p=JSON.parse(init.body);return Response.json({success:true,data:syntheticQuote(p,lines.find(m=>m.id===p.model)?.name)});}
 if(route==='/v1/images/generations'||route==='/v1/videos'){calls.submits++;return Response.json(route==='/v1/videos'?{id:'qa_task_'+calls.submits,status:'queued'}:{data:[{url:base+'/__qa/pixel.png'}]});}
 if(route.startsWith('/v1/videos/'))return Response.json({id:route.split('/').pop(),status:'in_progress'});
 throw Error('Unimplemented synthetic relay route: '+route);
}});
client.subscribeCatalog=()=>()=>{};
client.activateChat=async()=>activation;
const clone=value=>structuredClone(value),png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aG6kAAAAASUVORK5CYII=','base64');
const codexClient={status:async()=>({installed:true,available:true,version:'0.145.0',authState:'authenticated'}),list:async()=>clone(sessions),get:async id=>clone(sessions.find(s=>s.id===id)),create:async({directory})=>{const session={id:crypto.randomBytes(16).toString('hex'),title:'只读演示会话',directory,status:'idle',messages:[]};sessions.unshift(session);return clone(session);},send:async(id,{text})=>{calls.codexSend++;const s=sessions.find(s=>s.id===id);s.messages.push({role:'user',text});s.status='running';setTimeout(()=>{if(s.status==='running'){s.status='completed';s.messages.push({role:'assistant',text:'这是隔离的只读界面测试回答，未调用本机CLI或云端模型。'});}},1800);return clone(s);},stop:async id=>{calls.codexStop++;const s=sessions.find(s=>s.id===id);s.status='interrupted';return clone(s);},close(){}};
const app=createApp({relayMode:true,relayClient:client,relayKeyStore:keyStore,configPath:path.join(dir,'config.json'),resultDir:path.join(dir,'results'),taskDir:path.join(dir,'tasks'),assetDir:path.join(dir,'assets'),diagnosticsDir:path.join(dir,'diagnostics'),diagnosticExportDir:path.join(dir,'diagnostic-export'),taskOptions:{tickMs:60000},mediaUploader:async(data)=>{for await(const chunk of data){}calls.uploads++;return {file:{url:base+'/__qa/pixel.png',key:'synthetic-'+calls.uploads}};},directMediaUploader:async(data)=>{for await(const chunk of data){}calls.uploads++;return {file:{url:base+'/__qa/pixel.png',key:'synthetic-'+calls.uploads}};},mediaChecker:async({kind}={})=>({kind:kind||'video',connected:true,state:'ready'}),smartVideoLauncher:{prepare:async()=>({status:'ready',progress:{percent:100}}),open:async()=>({status:'ready',url:chatBase+'/chat/'}),status:async()=>({status:'ready',url:chatBase+'/chat/'}),stop(){}},inferenceGateway:{handle:async(req,res)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({configured:true}));}},codexClient,codexOptions:{chooseDirectory:async()=>dir},hypitOptions:{enabled:false},chatcutOptions:{enabled:false},openBrowserImpl:()=>{}});
function json(res,value,status=200){res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(value));}
function log(req,res){const entry={at:Date.now(),method:req.method,path:new URL(req.url,'http://127.0.0.1').pathname};requests.push(entry);res.once('finish',()=>{entry.status=res.statusCode;});}
const handler=app.listeners('request')[0];app.removeAllListeners('request');app.on('request',(req,res)=>{log(req,res);if(req.url==='/__qa/state')return json(res,{synthetic:true,dir,requests,calls,sessions});if(req.url==='/__qa/pixel.png'){res.writeHead(200,{'Content-Type':'image/png'});return res.end(png);}return handler(req,res);});
let child,closed=false;
async function main(){
 base='http://127.0.0.1:'+requested;chatBase='http://127.0.0.1:'+(requested+1);
 await new Promise(resolve=>app.listen(requested,'127.0.0.1',resolve));
 child=spawn(path.join(root,'smart-video-agent/.venv/Scripts/python.exe'),[path.join(root,'scripts/qa-chat-paid-server.py')],{cwd:root,windowsHide:true,env:{...require('../codex-local.cjs').nativeEnvironment(),PYTHONUTF8:'1',HAMSTER_QA_PORT:String(requested+1),HAMSTER_WALLET_API:base},stdio:['ignore','pipe','pipe']});
 child.stdout.on('data',()=>{});child.stderr.on('data',()=>{});
 for(let i=0;i<100&&!closed;i++){try{if((await fetch(chatBase+'/studio-api/health',{signal:AbortSignal.timeout(300)})).ok){console.log(JSON.stringify({base,chatBase,synthetic:true,dir,pid:process.pid}));return;}}catch{}await new Promise(resolve=>setTimeout(resolve,100));}
 throw Error('Synthetic chat did not become ready');
}
function close(){closed=true;child?.kill();app.closeAllConnections();app.close();}process.once('SIGINT',close);process.once('SIGTERM',close);
main().catch(()=>{close();process.exitCode=1;});
