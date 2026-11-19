const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),zlib=require('node:zlib');
const {extractRuntimeZip}=require(process.env.HAMSTER_QA_ASAR?path.join(process.env.HAMSTER_QA_ASAR,'runtime.cjs'):'../runtime.cjs');
const {createDiagnostics,classifyFailure}=require('../diagnostics.cjs');
function crc32(bytes){let crc=0xffffffff;for(const byte of bytes){crc^=byte;for(let i=0;i<8;i++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}return (crc^0xffffffff)>>>0;}
// Small ZIP fixtures, deliberately allowing malicious names for rejection tests.
function zipEntry(name,text,{mode=0,compressed=true}={}){
  const filename=Buffer.from(name),body=Buffer.from(text),payload=compressed?zlib.deflateRawSync(body):body;
  const local=Buffer.alloc(30),central=Buffer.alloc(46),end=Buffer.alloc(22),method=compressed?8:0,crc=crc32(body);
  local.writeUInt32LE(0x04034b50);local.writeUInt16LE(20,4);local.writeUInt16LE(0x800,6);local.writeUInt16LE(method,8);
  local.writeUInt32LE(crc,14);local.writeUInt32LE(payload.length,18);local.writeUInt32LE(body.length,22);local.writeUInt16LE(filename.length,26);
  central.writeUInt32LE(0x02014b50);central.writeUInt16LE(0x314,4);central.writeUInt16LE(20,6);central.writeUInt16LE(0x800,8);central.writeUInt16LE(method,10);
  central.writeUInt32LE(crc,16);central.writeUInt32LE(payload.length,20);central.writeUInt32LE(body.length,24);central.writeUInt16LE(filename.length,28);central.writeUInt32LE((mode<<16)>>>0,38);
  end.writeUInt32LE(0x06054b50);end.writeUInt16LE(1,8);end.writeUInt16LE(1,10);end.writeUInt32LE(central.length+filename.length,12);end.writeUInt32LE(local.length+filename.length+payload.length,16);
  return Buffer.concat([local,filename,payload,central,filename,end]);
}
function fixture(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'hamster-zip-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root;}
const customerFile='Lib/site-packages/litellm/proxy/guardrails/guardrail_hooks/litellm_content_filter/guardrail_benchmarks/results/block_age_discrimination_-_contentfilter_(age_discrimination.yaml).json';
test('actual customer filename extracts through extended paths over 400 characters including Chinese and spaces',async t=>{
  const root=fixture(t),zip=path.join(root,'测试环境.zip');
  const dest=path.join(root,'中文用户 与空格'.repeat(18),'AppData/Roaming/hamster-ai/runtimes', 'preparing-fixture');
  const target=path.join(dest,customerFile);assert.ok(target.length>400);
  fs.writeFileSync(zip,zipEntry(customerFile,'{"验证":"中文长路径内容完整"}'));
  const progress=[];
  await extractRuntimeZip(zip,dest,undefined,(done,total)=>progress.push([done,total]));
  assert.deepEqual(progress,[[1,1]]);
  assert.equal(fs.readFileSync(path.toNamespacedPath(target),'utf8'),'{"验证":"中文长路径内容完整"}');
});
test('ZIP traversal, absolute paths, NTFS streams and symbolic links cannot escape runtime directory',async t=>{
  const root=fixture(t);
  for(const [index,name,mode] of [[0,'../outside.txt',0],[1,'C:/outside.txt',0],[2,'safe.txt:stream',0],[3,'link',0xa000]]){
    const zip=path.join(root,index+'.zip');fs.writeFileSync(zip,zipEntry(name,'unsafe',{mode}));
    await assert.rejects(extractRuntimeZip(zip,path.join(root,'dest'+index)));
  }
  assert.ok(!fs.existsSync(path.join(root,'outside.txt')));
});
test('unexpected files, duplicate writes and corrupt archive are rejected with readable Chinese diagnostics',async t=>{
  const root=fixture(t),zip=path.join(root,'archive.zip'),dest=path.join(root,'dest');
  fs.writeFileSync(zip,zipEntry('合法文件.txt','内容',{compressed:false}));
  await assert.rejects(extractRuntimeZip(zip,dest,{files:{}}),/不在运行环境清单/);
  await extractRuntimeZip(zip,dest);
  await assert.rejects(extractRuntimeZip(zip,dest),/EEXIST/);
  fs.writeFileSync(zip,'broken');
  const diag=createDiagnostics({dir:path.join(root,'logs'),exportDir:path.join(root,'export')});
  try{await extractRuntimeZip(zip,dest);assert.fail('must reject');}catch(error){
    assert.match(error.message,/内置环境解压失败/);assert.ok(!error.message.includes('\ufffd'));
    assert.equal(classifyFailure(error.message).code,'RUNTIME_EXTRACT_FAILED');
    diag.log('prepare-error',error.message);diag.failure(classifyFailure(error.message));
  }
  const report=JSON.parse(diag.exportReport().content);assert.equal(report.lastFailure.code,'RUNTIME_EXTRACT_FAILED');
  assert.match(JSON.stringify(report.logs),/RUNTIME_EXTRACT_FAILED/);assert.doesNotMatch(JSON.stringify(report.logs),/Traceback|\.exe|\.test/);
});
