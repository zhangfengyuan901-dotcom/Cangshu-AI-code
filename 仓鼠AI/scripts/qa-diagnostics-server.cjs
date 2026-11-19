// Offline fixture: real diagnostic export, simulated startup conflict. No user data.
const fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const {createDiagnostics}=require('../diagnostics.cjs');
const root=fs.mkdtempSync(path.resolve('output/playwright/diagnostics-qa-'));
const configPath=path.join(root,'config.json');
fs.writeFileSync(configPath,JSON.stringify({apiKey:'fixture-only-private-key'}));
const diagnostics=createDiagnostics({dir:path.join(root,'logs'),exportDir:path.join(root,'exports'),configPath,version:'1.5.1-QA'});
const conflict={code:'PORT_IN_USE',message:'8000 端口已被本地程序（PID 4321）占用，工作台未启动。请确认占用程序后处理，或联系支持'};
const launcher={
  prepare:async()=>{diagnostics.failure(conflict);return {status:'error',...conflict};},
  open:async()=>{diagnostics.failure(conflict);return {status:'error',...conflict};},
  status:async()=>({status:'error',...conflict}),
  diagnose:async()=>({service:'stopped',port:{state:'occupied',port:8000,owners:[{pid:4321,name:'fixture-python'}]}}),
};
const upstream=http.createServer((_req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({data:[]}));});
upstream.listen(0,'127.0.0.1',()=>{
  require('../server').createApp({configPath,diagnostics,reporter:{capture(){}},inferenceGateway:{handle:async(_req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({activated:true,connected:true}));}},smartVideoLauncher:launcher,upstream:`http://127.0.0.1:${upstream.address().port}`,taskDir:path.join(root,'tasks'),resultDir:path.join(root,'results')})
    .listen(8790,'127.0.0.1',()=>console.log('Offline diagnostics UI QA :8790'));
});
