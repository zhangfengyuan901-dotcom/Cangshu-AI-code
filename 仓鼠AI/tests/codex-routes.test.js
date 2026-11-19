const {test}=require('node:test');
const assert=require('node:assert/strict');
const http=require('node:http');
const {createCodexRoutes}=require('../codex-routes.cjs');
async function fixture(t){
  const calls=[],session={id:'a'.repeat(32),directory:'C:\\fixture',status:'idle',messages:[]};
  const client={status:async()=>({installed:true,version:'0.145.0',authState:'authenticated'}),list:async()=>[session],get:async id=>{calls.push(['get',id]);return session;},create:async value=>{calls.push(['create',value]);return session;},send:async(id,value)=>{calls.push(['send',id,value]);return {...session,status:'running'};},stop:async id=>{calls.push(['stop',id]);return {...session,status:'interrupted'};}};
  const handle=createCodexRoutes({getClient:()=>client,chooseDirectory:async()=>{calls.push(['choose']);return 'C:\\fixture';}});
  const server=http.createServer((req,res)=>void handle(req,res,new URL(req.url,'http://127.0.0.1')));
  for(;;){await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));if(server.address().port>10080)break;await new Promise(resolve=>server.close(resolve));}
  const base='http://127.0.0.1:'+server.address().port;
  t.after(()=>{server.closeAllConnections();server.close();});
  const request=(path,body,headers={})=>new Promise((resolve,reject)=>{
    const req=http.request(base+'/api/codex'+path,{method:body===undefined?'GET':'POST',headers:{...(body===undefined?{}:{'Content-Type':'application/json'}),...headers}},res=>{
      const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>resolve({status:res.statusCode,text:async()=>Buffer.concat(chunks).toString('utf8')}));
    });req.on('error',reject);req.end(body===undefined?undefined:JSON.stringify(body));
  });
  return {request,calls,client,session,base};
}
test('local CLI routes accept fixed session operations without exposing CLI controls',async t=>{
  const f=await fixture(t);
  assert.equal((await f.request('/status')).status,200);
  assert.equal((await f.request('/sessions')).status,200);
  assert.equal((await f.request('/sessions',{directory:'C:\\fixture'})).status,201);
  assert.equal((await f.request('/sessions/'+f.session.id+'/messages',{text:'分析代码',requestId:'b'.repeat(32)})).status,202);
  assert.equal((await f.request('/sessions/'+f.session.id+'/stop',{})).status,200);
  assert.deepEqual(f.calls.map(c=>c[0]),['create','send','stop']);
  for(const extra of [{shell:true},{approvalPolicy:'never'},{executable:'evil.exe'},{env:{KEY:'fixture'}}])assert.equal((await f.request('/sessions',{directory:'C:\\fixture',...extra})).status,400);
  assert.equal(f.calls.length,3);
});
test('cross-origin, cross-site and invalid host cannot inspect CLI or open a directory chooser',async t=>{
  const f=await fixture(t);let probes=0;f.client.status=async()=>{probes++;return {};};
  for(const headers of [{Origin:'https://untrusted.invalid'},{'Sec-Fetch-Site':'cross-site'},{Host:'localhost:12345'}]){
    assert.equal((await f.request('/status',undefined,headers)).status,403);
    assert.equal((await f.request('/directory',{},headers)).status,403);
  }
  assert.equal(probes,0);assert.deepEqual(f.calls,[]);
  assert.equal((await f.request('/directory',{})).status,200);assert.deepEqual(f.calls,[['choose']]);
});
test('malformed messages and raw CLI failures are bounded and never escape routes',async t=>{
  const f=await fixture(t),route='/sessions/'+f.session.id+'/messages';
  for(const body of [{text:'x',requestId:'bad'},{text:'x'.repeat(12001),requestId:'c'.repeat(32)},{text:'x',requestId:'c'.repeat(32),cwd:'other'}])assert.equal((await f.request(route,body)).status,400);
  f.client.get=async()=>{throw Object.assign(Error('sk-fixture /private/file https://private.invalid'),{statusCode:500});};
  const response=await f.request('/sessions/'+f.session.id);assert.equal(response.status,503);assert.doesNotMatch(await response.text(),/sk-fixture|private|https:/);
  assert.deepEqual(f.calls,[]);
});
