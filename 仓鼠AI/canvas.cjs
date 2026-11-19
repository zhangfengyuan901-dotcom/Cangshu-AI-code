// HAMSTER owns canvas documents, references and execution. No provider credentials in documents.
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const idPattern=/^[a-f0-9]{32}$/;
const channels=new Set(['image','backup','main','digital','depth']);
const error=(message,status=400)=>Object.assign(new Error(message),{status,statusCode:status});
const balanceFailure={failureCode:'insufficient_balance',status:'failed',error:'PIKNO 账户余额不足，请前往账户页充值'};
async function read(req,limit=2*1024*1024){let size=0;const parts=[];for await(const part of req){size+=part.length;if(size>limit)throw error('请求过大',413);parts.push(part);}return Buffer.concat(parts);}
async function json(req){try{return JSON.parse((await read(req)).toString());}catch(e){if(e.status)throw e;throw error('无效 JSON');}}
function validateDocument(input){
  if(!Array.isArray(input.nodes)||!Array.isArray(input.edges)||input.nodes.length>1000||input.edges.length>3000)throw error('画布节点或连线无效');
  const ids=new Set();
  const nodes=input.nodes.map(n=>{
    if(typeof n.id!=='string'||n.id.length>100||ids.has(n.id)||!['text','asset','upload','output','generation'].includes(n.type))throw error('节点类型或 ID 无效');
    ids.add(n.id);
    if(!Number.isFinite(n.position?.x)||!Number.isFinite(n.position?.y))throw error('节点位置无效');
    const d=n.data || {},data={label:String(d.label || '').slice(0,160)};
    if(n.type==='text')data.text=String(d.text || '').slice(0,30000);
    if(n.type==='asset'||n.type==='output'&&d.assetId){if(!idPattern.test(d.assetId))throw error('素材 ID 无效');data.assetId=d.assetId;}
    if(n.type==='output'&&d.requestId){if(!/^[a-zA-Z0-9-]{16,100}$/.test(d.requestId))throw error('结果任务 ID 无效');data.requestId=d.requestId;}
    if(n.type==='upload'&&d.assetId){if(!idPattern.test(d.assetId))throw error('素材 ID 无效');data.assetId=d.assetId;}
    if(n.type==='generation'){
      if(!channels.has(d.channel))throw error('渠道无效');
      data.channel=d.channel;data.prompt=String(d.prompt || '').slice(0,30000);
      data.model=String(d.model || '').slice(0,160);
      data.options={};for(const key of ['ratio','resolution','duration','reference','aspect_ratio','size','quality','price_version'])if(['string','number'].includes(typeof d.options?.[key]))data.options[key]=d.options[key];
    }
    return {id:n.id,type:n.type,dragHandle:'.node-drag-handle',position:{x:n.position.x,y:n.position.y},data};
  });
  const edgeIds=new Set();
  const edges=input.edges.map(e=>{
    if(!ids.has(e.source)||!ids.has(e.target)||e.source===e.target)throw error('连线目标无效');
    const id=`reference:${e.source}:${e.target}`;if(edgeIds.has(id))throw error('重复连线');edgeIds.add(id);
    return {id,source:e.source,target:e.target};
  });
  const v=input.viewport;
  for(const n of nodes.filter(n=>n.type==='output')){
    const incoming=edges.filter(e=>e.target===n.id);
    if(incoming.length>1||incoming.some(e=>nodes.find(x=>x.id===e.source)?.type!=='generation'))throw error('Output 只能连接一个生成节点作为来源');
  }
  const visited=new Set(),visiting=new Set(),outgoing=new Map(nodes.map(n=>[n.id,[]]));
  for(const e of edges)outgoing.get(e.source).push(e.target);
  function visit(id){if(visiting.has(id))throw error('不能创建循环连线');if(visited.has(id))return;visiting.add(id);for(const target of outgoing.get(id))visit(target);visiting.delete(id);visited.add(id);}
  for(const n of nodes)visit(n.id);
  const viewport=v&&[v.x,v.y,v.zoom].every(Number.isFinite)?{x:v.x,y:v.y,zoom:Math.max(.1,Math.min(3,v.zoom))}:{x:0,y:0,zoom:1};
  return {title:String(input.title || '未命名画布').slice(0,120),nodes,edges,viewport};
}
function directorDocument(plan){
  const text=[{label:plan.title||'项目说明',text:plan.direction_summary||''},
    ...(plan.anchor_library||[]).map(a=>({label:`锚点 ${a.anchor_id}`,text:a.prompt||''})),
    ...(plan.production_segments||[]).map(s=>({label:`镜头 ${s.segment_id}`,text:s.model_neutral_prompt||''}))];
  return validateDocument({title:plan.title,nodes:text.map((data,i)=>({id:crypto.randomUUID(),type:'text',position:{x:(i%3)*370,y:Math.floor(i/3)*340},data})),edges:[]});
}
function createCanvas({dir,getAssets,taskStore,baseUrl,dhUpstream,getRhKey,walletMode=false,relayMode=false,getExecutionContext=()=>({owner:'',revision:0}),fetchImpl=fetch}){
  fs.mkdirSync(dir,{recursive:true});const executions=new Map(),imports=new Map(),quotes=new Map();
  const context=()=>({...getExecutionContext()});
  const assertContext=expected=>{const current=context();if(relayMode&&(current.owner!==expected.owner||current.revision!==expected.revision))throw error('账户配置已变更，请重新检测线路后执行',409);};
  const visibleRun=({owner,failureCode,...run})=>{
    if(relayMode&&owner&&owner!==context().owner)return {...run,inactiveAccount:true};
    return failureCode===balanceFailure.failureCode?{...run,failureCode}:run;
  };
  const file=id=>{if(!idPattern.test(id))throw error('画布不存在',404);return path.join(dir,id+'.json');};
  const load=id=>{try{const doc=JSON.parse(fs.readFileSync(file(id),'utf8'));doc.nodes=doc.nodes.map(n=>({...n,dragHandle:'.node-drag-handle',type:n.type==='asset'&&n.id.startsWith('output:')?'output':n.type}));
    // Freeze the preview visible in pre-1.8.6 manual Outputs once, on migration.
    if(doc.outputVersion!==2){for(const n of doc.nodes.filter(n=>n.type==='output'&&!n.id.startsWith('output:')&&!n.data.requestId)){const source=doc.edges.find(e=>e.target===n.id)?.source,run=[...doc.runs].reverse().find(r=>r.nodeId===source&&r.assetId);if(run)n.data={...n.data,requestId:run.requestId,assetId:run.assetId};}doc.outputVersion=2;}
    return doc;}catch(e){if(e.status)throw e;throw error('画布不存在',404);}};
  const save=doc=>{const target=file(doc.id);fs.writeFileSync(target+'.tmp',JSON.stringify(doc),{mode:0o600});fs.renameSync(target+'.tmp',target);return doc;};
  const list=()=>fs.readdirSync(dir).filter(n=>/^[a-f0-9]{32}\.json$/.test(n)).flatMap(n=>{try{const d=load(n.slice(0,-5));return [{id:d.id,title:d.title,updated:d.updated,directorPlanId:d.directorPlanId}];}catch{return [];}}).sort((a,b)=>b.updated.localeCompare(a.updated));
  function create(document,extra={}){return save({...validateDocument(document),...extra,outputVersion:2,id:crypto.randomBytes(16).toString('hex'),revision:1,updated:new Date().toISOString(),runs:[]});}
  async function local(route,body,requestId,expected){assertContext(expected);const r=await fetchImpl(baseUrl()+route,{method:'POST',headers:{'Content-Type':'application/json',Prefer:'respond-async','Idempotency-Key':requestId,...(relayMode?{'X-Hamster-Config-Revision':String(expected.revision)}:{})},body:JSON.stringify(body)});const data=await r.json();if(!r.ok)throw Object.assign(error(data.error||'任务提交失败',r.status),{code:data.code});return data;}
  async function quoteNode(id,nodeId,expectedRevision,checkBalance=false){
    const expected=context();if(!relayMode)throw error('当前模式不支持线路报价',404);if(expectedRevision!==expected.revision)throw error('账户配置已变更，请重新检测线路后报价',409);
    const doc=load(id),node=doc.nodes.find(n=>n.id===nodeId&&n.type==='generation');if(!node)throw error('生成节点不存在');
    if(node.data.channel==='image')throw error('图片节点直接执行',404);
    const {canvasQuoteSignature,nodeAssetId,combinedPrompt,missingReferenceError,referenceInputs,modelOptionsError}=await import('./public/canvas-core.mjs');assertContext(expected);
    const inputs=doc.edges.filter(e=>e.target===nodeId).map(e=>doc.nodes.find(n=>n.id===e.source));
    if(inputs.some(n=>n.type==='generation'||['upload','output'].includes(n.type)&&!nodeAssetId(doc,n)))throw error('请先完成已连接的输入素材或上游结果');
    const assets=inputs.filter(n=>['asset','upload','output'].includes(n.type)).map(n=>getAssets().get(nodeAssetId(doc,n)));
    const prompt=combinedPrompt(doc,nodeId),rh=['digital','depth'].includes(node.data.channel),model=rh?'tool-'+node.data.channel:node.data.model;
    const referenceError=missingReferenceError(prompt,referenceInputs(doc,nodeId,assets));if(referenceError)throw error(referenceError);
    if(!rh&&!prompt.trim())throw error('请填写或连接提示词');
    if(node.data.channel==='digital'&&(assets.filter(a=>a.kind==='image').length!==1||assets.filter(a=>a.kind==='audio').length!==1||assets.length!==2))throw error('数字人需要一张人物图片和一段音频');
    if(node.data.channel==='digital'&&(!assets.find(a=>a.kind==='audio').durationSeconds||assets.find(a=>a.kind==='audio').durationSeconds>30))throw error('数字人音频必须有有效时长且不超过30秒');
    if(node.data.channel==='depth'&&(assets.length!==1||assets[0].kind!=='video'))throw error('黑白深度需要一个视频');
    const catalogResponse=await fetchImpl(baseUrl()+'/api/canvas/models'),catalog=await catalogResponse.json();assertContext(expected);
    const selected=catalog.data?.find(m=>m.id===model&&m.type===(node.data.channel==='image'?'image':'video'));
    if(!catalogResponse.ok||catalog.revision!==undefined&&catalog.revision!==expected.revision)throw error('线路目录已变更，请重新检测后报价',409);
    const optionError=modelOptionsError(selected,node.data.options,node.data.channel);if(optionError)throw error(optionError);
    const {mediaLimitError}=await import('./public/core.mjs');const mediaError=mediaLimitError(selected,assets);if(mediaError)throw error(mediaError);
    const signature=canvasQuoteSignature(doc,nodeId,getAssets().entries()),payload={...node.data.options,model,concurrency:1,media_counts:{images:assets.filter(a=>a.kind==='image').length,videos:assets.filter(a=>a.kind==='video').length,audios:assets.filter(a=>a.kind==='audio').length}};
    const response=await local('/api/quotes',{...payload,...(checkBalance?{check_balance:true}:{})},crypto.randomUUID(),expected);assertContext(expected);
    if(checkBalance&&response.balance_checked!==true)throw error('暂时无法核对可用余额，请稍后再试',503);
    const {quoteValid}=await import('./public/canvas-pricing.mjs');if(!quoteValid(response.quote,{quantity:1,model})||response.revision!==expected.revision)throw error('暂时无法确认本次费用，请重新获取报价',409);
    if(canvasQuoteSignature(load(id),nodeId,getAssets().entries())!==signature)throw error('节点内容已变更，请重新获取报价',409);
    for(const [key,binding] of quotes)if(binding.quote.expires_at*1000<=Date.now())quotes.delete(key);
    if(quotes.size>=1000)quotes.delete(quotes.keys().next().value);
    quotes.set(response.quote.id,{id,nodeId,expected,signature,quote:response.quote});return response;
  }
  async function confirmedQuote(id,nodeId,quoteId,expected,requestId){
    const binding=quotes.get(quoteId);if(!binding||binding.id!==id||binding.nodeId!==nodeId)throw error('请重新获取并确认本节点报价',428);
    assertContext(binding.expected);assertContext(expected);
    const {canvasQuoteSignature}=await import('./public/canvas-core.mjs'),{quoteValid}=await import('./public/canvas-pricing.mjs');
    if(!quoteValid(binding.quote,{quantity:1})||canvasQuoteSignature(load(id),nodeId,getAssets().entries())!==binding.signature)throw error('报价已过期或节点内容已变更，请重新获取并确认',409);
    assertContext(binding.expected);assertContext(expected);
    if(binding.requestId&&binding.requestId!==requestId)throw error('本次报价已用于原任务，请查询任务或重新获取报价',409);
    if(requestId)binding.requestId=requestId;
    return binding.quote;
  }
  async function execute(id,nodeId,requestId,expectedRevision,quoteId){
    if(!/^[a-zA-Z0-9-]{16,100}$/.test(requestId))throw error('执行请求 ID 无效');
    const expected=context();if(relayMode&&expectedRevision!==undefined&&expectedRevision!==expected.revision)throw error('账户配置已变更，请重新检测线路后执行',409);
    const lock=id+':'+nodeId;
    if(executions.has(lock))throw error('此节点正在提交，请稍候',409);
    const doc=load(id),node=doc.nodes.find(n=>n.id===nodeId&&n.type==='generation');if(!node)throw error('生成节点不存在');
    const prior=doc.runs.find(r=>r.requestId===requestId);if(prior)return prior;
    const busy=doc.runs.find(r=>r.nodeId===nodeId&&(!r.owner||r.owner===expected.owner)&&!['succeeded','failed'].includes(r.status)&&!taskStore().list().some(t=>(t.requestId===r.requestId||t.requestId===r.requestId+':0')&&['succeeded','failed'].includes(t.status)));
    if(busy)throw error('此节点仍有未完成或待确认任务，请先查看任务状态',409);
    executions.set(lock,true);
    const {channel,model,options}=node.data,image=channel==='image';
    const prompt=[...doc.edges.filter(e=>e.target===nodeId).map(e=>doc.nodes.find(n=>n.id===e.source)).filter(n=>n?.type==='text').map(n=>n.data.text),node.data.prompt].filter(Boolean).join('\n\n');
    const run={requestId,nodeId,prompt,status:'preparing',created:new Date().toISOString(),...(relayMode&&expected.owner?{owner:expected.owner}:{})};doc.runs.push(run);save(doc);
    const update=patch=>{const latest=load(id);latest.runs=latest.runs.map(r=>r.requestId===requestId?{...r,...patch}:r);Object.assign(run,latest.runs.find(r=>r.requestId===requestId));save(latest);};
    try{
      const acceptedQuote=!image&&quoteId?await confirmedQuote(id,nodeId,quoteId,expected,requestId):null;
      if(acceptedQuote){const {id:ignored,...snapshot}=acceptedQuote;update({modelName:acceptedQuote.name,priceSnapshot:snapshot});}
      const inputs=doc.edges.filter(e=>e.target===nodeId).map(e=>doc.nodes.find(n=>n.id===e.source));
      if(inputs.some(n=>n.type==='generation'))throw error('请连接已完成的输出素材节点');
      if(inputs.some(n=>n.type==='upload'&&!n.data.assetId))throw error('请先完成已连接的素材卡片上传');
      const {referenceInputs,missingReferenceError,nodeAssetId,modelOptionsError,executionKind,canvasQuoteSignature}=await import('./public/canvas-core.mjs');assertContext(expected);
      const imageSignature=relayMode&&image?canvasQuoteSignature(doc,nodeId,getAssets().entries()):null;
      if(inputs.some(n=>n.type==='output'&&!nodeAssetId(doc,n)))throw error('请先执行 Output 连接的上游节点，等待输出结果');
      const assets=inputs.filter(n=>['asset','upload','output'].includes(n.type)).map(n=>getAssets().get(nodeAssetId(doc,n)));
      const referenceError=missingReferenceError(prompt,referenceInputs(doc,nodeId,assets));
      if(referenceError)throw error(referenceError);
      const rh=['digital','depth'].includes(channel);
      if(rh){
        if(!walletMode&&!getRhKey())throw error('请在账户页配置工具 API Key');
        if(channel==='digital'&&(assets.length!==2||assets.filter(a=>a.kind==='image').length!==1||assets.filter(a=>a.kind==='audio').length!==1))throw error('数字人需要一张人物图片和一段音频');
        if(channel==='depth'&&(assets.length!==1||assets[0].kind!=='video'))throw error('黑白深度需要一个视频');
        if(channel==='digital'&&(!assets.find(a=>a.kind==='audio').durationSeconds||assets.find(a=>a.kind==='audio').durationSeconds>30))throw error('数字人音频必须有有效时长且不超过30秒');
      }else if(!prompt.trim())throw error('请填写或连接提示词');
      if(!rh||relayMode){
        const r=await fetchImpl(baseUrl()+('/api/canvas/models'));const catalog=await r.json();assertContext(expected);
        if(!r.ok||relayMode&&catalog.revision!==undefined&&catalog.revision!==expected.revision)throw error('线路目录已变更，请重新检测后执行',409);
        const selected=catalog.data?.find(m=>m.id===(rh?'tool-'+channel:model)&&m.type===(image?'image':'video'));
        if(relayMode&&image&&selected?.image_billing!=='usage-v1')throw error('中转站图片线路暂未开放',409);
        if(!selected)throw error('请选择当前渠道可用模型');
        if(relayMode){const invalidOptions=modelOptionsError(selected,options,channel);if(invalidOptions)throw error(invalidOptions);}
        const {mediaLimitError}=await import('./public/core.mjs');const invalid=mediaLimitError(selected,assets);if(invalid)throw error(invalid);
        if(image)update({modelName:selected.name});
      }
      if(imageSignature&&canvasQuoteSignature(load(id),nodeId,getAssets().entries())!==imageSignature)throw error('节点内容已变更，请重新执行',409);
      assertContext(expected);
      const remote=await Promise.all(assets.map(async a=>{assertContext(expected);const uploaded=await getAssets().upload(a.id,relayMode?{kind:executionKind(channel),revision:expected.revision}:{});assertContext(expected);return uploaded;}));
      let body,route;
      if(rh&&walletMode){
        body={model:'tool-'+channel,price_version:options?.price_version,prompt:prompt||(channel==='digital'?'数字人视频':'黑白深度视频'),concurrency:1,images:[],videos:[],audios:[]};
        for(const a of remote)body[a.kind==='image'?'images':a.kind==='audio'?'audios':'videos'].push({url:a.url,durationSeconds:a.durationSeconds});
        route='/api/tools/'+channel;
      }else if(rh){
        const fields=[];
        for(const a of remote){
          // RH fixed workflows require RH's file handle; obtain bytes through the 素材通道 delivery URL.
          const media=await fetchImpl(a.url);if(!media.ok)throw error('对象存储素材暂时无法读取');
          const form=new FormData();form.append('file',await media.blob(),a.id+'.'+a.ext);
          const response=await fetchImpl(dhUpstream+'/media/upload/binary',{method:'POST',headers:{Authorization:`Bearer ${getRhKey()}`},body:form,signal:AbortSignal.timeout(120000)});
          const result=await response.json();const handle=result.data?.fileName||result.data?.download_url;
          if(!response.ok||!handle||(result.code!==undefined&&Number(result.code)!==0))throw error('工具素材处理失败');
          fields.push({nodeId:a.kind==='image'?'133':a.kind==='audio'?'125':'183',fieldName:a.kind,fieldValue:handle});
        }
        body={nodeInfoList:fields,instanceType:'default',usePersonalQueue:false};route='/rh/run/ai-app/'+(channel==='digital'?'2087890031699648513':'2089021172049596418');
      }else{
        body={...options,model,prompt,concurrency:1,images:[],videos:[],audios:[]};
        for(const a of remote){const key=a.kind==='image'?'images':a.kind==='video'?'videos':'audios';body[key].push({url:a.url,tag:`@${a.kind==='image'?'图片':a.kind==='video'?'视频':'音频'}${body[key].length+1}`,durationSeconds:a.durationSeconds});}
        route=image?'/api/images':channel==='main'||relayMode?'/api/videos':'/api/official-videos';
      }
      if(imageSignature){
        if(canvasQuoteSignature(load(id),nodeId,getAssets().entries())!==imageSignature)throw error('节点内容已变更，请重新执行',409);
        delete body.price_version;
      }
      if(acceptedQuote){await confirmedQuote(id,nodeId,quoteId,expected,requestId);body.quote_id=acceptedQuote.id;body.price_version=acceptedQuote.price_version;}
      assertContext(expected);update({status:'submitted'});
      const result=await local(route,body,requestId,expected);
      const rejected=relayMode&&(result.stopped?.code===balanceFailure.failureCode||result.task?.relayFailureCode===balanceFailure.failureCode);
      update({taskKey:result.task?.key,...(rejected?balanceFailure:{})});return run;
    }catch(e){
      if(relayMode&&e.status===402&&e.code===balanceFailure.failureCode){update(balanceFailure);throw e;}
      const message=relayMode&&!e.status&&!e.statusCode?'素材准备或服务连接未确认，请检查本地素材与账户配置后再核对任务记录':e.message;
      update({status:run.status==='submitted'&&(!(e.status>=400&&e.status<500)||e.code==='quote_already_submitted')?'unknown':'failed',error:message});
      throw relayMode?error(message,e.status||e.statusCode||500):e;
    }
    finally{executions.delete(lock);}
  }
  async function sync(id){
    let doc=load(id);const expected=context(),tasks=taskStore().list(),initialRuns=new Map(doc.runs.map(r=>[r.requestId,JSON.stringify(r)]));
    for(const run of doc.runs){
      const task=tasks.find(t=>t.requestId===run.requestId||t.requestId===run.requestId+':0');
      if(relayMode&&run.owner&&run.owner!==expected.owner)continue;
      if(relayMode&&!run.owner&&task?.walletUser)run.owner=task.walletUser;
      if(!task){if(run.status==='preparing'&&!executions.has(id+':'+run.nodeId)){run.status='failed';run.error='上次素材准备已中断，可以重新执行';}continue;}
      run.status=task.status;run.error=task.error||task.poll_error||'';run.taskKey=task.key;run.progress=task.progress;
      if(relayMode&&task.status==='failed'&&task.relayFailureCode===balanceFailure.failureCode)Object.assign(run,balanceFailure);
      if(task.status==='succeeded'&&!run.assetId&&task.result?.local_path){
        const assets=getAssets();const previous=assets.entries(true).find(a=>a.taskKey===task.key);
        try{const item=previous||assets.importTask(task);run.assetId=item.id;delete run.storageError;}
        catch(e){run.storageError=relayMode?'结果已保存在本机，素材入库待重试；请检查结果文件格式和大小':'结果已保存，素材入库待重试：'+e.message;}
      }
      if(task.status==='succeeded'&&run.assetId&&relayMode){
        // A read ticket has a limited lifetime and belongs to a target function.
        // Keep the result local; each explicit downstream execution reauthorizes it.
        run.localAvailable=true;delete run.storageSynced;delete run.storageError;
      }else if(task.status==='succeeded'&&run.assetId&&!run.storageSynced){
        try{await getAssets().upload(run.assetId);run.storageSynced=true;delete run.storageError;}
        catch(e){run.storageError='结果已保存在本机，素材通道 同步待重试：'+e.message;}
      }
    }
    // No await after reload: preserve user edits committed while result uploading.
    const current=load(id);current.runs=current.runs.map(r=>JSON.stringify(r)===initialRuns.get(r.requestId)?doc.runs.find(old=>old.requestId===r.requestId)||r:r);
    let outputsChanged=false;
    for(const run of current.runs){
      if(!run.assetId||run.outputCreated)continue;
      if(current.nodes.some(n=>n.id==='output:'+run.requestId||n.type==='output'&&n.data.requestId===run.requestId)){run.outputCreated=true;continue;}
      const source=current.nodes.find(n=>n.id===run.nodeId);if(!source)continue;
      const targets=current.edges.filter(e=>e.source===source.id).map(e=>current.nodes.find(n=>n.id===e.target)).filter(n=>n?.type==='output');
      const placed=targets.filter(n=>!n.id.startsWith('output:')&&!n.data.requestId&&!n.data.assetId);
      if(placed.length){for(const n of placed)n.data={...n.data,requestId:run.requestId,assetId:run.assetId};}
      else{
        const anchor=targets.at(-1),position={x:anchor?.position.x??source.position.x+390,y:anchor?anchor.position.y+460:source.position.y};
        while(current.nodes.some(n=>Math.abs(n.position.x-position.x)<350&&Math.abs(n.position.y-position.y)<440))position.y+=460;
        const output={id:'output:'+run.requestId,type:'output',dragHandle:'.node-drag-handle',position,data:{label:'Output · 生成结果',assetId:run.assetId,requestId:run.requestId}};
        current.nodes.push(output);current.edges.push({id:`reference:${source.id}:${output.id}`,source:source.id,target:output.id});
      }
      run.outputCreated=true;outputsChanged=true;
    }
    if(outputsChanged)current.revision++;save(current);return current;
  }
  async function handle(req,res,url){
    const reply=(status,data)=>{if(data?.runs)data={...data,runs:data.runs.map(visibleRun)};else if(data?.requestId&&data.nodeId)data=visibleRun(data);if(data?.current?.runs)data={...data,current:{...data.current,runs:data.current.runs.map(visibleRun)}};res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(data));};
    if(req.headers.origin&&req.headers.origin!==`http://${req.headers.host}`)throw error('请在本地画布操作',403);
    const route=url.pathname.slice('/api/canvas'.length);
    if(route==='/projects'&&req.method==='GET')return reply(200,{projects:list()});
    if(route==='/projects'&&req.method==='POST')return reply(201,create(await json(req)));
    if(route==='/director-import'&&req.method==='POST'){
      if(relayMode)throw error('智能工作台已移除，历史画布内容仍保留',410);
      const data=await json(req);if(typeof data.planId!=='string'||!data.planId||!data.plan)throw error('导演方案无效');
      const existing=list().find(d=>d.directorPlanId===data.planId);
      return reply(existing?200:201,existing?load(existing.id):create(directorDocument(data.plan),{directorPlanId:data.planId}));
    }
    if(route==='/assets/import'&&req.method==='POST'){
      const name=url.searchParams.get('name')||'素材',durationSeconds=Number(url.searchParams.get('duration'));
      const item=getAssets().add('scene',name,await read(req,50*1024*1024),path.extname(name).slice(1).toLowerCase(),{durationSeconds:Number.isFinite(durationSeconds)&&durationSeconds>0?durationSeconds:undefined});
      // Save locally first so an 素材通道 interruption can retry without importing duplicates.
      return reply(201,item);
    }
    const upload=route.match(/^\/assets\/([a-f0-9]{32})\/upload$/);
    if(upload&&req.method==='POST'){const input=await json(req),expected=context();if(relayMode&&input.revision!==expected.revision)throw error('账户配置已变更，请重新检测后同步',409);const kind=input.kind;if(relayMode&&!['image','video','tool'].includes(kind))throw error('请选择素材同步用途');await getAssets().upload(upload[1],relayMode?{kind,revision:expected.revision}:{});assertContext(expected);return reply(200,{uploaded:true,...(relayMode?{kind,revision:expected.revision}:{}),checkedAt:new Date().toISOString()});}
    const duration=route.match(/^\/assets\/([a-f0-9]{32})\/duration$/);
    if(duration&&req.method==='POST')return reply(200,getAssets().setDuration(duration[1],Number((await json(req)).seconds)));
    const m=route.match(/^\/projects\/([a-f0-9]{32})(?:\/(sync|execute|quote))?$/);if(!m)throw error('画布接口不存在',404);
    if(m[2]==='quote'&&req.method==='POST'){const input=await json(req);return reply(200,await quoteNode(m[1],input.nodeId,input.revision,input.check_balance===true));}
    if(!m[2]&&req.method==='GET')return reply(200,load(m[1]));
    if(!m[2]&&req.method==='DELETE'){
      const input=await json(req),doc=load(m[1]);
      if(input.revision!==doc.revision)throw error('画布已更新，请关闭删除提示后重试',409);
      if(imports.has(doc.id)||[...executions.keys()].some(key=>key.startsWith(doc.id+':')))throw error('画布正在同步或提交任务，请稍后再删除',409);
      const tasks=taskStore().list();
      if(doc.runs.some(run=>{const task=tasks.find(t=>t.requestId===run.requestId||t.requestId===run.requestId+':0');return !['succeeded','failed'].includes(task?.status||run.status);}))throw error('此画布有未完成或结果待确认的任务，请等待任务结束后删除',409);
      // Archive only the validated document. Shared assets, results and tasks stay intact.
      const archive=path.join(dir,'deleted');fs.mkdirSync(archive,{recursive:true});
      fs.renameSync(file(doc.id),path.join(archive,doc.id+'-'+crypto.randomBytes(6).toString('hex')+'.json'));
      return reply(200,{deleted:true,id:doc.id,recoverable:true});
    }
    if(!m[2]&&req.method==='PUT'){
      const input=await json(req),doc=load(m[1]);if(input.revision!==doc.revision)return reply(409,{error:'画布已在另一窗口更新，请重新打开后编辑',current:doc});
      const validated=validateDocument(input);
      // A saved result is immutable even if an older browser sends an unbound card.
      for(const n of validated.nodes.filter(n=>n.type==='output')){const old=doc.nodes.find(x=>x.id===n.id);if(old?.data.requestId)n.data={...n.data,requestId:old.data.requestId,assetId:old.data.assetId};}
      const {referenceChangeError}=await import('./public/canvas-core.mjs');
      const changedReference=referenceChangeError(doc,{...validated,runs:doc.runs},getAssets().entries());
      if(changedReference)throw error(changedReference);
      // Recheck after the async module import before committing the revision.
      const latest=load(m[1]);if(input.revision!==latest.revision)return reply(409,{error:'画布已更新，请重新打开',current:latest});
      return reply(200,save({...latest,...validated,revision:latest.revision+1,updated:new Date().toISOString()}));
    }
    if(m[2]==='execute'&&req.method==='POST'){
      const input=await json(req);if(relayMode&&input.revision!==context().revision)throw error('账户配置已变更，请重新检测线路后执行',409);
      const doc=load(m[1]),node=doc.nodes.find(n=>n.id===input.nodeId&&n.type==='generation');
      if(!node)throw error('生成节点不存在');
      const requireQuote=relayMode&&node.data.channel!=='image';
      if(requireQuote&&(input.confirmed!==true||typeof input.quote_id!=='string'))throw error('请先获取并确认本节点费用',428);
      if(requireQuote&&!doc.runs.some(run=>run.requestId===input.requestId))await confirmedQuote(m[1],input.nodeId,input.quote_id,context(),input.requestId);
      const pending=execute(m[1],input.nodeId,input.requestId,input.revision,requireQuote?input.quote_id:undefined);
      const run=load(m[1]).runs.find(r=>r.requestId===input.requestId);
      if(!run)return reply(202,await pending);
      // The durable run exists before accepting; a lost browser connection never
      // restarts a paid request. Sync recovers the original task after completion.
      pending.catch(()=>{});return reply(202,run);
    }
    if(m[2]==='sync'&&req.method==='POST'){
      if(!imports.has(m[1]))imports.set(m[1],sync(m[1]).finally(()=>imports.delete(m[1])));
      return reply(200,await imports.get(m[1]));
    }
    throw error('操作不支持',405);
  }
  return {handle,load,create,list,execute,quoteNode};
}
module.exports={createCanvas,validateDocument,directorDocument};
