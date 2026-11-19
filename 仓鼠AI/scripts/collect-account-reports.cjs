const fs=require('node:fs');
const path=require('node:path');
const {spawnSync}=require('node:child_process');
const {normalizeReport,ACCOUNT_CODES}=require('../report-schema.cjs');
const {workspaceDataDir}=require('../server.js');
const PROJECT=path.resolve(__dirname,'..');
const OUTPUT=path.join(workspaceDataDir(),'reports','exports');
const CONFIG=path.join(PROJECT,'cloudflare','report-worker','wrangler.jsonc');

function bounded(value,min,max,fallback){return Number.isSafeInteger(value)&&value>=min&&value<=max?value:fallback;}
function buildQuery({now=Date.now(),days=7,limit=100}={}){
  const since=bounded(now,0,8640000000000000,0)-bounded(days,1,30,7)*86400000;
  const count=bounded(limit,1,200,100);
  // Fixed read-only query. No SQL or database identity is accepted from arguments.
  return `SELECT payload,created,updated,(SELECT COUNT(*) FROM receipts WHERE receipts.fingerprint=incidents.fingerprint) AS reports FROM incidents WHERE updated>=${Math.max(0,since)} AND json_extract(payload,'$.module')='account' ORDER BY updated DESC LIMIT ${count}`;
}
function normalizeRows(raw){
  const parsed=typeof raw==='string'?JSON.parse(raw):raw;
  if(!Array.isArray(parsed)||parsed.some(item=>item?.success===false))throw Error('invalid_response');
  const rows=parsed.flatMap(item=>Array.isArray(item?.results)?item.results:[]);
  return rows.slice(0,200).flatMap(row=>{
    try{
      const input=typeof row?.payload==='string'?JSON.parse(row.payload):row?.payload;
      if(input?.module!=='account'||!ACCOUNT_CODES.includes(input?.code))return [];
      const report=normalizeReport(input);
      const timestamp=value=>new Date(bounded(value,0,8640000000000000,0)).toISOString();
      return [{...report,firstSeen:timestamp(row.created),lastSeen:timestamp(row.updated),reports:bounded(row.reports,0,1000000000,0)}];
    }catch{return [];}
  });
}
function outputPath(value){
  if(typeof value!=='string'||!path.isAbsolute(value)||path.extname(value).toLowerCase()!=='.json')throw Error('invalid_output');
  const resolved=path.resolve(value),relative=path.relative(OUTPUT,resolved);
  if(!relative||relative==='..'||relative.startsWith(`..${path.sep}`)||path.isAbsolute(relative))throw Error('invalid_output');
  // Existing links must not redirect the approved development output directory.
  for(let current=resolved;current!==path.dirname(current);current=path.dirname(current)){
    if(fs.existsSync(current)&&fs.lstatSync(current).isSymbolicLink())throw Error('invalid_output');
    if(current===OUTPUT)break;
  }
  return resolved;
}
function collect({remote=false,out,wrangler,days=7,limit=100,now=Date.now(),run=spawnSync}={}){
  if(remote!==true)throw Error('remote_opt_in_required');
  const file=outputPath(out);
  if(typeof wrangler!=='string'||!path.isAbsolute(wrangler)||!fs.statSync(wrangler).isFile())throw Error('invalid_cli');
  const result=run(process.execPath,[wrangler,'d1','execute','hamster-ai-reports','--remote','--config',CONFIG,'--command',buildQuery({now,days,limit}),'--json'],
    {cwd:PROJECT,encoding:'utf8',timeout:60000,maxBuffer:8*1024*1024,windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,CI:'true',WRANGLER_SEND_METRICS:'false'}});
  if(result.error||result.status!==0)throw Error('collection_failed');
  const reports=normalizeRows(result.stdout);
  const value={format:1,collectedAt:new Date(now).toISOString(),module:'account',reports};
  fs.mkdirSync(path.dirname(file),{recursive:true});
  fs.writeFileSync(file,JSON.stringify(value,null,2)+'\n',{mode:0o600});
  return {file,count:reports.length};
}
function main(args=process.argv.slice(2)){
  const options={};
  try{
    for(let i=0;i<args.length;i++){
      const arg=args[i];
      if(arg==='--help'){process.stdout.write('node scripts/collect-account-reports.cjs --remote --out <absolute JSON path under reports/exports> --wrangler <existing wrangler.js> [--days 1..30] [--limit 1..200]\n');return 0;}
      if(arg==='--remote'){options.remote=true;continue;}
      if(!['--out','--wrangler','--days','--limit'].includes(arg)||!args[i+1])throw Error('invalid_argument');
      const value=args[++i];options[arg.slice(2)]=['--days','--limit'].includes(arg)?Number(value):value;
    }
    const result=collect(options);
    process.stdout.write(JSON.stringify({ok:true,count:result.count,file:result.file})+'\n');return 0;
  }catch{
    // Never echo CLI stderr/stdout, credentials, customer fields or arbitrary exception text.
    process.stderr.write('未能只读收集账户故障。请检查 --remote、本机数据目录 reports/exports 内的 --out、Wrangler 路径及登录权限。\n');return 1;
  }
}
if(require.main===module)process.exitCode=main();
module.exports={buildQuery,normalizeRows,outputPath,collect,main};
