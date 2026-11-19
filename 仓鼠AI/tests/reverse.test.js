const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {createApp}=require('../server.js');
const {validateReverseVideo}=require('../reverse-media.cjs');
const {createReverseClient,publicAddress,storageURL,putStorage}=require('../reverse-client.cjs');
const {validPricing,publicBilling,reverseLink}=require('../reverse.cjs');
const pricing={available:true,configured:true,price_version:'reverse-cny-003-v1',currency:'CNY',unit_price_cny:'0.03',reservation_cny:'18.00',max_seconds:600,confirmation_required:true,billing_mode:'actual_seconds_v1'};
const options={videoType:'general',targetModel:'allRef',taskDurationSec:10};
const box=(type,...parts)=>{const body=Buffer.concat(parts),header=Buffer.alloc(8);header.writeUInt32BE(body.length+8);header.write(type,4);return Buffer.concat([header,body]);};
function video(seconds=10,handler='vide'){
  const mvhd=Buffer.alloc(20);mvhd.writeUInt32BE(1000,12);mvhd.writeUInt32BE(seconds*1000,16);const hdlr=Buffer.alloc(12);hdlr.write(handler,8);
  return Buffer.concat([box('ftyp',Buffer.from('isom0000')),box('moov',box('mvhd',mvhd),box('trak',box('mdia',box('hdlr',hdlr)))),box('mdat',Buffer.alloc(16))]);
}
const ebml=(hex,body)=>{assert.ok(body.length<127);return Buffer.concat([Buffer.from(hex,'hex'),Buffer.from([128|body.length]),body]);};
function webm(){const duration=Buffer.alloc(8);duration.writeDoubleBE(10000);return Buffer.concat([ebml('1a45dfa3',ebml('4282',Buffer.from('webm'))),ebml('18538067',Buffer.concat([ebml('1549a966',ebml('4489',duration)),ebml('1654ae6b',ebml('ae',ebml('83',Buffer.from([1]))))]))]);}
function temporary(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hamster-reverse-test-'));t.after(()=>{assert.ok(path.resolve(dir).startsWith(path.join(os.tmpdir(),'hamster-reverse-test-')));fs.rmSync(dir,{recursive:true,force:true});});return dir;}
async function fixture(t,overrides={}){
  const dir=temporary(t),calls=[],state={context:{owner:'synthetic-owner-7',scope:'a'.repeat(64),revision:7,key:'tool-test-only'},available:true,input_modes:undefined};
  const remoteId='rvt_'+'c'.repeat(32),uploadId='rvu_'+'b'.repeat(32);
  const client={
    capabilities:async key=>{calls.push(['capabilities',key]);return {available:state.available,billing:{...pricing,available:state.available},...(state.input_modes?{input_modes:state.input_modes,supported_platforms:['douyin','xiaohongshu','bilibili']}:{})};},
    quote:async()=>({...pricing,available:state.available}),
    upload:async(_key,body)=>{calls.push(['upload',body]);return {upload_id:uploadId,upload_url:'https://storage.amazonaws.com/signed?signature=private',method:'PUT',headers:{'Content-Type':body.content_type},expires_at:Math.floor(Date.now()/1000)+1800};},
    put:async(_ticket,file,metadata)=>{calls.push(['put',fs.readFileSync(file).length,metadata]);},
    submit:async(_key,body)=>{calls.push(['submit',body]);return {id:remoteId,status:'queued',billing:{status:'reserved',reservation_cny:'18.00',charged_cny:'0.00',refunded_cny:'0.00',price_version:pricing.price_version}};},
    task:async(_key,id)=>{calls.push(['task',id]);return {id:remoteId,status:'done',result:{text:'合成视频分析结果'},billing:{status:'settled',reservation_cny:'18.00',charged_cny:'0.30',refunded_cny:'17.70',charged_seconds:10,price_version:pricing.price_version}};},
    operation:async(_key,id)=>{calls.push(['operation',id]);return {id:remoteId,status:'queued'};},
    stop(){},...overrides,
  };
  const app=createApp({relayMode:true,configPath:path.join(dir,'config.json'),resultDir:path.join(dir,'results'),taskDir:path.join(dir,'tasks'),assetDir:path.join(dir,'assets'),smartVideoLauncher:{stop(){}},reverseOptions:{client,getContext:()=>({...state.context}),dir:path.join(dir,'reverse')}});
  await new Promise(resolve=>app.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{app.closeAllConnections();await new Promise(resolve=>app.close(resolve));});
  const base='http://127.0.0.1:'+app.address().port;
  const headers=()=>({'X-Hamster-Execution-Scope':state.context.scope,'X-Hamster-Config-Revision':String(state.context.revision)});
  const api=async(route,body,extra={})=>{const r=await fetch(base+'/api/reverse'+route,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json',...headers(),...extra},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:r.status,body:await r.json()};};
  const upload=async(data=video(),extra={})=>{const r=await fetch(base+'/api/reverse/uploads',{method:'POST',headers:{...headers(),'Content-Type':'video/mp4','X-Reverse-Filename':'synthetic.mp4','X-Reverse-Operation-Id':crypto.randomUUID(),...extra},body:data});return {status:r.status,body:await r.json()};};
  return {dir,app,base,api,upload,calls,state,client,headers};
}
test('real container metadata validates MP4/WebM tracks, MIME, duration and declared size',t=>{
  const dir=temporary(t),file=path.join(dir,'synthetic.bin');
  for(const [bytes,mime,seconds]of [[video(),'video/mp4',10],[webm(),'video/webm',10]]){fs.writeFileSync(file,bytes);assert.equal(validateReverseVideo(file,{contentType:mime,contentLength:bytes.length}).duration_seconds,seconds);}
  for(const [bytes,mime,size]of [[video(601),'video/mp4'],[video(10,'soun'),'video/mp4'],[video(),'video/webm'],[Buffer.alloc(60),'video/mp4'],[video(),'video/mp4',1]]){
    fs.writeFileSync(file,bytes);assert.throws(()=>validateReverseVideo(file,{contentType:mime,contentLength:size??bytes.length}),error=>error.code==='reverse_invalid_video'&&!error.message.includes(dir));
  }
});
test('storage transport rejects credentials, private addresses, non-HTTPS and redirects without forwarding API auth',async()=>{
  for(const value of ['http://storage.amazonaws.com/x','https://user:secret@storage.amazonaws.com/x','https://127.0.0.1/x','https://[::1]/x','https://metadata.internal/x','https://storage.amazonaws.com:8000/x'])assert.throws(()=>storageURL(value));
  for(const value of ['127.0.0.1','10.0.0.1','169.254.169.254','172.20.0.1','192.168.2.1','100.64.0.1','0.0.0.0','::1','fc00::1','::ffff:127.0.0.1'])assert.equal(publicAddress(value),false,value);
  assert.equal(publicAddress('8.8.8.8'),true);
  await assert.rejects(putStorage('https://storage.amazonaws.com/video','unused',{lookup:async()=>[{address:'127.0.0.1',family:4}]}));
  let put;
  const client=createReverseClient({putImpl:async(url,file,metadata)=>{put={url,file,metadata};}});
  await client.put({upload_url:'https://storage.amazonaws.com/x?secret=signed',method:'PUT',headers:{'Content-Type':'video/mp4'}},'synthetic',{contentType:'video/mp4',size:123});
  assert.deepEqual(Object.keys(put.metadata).sort(),['contentType','signal','size']);
  await assert.rejects(client.put({upload_url:'https://storage.amazonaws.com/x',method:'PUT',headers:{Authorization:'private'}},'synthetic',{contentType:'video/mp4',size:123}));
});
test('dedicated relay transport fixes API scope, omits raw errors and never retries chargeable POST',async()=>{
  const calls=[],client=createReverseClient({fetchImpl:async(target,init)=>{calls.push({target,init});return new Response('private upstream key and payload',{status:500});}});
  await assert.rejects(client.submit('synthetic-key',{operation_id:'test'}),error=>!error.message.includes('private'));
  assert.equal(calls.length,1);assert.equal(calls[0].target,'https://www.piknoai.com/v1/reverse/tasks');assert.equal(calls[0].init.redirect,'error');assert.equal(new Headers(calls[0].init.headers).get('authorization'),'Bearer synthetic-key');
});
test('unavailable pricing and missing confirmation forbid both upload execution and task submit',async t=>{
  const f=await fixture(t);f.state.available=false;
  const caps=await f.api('/capabilities');assert.equal(caps.body.available,false);assert.equal((await f.upload()).status,503);assert.equal(f.calls.filter(c=>['upload','put','submit'].includes(c[0])).length,0);
  f.state.available=true;const result=await f.api('/submit',{upload_id:'a'.repeat(32),operation_id:crypto.randomUUID(),options});assert.equal(result.status,428);assert.equal(result.body.code,'reverse_confirmation_required');
  assert.equal(validPricing({...pricing,unit_price_cny:'0.04'}),false);assert.equal(publicBilling({status:'settled',price_version:pricing.price_version,reservation_cny:'18.00',charged_cny:'99.00',refunded_cny:'0.00'}),undefined);
});
test('capabilities require an explicit link input contract while old servers remain file-compatible',async t=>{
  const f=await fixture(t),legacy=await f.api('/capabilities');
  assert.equal(legacy.body.available,true);assert.deepEqual(legacy.body.input_modes,['file']);assert.deepEqual(legacy.body.supported_platforms,[]);
  f.client.capabilities=async()=>({available:true,billing:pricing,input_modes:['file','link','other'],supported_platforms:['douyin','xiaohongshu','bilibili','untrusted']});
  const enabled=await f.api('/capabilities');assert.deepEqual(enabled.body.input_modes,['file','link']);assert.deepEqual(enabled.body.supported_platforms,['douyin','xiaohongshu','bilibili']);
  assert.equal((await f.upload()).status,201);
});
test('dedicated feature uploads real bytes directly, confirms fixed price once and persists text/billing',async t=>{
  const f=await fixture(t),cap=await f.api('/capabilities'),quote=await f.api('/quote');assert.equal(cap.body.available,true);assert.equal(quote.body.reservation_cny,'18.00');
  assert.doesNotMatch(JSON.stringify(cap.body),/tool-test-only|synthetic-owner|amazonaws/);
  const upload=await f.upload();assert.equal(upload.status,201);assert.match(upload.body.upload_id,/^[a-f0-9]{32}$/);assert.doesNotMatch(JSON.stringify(upload.body),/rvu_|https:|private/);
  const operation_id=crypto.randomUUID(),body={upload_id:upload.body.upload_id,operation_id,options,price_version:pricing.price_version,billing_confirmed:true};
  const accepted=await f.api('/submit',body);assert.equal(accepted.status,202);assert.equal(accepted.body.task.status,'queued');assert.match(accepted.body.task.id,/^[a-f0-9]{32}$/);
  const duplicate=await f.api('/submit',body);assert.equal(duplicate.body.task.id,accepted.body.task.id);assert.equal(f.calls.filter(c=>c[0]==='submit').length,1);
  const result=await f.api('/tasks/'+accepted.body.task.id);assert.equal(result.body.task.status,'succeeded');assert.equal(result.body.task.text,'合成视频分析结果');assert.equal(result.body.task.billing.charged_cny,'0.30');
  assert.doesNotMatch(JSON.stringify(result.body),/rvt_|rvu_|tool-test-only|amazonaws|private/);
  const record=JSON.parse(fs.readFileSync(path.join(f.dir,'reverse',accepted.body.task.id+'.json'),'utf8'));assert.equal(record.text,'合成视频分析结果');assert.equal(record.owner,f.state.context.owner);assert.doesNotMatch(JSON.stringify(record),/tool-test-only|amazonaws|signature/);
  assert.equal(f.calls.find(c=>c[0]==='upload')[1].duration_seconds,10);assert.equal(f.calls.find(c=>c[0]==='submit')[1].billing_confirmed,true);assert.equal(fs.readdirSync(path.join(f.dir,'reverse')).filter(n=>n.endsWith('.video.tmp')).length,0);
  const otherOp={...body,operation_id:crypto.randomUUID()};assert.equal((await f.api('/submit',otherOp)).status,409);assert.equal(f.calls.filter(c=>c[0]==='submit').length,1);
});
test('unknown submission recovers exclusively by its original operation and never replays POST',async t=>{
  const f=await fixture(t,{submit:async()=>{throw Object.assign(Error('private network details'),{statusCode:502});}}),upload=await f.upload();
  const body={upload_id:upload.body.upload_id,operation_id:crypto.randomUUID(),options,price_version:pricing.price_version,billing_confirmed:true},accepted=await f.api('/submit',body);
  assert.equal(accepted.body.task.status,'unknown');assert.doesNotMatch(accepted.body.task.error,/private/);
  await f.api('/submit',body);const recovered=await f.api('/operations/'+body.operation_id);assert.equal(recovered.body.task.status,'queued');assert.equal(f.calls.filter(c=>c[0]==='operation').length,1);
});
test('cross-account reads and stale configuration cannot upload, submit or display old asynchronous responses',async t=>{
  const f=await fixture(t),stale=f.headers();f.state.context={...f.state.context,revision:8};
  assert.equal((await f.upload(video(),stale)).status,409);assert.equal(f.calls.filter(c=>c[0]==='upload').length,0);
  const upload=await f.upload(),body={upload_id:upload.body.upload_id,operation_id:crypto.randomUUID(),options,price_version:pricing.price_version,billing_confirmed:true},accepted=await f.api('/submit',body);
  f.state.context={...f.state.context,owner:'synthetic-owner-8',scope:'d'.repeat(64),revision:9,key:'new-test-tool'};
  assert.deepEqual((await f.api('/tasks')).body.tasks,[]);assert.equal((await f.api('/tasks/'+accepted.body.task.id)).status,404);assert.equal((await f.api('/operations/'+body.operation_id)).status,404);
  assert.equal((await fetch(f.base+'/api/reverse/capabilities',{headers:{Origin:'https://foreign.example'}})).status,403);
});
test('container duration and MIME failures stop before requesting an upstream upload ticket',async t=>{
  const f=await fixture(t);
  assert.equal((await f.upload(video(601))).status,415);assert.equal((await f.upload(Buffer.from('this is not a video container'))).status,415);assert.equal(f.calls.filter(c=>c[0]==='upload').length,0);
});
test('billing accepts exact safe decimal strings from Go without discarding precision',()=>{
  const value=publicBilling({status:'settled',price_version:pricing.price_version,reservation_cny:'18.00',charged_cny:'0.900001',refunded_cny:'17.099999',charged_seconds:'30.000033'});
  assert.equal(value.charged_cny,'0.900001');assert.equal(value.refunded_cny,'17.099999');assert.equal(value.charged_seconds,30.000033);
  assert.equal(publicBilling({...value,charged_cny:'-0.1'}),undefined);assert.equal(publicBilling({...value,charged_cny:'1e1'}),undefined);assert.equal(publicBilling({...value,charged_cny:'0.1234567'}),undefined);
});
test('a concurrent repeat operation cannot dispatch a second chargeable submit',async t=>{
  const f=await fixture(t),upload=await f.upload();let entered,release;const ready=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve);const original=f.client.submit;
  f.client.submit=async(...args)=>{entered();await gate;return original(...args);};
  const body={upload_id:upload.body.upload_id,operation_id:crypto.randomUUID(),options,price_version:pricing.price_version,billing_confirmed:true},first=f.api('/submit',body);
  await ready;const second=await f.api('/submit',body);assert.equal(second.status,202);assert.equal(second.body.task.status,'submitting');release();assert.equal((await first).body.task.status,'queued');assert.equal(f.calls.filter(c=>c[0]==='submit').length,1);
});
test('unknown operation survives a fresh service process and only its original operation is queried',async t=>{
  const f=await fixture(t,{submit:async()=>{throw Error('synthetic response lost');}}),upload=await f.upload(),operation_id=crypto.randomUUID();
  const accepted=await f.api('/submit',{upload_id:upload.body.upload_id,operation_id,options,price_version:pricing.price_version,billing_confirmed:true});assert.equal(accepted.body.task.status,'unknown');
  const app=createApp({relayMode:true,configPath:path.join(f.dir,'restart-config.json'),smartVideoLauncher:{stop(){}},reverseOptions:{client:f.client,getContext:()=>({...f.state.context,revision:8}),dir:path.join(f.dir,'reverse')}});
  await new Promise(resolve=>app.listen(0,'127.0.0.1',resolve));t.after(async()=>{app.closeAllConnections();await new Promise(resolve=>app.close(resolve));});
  const response=await fetch('http://127.0.0.1:'+app.address().port+'/api/reverse/operations/'+operation_id),body=await response.json();assert.equal(body.task.id,accepted.body.task.id);assert.equal(body.task.status,'queued');assert.equal(f.calls.filter(c=>c[0]==='operation').length,1);
});
test('configuration changes while uploading hide the old upload acceptance',async t=>{
  let entered,release;const ready=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve);
  const f=await fixture(t,{put:async()=>{entered();await gate;}}),pending=f.upload();
  await ready;f.state.context={...f.state.context,revision:8,key:'synthetic-new-key'};release();const result=await pending;assert.equal(result.status,409);assert.equal(result.body.code,'reverse_configuration_changed');assert.equal(result.body.upload_id,undefined);
});
test('a malformed done response cannot turn an unfinished analysis into a successful result',async t=>{
  const f=await fixture(t,{task:async()=>({id:'rvt_'+'c'.repeat(32),status:'done',result:{text:''}})}),upload=await f.upload(),accepted=await f.api('/submit',{upload_id:upload.body.upload_id,operation_id:crypto.randomUUID(),options,price_version:pricing.price_version,billing_confirmed:true});
  const result=await f.api('/tasks/'+accepted.body.task.id);assert.equal(result.body.task.status,'queued');assert.equal(result.body.task.text,'');assert.equal(result.body.task.error,'视频分析服务暂时不可用，请稍后查询原任务');
});
test('only the exact insufficient reservation code and not_submitted pair mark a request unsubmitted',async t=>{
  for(const variant of [
    {status:402,error:{code:'reverse_reservation_insufficient',submission_state:'not_submitted'},safe:true},
    {status:402,error:{code:'reverse_reservation_insufficient',submission_state:'unknown'},safe:false},
    {status:402,error:{code:'other',submission_state:'not_submitted'},safe:false},
    {status:503,error:{code:'reverse_reservation_insufficient',submission_state:'not_submitted'},safe:false},
  ]){
    const client=createReverseClient({fetchImpl:async()=>new Response(JSON.stringify({error:{...variant.error,message:'private upstream body'}}),{status:variant.status})});
    let rejection;try{await client.submit('synthetic-key',{});}catch(error){rejection=error;}
    assert.equal(rejection?.submissionState==='not_submitted',variant.safe);assert.doesNotMatch(rejection.message,/private/);
    const f=await fixture(t,{submit:async()=>{throw rejection;}}),upload=await f.upload(),operation_id=crypto.randomUUID();
    const result=await f.api('/submit',{upload_id:upload.body.upload_id,operation_id,options,price_version:pricing.price_version,billing_confirmed:true});
    assert.equal(result.status,variant.safe?402:202);
    const record=JSON.parse(fs.readFileSync(path.join(f.dir,'reverse',fs.readdirSync(path.join(f.dir,'reverse')).filter(n=>n.endsWith('.json')).find(n=>JSON.parse(fs.readFileSync(path.join(f.dir,'reverse',n),'utf8')).kind==='task')),'utf8'));
    assert.equal(record.status,variant.safe?'failed':'unknown');assert.equal(record.submission_state,variant.safe?'not_submitted':undefined);
    if(variant.safe){const tasks=await f.api('/tasks');assert.equal(tasks.body.tasks[0].status,'failed');assert.equal(f.calls.filter(c=>c[0]==='operation').length,0);}
  }
});
test('platform URL validation matches exact raw official video paths without normalizing signed input',()=>{
  const good=[
    ['https://douyin.com/video/123','douyin'],['https://www.douyin.com/video/123/','douyin'],['https://v.douyin.com/AB_cd-123/','douyin'],
    ['https://xiaohongshu.com/explore/0123456789abcdefABCDEF01','xiaohongshu'],['https://www.xiaohongshu.com/discovery/item/0123456789abcdefABCDEF01/','xiaohongshu'],
    ['https://xhslink.com/a/Ab_C-d','xiaohongshu'],['https://xhslink.com/o/Ab_C-d/','xiaohongshu'],['https://xhslink.com/Ab_C-d','xiaohongshu'],
    ['https://bilibili.com/video/BV1AbcXYZ/','bilibili'],['https://www.bilibili.com/video/av123','bilibili'],['https://b23.tv/Ab_C-d/','bilibili'],
    ['HTTPS://WWW.DOUYIN.COM:443/video/123?token=synthetic%2Bvalue&foo=1','douyin'],
  ];
  for(const [url,platform] of good)assert.deepEqual(reverseLink(url),{url,platform});
  const bad=[
    null,{},'', 'https://www.douyin.com/', 'http://www.douyin.com/video/123','https://user@www.douyin.com/video/123',
    'https://www.douyin.com:444/video/123','https://www.douyin.com./video/123','https://sub.www.douyin.com/video/123','https://www.douyin.com.attacker.example/video/123',
    'https://127.0.0.1/video/123','https://[::1]/video/123','https://www.douyin.com/other/../video/123','https://www.douyin.com/%76ideo/123',
    'https://www.douyin.com/video/123#fragment','https://www.douyin.com/video/123?redirect=https://example.org/video',
    'https://www.douyin.com/video/123?redirect=https%3A%2F%2Fexample.org%2Fvideo','https://www.douyin.com/video/123?bad=%XX',
    'https://www.douyin.com/video/123?redirect=https%253A%252F%252Fexample.org%252Fvideo','https://www.douyin.com/video/123?newline=%0A','https://www.douyin.com/video/123?slash=%5C',
    'https://www.douyin.com/video/123?control=%09','https://www.douyin.com/video/123?control=%2509','https://www.douyin.com/video/123?control=%C2%80',
    'https://www.douyin.com/video/123?control=%25252500','https://www.douyin.com/video/123?redirect=https%2525253A%2525252F%2525252Fexample.org','https://www.douyin.com/video/123?bad=%25XX',
    'https://www.douyin.com/video/123\n','https://www.douyin.com/video/123?x=\u00a0','https://www.douyin.com/video/123?x=\u0080','https://www.douyin.com\\video/123',
    'https://www.douyin.com/video/123 https://b23.tv/other','https://www.bilibili.com/video/not-a-video-id','https://xhslink.com/a/b/c',
    'https://www.xiaohongshu.com/explore/123', 'https://v.douyin.com/'+ 'a'.repeat(129), 'https://v.douyin.com/valid?x='+ 'a'.repeat(4096),'https://v.douyin.com/valid?x='+ '中'.repeat(1400),
  ];
  for(const value of bad)assert.throws(()=>reverseLink(value),error=>error.code==='reverse_invalid_link'&&error.message==='请粘贴支持平台的单个HTTPS视频链接');
});
test('link submission requires explicit server support and exactly one input source',async t=>{
  const f=await fixture(t),url='https://www.douyin.com/video/123',body={url,operation_id:crypto.randomUUID(),options,price_version:pricing.price_version,billing_confirmed:true};
  const legacy=await f.api('/submit',body);assert.equal(legacy.status,503);assert.equal(legacy.body.code,'reverse_input_unavailable');assert.equal(f.calls.filter(c=>c[0]==='submit').length,0);
  f.state.input_modes=['file','link'];
  for(const patch of [{url:undefined},{url:'https://unsupported.example/video/1'},{upload_id:'a'.repeat(32)},{url:''}])assert.equal((await f.api('/submit',{...body,...patch})).status,400);
  assert.equal((await f.api('/submit',{...body,billing_confirmed:false})).status,428);
  assert.equal(f.calls.filter(c=>['upload','put','submit'].includes(c[0])).length,0);
});
test('link task sends one JSON control request, stores only its hash and never uploads or downloads media',async t=>{
  const f=await fixture(t);f.state.input_modes=['file','link'];
  const url='https://www.xiaohongshu.com/explore/0123456789abcdefABCDEF01?xsec_token=synthetic-private-token%2B123',body={url,operation_id:crypto.randomUUID(),options,price_version:pricing.price_version,billing_confirmed:true};
  const accepted=await f.api('/submit',body);assert.equal(accepted.status,202);assert.equal(accepted.body.task.status,'queued');
  const call=f.calls.find(c=>c[0]==='submit')[1];assert.deepEqual(call,body);assert.equal(call.upload_id,undefined);assert.equal(f.calls.filter(c=>['upload','put'].includes(c[0])).length,0);
  const record=JSON.parse(fs.readFileSync(path.join(f.dir,'reverse',accepted.body.task.id+'.json'),'utf8'));assert.equal(record.input_mode,'link');assert.match(record.fingerprint,/^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(record)+JSON.stringify(accepted.body),/https:|xsec_token|synthetic-private-token|xiaohongshu/);
  const replay=await f.api('/submit',body);assert.equal(replay.body.task.id,accepted.body.task.id);assert.equal(f.calls.filter(c=>c[0]==='submit').length,1);
  const conflict=await f.api('/submit',{...body,url:'https://v.douyin.com/different/'});assert.equal(conflict.status,409);assert.equal(f.calls.filter(c=>c[0]==='submit').length,1);
  const done=await f.api('/tasks/'+accepted.body.task.id);assert.equal(done.body.task.status,'succeeded');assert.equal(done.body.task.billing.charged_cny,'0.30');
  const newOperation=await f.api('/submit',{...body,operation_id:crypto.randomUUID()});assert.equal(newOperation.status,202);assert.notEqual(newOperation.body.task.id,accepted.body.task.id);assert.equal(f.calls.filter(c=>c[0]==='submit').length,2);
});
test('link timeout remains unknown and recovery queries the original operation without replay or source URL',async t=>{
  let submissions=0;const f=await fixture(t,{submit:async()=>{submissions++;throw Error('synthetic lost response');}});f.state.input_modes=['file','link'];
  const body={url:'https://b23.tv/synthetic/',operation_id:crypto.randomUUID(),options,price_version:pricing.price_version,billing_confirmed:true};
  const accepted=await f.api('/submit',body);assert.equal(accepted.body.task.status,'unknown');
  await f.api('/submit',body);assert.equal(submissions,1);
  const recovered=await f.api('/operations/'+body.operation_id);assert.equal(recovered.body.task.status,'queued');assert.equal(submissions,1);assert.equal(f.calls.filter(c=>c[0]==='operation').length,1);
  assert.doesNotMatch(JSON.stringify(recovered.body),/b23|https:|url/);
});
test('link configuration changes invalidate a pre-submit check before any chargeable request',async t=>{
  let entered,release;const ready=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve);
  const f=await fixture(t,{capabilities:async()=>{entered();await gate;return {available:true,billing:pricing,input_modes:['file','link'],supported_platforms:['douyin']};}});
  const pending=f.api('/submit',{url:'https://v.douyin.com/synthetic/',operation_id:crypto.randomUUID(),options,price_version:pricing.price_version,billing_confirmed:true});
  await ready;f.state.context={...f.state.context,revision:8,key:'synthetic-new-key'};release();const result=await pending;assert.equal(result.status,409);assert.equal(f.calls.filter(c=>c[0]==='submit').length,0);
});
