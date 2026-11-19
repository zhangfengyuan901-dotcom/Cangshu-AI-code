import test from 'node:test';
import assert from 'node:assert/strict';
import {mountCodexChat} from '../public/codex-chat.mjs';
class Element{
  constructor(doc,tag){this.ownerDocument=doc;this.tagName=tag;this.children=[];this.attributes={};this.textContent='';this.value='';this.disabled=false;this.hidden=false;this.listeners={};}
  append(...items){this.children.push(...items);}
  replaceChildren(...items){this.children=items;}
  setAttribute(key,value){this.attributes[key]=value;}
  addEventListener(key,fn){this.listeners[key]=fn;}
}
const nodes=root=>[root,...root.children.flatMap(nodes)];
const session=id=>({id,title:'会话'+id,directory:'C:\\fixture\\'+id,status:'idle',messages:[]});
const flush=async()=>{for(let i=0;i<15;i++)await Promise.resolve();};
function fixture({available=true}={}){
  const doc={createElement(tag){return new Element(doc,tag);}},root=new Element(doc,'main'),calls=[],timers=new Map();let next=0,selected=null,sendReply=null;
  const list=[session('a'),session('b')];
  const request=async(path,options={})=>{
    calls.push({path,options});let result;
    if(path.endsWith('/status'))result={installed:true,available,authState:'authenticated',version:'0.145.0'};
    else if(path==='/api/codex/sessions')result=options.method?session('new'):list;
    else if(path.endsWith('/messages'))result=sendReply?await sendReply():{...list[0],status:'running',messages:[{role:'user',text:JSON.parse(options.body).text}]};
    else if(path.endsWith('/stop'))result={...list[0],status:'interrupted'};
    else result=selected?await selected(path):list.find(value=>path.endsWith('/'+value.id));
    return {ok:true,json:async()=>result};
  };
  const ui=mountCodexChat(root,{request,setTimer:fn=>{timers.set(++next,fn);return next;},clearTimer:id=>timers.delete(id)});
  const find=(tag,text)=>nodes(root).find(n=>n.tagName===tag&&(text===undefined||n.textContent===text));
  return {ui,root,find,calls,timers,setSelect:fn=>selected=fn,setSend:fn=>sendReply=fn};
}
test('mount and hidden state do not detect or submit; unavailable CLI cannot send',async()=>{
  const f=fixture({available:false});assert.deepEqual(f.calls,[]);await f.ui.open();
  await f.find('button','会话a').onclick();const input=f.find('textarea');input.value='hello';input.listeners.input();
  assert.equal(f.find('button','发送').disabled,true);
  await f.find('form',undefined).onsubmit?.({preventDefault(){}});
  assert.equal(f.calls.filter(c=>c.path.endsWith('/messages')).length,0);assert.equal(f.timers.size,0);
});
test('selecting a different session disables send until the selected GET completes',async()=>{
  const f=fixture();await f.ui.open();await f.find('button','会话a').onclick();
  let resolve;f.setSelect(()=>new Promise(done=>resolve=done));
  const selecting=f.find('button','会话b').onclick();
  const input=f.find('textarea');input.value='belongs to b';input.listeners.input();assert.equal(f.find('button','发送').disabled,true);
  const composer=nodes(f.root).find(n=>n.tagName==='form'&&n.children.includes(input));await composer.onsubmit({preventDefault(){}});
  assert.equal(f.calls.filter(c=>c.path.endsWith('/messages')).length,0);
  resolve(session('b'));await selecting;
  assert.equal(f.find('p','C:\\fixture\\b · 始终只读').textContent,'C:\\fixture\\b · 始终只读');
});
test('explicit send is single-flight and hiding suspends progress polling without losing content',async()=>{
  const f=fixture();await f.ui.open();await f.find('button','会话a').onclick();
  let resolve;f.setSend(()=>new Promise(done=>resolve=done));const input=f.find('textarea');input.value='<script>fixture</script>';input.listeners.input();
  const composer=nodes(f.root).find(n=>n.tagName==='form'&&n.children.includes(input)),event={preventDefault(){}};
  const sending=composer.onsubmit(event);await composer.onsubmit(event);
  assert.equal(f.calls.filter(c=>c.path.endsWith('/messages')).length,1);
  resolve({...session('a'),status:'running',messages:[{role:'user',text:'<script>fixture</script>'}]});await sending;
  assert.equal(f.find('pre','<script>fixture</script>').textContent,'<script>fixture</script>');assert.equal(f.timers.size,1);
  f.ui.setVisible(false);assert.equal(f.timers.size,0);f.ui.setVisible(true);assert.equal(f.timers.size,1);
  f.ui.destroy();assert.equal(f.timers.size,0);
});
