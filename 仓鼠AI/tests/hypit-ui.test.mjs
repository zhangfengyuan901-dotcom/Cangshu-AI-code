import test from 'node:test';
import assert from 'node:assert/strict';
import {mountHypit,safeStudioUrl,hypitRequestTimeout,requestHypitJson} from '../public/hypit.mjs';

class Element {
  constructor(tag,document) { this.tagName=tag; this.ownerDocument=document; this.children=[]; this.dataset={}; this.attributes={}; this.listeners={}; this.value=''; this.disabled=false; this.hidden=false; this.textContent=''; }
  append(...nodes) { for (const node of nodes) { node.parent=this; this.children.push(node); } }
  replaceChildren(...nodes) { for (const node of this.children) node.parent=null; this.children=[]; this.append(...nodes); }
  setAttribute(name,value) { this.attributes[name]=value; }
  removeAttribute(name) { delete this.attributes[name];delete this[name]; }
  addEventListener(name,listener) { (this.listeners[name] ||= []).push(listener); }
  removeEventListener(name,listener) { this.listeners[name]=(this.listeners[name]||[]).filter(value=>value!==listener); }
  querySelector(selector) { const name=selector.slice(1,-1);return nodes(this).find(node=>Object.hasOwn(node.attributes,name)); }
  showModal() {this.open=true;}
  close() {this.open=false;this.emit('close');}
  focus() {}
  pause() { this.paused=true; }
  load() {}
  remove() { if (this.parent) this.parent.children=this.parent.children.filter(node=>node!==this); this.parent=null; }
  async emit(name) { await Promise.all((this.listeners[name]||[]).map(listener=>listener({preventDefault(){}}))); }
}
const document={createElement(tag){return new Element(tag,this);}};
const nodes=root=>[root,...root.children.flatMap(nodes)];
const find=(root,key)=>nodes(root).find(node=>node.dataset.hypit===key);
const flush=async()=>{for(let index=0;index<12;index++)await Promise.resolve();};
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const readyStatus=()=>({enabled:true,internalOnly:true,runtime:{state:'ready',items:[{id:'node',state:'ready'},{id:'hypit',state:'ready'}]},account:{state:'unverified',loginAvailable:false},projects:[{id:'project-1',name:'本地测试'}]});
function fixture(handler,onAgentSubmit,newOperationId=()=> 'fixture-shot-id') {
  const container=new Element('main',document),calls=[];
  const request=async(path,options={})=>{calls.push({path,...options});return handler(path,options);};
  const ui=mountHypit(container,{document,request,onAgentSubmit,newOperationId});
  return {container,calls,ui,get:key=>find(container,key)};
}

test('local startup and media operations use explicit longer deadlines; other calls stay bounded at 15 seconds',()=>{
  for(const [path,timeout] of [['/api/hypit/studio/open',40000],['/api/hypit/video/import-result',180000],['/api/hypit/video/start',150000],['/api/hypit/status',15000],['/api/hypit/projects',15000],['/api/hypit/video/quote',15000],['/api/hypit/video/operations/request-fixture',15000]]) assert.equal(hypitRequestTimeout(path),timeout,path);
});

test('deadline aborts the one fetch, clears its timer, and never retries a submitted identity',async()=>{
  const originals={fetch:globalThis.fetch,setTimeout:globalThis.setTimeout,clearTimeout:globalThis.clearTimeout};
  const calls=[],cleared=[];let expire,delay;
  try {
    globalThis.setTimeout=(callback,ms)=>{expire=callback;delay=ms;return 'test-timer';};
    globalThis.clearTimeout=timer=>cleared.push(timer);
    globalThis.fetch=(path,options)=>{calls.push({path,options});return new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>reject(new DOMException('aborted','AbortError')),{once:true}));};
    const request=requestHypitJson('/api/hypit/video/start',{method:'POST',body:{requestId:'original-task',revision:17}});
    assert.equal(delay,150000);assert.equal(calls.length,1);expire();
    await assert.rejects(request,{name:'AbortError'});
    assert.equal(calls.length,1);assert.equal(calls[0].options.signal.aborted,true);
    assert.deepEqual(JSON.parse(calls[0].options.body),{requestId:'original-task',revision:17});
    assert.deepEqual(cleared,['test-timer']);
  } finally { Object.assign(globalThis,originals); }
});

test('Studio accepts only a root URL on a strict local port and the comments anchor',()=>{
  assert.equal(safeStudioUrl('http://127.0.0.1:5179/'),'http://127.0.0.1:5179/');
  assert.equal(safeStudioUrl('http://127.0.0.1:5179/#comments'),'http://127.0.0.1:5179/#comments');
  assert.equal(safeStudioUrl('http://127.0.0.1:5179/','http://127.0.0.1:5179'),null,'Studio must be isolated from the host app origin');
  for(const value of ['https://example.com/','http://localhost:5179/','http://127.0.0.1:5179/api/config','http://127.0.0.1:80/','http://user:pass@127.0.0.1:5179/','http://127.0.0.1:5179/?token=x','http://127.0.0.1:5179/#anything','javascript:alert(1)','/api/config',null]) assert.equal(safeStudioUrl(value),null,value);
});

test('mount is read-only and omitted status fields never become ready',async()=>{
  const f=fixture(()=>({}));await f.ui.ready;
  assert.deepEqual(f.calls.map(call=>call.path),['/api/hypit/status']);
  assert.equal(f.get('create').disabled,true);assert.equal(f.get('login').disabled,true);assert.equal(f.get('agent-send').disabled,true);
  assert.match(f.get('runtime-state').textContent,/尚未启用/);
  assert.doesNotMatch(f.get('runtime-state').textContent,/所需依赖已检测/);
  f.ui.destroy();assert.equal(f.container.children.length,0);
});

test('a failed status check restores refresh but cannot leave actions enabled',async()=>{
  let fail=true;const f=fixture(()=>{if(fail)throw Error('https://private-provider.test secret-token');return readyStatus();});
  await f.ui.ready;assert.equal(f.get('refresh').disabled,false);assert.equal(f.get('create').disabled,true);
  assert.doesNotMatch(f.get('feedback').textContent,/private-provider|secret-token/);
  fail=false;await f.ui.refresh();assert.equal(f.get('create').disabled,false);
  assert.equal(f.get('open').disabled,false);assert.equal(f.get('login').disabled,true);
});

test('missing dependencies prevent Studio and GPT, not a false readiness claim',async()=>{
  const status=readyStatus();status.runtime.state='missing';status.runtime.items.push({id:'ffmpeg',state:'missing'});status.account={state:'connected',loginAvailable:true};status.agent={available:true};
  const f=fixture(()=>status,()=>{});await f.ui.ready;
  await f.get('open').emit('click');
  assert.equal(f.calls.length,1);assert.equal(f.get('open').disabled,true);assert.equal(f.get('agent-send').disabled,true);
  assert.match(f.get('runtime-state').textContent,/依赖不完整/);assert.match(f.get('runtime-items').children[2].textContent,/FFmpeg：缺失/);
});

test('Studio readiness never asserts that unverified generation or export dependencies are ready',async()=>{
  const status=readyStatus();status.runtime.items.push({name:'chrome',state:'unverified'},{name:'ffmpeg',state:'unverified'});
  const f=fixture(()=>status);await f.ui.ready;
  assert.equal(f.get('runtime-state').textContent,'Studio 组件已检测；生成与导出依赖仍需分别核验。');
  assert.match(f.get('runtime-items').children[2].textContent,/Chrome：未验证/);
  assert.match(f.get('runtime-items').children[3].textContent,/FFmpeg：未验证/);
});

test('a failed follow-up status read invalidates earlier Studio readiness',async()=>{
  let reads=0;
  const f=fixture(path=>{if(path.endsWith('/status')){if(++reads>1)throw Error('status failed');return readyStatus();}return {};});await f.ui.ready;
  assert.equal(f.get('open').disabled,false);
  f.get('project-name').value='新建项目';await f.get('project-name').parent.emit('submit');await flush();
  assert.equal(f.get('create').disabled,true);assert.equal(f.get('open'),undefined);
  assert.match(f.get('runtime-state').textContent,/本地状态未验证/);
  assert.equal(f.calls.some(call=>call.path.endsWith('/studio/open')),false);
});

test('project creation blocks duplicate clicks and recovers after failure',async()=>{
  const pending=deferred();let failCreate=true;
  const f=fixture((path)=>path.endsWith('/status')?readyStatus():failCreate?pending.promise:{});await f.ui.ready;
  f.get('project-name').value='测试项目';
  const form=f.get('project-name').parent;
  await form.emit('submit');await form.emit('submit');await flush();
  assert.equal(f.calls.filter(call=>call.path.endsWith('/projects')).length,1);assert.equal(f.get('create').disabled,true);
  pending.reject(Error('private failure'));await flush();
  assert.equal(f.get('create').disabled,false);assert.equal(f.get('project-name').value,'测试项目');
  failCreate=false;await form.emit('submit');await flush();
  assert.equal(f.calls.filter(call=>call.path.endsWith('/projects')).length,2);assert.equal(f.get('create').disabled,false);
});

test('Studio open rejects an unsafe server response without mounting a frame',async()=>{
  const f=fixture(path=>path.endsWith('/status')?readyStatus():{projectId:'project-1',url:'https://remote.example/'});await f.ui.ready;
  await f.get('open').emit('click');await flush();
  assert.equal(f.get('studio-host').children.length,0);assert.equal(f.get('open').disabled,false);
  assert.match(f.get('feedback').textContent,/未能安全打开/);
});

test('Studio is isolated, opens once during a pending request, and close is explicit',async()=>{
  const pending=deferred();
  const f=fixture(path=>path.endsWith('/status')?readyStatus():path.endsWith('/open')?pending.promise:{});await f.ui.ready;
  const opening=f.get('open').emit('click');await f.get('open').emit('click');await flush();
  assert.equal(f.calls.filter(call=>call.path.endsWith('/open')).length,1);
  pending.resolve({projectId:'project-1',url:'http://127.0.0.1:5179/'});await opening;await flush();
  const frame=f.get('studio-host').children[0];assert.equal(frame.tagName,'iframe');assert.equal(frame.src,'http://127.0.0.1:5179/');
  assert.equal(frame.attributes.sandbox,'allow-scripts allow-same-origin allow-downloads');assert.equal(frame.attributes.referrerpolicy,'no-referrer');
  await f.get('close').emit('click');await flush();assert.equal(f.get('studio-host').children.length,0);
  assert.equal(f.calls.filter(call=>call.path.endsWith('/close')).length,1);
});

test('login needs explicit eligibility and restores controls after failure',async()=>{
  const status=readyStatus();status.account.loginAvailable=true;
  const f=fixture(path=>{if(path.endsWith('/status'))return status;throw Error('private auth failure');});await f.ui.ready;
  assert.equal(f.get('login').disabled,false);assert.equal(f.calls.length,1);
  await f.get('login').emit('click');await flush();
  assert.equal(f.calls[1].path,'/api/hypit/account/login');assert.equal(f.calls[1].method,'POST');
  assert.equal(f.get('login').disabled,false);assert.doesNotMatch(f.get('feedback').textContent,/private auth/);
});

test('destroyed views ignore a late response',async()=>{
  const pending=deferred();const f=fixture(()=>pending.promise);f.ui.destroy();pending.resolve(readyStatus());await f.ui.ready;
  assert.equal(f.container.children.length,0);
});

const models=()=>({revision:17,models:[{id:'public-video',name:'已发布视频线路',durations:[4,5],resolutions:['720p'],ratios:['16:9']}]});
const videoOperation=(status='awaiting_confirmation')=>({requestId:'request-fixture',operationId:'manual-fixture-shot-id',projectId:'project-1',status,model:'public-video',name:'已发布视频线路',prompt:'一只仓鼠挥手',options:{duration:4,resolution:'720p',ratio:'16:9'},assetIds:[],quote:{id:'quote-fixture-id',model:'public-video',name:'已发布视频线路',price_version:2,currency:'CNY',unit:'second',unit_price_cny:'0.92',units:4,reference_surcharge_cny:'0',per_item_cny:'3.68',quantity:1,total_cny:'3.68',expires_at:Math.floor(Date.now()/1000)+300}});
async function loadVideo(f){await f.ui.ready;await f.get('video-refresh').emit('click');await flush();}
const taskActions=f=>nodes(f.get('video-operations')).filter(node=>node.dataset.hypit==='video-task-action');

test('manual video reads only current server options and quote does not confirm or submit',async()=>{
  const f=fixture(path=>path.endsWith('/status')?readyStatus():path.endsWith('/models')?models():path.includes('/operations?')?{operations:[]}:videoOperation());
  await loadVideo(f);assert.equal(f.get('video-duration').value,'4');assert.equal(f.get('video-resolution').value,'720p');
  assert.equal(f.calls.filter(call=>call.method==='POST').length,0);
  f.get('video-prompt').value='一只仓鼠挥手';await f.get('video-prompt').parent.emit('submit');await flush();
  const post=f.calls.find(call=>call.path.endsWith('/quote'));
  assert.deepEqual(post.body,{projectId:'project-1',operationId:'manual-fixture-shot-id',revision:17,model:'public-video',prompt:'一只仓鼠挥手',options:{duration:4,resolution:'720p',ratio:'16:9'},assetIds:[]});
  assert.equal(f.calls.some(call=>/\/(confirm|start)$/.test(call.path)),false);assert.equal(f.get('video-quote').disabled,true);
  assert.match(taskActions(f)[0].textContent,/¥3\.68/);
});

test('native price confirmation is required before a single explicit confirm and start',async()=>{
  const f=fixture(path=>path.endsWith('/status')?readyStatus():path.endsWith('/models')?models():path.includes('/operations?')?{operations:[videoOperation()]}:path.endsWith('/start')?videoOperation('queued'):videoOperation('confirmed'));
  await loadVideo(f);
  const pending=taskActions(f)[0].emit('click');await flush();
  assert.equal(f.calls.filter(call=>call.method==='POST').length,0);
  assert.equal(f.get('quote-accept').disabled,false);
  await f.get('quote-accept').emit('click');await pending;await flush();
  assert.deepEqual(f.calls.filter(call=>call.method==='POST').map(call=>call.path),['/api/hypit/video/confirm','/api/hypit/video/start']);
  assert.deepEqual(f.calls.find(call=>call.path.endsWith('/confirm')).body,{requestId:'request-fixture',quoteId:'quote-fixture-id',revision:17,confirmed:true});
  assert.deepEqual(taskActions(f).map(node=>node.textContent),['查询原任务']);
});

test('cancelling price confirmation never submits or confirms',async()=>{
  const f=fixture(path=>path.endsWith('/status')?readyStatus():path.endsWith('/models')?models():{operations:[videoOperation()]});await loadVideo(f);
  const pending=taskActions(f)[0].emit('click');await flush();await f.get('quote-cancel').emit('click');await pending;
  assert.equal(f.calls.some(call=>call.method==='POST'),false);assert.equal(f.get('refresh').disabled,false);
});

test('a lost submission response exposes only original-task query and never a new operation',async()=>{
  const f=fixture(path=>path.endsWith('/status')?readyStatus():path.endsWith('/models')?models():path.includes('/operations?')?{operations:[videoOperation()]}:path.endsWith('/confirm')?videoOperation('confirmed'):path.endsWith('/start')?Promise.reject(Error('private upstream text')):videoOperation('unknown'));
  await loadVideo(f);const pending=taskActions(f)[0].emit('click');await flush();await f.get('quote-accept').emit('click');await pending;await flush();
  assert.deepEqual(taskActions(f).map(node=>node.textContent),['查询原任务']);assert.doesNotMatch(f.get('feedback').textContent,/private upstream/);
  await taskActions(f)[0].emit('click');await flush();
  assert.equal(f.calls.filter(call=>call.path.endsWith('/start')).length,1);
  assert.deepEqual(taskActions(f).map(node=>node.textContent),['查询原任务']);
  f.get('video-prompt').value='一只仓鼠挥手';await f.get('video-prompt').emit('input');
  assert.equal(f.get('video-quote').disabled,true);await f.get('video-prompt').parent.emit('submit');await flush();
  assert.equal(f.calls.some(call=>call.path.endsWith('/quote')),false);
});

test('an expired quote refreshes the original identity without generating',async()=>{
  const expired=videoOperation();expired.quote.expires_at=1;
  const f=fixture(path=>path.endsWith('/status')?readyStatus():path.endsWith('/models')?models():path.includes('/operations?')?{operations:[expired]}:videoOperation());await loadVideo(f);
  const refresh=taskActions(f).find(node=>node.textContent.startsWith('重新获取'));await refresh.emit('click');await flush();
  const post=f.calls.find(call=>call.path.endsWith('/quote'));assert.equal(post.body.operationId,'manual-fixture-shot-id');assert.equal(post.body.model,expired.model);
  assert.equal(f.calls.some(call=>/\/(start|confirm)$/.test(call.path)),false);
});

test('a lost read-only quote may be checked again only with the exact original identity and parameters',async()=>{
  let quoteCalls=0;
  const f=fixture(path=>path.endsWith('/status')?readyStatus():path.endsWith('/models')?models():path.includes('/operations?')?{operations:[]}:++quoteCalls===1?Promise.reject(Error('lost quote response')):videoOperation());await loadVideo(f);
  f.get('video-prompt').value='一只仓鼠挥手';await f.get('video-prompt').parent.emit('submit');await flush();
  assert.equal(f.get('video-quote').disabled,false);assert.equal(f.get('video-prompt').disabled,true);
  f.get('video-prompt').value='不能悄悄换成新的请求';await f.get('video-prompt').parent.emit('submit');await flush();
  const quotes=f.calls.filter(call=>call.path.endsWith('/quote'));assert.equal(quotes.length,2);assert.deepEqual(quotes[1].body,quotes[0].body);
  assert.equal(f.calls.some(call=>/\/(confirm|start)$/.test(call.path)),false);
});

test('a quote for another model or multiple tasks cannot enable video confirmation',async()=>{
  for(const change of [quote=>quote.model='other-model',quote=>quote.quantity=4]) {
    const invalid=videoOperation();change(invalid.quote);
    const f=fixture(path=>path.endsWith('/status')?readyStatus():path.endsWith('/models')?models():{operations:[invalid]});await loadVideo(f);
    assert.equal(taskActions(f).some(node=>node.textContent.startsWith('确认并提交')),false);
    assert.equal(f.calls.some(call=>call.method==='POST'),false);
  }
});

test('an explicitly failed task has no retry and blocks an identical new identity',async()=>{
  const f=fixture(path=>path.endsWith('/status')?readyStatus():path.endsWith('/models')?models():{operations:[videoOperation('failed')]});await loadVideo(f);
  assert.deepEqual(taskActions(f).map(node=>node.textContent),['查询原任务']);
  f.get('video-prompt').value='一只仓鼠挥手';await f.get('video-prompt').emit('input');assert.equal(f.get('video-quote').disabled,true);
  await f.get('video-prompt').parent.emit('submit');await flush();assert.equal(f.calls.some(call=>call.method==='POST'),false);
});

test('a completed local result is imported only by explicit click into the isolated Studio',async()=>{
  const completed=videoOperation('succeeded');completed.result={url:'/api/hypit/video/operations/request-fixture/file',mediaType:'video/mp4'};
  const pending=deferred();
  const f=fixture(path=>path.endsWith('/status')?readyStatus():path.endsWith('/models')?models():path.includes('/operations?')?{operations:[completed]}:pending.promise);await loadVideo(f);
  const action=taskActions(f).find(node=>node.textContent==='放入 Hypit Studio');assert.ok(action);assert.equal(f.calls.some(call=>call.method==='POST'),false);
  const importing=action.emit('click');await action.emit('click');await flush();assert.equal(f.calls.filter(call=>call.path.endsWith('/import-result')).length,1);
  assert.deepEqual(f.calls.find(call=>call.path.endsWith('/import-result')).body,{requestId:'request-fixture'});
  pending.resolve({projectId:'project-1',url:'http://127.0.0.1:5180/'});await importing;await flush();
  const frame=f.get('studio-host').children[0];assert.equal(frame.src,'http://127.0.0.1:5180/');assert.equal(frame.attributes.sandbox,'allow-scripts allow-same-origin allow-downloads');assert.equal(frame.attributes.referrerpolicy,'no-referrer');
  assert.equal(f.calls.some(call=>/\/(confirm|start)$/.test(call.path)),false);
});

test('a completed local video opens in an in-app media dialog without a popup or new generation',async()=>{
  const completed=videoOperation('succeeded');completed.result={url:'/api/hypit/video/operations/request-fixture/file',mediaType:'video/mp4'};
  const f=fixture(path=>path.endsWith('/status')?readyStatus():path.endsWith('/models')?models():{operations:[completed]});await loadVideo(f);
  assert.equal(f.get('video-preview').open,undefined);
  await taskActions(f).find(node=>node.textContent==='查看本地视频').emit('click');
  assert.equal(f.get('video-preview').open,true);assert.equal(f.get('video-preview-media').tagName,'video');assert.equal(f.get('video-preview-media').src,completed.result.url);assert.equal(f.get('video-preview-download').href,completed.result.url);assert.equal(f.get('video-preview-download').download,'');
  assert.equal(nodes(f.container).some(node=>node.target==='_blank'),false);assert.equal(f.calls.some(call=>call.method==='POST'),false);
  await f.get('video-preview-close').emit('click');assert.equal(f.get('video-preview').open,false);assert.equal(f.get('video-preview-media').src,undefined);assert.equal(f.get('video-preview-media').paused,true);assert.equal(f.get('video-preview-download').href,undefined);
});

test('account changes close local preview and stale preview actions cannot reopen it',async()=>{
  let execution={scope:'wallet-a',revision:1};const completed=videoOperation('succeeded');completed.result={url:'/api/hypit/video/operations/request-fixture/file'};
  const f=fixture(path=>path.endsWith('/status')?{...readyStatus(),execution}:path.endsWith('/models')?models():{operations:[completed]});await loadVideo(f);
  const open=taskActions(f).find(node=>node.textContent==='查看本地视频');await open.emit('click');assert.equal(f.get('video-preview').open,true);
  execution={scope:'wallet-b',revision:2};await f.ui.refresh();assert.equal(f.get('video-preview').open,false);assert.equal(f.get('video-preview-media').src,undefined);await open.emit('click');assert.equal(f.get('video-preview').open,false);assert.equal(f.calls.some(call=>call.method==='POST'),false);
});

test('nonlocal results cannot be imported and a failed local preview never replays generation',async()=>{
  for(const url of ['https://private.example/result.mp4','/api/hypit/video/operations/another-task/file','/api/hypit/video/operations/request-fixture/file?token=private']) {
    const completed=videoOperation('succeeded');completed.result={url};
    const f=fixture(path=>path.endsWith('/status')?readyStatus():path.endsWith('/models')?models():{operations:[completed]});await loadVideo(f);
    assert.equal(taskActions(f).some(node=>node.textContent==='放入 Hypit Studio'),false);assert.equal(f.calls.some(call=>call.method==='POST'),false);
  }
  const completed=videoOperation('succeeded');completed.result={url:'/api/hypit/video/operations/request-fixture/file'};
  const f=fixture(path=>path.endsWith('/status')?readyStatus():path.endsWith('/models')?models():path.includes('/operations?')?{operations:[completed]}:{projectId:'project-1',url:'https://unsafe.example/'});await loadVideo(f);
  await taskActions(f).find(node=>node.textContent==='放入 Hypit Studio').emit('click');await flush();
  assert.equal(f.get('studio-host').children.length,0);
  assert.equal(f.get('feedback').textContent,'本地预览未完成，原视频仍保留；请检查本地媒体组件');
  assert.equal(f.calls.some(call=>/\/(confirm|start)$/.test(call.path)),false);
});

test('scope or revision changes close an open quote dialog and remove prior account rows and quote content',async()=>{
  for(const changed of [{scope:'wallet-b',revision:2},{scope:'wallet-a',revision:2}]) {
    let execution={scope:'wallet-a',revision:1};
    const f=fixture(path=>path.endsWith('/status')?{...readyStatus(),execution}:path.endsWith('/models')?models():{operations:execution.revision===1?[videoOperation()]:[]});await loadVideo(f);
    const oldConfirm=taskActions(f)[0],pending=oldConfirm.emit('click');await flush();
    const dialog=f.get('quote-accept').parent.parent;assert.equal(dialog.open,true);
    execution=changed;await f.ui.refresh();await pending;await flush();
    assert.equal(dialog.open,false);assert.equal(dialog.querySelector('[data-quote-total]').textContent,'');
    assert.deepEqual(taskActions(f),[]);assert.equal(f.get('video-model').children.length,0);assert.equal(f.get('video-quote').disabled,true);
    await oldConfirm.emit('click');await flush();assert.equal(f.calls.some(call=>call.method==='POST'),false);
    await f.get('video-refresh').emit('click');await flush();assert.deepEqual(taskActions(f),[]);
  }
});

test('a failed status refresh cancels open confirmation and requires a fresh read before original operations return',async()=>{
  let fail=false;
  const f=fixture(path=>{if(path.endsWith('/status')){if(fail)throw Error('private failure');return {...readyStatus(),execution:{scope:'wallet-a',revision:1}};}return path.endsWith('/models')?models():{operations:[videoOperation()]};});await loadVideo(f);
  const pending=taskActions(f)[0].emit('click');await flush();fail=true;await f.ui.refresh();await pending;await flush();
  assert.deepEqual(taskActions(f),[]);assert.equal(f.get('video-model').children.length,0);assert.equal(f.get('video-quote').disabled,true);
  assert.equal(f.get('quote-accept').parent.parent.open,false);assert.equal(f.calls.some(call=>call.method==='POST'),false);
  fail=false;await f.ui.refresh();assert.deepEqual(taskActions(f),[]);
  await f.get('video-refresh').emit('click');await flush();assert.equal(taskActions(f).some(node=>node.textContent.startsWith('确认并提交')),true);
});

test('account refresh preserves the manual shot identity and restores unknown only as the original task',async()=>{
  let revision=1,record=null,identities=0;
  const f=fixture(path=>path.endsWith('/status')?{...readyStatus(),execution:{scope:'wallet-a',revision}}:path.endsWith('/models')?models():path.includes('/operations?')?{operations:record?[record]:[]}:path.endsWith('/quote')?(record=videoOperation()):path.endsWith('/confirm')?(record=videoOperation('confirmed')):(record=videoOperation('unknown')),undefined,()=>{identities++;return 'fixture-shot-id';});await loadVideo(f);
  f.get('video-prompt').value='一只仓鼠挥手';await f.get('video-prompt').parent.emit('submit');await flush();
  const pending=taskActions(f)[0].emit('click');await flush();await f.get('quote-accept').emit('click');await pending;
  revision=2;await f.ui.refresh();assert.deepEqual(taskActions(f),[]);assert.equal(identities,1);
  await f.get('video-refresh').emit('click');await flush();assert.deepEqual(taskActions(f).map(node=>node.textContent),['查询原任务']);
  await f.get('video-prompt').parent.emit('submit');await flush();assert.equal(identities,1);
  assert.equal(f.calls.filter(call=>call.path.endsWith('/quote')).length,1);assert.equal(f.calls.filter(call=>call.path.endsWith('/start')).length,1);
  await taskActions(f)[0].emit('click');await flush();assert.equal(f.calls.at(-1).path,'/api/hypit/video/operations/request-fixture');
});

test('a prior-account quote response cannot restore rows after execution scope changes',async()=>{
  let execution={scope:'wallet-a',revision:1};const pending=deferred();
  const f=fixture(path=>path.endsWith('/status')?{...readyStatus(),execution}:path.endsWith('/models')?models():path.includes('/operations?')?{operations:[]}:pending.promise);await loadVideo(f);
  f.get('video-prompt').value='一只仓鼠挥手';await f.get('video-prompt').parent.emit('submit');await flush();
  execution={scope:'wallet-b',revision:2};await f.ui.refresh();pending.resolve(videoOperation());await flush();
  assert.deepEqual(taskActions(f),[]);assert.equal(f.get('video-prompt').value,'');assert.equal(f.get('video-quote').disabled,true);
  assert.equal(f.calls.filter(call=>call.path.endsWith('/quote')).length,1);assert.equal(f.calls.some(call=>call.path.endsWith('/start')),false);
});

test('switching accounts while confirmation is in flight cannot continue to start generation',async()=>{
  let execution={scope:'wallet-a',revision:1};const confirmation=deferred();
  const f=fixture(path=>path.endsWith('/status')?{...readyStatus(),execution}:path.endsWith('/models')?models():path.includes('/operations?')?{operations:[videoOperation()]}:confirmation.promise);await loadVideo(f);
  const pending=taskActions(f)[0].emit('click');await flush();await f.get('quote-accept').emit('click');await flush();
  assert.equal(f.calls.filter(call=>call.path.endsWith('/confirm')).length,1);
  execution={scope:'wallet-b',revision:2};await f.ui.refresh();confirmation.resolve(videoOperation('confirmed'));await pending;await flush();
  assert.equal(f.calls.some(call=>call.path.endsWith('/start')),false);assert.deepEqual(taskActions(f),[]);
});
