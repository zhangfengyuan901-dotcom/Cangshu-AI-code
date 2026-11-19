import {mediaLimitError} from './core.mjs';
const kinds={image:'图片',video:'视频',audio:'音频'};
export function canvasMediaError(model,refs){return mediaLimitError(model,refs.map(ref=>({kind:ref.asset.kind})));}
export function executionKind(channel){return ['digital','depth'].includes(channel)?'tool':channel==='image'?'image':'video';}
export function modelOptionsError(model,options={},channel='image'){
  if(!model)return '请选择当前已开放的线路';
  if(['digital','depth'].includes(channel))return '';
  const valid=(values,value)=>Array.isArray(values)&&values.length&&values.includes(value);
  if(channel==='image'){
    if(!valid(model.aspect_ratios,options.aspect_ratio))return '原画面比例已不可用，请重新选择图片规格';
    if(!valid(model.size_options,options.size))return '原图片尺寸已不可用，请重新选择图片规格';
    if(!valid(model.quality_options,options.quality))return '原图片质量已不可用，请重新选择图片规格';
    const [w,h]=String(options.size).split('x').map(Number);let a=w,b=h;while(b){[a,b]=[b,a%b];}
    if((options.size==='auto'?'auto':`${w/a}:${h/a}`)!==options.aspect_ratio)return '图片尺寸与画面比例不匹配，请重新选择';
  }else{
    if(!valid(model.ratios,options.ratio)||!valid(model.resolutions,options.resolution)||!valid(model.durations,Number(options.duration)))return '原视频规格已不可用，请重新选择比例、清晰度和时长';
    if(options.reference&&!['all','omni'].includes(options.reference))return '原参考模式已不可用，请选择全能参考';
  }
  return '';
}
export function outputRun(doc,node){
  if(node?.type!=='output')return;
  if(node.id.startsWith('output:'))return (doc.runs||[]).find(r=>'output:'+r.requestId===node.id);
  return (doc.runs||[]).find(r=>r.requestId===node.data.requestId);
}
export function nodeAssetId(doc,node){
  return node?.type==='output'?(node.data.assetId||outputRun(doc,node)?.assetId):node?.data.assetId;
}
export function mergeOutputBindings(nodes,result){
  return nodes.map(node=>{const incoming=result.nodes.find(n=>n.id===node.id);return node.type==='output'&&!node.data.requestId&&incoming?.data.requestId?{...node,data:{...node.data,...incoming.data}}:node;});
}
export function referenceInputs(doc,nodeId,assets){
  const counts={image:0,video:0,audio:0},nodes=new Map(doc.nodes.map(n=>[n.id,n])),library=new Map(assets.map(a=>[a.id,a]));
  return doc.edges.filter(e=>e.target===nodeId).flatMap(edge=>{
    const node=nodes.get(edge.source),asset=library.get(nodeAssetId(doc,node));
    if(!['asset','upload','output'].includes(node?.type)||!asset||!kinds[asset.kind])return [];
    return [{source:node.id,edgeId:edge.id,asset,tag:'@'+kinds[asset.kind]+(++counts[asset.kind])}];
  });
}
export function combinedPrompt(doc,nodeId){
  const nodes=new Map(doc.nodes.map(n=>[n.id,n]));
  return [...doc.edges.filter(e=>e.target===nodeId).map(e=>nodes.get(e.source)).filter(n=>n?.type==='text').map(n=>n.data.text),nodes.get(nodeId)?.data.prompt].filter(Boolean).join('\n\n');
}
// Positions, labels and unrelated task progress cannot change a confirmation.
// Input order and exact bound assets do: @ references must remain unchanged.
export function canvasQuoteSignature(doc,nodeId,assets){
  const node=doc?.nodes.find(n=>n.id===nodeId&&n.type==='generation');if(!node)return '';
  return JSON.stringify({nodeId,channel:node.data.channel,model:['digital','depth'].includes(node.data.channel)?'tool-'+node.data.channel:node.data.model,prompt:combinedPrompt(doc,nodeId),options:node.data.options||{},inputs:referenceInputs(doc,nodeId,assets).map(({source,asset})=>({source,id:asset.id,kind:asset.kind,size:asset.size,durationSeconds:asset.durationSeconds}))});
}
export function mentionTokens(prompt){return [...new Set(prompt.match(/@(图片|视频|音频)\d+/g)||[])];}
export function missingReferenceError(prompt,refs){
  const missing=mentionTokens(prompt).filter(tag=>!refs.some(r=>r.tag===tag));
  return missing.length?'未连接的素材引用：'+missing.join('、')+'。请连接素材或修正提示词。':'';
}
// Reject silent retargeting when deleting/reordering a source that is already mentioned.
export function referenceChangeError(before,after,assets){
  for(const target of after.nodes.filter(n=>n.type==='generation')){
    const oldRefs=referenceInputs(before,target.id,assets),newRefs=referenceInputs(after,target.id,assets);
    for(const tag of mentionTokens(combinedPrompt(after,target.id))){
      const old=oldRefs.find(r=>r.tag===tag),next=newRefs.find(r=>r.tag===tag);
      if(old&&old.source!==next?.source)return `「${target.data.label||'生成节点'}」正在引用 ${tag}，请先修改该提示词，再删除或调整素材连线。`;
    }
  }
  return '';
}
export function validConnection(connection,nodes,edges=[]){
  const from=nodes.find(n=>n.id===connection.source),to=nodes.find(n=>n.id===connection.target);
  if(!from||!to||from.id===to.id)return false;
  const reference=['text','asset','upload','output'].includes(from.type)&&to.type==='generation';
  const result=from.type==='generation'&&to.type==='output'&&!to.id.startsWith('output:')&&!to.data.requestId&&!to.data.assetId&&!edges.some(e=>e.target===to.id);
  if(!reference&&!result)return false;
  const seen=new Set(),pending=[to.id];
  while(pending.length){const id=pending.pop();if(id===from.id)return false;if(seen.has(id))continue;seen.add(id);pending.push(...edges.filter(e=>e.source===id).map(e=>e.target));}
  return true;
}
export function insertMention(value,start,end,tag){
  const left=value.slice(0,start),match=left.match(/@[^\s@]*$/),offset=match?start-match[0].length:start;
  const text=value.slice(0,offset)+tag+' '+value.slice(end);
  return {text,caret:offset+tag.length+1};
}
