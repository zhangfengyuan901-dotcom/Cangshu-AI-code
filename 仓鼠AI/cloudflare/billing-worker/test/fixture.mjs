import fs from 'node:fs';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {run,hash} from '../src/common.mjs';
export async function fixture(t,balance=100000000,limit=Infinity){
 const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:'export default {fetch(){return new Response("ok")}}',compatibilityDate:'2026-09-27',d1Databases:['DB'],r2Buckets:['RESULTS']}));t.after(()=>mf.dispose());
 const env={DB:await mf.getD1Database('DB'),RESULTS:await mf.getR2Bucket('RESULTS'),KEY_ENCRYPTION_SECRET:'fixture-secret',RESULT_SIGNING_SECRET:'fixture-signing'};
 // D1 exec treats newlines as statement separators. Keep trigger bodies intact.
 for(const file of fs.readdirSync(new URL('../migrations/',import.meta.url)).filter(x=>x.endsWith('.sql')).sort().slice(0,limit)){
 const schema=fs.readFileSync(new URL('../migrations/'+file,import.meta.url),'utf8');
 await env.DB.batch(schema.split(/(?=^(?:CREATE|INSERT|PRAGMA|ALTER|DROP|UPDATE|DELETE) )/m).filter(x=>x.trim()).map(sql=>env.DB.prepare(sql.trim())));}
 await run(env,"INSERT INTO customers(id,email,balance,max_concurrency,created_at,email_verified_at) VALUES ('user','test@example.com',?,1000,0,1)",balance);
 await run(env,"INSERT INTO api_keys(id,user_id,name,token_hash,preview,created_at) VALUES ('client','user','Test',?,'ha_test',0)",await hash('ha_fixture'));
 for(const provider of limit===3?['main','backup']:['main','backup','tool']){
 await run(env,'INSERT OR IGNORE INTO provider_accounts VALUES (?,?,?,100)','fixture-account-'+provider,provider,'fixture');
 await run(env,'INSERT INTO provider_keys(id,account_id,provider,name,encrypted_secret,fingerprint,preview,created_at) VALUES (?,?,?,?,?,?,?,0)','fixture-'+provider,'fixture-account-'+provider,provider,'fixture','unused','fixture-'+provider,'hidden');}
 return {env,user:{id:'user',key_id:'client'},payload:{model:'backup-video-480',prompt:'test',duration:5,resolution:'480p',ratio:'16:9'}};
}
