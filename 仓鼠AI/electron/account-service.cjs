const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const {createBrowserAccount}=require('./account-browser.cjs');
const {createPiknoClient,publishedName}=require('../pikno-client.cjs');

const ORIGIN = 'https://www.piknoai.com';
const GROUPS = Object.freeze({'image-standard':'图片','video-standard':'视频','tool-standard':'工具','chat-standard':'对话'});
const LEDGER_LABELS = Object.freeze({'image-standard':'图片生成','video-standard':'视频生成','tool-standard':'数字人与工具','chat-standard':'AI 对话'});
const fail = (code, extra = {}) => Object.assign(new Error(code), {code,...extra});
const text = (value, length = 100) => typeof value === 'string' ? value.replace(/[\u0000-\u001f]/g,'').slice(0,length) : '';
const positive = value => Number.isSafeInteger(value) && value > 0;
const uuid = value => typeof value==='string' && /^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i.test(value);
const metadata = row => positive(row?.id) && Object.hasOwn(GROUPS,row?.group) && positive(row.created_time) && typeof row.name === 'string' && row.name.length>0 && row.name.length <= 100 && !/[\u0000-\u001f]/.test(row.name) ? {id:row.id,name:row.name,group:row.group,createdAt:row.created_time,status:Number(row.status),expiresAt:Number(row.expired_time)} : null;
const safeCodes = new Set(['INVALID_REQUEST','LOGIN_REQUIRED','ACCOUNT_CHANGED','NETWORK','RATE_LIMITED','ACCOUNT_MISMATCH','KEY_STORAGE_UNAVAILABLE','KEY_INVALID','KEY_FORBIDDEN','CONNECT_FAILED','PENDING_OPERATION','STORAGE_UNAVAILABLE','FORBIDDEN','DESKTOP_FLOW_INVALID','DESKTOP_ACCOUNT_MISMATCH','DESKTOP_FLOW_COMPLETE','DESKTOP_SETUP_FAILED']);

// This journal contains only operation identity. A missing/corrupt journal must
// never silently permit replay of an uncertain key creation.
function createJournal(file) {
  let entries = {}, blocked = false;
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536) throw Error();
    const stored = JSON.parse(fs.readFileSync(file,'utf8'));
    if (stored?.format !== 1 || !Array.isArray(stored.entries) || stored.entries.length > 128) throw Error();
    for (const item of stored.entries) {
      if (!positive(item?.userId) || !Object.hasOwn(GROUPS,item.group) || !/^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i.test(item.requestId || '') || !positive(item.startedAt) || typeof item.name !== 'string' || !item.name.length || item.name.length > 100 || /[\u0000-\u001f]/.test(item.name) || !['pending','selected','saved'].includes(item.state) || item.state!=='pending'&&(!positive(item.keyId)||!positive(item.createdAt)) || item.keyId !== undefined && !positive(item.keyId) || item.createdAt !== undefined && !positive(item.createdAt) || Object.keys(item).some(key => !['userId','group','requestId','startedAt','name','state','keyId','createdAt'].includes(key))) throw Error();
      entries[`${item.userId}:${item.group}`] = item;
    }
  } catch (error) { if (error.code !== 'ENOENT') blocked = true; }
  const get = (id,group) => entries[`${id}:${group}`];
  return {
    get,
    list: id => Object.values(entries).filter(item => item.userId === id),
    async save(item) {
      if (blocked) throw fail('STORAGE_UNAVAILABLE');
      const next = {...entries,[`${item.userId}:${item.group}`]:item};
      if (Object.keys(next).length > 128) throw fail('STORAGE_UNAVAILABLE');
      const temporary = file + '.' + randomUUID() + '.tmp';
      try {
        await fs.promises.mkdir(path.dirname(file),{recursive:true});
        await fs.promises.writeFile(temporary,JSON.stringify({format:1,entries:Object.values(next)}),{flag:'wx',mode:0o600});
        await fs.promises.rename(temporary,file); entries = next;
      } catch { throw fail('STORAGE_UNAVAILABLE'); }
      finally { await fs.promises.unlink(temporary).catch(()=>{}); }
    },
    assertReadable() { if (blocked) throw fail('STORAGE_UNAVAILABLE'); },
  };
}

function createAccountService({fetchImpl,journalFile,connectCreatedKey,getConnectedAccountId=()=>null,getConfiguredGroups=()=>[],browserCipher,openExternal=()=>{throw fail('FORBIDDEN');},onConfigured=()=>{},onFailure=()=>{},isCurrent=()=>true,origin=ORIGIN,allowLoopbackForTests=false,now=Date.now}) {
  if (origin !== ORIGIN && !(allowLoopbackForTests && /^https?:\/\/127\.0\.0\.1:\d+$/.test(origin))) throw Error('Invalid account origin');
  const journal = createJournal(journalFile);
  const {readLedgerCatalog}=createPiknoClient({endpoint:origin,fetchImpl});
  let bundle = null, epoch = 0, suspended = false, closed = false, queue = Promise.resolve();
  const routeRetryAt = new Map();
  const selections = new Map();
  const reset = () => { bundle = null; epoch++; selections.clear(); };
  const current = ticket => !closed && !suspended && ticket === epoch && isCurrent();
  const assertCurrent = ticket => { if (!current(ticket)) throw fail('ACCOUNT_CHANGED'); };
  async function wire(route, options = {}) {
    if (!route.startsWith('/api/') || route.includes('://')) throw fail('INVALID_REQUEST');
    // Key IDs and query parameters share their route budget without blocking other operations.
    const routeKey = `${(options.method || 'GET').toUpperCase()} ${new URL(route,origin).pathname.replace(/\/token\/\d+(?=\/|$)/,'/token/:id')}`;
    for (const [key,until] of routeRetryAt) if (until <= now()) routeRetryAt.delete(key);
    const retryAt = routeRetryAt.get(routeKey) || 0;
    if (retryAt > now()) throw fail('RATE_LIMITED',{retryAfterMs:retryAt-now(),httpStatus:429});
    const ticket = epoch, controller = new AbortController(), timer = setTimeout(()=>controller.abort(),15000);
    try {
      const response = await fetchImpl(origin+route,{...options,headers:{Origin:origin,Referer:origin+'/account-lite/index.html',...options.headers},credentials:'include',cache:'no-store',redirect:'error',signal:controller.signal});
      assertCurrent(ticket);
      if (response.status === 429) {
        const value = response.headers.get('Retry-After'), seconds = /^\d+(\.\d+)?$/.test(value || '') ? Number(value)*1000 : Date.parse(value)-now();
        const retryAfterMs = Math.max(1000,Math.min(3600000,Number.isFinite(seconds)?seconds:60000));
        routeRetryAt.set(routeKey,now()+retryAfterMs); throw fail('RATE_LIMITED',{retryAfterMs,httpStatus:429});
      }
      let data; try { data = await response.json(); } catch { throw fail('NETWORK'); }
      assertCurrent(ticket); return {response,data};
    } catch (error) { if (safeCodes.has(error?.code)) throw error; throw fail('NETWORK'); }
    finally { clearTimeout(timer); }
  }
  async function refresh() {
    const {response,data} = await wire('/api/user/auth/refresh',{method:'POST',headers:bundle?.session?.sid?{'X-Auth-Session':bundle.session.sid}:{}});
    if ([401,409].includes(response.status)) { reset(); throw fail('LOGIN_REQUIRED'); }
    const next = data?.data;
    if (!response.ok || data?.success !== true || !positive(next?.user?.id) || typeof next.access_token !== 'string' || !next.access_token || typeof next.session?.sid !== 'string' || !(next.access_expires_at > now()/1000)) throw fail('NETWORK');
    if (bundle && (bundle.user.id !== next.user.id || bundle.session.sid !== next.session.sid)) { reset(); throw fail('ACCOUNT_CHANGED'); }
    bundle = next;
  }
  async function request(route,{method='GET',body,retry=true}={}) {
    if (!bundle || bundle.access_expires_at < now()/1000+20) await refresh();
    const {response,data} = await wire(route,{method,headers:{Authorization:`Bearer ${bundle.access_token}`,...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});
    if (response.status === 401) {
      if (method==='GET' && retry) { await refresh(); return request(route,{method,retry:false}); }
      throw fail('LOGIN_REQUIRED');
    }
    if (!response.ok || !(data?.success===true || data?.message==='success')) throw fail('NETWORK');
    return data;
  }
  const money = (quota,status) => Number.isFinite(Number(quota)) && Number(status?.quota_per_unit)>0 && Number(status?.usd_exchange_rate)>0 ? Number(quota)/Number(status.quota_per_unit)*Number(status.usd_exchange_rate) : null;
  async function status() { const {response,data}=await wire('/api/status'); if (!response.ok || data?.success!==true) throw fail('NETWORK'); return data.data; }
  async function publishedLedgerNames() {
    const ticket=epoch;
    const names=new Map();
    try {
      const data=await readLedgerCatalog();
      if(data?.success===true&&Array.isArray(data.data?.models)){
        for(const line of data.data.models){
          const name=publishedName(line?.name,'');
          if(typeof line?.id==='string'&&name)names.set(line.id,name);
        }
      }
    }catch{}
    assertCurrent(ticket);
    return names;
  }
  const browser=createBrowserAccount({request:wire,file:journalFile+'.browser',cipher:browserCipher,origin,
    getBundle:()=>bundle,getConnectedAccountId,getConfiguredGroups,openExternal,now,ensureBundle:refresh,isCurrent:()=>current(epoch),
    async adopt(value){
      if(typeof value.access_token!=='string'||!value.access_token||value.token_type!=='Bearer'
        || !(value.access_expires_at>now()/1000)||!positive(value.user?.id)||typeof value.session?.sid!=='string'||!value.session.sid)throw fail('NETWORK');
      const {response,data}=await wire('/api/user/self',{headers:{Authorization:'Bearer '+value.access_token}});
      if(!response.ok||data?.success!==true||data.data?.id!==value.user.id)throw fail('ACCOUNT_CHANGED');
      bundle={access_token:value.access_token,token_type:value.token_type,access_expires_at:value.access_expires_at,
        session:value.session,user:value.user};selections.clear();
    },
    async install(key,requestId){
      const userId=bundle.user.id,row=metadata((await request(`/api/token/${key.id}`)).data);
      if(!row||row.group!==key.group||row.id!==key.id)throw fail('KEY_INVALID');
      const existing=journal.get(userId,key.group);
      if(existing?.state==='pending')throw fail('PENDING_OPERATION');
      await activate({userId,group:row.group,name:row.name,requestId,startedAt:now(),keyId:row.id,createdAt:row.createdAt,state:'selected'},row,key.key);
    }});
  async function lookup(operation) {
    const response = await request(`/api/token/search?keyword=${encodeURIComponent(operation.name)}&p=1&size=100`);
    if(!Array.isArray(response.data?.items) || !Number.isSafeInteger(response.data?.total) || response.data.total!==response.data.items.length)throw fail('PENDING_OPERATION');
    const rows = (response.data?.items || []).map(metadata).filter(Boolean).filter(row => row.name===operation.name && row.group===operation.group && (operation.keyId ? row.id===operation.keyId && row.createdAt===operation.createdAt : row.createdAt>=Math.floor(operation.startedAt/1000)-2));
    if (rows.length!==1) throw fail('PENDING_OPERATION');
    return rows[0];
  }
  async function activate(operation,row,providedKey) {
    if (operation.state==='saved') return {ok:true,code:'SAVED_CHECK_PENDING',saved:true,kind:operation.group.split('-')[0]};
    if (row.status!==1 || row.expiresAt>0 && row.expiresAt<=now()/1000) throw fail('KEY_INVALID');
    operation={...operation,keyId:row.id,createdAt:row.createdAt,state:'selected'};
    await journal.save(operation);
    const ticket=epoch; let data,payload;
    try {
      data=providedKey===undefined?(await request(`/api/token/${row.id}/key`,{method:'POST'})).data:{key:providedKey};
      assertCurrent(ticket);
      let key=data?.key;
      if (typeof key==='string' && /^[a-zA-Z0-9]{48}$/.test(key)) key='sk-'+key;
      if (typeof key!=='string' || !/^sk-[a-zA-Z0-9]{20,128}$/.test(key)) throw fail('KEY_INVALID');
      payload={userId:operation.userId,keyId:row.id,group:row.group,name:row.name,createdAt:row.createdAt,requestId:operation.requestId,key}; key='';
      const result=await connectCreatedKey(payload,{assertCurrent:()=>current(ticket)});
      assertCurrent(ticket);
      if (!result?.ok || !['CONNECTED','SAVED_CHECK_PENDING'].includes(result.code)) throw fail(safeCodes.has(result?.code)?result.code:'CONNECT_FAILED',{httpStatus:result?.httpStatus,retryAfterMs:result?.retryAfterMs});
      await journal.save({...operation,state:'saved'}); onConfigured();
      const limited=result.httpStatus===429?{httpStatus:429,retryAfterMs:Math.min(3600000,Math.max(1000,Number(result.retryAfterMs)||60000))}:{};
      return {ok:true,code:result.code,saved:true,kind:row.group.split('-')[0],connected:result.code==='CONNECTED',...limited};
    } finally { if (data) data.key=''; if (payload) payload.key=''; }
  }
  async function run(action,value={}) {
    if (closed || !isCurrent()) throw fail('FORBIDDEN');
    if (suspended) throw fail('WINDOW_OPEN');
    if (!value || typeof value!=='object' || Array.isArray(value)) throw fail('INVALID_REQUEST');
    if(action==='browser-open'||action==='browser-poll'){
      if(Object.keys(value).length)throw fail('INVALID_REQUEST');
      if(action==='browser-poll')return browser.poll();
      if(!browser.hasPending()&&(!bundle||bundle.access_expires_at<now()/1000+20)){try{await refresh();}catch(error){if(error.code!=='LOGIN_REQUIRED')throw error;}}
      return browser.open();
    }
    const contracts={snapshot:[],logout:[],keys:['group','page'],usage:['page','kind'],create:['group','days','limit','requestId'],enable:['id','group'],recover:['group']};
    if (!contracts[action] || Object.keys(value).some(key=>!contracts[action].includes(key))) throw fail('INVALID_REQUEST');
    if (['keys','create','enable','recover'].includes(action) && !Object.hasOwn(GROUPS,value.group)) throw fail('INVALID_REQUEST');
    if (value.page!==undefined && (!positive(value.page)||value.page>10000)) throw fail('INVALID_REQUEST');
    if (action==='snapshot') {
      if(browser.hasPending()){
        const result=await browser.poll();
        if(result.pending)return {ok:true,signedIn:Boolean(bundle),browserPending:true,
          ...(bundle?{user:{id:bundle.user.id,username:text(bundle.user.username),email:text(bundle.user.email,254)},accountMatched:getConnectedAccountId()===null||getConnectedAccountId()===bundle.user.id}: {})};
      }
      try { if (!bundle) await refresh(); const user=(await request('/api/user/self')).data; if (user?.id!==bundle.user.id) { reset(); throw fail('ACCOUNT_CHANGED'); }
        const display=await status(), groups=(await request('/api/user/self/groups')).data;
        const connectedId=getConnectedAccountId();
        return {ok:true,signedIn:true,accountMatched:connectedId===null||connectedId===undefined||connectedId===user.id,user:{id:user.id,username:text(user.username),email:text(user.email,254)},balance:money(user.quota,display),spent:money(user.used_quota,display),requests:Number(user.request_count)||0,groups:Object.keys(GROUPS).filter(group=>Object.hasOwn(groups||{},group)),pending:journal.list(user.id).filter(item=>item.state!=='saved').map(({group,name,state})=>({group,name,state}))};
      } catch(error) { if(error.code==='LOGIN_REQUIRED') return {ok:true,signedIn:false}; throw error; }
    }
    if (!bundle || bundle.access_expires_at<now()/1000+20) await refresh();
    const userId=bundle.user.id;
    if(['create','enable','recover'].includes(action)){
      const connectedId=getConnectedAccountId();
      if(connectedId!==null&&connectedId!==undefined&&connectedId!==userId)throw fail('ACCOUNT_MISMATCH');
    }
    if (action==='logout') { const {response,data}=await wire('/api/user/auth/logout',{method:'POST',headers:{'X-Auth-Session':bundle.session.sid,Authorization:`Bearer ${bundle.access_token}`}}); if(!response.ok||data?.success!==true) throw fail('NETWORK'); await browser.cancel();reset(); return {ok:true}; }
    if (action==='keys') {
      const page=value.page||1,data=(await request(`/api/token/?p=${page}&size=20`)).data;
      const items=(data?.items||[]).slice(0,20).map(metadata).filter(row=>row?.group===value.group);
      for(const row of items)selections.set(row.id,{...row,userId});
      while(selections.size>200)selections.delete(selections.keys().next().value);
      return {ok:true,items,total:Number(data?.total)||0,page};
    }
    if (action==='usage') {
      const page=value.page||1,kind=value.kind||'usage'; if(!['usage','settlements'].includes(kind))throw fail('INVALID_REQUEST');
      const data=(await request(kind==='settlements'?`/api/pikno/settlements/self?page=${page}`:`/api/log/self?p=${page}&page_size=20&type=2`)).data,display=await status();
      const rows=(Array.isArray(data?.items)?data.items:[]).slice(0,20);
      const settlement=kind==='settlements';
      const modelID=row=>settlement?(row.model??row.model_name):row.model_name;
      const names=rows.some(row=>typeof modelID(row)==='string'&&modelID(row))?await publishedLedgerNames():new Map();
      const label=settlement?'任务结算':'API 消费';
      return {ok:true,page,total:Number(data?.total)||0,items:rows.map(row=>({
        kind:Object.hasOwn(GROUPS,row.group)?GROUPS[row.group]:label,
        createdAt:Number(row.created_at)||0,amount:money(settlement?row.net_quota:row.quota,display),
        model:names.get(modelID(row))||(Object.hasOwn(LEDGER_LABELS,row.group)?LEDGER_LABELS[row.group]:label),
        state:settlement?(row.review_required?'pending_review':['settled','reserved','refunded','partially_refunded'].includes(row.financial_state)?row.financial_state:'pending_review'):'',
      }))};
    }
    journal.assertReadable();
    let operation=journal.get(userId,value.group);
    if(action==='create'&&!uuid(value.requestId))throw fail('INVALID_REQUEST');
    if (action==='recover' || action==='create' && operation && (operation.state==='pending'||operation.requestId===value.requestId)) { if(!operation)throw fail('INVALID_REQUEST'); return activate(operation,operation.state==='saved'?null:await lookup(operation)); }
    if (action==='enable') {
      if(!positive(value.id))throw fail('INVALID_REQUEST');
      if(operation?.state==='pending')throw fail('PENDING_OPERATION');
      const selected=selections.get(value.id);
      if(!selected || selected.userId!==userId || selected.group!==value.group)throw fail('INVALID_REQUEST');
      const row=metadata((await request(`/api/token/${value.id}`)).data);
      if(!row||row.id!==value.id||row.group!==value.group||row.name!==selected.name||row.createdAt!==selected.createdAt)throw fail('KEY_INVALID');
      operation={userId,group:row.group,name:row.name,requestId:randomUUID(),startedAt:now(),keyId:row.id,createdAt:row.createdAt,state:'selected'};
      return activate(operation,row);
    }
    if(action==='create') {
      if(![7,30,-1].includes(value.days) || typeof value.limit!=='string' || value.limit.length>20 || value.limit!=='' && (!/^\d+(\.\d{1,2})?$/.test(value.limit)||Number(value.limit)<=0))throw fail('INVALID_REQUEST');
      const groups=(await request('/api/user/self/groups')).data;if(!Object.hasOwn(groups||{},value.group))throw fail('KEY_FORBIDDEN');
      const display=await status(),unlimited=value.limit==='';
      const remain=unlimited?0:Math.round(Number(value.limit)/Number(display.usd_exchange_rate)*Number(display.quota_per_unit));
      if(!unlimited&&(!positive(remain)||!(Number(display.usd_exchange_rate)>0)||!(Number(display.quota_per_unit)>0)))throw fail('INVALID_REQUEST');
      operation={userId,group:value.group,name:`仓鼠-${GROUPS[value.group]}-${randomUUID()}`,requestId:value.requestId,startedAt:now(),state:'pending'};
      await journal.save(operation);
      await request('/api/token/',{method:'POST',body:{name:operation.name,group:value.group,expired_time:value.days===-1?-1:Math.floor(now()/1000)+value.days*86400,remain_quota:remain,unlimited_quota:unlimited,model_limits_enabled:false,model_limits:'',allow_ips:'',auto_groups:[],cross_group_retry:false}});
      return activate(operation,await lookup(operation));
    }
    throw fail('INVALID_REQUEST');
  }
  function command(action,value) {
    const task=queue.then(()=>run(action,value)).catch(error=>{
      const code=safeCodes.has(error?.code)?error.code:'NETWORK';
      if(['create','enable','recover'].includes(action)&&!['RATE_LIMITED','PENDING_OPERATION','ACCOUNT_CHANGED','WINDOW_OPEN','LOGIN_REQUIRED','INVALID_REQUEST'].includes(code))onFailure({code:'ACCOUNT_KEY_IMPORT_FAILED',httpStatus:Number.isInteger(error.httpStatus)?error.httpStatus:0});
      return {ok:false,code,...(code==='RATE_LIMITED'?{retryAfterMs:Math.min(3600000,Math.max(1,Number(error.retryAfterMs)||60000))}: {})};
    });
    queue=task.then(()=>{});return task;
  }
  return {command,hasBrowserPending:browser.hasPending,async suspend(){suspended=true;reset();await queue;},resume(){suspended=false;reset();},dispose(){closed=true;reset();},invalidate:reset};
}
module.exports={ORIGIN,GROUPS,createAccountService,createJournal};
