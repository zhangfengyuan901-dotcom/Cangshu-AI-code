'use strict';
// One real Flare request, user-authorized ordinary account only. Never retries.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const cp = require('node:child_process');
const assert = require('node:assert/strict');
const BASE = 'https://www.piknoai.com';
const DIR = path.join(__dirname, 'private/settlement16-production');
const KEY_FILE = path.join(__dirname, 'private/settlement16-customer-key.txt');
function sql(query) {
  const result = cp.spawnSync('ssh', ['-o','BatchMode=yes','-o','ConnectTimeout=10','-i',
    'C:/Users/ZhuanZ/Desktop/_PIKNO.pem','root@8.217.68.247',
    'docker exec -i piknoai-relay-postgres-1 psql -U pikno -d newapi -At -v ON_ERROR_STOP=1'],
    {input:query,encoding:'utf8',timeout:20000});
  if(result.status !== 0) throw new Error('Read-only financial verification failed');
  return result.stdout.trim();
}
function jsonSQL(query) { return JSON.parse(sql(`SELECT coalesce(json_agg(t),'[]'::json) FROM (${query}) t`)); }
function save(name,data){fs.writeFileSync(path.join(DIR,name),JSON.stringify(data,null,2),{mode:0o600});}
async function main(){
  const mode=process.argv[2]; assert.ok(['preflight','call','verify'].includes(mode));
  const key=fs.readFileSync(KEY_FILE,'utf8').trim(); assert.match(key,/^sk-[A-Za-z0-9_-]+$/);
  const fingerprint=crypto.createHash('md5').update(key.slice(3)).digest('hex');
  const tokens=jsonSQL(`SELECT t.id,t.user_id,t.status,t.remain_quota,t.unlimited_quota,t.expired_time,t."group",t.model_limits_enabled,t.model_limits,u.email,u.role,u.quota,u.used_quota FROM tokens t JOIN users u ON u.id=t.user_id WHERE t.deleted_at IS NULL AND md5(t.key)='${fingerprint}'`);
  assert.equal(tokens.length,1,'Token was not found on this relay'); const t=tokens[0];
  assert.equal(t.user_id,2,'Not the selected ordinary test account'); assert.equal(t.role,1);
  assert.equal(t.email,'1060761161@qq.com'); assert.equal(t.status,1);
  assert.ok(t.expired_time===-1||t.expired_time>Date.now()/1000,'Token expired');
  assert.equal(t.group,'image-standard','Select the image-standard group');
  fs.mkdirSync(DIR,{recursive:true});
  if(mode==='preflight'){
    assert.ok(t.quota>=100000);assert.ok(t.unlimited_quota||t.remain_quota>=100000);
    console.log(JSON.stringify({ready:true,userId:t.user_id,tokenId:t.id,balanceCNY:t.quota/1000000,group:t.group}));return;
  }
  if(mode==='call'){
    const marker=path.join(DIR,'submitted.json'); assert.ok(!fs.existsSync(marker),'Already submitted; verify instead of retrying');
    assert.equal(sql('SELECT status FROM channels WHERE id=1'),'1');
    assert.equal(sql('SELECT count(*) FROM channels WHERE id<>1 AND status=1'),'0');
    const status=await fetch(BASE+'/api/status').then(r=>r.json()); assert.equal(status.data.version,'v1.0.0-rc.41-pikno.16');
    save('before.json',t);
    fs.writeFileSync(marker,JSON.stringify({time:Math.floor(Date.now()/1000),userId:t.user_id,tokenId:t.id}),{flag:'wx',mode:0o600});
    console.log('REAL_FLARE_REQUEST_STARTED_NO_RETRIES');
    const r=await fetch(BASE+'/v1/images/generations',{
      method:'POST',redirect:'error',headers:{'Content-Type':'application/json',Authorization:'Bearer '+key},
      body:JSON.stringify({model:'gpt-image-2.5-flare',n:1,size:'1024x1024',quality:'high',output_format:'png',response_format:'url',
        prompt:'Minimal product photo of one matte white geometric vase on a pale grey table, soft daylight, plain background, square composition, no text, no logo.'}),
      signal:AbortSignal.timeout(600000),
    });
    const body=await r.json();save('response.json',body);
    const result={http:r.status,returnedImages:Array.isArray(body.data)?body.data.length:0,hasMedia:!!(body.data?.[0]?.url||body.data?.[0]?.b64_json)};
    save('response-summary.json',result); console.log(JSON.stringify(result));
    assert.equal(r.status,200,'Inspect the real failed order; do not retry');assert.equal(result.returnedImages,1);assert.ok(result.hasMedia);
  }
  const mark=JSON.parse(fs.readFileSync(path.join(DIR,'submitted.json'),'utf8'));
  const orders=jsonSQL(`SELECT id,financial_state,generation_state,reserved_quota,net_quota,refunded_quota,version FROM pikno_settlements WHERE user_id=2 AND token_id=${t.id} AND created_at>=${mark.time} ORDER BY created_at`);
  const wallet=jsonSQL('SELECT quota,used_quota FROM users WHERE id=2')[0];
  const outbox=jsonSQL(`SELECT id,kind,delivery_state,delivered_at,attempts FROM pikno_settlement_outboxes WHERE user_id=2 AND created_at>=${mark.time} ORDER BY id`);
  save('verification.json',{orders,wallet,outbox});
  console.log(JSON.stringify({orders,balanceCNY:wallet.quota/1000000,consumptionCNY:wallet.used_quota/1000000,outbox}));
  assert.equal(orders.length,1); assert.equal(orders[0].financial_state,'settled');assert.equal(orders[0].net_quota,100000);assert.equal(orders[0].reserved_quota,0);
  const before=JSON.parse(fs.readFileSync(path.join(DIR,'before.json'),'utf8'));
  assert.equal(wallet.quota,before.quota-100000);assert.equal(wallet.used_quota,before.used_quota+100000);
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
