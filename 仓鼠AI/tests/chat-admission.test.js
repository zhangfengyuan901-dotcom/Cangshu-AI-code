const test=require('node:test'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events');
const {createPiknoInferenceGateway}=require('../pikno-inference.cjs');
const operation='b'.repeat(32),version='chat-cny-9-45-actual-v2';
const bill=()=>({request_id:operation,status:'unknown',currency:'CNY',price_version:version,billing_mode:'actual_usage_v1',reserved_quota:0,charged_quota:0,refunded_quota:0,admission_blocking:false});
async function lookup(wire,options={}){
 const calls=[],req=Object.assign(new EventEmitter(),{method:'GET'}),res={writeHead(status,headers){this.status=status;this.headers=headers;},end(body){this.value=JSON.parse(body);}};
 const gateway=createPiknoInferenceGateway({endpoint:'https://synthetic.invalid',fetchImpl:async(url,init)=>{calls.push({url:String(url),method:init.method});options.onRead?.();return Response.json(wire,{status:options.status||200});}});
 await gateway.handle(req,res,new URL('/api/inference/requests/'+operation,'http://127.0.0.1'),'synthetic-only',{assertCurrent:options.assertCurrent});
 return {res,calls};
}
test('read-only original bill forwards strict server admission status without settling or resubmitting',async()=>{
 for(const blocking of [false,true]){
  const {res,calls}=await lookup({...bill(),admission_blocking:blocking,private:'must-be-discarded'});
  assert.equal(res.value.status,'unknown');assert.equal(res.value.admission_blocking,blocking);assert.equal(res.value.private,undefined);
  assert.deepEqual(calls,[{url:'https://synthetic.invalid/assistant/v2/requests/'+operation,method:'GET'}]);
  assert.equal(res.headers['Cache-Control'],'no-store');
 }
});
test('missing, malformed, legacy, nonzero and non-unknown receipts cannot opt out of admission protection',async()=>{
 const cases=[{admission_blocking:undefined},{admission_blocking:'false'},{admission_blocking:0},{billing_mode:'prepaid'},{billing_mode:undefined},{price_version:'chat-legacy-v1'},{reserved_quota:1},{charged_quota:1},{refunded_quota:1},{refunded_quota:undefined},{status:'reserved'},{status:'dispatched'}];
 for(const change of cases){const {res}=await lookup({...bill(),...change});assert.equal(res.value.admission_blocking,undefined,JSON.stringify(change));}
});
test('wrong original identity, errors and changed local account never return a release flag',async()=>{
 await assert.rejects(lookup({...bill(),request_id:'c'.repeat(32)}));
 await assert.rejects(lookup({admission_blocking:false},{status:404}));
 let current=true;
 await assert.rejects(lookup(bill(),{onRead(){current=false;},assertCurrent(){if(!current)throw Object.assign(Error('scope changed'),{statusCode:409});}}),/scope changed/);
});
