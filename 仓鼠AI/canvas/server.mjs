import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Readable} from 'node:stream';
const root=path.join(path.dirname(fileURLToPath(import.meta.url)),'dist');
const upstream=new URL(process.env.HAMSTER_CANVAS_API);
const token=process.env.HAMSTER_CANVAS_TOKEN;
const instance=process.env.HAMSTER_CANVAS_INSTANCE;
if(!token||!instance||upstream.protocol!=='http:'||upstream.hostname!=='127.0.0.1'||!upstream.port||upstream.username||upstream.password||upstream.pathname!=='/'||upstream.search||upstream.hash)throw Error('Missing local canvas configuration');
const types={'.html':'text/html; charset=utf-8','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.txt':'text/plain; charset=utf-8','.woff2':'font/woff2','.ttf':'font/ttf'};
const server=http.createServer(async(req,res)=>{
  res.setHeader('Content-Security-Policy',`base-uri 'self'; object-src 'none'; frame-ancestors ${upstream.origin}`);
  res.setHeader('Cache-Control','no-store');
  res.setHeader('Referrer-Policy','no-referrer');
  try{
    if(req.headers.host!==`127.0.0.1:${server.address().port}`){res.writeHead(403);res.end();return;}
    const url=new URL(req.url,'http://'+req.headers.host);
    if(req.headers.origin&&req.headers.origin!==url.origin){res.writeHead(403);res.end();return;}
    if(url.pathname==='/health'&&req.method==='GET'){res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({app:'hamster-canvas',version:1,instance}));return;}
    if(url.searchParams.get('token')===token){res.setHeader('Set-Cookie',`hamster_canvas=${token}; HttpOnly; SameSite=Strict; Path=/`);res.writeHead(302,{Location:'/'+(url.searchParams.has('project')?'?project='+encodeURIComponent(url.searchParams.get('project')):''),'Referrer-Policy':'no-referrer'});res.end();return;}
    if(!(req.headers.cookie||'').split(';').some(c=>c.trim()===`hamster_canvas=${token}`)){res.writeHead(403);res.end('请从仓鼠AI 左侧栏打开创作画布');return;}
    if(url.pathname.startsWith('/api/')){
      const allowed=/^\/api\/(canvas\/|error-report$|assets(?:\/|$)|tasks(?:\/|$)|models$|low-cost\/models$|startup$)/.test(url.pathname)||(['/api/uploads/status','/api/relay/state','/api/relay/connection','/api/relay/catalog/events'].includes(url.pathname)&&req.method==='GET');
      if(!allowed){res.writeHead(404);res.end();return;}
      const headers={};for(const name of ['content-type','range','content-length'])if(req.headers[name])headers[name]=req.headers[name];
      const events=url.pathname==='/api/relay/catalog/events',controller=events?new AbortController():null;
      if(controller)res.once('close',()=>controller.abort());
      const result=await fetch(new URL(url.pathname+url.search,upstream),{method:req.method,headers,...(!['GET','HEAD'].includes(req.method)?{body:req,duplex:'half'}:{}),signal:controller?.signal||AbortSignal.timeout(240000)});
      for(const name of ['content-type','content-range','accept-ranges'])if(result.headers.has(name))res.setHeader(name,result.headers.get(name));
      res.writeHead(result.status);if(events)res.flushHeaders();if(result.body){const body=Readable.fromWeb(result.body);body.once('error',()=>res.destroy());body.pipe(res);}else res.end();return;
    }
    const target=path.resolve(root,'.'+decodeURIComponent(url.pathname==='/'?'/index.html':url.pathname));
    if(!target.startsWith(root+path.sep)||!fs.existsSync(target)||!fs.statSync(target).isFile()){res.writeHead(404);res.end();return;}
    res.writeHead(200,{'Content-Type':types[path.extname(target)]||'application/octet-stream','Referrer-Policy':'no-referrer'});fs.createReadStream(target).pipe(res);
  }catch{if(!res.headersSent)res.writeHead(502,{'Content-Type':'application/json'});res.end(JSON.stringify({error:'本地服务连接中断，请保持仓鼠AI 开启'}));}
});
// The owned child cannot outlive a closed or crashed desktop process.
process.on('disconnect',()=>{server.close();server.closeAllConnections();});
server.listen(0,'127.0.0.1',()=>console.log('HAMSTER_CANVAS_READY:'+server.address().port));
