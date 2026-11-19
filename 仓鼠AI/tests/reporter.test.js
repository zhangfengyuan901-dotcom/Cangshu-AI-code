const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {normalizeReport,framesFromStack}=require('../report-schema.cjs');
const {createReporter}=require('../reporter.cjs');
const settle=()=>new Promise(r=>setTimeout(r,15));
function fixture(t,options={}){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hamster-report-'));const reporter=createReporter({dir,version:'1.7.39',...options});t.after(()=>{reporter.close();fs.rmSync(dir,{recursive:true,force:true});});return {dir,reporter};}
test('allowlist strips customer content, arbitrary properties, paths and provider text',()=>{
  const value=normalizeReport({version:'1.7.39',module:'third-party',code:'secret',message:'customer prompt',apiKey:'private',url:'https://private.test',frames:[{file:'C:/private/chat.py',line:10},{file:'chat.py',line:12,message:'secret'}]});
  assert.equal(value.module,'service');assert.equal(value.code,'UNEXPECTED');assert.deepEqual(value.frames,[{file:'chat.py',line:12}]);
  assert.doesNotMatch(JSON.stringify(value),/private|customer|third-party|secret/);
  assert.equal(normalizeReport(null).version,'0.0.0');
  assert.deepEqual(framesFromStack('Error: sk-private\n at run (C:\\Users\\customer\\app.js:34:12)\n at send (C:\\private\\sdk.js:1:2)'),[{file:'app.js',line:34}]);
});
test('failures persist only safe metadata and retry same report ID after restart',async t=>{
  let time=Date.now(),calls=[];
  const {dir,reporter}=fixture(t,{now:()=>time,fetchImpl:async(url,init)=>{calls.push(JSON.parse(init.body));throw Error('offline');}});
  const error=Object.assign(new Error('prompt and sk-private'),{statusCode:401});
  reporter.capture('chat',error);await settle();assert.equal(reporter.pendingCount(),1);
  reporter.capture('chat',error);await settle();assert.equal(calls.length,1);
  assert.doesNotMatch(fs.readFileSync(path.join(dir,'pending-reports.json'),'utf8'),/prompt|sk-private|Authorization/);
  reporter.close();time+=120000;
  const restored=createReporter({dir,version:'1.7.39',now:()=>time,fetchImpl:async(_url,init)=>{calls.push(JSON.parse(init.body));return new Response('{}',{status:202});}});
  await settle();restored.close();assert.equal(restored.pendingCount(),0);assert.equal(calls[0].id,calls[1].id);
});
test('report storage and transport failures never break user operation',async t=>{
  const {reporter}=fixture(t,{fetchImpl:async()=>new Response('{}',{status:400})});
  assert.doesNotThrow(()=>reporter.capture('generation',{message:'secret'}, {code:'TASK_FAILED'}));
  await settle();assert.equal(reporter.pendingCount(),0);
});

test('development collection persists sanitized failures without contacting the report service',async t=>{
  let calls=0;
  const {dir,reporter}=fixture(t,{uploadEnabled:false,fetchImpl:async()=>{calls++;throw Error('must stay offline');}});
  reporter.capture('account',new Error('sk-private customer data'),{code:'ACCOUNT_KEY_IMPORT_FAILED',httpStatus:503});
  await reporter.flush();await settle();assert.equal(calls,0);assert.equal(reporter.pendingCount(),1);
  const saved=fs.readFileSync(path.join(dir,'pending-reports.json'),'utf8');
  assert.match(saved,/ACCOUNT_KEY_IMPORT_FAILED/);assert.doesNotMatch(saved,/sk-private|customer data/);
  reporter.close();
  const restored=createReporter({dir,version:'1.7.39',uploadEnabled:false,fetchImpl:async()=>{calls++;}});
  await restored.flush();restored.close();assert.equal(calls,0);assert.equal(restored.pendingCount(),1);
});
test('local intake rejects cross-origin and oversized reports, forwards only safe fields',async t=>{
  const {dir}=fixture(t,{enabled:false}),calls=[];
  const server=require('../server.js').createApp({configPath:path.join(dir,'config.json'),resultDir:path.join(dir,'result'),taskDir:path.join(dir,'tasks'),smartVideoLauncher:{stop(){}},reporter:{capture:(...args)=>calls.push(args)}});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>server.close());
  const url=`http://127.0.0.1:${server.address().port}/api/error-report`;
  const send=(body,headers={})=>fetch(url,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body)});
  assert.equal((await send({message:'secret'},{Origin:'https://evil.test'})).status,403);
  assert.equal((await send({message:'x'.repeat(5000)})).status,413);
  assert.equal((await send({module:'chat',code:'AUTH_FAILED',prompt:'private',apiKey:'private'})).status,202);
  assert.equal(calls.length,1);assert.doesNotMatch(JSON.stringify(calls),/private|prompt|apiKey/);
});
test('startup failure and failed generation connect to reporting without raw payloads',async t=>{
  const {dir}=fixture(t,{enabled:false}),calls=[];
  const recorder={capture:(...args)=>calls.push(args)};
  const diagnostics=require('../diagnostics.cjs').createDiagnostics({dir:path.join(dir,'logs'),reporter:recorder});
  diagnostics.failure({code:'STARTUP_FAILED',exitCode:1,message:'private stack and token'});
  const tasks=require('../tasks.cjs').createTasks({dir:path.join(dir,'tasks'),getKey:()=>'',resultDir:dir,onFailure:code=>recorder.capture('generation',{}, {code})});
  const submission=tasks.begin('/api/videos',{prompt:'private prompt',model:'private model'},'private-key','request1');
  await tasks.capture(submission,{error:'private upstream failure'},400);
  assert.ok(calls.some(x=>x[0]==='startup' && x[2].code==='STARTUP_FAILED'));
  assert.ok(calls.some(x=>x[0]==='generation' && x[2].code==='TASK_FAILED'));
  assert.doesNotMatch(JSON.stringify(calls),/private|prompt|model|token/);
});
test('explicitly disabled inference is quiet while other 503 failures report once',async t=>{
  const {dir}=fixture(t,{enabled:false});
  for(const [statusCode,code,expected] of [[503,'assistant_disabled',0],[503,undefined,1],[500,'assistant_disabled',1]]){
    const calls=[];
    const name=`${statusCode}-${code || 'generic'}`;
    const error=Object.assign(new Error('safe test failure'),{statusCode,...(code?{code}: {})});
    const server=require('../server.js').createApp({
      configPath:path.join(dir,`config-${name}.json`),resultDir:path.join(dir,`result-${name}`),taskDir:path.join(dir,`tasks-${name}`),
      smartVideoLauncher:{stop(){}},reporter:{capture:(...args)=>calls.push(args)},inferenceGateway:{handle:async()=>{throw error;}},
    });
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const response=await fetch(`http://127.0.0.1:${server.address().port}/api/inference/status`);
    await response.text();assert.equal(response.status,statusCode);assert.equal(calls.length,expected);
    server.closeAllConnections?.();
    await new Promise(resolve=>server.close(resolve));
  }
});
