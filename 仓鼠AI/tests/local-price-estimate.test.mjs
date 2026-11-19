import test from 'node:test';
import assert from 'node:assert/strict';
import {estimatePrice,quoteValid} from '../public/canvas-pricing.mjs';

const video=(overrides={})=>({id:'video-line',type:'video',provider:'generate',billing_mode:'relay',currency:'CNY',line_revision:1,durations:[4,5,30],prices:[{resolution:'720p',unit:'second',retail_cny:'0.20'}],reference_surcharge_cny:'0.05',...overrides});
const options=(overrides={})=>({resolution:'720p',duration:4,concurrency:1,media_counts:{images:0,videos:0,audios:0},...overrides});

test('local estimate uses exact decimal units and the whole batch total without signed quote fields',()=>{
  const result=estimatePrice(video(),options({concurrency:4}));
  assert.equal(result.total_cny,'3.200000');assert.equal(result.text,'预估￥3.20元');
  assert.equal(result.units,4);assert.equal(result.quantity,4);assert.equal(quoteValid(result),false);
  assert.equal('id' in result,false);assert.equal('expires_at' in result,false);
  const precise=estimatePrice(video({prices:[{resolution:'720p',unit:'second',retail_cny:'0.000001'}]}),options({concurrency:2}));
  assert.equal(precise.total_cny,'0.000008');assert.equal(precise.text,'预估￥0.000008元');
});

test('video reference image surcharge applies once to each output, never per image or video',()=>{
  for(const [images,total] of [[0,'1.600000'],[1,'1.700000'],[10,'1.700000']]){
    const result=estimatePrice(video(),options({concurrency:2,media_counts:{images,videos:3,audios:1}}));
    assert.equal(result.total_cny,total);assert.equal(result.reference_surcharge_cny,images?'0.050000':'0.000000');
  }
  const missing=video();delete missing.reference_surcharge_cny;
  assert.equal(estimatePrice(missing,options()).known,true);
  assert.equal(estimatePrice(missing,options({media_counts:{images:1}})).known,false);
});

test('request billing is fixed per output and image prices ignore video surcharge fields',()=>{
  const fixed=estimatePrice(video({prices:[{resolution:'720p',unit:'request',retail_cny:'7.76'}]}),options({duration:30,concurrency:2}));
  assert.equal(fixed.units,1);assert.equal(fixed.total_cny,'15.520000');
  const image={id:'image-line',type:'image',provider:'generate',billing_mode:'relay',currency:'CNY',line_revision:2,prices:[{resolution:'1024x1024',unit:'image',retail_cny:'0.10'}],reference_surcharge_cny:'99'};
  assert.equal(estimatePrice(image,{size:'1024x1024',concurrency:4,media_counts:{images:2}}).total_cny,'0.400000');
  assert.equal(estimatePrice(image,{size:'1024x1024',media_counts:{videos:1}}).known,false);
});

test('tool request estimates use one output and preserve only the published depth zero policy',()=>{
  const tool={id:'tool-digital',type:'video',provider:'tool',billing_mode:'relay',currency:'CNY',price_version:1,prices:[{resolution:'default',unit:'request',retail_cny:'5.00'}]};
  assert.equal(estimatePrice(tool,{media_counts:{images:1,audios:1}}).total_cny,'5.000000');
  assert.equal(estimatePrice(tool,{concurrency:2}).known,false);
  assert.equal(estimatePrice({...tool,id:'tool-depth',prices:[{resolution:'default',unit:'request',retail_cny:'0.00'}]},{media_counts:{videos:1}}).text,'预估￥0.00元');
  assert.equal(estimatePrice({...tool,prices:[{resolution:'default',unit:'request',retail_cny:'0'}]},{}).known,false);
});

test('price resolution matches the exact row before default and never picks an unrelated row',()=>{
  const model=video({prices:[{resolution:'default',unit:'second',retail_cny:'0.10'},{resolution:'720p',unit:'second',retail_cny:'0.20'}]});
  assert.equal(estimatePrice(model,options()).total_cny,'0.800000');
  assert.equal(estimatePrice(model,options({resolution:'480p'})).total_cny,'0.400000');
  assert.equal(estimatePrice(video(),options({resolution:'480p'})).known,false);
  assert.equal(estimatePrice(video(),options({resolution:'auto'})).known,true);
  assert.equal(estimatePrice(video({prices:[...model.prices,model.prices[1]]}),options()).known,false);
});

test('missing or invalid published contract cannot be treated as a free or exact estimate',()=>{
  for(const change of [{billing_mode:'legacy'},{currency:undefined},{currency:'USD'},{line_revision:undefined},{line_revision:0},{line_revision:1.5},{prices:[]},{prices:[{resolution:'720p',unit:'second',retail_cny:'-1'}]},{prices:[{resolution:'720p',unit:'second',retail_cny:'0'}]},{prices:[{resolution:'720p',unit:'second',retail_cny:'0.0000001'}]},{prices:[{resolution:'720p',unit:'image',retail_cny:'1'}]},{prices:[{resolution:'720p',unit:'second',retail_cny:1}]},{reference_surcharge_cny:'invalid'},{prices:[{resolution:'720p',unit:'second',retail_cny:'9999999999.999999'}]}]){
    const result=estimatePrice(video(change),options({media_counts:{images:1}}));assert.deepEqual(result,{known:false,text:'预估￥？元'},JSON.stringify(change));
  }
  for(const change of [{duration:0},{duration:6},{duration:4.5},{concurrency:3},{resolution:720},{media_counts:null},{media_counts:[]},{media_counts:'invalid'},{media_counts:{images:-1}},{media_counts:{images:21}},{media_counts:{images:20,videos:1}},{media_counts:{images:1.2}}])assert.equal(estimatePrice(video(),options(change)).known,false);
  assert.equal(estimatePrice(null).known,false);assert.equal(estimatePrice(video(),null).known,false);
});
