const {test}=require('node:test'),assert=require('node:assert/strict');
const {createPiknoClient}=require('../pikno-client.cjs');
const {createPiknoBridge}=require('../pikno.cjs');
const {EventEmitter}=require('node:events');
const http=require('node:http');
const json=value=>new Response(JSON.stringify(value),{headers:{'Content-Type':'application/json'}});
const flush=async()=>{for(let i=0;i<20;i++)await Promise.resolve();};
const deferred=()=>{let resolve;const promise=new Promise(done=>resolve=done);return {promise,resolve};};
const revision='a'.repeat(64),nextRevision='b'.repeat(64);
function eventStream(signal){
  let streamController;const body=new ReadableStream({start(controller){streamController=controller;signal.addEventListener('abort',()=>controller.error(Error('aborted')),{once:true});}});
  return {response:new Response(body,{headers:{'Content-Type':'text/event-stream'}}),send:text=>streamController.enqueue(new TextEncoder().encode(text)),close:()=>streamController.close()};
}

test('all local subscribers share one fixed public upstream GET without credentials and release it when hidden',async()=>{
  const calls=[],streams=[],received=[[],[]];
  const client=createPiknoClient({fetchImpl:async(target,init)=>{calls.push({target,init});const stream=eventStream(init.signal);streams.push(stream);return stream.response;}});
  const off1=client.subscribeCatalog(value=>received[0].push(value)),off2=client.subscribeCatalog(value=>received[1].push(value));await flush();
  assert.equal(calls.length,1);assert.equal(calls[0].target,'https://www.piknoai.com/api/pikno/catalog/events');
  assert.equal(calls[0].init.method,'GET');assert.equal(calls[0].init.credentials,'omit');assert.equal(calls[0].init.redirect,'error');
  assert.deepEqual(Object.keys(calls[0].init.headers),['Accept']);
  streams[0].send('event: catalog-change\r\ndata: {"revision":"'+revision+'","private":"discard"}\r\n\r\n');await flush();
  assert.deepEqual(received,[[{revision}],[{revision}]]);
  streams[0].send('event: catalog-change\ndata: {"revision":"'+revision+'"}\n\nevent: catalog-change\ndata: {"revision":"invalid"}\n\n');await flush();assert.equal(received[0].length,1);
  off1();assert.equal(calls[0].init.signal.aborted,false);off2();assert.equal(calls[0].init.signal.aborted,true);client.stop();
});

test('disconnect failures use bounded exponential backoff and stop cancels a pending reconnect',async()=>{
  const timers=[],cleared=[];let attempts=0;
  const client=createPiknoClient({fetchImpl:async()=>{attempts++;throw Error('private network response');},setTimer:(fn,ms)=>{timers.push({fn,ms});return timers.length;},clearTimer:id=>cleared.push(id)});
  client.subscribeCatalog(()=>{});await flush();assert.equal(timers[0].ms,1000);
  for(let i=0;i<6;i++){timers[i].fn();await flush();}
  assert.deepEqual(timers.map(timer=>timer.ms),[1000,2000,4000,8000,16000,30000,30000]);assert.equal(attempts,7);
  client.stop();assert.deepEqual(cleared,[7]);
});

test('rejected catalog responses close their real loopback streams before reconnecting',async t=>{
  const replies=[{status:503,type:'text/plain'},{status:200,type:'application/json'}],closures=[],timers=[],signals=[];
  let requests=0;
  const server=http.createServer((req,res)=>{
    const index=requests++,reply=replies[index];
    if(!reply){res.writeHead(500);res.end();return;}
    const closed=deferred();closures.push(closed.promise);
    res.once('close',closed.resolve);res.writeHead(reply.status,{'Content-Type':reply.type});res.write('synthetic unavailable');
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const client=createPiknoClient({endpoint:'http://127.0.0.1:'+server.address().port,
    fetchImpl:(target,init)=>{signals.push(init.signal);return fetch(target,init);},
    setTimer:(fn,ms)=>{timers.push({fn,ms});reconnected.resolve();return timers.length;},clearTimer:()=>{}});
  let reconnected=deferred();
  t.after(async()=>{client.stop();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  client.subscribeCatalog(()=>{});
  for(let index=0;index<replies.length;index++){
    await reconnected.promise;
    assert.equal(signals[index].aborted,true,'invalid response must be aborted before retry');
    await closures[index];
    assert.equal(requests,index+1);assert.equal(timers[index].ms,1000*2**index);
    if(index+1<replies.length){reconnected=deferred();timers[index].fn();}
  }
});

test('a revision invalidates cached and already pending directories before they can restore a removed line',async()=>{
  const old=deferred(),streams=[];let publicReads=0,modelReads=0;
  const line={id:'pikno-video-test',kind:'video',name:'Published video',resolutions:['720p'],ratios:['16:9'],durations:[5]};
  const client=createPiknoClient({fetchImpl:async(target,init)=>{
    if(target.endsWith('/events')){const stream=eventStream(init.signal);streams.push(stream);return stream.response;}
    if(target.endsWith('/api/pikno/catalog')){publicReads++;if(publicReads===1)return old.promise;return json({data:{models:[]}});}
    if(target.endsWith('/v1/models')){modelReads++;return json({data:[{id:line.id}]});}
    assert.fail('unexpected request');
  }});
  const off=client.subscribeCatalog(()=>{});await flush();
  const pending=client.catalog({piknoVideoKey:'synthetic-only'});await flush();
  streams[0].send('event: catalog-change\ndata: {"revision":"'+revision+'"}\n\n');await flush();old.resolve(json({data:{models:[line]}}));
  assert.equal((await pending).data.length,0);assert.equal(publicReads,2);
  await client.catalog({piknoVideoKey:'synthetic-only'});assert.equal(publicReads,2);
  streams[0].send('event: catalog-change\ndata: {"revision":"'+nextRevision+'"}\n\n');await flush();
  await client.catalog({piknoVideoKey:'synthetic-only'});assert.equal(publicReads,3);assert.ok(modelReads>=3);off();client.stop();
});

test('the loopback event route needs no account key, filters payloads and rejects foreign origins',async()=>{
  let listener,subscribed=0,unsubscribed=0;
  const bridge=createPiknoBridge({client:{subscribeCatalog:fn=>{listener=fn;subscribed++;return ()=>unsubscribed++;}},keyStore:{read:()=>assert.fail('event stream must not read customer keys')}});
  const request={method:'GET',headers:{host:'127.0.0.1:12345'}},response=new EventEmitter();response.writeHead=(status,headers)=>{response.status=status;response.headers=headers;};response.body='';response.write=text=>{response.body+=text;return true;};
  await bridge.handle(request,response,new URL('http://127.0.0.1:12345/api/relay/catalog/events'));
  assert.equal(response.status,200);assert.equal(subscribed,1);listener({revision,private:'discard'});listener({revision:'invalid'});
  assert.match(response.body,/event: catalog-change/);assert.doesNotMatch(response.body,/private|discard|invalid/);response.emit('close');assert.equal(unsubscribed,1);
  await assert.rejects(bridge.handle({...request,headers:{...request.headers,origin:'https://foreign.test'}},response,new URL('http://127.0.0.1:12345/api/relay/catalog/events')),error=>error.statusCode===403);
  assert.equal(subscribed,1);
});

test('two real loopback pages receive a shared revision stream and closing both stops the only upstream request',async t=>{
  const upstream=[],streams=[];
  const client=createPiknoClient({fetchImpl:async(target,init)=>{upstream.push({target,init});const stream=eventStream(init.signal);streams.push(stream);return stream.response;}});
  const bridge=createPiknoBridge({client,keyStore:{read:()=>assert.fail('public notification cannot access account keys')}});
  const server=http.createServer((req,res)=>{bridge.handle(req,res,new URL(req.url,'http://localhost')).catch(()=>{res.writeHead(403);res.end();});});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const controllers=[new AbortController(),new AbortController()];
  t.after(async()=>{controllers.forEach(controller=>controller.abort());client.stop();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  const url='http://127.0.0.1:'+server.address().port+'/api/relay/catalog/events';
  const pages=await Promise.all(controllers.map(controller=>fetch(url,{signal:controller.signal})));
  assert.ok(pages.every(page=>page.status===200));assert.equal(upstream.length,1);
  const readers=pages.map(page=>page.body.getReader());await Promise.all(readers.map(reader=>reader.read()));
  streams[0].send('event: catalog-change\ndata: {"revision":"'+revision+'"}\n\n');
  const events=await Promise.all(readers.map(reader=>reader.read()));
  for(const event of events)assert.equal(new TextDecoder().decode(event.value),'event: catalog-change\ndata: '+JSON.stringify({revision})+'\n\n');
  controllers.forEach(controller=>controller.abort());for(let i=0;i<20&&!upstream[0].init.signal.aborted;i++)await new Promise(setImmediate);
  assert.equal(upstream[0].init.signal.aborted,true);assert.equal(upstream.length,1);
});
