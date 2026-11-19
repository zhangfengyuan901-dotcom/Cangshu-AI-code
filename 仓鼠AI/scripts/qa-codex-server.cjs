// Isolated browser fixture. No real CLI or cloud calls.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const nativeFetch=global.fetch;
global.fetch=(input,options)=>{const url=new URL(typeof input==='string'?input:input.url||input.href);if(url.hostname!=='127.0.0.1')throw Error('Offline fixture');return nativeFetch(input,options);};
const {createApp}=require('../server.js');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'hamster-codex-ui-')),sessions=new Map(),counts={sent:0,stopped:0,piknoStarts:0};
const client={status:async()=>({installed:true,available:true,version:'0.145.0',authState:'authenticated',readOnly:true}),list:()=>[...sessions.values()],get:id=>sessions.get(id),
  create:({directory})=>{const s={id:crypto.randomUUID(),title:'本机只读分析',directory,status:'idle',messages:[]};sessions.set(s.id,s);return s;},
  send:(id,{text})=>{counts.sent++;const s=sessions.get(id);s.status='running';s.messages.push({role:'user',text});setTimeout(()=>{if(s.status==='running'){s.status='completed';s.messages.push({role:'assistant',text:'合成只读回答：已查看测试文本，未修改文件。'});}},1800);return s;},
  stop:id=>{counts.stopped++;const s=sessions.get(id);s.status='interrupted';return s;},close(){},
};
const app=createApp({configPath:path.join(root,'config.json'),taskDir:path.join(root,'tasks'),assetDir:path.join(root,'assets'),resultDir:path.join(root,'results'),codexClient:client,
  codexOptions:{chooseDirectory:async()=>root},smartVideoLauncher:{prepare:async()=>{counts.piknoStarts++;return {status:'error',message:'隔离测试未启动PIKNO对话服务'};},status:async()=>({status:'stopped'}),stop(){}},relayMode:true,
  relayClient:{context:async()=>{throw Error('Offline fixture');},catalog:async()=>({data:[]})},hypitOptions:{enabled:false},chatcutOptions:{enabled:false}});
const handlers=app.listeners('request');app.removeAllListeners('request');app.on('request',(req,res)=>{if(req.url==='/qa/counts'){res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(counts));return;}for(const handler of handlers)handler(req,res);});
app.listen(11143,'127.0.0.1',()=>console.log('http://127.0.0.1:11143'));
process.on('SIGINT',()=>app.close(()=>process.exit(0)));
