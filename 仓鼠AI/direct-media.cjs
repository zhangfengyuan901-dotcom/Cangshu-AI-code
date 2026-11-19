const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const crypto=require('node:crypto');
const {Readable,Transform}=require('node:stream');
const {pipeline}=require('node:stream/promises');

const LOCAL_ORIGIN='https://local.hamster.invalid';
const MAX_IMAGE_BYTES=30*1024*1024;
const MAX_INPUT_BYTES=20*MAX_IMAGE_BYTES+1024*1024;
const failed=(message,statusCode=400)=>Object.assign(Error(message),{statusCode});
function imageMime(bytes){
  if(bytes.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex')))return 'image/png';
  if(bytes[0]===255&&bytes[1]===216&&bytes[2]===255)return 'image/jpeg';
  if(bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP')return 'image/webp';
  return '';
}
function localMediaID(value){
  try{
    const url=new URL(value);
    if(url.origin===LOCAL_ORIGIN&&!url.username&&!url.password&&!url.search&&!url.hash)return /^\/direct-media\/([a-f0-9]{32})$/.exec(url.pathname)?.[1]||'';
  }catch{}
  return '';
}
function decodeInlineImage(value){
  if(typeof value!=='string'||value.length>Math.ceil((16<<20)/3)*4||!value.length||value.length%4||!/^[A-Za-z0-9+/]*={0,2}$/.test(value))throw failed('图片结果格式无效',502);
  const bytes=Buffer.from(value,'base64'),mime=imageMime(bytes);
  if(!mime||bytes.length<12||bytes.length>16<<20||bytes.toString('base64')!==value)throw failed('图片结果格式无效',502);
  return {bytes,mime};
}
function directResultURL(value,kind){
  let url;
  try{url=new URL(value);}catch{throw failed('生成结果地址暂不可用',502);}
  const hosts=kind==='image'?['external-resources.packyapi.ai']:['rh-images-1252422369.cos.ap-beijing.myqcloud.com','rh-comfyui01.tos-cn-beijing.volces.com'];
  if(typeof value!=='string'||value.length>32768||url.protocol!=='https:'||!hosts.includes(url.hostname)||url.username||url.password||url.port||url.hash||!value.toLowerCase().startsWith('https://'+url.hostname+'/')||kind==='image'&&!/^\/file_download\/[A-Za-z0-9_-]+$/.test(url.pathname))throw failed('生成结果地址暂不可用',502);
  return url.href;
}
function createDirectMedia({now=Date.now}={}){
  let directory;
  const records=new Map();
  const receipt=(id,expires_at)=>{const url=LOCAL_ORIGIN+'/direct-media/'+id;return {file:{url,expires_at},url,expires_at};};
  function sweep(){
    for(const [id,item] of records)if(item.expires_at*1000<=now()){
      try{fs.unlinkSync(item.file);}catch{}
      records.delete(id);
    }
  }
  async function stage(data,{contentType,contentLength,user,revision}){
    sweep();
    if(!Number.isSafeInteger(user)||user<1)throw failed('请先配置当前账户的图片 Key',401);
    if(!['image/png','image/jpeg','image/webp'].includes(contentType))throw failed('请使用 PNG、JPG 或 WEBP 图片',415);
    if(!Number.isSafeInteger(contentLength)||contentLength<12||contentLength>MAX_IMAGE_BYTES)throw failed('图片最大支持30MB',413);
    directory??=fs.mkdtempSync(path.join(os.tmpdir(),'hamster-direct-images-'));
    const id=crypto.randomBytes(16).toString('hex'),file=path.join(directory,id),temp=file+'.part';
    let length=0,signature=Buffer.alloc(0);
    const checksum=crypto.createHash('sha256');
    const checked=new Transform({transform(chunk,_encoding,done){
      length+=chunk.length;
      if(length>contentLength){done(failed('图片文件大小不匹配',413));return;}
      if(signature.length<12)signature=Buffer.concat([signature,chunk.subarray(0,12-signature.length)]);
      checksum.update(chunk);
      done(null,chunk);
    }});
    try{
      await pipeline(Buffer.isBuffer(data)?Readable.from([data]):data,checked,fs.createWriteStream(temp,{flags:'wx',mode:0o600}));
      if(length!==contentLength||imageMime(signature)!==contentType)throw failed('图片内容与格式不匹配',415);
      const hash=checksum.digest('hex');
      for(const [existingId,item] of records){
        if(item.user===user&&item.revision===String(revision??'')&&item.mime===contentType&&item.size===length&&item.hash===hash&&item.expires_at*1000>now()+60000){
          let stat;try{stat=fs.lstatSync(item.file);}catch{}
          if(stat?.isFile()&&!stat.isSymbolicLink()&&stat.size===length){fs.unlinkSync(temp);return receipt(existingId,item.expires_at);}
        }
      }
      if(records.size>=128)throw failed('待提交图片过多，请完成当前任务后重试',429);
      fs.renameSync(temp,file);
      const expires_at=Math.floor(now()/1000)+86400;
      records.set(id,{file,user,revision:String(revision??''),mime:contentType,size:length,hash,expires_at});
      return receipt(id,expires_at);
    }catch(error){try{fs.unlinkSync(temp);}catch{}throw error.statusCode?error:failed('本地参考图片保存未完成，请重新选择',503);}
  }
  function get(value,{user,revision}={}){
    sweep();
    const record=records.get(localMediaID(value));
    if(!record||record.user!==user||record.revision!==String(revision??'')||record.expires_at*1000<=now()+60000)throw failed('参考图片已失效，请重新选择当前账户的图片',409);
    let stat;try{stat=fs.lstatSync(record.file);}catch{}
    if(!stat?.isFile()||stat.isSymbolicLink()||stat.size!==record.size)throw failed('参考图片不可读取，请重新选择',409);
    return record;
  }
  function multipart(fields,images,context){
    const files=images.map(item=>get(typeof item==='string'?item:item.url,context));
    const boundary='hamster-'+crypto.randomBytes(18).toString('hex');
    const parts=Object.entries(fields).map(([key,value])=>Buffer.from('--'+boundary+'\r\nContent-Disposition: form-data; name="'+key+'"\r\n\r\n'+value+'\r\n'));
    const prefixes=files.map((file,index)=>Buffer.from('--'+boundary+'\r\nContent-Disposition: form-data; name="'+(files.length===1?'image':'image[]')+'"; filename="reference-'+(index+1)+'.'+({'image/png':'png','image/jpeg':'jpg','image/webp':'webp'}[file.mime])+'"\r\nContent-Type: '+file.mime+'\r\n\r\n'));
    const suffix=Buffer.from('--'+boundary+'--\r\n');
    const length=parts.reduce((n,p)=>n+p.length,0)+files.reduce((n,file,index)=>n+prefixes[index].length+file.size+2,0)+suffix.length;
    if(length>MAX_INPUT_BYTES)throw failed('本次参考图片合计过大，请减少图片或压缩后重试',413);
    async function* body(){
      yield* parts;
      for(let index=0;index<files.length;index++){
        yield prefixes[index];
        yield* fs.createReadStream(files[index].file);
        yield Buffer.from('\r\n');
      }
      yield suffix;
    }
    return {headers:{'Content-Type':'multipart/form-data; boundary='+boundary,'Content-Length':String(length)},body:Readable.from(body()),duplex:'half'};
  }
  function close(){
    for(const item of records.values())try{fs.unlinkSync(item.file);}catch{}
    records.clear();
    if(directory)try{fs.rmdirSync(directory);}catch{}
  }
  return {stage,get,multipart,close};
}
module.exports={createDirectMedia,imageMime,localMediaID,decodeInlineImage,directResultURL};
