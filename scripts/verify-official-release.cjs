// Read-only website release verification; never calls business generation APIs.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..'),version=process.argv[2];
assert.match(version||'',/^\d+\.\d+\.\d+$/);
const defaultDir=fs.existsSync(path.join(root,'dist','release-'+version))?'release-'+version:'candidate-'+version;
const artifact=path.resolve(process.argv[3]||path.join(root,'dist',defaultDir,'仓鼠AI-'+version+'-便携版.exe'));
const reportDir=path.join(root,'output','release-'+version);fs.mkdirSync(reportDir,{recursive:true});
const stat=fs.statSync(artifact),local=crypto.createHash('sha256').update(fs.readFileSync(artifact)).digest('hex');
const base='https://hamsterai.cc',url=base+'/download/HamsterAI-Portable-'+version+'.exe';
const get=(target,options={})=>fetch(target,{redirect:'manual',signal:AbortSignal.timeout(240000),...options});
(async()=>{
  const homepage=await get(base+'/');assert.equal(homepage.status,200);const html=await homepage.text();
  assert.ok(html.includes('/download/HamsterAI-Portable-'+version+'.exe'));assert.ok(html.toLowerCase().includes(local));
  const tutorial=await get(base+'/tutorials/');assert.equal(tutorial.status,200);const guide=await tutorial.text();
  for(const phrase of [version,'图片 Key','视频 Key','工具 Key','报价'])assert.ok(guide.includes(phrase),'tutorial missing '+phrase);
  assert.doesNotMatch(guide,/内部候选|name="robots" content="noindex/);
  const head=await get(url,{method:'HEAD'});assert.equal(head.status,200);assert.equal(Number(head.headers.get('content-length')),stat.size);
  const ranged=await get(url,{headers:{Range:'bytes=0-15'}});assert.equal(ranged.status,206);const prefix=Buffer.from(await ranged.arrayBuffer());
  const fd=fs.openSync(artifact,'r'),expected=Buffer.alloc(16);try{fs.readSync(fd,expected,0,16,0);}finally{fs.closeSync(fd);}assert.deepEqual(prefix,expected);
  const full=await get(url);assert.equal(full.status,200);assert.equal(full.headers.get('content-range'),null);
  let bytes=0,last=0;const digest=crypto.createHash('sha256');
  for await(const chunk of full.body){digest.update(chunk);bytes+=chunk.length;if(bytes-last>=32*1024*1024){last=bytes;console.log('download verification bytes='+bytes);}}
  const remote=digest.digest('hex');assert.equal(bytes,stat.size);assert.equal(remote,local);
  const retired={};for(const old of ['1.7.31','1.7.43','1.7.44','1.7.45','1.7.46','1.7.47','1.7.48']){const r=await get(base+'/download/HamsterAI-Portable-'+old+'.exe',{method:'HEAD',headers:{'Cache-Control':'no-cache'}});retired[old]=r.status;assert.equal(r.status,404);}
  const installer=await get(base+'/download/HamsterAI-Setup-'+version+'.exe',{method:'HEAD'});assert.equal(installer.status,404);
  const www=await get('https://www.hamsterai.cc/');assert.equal(www.status,308);assert.equal(www.headers.get('location'),base+'/');
  const result={checkedAt:new Date().toISOString(),version,site:base,download:url,artifactBytes:bytes,sha256:remote,headStatus:head.status,rangeStatus:ranged.status,rangeBytes:prefix.length,rangeMatchesLocalPrefix:true,fullDownloadStatus:full.status,fullDownloadHashMatchesLocal:true,homepageStatus:homepage.status,tutorialStatus:tutorial.status,retiredVersionStatuses:retired,installerDownloadStatus:installer.status,wwwRedirectStatus:www.status,paidGenerationRequests:0,inferenceRequests:0};
  fs.writeFileSync(path.join(reportDir,'http-download-verification.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result,null,2));
})().catch(error=>{console.error(error.message);process.exitCode=1;});
