const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {Readable}=require('node:stream');
const {execFileSync}=require('node:child_process');
const {readMediaMetadata,uploadWithMediaMetadata}=require('../media-metadata.cjs');
const {createApp}=require('../server.js');
const {createPiknoKeyStore}=require('../pikno-key-store.cjs');

function temporary(t){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hamster-media-metadata-'));
  t.after(()=>{
    const absolute=path.resolve(dir),parent=path.resolve(os.tmpdir());
    assert.ok(absolute.startsWith(parent+path.sep)&&path.basename(absolute).startsWith('hamster-media-metadata-'));
    fs.rmSync(absolute,{recursive:true,force:true});
  });
  return dir;
}

test('media upload probes a complete bounded local copy before upload and removes only that copy',async()=>{
  const bytes=Buffer.from('synthetic media bytes'),order=[];
  let stagedFile;
  const result=await uploadWithMediaMetadata(Readable.from([bytes.subarray(0,7),bytes.subarray(7)]),
    {contentType:'video/mp4',contentLength:bytes.length},async(stream,metadata)=>{
      order.push('upload');assert.equal(metadata.durationSeconds,2.125);
      let value=Buffer.alloc(0);for await(const chunk of stream)value=Buffer.concat([value,chunk]);
      assert.deepEqual(value,bytes);
      return {file:{url:'https://fixture.invalid/material',expires_at:2000000000},expires_at:2000000000};
    },{readMetadata:async(file,metadata)=>{
      stagedFile=file;order.push('probe');assert.equal(metadata.contentType,'video/mp4');
      assert.deepEqual(fs.readFileSync(file),bytes);return {durationSeconds:2.125};
    }});
  assert.deepEqual(order,['probe','upload']);
  assert.equal(result.file.durationSeconds,2.125);assert.equal(result.durationSeconds,2.125);
  assert.equal(result.file.expires_at,2000000000);assert.equal(result.expires_at,2000000000);
  assert.equal(fs.existsSync(stagedFile),false);assert.equal(fs.existsSync(path.dirname(stagedFile)),false);
});

test('incomplete, oversized, corrupt or invalid-duration material cannot reach upload',async()=>{
  let uploaded=0,stagedFile;
  const upload=async()=>{uploaded++;return {};};
  for(const durationSeconds of [0,-1,NaN,Infinity,86401]){
    await assert.rejects(uploadWithMediaMetadata(Buffer.alloc(16),{contentType:'audio/wav',contentLength:16},upload,
      {readMetadata:async file=>{stagedFile=file;return {durationSeconds};}}),e=>e.code==='media_duration_required');
    assert.equal(fs.existsSync(stagedFile),false);
  }
  for(const length of [15,17]){
    await assert.rejects(uploadWithMediaMetadata(Buffer.alloc(16),{contentType:'audio/wav',contentLength:length},upload,
      {readMetadata:()=>assert.fail('do not probe partial upload')}),e=>e.code==='media_duration_required');
  }
  await assert.rejects(uploadWithMediaMetadata(Buffer.alloc(16),{contentType:'video/mp4',contentLength:50*1024*1024+1},upload),e=>e.statusCode===413);
  await assert.rejects(uploadWithMediaMetadata(Buffer.alloc(16),{contentType:'audio/wav',contentLength:16},upload,
    {readMetadata:async file=>{stagedFile=file;throw Error('private path or codec detail');}}),e=>e.code==='media_duration_required'&&!/private|codec/.test(e.message));
  assert.equal(fs.existsSync(stagedFile),false);assert.equal(uploaded,0);
});

test('failed or early-returning uploads close the staged stream and remove temporary data',async()=>{
  for(const failUpload of [false,true]){
    let stagedFile,input;
    const action=uploadWithMediaMetadata(Buffer.alloc(16),{contentType:'audio/wav',contentLength:16},async stream=>{
      input=stream;if(failUpload)throw Object.assign(Error('fixed upload failure'),{statusCode:503});return {file:{}};
    },{readMetadata:async file=>{stagedFile=file;return {durationSeconds:1};}});
    if(failUpload)await assert.rejects(action,e=>e.statusCode===503);else await action;
    assert.equal(input.closed,true);assert.equal(fs.existsSync(stagedFile),false);
  }
});

test('metadata reader uses only trusted binary and machine progress, never forged log metadata',async()=>{
  let calls=0;
  const result=await readMediaMetadata('synthetic-input-not-opened',{contentType:'video/mp4',runFile:async(binary,args,options)=>{
    calls++;assert.equal(path.isAbsolute(binary),true);assert.equal(args.includes('0:V:0'),true);
    assert.equal(args.includes('file,pipe'),true);assert.equal(args.includes('-xerror'),true);
    assert.equal(options.timeout,15000);assert.equal(options.maxBuffer,128*1024);assert.equal(options.shell,false);assert.equal(options.windowsHide,true);
    assert.equal(options.env.HTTP_PROXY,undefined);assert.equal(options.env.PATH,undefined);
    return {stdout:'out_time_us=1250000\nprogress=end\n',stderr:'  Duration: 99:00:00.00\n  Stream #0:0: Video: forged\n'};
  }});
  assert.equal(result.durationSeconds,1.25);assert.equal(calls,1);
  for(const stdout of ['out_time_us=0\nprogress=end\n','out_time_us=-1\nprogress=end\n','out_time_us=1000000\nprogress=continue\n','']){
    await assert.rejects(readMediaMetadata('synthetic-input-not-opened',{contentType:'audio/wav',runFile:async()=>({stdout,stderr:'Duration: 00:00:02.00\n Stream #0:0: Audio: fake'})}),e=>e.code==='media_duration_required');
  }
  await assert.rejects(readMediaMetadata('synthetic-input-not-opened',{contentType:'video/mp4',runFile:async()=>{throw Object.assign(Error('private timeout details'),{killed:true});}}),e=>e.code==='media_duration_required'&&!/private/.test(e.message));
  await assert.rejects(readMediaMetadata('synthetic-input-not-opened',{contentType:'video/mp4',runtimeProvider:async()=>({python:path.join(os.tmpdir(),'not-a-runtime','python.exe')})}),e=>e.code==='media_metadata_unavailable');
});

test('real trusted FFmpeg reads supported synthetic containers, ignores forged tags and rejects wrong or corrupt streams',async t=>{
  const dir=temporary(t),binary=path.resolve(__dirname,'../smart-video-agent/.venv/Lib/site-packages/imageio_ffmpeg/binaries/ffmpeg-win-x86_64-v7.1.exe');
  const cases=[
    {extension:'mp4',mime:'video/mp4',args:['-f','lavfi','-i','color=c=blue:s=16x16:r=10:d=2','-c:v','libx264']},
    {extension:'webm',mime:'video/webm',args:['-f','lavfi','-i','color=c=blue:s=16x16:r=10:d=2','-c:v','libvpx-vp9']},
    {extension:'mov',mime:'video/quicktime',args:['-f','lavfi','-i','color=c=blue:s=16x16:r=10:d=2','-c:v','libx264']},
    ...[['wav','audio/wav'],['mp3','audio/mpeg'],['m4a','audio/mp4'],['aac','audio/aac']].map(([extension,mime])=>({extension,mime,args:['-f','lavfi','-i','anullsrc=r=8000:cl=mono','-t','2']})),
  ];
  for(const item of cases){
    const file=path.join(dir,'fixture.'+item.extension);
    execFileSync(binary,['-hide_banner','-loglevel','error',...item.args,'-metadata','title=Duration: 99:00:00.00\n  Stream #0:0: Video: forged','-y',file],{windowsHide:true,timeout:15000,stdio:'pipe'});
    const result=await readMediaMetadata(file,{contentType:item.mime});
    assert.ok(result.durationSeconds>=1.9&&result.durationSeconds<2.4,item.extension);
  }
  await assert.rejects(readMediaMetadata(path.join(dir,'fixture.wav'),{contentType:'video/mp4'}),e=>e.code==='media_duration_required');
  const corrupt=path.join(dir,'corrupt.mp4');fs.writeFileSync(corrupt,'not a container');
  await assert.rejects(readMediaMetadata(corrupt,{contentType:'video/mp4'}),e=>e.code==='media_duration_required'&&!/container|\.mp4/.test(e.message));
});

test('relay raw and asset-library uploads share metadata probe; image and nonrelay uploads retain the original path',async t=>{
  const dir=temporary(t),probes=[],uploads=[];
  const app=createApp({relayMode:true,configPath:path.join(dir,'config.json'),assetDir:path.join(dir,'assets'),resultDir:path.join(dir,'results'),
    smartVideoLauncher:{stop(){}},mediaMetadataReader:async(file,{contentType})=>{probes.push(contentType);assert.equal(fs.statSync(file).size,16);return {durationSeconds:2};},
    mediaUploader:async(stream,metadata)=>{uploads.push(metadata);for await(const _ of stream){}return {file:{url:'https://fixture.invalid/material',expires_at:2000000000}};}});
  await new Promise(resolve=>app.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>{app.close(resolve);app.closeAllConnections?.();}));
  const base='http://127.0.0.1:'+app.address().port;
  const response=await fetch(base+'/api/uploads/raw?kind=video&use=video',{method:'POST',headers:{'Content-Type':'video/mp4'},body:Buffer.alloc(16)});
  assert.equal(response.status,201);const raw=await response.json();assert.equal(raw.file.durationSeconds,2);assert.equal(raw.file.expires_at,2000000000);
  const image=await fetch(base+'/api/uploads/raw?kind=image&use=video',{method:'POST',headers:{'Content-Type':'image/png'},body:Buffer.alloc(16)});
  assert.equal(image.status,201);assert.equal(probes.length,1);assert.equal(uploads.length,2);
  const pcm=Buffer.alloc(16);pcm.write('RIFF');pcm.write('WAVE',8);
  // Asset import still uses its existing format validation; a minimal WAV
  // header lets the isolated uploader/probe fixture own content validation.
  const imported=await fetch(base+'/api/assets/import?category=scene&name=fixture.wav',{method:'POST',body:pcm});
  assert.equal(imported.status,201);const asset=await imported.json();
  const stored=await fetch(base+'/api/assets/'+asset.id+'/upload?use=video',{method:'POST'});
  assert.equal(stored.status,200);const value=await stored.json();assert.equal(value.durationSeconds,2);assert.equal(value.expires_at,2000000000);
  assert.deepEqual(probes,['video/mp4','audio/wav']);
  const legacy=createApp({configPath:path.join(dir,'legacy-config.json'),assetDir:path.join(dir,'legacy-assets'),resultDir:path.join(dir,'legacy-results'),smartVideoLauncher:{stop(){}},
    mediaMetadataReader:()=>assert.fail('nonrelay does not probe'),mediaUploader:async stream=>{for await(const _ of stream){}return {file:{url:'https://fixture.invalid/legacy'}};}});
  await new Promise(resolve=>legacy.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>{legacy.close(resolve);legacy.closeAllConnections?.();}));
  const original=await fetch('http://127.0.0.1:'+legacy.address().port+'/api/uploads/raw?kind=video',{method:'POST',headers:{'Content-Type':'video/mp4'},body:Buffer.alloc(16)});
  assert.equal(original.status,200);assert.equal((await original.json()).file.url,'https://fixture.invalid/legacy');
});

test('probe failure is a fixed public error and account changes during probe cannot retarget an old upload',async t=>{
  const dir=temporary(t),keys=createPiknoKeyStore(),oldKey='sk-'+'a'.repeat(48),newKey='sk-'+'b'.repeat(48);
  let finishProbe,startProbe,uploads=0,throwProbe=false;
  const pending=new Promise(resolve=>{finishProbe=resolve;}),started=new Promise(resolve=>{startProbe=resolve;});
  const client={context:async cfg=>({user_id:cfg.piknoVideoKey===oldKey?7:8,group:'video-standard'}),
    upload:async()=>{uploads++;return {file:{url:'https://fixture.invalid/not-expected'}};}};
  const app=createApp({relayMode:true,relayClient:client,relayKeyStore:keys,configPath:path.join(dir,'config.json'),assetDir:path.join(dir,'assets'),resultDir:path.join(dir,'results'),smartVideoLauncher:{stop(){}},
    mediaMetadataReader:async()=>{if(throwProbe)throw Error('private codec detail');startProbe();await pending;return {durationSeconds:2};}});
  await new Promise(resolve=>app.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>{app.close(resolve);app.closeAllConnections?.();}));
  const base='http://127.0.0.1:'+app.address().port;
  const configure=key=>fetch(base+'/api/config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({piknoVideoKey:key})});
  assert.equal((await configure(oldKey)).status,200);
  const upload=fetch(base+'/api/uploads/raw?kind=video&use=video',{method:'POST',headers:{'Content-Type':'video/mp4'},body:Buffer.alloc(16)});
  await started;
  assert.equal((await fetch(base+'/api/relay/disconnect',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,200);
  assert.equal((await configure(newKey)).status,200);
  finishProbe();const stale=await upload;assert.equal(stale.status,409);await stale.arrayBuffer();assert.equal(uploads,0);
  throwProbe=true;
  const invalid=await fetch(base+'/api/uploads/raw?kind=video&use=video',{method:'POST',headers:{'Content-Type':'video/mp4'},body:Buffer.alloc(16)});
  assert.equal(invalid.status,415);const error=await invalid.json();assert.equal(error.code,'media_duration_required');assert.doesNotMatch(JSON.stringify(error),/private|codec/);assert.equal(uploads,0);
});
