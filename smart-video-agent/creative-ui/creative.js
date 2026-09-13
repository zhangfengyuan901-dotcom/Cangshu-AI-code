import { pickAsset } from '/shared/asset-library.mjs';
const $ = s => document.querySelector(s);
let job = null, source = null, script = null, bindings = {}, busy = false, ready = false, timer, uploading = false, pollGeneration = 0;
const node = (tag, text, cls) => { const n=document.createElement(tag); if(text)n.textContent=text; if(cls)n.className=cls; return n; };
function toast(text) { $('#toast').textContent=text; $('#toast').hidden=false; clearTimeout(timer); timer=setTimeout(()=>$('#toast').hidden=true,6000); }
async function request(path, options={}) {
  const response=await fetch('/creative-api'+path,options);
  const data=await response.json();
  if(!response.ok)throw new Error(typeof data.detail==='string'?data.detail:'数据校验未通过，请检查脚本结构、素材及时间轴。');
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
  $('#applyScript').disabled=busy;
  for(const b of $('#bindings').querySelectorAll('button')) b.disabled=busy||uploading;
}
async function config() {const value=await request('/config');ready=value.ready;$('#connection').textContent=ready?'智能服务已配置 · 本地保存 · 拆解与改编分步运行':'请在主应用「账户」保存仓鼠智能 API Key，再检查连接。需开通支持音画理解的智能模型。';$('#outputPath').textContent='输出目录：'+value.output;controls();}
async function upload(file) {return request('/media?name='+encodeURIComponent(file.name),{method:'POST',headers:{'Content-Type':file.type},body:file});}
async function selectSource(file) {
  if(!file||busy||uploading)return;
  if(!['video/mp4','video/quicktime'].includes(file.type)||file.size>50*1024*1024)throw new Error('请选择50MB以内的 MP4 / MOV 视频。');
  uploading=true;controls();
  try {source=await upload(file);pollGeneration++;job=null;script=null;bindings={};$('#sourcePreview').src='/creative-api/media/'+source.id;$('#sourcePreview').hidden=false;$('#sourceName').textContent=source.name;$('#scriptArea').hidden=true;$('#empty').hidden=false;$('#resultPanel').hidden=true;$('#progress').hidden=true;localStorage.removeItem('hamster-creative-job');}
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
  $('#scriptArea').hidden=false;$('#empty').hidden=true;$('#summary').textContent=script.summary;$('#warnings').textContent=script.uncertainties.length?'待核对：'+script.uncertainties.join('；'):'模型未标记不确定项，仍请核对对白与时间轴。';
  $('#relationships').replaceChildren(...script.relationships.map(r=>node('p',`${r.characters.join(' ↔ ')} · ${r.description}（${r.certainty}）\n依据：${r.evidence}`,'relationship')));
  if(!script.relationships.length)$('#relationships').append(node('p','未确认明确的人物关系。','muted'));
  $('#shots').replaceChildren();for(const shot of script.shots){const card=node('article',null,'shot'),seek=node('button','定位原片');seek.onclick=()=>{$('#sourcePreview').currentTime=shot.start;$('#sourcePreview').scrollIntoView({block:'center',behavior:'smooth'});};card.append(seek,node('time',`${shot.start}–${shot.end}秒 · ${shot.scene} · ${shot.characters.join(' / ')||'无人物'}`));for(const [label,key] of [['动作','action'],['神态 / 情绪','emotion'],['镜头','camera'],['剧情','plot']])card.append(node('p',label+'：'+shot[key]));card.append(node('p',`对白［${shot.dialogue_source}］：${shot.dialogue||'无'}`));$('#shots').append(card);}
  $('#scriptEditor').value=JSON.stringify(script,null,2);$('#reviewed').checked=false;renderBindings();controls();
}
function renderResult() {
  const result=job?.result;$('#resultPanel').hidden=!result;if(!result)return;
  $('#prompt').value=result.prompt;$('#download').href='/creative-api/jobs/'+job.id+'/result';$('#manifest').replaceChildren();
  for(const item of result.manifest){const link=node('a',item.tag+' · '+item.name+' ↓');link.href='/creative-api/media/'+item.media+'?download=true';$('#manifest').append(link);}
}
async function show(item) {
  job=item;localStorage.setItem('hamster-creative-job',item.id);source={id:item.source,name:item.name};$('#sourcePreview').src='/creative-api/media/'+source.id;$('#sourcePreview').hidden=false;$('#sourceName').textContent=source.name;
  if(item.script){script=item.script;bindings={};for(const b of item.brief?.bindings||[]){const found=(item.references||item.result?.manifest||[]).find(m=>m.media===b.media);if(found)bindings[b.target]={id:b.media,name:found.name};}renderScript();}
  else{$('#scriptArea').hidden=true;$('#empty').hidden=false;}
  $('#seconds').value=String(item.brief?.seconds||10);$('#ratio').value=item.brief?.ratio||'9:16';$('#motion').checked=item.brief?.reference_motion??true;$('#notes').value=item.brief?.notes||'';
  renderResult();busy=item.status==='running';controls();status(item);if(busy)poll(item.id);
}
function status(item){$('#progress').hidden=false;$('#progress').textContent=(item.error||item.stage||item.status)+(item.cleanup_warning?' · '+item.cleanup_warning:'');}
async function poll(id) {
  const generation=++pollGeneration;
  while(generation===pollGeneration&&job?.id===id&&busy){await new Promise(r=>setTimeout(r,1500));try{const item=await request('/jobs/'+id);if(generation!==pollGeneration||job?.id!==id)return;job=item;status(item);if(item.status!=='running'){busy=false;if(item.script){script=item.script;renderScript();}renderResult();controls();await history();}}catch(e){if(generation!==pollGeneration)return;busy=false;controls();toast('状态连接中断；任务可能仍在运行，可从最近创作重新打开。');}}
}
async function history(){const items=await request('/jobs');$('#history').replaceChildren();for(const item of items){const b=node('button',item.name+' · '+({running:'运行中',success:'已完成',failed:'未完成',cancelled:'已停止',interrupted:'已中断'}[item.status]||item.status));b.onclick=()=>safe(async()=>{if(busy||uploading)throw new Error('请先等待当前操作完成。');await show(await request('/jobs/'+item.id));});$('#history').append(b);}if(!items.length)$('#history').append(node('p','完成第一次拆解后，会在这里保留记录。','muted'));}
async function safe(action){try{await action();}catch(e){toast(e.message);}}
$('#pickSource').onclick=()=>$('#sourceInput').click();$('#sourceInput').onchange=()=>safe(()=>selectSource($('#sourceInput').files[0]));
$('#dropZone').ondragover=e=>{e.preventDefault();$('#dropZone').classList.add('drag');};$('#dropZone').ondragleave=()=>$('#dropZone').classList.remove('drag');$('#dropZone').ondrop=e=>{e.preventDefault();$('#dropZone').classList.remove('drag');safe(()=>selectSource(e.dataTransfer.files[0]));};
$('#analyze').onclick=()=>safe(async()=>{busy=true;controls();try{const item=await post('/analyze/'+source.id);await show(item);await history();}catch(e){busy=false;controls();throw e;}});
$('#applyScript').onclick=()=>safe(async()=>{if(!job)throw new Error('请先拆解视频');const candidate=JSON.parse($('#scriptEditor').value);const checked=await post('/jobs/'+job.id+'/script',candidate);script=checked;$('#resultPanel').hidden=true;renderScript();toast('修改已保存，请重新核对并生成方案。');});
$('#adapt').onclick=()=>safe(async()=>{
  if(!$('#reviewed').checked)throw new Error('请先核对脚本并勾选确认。');
  if(JSON.stringify(JSON.parse($('#scriptEditor').value))!==JSON.stringify(script))throw new Error('编辑器有尚未应用的修改，请先应用。');
  if(!Object.keys(bindings).length)throw new Error('请至少绑定一张自己的资产图片。');
  busy=true;controls();$('#resultPanel').hidden=true;
  try{job=await post('/jobs/'+job.id+'/adapt',{script,bindings:Object.entries(bindings).map(([target,media])=>({target,media:media.id})),notes:$('#notes').value,seconds:Number($('#seconds').value),ratio:$('#ratio').value,reference_motion:$('#motion').checked});status(job);poll(job.id);}
  catch(e){busy=false;controls();throw e;}
});
$('#cancel').onclick=()=>safe(async()=>{if(job){const item=await post('/jobs/'+job.id+'/cancel');pollGeneration++;busy=false;job=item;status(item);controls();await history();}});
$('#copyPrompt').onclick=()=>safe(async()=>{await navigator.clipboard.writeText($('#prompt').value);toast('完整方案已复制，请按素材绑定顺序上传。');});
$('#refresh').onclick=()=>safe(config);$('#refreshHistory').onclick=()=>safe(history);
safe(async()=>{await config();await history();const id=localStorage.getItem('hamster-creative-job');if(id)await show(await request('/jobs/'+id));});
