import {all,one,run,stmt,id,now,fail,hash,canonical,integer,roundSale,money,signedUrl} from './common.mjs';

export function quote(model,payload){
 if(payload.price_version!==undefined&&payload.price_version!==model.version)throw fail('线路售价已更新，请刷新价格后重新确认生成',409);
 const spec=JSON.parse(model.spec_json);const duration=model.kind==='video'?integer(payload.duration??5,1,600,'视频时长'):1;
 if(model.kind==='video'&&!spec.tool&&(!spec.durations.includes(duration)||!spec.resolutions.includes(payload.resolution||spec.resolutions[0])||!spec.ratios.includes(payload.ratio||spec.ratios[0])))throw fail('模型不支持该时长、清晰度或比例');
 if(typeof payload.prompt!=='string'||!payload.prompt.trim()||payload.prompt.length>(spec.max_prompt_characters||30000))throw fail('提示词为空或超过长度限制');
 let total=0;for(const field of ['images','videos','audios']){if(payload[field]!==undefined&&!Array.isArray(payload[field]))throw fail('素材列表格式无效');const count=payload[field]?.length||0;total+=count;if(count>(spec['max_'+field]||0))throw fail('素材数量超过模型限制');}
 if(total>(spec.max_media_files||0))throw fail('素材总数超过模型限制');
 if(model.kind==='image'&&payload.mask&&!payload.images?.length)throw fail('蒙版需要原图');
 if(model.kind==='image'){
  if(!['auto','1:1','16:9','9:16','3:2','2:3'].includes(payload.aspect_ratio||'auto')||!['low','medium','high','auto'].includes(payload.quality||'high'))throw fail('图片规格无效');
  if(payload.size&&payload.size!=='auto'){const match=String(payload.size).match(/^(\d+)x(\d+)$/),w=Number(match?.[1]),h=Number(match?.[2]);if(!match||w%16||h%16||w<1||h<1||Math.max(w,h)>3840||Math.max(w,h)/Math.min(w,h)>3||w*h<655360||w*h>8294400)throw fail('图片尺寸不符合模型限制');}
 }
 if(model.kind==='video'&&payload.reference==='startEnd'&&(payload.images?.length||0)>2)throw fail('首尾帧最多两张图片');
 const rates=spec.cost_by_resolution||{};const rate=rates[payload.resolution]??model.cost_rate;
 const cost=rate*(model.billing==='per_second'?duration:1);
 const sale=model.fixed_sale==null?0:model.fixed_sale*(model.billing==='per_second'?duration:1);
 if(spec.tool==='digital'&&((payload.images?.length||0)!==1||(payload.audios?.length||0)!==1||!Number.isFinite(Number(payload.audios[0].durationSeconds))||Number(payload.audios[0].durationSeconds)<=0||Number(payload.audios[0].durationSeconds)>30.5))throw fail('数字人需要一张图片和不超过30秒的有效音频');
 if(spec.tool==='depth'&&(payload.videos?.length||0)!==1)throw fail('黑白深度需要一个视频');
 if(!Number.isSafeInteger(sale)||sale<0||sale===0&&!(model.id==='tool-depth'&&spec.free===true&&model.fixed_sale===0))throw fail('价格未发布，请联系管理员',503);
 return {model_id:model.id,provider:model.provider,kind:model.kind,version:model.version,billing:model.billing,cost_rate:rate,markup_bps:model.markup_bps,duration,upstream_estimate:cost,reserved:sale,currency:'CNY'};
}
export function publicModel(row){
 const raw=JSON.parse(row.spec_json),spec={};
 for(const k of ['resolutions','durations','ratios','max_images','max_videos','max_audios','max_media_files','max_prompt_characters','tool','free'])if(raw[k]!==undefined)spec[k]=raw[k];
 const rate=money(row.fixed_sale||0);
 if(raw.free!==undefined)spec.free=raw.free===true&&row.id==='tool-depth'&&row.fixed_sale===0;
 return {id:row.id,name:row.name,type:row.kind,...spec,...(row.kind==='image'?{aspect_ratios:spec.ratios,quality_options:['auto','high','medium','low'],default_quality:'auto'}:{}),provider:row.provider==='tool'?'tool':row.provider==='backup'?'official':'generate',default_resolution:spec.resolutions?.[0],default_duration_seconds:spec.durations?.[0],default_ratio:spec.ratios?.[0],concurrency_options:row.provider==='backup'?[1]:[1,2,4],billing:row.billing,price_currency:'CNY',price_version:row.version,
 ...(row.billing==='per_second'?{price_per_second_credits:rate,display_price_yuan_per_second:rate}:{price_credits:rate,display_price_yuan:rate}),pricing_precision:'exact',pricing_source:'仓鼠AI 售价'};
}
export async function createTask(env,user,payload,requestKey){
 const requestHash=await hash(canonical(payload));let prior=await one(env,'SELECT * FROM tasks WHERE user_id=? AND request_id=?',user.id,requestKey);
 if(prior){if(prior.request_hash!==requestHash)throw fail('同一请求编号不能更换生成内容',409);return prior;}
 const model=await one(env,'SELECT * FROM models WHERE id=? AND enabled=1',payload.model);if(!model)throw fail('模型未开放');
 const q=quote(model,payload);const taskId=id('task');
 await requireChannel(env,model.provider);
 try{await run(env,'INSERT INTO tasks (id,user_id,api_key_id,request_id,request_hash,model_id,provider,kind,payload_json,quote_json,reserved,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',taskId,user.id,user.key_id,requestKey,requestHash,model.id,model.provider,model.kind,JSON.stringify(payload),JSON.stringify(q),q.reserved,now(),now());}
 catch(e){prior=await one(env,'SELECT * FROM tasks WHERE user_id=? AND request_id=?',user.id,requestKey);if(prior&&prior.request_hash===requestHash)return prior;
 if(String(e).includes('CHECK constraint'))throw fail('可用余额不足，请充值',402);if(String(e).includes('CUSTOMER_CONCURRENCY'))throw fail('客户在途任务已达到上限',429);throw e;}
 return one(env,'SELECT * FROM tasks WHERE id=?',taskId);
}
export async function requireChannel(env,provider){
 const ready=await one(env,"SELECT k.id FROM provider_keys k JOIN provider_accounts a ON a.id=k.account_id WHERE k.provider=? AND a.provider=k.provider AND k.status='active' LIMIT 1",provider);
 if(!ready)throw fail('此线路尚未配置或已停用，请联系管理员；本次未扣费',409);
}
export async function claimKey(env,taskId){
 const task=await one(env,'SELECT * FROM tasks WHERE id=?',taskId);if(task.state!=='queued')return task.provider_key_id;
 const keys=await all(env,`SELECT k.id FROM provider_keys k JOIN provider_accounts a ON a.id=k.account_id WHERE k.provider=? AND k.status='active' AND k.cooldown_until<=? AND
 (SELECT COUNT(*) FROM key_leases WHERE key_id=k.id)<k.max_concurrency AND
 (SELECT COUNT(*) FROM key_leases l JOIN provider_keys p ON p.id=l.key_id WHERE p.account_id=a.id)<a.max_concurrency
 ORDER BY k.priority DESC,(SELECT COUNT(*) FROM key_leases WHERE key_id=k.id) ASC,k.created_at ASC`,task.provider,now());
 for(const key of keys){try{await env.DB.batch([stmt(env,'INSERT INTO key_leases VALUES (?,?,?)',taskId,key.id,now()),stmt(env,"UPDATE tasks SET provider_key_id=?,state='preparing',updated_at=? WHERE id=? AND state='queued'",key.id,now(),taskId)]);return key.id;}
 catch(e){if(!/KEY_FULL|ACCOUNT_FULL|TASK_NOT_QUEUED|UNIQUE constraint|KEY_UNAVAILABLE/.test(String(e)))throw e;}}
 return null;
}
export async function finishFailure(env,taskId,message,cancel=false){await run(env,`UPDATE tasks SET state=?,error=?,updated_at=? WHERE id=? AND state NOT IN ('succeeded','failed','cancelled')`,cancel?'cancelled':'failed',message,now(),taskId);}
export async function settle(env,taskId,resultKey){
 const exists=await env.RESULTS.head(resultKey);if(!exists||exists.size<=0)throw fail('结果尚未成功转存',503);
 await run(env,"UPDATE tasks SET state='succeeded',result_key=?,charged=reserved,progress=100,error='',updated_at=? WHERE id=? AND state='transferring'",resultKey,now(),taskId);
}
export async function publicTask(env,task,origin){
 const state=['queued','preparing'].includes(task.state)?'queued':['submitting','unknown','processing','transferring'].includes(task.state)?'processing':task.state==='cancelled'?'failed':task.state;
 const resultUrl=task.result_key?await signedUrl(env,origin,task.result_key):'';
 return {id:task.id,task_id:task.id,status:state,billing_status:task.state,progress:task.progress,model:task.model_id,prompt:JSON.parse(task.payload_json).prompt,estimated_cost:money(task.reserved),cost:money(task.charged),error:task.error,
 state_label:({queued:'等待可用通道',preparing:'素材准备中',submitting:'正在提交',unknown:'提交结果核查中',processing:'生成中',transferring:'结果转存中',succeeded:'已完成',failed:'失败，未扣费',cancelled:'已取消，未扣费'})[task.state],
 ...(resultUrl?{result_url:resultUrl,[task.kind==='video'?'video_url':'image_url']:resultUrl}:{}),created_at:task.created_at};
}
