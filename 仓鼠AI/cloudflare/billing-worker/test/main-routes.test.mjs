import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './fixture.mjs';
import {one,run,crypt} from '../src/common.mjs';
import {quote,publicModel,createTask,claimKey} from '../src/billing.mjs';
import {submitTask} from '../src/providers.mjs';
import {upstreamModel} from '../src/routes.mjs';
import {mapUpstreamModels,mediaLimitError} from '../../../public/core.mjs';

const cases=[
 ['main-video-480real','sd2_480p_real','480p',4,6000000],
 ['main-video-933limited','sd2_933_limited_line','720p',4,8000000],
 ['main-video-value','sd2_value','720p',15,8000000],
 ['main-video-line5','sd2_5_line5','720p',4,4000000],
 ['main-video-line1','sd2_5_limited_line1','720p',4,4000000],
];

test('five restored main routes show only business names and charge the approved prices',async t=>{
 const {env}=await fixture(t);
 for(const [id,upstream,resolution,duration,price] of cases){
  const model=await one(env,'SELECT * FROM models WHERE id=?',id);
  assert.equal(model.enabled,1);
  assert.equal(upstreamModel(id),upstream);
  assert.equal(quote(model,{prompt:'非敏感测试',resolution,duration,ratio:'16:9'}).reserved,price);
  const visible=publicModel(model);
  assert.equal(mapUpstreamModels([visible]).length,1);
  assert.match(visible.name,/^主线路 · /);
  assert.doesNotMatch(JSON.stringify(visible),/sd2_|sanbao|upstream|cost_rate|cost_by_resolution/i);
 }
 const limited=await one(env,"SELECT * FROM models WHERE id='main-video-933limited'");
 assert.match(mediaLimitError(publicModel(limited),[{kind:'video'}]),/不支持视频素材/);
 const light=await one(env,"SELECT * FROM models WHERE id='main-video-line1'");
 assert.throws(()=>quote(light,{prompt:'测试',resolution:'720p',duration:4,ratio:'16:9',videos:['https://example.com/clip.mp4']}),/素材数量/);
 const value=await one(env,"SELECT * FROM models WHERE id='main-video-value'");
 assert.throws(()=>quote(value,{prompt:'测试',resolution:'720p',duration:4,ratio:'16:9'}),/时长/);
 for(const id of ['main-video-line5','main-video-line1']){
  const model=await one(env,'SELECT * FROM models WHERE id=?',id);
  assert.equal(quote(model,{prompt:'测试',resolution:'480p',duration:4,ratio:'16:9'}).reserved,4000000);
 }
});

test('five routes submit through the existing server-side adapter without duplicating wallet tasks',async t=>{
 const {env,user}=await fixture(t);
 await run(env,"UPDATE provider_keys SET encrypted_secret=? WHERE provider='main'",await crypt(env.KEY_ENCRYPTION_SECRET,'fixture-main-key'));
 const original=globalThis.fetch,calls=[];
 globalThis.fetch=async(url,options)=>{
  const payload=JSON.parse(options.body);
  calls.push({url:String(url),model:payload.model,request:options.headers['Idempotency-Key']});
  return Response.json({data:{id:'upstream-'+calls.length,status:'queued'}});
 };
 try{
  for(const [id,upstream,resolution,duration] of cases){
   const task=await createTask(env,user,{model:id,prompt:'非敏感测试',resolution,duration,ratio:'16:9'},'restore-'+id);
   await claimKey(env,task.id);
   await submitTask(env,task.id);
   await submitTask(env,task.id);
   assert.equal((await one(env,'SELECT state FROM tasks WHERE id=?',task.id)).state,'processing');
   assert.equal(calls.at(-1).model,upstream);
   assert.equal(calls.at(-1).request,task.id);
  }
 }finally{globalThis.fetch=original;}
 assert.equal(calls.length,5);
 assert.ok(calls.every(call=>call.url.endsWith('/openapi/v1/videos')));
});
