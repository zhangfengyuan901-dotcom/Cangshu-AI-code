const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {EventEmitter}=require('node:events');
const {test}=require('node:test');
const {createWorkDirectory,bindWorkDirectory,findResultFile,STATUS,CHOOSE}=require('../electron/work-directory.cjs');
const {createAssets}=require('../assets.cjs');
const {createTasks}=require('../tasks.cjs');

function fixture(t) {
  const temp=fs.realpathSync(os.tmpdir());
  const root=fs.mkdtempSync(path.join(temp,'hamster-work-directory-'));
  t.after(()=>{
    const resolved=fs.realpathSync(root);
    assert.equal(path.dirname(resolved),temp);
    assert.match(path.basename(resolved),/^hamster-work-directory-/);
    fs.rmSync(resolved,{recursive:true,force:true});
  });
  const add=part=>{const target=path.join(root,part);fs.mkdirSync(target,{recursive:true});return target;};
  const options={userData:add('profile'),defaultDirectory:add('desktop'),protectedDirectories:[add('application')]};
  return {root,add,options,open:()=>createWorkDirectory(options)};
}

test('choosing changes future writes after restart while retaining each prior location',async t=>{
  const f=fixture(t),first=f.open(),selected=f.add('first works'),next=f.add('second works');
  const priorResult=first.resultDir,priorAssets=first.assetDir;
  const pending=await first.choose(selected);
  assert.deepEqual(pending,{ok:true,activeDirectory:f.options.defaultDirectory,nextDirectory:selected,restartRequired:true,unavailable:false});
  assert.equal(first.resultDir,priorResult);
  const second=f.open();
  assert.deepEqual(second.status(),{ok:true,activeDirectory:selected,nextDirectory:selected,restartRequired:false,unavailable:false});
  assert.deepEqual(second.resultReadDirs,[priorResult]);
  assert.deepEqual(second.assetReadDirs,[priorAssets]);
  await second.choose(next);
  const third=f.open();
  assert.equal(third.status().activeDirectory,next);
  assert.ok(third.resultReadDirs.includes(second.resultDir));
  assert.ok(third.assetReadDirs.includes(second.assetDir));
  fs.renameSync(next,next+' offline');
  const fallback=f.open();
  assert.equal(fallback.status().activeDirectory,f.options.defaultDirectory);
  assert.equal(fallback.status().unavailable,true);
  assert.ok(fallback.resultReadDirs.includes(third.resultDir));
  assert.ok(fallback.assetReadDirs.includes(second.assetDir));
});

test('a selection cannot write inside the install or profile tree, including junctions',async t=>{
  const f=fixture(t),store=f.open();
  const installed=f.options.protectedDirectories[0];
  await assert.rejects(store.choose(installed));
  await assert.rejects(store.choose(f.options.userData));
  const alias=path.join(f.root,'link to install');
  const linkType=process.platform==='win32'?'junction':'dir';
  fs.symlinkSync(installed,alias,linkType);
  await assert.rejects(store.choose(alias));
  const parent=f.add('outside'),subfolder=path.join(parent,'仓鼠AI生成结果');
  fs.symlinkSync(installed,subfolder,linkType);
  await assert.rejects(store.choose(parent));
  const dangerousParent=f.add('near install'),nestedInstall=f.add('near install/仓鼠AI资产库/bin');
  const unsafe=createWorkDirectory({...f.options,protectedDirectories:[nestedInstall]});
  await assert.rejects(unsafe.choose(dangerousParent));
  assert.deepEqual(fs.readdirSync(installed),[]);
  assert.equal(store.status().restartRequired,false);
});

test('historical asset IDs, historical results and new imports remain usable together',async t=>{
  const f=fixture(t),old=f.open();
  const png=Buffer.from('89504e470d0a1a0a0000','hex');
  const oldAssets=createAssets(old.assetDir,old.resultDir);
  const existing=oldAssets.add('scene','old.png',png,'png');
  const video=oldAssets.add('scene','old.mp4',Buffer.from('00000010667479706d703432','hex'),'mp4');
  fs.mkdirSync(old.resultDir);
  const key='a'.repeat(32),local=path.join(old.resultDir,'old.png');
  fs.writeFileSync(local,png);
  const journals=f.add('profile/task-history');
  fs.writeFileSync(path.join(journals,key+'.json'),JSON.stringify({key,id:'synthetic',status:'succeeded',type:'image',result:{local_path:local}}));
  await old.choose(f.add('works'));
  const current=f.open();
  const assets=createAssets(current.assetDir,current.resultDir,undefined,undefined,current);
  const tasks=createTasks({dir:journals,resultDir:current.resultDir,resultReadDirs:current.resultReadDirs,getKey:()=>''});
  t.after(()=>tasks.stop());
  assert.equal(tasks.list()[0].result.local_url,'/api/tasks/'+key+'/file');
  assert.deepEqual(fs.readFileSync(assets.file(assets.get(existing.id))),png);
  assert.equal(assets.setDuration(video.id,4).durationSeconds,4);
  assert.equal(oldAssets.get(video.id).durationSeconds,4);
  const added=assets.importTask(tasks.list()[0]);
  assert.ok(path.relative(current.assetDir,assets.file(added)).startsWith('场景'+path.sep));
  assert.equal(assets.summary().total,3);
  assert.equal(findResultFile(path.join(f.root,'unrelated.png'),[current.resultDir,...current.resultReadDirs]),'');
  assert.equal(fs.existsSync(local),true);
});

test('a disconnected retained directory does not trigger a new result download',async t=>{
  const f=fixture(t),old=f.open(),first=f.add('old works'),next=f.add('new works');
  await old.choose(first);
  const previous=f.open(),key='b'.repeat(32),local=path.join(previous.resultDir,'old.png');
  fs.writeFileSync(local,Buffer.from('previous result'));
  const journals=f.add('profile/task-history');
  const record=path.join(journals,key+'.json');
  fs.writeFileSync(record,JSON.stringify({key,id:'synthetic',status:'succeeded',type:'image',result:{local_path:local,download_url:'https://synthetic.invalid/old.png'}}));
  await previous.choose(next);
  fs.renameSync(first,first+' offline');
  const current=f.open();
  let fetches=0;
  const tasks=createTasks({dir:journals,resultDir:current.resultDir,resultReadDirs:current.resultReadDirs,getKey:()=>'',tickMs:10,
    fetchImpl:async()=>{fetches++;throw new Error('Unexpected fetch');}});
  t.after(()=>tasks.stop());
  tasks.start();
  await new Promise(resolve=>setTimeout(resolve,40));
  assert.equal(fetches,0);
  assert.equal(JSON.parse(fs.readFileSync(record,'utf8')).result.local_path,local);
  fs.renameSync(first+' offline',first);
  assert.equal(tasks.list()[0].result.local_url,'/api/tasks/'+key+'/file');
});

test('only the exact top frame can select a directory and a closed window releases the handlers',async t=>{
  const f=fixture(t),store=f.open(),target=f.add('works');
  const appUrl='http://127.0.0.1:18374/';
  const mainFrame={url:appUrl},contents={mainFrame,getURL:()=>mainFrame.url,isDestroyed:()=>false};
  const window=Object.assign(new EventEmitter(),{webContents:contents,isDestroyed:()=>false});
  const handlers=new Map();
  let opened=0;
  const dialog={async showOpenDialog(_parent,{properties}){assert.ok(properties.includes('openDirectory'));opened++;return {canceled:false,filePaths:[target]};}};
  bindWorkDirectory({window,ipcMain:{handle:(name,action)=>handlers.set(name,action),removeHandler:name=>handlers.delete(name)},dialog,appUrl,store});
  const trusted={sender:contents,senderFrame:mainFrame};
  const iframe={sender:contents,senderFrame:{url:appUrl}};
  assert.deepEqual(await handlers.get(CHOOSE)(iframe),{ok:false,code:'FORBIDDEN'});
  assert.deepEqual(await handlers.get(STATUS)(iframe),{ok:false,code:'FORBIDDEN'});
  assert.equal(opened,0);
  assert.equal((await handlers.get(STATUS)(trusted)).restartRequired,false);
  assert.equal((await handlers.get(CHOOSE)(trusted)).restartRequired,true);
  assert.equal(opened,1);
  mainFrame.url=appUrl+'elsewhere';
  assert.deepEqual(await handlers.get(STATUS)(trusted),{ok:false,code:'FORBIDDEN'});
  window.emit('closed');
  assert.equal(handlers.size,0);
});
