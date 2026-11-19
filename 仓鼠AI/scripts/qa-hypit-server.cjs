// Isolated, synthetic-only browser fixture. Never reads desktop credentials or contacts production.
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {execFileSync}=require('node:child_process');
const {createApp}=require('../server.js');
const {createPiknoKeyStore}=require('../pikno-key-store.cjs');
const {quoteParameters}=require('../pikno-client.cjs');
const {syntheticQuote}=require('../tests/support/relay-quote.cjs');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hamster-hypit-browser-'));
const media=require('../hypit-project.cjs').localMediaPaths(path.resolve(__dirname,'../build/hypit-host'));
if(!media)throw Error('Prepare the internal local media dependencies first');
const video=path.join(dir,'synthetic.mp4');
execFileSync(media.ffmpegPath,['-hide_banner','-loglevel','error','-f','lavfi','-i','color=c=blue:s=1280x720:r=30','-f','lavfi','-i','sine=frequency=440:sample_rate=48000','-t','4','-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p','-c:a','aac',video],{windowsHide:true,timeout:30000,stdio:'pipe'});
const store=createPiknoKeyStore();
const line={id:'main-video-abc123',name:'本地测试视频',type:'video',provider:'generate',concurrency_options:[1],billing_mode:'relay',ratios:['16:9'],resolutions:['720p'],durations:[4],max_images:0,max_videos:0,max_audios:0,line_revision:1};
const resolved={id:line.id,kind:'video',ratios:line.ratios,resolutions:line.resolutions,durations:line.durations,max_images:0,max_videos:0,max_audio:0};
const counts={submissions:0,quotes:0,uploads:0};
const client={context:async()=>({user_id:9999,group:'video-standard'}),catalog:async()=>({data:[line],resolve:id=>id===line.id?resolved:undefined}),
  quote:async(_cfg,l,payload)=>{counts.quotes++;return syntheticQuote(quoteParameters(l,payload),line.name,{line_revision:1});},
  submit:async()=>{counts.submissions++;return {id:'synthetic-task-one',status:'queued'};},query:async()=>({id:'synthetic-task-one',status:'succeeded',video_url:'https://synthetic.invalid/movie.mp4'}),
  upload:async()=>{counts.uploads++;throw Error('This synthetic browser test has no remote upload');}};
const server=createApp({relayMode:true,relayClient:client,relayKeyStore:store,configPath:path.join(dir,'config.json'),taskDir:path.join(dir,'tasks'),assetDir:path.join(dir,'assets'),resultDir:path.join(dir,'results'),diagnosticsDir:path.join(dir,'diagnostics'),taskOptions:{interval:100,tickMs:50,fetchImpl:async url=>{if(String(url)!=='https://synthetic.invalid/movie.mp4')throw Error('External requests are forbidden by the test fixture');return new Response(fs.readFileSync(video),{headers:{'Content-Type':'video/mp4'}});}},smartVideoLauncher:{stop(){},prepare:async()=>({status:'stopped'}),status:()=>({status:'stopped'})},inferenceGateway:{handle:async(_req,res)=>{res.writeHead(503,{'Content-Type':'application/json'});res.end('{"error":"对话服务暂未开放"}');}},hypitOptions:{dir:path.join(dir,'hypit-data')}});
server.listen(0,'127.0.0.1',async()=>{
  const base=`http://127.0.0.1:${server.address().port}`;
  await fetch(base+'/api/config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({piknoVideoKey:'sk-'+'s'.repeat(48)})});
  console.log(JSON.stringify({url:base,synthetic:true,counts}));
});
const close=()=>{console.log(JSON.stringify({synthetic:true,counts}));server.closeAllConnections?.();server.close(()=>process.exit(0));};
process.once('SIGINT',close);process.once('SIGTERM',close);
process.stdin.on('data',bytes=>{if(bytes.toString().trim()==='stop')close();});
