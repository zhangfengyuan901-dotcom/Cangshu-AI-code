'use strict';
// Read-only queries of two previously generated tasks. No submit endpoint,
// production database access, wallet mutation or provider session extraction.
const fs=require('node:fs');
const path=require('node:path');
const {inspect}=require('./video17-evidence.cjs');
const privateDir=path.join(__dirname,'private');
async function main(){
  const sanbao=JSON.parse(fs.readFileSync(path.join(privateDir,'release-probe-20261008/sanbao.json')));
  const configs=[
    {provider:'sanbao',base:'https://sanbaobeauty.com',file:'sanbao-release-key.json',taskId:sanbao.taskId,prefix:'/openapi/v1/videos/'},
    {provider:'canseedream',base:'https://see.ximeiedu.org',file:'canseedream-client14.json',taskId:'cstask_KAkJmwtFEc4uKzG7c_0ejP1l',prefix:'/api/v3/contents/generations/tasks/'},
  ];
  const results=[];
  for(const config of configs){
    const {apiKey}=JSON.parse(fs.readFileSync(path.join(privateDir,config.file)));
    if(typeof apiKey!=='string'||!apiKey||!/^\w[\w-]{1,199}$/.test(config.taskId)) throw Error('Invalid private query configuration');
    try{
      const response=await fetch(config.base+config.prefix+encodeURIComponent(config.taskId),{
        method:'GET',headers:{Authorization:'Bearer '+apiKey},redirect:'error',signal:AbortSignal.timeout(20000)});
      let body;try{body=await response.json();}catch{body=null;}
      results.push(inspect({provider:config.provider,expectedTaskId:config.taskId,httpStatus:response.status,body}));
    }catch{results.push({provider:config.provider,taskId:config.taskId,reason:'query_transport_failure',automaticSettlementAllowed:false,requiresAdminReview:true});}
  }
  const report={checkedAt:new Date().toISOString(),generationRequests:0,productionMutations:0,results};
  const dir=path.join(privateDir,'video17-evidence');fs.mkdirSync(dir,{recursive:true});
  fs.writeFileSync(path.join(dir,'observation-'+Date.now()+'.json'),JSON.stringify(report,null,2),{mode:0o600});
  console.log(JSON.stringify(report));
}
main().catch(()=>{console.error('Read-only evidence probe failed; secret output withheld');process.exitCode=1;});
