import test from 'node:test';
import assert from 'node:assert/strict';
import {createQuoteController,createQuoteConfirmation,quoteFingerprint} from '../public/quote-ui.mjs';

const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const flush=async()=>{for(let i=0;i<8;i++)await Promise.resolve();};
const quote=(overrides={})=>({id:'opaque_quote_123',model:'main-image-1234abcd',name:'PIKNO 图片优选',price_version:1,currency:'CNY',unit:'image',unit_price_cny:'0.10',units:1,reference_surcharge_cny:'0.02',per_item_cny:'0.12',quantity:2,total_cny:'0.24',expires_at:2000000000,...overrides});
const snapshot=(overrides={})=>({revision:10,version:1,payload:{model:'main-image-1234abcd',size:'1024x1024',concurrency:2,media_counts:{images:1,videos:0,audios:0}},context:['local-selection'],...overrides});

test('quote requests contain billing parameters and counts, never prompt or reference URL',async()=>{
  let sent;const c=createQuoteController({request:async value=>{sent=value;return {quote:quote(),revision:10};},now:()=>1000});
  const q=await c.ensure('generate',snapshot());assert.equal(q.total_cny,'0.24');
  assert.equal('prompt' in sent.payload,false);assert.equal('images' in sent.payload,false);assert.deepEqual(sent.payload.media_counts,{images:1,videos:0,audios:0});c.reset();
});
for(const change of ['account','parameters','selection'])test(`a late quote cannot restore permissions after changing ${change}`,async()=>{
  const pending=deferred();let current=snapshot();const c=createQuoteController({request:()=>pending.promise,isCurrent:(_key,s)=>quoteFingerprint(s)===quoteFingerprint(current),now:()=>1000});
  const result=c.ensure('generate',current);await flush();
  current=change==='account'?snapshot({revision:11}):change==='selection'?snapshot({context:['replaced-local-selection']}):snapshot({payload:{...current.payload,size:'2048x2048'}});
  c.update('generate',current);pending.resolve({quote:quote(),revision:10});assert.equal(await result,null);assert.equal(c.state('generate').quote,null);c.reset();
});
test('reset cancels delayed ensure without leaving an unresolved submit gate',async()=>{
  let calls=0;const c=createQuoteController({request:async()=>{calls++;return {quote:quote(),revision:10};},delay:10000});
  const entry=c.update('generate',snapshot());c.reset();assert.equal(await entry.pending,null);assert.equal(calls,0);
});
test('invalidating an in-flight quote cannot let its late response clear an unknown submission',async()=>{
  const pending=deferred(),c=createQuoteController({request:()=>pending.promise,now:()=>1000});const gate=c.ensure('generate',snapshot());await flush();c.invalidate('generate','unknown');pending.resolve({quote:quote(),revision:10});assert.equal(await gate,null);await flush();assert.equal(c.state('generate').status,'unknown');c.reset();
});
for(const wrong of [{revision:11},{quote:quote({quantity:4})},{quote:quote({model:'main-video-5678abcd'})},{quote:quote({total_cny:'-1'})},{quote:quote({expires_at:1})}])test(`invalid quote response does not enable generation: ${JSON.stringify(wrong)}`,async()=>{
  const c=createQuoteController({request:async()=>({quote:quote(),revision:10,...wrong}),now:()=>2000});assert.equal(await c.ensure('generate',snapshot()),null);assert.equal(c.state('generate').status,'error');c.reset();
});
test('a failed readonly quote is not automatically retried by repeated rendering',async()=>{
  let calls=0;const c=createQuoteController({request:async()=>{calls++;throw Error('private upstream diagnostic');},now:()=>1000});
  const s=snapshot();assert.equal(await c.ensure('generate',s),null);for(let i=0;i<10;i++)c.update('generate',s);assert.equal(calls,1);
  await c.refresh('generate').pending;assert.equal(calls,2);c.reset();
});
test('expired quote changes state before a stale confirmation can be used',async()=>{
  let now=1000;const c=createQuoteController({request:async()=>({quote:quote({expires_at:2}),revision:10}),now:()=>now});await c.ensure('generate',snapshot());now=2001;assert.equal(c.state('generate').status,'expired');c.reset();
});

class Element extends EventTarget{
  constructor(){super();this.textContent='';this.children=[];this.disabled=false;this.open=false;}
  append(...items){this.children.push(...items);}replaceChildren(){this.children=[];}focus(){}
  showModal(){this.open=true;}close(){this.open=false;this.dispatchEvent(new Event('close'));}
  click(){this.dispatchEvent(new Event('click'));}
}
function dialogFixture(){const dialog=new Element(),nodes=new Map();dialog.querySelector=selector=>{if(!nodes.has(selector))nodes.set(selector,new Element());return nodes.get(selector);};return {dialog,node:s=>dialog.querySelector(`[data-quote-${s}]`),document:{createElement:()=>new Element()}};}
test('confirmation shows published name, unit, surcharge, quantity and exact string total',async()=>{
  const f=dialogFixture(),c=createQuoteConfirmation({...f,now:()=>1000});const pending=c.confirm({quote:quote(),details:'1024 × 1024 · 1 图'});
  assert.equal(f.node('name').textContent,'PIKNO 图片优选');assert.equal(f.node('total').textContent,'¥0.24');assert.equal(f.node('rows').children.length,5);
  assert.equal(f.node('rows').children[2].children[1].textContent,'¥0.02/份');assert.match(f.node('spec').textContent,/1 图/);
  f.node('cancel').click();assert.equal(await pending,false);
});
test('double click confirmation resolves once and cannot open a concurrent confirmation',async()=>{
  const f=dialogFixture(),c=createQuoteConfirmation({...f,now:()=>1000});const first=c.confirm({quote:quote()});assert.equal(await c.confirm({quote:quote()}),false);
  f.node('accept').click();f.node('accept').click();assert.equal(await first,true);assert.equal(f.dialog.open,false);
});
for(const change of ['expiry','parameters'])test(`${change} after opening confirmation prevents acceptance`,async()=>{
  let now=1000,current=true;const f=dialogFixture(),c=createQuoteConfirmation({...f,now:()=>now});const pending=c.confirm({quote:quote({expires_at:2}),isCurrent:()=>current});
  if(change==='expiry')now=2001;else current=false;f.node('accept').click();assert.equal(f.node('accept').disabled,true);assert.equal(f.dialog.open,true);f.node('cancel').click();assert.equal(await pending,false);
});
test('account reset closes the confirmation and rejects the pending submission',async()=>{
  const f=dialogFixture(),c=createQuoteConfirmation({...f,now:()=>1000}),pending=c.confirm({quote:quote()});c.cancel();assert.equal(await pending,false);assert.equal(f.dialog.open,false);
});
