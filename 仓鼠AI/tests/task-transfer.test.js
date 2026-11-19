const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {createTasks} = require('../tasks.cjs');

const defer = () => {let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
const until = async fn => {
  const end=Date.now()+3000;
  while(Date.now()<end){const value=fn();if(value)return value;await new Promise(r=>setTimeout(r,5));}
  throw Error('task transfer condition timed out');
};
function fixture(t, options={}) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'hamster-task-transfer-'));
  let owner='fixture-owner';
  const resultDir=path.join(root,'results');
  const tasks=createTasks({dir:path.join(root,'journal'),resultDir,relayMode:true,walletUser:()=>owner,
    interval:60000,tickMs:5,...options});
  t.after(async()=>{
    tasks.stop();
    await until(()=>tasks.list().every(item=>!item.result?.saving));
    assert.ok(root.startsWith(path.join(os.tmpdir(),'hamster-task-transfer-')));
    fs.rmSync(root,{recursive:true,force:true});
  });
  return {tasks,root,resultDir,setOwner:value=>{owner=value;},
    record(id) {
      const item=tasks.list().find(item=>item.id===id);
      return JSON.parse(fs.readFileSync(path.join(root,'journal',item.key+'.json'),'utf8'));
    },
    async add(id, payload={model:'fixture'}) {
      const receipt=tasks.begin('/api/videos',payload,'','operation-'+id,{walletUser:owner,relay:true});
      await tasks.capture(receipt,{id,status:'queued'},200);
    },
    async retry(id) {
      const item=tasks.list().find(item=>item.id===id);
      await tasks.handle({method:'POST'}, {writeHead(){},end(){}},new URL('http://127.0.0.1/api/tasks/'+item.key+'/retry'));
    },
  };
}
const complete = item => ({status:'succeeded',video_url:'https://fixture.invalid/'+item.id+'.mp4'});

test('slow downloads use two independent slots and leave task polling responsive',async t=>{
  const gate=defer(),polls=[];let running=0,maxRunning=0,downloads=0;
  const f=fixture(t,{walletQuery:async item=>{polls.push(item.id);return item.id==='pending'?{status:'processing'}:complete(item);},
    fetchImpl:async(_url,{signal})=>{
      downloads++;running++;maxRunning=Math.max(maxRunning,running);
      const body=new ReadableStream({start(controller){
        const abort=()=>{running--;controller.error(new Error('fixture aborted'));};
        signal.addEventListener('abort',abort,{once:true});
        gate.promise.then(()=>{if(signal.aborted)return;signal.removeEventListener('abort',abort);running--;controller.enqueue(Buffer.from('video'));controller.close();});
      }});
      return new Response(body,{headers:{'Content-Type':'video/mp4'}});
    }});
  t.after(()=>gate.resolve());
  for(const id of ['one','two','three','pending'])await f.add(id);
  f.tasks.start();
  await until(()=>polls.includes('pending')&&downloads===2);
  assert.equal(downloads,2,'the third download waits without blocking the fourth task status');
  assert.equal(f.tasks.list().find(item=>item.id==='pending').status,'processing');
  gate.resolve();
  await until(()=>f.tasks.list().filter(item=>item.id!=='pending').every(item=>item.result?.local_path));
  assert.equal(maxRunning,2);
  assert.equal(downloads,3);
  assert.deepEqual(polls.sort(),['one','pending','three','two'],'saved tasks do not repeat status queries');
});

test('input cleanup is single flight and does not delay saving the completed result',async t=>{
  const cleanup=defer();let cleanupCalls=0,downloads=0;
  const f=fixture(t,{walletQuery:async item=>complete(item),deleteMedia:async()=>{cleanupCalls++;await cleanup.promise;return {deleted:1};},
    fetchImpl:async()=>{downloads++;return new Response('video',{headers:{'Content-Type':'video/mp4'}});}});
  t.after(()=>cleanup.resolve());
  const receipt=f.tasks.begin('/api/videos',{model:'fixture',images:[{url:'https://fixture.invalid/tmp/2026/10/23/123e4567-e89b-12d3-a456-426614174000.png?sig=fixture'}]},'','shared-operation',{walletUser:'fixture-owner',relay:true});
  await f.tasks.capture(receipt,{tasks:[{id:'one'},{id:'two'}]},200);
  f.tasks.start();
  await until(()=>f.tasks.list().every(item=>item.result?.local_path));
  assert.equal(downloads,2);
  assert.equal(cleanupCalls,1);
  assert.ok(f.tasks.list().every(item=>!item.mediaCleanedAt),'download finishes while cleanup is still waiting');
  cleanup.resolve();
  await until(()=>f.tasks.list().every(item=>item.mediaCleanedAt));
});

test('a transient download error retries only the preserved result, including after restart',async t=>{
  let polls=0,downloads=0;
  const options={walletQuery:async item=>{polls++;return complete(item);},fetchImpl:async()=>{
    downloads++;if(downloads===1)throw new TypeError('fixture network interrupted');
    return new Response('complete-video',{headers:{'Content-Type':'video/mp4','Content-Length':'14'}});
  }};
  const f=fixture(t,options);
  await f.add('original');f.tasks.start();
  await until(()=>f.tasks.list()[0]?.result?.save_error);
  const before=f.tasks.list()[0];
  assert.equal(before.status,'succeeded');assert.ok(f.record('original').result.video_url);
  f.tasks.stop();
  const restarted=createTasks({dir:path.join(f.root,'journal'),resultDir:f.resultDir,relayMode:true,walletUser:()=> 'fixture-owner',tickMs:5,...options});
  t.after(()=>restarted.stop());
  restarted.start();
  await until(()=>restarted.list()[0]?.result?.local_path);
  assert.equal(polls,1,'restart resumes downloading instead of querying the completed task again');
  assert.equal(downloads,2);
  assert.equal(fs.readFileSync(restarted.list()[0].result.local_path,'utf8'),'complete-video');
});

test('an expired result link refreshes only the original task and preserves completed state',async t=>{
  let polls=0,downloads=0;
  const f=fixture(t,{walletQuery:async item=>{
    polls++;if(polls===2)return {status:'processing'};
    return {...complete(item),video_url:'https://fixture.invalid/'+(polls>2?'fresh':'expired')+'.mp4'};
  },fetchImpl:async url=>{downloads++;return String(url).includes('expired')?new Response('',{status:403}):new Response('video',{headers:{'Content-Type':'video/mp4'}});}});
  await f.add('original');f.tasks.start();
  await until(()=>f.tasks.list()[0]?.result?.save_error);
  await f.retry('original');
  await until(()=>polls===2&&f.tasks.list()[0]?.poll_error);
  assert.equal(f.tasks.list()[0].status,'succeeded');
  assert.match(f.record('original').result.video_url,/expired/);
  await f.retry('original');
  await until(()=>f.tasks.list()[0]?.result?.local_path);
  assert.equal(polls,3);assert.equal(downloads,2);
});

test('partial HTTP responses and short bodies never become completed files',async t=>{
  let polls=0,attempt=0;
  const f=fixture(t,{walletQuery:async item=>{polls++;return complete(item);},fetchImpl:async()=>{
    attempt++;
    if(attempt===1)return new Response('12345',{status:206,headers:{'Content-Type':'video/mp4','Content-Length':'5','Content-Range':'bytes 0-4/100'}});
    if(attempt===2)return new Response('12345',{headers:{'Content-Type':'video/mp4','Content-Length':'100'}});
    return new Response('complete',{headers:{'Content-Type':'video/mp4','Content-Length':'8'}});
  }});
  await f.add('original');f.tasks.start();
  for(let expected=1;expected<=2;expected++){
    await until(()=>attempt===expected&&f.tasks.list()[0]?.result?.save_error&&!f.tasks.list()[0]?.result?.saving);
    const item=f.tasks.list()[0];
    assert.equal(item.status,'succeeded');assert.equal(item.result.local_path,undefined);
    assert.deepEqual(fs.readdirSync(f.resultDir),[],'neither a partial file nor a final file survives');
    await f.retry('original');
  }
  await until(()=>f.tasks.list()[0]?.result?.local_path);
  assert.equal(polls,1);assert.equal(attempt,3);
});

test('stopping aborts an active result stream and leaves queued downloads unsent',async t=>{
  let downloads=0,aborts=0;
  const f=fixture(t,{walletQuery:async item=>complete(item),fetchImpl:async(_url,{signal})=>{
    downloads++;
    return new Response(new ReadableStream({start(controller){
      controller.enqueue(Buffer.from('partial'));
      signal.addEventListener('abort',()=>{aborts++;controller.error(new Error('fixture aborted'));},{once:true});
    }}),{headers:{'Content-Type':'video/mp4'}});
  }});
  for(const id of ['one','two','three'])await f.add(id);
  f.tasks.start();await until(()=>downloads===2);
  f.tasks.stop();
  await until(()=>f.tasks.list().every(item=>!item.result?.saving));
  assert.equal(aborts,2);assert.equal(downloads,2);
  assert.ok(f.tasks.list().every(item=>item.status==='succeeded'&&!item.result?.local_path));
  assert.deepEqual(fs.readdirSync(f.resultDir),[]);
});

test('an account change prevents late results from being saved or other downloads from starting',async t=>{
  const gate=defer();let downloads=0;
  const f=fixture(t,{walletQuery:async item=>complete(item),fetchImpl:async()=>{
    downloads++;
    return new Response(new ReadableStream({start(controller){gate.promise.then(()=>{controller.enqueue(Buffer.from('late result'));controller.close();});}}),{headers:{'Content-Type':'video/mp4'}});
  }});
  t.after(()=>gate.resolve());
  for(const id of ['one','two','three'])await f.add(id);
  f.tasks.start();await until(()=>downloads===2);
  f.setOwner('other-owner');gate.resolve();
  await until(()=>fs.readdirSync(f.resultDir).length===0);
  await new Promise(r=>setTimeout(r,25));
  assert.equal(downloads,2);assert.deepEqual(f.tasks.list(),[]);
  assert.deepEqual(fs.readdirSync(f.resultDir),[]);
  f.setOwner('fixture-owner');
  assert.ok(f.tasks.list().every(item=>!item.result?.local_path));
});
