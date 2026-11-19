const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const http=require('node:http');
const {createHypit}=require('../hypit.cjs');
const {listen}=require('./support/listen.cjs');
const {spawnSync}=require('node:child_process');

function request(url,{method='GET',body,token,origin,headers={}}={}){
  return new Promise((resolve,reject)=>{
    const data=body===undefined?null:JSON.stringify(body);
    const req=http.request(url,{method,headers:{...(data?{'Content-Type':'application/json','Content-Length':Buffer.byteLength(data)}:{}),...(token?{Authorization:'Bearer '+token}:{}),...(origin?{Origin:origin}:{}),...headers}},res=>{
      let text='';res.setEncoding('utf8');res.on('data',part=>text+=part);res.on('end',()=>{let json;try{json=JSON.parse(text);}catch{}resolve({status:res.statusCode,json,text});});
    });req.on('error',reject);if(data)req.write(data);req.end();
  });
}
async function fixture(t){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hamster-provider-http-')),ids=['a'.repeat(32),'b'.repeat(32)],calls=[],env=[];
  let owner='pikno:synthetic-a',revision=1,options,selected;
  for(const id of ids){const root=path.join(dir,'projects',id);fs.mkdirSync(root,{recursive:true});fs.writeFileSync(path.join(root,'package.json'),JSON.stringify({name:'synthetic-hypit-project',private:true}));}
  const host=createHypit({dir,getExecutionContext:()=>({owner,revision}),video:{
    handle:async(req,res,url,authority)=>{calls.push({method:req.method,path:url.pathname,search:url.search,projectId:authority.projectId,isProvider:authority.isProvider});res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({ok:true,projectId:authority.projectId}));},
    catalog:async()=>({models:[],revision}),list:async projectId=>[{projectId}],poll:async()=>({status:'unknown'}),
  },runtimeFactory:opts=>{
    options=opts;
    return {status:async()=>({state:'ready'}),listProjects:async()=>ids.map(id=>({id,label:'Synthetic project'})),projectDirectory:id=>{if(!ids.includes(id))throw Object.assign(Error('invalid synthetic project'),{statusCode:404});return path.join(dir,'projects',id);},
      startStudio:async({projectId})=>{selected=projectId;env.push(await options.envProvider());return {state:'ready',projectId,url:'http://127.0.0.1:32123'};},stop:async()=>{},dispose:async()=>{},
    };
  }});
  const server=http.createServer((req,res)=>host.handle(req,res,new URL(req.url,'http://'+req.headers.host)).catch(error=>{res.writeHead(error.statusCode||500,{'Content-Type':'application/json'});res.end(JSON.stringify({error:error.publicMessage||'synthetic failure',code:error.code}));}));
  await listen(server);const base='http://127.0.0.1:'+server.address().port;
  t.after(async()=>{host.stop();server.closeAllConnections?.();await new Promise(resolve=>server.close(resolve));fs.rmSync(dir,{recursive:true,force:true});});
  const browser=(route,body,extra={})=>request(base+route,{method:body?'POST':'GET',...(body?{body,origin:base}:{}),...extra});
  const open=async(projectId=ids[0])=>{const result=await browser('/api/hypit/studio/open',{projectId});assert.equal(result.status,200);const current=env.at(-1);assert.match(current.HAMSTER_HYPIT_BRIDGE_URL,/^http:\/\/127\.0\.0\.1:\d+$/);return current;};
  const provider=(session,route,extra={})=>request(session.HAMSTER_HYPIT_BRIDGE_URL+route,{token:session.HAMSTER_HYPIT_BRIDGE_TOKEN,...extra});
  return {ids,calls,browser,open,provider,base,changeAccount:()=>{owner='pikno:synthetic-b';revision++;},changeRevision:()=>revision++,selected:()=>selected};
}
test('dedicated Provider server rejects absent credentials and every browser Origin',async t=>{
  const f=await fixture(t),session=await f.open();
  const route='/api/hypit/video/models';
  assert.equal((await f.provider(session,route,{token:''})).status,403);
  assert.equal((await f.provider(session,route,{token:'synthetic-wrong-token'})).status,403);
  assert.equal((await f.provider(session,route,{origin:'https://unrelated.example'})).status,403);
  assert.equal((await f.provider(session,route,{origin:f.base})).status,403);
  assert.equal((await f.provider(session,route,{headers:{'Sec-Fetch-Site':'cross-site'}})).status,403);
  assert.equal((await f.provider(session,route,{headers:{Host:'unrelated.example'}})).status,403);
  assert.equal(f.calls.length,0);
});
test('Provider capability cannot confirm, import a result, access other app APIs or use unapproved methods',async t=>{
  const f=await fixture(t),session=await f.open();
  for(const [route,method] of [
    ['/api/hypit/video/confirm','POST'],['/api/hypit/video/import-result','POST'],['/api/config','POST'],
    ['/api/hypit/projects','GET'],['/api/hypit/video/operations','DELETE'],['/api/hypit/video/models','POST'],
    ['/api/hypit/video/start','GET'],['/api/hypit/video/future-sensitive-action','POST'],
  ])assert.equal((await f.provider(session,route,{method,body:method==='POST'?{}:undefined})).status,403,method+' '+route);
  assert.equal(f.calls.length,0);
});
test('Provider read, quote, start, poll and file calls are always bound to the selected project',async t=>{
  const f=await fixture(t),session=await f.open(),id='hypit-'+'c'.repeat(64);
  const routes=[['/api/hypit/video/models','GET'],['/api/hypit/video/operations?projectId='+f.ids[1],'GET'],['/api/hypit/video/quote','POST'],['/api/hypit/video/start','POST'],['/api/hypit/video/operations/'+id,'GET'],['/api/hypit/video/operations/'+id+'/file','GET']];
  for(const [route,method] of routes)assert.equal((await f.provider(session,route,{method,...(method==='POST'?{body:{projectId:f.ids[0]}}:{})})).status,200);
  assert.equal(f.calls.length,routes.length);assert.ok(f.calls.every(c=>c.projectId===f.ids[0]&&c.isProvider===true));
});
test('switching Studio project rotates the capability and old sessions cannot operate on the new project',async t=>{
  const f=await fixture(t),old=await f.open(f.ids[0]),current=await f.open(f.ids[1]);
  assert.ok(old.HAMSTER_HYPIT_BRIDGE_TOKEN!==current.HAMSTER_HYPIT_BRIDGE_TOKEN,'project switch must rotate the capability');
  assert.equal((await f.provider(old,'/api/hypit/video/quote',{method:'POST',body:{projectId:f.ids[0]}})).status,403);
  assert.equal((await f.provider(current,'/api/hypit/video/models')).status,200);
  assert.equal(f.calls.length,1);assert.equal(f.calls[0].projectId,f.ids[1]);
});
test('closing Studio immediately invalidates its Provider capability',async t=>{
  const f=await fixture(t),old=await f.open();assert.equal((await f.browser('/api/hypit/studio/close',{})).status,200);
  assert.equal((await f.provider(old,'/api/hypit/video/models')).status,403);assert.equal(f.calls.length,0);
});
for(const kind of ['owner','revision'])test('changing '+kind+' invalidates an old Provider before it can quote for a new account',async t=>{
  const f=await fixture(t),old=await f.open();kind==='owner'?f.changeAccount():f.changeRevision();
  assert.equal((await f.provider(old,'/api/hypit/video/quote',{method:'POST',body:{projectId:f.ids[0]}})).status,403);
  assert.equal(f.calls.length,0);
  const current=await f.open();assert.ok(old.HAMSTER_HYPIT_BRIDGE_TOKEN!==current.HAMSTER_HYPIT_BRIDGE_TOKEN,'account configuration changes must rotate the capability');
  assert.equal((await f.provider(old,'/api/hypit/video/models')).status,403);
  assert.equal((await f.provider(current,'/api/hypit/video/models')).status,200);
  assert.equal(f.calls.length,1);
});
test('configured project adapter and its initial Profile load in untouched Hypit CLI without execution',t=>{
  const actualHost=path.resolve(__dirname,'../build/hypit-host'),cli=path.join(actualHost,'node_modules/@hypit/hypit/bin/hypit.mjs');
  if(!fs.existsSync(cli)){t.skip('internal Hypit runtime not installed');return;}
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hamster-provider-profile-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const hostRoot=path.join(dir,'host'),projectRoot=path.join(dir,'project'),projectId='d'.repeat(32);
  fs.mkdirSync(path.join(hostRoot,'node_modules'),{recursive:true});fs.mkdirSync(projectRoot);
  // Read-only fixture links provide the real fixed peer packages without copying
  // or editing an upstream Distribution or the active app's host directory.
  fs.symlinkSync(path.join(actualHost,'node_modules/@hypit'),path.join(hostRoot,'node_modules/@hypit'),process.platform==='win32'?'junction':'dir');
  fs.writeFileSync(path.join(projectRoot,'package.json'),JSON.stringify({name:'hypit-project-offline-check',private:true,type:'module'}));
  fs.writeFileSync(path.join(projectRoot,'build.svml'),'<?svml using="@hypit/markup@1"?>\n<svml><import as="hamster" from="@hamster/hypit-video@1"/><hamster:Video id="shot" operation-id="shot-v1" line="main-video-test" prompt="A synthetic scene" duration="4" resolution="720p" ratio="16:9"/></svml>');
  fs.writeFileSync(path.join(projectRoot,'build.svrun'),'<?svml using="@hypit/markup/run@1"?>\n<svrun version="1"><author source="./build.svml"/><target output="shot.video"/></svrun>');
  const {configureProject}=require('../hypit-project.cjs'),configured=configureProject({projectRoot,projectId,hostRoot});
  const profile=JSON.parse(fs.readFileSync(configured.profilePath,'utf8'));
  assert.equal(profile.endpoints['hamster.video'].config.projectId,projectId);
  assert.equal(profile.bindings['@hamster/hypit-video@1#pikno-video'],'hamster.video');
  assert.doesNotMatch(JSON.stringify(profile),/HAMSTER_HYPIT_BRIDGE_TOKEN|synthetic-offline-capability/);
  assert.equal(fs.realpathSync(path.join(projectRoot,'node_modules/@hamster/hypit-video')),fs.realpathSync(path.join(hostRoot,'node_modules/@hamster/hypit-video')));
  const result=spawnSync(process.execPath,[cli,'plan','build.svrun','--project',projectRoot,'--runtime',configured.profilePath,'--json'],{cwd:projectRoot,encoding:'utf8',timeout:30000,windowsHide:true,env:{...process.env,HAMSTER_HYPIT_BRIDGE_URL:'http://127.0.0.1:12345',HAMSTER_HYPIT_BRIDGE_TOKEN:'synthetic-offline-capability'}});
  assert.equal(result.status,0,(result.stderr||'')+(result.stdout||''));assert.match(result.stdout,/hamster\.video/);
  const manifestBefore=fs.readFileSync(path.join(projectRoot,'package.json'),'utf8'),profileBefore=fs.readFileSync(configured.profilePath,'utf8');
  configureProject({projectRoot,projectId,hostRoot});
  assert.equal(fs.readFileSync(path.join(projectRoot,'package.json'),'utf8'),manifestBefore);assert.equal(fs.readFileSync(configured.profilePath,'utf8'),profileBefore);
});
