import {test} from 'node:test';
import assert from 'node:assert/strict';
import {formatMoney,catalogPriceText,quoteValid,pricingQuote} from '../public/canvas-pricing.mjs';
test('exact small retail prices retain all meaningful decimal places without floating rounding',()=>{
  assert.equal(formatMoney('0.000001'),'¥0.000001');assert.equal(formatMoney('0.125000'),'¥0.125');
  assert.equal(formatMoney('2.2'),'¥2.20');assert.equal(formatMoney('0'),'¥0.00');
  for(const bad of [0.1,'NaN','-1','1e-6','0.0000001','Infinity','01.00'])assert.equal(formatMoney(bad),'—');
});
test('a selected specification cannot inherit a different specification price',()=>{
  const m={billing_mode:'relay',prices:[{resolution:'720p',unit:'second',retail_cny:'0.125'}]};
  assert.equal(catalogPriceText(m,{resolution:'720p'}),'¥0.125/秒');
  assert.equal(catalogPriceText(m,{resolution:'1080p'}),'此规格暂无售价');
  assert.equal(catalogPriceText({...m,prices:[]}),'价格待确认');
});
test('relay pricing stays unknown without a valid exact-parameter quote; missing prices are never free',()=>{
  const m={id:'main-video-a',billing_mode:'relay'};
  assert.equal(pricingQuote(m).known,false);
  const q={id:'synthetic_quote_001',model:m.id,currency:'CNY',price_version:3,unit:'second',unit_price_cny:'0.125',reference_surcharge_cny:'0',per_item_cny:'0.5',total_cny:'2',quantity:4,units:4,expires_at:Math.floor(Date.now()/1000)+60};
  assert.equal(quoteValid(q,{model:m,quantity:4}),true);assert.equal(pricingQuote(m,{quote:q,concurrency:4}).known,true);
  assert.equal(quoteValid(q,{quantity:1}),false);assert.equal(quoteValid(q,{model:'other-model'}),false);
  assert.equal(quoteValid({...q,expires_at:1}),false);assert.equal(quoteValid({...q,total_cny:'NaN'}),false);
});
