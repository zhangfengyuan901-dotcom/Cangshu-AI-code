import {test} from 'node:test';
import assert from 'node:assert/strict';
import {canvasQuoteSignature} from '../public/canvas-core.mjs';

const document=()=>({nodes:[{id:'prompt',type:'text',position:{x:0,y:0},data:{text:'prompt'}},{id:'source',type:'upload',position:{x:0,y:0},data:{assetId:'asset-a'}},{id:'run',type:'generation',position:{x:0,y:0},data:{label:'Video',channel:'main',model:'line-a',prompt:'@图片1',options:{duration:5,resolution:'720p'}}}],edges:[{source:'prompt',target:'run'},{source:'source',target:'run'}],runs:[]});
const assets=[{id:'asset-a',kind:'image',size:30},{id:'asset-b',kind:'image',size:40}];
test('canvas quote signature ignores dragging, labels and unrelated task progress',()=>{
  const doc=document(),before=canvasQuoteSignature(doc,'run',assets);
  doc.nodes[2].position.x=90;doc.nodes[2].data.label='New display name';doc.runs.push({requestId:'other',status:'processing'});
  assert.equal(canvasQuoteSignature(doc,'run',assets),before);
});
for(const field of ['prompt','model','options','asset','text'])test('canvas quote confirmation expires after changing '+field,()=>{
  const doc=document(),before=canvasQuoteSignature(doc,'run',assets);
  if(field==='asset')doc.nodes[1].data.assetId='asset-b';
  else if(field==='text')doc.nodes[0].data.text='changed';
  else doc.nodes[2].data[field]=field==='options'?{duration:6,resolution:'720p'}:'changed';
  assert.notEqual(canvasQuoteSignature(doc,'run',assets),before);
});
