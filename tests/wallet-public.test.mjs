import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {pricingQuote} from '../public/canvas-pricing.mjs';
import {mapUpstreamModels,hamsterModelName,publicText,buildVideoPayload,buildImagePayload} from '../public/core.mjs';

test('browser routing only accepts business aliases and contains no legacy model IDs',()=>{
 const source=fs.readFileSync(new URL('../public/core.mjs',import.meta.url),'utf8');
 assert.doesNotMatch(source,/sd_2_5_once|image_2_5_flare|gpt-image2/);
 const model={id:'main-video-720',name:'主线路 · 标准720P',type:'video',price_version:4};
 assert.deepEqual(mapUpstreamModels([model,{id:'sd_2_5_once_720p',name:'legacy'}]),[model]);
 assert.equal(hamsterModelName(model),model.name);
 assert.equal(hamsterModelName({id:'sd_2_5_once_720p'}),'仓鼠线路');
 assert.doesNotMatch(publicText('VideoFee sd_2_5_once_720p ep-fixture sk-fixture https://example.com'),/VideoFee|sd_2|ep-|sk-|https:/i);
 assert.equal(buildVideoPayload({model}).price_version,4);
 assert.equal(buildImagePayload({model:{...model,id:'main-image-a'}}).price_version,4);
});

test('new main video routes appear from the cloud catalog without upstream identifiers',()=>{
 const ids=['main-video-480real','main-video-933limited','main-video-value','main-video-line5','main-video-line1'];
 const models=ids.map((id,index)=>({id,name:`主线路 · 线路${index+1}`,type:'video',enabled:true,price_version:1}));
 assert.deepEqual(mapUpstreamModels(models).map(model=>model.id),ids);
 for(const model of models){
  assert.equal(hamsterModelName(model),model.name);
  assert.equal(buildVideoPayload({model}).model,model.id);
 }
});

test('legacy zero-price rule remains and new paid entries require quote confirmation without upstream workflow IDs',()=>{
 assert.equal(pricingQuote({display_price_yuan:0}).known,false);
 assert.equal(pricingQuote({display_price_yuan:0,free:true}).text,'免费');
 assert.equal(pricingQuote({display_price_yuan:.1}).total,.1);
 assert.equal(pricingQuote({display_price_yuan:5}).total,5);
 const source=fs.readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
 assert.doesNotMatch(source,/2087890031699648513|2089021172049596418|nodeInfoList|\/run\/ai-app/);
 for(const [start,end,key] of [['async function onSubmit(e)','// The UI reads','generate'],['async function submitImageEdit(event)','let historyFilter','imageEdit'],['async function dhSubmit()','// ---- 工具箱','digital'],['async function depthSubmit()','function renderRhStatus()','depth']]){
  const first=source.indexOf(start),body=source.slice(first,source.indexOf(end,first));
  const confirmation=body.indexOf(`confirmPaidSubmission('${key}'`),paid=body.indexOf('await request(');
  assert.ok(confirmation>=0&&paid>confirmation,`${key} must confirm before a paid request`);
  assert.ok(body.includes('quote_id')&&body.includes(`confirmedQuoteCurrent('${key}'`),`${key} binds and rechecks its confirmed quote`);
 }
});

test('internal test wallet is visibly separate from real recharge',()=>{
 const client=fs.readFileSync(new URL('../public/billing-account.mjs',import.meta.url),'utf8');
 const admin=fs.readFileSync(new URL('../cloudflare/billing-worker/public/admin.js',import.meta.url),'utf8');
 assert.match(client,/openRecharge'\)\.hidden=Boolean\(me\.test_account\)/);
 assert.match(client,/内部测试额度，不对应实际充值/);
 assert.match(admin,/发放 ¥22\.30 测试额度/);
 assert.match(admin,/正式客户余额/);
});
