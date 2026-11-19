// Read only bounded, normalized incident records and their known R2 objects.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{spawnSync}=require('node:child_process');
const {normalizeReport}=require('../report-schema.cjs');
const app=path.resolve(__dirname,'..'),root=path.dirname(app),out=path.join(app,'output/chat-media-failure-current');
const cli=path.join(root,'PIKNO中转站/tools/relay-cli/node_modules/wrangler/bin/wrangler.js');
const env={...process.env,CI:'true',WRANGLER_SEND_METRICS:'false',WRANGLER_LOG_SANITIZE:'true'};
const run=args=>spawnSync(process.execPath,[cli,...args],{cwd:root,encoding:'utf8',windowsHide:true,timeout:60000,maxBuffer:2*1024*1024,env});
const stamp=value=>{assert(Number.isSafeInteger(value)&&value>0);return new Date(value).toISOString();};
async function main(){
 const auth=run(['auth','token','--json','--profile','default']);assert.equal(auth.status,0,'DEFAULT_AUTH_UNAVAILABLE');const token=JSON.parse(auth.stdout).token;
 const sql="SELECT fingerprint,payload,created,updated,(SELECT COUNT(*) FROM receipts WHERE receipts.fingerprint=incidents.fingerprint) AS reports FROM incidents WHERE updated>="+String(Date.now()-3*86400000)+" AND json_extract(payload,'$.module') IN ('chat','service','generation','account') ORDER BY updated DESC LIMIT 30";
 const response=await fetch('https://api.cloudflare.com/client/v4/accounts/7ad8e2addb69374532fecc2f16a00549/d1/database/5dcd367a-aeff-46e6-9c67-faf9fc5d558b/query',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({sql}),signal:AbortSignal.timeout(30000)});
 const data=await response.json();assert(response.ok&&data.success,'INCIDENT_READ_FAILED');
 const rows=data.result.flatMap(x=>x.results||[]).map(row=>{assert(/^[a-f0-9]{64}$/.test(row.fingerprint));return {fingerprint:row.fingerprint,...normalizeReport(JSON.parse(row.payload)),firstSeen:stamp(row.created),lastSeen:stamp(row.updated),reports:row.reports};});
 fs.mkdirSync(out,{recursive:true});
 const reports=[];
 for(const row of rows.slice(0,5)){
  const object='reports/'+row.firstSeen.slice(0,10)+'/'+row.fingerprint+'.json';
  const r=run(['r2','object','get','hamster-ai-reports/'+object,'--remote','--pipe','--profile','default']);
  let bucket=null;if(r.status===0){const value=JSON.parse(r.stdout);bucket={...normalizeReport(value),firstSeen:value.firstSeen,lastSeen:value.lastSeen,reports:value.reports};assert.deepEqual(normalizeReport(bucket),normalizeReport(row));}
  reports.push({object,bucketFound:bucket!==null,bucket});
 }
 const result={readOnly:true,at:new Date().toISOString(),customerContentRead:false,incidents:rows,bucketObjects:reports};fs.writeFileSync(path.join(out,'incidents.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
}
main().catch(e=>{console.error(JSON.stringify({ok:false,reason:e instanceof assert.AssertionError?e.message:'READ_FAILED'}));process.exitCode=1;});
