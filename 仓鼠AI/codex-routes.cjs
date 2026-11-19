// Local CLI sessions are independent from PIKNO credentials and billing.
const send=(res,status,value)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(value));};
async function read(req){
  if(!/^application\/json(?:;|$)/i.test(req.headers['content-type']||''))throw Object.assign(Error(),{statusCode:415});
  let size=0;const chunks=[];
  for await(const chunk of req){size+=chunk.length;if(size>20000)throw Object.assign(Error(),{statusCode:413});chunks.push(chunk);}
  try{const value=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(!value||Array.isArray(value)||typeof value!=='object')throw Error();return value;}catch{throw Object.assign(Error(),{statusCode:400});}
}
function createCodexRoutes({getClient,chooseDirectory}={}){
  return async function handle(req,res,url){
    if(!/^127\.0\.0\.1:\d+$/.test(req.headers.host||'')||req.headers.origin&&req.headers.origin!==`http://${req.headers.host}`||req.headers['sec-fetch-site']==='cross-site')return send(res,403,{error:'请求来源无效'});
    const route=url.pathname;
    try{
      if(route==='/api/codex/status'&&req.method==='GET')return send(res,200,await getClient().status());
      if(route==='/api/codex/directory'&&req.method==='POST'){
        await read(req);
        if(!chooseDirectory)return send(res,200,{available:false,directory:''});
        const directory=await chooseDirectory();return send(res,200,{available:true,directory:typeof directory==='string'?directory:''});
      }
      if(route==='/api/codex/sessions'){
        if(req.method==='GET')return send(res,200,await getClient().list());
        if(req.method==='POST'){
          const body=await read(req);
          if(Object.keys(body).some(key=>key!=='directory')||typeof body.directory!=='string')return send(res,400,{error:'请选择有效的工程目录'});
          return send(res,201,await getClient().create({directory:body.directory}));
        }
      }
      const match=route.match(/^\/api\/codex\/sessions\/([a-zA-Z0-9-]{1,80})(?:\/(messages|stop))?$/);
      if(match){
        if(!match[2]&&req.method==='GET')return send(res,200,await getClient().get(match[1]));
        if(match[2]&&req.method==='POST'){
          const body=await read(req);
          if(match[2]==='stop')return send(res,200,await getClient().stop(match[1]));
          if(Object.keys(body).some(key=>!['text','requestId'].includes(key))||typeof body.text!=='string'||!body.text.trim()||body.text.length>12000||! /^[a-f0-9-]{16,64}$/i.test(body.requestId||''))return send(res,400,{error:'消息格式不正确'});
          return send(res,202,await getClient().send(match[1],{text:body.text,requestId:body.requestId}));
        }
      }
      send(res,405,{error:'操作不支持'});
    }catch(error){
      const status=[400,404,409,413,415,503].includes(error?.statusCode)?error.statusCode:503;
      const message={400:'请选择有效目录并检查输入',404:'本机会话不存在',409:'本机任务仍在处理中，请先查看原会话状态',413:'消息过长，请缩短后重试',415:'请求格式不支持',503:'本机 Codex 暂不可用，请检查安装与登录状态后重试'}[status];
      send(res,status,{error:message});
    }
  };
}
module.exports={createCodexRoutes};
