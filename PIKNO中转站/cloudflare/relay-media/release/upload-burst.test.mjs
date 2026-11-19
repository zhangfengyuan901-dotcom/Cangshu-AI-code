import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHmac} from 'node:crypto';
import {Miniflare,convertV4MiniflareOptions} from '../../../tools/relay-cli/node_modules/miniflare/dist/src/index.js';

const secret='upload-burst-synthetic-ticket-key-12345678901234567890';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZCr8AAAAASUVORK5CYII=','base64');
const video=Buffer.from('000000186674797069736f6d0000000069736f6d6d703432','hex');
const audio=Buffer.from('524946460000000057415645666d7420','hex');
const source=await readFile(new URL('./worker-release.js',import.meta.url),'utf8');
const configuration=JSON.parse(await readFile(new URL('../wrangler.jsonc',import.meta.url),'utf8'));
const limiter=configuration.ratelimits.find(binding=>binding.name==='UPLOAD_LIMITER');

async function sameWindow(run){
 for(let attempt=0;attempt<2;attempt++){
  const epoch=Math.floor(Date.now()/60000);
  try{
   const result=await run(attempt);
   if(epoch===Math.floor(Date.now()/60000))return result;
  }catch(error){if(epoch===Math.floor(Date.now()/60000))throw error;}
 }
 throw Error('A complete fixture must fit in the same real 60-second limiter window');
}

async function fixture(run){
 const {name,...settings}=limiter;
 const mf=new Miniflare(convertV4MiniflareOptions({modules:true,compatibilityDate:configuration.compatibility_date,script:source,r2Buckets:['MEDIA'],bindings:{TICKET_KEY:secret},ratelimits:{[name]:settings}}));
 const now=Math.floor(Date.now()/1000);
 const sign=claims=>{const payload=Buffer.from(JSON.stringify(claims)).toString('base64url');return payload+'.'+createHmac('sha256',secret).update(payload).digest('base64url');};
 const send=({index,uid=7,kind='image',overrides={},invalidSignature=false})=>{
  const [bytes,mime]=kind==='image'?[png,'image/png']:kind==='video'?[video,'video/mp4']:[audio,'audio/wav'];
  const id=(index+1).toString(16).padStart(32,'0'),claims={v:1,aud:'pikno-relay-media',uid,id,op:'upload',iat:now,exp:now+600,mime,size:bytes.length,...overrides};
  const token=sign(claims)+(invalidSignature?'!':'');
  return mf.dispatchFetch('https://www.piknoai.com/media/v1/assets/'+id,{method:'PUT',headers:{Authorization:'Bearer '+token,'Content-Type':mime,'Content-Length':String(bytes.length)},body:bytes});
 };
 try{await run({send,bucket:await mf.getR2Bucket('MEDIA')});}finally{await mf.dispose();}
}

async function uploadBatch(send,kinds){
 const statuses=[];let next=0,active=0,maxActive=0;
 await Promise.all(Array.from({length:2},async()=>{
  while(next<kinds.length){const index=next++;active++;maxActive=Math.max(maxActive,active);
   try{const r=await send({index,kind:kinds[index]});statuses[index]=r.status;await r.body?.cancel();}finally{active--;}
  }
 }));
 return {statuses,maxActive};
}

test('current real upload limiter enforces twenty requests per account in sixty seconds',async()=>sameWindow(async()=>fixture(async({send,bucket})=>{
 const result=await uploadBatch(send,Array(30).fill('image'));
 assert.equal(result.statuses.filter(x=>x===201).length,20);assert.equal(result.statuses.filter(x=>x===429).length,10);assert.equal(result.maxActive,2);
 assert.equal((await bucket.list({prefix:'input/7/'})).objects.length,20);
 assert.equal((await send({index:30})).status,429);
 assert.equal((await send({index:31,uid:8})).status,201,'a different signed account has an independent limiter key');
 assert.equal((await bucket.list({prefix:'input/8/'})).objects.length,1);
})));

test('current real upload limiter accepts mixed assets within its twenty-request budget',async()=>sameWindow(async()=>fixture(async({send,bucket})=>{
 const result=await uploadBatch(send,[...Array(10).fill('image'),...Array(5).fill('video'),...Array(5).fill('audio')]);assert.ok(result.statuses.every(x=>x===201));assert.equal(result.maxActive,2);
 const objects=await bucket.list({prefix:'input/7/'});assert.equal(objects.objects.length,20);
 const types={};for(const object of objects.objects){const item=await bucket.head(object.key);types[item.httpMetadata.contentType]=(types[item.httpMetadata.contentType]||0)+1;assert.equal(item.customMetadata.uid,'7');}
 assert.deepEqual(types,{'image/png':10,'video/mp4':5,'audio/wav':5});
 assert.equal((await send({index:20,kind:'video'})).status,429);
})));

test('real upload limiter retains ticket signature, account binding, expiry and size validation',async()=>fixture(async({send,bucket})=>{
 assert.equal((await send({index:0,invalidSignature:true})).status,401);
 assert.equal((await send({index:1,overrides:{uid:0}})).status,403);
 assert.equal((await send({index:2,overrides:{exp:1}})).status,403);
 assert.equal((await send({index:3,overrides:{size:(30<<20)+1}})).status,403);
 assert.equal((await bucket.list({prefix:'input/'})).objects.length,0);
 assert.equal((await send({index:4,uid:8})).status,201);
 assert.equal(await bucket.head('input/7/'+'5'.padStart(32,'0')),null);
 assert.equal((await bucket.head('input/8/'+'5'.padStart(32,'0'))).customMetadata.uid,'8');
}));

test('current upload configuration retains the deployed twenty-per-minute budget',()=>{
 assert.deepEqual(configuration.ratelimits,[{name:'UPLOAD_LIMITER',namespace_id:'1010',simple:{limit:20,period:60}}]);
});
