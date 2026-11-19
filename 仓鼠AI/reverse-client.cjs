const fs=require('node:fs');
const https=require('node:https');
const dns=require('node:dns').promises;
const net=require('node:net');
const {DEFAULT_PIKNO_ENDPOINT}=require('./pikno-client.cjs');

const failure=(statusCode=502)=>Object.assign(Error('视频分析服务暂时不可用，请查询原任务，勿重复提交'),{statusCode});
function publicAddress(address){
  if(net.isIP(address)===4){
    const [a,b]=address.split('.').map(Number);
    return a>0&&a<224&&a!==10&&a!==127&&!(a===100&&b>=64&&b<=127)&&!(a===169&&b===254)&&!(a===172&&b>=16&&b<=31)&&!(a===192&&(b===168||b===0))&&!(a===198&&(b===18||b===19));
  }
  // Only globally routable unicast IPv6; mapped IPv4 and local ranges fail closed.
  return net.isIP(address)===6&&/^[23][0-9a-f]{3}:/i.test(address);
}
function storageURL(value){
  try{
    const url=new URL(value);
    if(url.protocol!=='https:'||url.username||url.password||url.hash||url.port&&url.port!=='443'||url.href.length>16384||!url.hostname.includes('.')||net.isIP(url.hostname.replace(/^\[|\]$/g,''))||/(?:^|\.)(?:localhost|local|internal|test|invalid)$/i.test(url.hostname))throw failure();
    return url;
  }catch{throw failure();}
}
// HTTPS is pinned to the public DNS answer inspected here. Redirects are never followed.
async function putStorage(value,file,{contentType,size,signal,lookup=dns.lookup}={}){
  const url=storageURL(value),addresses=await lookup(url.hostname,{all:true,verbatim:true});
  if(!addresses.length||addresses.some(item=>!publicAddress(item.address)))throw failure();
  const address=addresses[0];
  return new Promise((resolve,reject)=>{
    const req=https.request(url,{method:'PUT',signal,headers:{'Content-Type':contentType,'Content-Length':String(size)},
      lookup:(_host,options,callback)=>options?.all?callback(null,[address]):callback(null,address.address,address.family)},res=>{
      res.resume();
      res.on('error',()=>reject(failure()));
      res.on('end',()=>res.statusCode>=200&&res.statusCode<300?resolve():reject(failure()));
    });
    req.on('error',()=>reject(failure()));
    const source=fs.createReadStream(file);
    source.on('error',()=>{req.destroy();reject(failure());});
    req.on('close',()=>source.destroy());
    source.pipe(req);
  });
}
async function boundedJSON(response){
  if(!response.body)throw failure();
  const chunks=[];let bytes=0;
  for await(const chunk of response.body){bytes+=chunk.length;if(bytes>1024*1024)throw failure();chunks.push(chunk);}
  try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw failure();}
}
function createReverseClient({endpoint=DEFAULT_PIKNO_ENDPOINT,fetchImpl=fetch,putImpl=putStorage}={}){
  const base=new URL(endpoint);
  if(base.username||base.password||base.search||base.hash||base.pathname!=='/'||!(base.protocol==='https:'||base.protocol==='http:'&&base.hostname==='127.0.0.1'))throw failure(400);
  const controllers=new Set();
  async function request(key,route,body){
    if(typeof key!=='string'||!key.trim())throw failure(401);
    const controller=new AbortController();controllers.add(controller);const timer=setTimeout(()=>controller.abort(),30000);timer.unref?.();
    try{
      const response=await fetchImpl(base.origin+'/v1/reverse'+route,{method:body===undefined?'GET':'POST',redirect:'error',credentials:'omit',signal:controller.signal,
        headers:{Authorization:'Bearer '+key,...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});
      if(!response.ok){
        let value;try{value=await boundedJSON(response);}catch{}
        const error=failure([400,401,402,403,404,409,413,422,429,503].includes(response.status)?response.status:502);
        // Only this audited broker code/state pair proves no billable task was sent.
        if(response.status===402&&value?.error?.code==='reverse_reservation_insufficient'&&value.error.submission_state==='not_submitted'){
          error.code='reverse_reservation_insufficient';error.submissionState='not_submitted';
        }
        throw error;
      }
      return await boundedJSON(response);
    }catch(error){if(error?.statusCode)throw error;throw failure();}finally{clearTimeout(timer);controllers.delete(controller);}
  }
  return {
    capabilities:key=>request(key,'/capabilities'),
    quote:key=>request(key,'/quote'),
    upload:(key,body)=>request(key,'/uploads',body),
    submit:(key,body)=>request(key,'/tasks',body),
    task:(key,id)=>request(key,'/tasks/'+encodeURIComponent(id)),
    operation:(key,id)=>request(key,'/operations/'+encodeURIComponent(id)),
    put:async(ticket,file,metadata)=>{
      const target=storageURL(ticket.upload_url);
      if(ticket.method!=='PUT'||ticket.headers&&Object.keys(ticket.headers).some(key=>key.toLowerCase()!=='content-type')||ticket.headers?.['Content-Type']&&ticket.headers['Content-Type']!==metadata.contentType)throw failure();
      const controller=new AbortController();controllers.add(controller);const timer=setTimeout(()=>controller.abort(),900000);timer.unref?.();
      try{await putImpl(target.href,file,{...metadata,signal:controller.signal});}catch{throw failure();}finally{clearTimeout(timer);controllers.delete(controller);}
    },
    stop:()=>{for(const controller of controllers)controller.abort();controllers.clear();},
  };
}
module.exports={createReverseClient,storageURL,publicAddress,putStorage};
