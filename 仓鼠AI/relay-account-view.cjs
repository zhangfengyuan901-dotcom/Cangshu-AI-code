// Local UI control only. Remote account credentials never pass through this API.
const PREFIX='/api/relay/account-view/';
const emptyState={available:false,visible:false,state:'closed'};
function publicState(value){return {available:value?.available===true,visible:value?.visible===true,state:['closed','loading','ready','error'].includes(value?.state)?value.state:'closed'};}
function validBounds(value){return value&&Object.keys(value).length===4&&['x','y','width','height'].every(key=>Number.isFinite(value[key])&&value[key]>=(['width','height'].includes(key)?1:0)&&value[key]<=16384);}
function createAccountViewRoutes({view}={}){
  return async(req,res,url)=>{
    const reply=(status,value)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(value));};
    const action=url.pathname.slice(PREFIX.length);
    if(!/^127\.0\.0\.1:\d+$/.test(req.headers.host||'')||req.headers.origin&&req.headers.origin!==`http://${req.headers.host}`||req.headers['sec-fetch-site']==='cross-site')return reply(403,{error:'请求来源无效'});
    if(url.search||!['state','open','bounds','close','reload'].includes(action))return reply(404,{error:'操作不存在'});
    if(req.method!==(action==='state'?'GET':'POST'))return reply(405,{error:'操作不支持'});
    try{
      if(action==='state')return reply(200,publicState(view?.state?.()||emptyState));
      if(!req.headers['content-type']?.startsWith('application/json'))return reply(415,{error:'请求格式无效'});
      let size=0;const chunks=[];
      for await(const chunk of req){size+=chunk.length;if(size>1024)return reply(413,{error:'请求过大'});chunks.push(chunk);}
      let body;try{body=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{return reply(400,{error:'请求格式无效'});}
      if(!body||Array.isArray(body)||typeof body!=='object'||(['open','bounds'].includes(action)?!validBounds(body):Object.keys(body).length!==0))return reply(400,{error:'显示区域无效'});
      if(!view||view.state().available!==true)return reply(409,emptyState);
      const result=await view[action](body);
      return reply(200,{ok:true,...publicState(result||view.state())});
    }catch{return reply(503,{error:'账户页面未能打开，请重试',...publicState(view?.state?.()||emptyState)});}
  };
}
module.exports={createAccountViewRoutes,validBounds,publicState};
