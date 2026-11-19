const crypto=require('node:crypto');
const DEFAULT_BILLING_ENDPOINT='https://account.hamsterai.cc';
const BILLING_QR_SHA256='8759221176d2b449c0eec04ac3c5d81b17977e77de35853718f8ad74512501bc';
const enabled=cfg=>/^ha_[a-f0-9]{64}$/.test(cfg.billingApiKey||'');
function createClient({endpoint=DEFAULT_BILLING_ENDPOINT,fetchImpl=fetch}={}){
 async function request(cfg,path,{signal,...options}={}){
  let response;try{response=await fetchImpl(endpoint+path,{...options,redirect:'error',headers:{...options.headers,Authorization:'Bearer '+(cfg.billingApiKey||'')},signal:signal||AbortSignal.timeout(60000)});}catch{throw Object.assign(Error('仓鼠服务暂时无法连接，请稍后重试'),{statusCode:503});}
  const data=await response.json().catch(()=>({}));
  if(!response.ok){const safe=String(data.error||'请求失败').replace(/https?:\/\/\S+|sanbao\S*|videofee|packy|cloudflare|resend|seedance|\bR2\b|ep-[\w-]+|(?:sk|ark)-[\w-]+/gi,'仓鼠服务');throw Object.assign(Error(response.status>=500?'仓鼠服务暂不可用，请稍后重试':safe),{statusCode:response.status});}
  return data;
 }
 return {request,upload:(cfg,data,metadata={})=>request(cfg,'/v1/upload',{method:'POST',headers:{'Content-Type':metadata.contentType||'application/octet-stream','Content-Length':String(metadata.contentLength??data?.byteLength)},body:data,duplex:'half'})};
}
const verifyQr=bytes=>crypto.createHash('sha256').update(bytes).digest('hex')===BILLING_QR_SHA256;
module.exports={DEFAULT_BILLING_ENDPOINT,BILLING_QR_SHA256,enabled,createClient,verifyQr};
