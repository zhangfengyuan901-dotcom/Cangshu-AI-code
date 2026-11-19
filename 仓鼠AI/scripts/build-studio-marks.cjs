// Reuse the existing encoded PNG frames; no pixel resampling or artwork changes.
const fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..'),source=fs.readFileSync(path.join(root,'build/icon.ico'));
if(source.readUInt16LE(0)!==0||source.readUInt16LE(2)!==1)throw Error('Invalid application icon');
const entries=[];
for(let i=0;i<source.readUInt16LE(4);i++){
  const at=6+i*16,size=source.readUInt32LE(at+8),offset=source.readUInt32LE(at+12);
  entries.push({width:source[at]||256,height:source[at+1]||256,bytes:source.subarray(offset,offset+size)});
}
for(const [size,targets] of [[32,['public/studio-favicon.png']],[128,['public/hamster-mark.png','smart-video-agent/studio-ui/hamster-mark.png']]]){
  const frame=entries.find(entry=>entry.width===size&&entry.height===size);
  if(!frame||!frame.bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))throw Error('Missing existing PNG frame');
  for(const target of targets){
    const file=path.join(root,target);
    if(process.argv.includes('--check')){if(!fs.existsSync(file)||!fs.readFileSync(file).equals(frame.bytes))throw Error('Outdated studio mark: '+target);}
    else fs.writeFileSync(file,frame.bytes);
    console.log(`${target}: ${frame.bytes.length} bytes (${size}x${size})`);
  }
}
