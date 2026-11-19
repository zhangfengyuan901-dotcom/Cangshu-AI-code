import { pickAsset } from '/shared/asset-library.mjs';
import { installFaultEvents } from '/shared/fault-events.mjs';
installFaultEvents('/studio-api/error-report');
const $ = s => document.querySelector(s);
let job = null, source = null, script = null, bindings = Object.create(null), busy = false, ready = false, timer, uploading = false, pollGeneration = 0;
const node = (tag, text, cls) => { const n=document.createElement(tag); if(text)n.textContent=text; if(cls)n.className=cls; return n; };
function toast(text) { $('#toast').textContent=text; $('#toast').hidden=false; clearTimeout(timer); timer=setTimeout(()=>$('#toast').hidden=true,6000); }
async function request(path, options={}) {
  let response;
  try{response=await fetch('/creative-api'+path,options);}catch{throw new Error('工作台连接暂时中断，正在等待本地服务恢复。');}
  const body=await response.text();let data;
  try{data=body?JSON.parse(body):{};}catch{throw new Error('本地服务返回格式异常，请重新打开工作台。');}
  if(!response.ok)throw new Error(typeof data.detail==='string'?data.detail:'请求未完成，请检查所选素材和改写要求。');
  return data;
}
const post = (path, value) => request(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(value)});
function controls() {
  document.body.classList.toggle('busy',busy);
  $('#analyze').disabled=busy||uploading||!source||!ready;
  $('#pickSource').disabled=busy||uploading;
  $('#cancel').hidden=!busy;
  $('#cancel').disabled=!job||job.status!=='running';
  $('#adapt').disabled=busy||uploading||!ready;
  for(const b of $('#bindings').querySelectorAll('button')) b.disabled=busy||uploading;
}
async function config() {const value=await request('/config');ready=value.ready;$('#connection').hidden=ready;$('#connection').textContent=ready?'':'请在主应用「账户」页完成连接，再点击仓鼠标志检测智能服务。';$('#outputPath').textContent='保存位置：'+value.output;controls();}
async function upload(file) {return request('/media?name='+encodeURIComponent(file.name),{method:'POST',headers:{'Content-Type':file.type},body:file});}
async function selectSource(file) {
  if(!file||busy||uploading)return;
  if(!['video/mp4','video/quicktime'].includes(file.type)||file.size>50*1024*1024)throw new Error('请选择50MB以内的 MP4 / MOV 视频。');
  uploading=true;controls();
  $('#failureDetails').hidden=true;
  try {source=await upload(file);pollGeneration++;job=null;script=null;bindings=Object.create(null);$('#sourcePreview').src='/creative-api/media/'+source.id;$('#sourcePreview').hidden=false;$('#sourceName').textContent=source.name;$('#scriptArea').hidden=true;$('#empty').hidden=false;$('#resultPanel').hidden=true;$('#progress').hidden=true;localStorage.removeItem('hamster-creative-job');}
  finally {uploading=false;controls();}
}
function renderBindings() {
  const host=$('#bindings');host.replaceChildren();
  const targets=[...script.characters.map(c=>({id:c.id,title:c.name,description:c.appearance,category:'talent'})),...script.scenes.map(s=>({id:s.id,title:'场景',description:s.description,category:'scene'})),{id:'product',title:'我的产品 / 服装',description:'指定商品外观，避免沿用原片商品。',category:'product'}];
  const valid=new Set(targets.map(x=>x.id));for(const key of Object.keys(bindings))if(!valid.has(key))delete bindings[key];
  for(const target of targets){
    const card=node('div',null,'binding');card.append(node('strong',target.id+' · '+target.title),node('p',target.description));
    const chosen=bindings[target.id];
    if(chosen){const image=node('img');image.src='/creative-api/media/'+chosen.id;image.alt=chosen.name;card.append(image,node('p',chosen.name,'name'));}
    const actions=node('div',null,'actions'),library=node('button','资产库'),temporary=node('button','临时上传'),input=node('input');input.type='file';input.accept='image/png,image/jpeg,image/webp';input.hidden=true;
    async function choose(value){if(!value)return;if(!bindings[target.id]&&Object.keys(bindings).length>=9)throw new Error('最多绑定9张图片。');bindings[target.id]=value;$('#resultPanel').hidden=true;renderBindings();controls();}
    library.onclick=()=>safe(async()=>{const asset=await pickAsset({base:'/studio-api/assets',category:target.category});if(!asset)return;if(asset.kind!=='image')throw new Error('角色、产品与场景替换请选择图片。');uploading=true;controls();try{await choose(await post('/asset/'+asset.id));}finally{uploading=false;controls();}});
    temporary.onclick=()=>input.click();input.onchange=()=>safe(async()=>{const file=input.files[0];if(!file)return;if(!file.type.startsWith('image/')||file.size>10*1024*1024)throw new Error('请选择10MB以内的图片。');uploading=true;controls();try{await choose(await upload(file));}finally{uploading=false;controls();input.value='';}});
    actions.append(library,temporary,input);if(chosen){const clear=node('button','移除');clear.onclick=()=>{delete bindings[target.id];$('#resultPanel').hidden=true;renderBindings();controls();};actions.append(clear);}card.append(actions);host.append(card);
  }
}
function renderScript() {
  $('#scriptArea').hidden=false;$('#empty').hidden=true;$('#summary').textContent=script.summary;$('#warnings').hidden=!script.uncertainties.length;$('#warnings').textContent=script.uncertainties.length?'待核对：'+script.uncertainties.join('；'):'';
  $('#relationships').replaceChildren(...script.relationships.map(r=>node('p',`${r.characters.join(' ↔ ')} · ${r.description}（${r.certainty}）\n依据：${r.evidence}`,'relationship')));
  if(!script.relationships.length)$('#relationships').append(node('p','未确认明确的人物关系。','muted'));
  $('#shots').replaceChildren();for(const shot of script.shots){const card=node('article',null,'shot'),seek=node('button','定位原片');seek.onclick=()=>{$('#sourcePreview').currentTime=Math.max(0,Math.min(shot.start,Number.isFinite($('#sourcePreview').duration)?$('#sourcePreview').duration:shot.start));$('#sourcePreview').scrollIntoView({block:'center',behavior:'smooth'});};card.append(seek,node('time',`${shot.start}–${shot.end}秒 · ${shot.scene} · ${shot.characters.join(' / ')||'无人物'}`));for(const [label,key] of [['动作路径','action'],['商品 / 道具','product'],['神态 / 情绪','emotion'],['景别 / 运镜','camera'],['构图 / 焦点','composition'],['光线 / 色调','lighting'],['入镜 / 转场','transition'],['时长 / 节奏','pacing'],['屏幕文字','screen_text'],['剧情作用','plot'],['前后连续性','continuity'],['证据置信度','confidence']])if(shot[key])card.append(node('p',label+'：'+shot[key]));card.append(node('p',`对白［${shot.dialogue_source}］：${shot.dialogue||'无'}`));$('#shots').append(card);}
  renderBindings();controls();
}
function renderResult() {
  const result=job?.result;$('#resultPanel').hidden=!result;if(!result)return;
  $('#prompt').value=result.prompt;$('#download').href='/creative-api/jobs/'+job.id+'/result';$('#manifest').replaceChildren();$('#segmentPrompts').replaceChildren();
  for(const item of result.manifest){const link=node('a',item.tag+' · '+item.name+' ↓');link.href='/creative-api/media/'+item.media+'?download=true';$('#manifest').append(link);}
  for(const segment of result.segments||[]){const card=node('article',null,'segment-prompt'),title=node('strong',`第${segment.index}段 · ${segment.start}–${segment.end}秒 · 生成${segment.duration}秒`),area=node('textarea'),copy=node('button','复制本段');area.readOnly=true;area.value=segment.prompt;copy.onclick=()=>safe(async()=>{await navigator.clipboard.writeText(segment.prompt);toast(`第${segment.index}段提示词已复制`);});card.append(title,area,copy);$('#segmentPrompts').append(card);}
}
async function show(item) {
  job=item;localStorage.setItem('hamster-creative-job',item.id);source={id:item.source,name:item.name};$('#sourcePreview').src='/creative-api/media/'+source.id;$('#sourcePreview').hidden=false;$('#sourceName').textContent=source.name;
  if(item.script){script=item.script;bindings=Object.create(null);for(const b of item.brief?.bindings||[]){const found=(item.references||item.result?.manifest||[]).find(m=>m.media===b.media);if(found)bindings[b.target]={id:b.media,name:found.name};}renderScript();}
  else{$('#scriptArea').hidden=true;$('#empty').hidden=false;}
  $('#notes').value=item.brief?.notes||'';
  renderResult();busy=item.status==='running';controls();status(item);if(busy)poll(item.id);
}
function status(item){
  const stage={'上传 R2 原片与证据':'正在发送完整原片与时间证据…','读取原片与镜头证据':'正在读取连续原片…','整理分析结果':'正在整理多维分镜…','请求智能分析':'正在深度分析完整原片…','校验脚本结构与时间轴':'正在整理多维分镜…','Prompt 已保存到本地':'提示词已生成'}[item.stage]||item.stage;
  $('#progress').hidden=false;$('#progress').textContent=(item.error||stage||item.status)+(item.cleanup_warning?' · '+item.cleanup_warning:'');
  $('#failureDetails').hidden=!item.failure;
  const f=item.failure;
  $('#failureText').textContent=f?`失败步骤：${f.step}\n原因：${f.message}\n错误码：${f.code}\nHTTP：${f.http_status||'无响应'}\n请求编号：${f.request_id||'未返回'}\n本地任务：${item.id}`:'';
}
async function poll(id) {
  const generation=++pollGeneration;let disconnects=0;
  while(generation===pollGeneration&&job?.id===id&&busy){await new Promise(r=>setTimeout(r,Math.min(1500*(disconnects+1),10000)));try{const item=await request('/jobs/'+id);if(generation!==pollGeneration||job?.id!==id)return;if(disconnects)toast('连接已恢复，任务状态已同步。');disconnects=0;job=item;status(item);if(item.status!=='running'){busy=false;if(item.script){script=item.script;renderScript();}renderResult();controls();await history();}}catch(e){if(generation!==pollGeneration)return;disconnects++;if(disconnects===1)toast('状态连接短暂中断，正在自动恢复；不会重复提交任务。');}}
}
async function history(){const items=await request('/jobs');$('#history').replaceChildren();for(const item of items){const b=node('button',item.name+' · '+({running:'运行中',success:'已完成',failed:'未完成',cancelled:'已停止',interrupted:'已中断'}[item.status]||item.status));b.onclick=()=>safe(async()=>{if(busy||uploading)throw new Error('请先等待当前操作完成。');await show(await request('/jobs/'+item.id));});$('#history').append(b);}if(!items.length)$('#history').append(node('p','完成第一次拆解后，会在这里保留记录。','muted'));}
async function safe(action){try{await action();}catch(e){toast(e.message);}}
$('#pickSource').onclick=()=>$('#sourceInput').click();$('#sourceInput').onchange=()=>safe(()=>selectSource($('#sourceInput').files[0]));
$('#dropZone').ondragover=e=>{e.preventDefault();$('#dropZone').classList.add('drag');};$('#dropZone').ondragleave=()=>$('#dropZone').classList.remove('drag');$('#dropZone').ondrop=e=>{e.preventDefault();$('#dropZone').classList.remove('drag');safe(()=>selectSource(e.dataTransfer.files[0]));};
$('#analyze').onclick=()=>safe(async()=>{busy=true;controls();try{const item=await post('/analyze/'+source.id,{mode:'precise'});await show(item);await history();}catch(e){busy=false;controls();throw e;}});
$('#adapt').onclick=()=>safe(async()=>{
  if(!job||!script)throw new Error('请先拆解视频。');
  busy=true;controls();$('#resultPanel').hidden=true;
  try{job=await post('/jobs/'+job.id+'/adapt',{script,bindings:Object.entries(bindings).map(([target,media])=>({target,media:media.id})),notes:$('#notes').value});status(job);poll(job.id);}
  catch(e){busy=false;controls();throw e;}
});
$('#cancel').onclick=()=>safe(async()=>{if(job){const item=await post('/jobs/'+job.id+'/cancel');pollGeneration++;busy=false;job=item;status(item);controls();await history();}});
$('#copyPrompt').onclick=()=>safe(async()=>{await navigator.clipboard.writeText($('#prompt').value);toast('提示词正文已复制；如有多段，请分别提交生成。');});
$('#refresh').onclick=()=>safe(config);$('#refreshHistory').onclick=()=>safe(history);
$('#copyFailure').onclick=()=>safe(async()=>{await navigator.clipboard.writeText($('#failureText').textContent);toast('诊断信息已复制，可发送给客服。');});
safe(async()=>{await config();await history();const id=localStorage.getItem('hamster-creative-job');if(id)await show(await request('/jobs/'+id));});
