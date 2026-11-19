import {sealGenerationPortTable,generationProducers} from '@hypit/generation';
import {defineExactModelModule} from '@hypit/generation/model';
import {blobTypes} from '@hypit/hypit/blob';
import {sealGraphFragment} from '@hypit/hypit/author';

// This declares the published PIKNO line workflow, not an underlying vendor model.
// Unsupported roles cannot be silently mapped onto reference images.
export const moduleRef={name:'@hamster/hypit-video',version:'1'};
export const ports=sealGenerationPortTable({model:'pikno-video',result:'video',ports:[
  {name:'operationId',value:{kind:'token',minLength:1,maxLength:120},minItems:1,maxItems:1},
  {name:'line',value:{kind:'token',minLength:1,maxLength:120},minItems:1,maxItems:1},
  {name:'prompt',value:{kind:'text',maxChars:30000},minItems:1,maxItems:1},
  {name:'duration',value:{kind:'number',minimum:0.01,maximum:120},minItems:1,maxItems:1},
  {name:'resolution',value:{kind:'token',minLength:1,maxLength:32},minItems:1,maxItems:1},
  {name:'ratio',value:{kind:'token',minLength:1,maxLength:16},minItems:1,maxItems:1},
  {name:'referenceAssetIds',value:{kind:'token',minLength:32,maxLength:32},minItems:0,maxItems:20},
],requires:[]});
function validateInputs(request){
  const p=request.ports;
  for(const key of ['operationId','line'])if(p[key]&&!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,119}$/.test(p[key][0]))throw new Error('视频操作或线路标识无效');
  if(p.prompt&&!p.prompt[0].trim())throw new Error('请填写视频提示词');
  const refs=p.referenceAssetIds||[];
  if(new Set(refs).size!==refs.length||refs.some(id=>!/^[a-f0-9]{32}$/.test(id)))throw new Error('请使用仓鼠已有素材 ID');
}
export const definition=defineExactModelModule({module:moduleRef,endpoints:[{
  key:'video',requestTypeName:'PiknoVideoRequest',producerName:'request-pikno-video',ports,validateInputs,
}]});
export const endpoint=definition.endpoints.video;
export const capability=endpoint.capability;
export const fragment=sealGraphFragment({inputs:[{name:'request',type:endpoint.requestType}],operations:[
  {id:'generate',producer:endpoint.producer,inputs:{request:{kind:'fragment-input',name:'request'}},result:{kind:'need',name:'generation'}},
  {id:'primary-video',producer:generationProducers.primaryVideo,inputs:{set:{kind:'fragment-operation',operation:'generate'}},result:{kind:'output',name:'video'}},
],exports:[{name:'video',type:blobTypes.blob,root:{kind:'fragment-operation',operation:'primary-video'}}]});
export const surface={name:'video',tag:'Video',mode:'structured',outputs:[endpoint.requestType],vocabulary:{
  summary:'通过当前 PIKNO 客户线路生成一个视频；费用必须在仓鼠界面人工确认。',
  attributes:[
    ...['id','operation-id','line','prompt','duration','resolution','ratio'].map(name=>({name,kind:'literal',required:true,summary:name==='operation-id'?'跨 Build 不变的 Source 操作身份；不得因未知结果自动换新。':name})),
    {name:'reference-asset-ids',kind:'literal',required:false,summary:'仓鼠已有素材 ID，以英文逗号分隔；并非任意远程地址。'},
  ],ports:[{name:'video',type:blobTypes.blob,summary:'已保存的生成视频。'}],
  example:'<hamster:Video id="shot-1" operation-id="shot-1-v1" line="当前仓鼠线路ID" prompt="镜头提示词" duration="4" resolution="720p" ratio="16:9"/>',
  notes:['仅支持文本与仓鼠已有素材 ID；不支持 Hypit Resource、首尾帧、人物参考分类或其他未声明角色。','线路、参数和参考素材上限由当前已授权目录再次验证；不替换模型或缩减参数。'],
}};
export function decodeVideoSurface({element}){
  const required=['id','operation-id','line','prompt','duration','resolution','ratio'],allowed=[...required,'reference-asset-ids'];
  if(Object.keys(element.attributes).some(name=>!allowed.includes(name))||required.some(name=>typeof element.attributes[name]!=='string'||!element.attributes[name].trim())||element.children.some(child=>child.kind==='element'||child.value.trim()))throw new Error('视频元素含未支持的参数或缺少必要参数');
  const a=element.attributes,id=a.id;
  const request=endpoint.sealRequest({operationId:[a['operation-id']],line:[a.line],prompt:[a.prompt],duration:[Number(a.duration)],resolution:[a.resolution],ratio:[a.ratio],...(a['reference-asset-ids']?{referenceAssetIds:a['reference-asset-ids'].split(',').map(id=>id.trim())}:{})});
  return {records:[{id:id+'.request',type:endpoint.requestType,value:{kind:'inline',value:request},range:element.range}],components:[{id,fragment:fragment.id,inputs:{request:{kind:'record',id:id+'.request'}},outputs:{video:id+'.video'},range:element.range}],fragments:[fragment]};
}
