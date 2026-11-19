import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source=fs.readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
const first=source.indexOf('function bindViewTabs()'),last=source.indexOf('function bindEvents()',first);
assert.ok(first>=0&&last>first);

function fixture() {
  let handler;
  const changes=[],focus=[];
  const list={addEventListener(type,listener){assert.equal(type,'keydown');handler=listener;},querySelectorAll:()=>tabs};
  const tabs=['chat','generate','hidden','disabled','depth'].map(view=>({
    dataset:{view},parentElement:list,hidden:view==='hidden',disabled:view==='disabled',
    closest(){return this;},focus:options=>focus.push({view,options}),
  }));
  const context=vm.createContext({$:()=>list,switchView:view=>changes.push(view)});
  vm.runInContext(source.slice(first,last),context);context.bindViewTabs();
  function press(view,key,options={}) {
    const event={target:tabs.find(tab=>tab.dataset.view===view),key,preventDefault(){this.prevented=true;},...options};
    handler(event);return event;
  }
  return {tabs,list,changes,focus,press,handler:()=>handler};
}

test('fixed tabs wrap and skip unavailable pages without rebuilding their controls',()=>{
  const f=fixture(),original=[...f.tabs];
  assert.equal(f.press('chat','ArrowLeft').prevented,true);
  assert.equal(f.changes.at(-1),'depth');
  assert.equal(f.press('depth','ArrowRight').prevented,true);
  assert.equal(f.changes.at(-1),'chat');
  f.press('generate','ArrowRight');assert.equal(f.changes.at(-1),'depth');
  f.press('depth','Home');assert.equal(f.changes.at(-1),'chat');
  f.press('chat','End');assert.equal(f.changes.at(-1),'depth');
  assert.deepEqual(f.tabs,original);
  assert.equal(f.focus.length,5);
  assert.ok(f.focus.every(value=>value.options.preventScroll===true));
});

test('tab keyboard navigation is limited to its own tab buttons and leaves modified shortcuts alone',()=>{
  const f=fixture();
  for(const modifier of ['ctrlKey','metaKey','altKey','shiftKey'])assert.equal(f.press('chat','ArrowRight',{[modifier]:true}).prevented,undefined);
  assert.equal(f.press('chat','Tab').prevented,undefined);
  assert.equal(f.press('chat','Enter').prevented,undefined);
  const input={target:{closest:()=>null},key:'End',preventDefault(){throw Error('Input key intercepted');}};
  f.handler()(input);
  const other={...f.tabs[0],parentElement:{}};
  f.handler()({target:other,key:'ArrowRight',preventDefault(){throw Error('Unrelated control intercepted');}});
  assert.deepEqual(f.changes,[]);
});
