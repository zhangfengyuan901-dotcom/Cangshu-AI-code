// Internal execution adapter. The relay owns identity, reservation and review;
// the protected media Worker owns workflow credentials and binary transfer.
const MODELS=['digital','depth','pikno-tool-digital','pikno-tool-depth'];
export const meta={apiVersion:1,key:'pikno-tools',name:'PIKNO Tools',version:'0.2.0',author:{name:'PIKNO'},baseUrl:'https://www.piknoai.com',auth:'api_key',models:MODELS,fetchMode:'per_task',protocols:['openai_video'],routes:[
  {method:'POST',path:'/v1/tools/digital',type:'submit',decode:'digital',render:'created',models:['pikno-tool-digital']},
  {method:'POST',path:'/v1/tools/depth',type:'submit',decode:'depth',render:'created',models:['pikno-tool-depth']},
  {method:'GET',path:'/pikno-tools/tasks/:task_id',type:'query',render:'created'},
],usageSchema:{requests:{type:'number',unit:'count',description:{en:'Tool execution unit price',zh:'工具执行单价'}}}};
function normalize(input,kind){
  if(!input||typeof input!=='object'||Array.isArray(input)||input.model!=='pikno-tool-'+kind||Object.keys(input).some(key=>!['model','images','videos','audios'].includes(key)))throw Error('Use the matching published tool with completed media');
  const images=input.images||[],videos=input.videos||[],audios=input.audios||[];
  if(![images,videos,audios].every(Array.isArray)||(kind==='digital'?(images.length!==1||audios.length!==1||videos.length!==0):(videos.length!==1||images.length!==0||audios.length!==0)))throw Error('Tool reference count is invalid');
  for(const item of [...images,...videos,...audios])if(typeof item!=='object'||typeof item.url!=='string'||!/^https:\/\/www\.piknoai\.com\/media\/v1\/assets\/[a-f0-9]{32}\?ticket=/.test(item.url))throw Error('Upload and complete media before submitting');
  if(kind==='digital'&&(!Number.isFinite(audios[0].durationSeconds)||audios[0].durationSeconds<=0||audios[0].durationSeconds>30))throw Error('Audio duration must be no more than 30 seconds');
  return {kind:'submit',model:input.model,requestBody:{kind,images,videos,audios}};
}
function visible(task){
  let status={SUCCESS:'completed',FAILURE:'failed',QUEUED:'queued',SUBMITTED:'queued',NOT_START:'queued',IN_PROGRESS:'in_progress',UNKNOWN:'unknown'}[task.status]||'unknown';
  // A local polling failure is not a provider receipt. Keep it in review.
  if(task.data?.status==='unknown'||(task.status==='FAILURE'&&task.data?.status!=='failed'))status='unknown';
  return {id:task.task_id,status,progress:task.progress||'0%',outputs:status==='completed'?(task.data?.outputs||[]):[],...(status==='failed'?{error:{message:'Tool generation failed'}}:{})};
}
export const native={digital:ctx=>normalize(ctx.body.kind==='json'?ctx.body.value:null,'digital'),depth:ctx=>normalize(ctx.body.kind==='json'?ctx.body.value:null,'depth'),created:(_ctx,task)=>visible(task)};
export const protocols={openai_video:{decodeRequest(){throw Error('Use the dedicated tool endpoint');},render:(_ctx,task)=>visible(task)}};
function endpoint(ctx,path){if(ctx.baseUrl.replace(/\/+$/,'')!=='https://www.piknoai.com')throw Error('Tool execution origin is invalid');return 'https://www.piknoai.com/media/v1/tools'+path;}
function authorization(ctx){const key=String(ctx.apiKey||'');if(key.length<32)throw Error('Tool execution connection is unavailable');return 'Bearer '+key;}
export function buildSubmitRequest(ctx){return {url:endpoint(ctx,''),method:'POST',headers:{Authorization:authorization(ctx),'Content-Type':'application/json'},body:{...ctx.requestBody,request_id:ctx.publicTaskId}};}
export function parseSubmitResponse(ctx,response){const value=response.body;if(!value||typeof value.id!=='string'||!/^[A-Za-z0-9_-]{1,200}$/.test(value.id)||value.id!==ctx.publicTaskId)throw Error('Tool submission is uncertain; do not resubmit');return {taskId:value.id,taskData:value,...(value.status==='failed'?{immediate:{status:'FAILURE',reason:'Tool could not be prepared'}}:{})};}
export function buildQueryRequest(ctx){return {url:endpoint(ctx,'/'+encodeURIComponent(ctx.taskId)),method:'GET',headers:{Authorization:authorization(ctx)}};}
export function parseTaskResult(ctx,value){const statuses={queued:'QUEUED',processing:'IN_PROGRESS',completed:'SUCCESS',failed:'FAILURE',unknown:'UNKNOWN'};const status=statuses[value?.status]||'UNKNOWN';if(!value||value.id!==ctx.taskId)return {status:'UNKNOWN'};if(status==='SUCCESS'&&(!Array.isArray(value.outputs)||value.outputs.length!==1||value.outputs[0]?.type!=='video'||typeof value.outputs[0]?.url!=='string'||!/^https:\/\/www\.piknoai\.com\/media\/v1\/assets\/[a-f0-9]{32}\?ticket=/.test(value.outputs[0].url)))return {status:'UNKNOWN'};return {status,progress:status==='SUCCESS'?'100%':'0%',...(status==='FAILURE'?{reason:'Tool generation failed'}:{})};}
export function extractUsage(){return {requests:1};}
export function extractUsageOnComplete(){return {requests:1};}
export function listArtifacts(task){return task.status==='SUCCESS'&&task.data?.outputs?.length===1?[{key:'video',type:'video',mimeType:'video/mp4'}]:[];}
export function buildContentRequest(ctx){const id=ctx.upstreamTaskId;if(ctx.artifactKey!=='video'||!['GET','HEAD'].includes(ctx.clientRequest?.method)||typeof id!=='string'||!/^task_[A-Za-z0-9_-]{1,190}$/.test(id)||ctx.data?.status!=='completed'||ctx.data?.outputs?.length!==1||ctx.data.outputs[0]?.type!=='video')throw Error('Tool result unavailable');const headers={Authorization:authorization(ctx)},range=ctx.clientRequest.headers?.Range||ctx.clientRequest.headers?.range;if(range&&/^bytes=\d+-\d*$/.test(range))headers.Range=range;return {url:endpoint(ctx,'/'+encodeURIComponent(id)+'/content'),method:ctx.clientRequest.method,headers};}
