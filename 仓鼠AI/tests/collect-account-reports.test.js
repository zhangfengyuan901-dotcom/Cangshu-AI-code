const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const {buildQuery,normalizeRows,outputPath,collect}=require('../scripts/collect-account-reports.cjs');
const {workspaceDataDir}=require('../server.js');

test('feedback collection uses a bounded fixed read-only account query',()=>{
  const query=buildQuery({now:2000000000000,days:2,limit:15});
  assert.match(query,/^SELECT payload,created,updated,/);assert.match(query,/updated>=1999827200000/);assert.match(query,/module'\)='account'/);assert.match(query,/LIMIT 15$/);
  assert.doesNotMatch(query,/\b(INSERT|UPDATE|DELETE|DROP|ALTER)\b/i);
  assert.match(buildQuery({now:2000000000000,days:'1; DROP TABLE incidents',limit:'ALL'}),/LIMIT 100$/);
});
test('export removes stored free text, secrets, ids and paths before writing JSON',()=>{
  const rows=normalizeRows(JSON.stringify([{success:true,results:[{payload:JSON.stringify({version:'1.7.54',module:'account',code:'ACCOUNT_CONNECT_FAILED',httpStatus:503,apiKey:'sk-private',message:'private customer text',url:'https://private.test',paymentId:'private',frames:[{file:'account.mjs',line:12,raw:'private'},{file:'C:/private/account.mjs',line:3}]}),created:1000,updated:2000,reports:2,fingerprint:'private'}, {payload:JSON.stringify({module:'chat',code:'AUTH_FAILED'}),created:1000,updated:2000}]}]));
  assert.equal(rows.length,1);assert.equal(rows[0].module,'account');assert.equal(rows[0].reports,2);assert.equal(rows[0].firstSeen,'1970-01-01T00:00:01.000Z');
  assert.deepEqual(rows[0].frames,[{file:'account.mjs',line:12}]);assert.doesNotMatch(JSON.stringify(rows),/private|customer|apiKey|paymentId|fingerprint|message|url/);
  assert.deepEqual(normalizeRows([{results:[{payload:'not json'},{payload:{module:'account',code:'arbitrary'}}]}]),[]);
  assert.throws(()=>normalizeRows([{success:false,errors:['private']}]),/invalid_response/);
});
test('collector requires explicit remote opt-in and confines output to private report exports',()=>{
  assert.throws(()=>collect({}),/remote_opt_in_required/);
  for(const out of ['file.json','D:\\PIKNO\\仓鼠AI\\private.json','D:\\PIKNO\\output\\..\\private.json','D:\\PIKNO\\output\\file.txt'])assert.throws(()=>outputPath(out),/invalid_output/);
});
test('collector invokes an existing CLI without shell, never logs raw response and stores rebuilt metadata',t=>{
  const outputRoot=path.join(workspaceDataDir(),'reports','exports');
  fs.mkdirSync(outputRoot,{recursive:true});
  const dir=fs.mkdtempSync(path.join(outputRoot,'account-feedback-test-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  let calls=0;
  const result=collect({remote:true,out:path.join(dir,'reports.json'),wrangler:__filename,now:2000000000000,run:(cmd,args,options)=>{
    calls++;assert.equal(cmd,process.execPath);assert.equal(args[1],'d1');assert.equal(args[2],'execute');assert.ok(args.includes('--remote'));assert.equal(options.shell,undefined);assert.equal(options.env.CI,'true');assert.equal(options.stdio[0],'ignore');
    return {status:0,stdout:JSON.stringify([{success:true,results:[{payload:JSON.stringify({module:'account',code:'ACCOUNT_KEY_IMPORT_FAILED',token:'sk-private',message:'private customer'}),created:1000,updated:2000,reports:1}]}]),stderr:'private secret'};
  }});
  assert.equal(calls,1);assert.equal(result.count,1);assert.doesNotMatch(fs.readFileSync(result.file,'utf8'),/private|customer|token/);
  assert.throws(()=>collect({remote:true,out:path.join(dir,'failed.json'),wrangler:__filename,run:()=>({status:1,stdout:'sk-private',stderr:'private customer'})}),/^Error: collection_failed$/);
  assert.equal(fs.existsSync(path.join(dir,'failed.json')),false);
});
