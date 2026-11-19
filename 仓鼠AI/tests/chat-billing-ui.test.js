const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),crypto=require('node:crypto');
const source=fs.readFileSync(path.join(__dirname,'../smart-video-agent/chat-ui/chat.js'),'utf8');
const fn=name=>source.match(new RegExp(`(?:async )?function ${name}\\([^]*?\\n\\}`))[0];
const notice=vm.runInNewContext(fn('billingNotice')+';billingNotice;');
const version='chat-cny-9-45-actual-v2',contextId='b'.repeat(64),operation='abcdef0123456789abcdef0123456789';
const terms=()=>({metered:true,billing_mode:'actual_usage_v1',billing:{allow_debt:true,one_inflight_per_user:true},confirmation_context:contextId,price_version:version,pricing:{currency:'CNY',input_cny_per_million:9,output_cny_per_million:45},limits:{max_output_tokens:512}});
const config=()=>({ready:true,metered:true,confirmation_context:contextId});
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const flush=async()=>{for(let i=0;i<12;i++)await Promise.resolve();};

test('terminal bills have no visible fee, state or request number; pending is one nontechnical warning',()=>{
 for(const status of ['settled','released','not_submitted','rejected_before_execution'])assert.equal(notice({status,request_id:operation,charged_quota:7560}),'',status);
 for(const status of ['reserved','unknown','dispatching','dispatched','submitted'])assert.equal(notice({status,charged_quota:7560,request_id:operation}),'正在核对请求状态，请勿重复发送。',status);
 assert.doesNotMatch(notice({status:'reserved',reserved_quota:0}),/免费|预占|实际费用/);
});
function sender(status='rejected_before_execution'){
 const calls=[],current={id:'session-fixture',status:'failed',messages:[{id:'message-fixture',billing:{request_id:operation,status}}]};
 const context={uploading:false,submitting:false,ready:true,selection:0,current,metered:true,pending:[],controls(){},ensureSession:async()=>{},render(){},refreshHistory:async()=>{},toast(){},draft(){},crypto,
  $(){return {value:'合成消息'};},json:(method,value)=>({method,body:JSON.stringify(value)}),
  api:async(route,options)=>{calls.push({route,options});return route==='/capabilities'?terms():{...current,status:'running'};}};
 context.applyAttachmentCapabilities=()=>{};
 const send=vm.runInNewContext(fn('billingNotice')+'\n'+fn('billingBlocksAdmission')+'\n'+fn('paidTermsIdentity')+'\n'+fn('send')+';send;',context);
 return {send,calls,current,context};
}
test('explicit send reads one current contract and posts once without a per-message fee dialog',async()=>{
 for(const retry of [false,true]){
  const f=sender();await f.send(retry);
  assert.deepEqual(f.calls.map(call=>call.route),['/capabilities',`/sessions/session-fixture/${retry?'retry':'messages'}`]);
  const body=JSON.parse(f.calls[1].options.body);assert.equal(body.price_version,version);assert.equal(body.confirmation_context,contextId);assert.notEqual(body.request_id,operation);assert.match(body.request_id,/^[a-f0-9-]{36}$/);
 }
 assert.doesNotMatch(source,/confirmPrice|priceConfirmation|window\.confirm/);
 const html=fs.readFileSync(path.join(__dirname,'../smart-video-agent/chat-ui/index.html'),'utf8');assert.doesNotMatch(html,/priceConfirmation|确认费用并发送/);
});
test('malformed billing contract and missing account binding fail before submission',async()=>{
 for(const change of [value=>delete value.confirmation_context,value=>value.confirmation_context='invalid',value=>value.pricing.input_cny_per_million=NaN,value=>value.billing.allow_debt=false]){
  const f=sender(),original=f.context.api;f.context.api=async(route,options)=>{const value=await original(route,options);if(route==='/capabilities')change(value);return value;};
  await f.send(true);assert.equal(f.calls.some(call=>call.route.endsWith('/retry')),false);
 }
});
test('a late capability response cannot submit after readiness, selection or session changes',async()=>{
 for(const changed of ['ready','selection','session']){
  const f=sender(),original=f.context.api;f.context.api=async(route,options)=>{const value=await original(route,options);if(route==='/capabilities'){if(changed==='ready')f.context.ready=false;if(changed==='selection')f.context.selection++;if(changed==='session')f.context.current={...f.current,id:'other'};}return value;};
  await f.send(true);assert.equal(f.calls.some(call=>call.route.endsWith('/retry')),false,changed);
 }
});
test('duplicate send remains single-flight; pending originals block both retry and a new message',async()=>{
 const f=sender(),wait=deferred(),original=f.context.api;f.context.api=async(route,options)=>{const value=await original(route,options);if(route==='/capabilities')await wait.promise;return value;};
 const first=f.send(true);await flush();await f.send(true);assert.equal(f.calls.length,1);wait.resolve();await first;assert.equal(f.calls.filter(call=>call.options?.method==='POST').length,1);
 for(const status of ['reserved','unknown','dispatching','dispatched','submitted'])for(const retry of [true,false]){const g=sender(status);await g.send(retry);assert.deepEqual(g.calls,[],status);}
});

function displayFixture(status='settled',legacy=false,messageCount=1){
 let viewport;
 class Element {
  constructor(tag='div',text=''){this.tagName=tag;this.textContent=text;this.children=[];this.dataset={};this.attributes={};this.classList={add(){},toggle(){}};}
  append(...nodes){for(const node of nodes)this.insertBefore(node,null);}
  prepend(node){this.insertBefore(node,this.firstElementChild);}
  replaceChildren(...nodes){for(const child of [...this.children])child.remove();this.append(...nodes);}
  insertBefore(node,next){node.remove();this.children.splice(next?this.children.indexOf(next):this.children.length,0,node);node.parent=this;}
  remove(){if(this.parent){const {children}=this.parent;children.splice(children.indexOf(this),1);delete this.parent;}}
  get firstElementChild(){return this.children[0]||null;}
  get nextElementSibling(){return this.parent?.children[this.parent.children.indexOf(this)+1]||null;}
  getBoundingClientRect(){return {top:this.parent.children.indexOf(this)*20-viewport.scrollTop};}
  toJSON(){const {parent,...value}=this;return value;}
  setAttribute(name,value){this.attributes[name]=String(value);}
 }
 const nodes=new Map(),node=selector=>{if(!nodes.has(selector))nodes.set(selector,new Element());return nodes.get(selector);};
 const find=(element,id)=>element.id===id?element:element.children.map(child=>find(child,id)).find(Boolean);
 const calls=[],bill={request_id:operation,price_version:version,billing_mode:'actual_usage_v1',status,reserved_quota:0,charged_quota:7560};if(legacy)delete bill.billing_mode;
 const current={id:'session-fixture',status:['settled','released'].includes(status)?'completed':'failed',stage:'原请求状态待核对，请先核对账单；不会自动重复生成。',notice:'',media:[],messages:[{id:'message-fixture',role:'assistant',text:'这是合成回答。',attachments:[],status:['settled','released'].includes(status)?'completed':'failed',billing:bill}]};
 current.messages.unshift(...Array.from({length:messageCount-1},(_,i)=>({id:'old-'+i,role:'user',text:'合成历史 '+i,attachments:[],status:'completed'})));
 viewport=Object.assign(node('#scrollArea'),{scrollTop:120,scrollHeight:1200,clientHeight:400});
 const context={current,selection:0,metered:true,billingChecks:new Map(),billingCheckDelays:[0,2000,5000,10000,20000,30000],$:node,renderedBillStates:new WeakMap(),
  document:{createElement:tag=>new Element(tag),getElementById:id=>[...nodes.values()].map(element=>find(element,id)).find(Boolean)},
  bindAttachmentPreviews:container=>{container._materialPreview||={refresh(){}};},richText(element,text){element.textContent=text;},renderAttachments(){},controls(){},toast(){},navigator:{clipboard:{writeText:async()=>{}}},reconcileBills:async options=>{calls.push(options);return true;}};
 vm.createContext(context);
 const helpers=source.slice(source.indexOf('const make ='),source.indexOf('let current ='));
 const rendering=source.slice(source.indexOf('function render(scroll = false)'),source.indexOf('async function send(retry = false)'));
 vm.runInContext(helpers+'\n'+fn('billingNotice')+'\n'+fn('billingBlocksAdmission')+'\n'+fn('answerNotice')+'\n'+rendering+'\nrender();',context);
 return {nodes,current,bill,calls,context,viewport,render:()=>vm.runInContext('render();',context),all:()=>JSON.stringify([...nodes.values()]),elements:()=>{const output=[];const visit=element=>{output.push(element);element.children.forEach(visit);};nodes.forEach(visit);return output;}};
}

test('billing status updates preserve reviewed message body and copy button identity',()=>{
 const f=displayFixture('unknown');
 f.current.status='completed';f.current.messages[0].status='completed';f.render();
 const body=f.elements().find(element=>element.className==='message-body');
 const copy=f.elements().find(element=>element.textContent==='复制');
 f.context.billingChecks.set(`session-fixture/${operation}`,{attempts:7,pending:null,finalAttempted:true});f.render();
 assert.equal(f.elements().find(element=>element.className==='message-body'),body);
 assert.equal(f.elements().find(element=>element.textContent==='复制'),copy);
 assert.equal(body.textContent,'这是合成回答。');
 assert.match(f.all(),/核对状态/);
});

test('long sessions mount the newest messages and keep the old viewport anchor when prepending',()=>{
 const f=displayFixture('settled',false,120);
 const list=f.nodes.get('#messages'),earlier=list.children[0],anchor=list.children[1];
 assert.equal(earlier.id,'earlierMessages');assert.equal(anchor.id,'message-old-70');
 assert.equal(list.children.length,51);
 const initialTop=anchor.getBoundingClientRect().top;
 earlier.onclick();
 assert.equal(list.children.length,101);assert.equal(anchor.getBoundingClientRect().top,initialTop);
 assert.equal(list.children[51],anchor);
 earlier.onclick();
 assert.equal(list.children.length,120);
 assert.equal(list.children[0].id,'message-old-0');
});
test('normal and historical bills remain private in text, title, aria and dataset',()=>{
 for(const status of ['settled','released','not_submitted','rejected_before_execution'])for(const legacy of [false,true]){
  const f=displayFixture(status,legacy),before=JSON.stringify(f.bill);assert.doesNotMatch(f.all(),/abcdef01|23456789|7560|0\.007560|对话账单|实际费用|请求编号|已结算|已释放/);assert.equal(JSON.stringify(f.bill),before);
 }
});
test('unknown has one recovery notice, no competing failure hint or retry, and manual check keeps the original operation',async()=>{
 const f=displayFixture('unknown');assert.match(f.all(),/正在核对请求状态/);assert.doesNotMatch(f.all(),/本次回答未完成|abcdef01|7560|0\.007560|核对账单/);
 assert.equal(f.elements().some(element=>element.tagName==='button'&&element.textContent==='重新回答'),false);
 await f.elements().find(element=>element.tagName==='button'&&element.textContent==='核对状态').onclick();assert.deepEqual(JSON.parse(JSON.stringify(f.calls)),[{manual:true,requestId:operation}]);
});

test('explicit non-submission explains a prior pending request without creating a new pending bill',()=>{
 const f=displayFixture('not_submitted');
 assert.match(f.all(),/本次请求未提交/);assert.doesNotMatch(f.all(),/正在核对请求状态/);
 f.current.messages[0].reason='prior_request_pending';f.render();
 assert.match(f.all(),/上一条对话正在后台处理，请稍后发送新消息/);assert.doesNotMatch(f.all(),/请先核对原请求/);
 assert.equal(f.elements().some(element=>element.tagName==='button'&&element.textContent==='核对状态'),false);
});
test('normal running messages show generation progress without false non-submission or billing warnings',()=>{
 for(const status of ['not_submitted','reserved','dispatching','dispatched','submitted','unknown']){
  const f=displayFixture(status);f.current.status='running';f.current.stage='仓鼠正在思考…';f.current.messages[0].status='running';f.render();
  assert.match(f.all(),/仓鼠正在思考/);assert.doesNotMatch(f.all(),/未提交|核对请求|核对状态|重新回答/);
 }
});
test('reviewed answers stay visible while bounded automatic billing recovery runs silently',()=>{
 for(const status of ['completed','partial']){
  const f=displayFixture('unknown');f.current.status=status;f.current.messages[0].status=status;f.current.messages[0].reason='max_output_tokens';f.render();
  assert.match(f.all(),/这是合成回答/);assert.doesNotMatch(f.all(),/核对请求|核对状态|重新回答/);
  if(status==='partial')assert.match(f.all(),/回答因长度限制结束/);
  f.context.billingChecks.set(`session-fixture/${operation}`,{attempts:7,pending:null,finalAttempted:true});f.render();
  assert.match(f.all(),/暂未确认，可稍后核对/);assert.match(f.all(),/核对状态/);
  assert.equal(f.current.messages[0].billing.status,'unknown');
 }
});
test('only a strict server admission decision permits a new explicit message, never retrying the unknown original',async()=>{
 for(const retry of [false,true]){
  const f=sender('unknown');Object.assign(f.current.messages[0].billing,{admission_blocking:false,billing_mode:'actual_usage_v1',price_version:version});
  await f.send(retry);
  assert.equal(f.calls.some(call=>call.route.endsWith('/messages')),!retry);
  assert.equal(f.calls.some(call=>call.route.endsWith('/retry')),false);
 }
 for(const change of [{admission_blocking:undefined},{admission_blocking:'false'},{admission_blocking:0},{admission_blocking:true},{billing_mode:'legacy'},{price_version:'chat-legacy-v1'},{status:'dispatched'},{status:'reserved'}]){
  const f=sender('unknown');Object.assign(f.current.messages[0].billing,{admission_blocking:false,billing_mode:'actual_usage_v1',price_version:version},change);
  await f.send(false);assert.equal(f.calls.length,0,JSON.stringify(change));
 }
});
test('nonblocking unknown is still unresolved, has no retry action and gives a concise outcome notice',()=>{
 const f=displayFixture('unknown');f.bill.admission_blocking=false;f.render();
 assert.match(f.all(),/本次回答未完成，可继续发送新消息/);
 assert.doesNotMatch(f.all(),/正在核对|请勿重复|核对状态|重新回答|已结算|免费|未扣费/);
 assert.equal(f.bill.status,'unknown');
 for(const status of ['completed','partial']){
  f.current.status=status;f.current.messages[0].status=status;f.render();
  assert.match(f.all(),/这是合成回答/);assert.doesNotMatch(f.all(),/核对状态|本次回答未完成|重新回答/);
 }
});
test('settled billing does not turn a failed answer into success and removes stale technical progress',()=>{
 const f=displayFixture('unknown');f.bill.status='settled';f.render();assert.equal(f.current.messages[0].status,'failed');assert.match(f.all(),/本次回答未完成/);assert.doesNotMatch(f.all(),/正在核对请求状态|原请求状态待核对|核对状态|abcdef01|7560/);
 f.current.messages[0].reason='max_output_tokens';f.render();assert.match(f.all(),/未形成可显示的回答/);
});
test('reviewed partial answer remains visible and has an honest length-limit note, not a failure badge',()=>{
 const f=displayFixture('settled');f.current.status='partial';f.current.messages[0].status='partial';f.current.messages[0].reason='max_output_tokens';f.render();assert.match(f.all(),/这是合成回答|回答因长度限制结束/);assert.doesNotMatch(f.all(),/本次回答未完成|重新回答|已结算/);
});
test('automatic retry budget exhaustion uses a static recovery message instead of endless checking',()=>{
 const f=displayFixture('unknown');f.context.billingChecks.set(`session-fixture/${operation}`,{attempts:7,pending:null,finalAttempted:true});f.render();assert.match(f.all(),/暂未确认，可稍后核对/);assert.doesNotMatch(f.all(),/正在核对请求状态|本次回答未完成/);
});
test('the cooldown before the final read uses static background status and keeps reviewed answers quiet',()=>{
 const f=displayFixture('unknown');f.context.billingChecks.set(`session-fixture/${operation}`,{attempts:6,pending:null,startedAt:1000,finalAttempted:false});f.render();
 assert.match(f.all(),/本次回答未完成，正在后台处理/);assert.doesNotMatch(f.all(),/正在核对请求状态|暂未确认，可稍后核对/);
 for(const status of ['completed','partial']){
  f.current.status=status;f.current.messages[0].status=status;f.render();
  assert.match(f.all(),/这是合成回答/);assert.doesNotMatch(f.all(),/正在后台处理|核对请求状态|核对状态/);
 }
});
test('configuration and initial HTML keep connection and billing metadata hidden',()=>{
 const nodes=new Map(),node=selector=>{if(!nodes.has(selector))nodes.set(selector,{textContent:'',placeholder:'',hidden:false});return nodes.get(selector);};
 const context={$:node,current:null,closeMediaPreview(){},billingChecks:new Map(),ready:false,metered:false,configurationContext:'',configurationEpoch:0};vm.createContext(context);vm.runInContext(fn('attachmentKind')+'\n'+fn('attachmentsEnabled')+'\n'+fn('renderAttachmentCapabilities')+'\n'+fn('applyConfiguration')+';applyConfiguration('+JSON.stringify(config())+');',context);
 assert.equal(context.ready,true);assert.equal(context.configurationContext,contextId);assert.equal(context.configurationEpoch,1);
 const html=fs.readFileSync(path.join(__dirname,'../smart-video-agent/chat-ui/index.html'),'utf8');assert.doesNotMatch(html+JSON.stringify([...nodes.values()]),/本地已就绪|校验授权|发送前确认价格|全额扣费|欠费|id="connection"/);assert.equal(node('#input').placeholder,'输入消息');
});

function reconciler(handler){
 const calls=[],renders=[],item={id:'session-fixture',status:'failed',messages:[{id:'message-fixture',status:'failed',billing:{request_id:operation,price_version:version,status:'unknown'}}]};let now=1000;
 const context={current:item,selection:0,metered:true,ready:true,uploading:false,submitting:false,closeMediaPreview(){},billingChecks:new Map(),billingCheckDelays:[0,2000,5000,10000,20000,30000],configurationContext:contextId,configurationEpoch:0,AbortSignal,Date:{now:()=>now},$:()=>({}),render:()=>renders.push(1),json:(method,value)=>({method,body:JSON.stringify(value)}),
  api:async(route,options)=>{calls.push({route,options});return handler?handler(route,options,context):route==='/config'?config():JSON.parse(JSON.stringify(item));}};
 vm.createContext(context);context.renderAttachmentCapabilities=()=>{};const reconcile=vm.runInContext(fn('billingNotice')+'\n'+fn('billingBlocksAdmission')+'\n'+fn('applyConfiguration')+'\n'+fn('reconcileBills')+';reconcileBills;',context);
 return {context,calls,renders,item,reconcile,advance:milliseconds=>now+=milliseconds,apply:value=>vm.runInContext('applyConfiguration('+JSON.stringify(value)+');',context)};
}
test('automatic recovery queries only the original bill, is single-flight and stops on terminal state',async()=>{
 const wait=deferred(),f=reconciler(async(route,_options,context)=>{if(route==='/config')return config();await wait.promise;return {...context.current,messages:[{...context.current.messages[0],billing:{...context.current.messages[0].billing,status:'settled'}}]};});
 const first=f.reconcile();await flush();const second=f.reconcile();await flush();assert.equal(f.calls.filter(call=>call.options.method==='POST').length,1);wait.resolve();assert.equal(await first,true);assert.equal(await second,true);
 assert.equal(f.context.current.messages[0].billing.status,'settled');assert.equal(f.context.current.messages[0].status,'failed');await f.reconcile();assert.equal(f.calls.length,3);
 assert.deepEqual(f.calls.map(call=>call.route),['/config',`/sessions/session-fixture/billing/${operation}`,'/config']);assert.equal(f.calls.some(call=>/\/messages|\/retry$/.test(call.route)),false);
});
test('automatic recovery has finite backoff; manual recheck does not create a new operation',async()=>{
 const f=reconciler();for(let index=0;index<6;index++){await f.reconcile();const before=f.calls.length;await f.reconcile();assert.equal(f.calls.length,before);f.advance(60000);}
 assert.equal(f.calls.filter(call=>call.options.method==='POST').length,6);await f.reconcile();assert.equal(f.calls.filter(call=>call.options.method==='POST').length,6);
 await f.reconcile({manual:true,requestId:operation});assert.equal(f.calls.filter(call=>call.options.method==='POST').length,7);assert.equal(f.context.current.messages[0].billing.request_id,operation);
});
test('six quick reads are followed by exactly one original-operation read at 905 seconds, never clock-based admission',async()=>{
 for(const serverAllows of [false,true]){
  let billReads=0;
  const f=reconciler((route,_options,context)=>{
   if(route==='/config')return config();billReads++;
   const updated=JSON.parse(JSON.stringify(context.current));
   if(billReads===7)Object.assign(updated.messages[0].billing,{billing_mode:'actual_usage_v1',admission_blocking:!serverAllows});
   return updated;
  });
  for(let index=0;index<6;index++){await f.reconcile();f.advance(60000);}
  assert.equal(billReads,6);f.advance(544999);await f.reconcile();assert.equal(billReads,6);
  assert.notEqual(f.context.current.messages[0].billing.admission_blocking,false);
  f.advance(1);await f.reconcile();assert.equal(billReads,7);
  assert.equal(f.context.current.messages[0].billing.admission_blocking,!serverAllows);
  assert.equal(f.context.current.messages[0].billing.status,'unknown');
  for(let i=0;i<4;i++){f.advance(1000000);await f.reconcile();}assert.equal(billReads,7);
  assert.equal(f.calls.some(call=>/\/messages|\/retry$/.test(call.route)),false);
  assert.deepEqual([...new Set(f.calls.filter(call=>call.options.method==='POST').map(call=>call.route))],[`/sessions/session-fixture/billing/${operation}`]);
  await f.reconcile({manual:true,requestId:operation});assert.equal(billReads,8);
 }
});
test('a server nonblocking unknown stops automatic reads immediately while retaining explicit manual lookup',async()=>{
 const f=reconciler();Object.assign(f.item.messages[0].billing,{billing_mode:'actual_usage_v1',admission_blocking:false});
 await f.reconcile();f.advance(1000000);await f.reconcile();assert.equal(f.calls.length,0);
 await f.reconcile({manual:true,requestId:operation});assert.equal(f.calls.filter(call=>call.options.method==='POST').length,1);
 assert.equal(f.context.current.messages[0].billing.status,'unknown');
});
test('the delayed final read is single-flight and an account change discards its admission decision',async()=>{
 const wait=deferred();let billReads=0,changed=false;
 const f=reconciler(async(route,_options,context)=>{
  if(route==='/config')return changed?{...config(),confirmation_context:'c'.repeat(64)}:config();
  billReads++;const updated=JSON.parse(JSON.stringify(context.current));
  if(billReads===7){await wait.promise;changed=true;Object.assign(updated.messages[0].billing,{billing_mode:'actual_usage_v1',admission_blocking:false});}
  return updated;
 });
 for(let index=0;index<6;index++){await f.reconcile();f.advance(60000);}f.advance(545000);
 const first=f.reconcile();await flush();const second=f.reconcile();await flush();assert.equal(billReads,7);
 wait.resolve();assert.equal(await first,false);assert.equal(await second,false);
 assert.notEqual(f.context.current.messages[0].billing.admission_blocking,false);
 assert.equal(f.context.billingChecks.size,0,'changed configuration discards the old exhausted budget');
 f.advance(1000000);await f.reconcile();assert.equal(billReads,8);
 assert.equal(f.calls.some(call=>/\/messages|\/retry$/.test(call.route)),false);
});
test('a late transition from dispatched to unknown gets one final check after observing unknown, at most eight automatic reads',async()=>{
 for(const serverAllows of [true,false]){
  let billReads=0;const f=reconciler((route,_options,context)=>{
   if(route==='/config')return config();billReads++;
   const updated=JSON.parse(JSON.stringify(context.current));
   Object.assign(updated.messages[0].billing,{status:billReads<=6?'dispatched':'unknown',billing_mode:'actual_usage_v1',admission_blocking:billReads===8?!serverAllows:true});
   return updated;
  });
  for(let i=0;i<6;i++){await f.reconcile();f.advance(60000);}assert.equal(billReads,6);
  f.advance(545000);await f.reconcile();assert.equal(billReads,7);assert.equal(f.context.current.messages[0].billing.admission_blocking,true);
  f.advance(904999);await f.reconcile();assert.equal(billReads,7);
  f.advance(1);await f.reconcile();assert.equal(billReads,8);assert.equal(f.context.current.messages[0].billing.admission_blocking,!serverAllows);
  for(let i=0;i<3;i++){f.advance(1000000);await f.reconcile();}assert.equal(billReads,8);
  assert.equal(f.context.current.messages[0].billing.status,'unknown');
  assert.equal(f.calls.some(call=>/\/messages|\/retry$/.test(call.route)),false);
 }
});
test('same-account configuration revision resets an exhausted false decision and obtains fresh admission automatically',async()=>{
 let billReads=0,activeContext=contextId;
 const f=reconciler((route,_options,context)=>{
  if(route==='/config')return {...config(),confirmation_context:activeContext};billReads++;
  const updated=JSON.parse(JSON.stringify(context.current));
  Object.assign(updated.messages[0].billing,{billing_mode:'actual_usage_v1',admission_blocking:billReads<7});return updated;
 });
 for(let i=0;i<6;i++){await f.reconcile();f.advance(60000);}f.advance(545000);await f.reconcile();
 assert.equal(billReads,7);assert.equal(f.context.current.messages[0].billing.admission_blocking,false);
 activeContext='c'.repeat(64);f.apply({...config(),confirmation_context:activeContext});
 assert.equal(f.context.billingChecks.size,0);assert.notEqual(f.context.current.messages[0].billing.admission_blocking,false);
 await f.reconcile();assert.equal(billReads,8);assert.equal(f.context.current.messages[0].billing.admission_blocking,false);
 assert.equal(f.context.billingChecks.get(`session-fixture/${operation}`).attempts,1);
 assert.equal(f.calls.some(call=>/\/messages|\/retry$/.test(call.route)),false);
});
test('an old pending read cannot overwrite a new configuration budget or its refreshed admission',async()=>{
 const wait=deferred();let billReads=0,activeContext=contextId;
 const f=reconciler(async(route,_options,context)=>{
  if(route==='/config')return {...config(),confirmation_context:activeContext};billReads++;
  const updated=JSON.parse(JSON.stringify(context.current));
  if(billReads===1){await wait.promise;updated.messages[0].billing.admission_blocking=true;}
  else Object.assign(updated.messages[0].billing,{billing_mode:'actual_usage_v1',admission_blocking:false});
  return updated;
 });
 const first=f.reconcile();await flush();activeContext='c'.repeat(64);f.apply({...config(),confirmation_context:activeContext});
 assert.equal(await f.reconcile(),true);const next=f.context.billingChecks.get(`session-fixture/${operation}`);
 assert.equal(next.attempts,1);assert.equal(f.context.current.messages[0].billing.admission_blocking,false);
 wait.resolve();assert.equal(await first,false);
 assert.equal(f.context.billingChecks.get(`session-fixture/${operation}`),next);assert.equal(next.attempts,1);
 assert.equal(f.context.current.messages[0].billing.admission_blocking,false);assert.equal(billReads,2);
});
test('session or account changes and mismatched query results cannot contaminate the selected conversation',async()=>{
 for(const change of ['session','selection','scope','operation','price']){
  let reads=0;const f=reconciler(async(route,_options,context)=>{
   if(route==='/config'){reads++;return change==='scope'&&reads===2?{...config(),confirmation_context:'c'.repeat(64)}:config();}
   const value=JSON.parse(JSON.stringify(context.current));value.messages[0].billing.status='settled';if(change==='session')context.current={id:'other-session',status:'failed',messages:[]};if(change==='selection')context.selection++;if(change==='operation')value.messages[0].billing.request_id='c'.repeat(32);if(change==='price')value.messages[0].billing.price_version='chat-new-version';return value;
  });
  assert.equal(await f.reconcile(),false,change);if(change!=='session')assert.equal(f.context.current.messages[0].billing.status,'unknown',change);else assert.equal(f.context.current.id,'other-session');
 }
});
test('recovery remains available after an accepted debt, but missing local identity and active generation fail closed',async()=>{
 const f=reconciler();await f.reconcile();assert.equal(f.calls.some(call=>call.route==='/capabilities'),false,'billing lookup must not require a new positive-balance activation');
 const g=reconciler(route=>route==='/config'?{ready:true,metered:true}:null);assert.equal(await g.reconcile(),false);assert.equal(g.calls.length,1);
 for(const key of ['submitting','uploading']){const h=reconciler();h.context[key]=true;await h.reconcile();assert.equal(h.calls.length,0);}
 const running=reconciler();running.item.status='running';await running.reconcile();assert.equal(running.calls.length,0);
});
test('late billing snapshots cannot regress a terminal bill or replace newer answer content',async()=>{
 for(const terminal of [false,true]){
  const f=reconciler(async(route,_options,context)=>{
   if(route==='/config')return config();const stale=JSON.parse(JSON.stringify(context.current));stale.messages[0].billing.status=terminal?'unknown':'settled';
   context.current.messages[0].text='更新后的已审查回答';context.current.messages[0].status='partial';if(terminal)context.current.messages[0].billing.status='settled';return stale;
  });
  assert.equal(await f.reconcile(),!terminal);assert.equal(f.context.current.messages[0].text,'更新后的已审查回答');assert.equal(f.context.current.messages[0].status,'partial');assert.equal(f.context.current.messages[0].billing.status,'settled');
 }
});
test('failed recovery requests back off without surfacing private errors or creating a generation request',async()=>{
 const f=reconciler(route=>{if(route==='/config')return config();throw Error('private-upstream-token');});
 for(let count=0;count<6;count++){assert.equal(await f.reconcile(),false);f.advance(60000);}await f.reconcile();
 assert.equal(f.calls.filter(call=>call.options.method==='POST').length,6);assert.equal(f.calls.some(call=>/\/messages|\/retry$/.test(call.route)),false);assert.equal(f.context.current.messages[0].billing.status,'unknown');
});
