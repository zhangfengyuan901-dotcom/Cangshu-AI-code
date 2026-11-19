// Node.js 22+: PIKNO_API_KEY=... node media-edit.mjs reference.png [reference2.jpg ...]
// Paid edit: run only when you intend to generate one image. Never auto-retries.
import {readFile} from 'node:fs/promises';
import {extname} from 'node:path';
const files=process.argv.slice(2),base='https://www.piknoai.com';
if(!process.env.PIKNO_API_KEY || files.length<1 || files.length>5)throw new Error('Set PIKNO_API_KEY and pass 1 to 5 PNG/JPEG/WebP files');
const auth={Authorization:'Bearer '+process.env.PIKNO_API_KEY,'Content-Type':'application/json'};
async function call(path,body){
 const r=await fetch(base+path,{method:'POST',headers:auth,body:JSON.stringify(body),signal:AbortSignal.timeout(600000)});
 const result=await r.json();if(!r.ok)throw new Error(`HTTP ${r.status}: ${result.error?.message||result.error||'Request failed'}`);return result;
}
const images=[];
for(const file of files){
 const type={'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp'}[extname(file).toLowerCase()];
 if(!type)throw new Error('Unsupported image extension');
 const bytes=await readFile(file);if(bytes.length>(30<<20))throw new Error('Image exceeds 30 MiB');
 const ticket=await call('/v1/media/uploads',{content_type:type,size:bytes.length});
 const upload=await fetch(ticket.upload_url,{method:'PUT',headers:ticket.headers,body:bytes,signal:AbortSignal.timeout(120000)});
 if(!upload.ok)throw new Error('Media upload failed: '+upload.status);
 images.push((await call('/v1/media/complete',{upload_ticket:ticket.upload_ticket})).url);
}
const result=await call('/v1/images/edits',{model:'gpt-image-2.5-flare',prompt:process.env.PIKNO_PROMPT||'将参考图中的主色调整为蓝色，保留主体形状和构图。',n:1,size:'1024x1024',quality:'high',response_format:'url',images});
// This prints a private, expiring result link: do not send it to public logs.
console.log(JSON.stringify(result,null,2));
