const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {EventEmitter}=require('node:events');
const {PassThrough,Writable}=require('node:stream');
const {createLocalCodex,nativeEnvironment,readTool,FIXED_CONFIG,verifyConfig,locateCodex,safeText}=require('../codex-local.cjs');

function fixture(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'hamster-codex-test-'));
  const directory=path.join(root,'project with spaces'),dir=path.join(root,'sessions');fs.mkdirSync(directory);
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return {root,directory,dir};
}
function fakeCli(options={}) {
  const calls=[],requests=[],replies=[],servers=[];
  function spawnImpl(file,args,spawnOptions) {
    calls.push({file,args,options:spawnOptions});
    const p=new EventEmitter();p.stdout=new PassThrough();p.stderr=new PassThrough();
    let ended=false,buffer='';
    const emit=message=>p.stdout.write(JSON.stringify(message)+'\n');
    const close=()=>{if(ended)return;ended=true;p.stdout.end();p.stderr.end();p.emit('close',0);};
    p.kill=()=>{close();return true;};
    p.stdin=new Writable({write(chunk,encoding,callback){buffer+=chunk;let i;while((i=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,i);buffer=buffer.slice(i+1);const message=JSON.parse(line);if(!message.method){replies.push(message);options.onReply?.(message,emit);continue;}
      requests.push(message);
      const reply=result=>emit({id:message.id,result});
      if(message.method==='initialize')reply({userAgent:'fake/0.145.0'});
      if(message.method==='config/read') {
        let config=structuredClone(FIXED_CONFIG);
        if(options.config)config=options.config(config,args);
        reply({config});
      }
      if(message.method==='account/read')reply({account:{type:'chatgpt',email:options.email||'synthetic@example.invalid',planType:'plus'}});
      if(message.method==='thread/start'||message.method==='thread/resume')reply({thread:{id:message.params.threadId||'synthetic-thread'},sandbox:{type:'readOnly',networkAccess:false},approvalPolicy:'never'});
      if(message.method==='turn/start') {
        reply({turn:{id:'synthetic-turn',status:'inProgress'}});
        setImmediate(()=>options.onTurn?options.onTurn(message,emit,p):complete(emit));
      }
      if(message.method==='turn/interrupt')reply({});
    }callback();},final(callback){setImmediate(close);callback();}});
    if(args[0]==='--version')setImmediate(()=>{p.stdout.write('codex-cli '+(options.version||'0.145.0')+'\n');close();});
    else if(args[0]==='login')setImmediate(()=>{p.stderr.write(options.auth||'Logged in using ChatGPT\n');close();});
    else servers.push({p,emit});
    return p;
  }
  function complete(emit,text='分析完成') {
    emit({method:'item/completed',params:{threadId:'synthetic-thread',turnId:'synthetic-turn',item:{type:'agentMessage',phase:'final_answer',text}}});
    // Actual 0.145.0 turn/completed uses params.turn.id rather than turnId.
    emit({method:'turn/completed',params:{threadId:'synthetic-thread',turn:{id:'synthetic-turn',status:'completed'}}});
  }
  return {spawnImpl,calls,requests,replies,servers,complete};
}
const tick=()=>new Promise(resolve=>setImmediate(resolve));
async function terminal(api,id) {for(let i=0;i<200;i++){const state=api.get(id);if(state.status!=='running')return state;await tick();}throw new Error('fake operation did not complete');}
function apiFor(t,fake,extra={}) {const f=fixture(t);const api=createLocalCodex({...f,spawnImpl:fake.spawnImpl,locateImpl:()=>'/synthetic/codex.exe',...extra});t.after(()=>api.close());return {...f,api};}

test('status returns only version/login enums and never inherits keys or startup injection variables',async t=>{
  const fake=fakeCli({auth:'Logged in using ChatGPT\nidentity: private@example.invalid\nBearer fake-secret'});
  const {api}=apiFor(t,fake,{env:{PATH:'C:\\Windows',SystemRoot:'C:\\Windows',USERPROFILE:'C:\\Synthetic',PIKNO_KEY:'private',OPENAI_API_KEY:'sk-private',CODEX_ACCESS_TOKEN:'private',NODE_OPTIONS:'--require malicious'}});
  const status=await api.status();assert.equal(status.authState,'authenticated');assert.equal(status.version,'0.145.0');
  assert.ok(!JSON.stringify(status).includes('private'));
  assert.deepEqual(fake.calls[0].options.env,{PATH:'C:\\Windows',SystemRoot:'C:\\Windows',USERPROFILE:'C:\\Synthetic'});
  assert.equal(fake.calls[0].options.shell,false);
});
test('missing and unsupported CLI versions fail before starting any thread',async t=>{
  const f=fixture(t),fake=fakeCli({version:'0.144.0'});
  const api=createLocalCodex({...f,spawnImpl:fake.spawnImpl,locateImpl:()=>null});assert.equal((await api.status()).errorCode,'CODEX_NOT_FOUND');await api.close();
  const {api:old,directory}=apiFor(t,fake);const s=old.create({directory});old.send(s.id,{requestId:'test-old-version',text:'你好'});
  assert.equal((await terminal(old,s.id)).errorCode,'CODEX_VERSION_UNSUPPORTED');assert.ok(!fake.requests.some(x=>x.method==='thread/start'));
});
test('session requires a real absolute directory, rejects caller thread overrides and exposes no internal IDs',async t=>{
  const {api,directory}=apiFor(t,fakeCli());
  assert.throws(()=>api.create({directory:'relative'}),e=>e.statusCode===400);
  const s=api.create({directory,threadId:'other-thread'});assert.equal(s.directory,fs.realpathSync(directory));assert.equal(s.readOnly,true);assert.ok(!('threadId' in s));
  assert.throws(()=>api.get('missing'),e=>e.statusCode===404);
});
test('completed turns, independent sessions, persisted request IDs and resume survive reload without resend',async t=>{
  const fake=fakeCli(),{api,dir,directory}=apiFor(t,fake);const s=api.create({directory});
  assert.equal(api.send(s.id,{requestId:'first-request',text:'分析项目'}).status,'running');
  const end=await terminal(api,s.id);assert.equal(end.status,'completed');assert.equal(end.messages[1].text,'分析完成');
  api.send(s.id,{requestId:'first-request',text:'分析项目'});assert.equal(fake.requests.filter(x=>x.method==='turn/start').length,1);
  assert.throws(()=>api.send(s.id,{requestId:'first-request',text:'另一个请求'}),e=>e.statusCode===409);
  await api.close();
  const next=createLocalCodex({dir,spawnImpl:fake.spawnImpl,locateImpl:()=>'/synthetic/codex.exe'});t.after(()=>next.close());
  assert.equal(next.list().length,1);assert.equal(fake.requests.filter(x=>x.method==='turn/start').length,1);
  next.send(s.id,{requestId:'second-request',text:'继续分析'});assert.equal((await terminal(next,s.id)).status,'completed');
  assert.ok(fake.requests.some(x=>x.method==='thread/resume'));
  const thread=fake.requests.find(x=>x.method==='thread/start');assert.equal(thread.params.sandbox,'read-only');assert.equal(thread.params.approvalPolicy,'never');assert.equal(thread.params.dynamicTools.length,2);
  assert.equal(fake.requests.find(x=>x.method==='turn/start').params.sandboxPolicy.networkAccess,false);
});
test('global single flight and stop cancel only owned active turn and never send again',async t=>{
  const fake=fakeCli({onTurn(){}}),{api,directory}=apiFor(t,fake);
  const s=api.create({directory}),other=api.create({directory});api.send(s.id,{requestId:'active-request',text:'分析'});
  assert.throws(()=>api.send(other.id,{requestId:'another-request',text:'分析'}),e=>e.code==='CODEX_BUSY');
  for(let i=0;i<100&&!fake.requests.some(x=>x.method==='turn/start');i++)await tick();
  await api.stop(s.id);assert.equal(api.get(s.id).status,'interrupted');assert.ok(fake.requests.some(x=>x.method==='turn/interrupt'));
  api.send(s.id,{requestId:'active-request',text:'分析'});assert.equal(fake.requests.filter(x=>x.method==='turn/start').length,1);
});
test('restart marks durable in-flight work interrupted and does not relaunch',async t=>{
  const fake=fakeCli({onTurn(){}}),{api,dir,directory}=apiFor(t,fake);const s=api.create({directory});api.send(s.id,{requestId:'durable-request',text:'分析'});
  await api.close();
  const sessionFile=path.join(dir,s.id+'.json'),snapshot=JSON.parse(fs.readFileSync(sessionFile,'utf8'));snapshot.status='running';snapshot.messages[0].status='running';fs.writeFileSync(sessionFile,JSON.stringify(snapshot));
  fs.writeFileSync(path.join(dir,'.active.lock'),JSON.stringify({pid:2147483647,id:'dead-process'}));
  const reloaded=createLocalCodex({dir,spawnImpl:fake.spawnImpl,locateImpl:()=>'/synthetic/codex.exe'});t.after(()=>reloaded.close());
  assert.equal(reloaded.get(s.id).status,'interrupted');assert.equal(reloaded.get(s.id).errorCode,'CODEX_RESTARTED');
});
test('a second live controller cannot overwrite or run another operation in the same private storage',async t=>{
  const fake=fakeCli({onTurn(){}}),{api,dir,directory}=apiFor(t,fake);const s=api.create({directory});api.send(s.id,{requestId:'controller-first',text:'分析'});
  const other=createLocalCodex({dir,spawnImpl:fake.spawnImpl,locateImpl:()=>'/synthetic/codex.exe'});t.after(()=>other.close());
  assert.equal(other.get(s.id).status,'running');assert.throws(()=>other.send(s.id,{requestId:'controller-next',text:'继续'}),e=>e.code==='CODEX_BUSY');
});
test('configured MCP servers require a second verified process with every server explicitly disabled',async t=>{
  const fake=fakeCli({config(config,args){const joined=args.join(' ');config.mcp_servers={untrusted:{enabled:joined.includes('"untrusted"={"enabled"=false')?false:true}};return config;}});
  const {api,directory}=apiFor(t,fake);const s=api.create({directory});api.send(s.id,{requestId:'mcp-safe-request',text:'分析'});
  assert.equal((await terminal(api,s.id)).status,'completed');assert.equal(fake.servers.length,2);
  assert.equal(fake.requests.find(x=>x.method==='thread/start').params.config.mcp_servers.untrusted.enabled,false);
});
test('failure to enforce read-only configuration prevents thread creation and hides all raw errors',async t=>{
  const fake=fakeCli({config(config){config.features.shell_tool=true;return config;}}),{api,directory}=apiFor(t,fake);const s=api.create({directory});
  api.send(s.id,{requestId:'unsafe-config',text:'分析'});assert.equal((await terminal(api,s.id)).errorCode,'CODEX_READONLY_UNAVAILABLE');
  assert.ok(!fake.requests.some(x=>x.method==='thread/start'));
  assert.throws(()=>verifyConfig({...FIXED_CONFIG,mcp_servers:{bad:{}}}));
});
test('all command/file/network approvals denied and only directory-bound read tools succeed',async t=>{
  let fake;
  fake=fakeCli({onTurn(request,emit){for(const [id,method] of [[201,'item/commandExecution/requestApproval'],[202,'item/fileChange/requestApproval'],[203,'item/permissions/requestApproval'],[204,'mcpServer/elicitation/request']])emit({id,method,params:{threadId:'synthetic-thread',turnId:'synthetic-turn'}});
    emit({id:205,method:'item/tool/call',params:{threadId:'synthetic-thread',turnId:'synthetic-turn',callId:'read',tool:'local_read_file',arguments:{path:'readme.txt'}}});
    emit({id:206,method:'item/tool/call',params:{threadId:'foreign-thread',turnId:'synthetic-turn',tool:'local_read_file',arguments:{path:'readme.txt'}}});
    setImmediate(()=>fake.complete(emit));}});
  const {api,directory}=apiFor(t,fake);fs.writeFileSync(path.join(directory,'readme.txt'),'hello\napi_key="do-not-share-value"');const s=api.create({directory});api.send(s.id,{requestId:'tool-read-request',text:'读取文件'});
  assert.equal((await terminal(api,s.id)).status,'completed');
  assert.deepEqual(fake.replies.find(x=>x.id===201).result,{decision:'decline'});assert.deepEqual(fake.replies.find(x=>x.id===203).result,{permissions:{},scope:'turn'});
  const result=fake.replies.find(x=>x.id===205).result;assert.equal(result.success,true);assert.ok(!JSON.stringify(result).includes('do-not-share'));
  assert.equal(fake.replies.find(x=>x.id===206).error.code,-32601);
});
test('read helper rejects traversal, credentials, binary files and external directory junctions',t=>{
  const f=fixture(t);fs.writeFileSync(path.join(f.directory,'hello.txt'),'readable');fs.writeFileSync(path.join(f.directory,'.env'),'PRIVATE=secret');fs.writeFileSync(path.join(f.directory,'config.json'),'secret');fs.writeFileSync(path.join(f.directory,'binary.dat'),Buffer.from([1,0,2]));
  assert.equal(readTool(f.directory,'local_read_file',{path:'hello.txt'}).text,'readable');
  for(const p of ['../other','.env','config.json','binary.dat'])assert.throws(()=>readTool(f.directory,'local_read_file',{path:p}));
  const outside=path.join(f.root,'outside');fs.mkdirSync(outside);fs.writeFileSync(path.join(outside,'private.txt'),'private');fs.symlinkSync(outside,path.join(f.directory,'linked'),process.platform==='win32'?'junction':'dir');
  assert.throws(()=>readTool(f.directory,'local_read_file',{path:'linked/private.txt'}));
  assert.ok(!readTool(f.directory,'local_list_directory',{path:'.'}).entries.some(e=>e.name==='linked'||e.name==='.env'));
});
test('account changes stop old session before resume or new turn; raw identity stays out of storage',async t=>{
  const fake=fakeCli(),{api,dir,directory}=apiFor(t,fake);const s=api.create({directory});api.send(s.id,{requestId:'identity-first',text:'分析'});await terminal(api,s.id);await api.close();
  const changed=fakeCli({email:'changed@example.invalid'}),next=createLocalCodex({dir,spawnImpl:changed.spawnImpl,locateImpl:()=>'/synthetic/codex.exe'});t.after(()=>next.close());
  next.send(s.id,{requestId:'identity-second',text:'继续'});assert.equal((await terminal(next,s.id)).errorCode,'CODEX_ACCOUNT_CHANGED');assert.ok(!changed.requests.some(x=>x.method==='thread/resume'));
  const disk=fs.readFileSync(path.join(dir,s.id+'.json'),'utf8');assert.ok(!disk.includes('synthetic@example.invalid'));assert.ok(!JSON.stringify(next.get(s.id)).includes('accountBinding'));
});
test('unexpected process exit and turn timeout are terminal and never replayed',async t=>{
  const fake=fakeCli({onTurn(req,emit,p){p.emit('close',1);}}),{api,directory}=apiFor(t,fake);const s=api.create({directory});api.send(s.id,{requestId:'exit-once-request',text:'分析'});assert.equal((await terminal(api,s.id)).errorCode,'CODEX_CONNECTION_CLOSED');
  const silent=fakeCli({onTurn(){}}),f=apiFor(t,silent,{turnTimeoutMs:5});const next=f.api.create({directory:f.directory});f.api.send(next.id,{requestId:'timeout-request',text:'分析'});await new Promise(resolve=>setTimeout(resolve,30));assert.equal(f.api.get(next.id).errorCode,'CODEX_TURN_TIMEOUT');
});
test('close persists interruption and kills owned processes synchronously before its promise is awaited',async t=>{
  const fake=fakeCli({onTurn(){}}),{api,dir,directory}=apiFor(t,fake),s=api.create({directory});api.send(s.id,{requestId:'close-immediately',text:'分析'});
  for(let i=0;i<100&&!fake.requests.some(x=>x.method==='turn/start');i++)await tick();
  const proc=fake.servers[0].p;let killed=false;const kill=proc.kill;proc.kill=()=>{killed=true;return kill();};
  const closing=api.close();assert.equal(killed,true);assert.equal(JSON.parse(fs.readFileSync(path.join(dir,s.id+'.json'),'utf8')).status,'interrupted');await closing;
});
test('npm command shims locate the native optional package without invoking shell or Node',t=>{
  const f=fixture(t),npm=path.join(f.root,'npm'),pkg=path.join(npm,'node_modules','@openai','codex'),native=path.join(pkg,'node_modules','@openai','codex-win32-x64');
  fs.mkdirSync(path.join(native,'vendor','x86_64-pc-windows-msvc','bin'),{recursive:true});
  fs.writeFileSync(path.join(pkg,'package.json'),JSON.stringify({name:'@openai/codex',version:'0.145.0'}));
  fs.writeFileSync(path.join(native,'package.json'),JSON.stringify({name:'@openai/codex-win32-x64',version:'0.145.0'}));
  const executable=path.join(native,'vendor','x86_64-pc-windows-msvc','bin','codex.exe');fs.writeFileSync(executable,'fixture only');
  assert.equal(locateCodex({env:{PATH:npm},platform:'win32',arch:'x64'}),fs.realpathSync(executable));
});
test('credential filenames and private-key blocks cannot be read even under ordinary text filenames',t=>{
  const f=fixture(t),pem='-----BEGIN EC PRIVATE KEY-----\nKEY_BODY\n-----END EC PRIVATE KEY-----';
  for(const name of ['id_ecdsa','id_custom','service-account.json','gcp-service-account.json','oauth_tokens.json']) {
    fs.writeFileSync(path.join(f.directory,name),'KEY_BODY');assert.throws(()=>readTool(f.directory,'local_read_file',{path:name}),e=>e.code==='CODEX_READ_DENIED');
  }
  for(const block of [pem,'-----BEGIN OPENSSH PRIVATE KEY-----\nKEY_BODY\n-----END OPENSSH PRIVATE KEY-----','-----BEGIN PRIVATE KEY-----\nKEY_BODY']) {
    fs.writeFileSync(path.join(f.directory,'notes.txt'),block);assert.throws(()=>readTool(f.directory,'local_read_file',{path:'notes.txt'}),e=>e.code==='CODEX_READ_DENIED');assert.ok(!safeText(block).includes('KEY_BODY'));
  }
  assert.ok(!readTool(f.directory,'local_list_directory',{path:'.'}).entries.some(e=>e.name==='id_ecdsa'||e.name==='service-account.json'));
});
test('renamed service-account and OAuth credential JSON is rejected by content',t=>{
  const f=fixture(t);
  for(const payload of [{type:'service_account',private_key:'KEY_BODY'},{refresh_token:'KEY_BODY'},{access_token:'KEY_BODY'}]) {
    fs.writeFileSync(path.join(f.directory,'data.txt'),JSON.stringify(payload));assert.throws(()=>readTool(f.directory,'local_read_file',{path:'data.txt'}),e=>e.code==='CODEX_READ_DENIED');
  }
});
test('close while CLI location is pending never starts a later version or authentication process',async t=>{
  const f=fixture(t),fake=fakeCli();let finishLocation;
  const api=createLocalCodex({...f,spawnImpl:fake.spawnImpl,locateImpl:()=>new Promise(resolve=>{finishLocation=resolve;})});
  const pending=api.status();await api.close();finishLocation('/synthetic/codex.exe');
  assert.equal((await pending).errorCode,'CODEX_CLOSED');assert.equal(fake.calls.length,0);
});
