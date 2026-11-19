import React,{memo,useEffect,useRef,useState} from 'react';
import {insertMention} from '../../public/canvas-core.mjs';

export const StorageStatus=memo(function StorageStatus({revision}){
  const [status,setStatus]=useState({state:'checking',message:'正在检测素材权限',time:''});
  const checking=useRef(false),generation=useRef(0);
  useEffect(()=>{generation.current++;checking.current=false;setStatus({state:'checking',message:'正在检测素材权限',time:''});void check();const timer=setInterval(check,60000);window.addEventListener('online',check);return()=>{generation.current++;clearInterval(timer);window.removeEventListener('online',check);};},[revision]);
  async function check(){
    if(checking.current)return;const current=generation.current;checking.current=true;setStatus(s=>({...s,state:'checking'}));
    try{
      const response=await fetch('/api/uploads/status',{cache:'no-store',signal:AbortSignal.timeout(12000)}),data=await response.json();
      if(current!==generation.current)return;const connected=response.ok&&data.connected===true;
      setStatus({state:connected?'online':'offline',message:connected?'素材权限已验证；实际上传结果以素材任务为准；点击重新检测':'素材权限未验证，请检查网络并到主应用的个人中心检查连接',time:new Date().toLocaleTimeString()});
    }catch{if(current===generation.current)setStatus({state:'offline',message:'无法完成素材权限检测；请检查本地服务和网络，点击重试',time:new Date().toLocaleTimeString()});}
    finally{if(current===generation.current)checking.current=false;}
  }
  const label=status.state==='online'?'素材权限已验证':status.state==='offline'?'素材权限未验证':'正在检测素材权限';
  return <button className={'r2-status '+status.state} onClick={check} disabled={status.state==='checking'} aria-label={label+'，点击重新检测'} title={status.message+(status.time?'\n上次检测 '+status.time:'')}><i aria-hidden="true"/>{label}</button>;
});

export function PromptInput({value,onChange,references,enabled=true}){
  const input=useRef(),[query,setQuery]=useState(null),[active,setActive]=useState(0);
  const candidates=references.filter(r=>!query||r.tag.includes(query)||r.asset.name.includes(query));
  function updateQuery(el){const match=el.value.slice(0,el.selectionStart).match(/@([^\s@]*)$/);setQuery(enabled&&match?match[1]:null);setActive(0);}
  function insert(ref){const el=input.current,start=el.selectionStart??value.length,end=el.selectionEnd??start;const next=insertMention(value,start,end,ref.tag);onChange(next.text);setQuery(null);requestAnimationFrame(()=>{el.focus();el.setSelectionRange(next.caret,next.caret);});}
  return <div className="prompt-control">
    <textarea ref={input} aria-label="生成提示词" aria-autocomplete={enabled?'list':undefined} aria-expanded={enabled?query!==null:undefined} placeholder={enabled?'输入 @ 引用已连接素材，或点击下方素材标签':'输入提示词，或连接文本节点'} value={value} onChange={e=>{updateQuery(e.target);onChange(e.target.value);}} onSelect={e=>updateQuery(e.target)} onClick={e=>updateQuery(e.target)} onBlur={()=>setQuery(null)} onKeyDown={e=>{
      if(query===null)return;
      if(e.key==='Escape'){setQuery(null);e.stopPropagation();}
      if(['ArrowDown','ArrowUp'].includes(e.key)){e.preventDefault();setActive(n=>(n+(e.key==='ArrowDown'?1:-1)+Math.max(1,candidates.length))%Math.max(1,candidates.length));}
      if(e.key==='Enter'&&candidates.length){e.preventDefault();insert(candidates[active]||candidates[0]);}
    }}/>
    {enabled&&query!==null&&<div className="mention-menu" role="listbox" aria-label="已连接素材引用">{candidates.length?candidates.map((ref,i)=><button key={ref.source} type="button" role="option" aria-selected={i===active} className={i===active?'active':''} onMouseDown={e=>e.preventDefault()} onClick={()=>insert(ref)}><b>{ref.tag}</b><span>{ref.asset.name}</span></button>):<p>{references.length?'没有匹配的素材':'先把素材卡片连到此节点，再输入 @'}</p>}</div>}
    {enabled&&<div className="mention-chips" aria-label="点击插入素材引用">{references.map(ref=><button type="button" key={ref.source} title={ref.asset.name} onMouseDown={e=>e.preventDefault()} onClick={()=>insert(ref)}>{ref.tag}<span>{ref.asset.name}</span></button>)}</div>}
  </div>;
}

export function UploadContent({asset,job,onUpload,onRetry,children}){
  const input=useRef(),[over,setOver]=useState(false),busy=job&&['reading','uploading','syncing'].includes(job.stage);
  return <div className={'upload-body nodrag nowheel'+(over?' drag-over':'')} onDragOver={e=>{e.preventDefault();e.stopPropagation();if(!busy)setOver(true);}} onDragLeave={()=>setOver(false)} onDrop={e=>{e.preventDefault();e.stopPropagation();setOver(false);if(!busy&&e.dataTransfer.files[0])onUpload(e.dataTransfer.files[0]);}}>
    <input ref={input} aria-label="上传卡片素材文件" type="file" hidden accept="image/png,image/jpeg,image/webp,video/mp4,video/webm,video/quicktime,audio/mpeg,audio/wav,audio/mp4,audio/aac" onChange={e=>{if(e.target.files[0])onUpload(e.target.files[0]);e.target.value='';}}/>
    {asset?children:<div className="upload-placeholder"><span>↑</span><strong>独立素材上传卡片</strong><p>拖入图片、视频或音频<br/>一张卡片对应一个素材</p></div>}
    <button className="upload-choose" disabled={busy} onClick={()=>input.current.click()}>{asset?'替换素材':'选择素材'}</button>
    {job&&<div className={'upload-progress '+(job.stage==='error'?'error':'')} role="status">{job.message}{job.stage==='uploading'&&<progress max="100" value={job.progress}/>} {job.stage==='syncing'&&<progress/>}{job.stage==='error'&&asset&&<button onClick={onRetry}>重试 素材通道 同步</button>}</div>}
    {!job&&asset&&<small>本地素材已保存 · 执行时按目标功能上传</small>}
    <small>图片 ≤30MB · 视频/音频 ≤50MB<br/>上传完成后连接生成节点，使用 @ 引用</small>
  </div>;
}

export function SyncControls({kind,onKindChange,onSync,busy=false}){
  return <div className="output-actions"><label className="field">素材用途<select className="nodrag" aria-label="素材同步用途" value={kind} onChange={e=>onKindChange(e.target.value)}><option value="image">图片生成</option><option value="video">视频生成</option><option value="tool">数字人 / 深度视频</option></select></label><button disabled={busy} onClick={onSync}>{busy?'准备中…':kind==='video'?'上传视频参考素材':kind==='image'?'准备图片参考素材':'直传工具素材'}</button></div>;
}

export function uploadLocal(file,duration,onProgress){
  return new Promise((resolve,reject)=>{
    const xhr=new XMLHttpRequest();xhr.open('POST','/api/canvas/assets/import?name='+encodeURIComponent(file.name)+'&duration='+duration);xhr.timeout=180000;
    xhr.upload.onprogress=e=>{if(e.lengthComputable)onProgress(Math.round(e.loaded/e.total*100));};
    xhr.onload=()=>{try{const data=JSON.parse(xhr.responseText);xhr.status>=200&&xhr.status<300?resolve(data):reject(Error(data.error||'上传失败'));}catch{reject(Error('上传响应异常，请检查素材库后重试'));}};
    xhr.onerror=()=>reject(Error('本地上传连接中断，请检查素材库后重试'));xhr.ontimeout=()=>reject(Error('上传超时，请检查素材库后重试'));xhr.send(file);
  });
}
export async function mediaDuration(file){
  if(!/^(audio|video)\//.test(file.type)&&!(/\.(mp4|webm|mov|mp3|wav|m4a|aac)$/i.test(file.name)))return 0;
  return new Promise((resolve,reject)=>{
    const el=document.createElement('video'),url=URL.createObjectURL(file);
    const finish=(err)=>{clearTimeout(timer);el.onloadedmetadata=null;el.onerror=null;URL.revokeObjectURL(url);el.removeAttribute('src');el.load();err?reject(err):resolve(value);};let value;
    const timer=setTimeout(()=>finish(Error('读取素材时长超时，请换用兼容格式')),15000);
    el.onloadedmetadata=()=>{value=el.duration;el.onloadedmetadata=null;el.onerror=null;finish(Number.isFinite(value)&&value>0?null:Error('无法读取有效素材时长'));};
    el.onerror=()=>{el.onloadedmetadata=null;el.onerror=null;finish(Error('此素材格式无法读取时长'));};el.preload='metadata';el.src=url;
  });
}
