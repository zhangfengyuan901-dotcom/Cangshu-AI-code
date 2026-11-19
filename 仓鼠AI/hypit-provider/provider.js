import {canonicalize,defineEndpoint,wakeAfter} from '@hypit/hypit/endpoint';
import {generationTypes,sealGeneratedVideoSet} from '@hypit/generation';
import {capability,endpoint as model} from './model.js';

const states=new Set(['awaiting_confirmation','confirmed','preparing','submitting','queued','processing','unknown','succeeded','failed']);
const fail=()=>new Error('Hypit 视频服务暂不可用；请在仓鼠中查看原操作');
export function createVideoProvider({instance,pool,baseUrl,projectId,token,pollIntervalMs=3000,fetch:fetcher=globalThis.fetch}){
  const base=new URL(baseUrl);
  if(base.protocol!=='http:'||base.hostname!=='127.0.0.1'||!base.port||base.username||base.password||base.search||base.hash||!token||!projectId)throw fail();
  const request=async(route,body)=>{
    let response;
    try{response=await fetcher(new URL('/api/hypit/video'+route,base),{method:body===undefined?'GET':'POST',headers:{authorization:'Bearer '+token,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(130000),redirect:'error'});}catch{throw fail();}
    if(!response.ok)throw fail();
    try{return await response.json();}catch{throw fail();}
  };
  const authored=need=>{model.validateRequest(need.constraints);const p=need.constraints.ports;return {projectId,operationId:p.operationId[0],model:p.line[0],prompt:p.prompt[0],options:{duration:p.duration[0],resolution:p.resolution[0],ratio:p.ratio[0]},assetIds:p.referenceAssetIds||[]};};
  const supports=need=>{try{authored(need);return {status:'supported'};}catch{return {status:'unsupported',reason:'视频参数含未适配的输入；仅接受当前线路、文本及仓鼠已有素材 ID。'};}};
  const handleOf=value=>{if(!value||!/^hypit-[a-f0-9]{64}$/.test(value.requestId||''))throw fail();return {requestId:value.requestId};};
  const outcome=operation=>{
    const handle=handleOf(operation),receipt={requestId:handle.requestId};
    if(!states.has(operation.status))throw fail();
    if(operation.status==='failed')return {status:'failed',receipt,failure:{code:'VIDEO_GENERATION_FAILED',message:'视频生成未完成；请在 PIKNO 任务记录核对结果。'}};
    if(operation.status==='succeeded'&&operation.result?.url)return {status:'ready',handle,receipt};
    return {...wakeAfter(handle,pollIntervalMs,Date.now(),{phase:operation.status==='awaiting_confirmation'?'等待在仓鼠界面确认费用':operation.status==='unknown'?'查询原任务；不会自动重发':'视频任务处理中'}),receipt};
  };
  const endpoint={
    async start(context){
      const input=authored(context.need);
      // A Build can request a quote, never approve its own spending.
      const operation=await request('/quote',input),handle=handleOf(operation),receipt={requestId:handle.requestId};
      await context.checkpoint?.({handle,receipt});
      return outcome(operation);
    },
    async poll(context){
      const handle=handleOf(context.handle);let operation=await request('/operations/'+handle.requestId);
      // Only the independently approved host receipt can authorize start().
      if(operation.status==='confirmed')operation=await request('/start',{requestId:handle.requestId});
      return outcome(operation);
    },
    async collect(context){
      const handle=handleOf(context.handle),operation=await request('/operations/'+handle.requestId);
      if(operation.status!=='succeeded'||operation.result?.url!=='/api/hypit/video/operations/'+handle.requestId+'/file')throw fail();
      let response;
      try{response=await fetcher(new URL(operation.result.url,base),{headers:{authorization:'Bearer '+token},signal:AbortSignal.timeout(600000),redirect:'error'});}catch{throw fail();}
      const mediaType=response.headers.get('content-type')?.split(';')[0]?.trim(),limit=512*1024*1024;
      if(!response.ok||!mediaType?.startsWith('video/')||Number(response.headers.get('content-length'))>limit||!response.body)throw fail();
      const chunks=[];let size=0;
      try{for await(const chunk of response.body){size+=chunk.byteLength;if(size>limit)throw fail();chunks.push(chunk);}}catch{throw fail();}
      if(!size)throw fail();const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
      const artifact=await context.resources.put(bytes,mediaType);
      return {status:'completed',result:{value:{kind:'inline',value:canonicalize(sealGeneratedVideoSet({videos:[artifact]}))}}};
    },
  };
  return defineEndpoint({instance,pool,defaultConcurrency:1,actionLimits:{submit:{concurrency:1},poll:{concurrency:4},collect:{concurrency:1}},
    pricing:{kind:'page',url:'https://www.piknoai.com'},
    async readPricing(context){
      const input=authored(context.request),catalog=await request('/models'),line=catalog.models?.find(line=>line.id===input.model);
      if(!line)throw fail();
      return [{source:'https://www.piknoai.com',data:canonicalize({name:line.name,currency:line.currency,prices:line.prices||[]}),summary:'当前客户线路标价；本次准确费用需在仓鼠中获取报价并人工确认。'}];
    },
    capabilities:[{capability,returns:generationTypes.videoSet,lifecycle:'asynchronous',supports,endpoint}],
  });
}
