import test from 'node:test';
import assert from 'node:assert/strict';
import {reverseFileError,reverseQuoteValid,reverseLinkInput} from '../public/reverse.mjs';
import reverseService from '../reverse.cjs';
import {startupView,startupCheckKind,needsMainCatalogue} from '../public/startup-ui.mjs';
import prefs from '../startup-preferences.cjs';

test('reverse validates local file bounds before permitting an upload',()=>{
  const valid={name:'sample.mp4',size:12000};
  for(const name of ['sample.mp4','sample.MOV','sample.webm','sample.m4v'])assert.equal(reverseFileError({...valid,name},600),'');
  for(const [file,seconds] of [[{...valid,name:'sample.png'},30],[{...valid,size:0},30],[{...valid,size:524288001},30],[valid,600.01],[valid,Infinity],[valid,NaN],[valid,0]])assert.ok(reverseFileError(file,seconds));
  assert.ok(reverseFileError(valid,60,{max_bytes:100}));
  assert.ok(reverseFileError(valid,60,{max_seconds:30}));
});

test('reverse requires the confirmed tariff and maximum reservation, never an absent price',()=>{
  const quote={available:true,currency:'CNY',confirmation_required:true,billing_mode:'actual_seconds_v1',price_version:'reverse-cny-003-v1',unit_price_cny:'0.03',reservation_cny:'18.00',max_seconds:600};
  assert.equal(reverseQuoteValid(quote),true);
  for(const changed of [null,{}, {...quote,available:false},{...quote,confirmation_required:false},{...quote,currency:'USD'},{...quote,price_version:'unknown'},{...quote,price_version:''},{...quote,unit_price_cny:'0'},{...quote,reservation_cny:'19.00'},{...quote,max_seconds:900}])assert.equal(reverseQuoteValid(changed),false);
});

test('reverse is a tool-key page and startup never sends a task or loads the generation catalogue',()=>{
  assert.equal(prefs.validPreference({lastView:'reverse'}),true);
  assert.equal(startupView({toolConfigured:true},{lastView:'reverse'}),'reverse');
  assert.equal(startupView({configured:true},{lastView:'reverse'}),'account');
  assert.equal(startupCheckKind({toolConfigured:true},'reverse'),'tool');
  assert.equal(needsMainCatalogue('reverse'),false);
});

test('share text extracts one supported platform link without changing signed query',()=>{
  const cases=[
    ['https://v.douyin.com/TestVideo/','douyin'],
    ['https://www.douyin.com/video/1234567890','douyin'],
    ['https://www.xiaohongshu.com/explore/0123456789abcdef01234567?xsec_token=synthetic%2Btest.','xiaohongshu'],
    ['https://xhslink.com/o/TestVideo','xiaohongshu'],
    ['https://www.bilibili.com/video/BV1TestVideo/','bilibili'],
    ['https://b23.tv/TestVideo','bilibili'],
  ];
  for(const [url,platform] of cases){
    const result=reverseLinkInput('分享视频 '+url+' 复制后打开应用');
    assert.equal(result.url,url);assert.equal(result.platform,platform);assert.equal(result.error,'');
    assert.deepEqual(reverseService.reverseLink(result.url),{url,platform});
  }
  assert.equal(reverseLinkInput('（https://v.douyin.com/TestVideo/）。').url,'https://v.douyin.com/TestVideo/');
});

test('UI and local relay reject unsupported, ambiguous and disguised URLs consistently',()=>{
  for(const url of [
    'http://v.douyin.com/TestVideo','https://v.douyin.com.evil.invalid/TestVideo','https://user@v.douyin.com/TestVideo',
    'https://v.douyin.com.:443/TestVideo','https://v.douyin.com:0443/TestVideo','https://v.douyin.com/a/../TestVideo',
    'https://%76.douyin.com/TestVideo','https://v.douyin.com/%54estVideo','https://127.0.0.1/video/123',
    'https://example.invalid/video.mp4','https://b23.tv/TestVideo#','https://b23.tv/TestVideo?next=https%253A%252F%252Fexample.invalid',
    'https://b23.tv/TestVideo?x=%2509','https://b23.tv/TestVideo?x=%C2%80',
  ]){
    assert.ok(reverseLinkInput(url).error);
    assert.throws(()=>reverseService.reverseLink(url));
  }
  assert.ok(reverseLinkInput('https://v.douyin.com/one/ https://b23.tv/two').error);
  assert.ok(reverseLinkInput('hello').error);
});
