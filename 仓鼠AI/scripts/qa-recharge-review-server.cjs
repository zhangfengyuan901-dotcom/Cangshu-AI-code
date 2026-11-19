// Static admin UI only. No production API, email or payment access.
const http=require('node:http'),fs=require('node:fs'),path=require('node:path');
const root=path.resolve('cloudflare/billing-worker/public');
http.createServer((req,res)=>{
 const name=new URL(req.url,'http://localhost').pathname;
 if(!['/','/admin.js','/admin.css','/favicon.svg'].includes(name)){res.writeHead(404);return res.end();}
 const file=path.join(root,name==='/'?'index.html':name.slice(1));
 res.setHeader('Content-Type',({'/':'text/html','/admin.js':'application/javascript','/admin.css':'text/css','/favicon.svg':'image/svg+xml'})[name]);
 fs.createReadStream(file).pipe(res);
}).listen(8792,'127.0.0.1',()=>console.log('Offline admin UI http://127.0.0.1:8792'));
