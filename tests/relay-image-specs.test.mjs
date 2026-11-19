import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {defaultImageOptions,imageSizeRatio,imageSizesForRatio,closestImageRatio,buildImagePayload} from '../public/core.mjs';

const model={id:'main-image-fixture',type:'image',aspect_ratios:['1:1','16:9','9:16','auto'],
  size_options:['1024x1024','2048x2048','1536x864','2048x1152','3840x2160','2160x3840','auto'],
  quality_options:['auto','low','medium','high'],default_quality:'auto'};
const source=fs.readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
function section(start,end){
  const first=source.indexOf(start),last=source.indexOf(end,first);
  assert.ok(first>=0&&last>first);return source.slice(first,last);
}
function fixture(){
  const elements=new Map(),quoteUpdates=[];
  const element=selector=>{
    if(!elements.has(selector))elements.set(selector,{value:'',hidden:false,children:[],naturalWidth:1600,naturalHeight:900,
      replaceChildren(){this.children=[];this.value='';},append(child){this.children.push(child);}});
    return elements.get(selector);
  };
  const context={state:{model,options:defaultImageOptions(model)},$ :element,
    imageSizesForRatio,defaultImageOptions,closestImageRatio,isVideoType:()=>false,imageModels:()=>[model],
    QUALITY_LABEL:{auto:'自动',low:'快速',medium:'标准',high:'高质量'},
    document:{createElement:()=>({value:'',textContent:''})},renderComposer(){},toast:()=>assert.fail('unexpected toast'),
    renderImageEditCapability(){},updateSurfaceQuote:key=>quoteUpdates.push(key),
    openMenu(_anchor,items){context.menu=items;}};
  element('#imageEditModel').value=model.id;
  vm.createContext(context);
  vm.runInContext(section('function ratioMenu(anchor)','function qualityMenu(anchor)')+'\n'+section('function imageEditOptions()','function imageEditPoint(event)'),context);
  return {context,element,quoteUpdates};
}

test('image size options preserve multiple resolutions per ratio and optional auto',()=>{
  assert.equal(imageSizeRatio('3840x2160'),'16:9');
  assert.equal(imageSizeRatio('0x0'),'');
  assert.deepEqual(imageSizesForRatio(model,'16:9'),['1536x864','2048x1152','3840x2160']);
  assert.deepEqual(imageSizesForRatio(model,'auto'),['auto']);
  assert.deepEqual(defaultImageOptions(model),{aspect_ratio:'1:1',size:'1024x1024',quality:'auto'});
  assert.deepEqual(defaultImageOptions({...model,default_size:'2048x2048'}),{aspect_ratio:'1:1',size:'2048x2048',quality:'auto'});
});

test('main image ratio and size menus keep the exact chosen size in the submitted payload',()=>{
  const {context}=fixture();
  context.ratioMenu({});context.menu.find(item=>item.label==='16:9').onSelect();
  assert.equal(context.state.options.size,'1536x864');
  context.sizeMenu({});context.menu.find(item=>item.label==='3840 × 2160').onSelect();
  context.ratioMenu({});context.menu.find(item=>item.label==='16:9').onSelect();
  context.state.options.quality='high';
  const payload=buildImagePayload({model,...context.state.options,prompt:'test',concurrency:1});
  assert.equal(payload.size,'3840x2160');assert.equal(payload.aspect_ratio,'16:9');assert.equal(payload.quality,'high');
  context.ratioMenu({});context.menu.find(item=>item.label==='1:1').onSelect();
  assert.equal(context.state.options.size,'1024x1024');
  context.ratioMenu({});context.menu.find(item=>item.label==='自动').onSelect();
  context.sizeMenu({});assert.equal(context.menu.length,1);assert.equal(context.menu[0].label,'自动');assert.equal(context.state.options.size,'auto');
});

test('image editor selects source ratio and keeps size and quality independent',()=>{
  const {context,element,quoteUpdates}=fixture();
  context.imageEditOptions();
  assert.equal(element('#imageEditRatio').value,'16:9');
  assert.equal(element('#imageEditSizeField').hidden,false);
  assert.deepEqual(element('#imageEditSize').children.map(option=>option.value),['1536x864','2048x1152','3840x2160']);
  element('#imageEditSize').value='2048x1152';element('#imageEditQuality').value='medium';
  context.imageEditSizes();assert.equal(element('#imageEditSize').value,'2048x1152');
  const payload=buildImagePayload({model,prompt:'edit',aspect_ratio:element('#imageEditRatio').value,size:element('#imageEditSize').value,quality:element('#imageEditQuality').value,images:[{url:'mock-input'}]});
  assert.equal(payload.size,'2048x1152');assert.equal(payload.quality,'medium');
  element('#imageEditRatio').value='9:16';context.imageEditSizes();assert.equal(element('#imageEditSize').value,'2160x3840');
  assert.equal(element('#imageEditQuality').value,'medium');
  element('#imageEditRatio').value='auto';context.imageEditSizes();assert.equal(element('#imageEditSize').value,'auto');
  assert.deepEqual(quoteUpdates,['imageEdit','imageEdit','imageEdit','imageEdit']);
});

test('models without declared sizes keep the legacy payload and hide the new size selector',()=>{
  const {context,element}=fixture();
  const legacy={...model,size_options:undefined};context.imageModels=()=>[legacy];
  context.imageEditOptions();
  assert.equal(element('#imageEditSizeField').hidden,true);assert.equal(element('#imageEditSize').value,'');
  assert.equal('size' in defaultImageOptions(legacy),false);
  assert.equal('size' in buildImagePayload({model:legacy,aspect_ratio:'1:1',quality:'auto'}),false);
});
