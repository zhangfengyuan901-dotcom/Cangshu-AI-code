const fs=require('node:fs');
const fail=(message='无法确认视频格式或时长，请选择有效的视频文件')=>Object.assign(Error(message),{statusCode:415,code:'reverse_invalid_video'});
function boxes(buffer,start=0,end=buffer.length){
  const result=[];let offset=start;
  while(offset+8<=end){
    let size=buffer.readUInt32BE(offset),head=8;
    if(size===1){if(offset+16>end)throw fail();const n=buffer.readBigUInt64BE(offset+8);if(n>BigInt(Number.MAX_SAFE_INTEGER))throw fail();size=Number(n);head=16;}
    if(size===0)size=end-offset;
    if(size<head||offset+size>end)throw fail();
    result.push({type:buffer.toString('ascii',offset+4,offset+8),start:offset+head,end:offset+size});offset+=size;
  }
  if(offset!==end)throw fail();return result;
}
function mp4Metadata(file,length){
  const fd=fs.openSync(file,'r');let position=0,moov,ftyp=false;
  try{
    while(position+8<=length){
      const header=Buffer.alloc(16);if(fs.readSync(fd,header,0,Math.min(16,length-position),position)<8)throw fail();
      let size=header.readUInt32BE(0),head=8;
      if(size===1){if(position+16>length)throw fail();const n=header.readBigUInt64BE(8);if(n>BigInt(Number.MAX_SAFE_INTEGER))throw fail();size=Number(n);head=16;}
      if(size===0)size=length-position;
      if(size<head||position+size>length)throw fail();
      const type=header.toString('ascii',4,8);
      if(type==='ftyp'&&size>=16)ftyp=true;
      if(type==='moov'){
        if(size-head>16*1024*1024)throw fail();moov=Buffer.alloc(size-head);if(fs.readSync(fd,moov,0,moov.length,position+head)!==moov.length)throw fail();
      }
      position+=size;
    }
    if(position!==length||!moov)throw fail();
    const children=boxes(moov),mvhd=children.find(box=>box.type==='mvhd');
    if(!mvhd)throw fail();const version=moov[mvhd.start],offset=mvhd.start+(version===1?20:12);
    if(![0,1].includes(version)||offset+(version===1?12:8)>mvhd.end)throw fail();
    const scale=moov.readUInt32BE(offset),ticks=version===1?Number(moov.readBigUInt64BE(offset+4)):moov.readUInt32BE(offset+4);
    let video=false;
    for(const track of children.filter(box=>box.type==='trak'))for(const mdia of boxes(moov,track.start,track.end).filter(box=>box.type==='mdia')){
      const handler=boxes(moov,mdia.start,mdia.end).find(box=>box.type==='hdlr');
      if(handler&&handler.start+12<=handler.end&&moov.toString('ascii',handler.start+8,handler.start+12)==='vide')video=true;
    }
    if(!video||!scale)throw fail();return {duration:ticks/scale,content_type:ftyp?'video/mp4':'video/quicktime'};
  }finally{fs.closeSync(fd);}
}
function vint(buffer,offset,id=false){
  if(offset>=buffer.length)throw fail();let length=1,mask=128;
  while(length<=8&&!(buffer[offset]&mask)){length++;mask>>=1;}
  if(length>8||offset+length>buffer.length||id&&length>4)throw fail();
  let value=id?buffer[offset]:buffer[offset]&(mask-1);for(let i=1;i<length;i++)value=value*256+buffer[offset+i];
  return {length,value,unknown:!id&&value===2**(7*length)-1};
}
function webmMetadata(file,length){
  const fd=fs.openSync(file,'r'),buffer=Buffer.alloc(Math.min(length,8*1024*1024));
  try{fs.readSync(fd,buffer,0,buffer.length,0);}finally{fs.closeSync(fd);}
  let scale=1000000,duration,video=false,docType=false;
  const parse=(start,end,depth=0)=>{
    if(depth>8)throw fail();let position=start;
    while(position<end){
      const id=vint(buffer,position,true),size=vint(buffer,position+id.length),data=position+id.length+size.length;
      const next=size.unknown?end:data+size.value;
      if(next>end){if(id.value===0x18538067){parse(data,end,depth+1);return;}break;}
      if([0x1A45DFA3,0x18538067,0x1549A966,0x1654AE6B,0xAE].includes(id.value))parse(data,next,depth+1);
      else if(id.value===0x4282)docType=buffer.toString('ascii',data,next)==='webm';
      else if(id.value===0x2AD7B1&&size.value>=1&&size.value<=8){scale=0;for(let i=data;i<next;i++)scale=scale*256+buffer[i];}
      else if(id.value===0x4489){if(size.value===4)duration=buffer.readFloatBE(data);else if(size.value===8)duration=buffer.readDoubleBE(data);}
      else if(id.value===0x83&&size.value===1&&buffer[data]===1)video=true;
      position=next;
    }
  };
  if(buffer.readUInt32BE(0)!==0x1A45DFA3)throw fail();parse(0,buffer.length);
  if(!docType||!video||!Number.isFinite(duration))throw fail();return {duration:duration*scale/1e9,content_type:'video/webm'};
}
function validateReverseVideo(file,{contentType,contentLength,maxBytes=500*1024*1024,maxSeconds=600}={}){
  try{
    const length=fs.statSync(file).size;
    if(!Number.isSafeInteger(length)||length<16||length>maxBytes||length!==contentLength)throw fail('视频大小不符合要求');
    const fd=fs.openSync(file,'r'),header=Buffer.alloc(16);try{fs.readSync(fd,header,0,16,0);}finally{fs.closeSync(fd);}
    const metadata=header.readUInt32BE(0)===0x1A45DFA3?webmMetadata(file,length):mp4Metadata(file,length);
    if(!Number.isFinite(metadata.duration)||metadata.duration<=0||metadata.duration>maxSeconds)throw fail('视频时长须在10分钟以内');
    if(metadata.content_type==='video/webm'?contentType!=='video/webm':!['video/mp4','video/quicktime','video/x-m4v'].includes(contentType))throw fail();
    return {content_type:contentType,duration_seconds:metadata.duration,size_bytes:length};
  }catch(error){if(error?.code==='reverse_invalid_video')throw error;throw fail();}
}
module.exports={validateReverseVideo};
