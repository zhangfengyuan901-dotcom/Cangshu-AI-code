import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source=fs.readFileSync(new URL('../canvas/src/main.jsx',import.meta.url),'utf8');
const context=vm.createContext({});
vm.runInContext(source.slice(source.indexOf('function canvasPreview('),source.indexOf('function PreviewDialog(')),context);
const preview=(...args)=>JSON.parse(JSON.stringify(context.canvasPreview(...args)));
const id='a'.repeat(32);

test('canvas previews construct only fixed local asset or saved-task routes',()=>{
  for(const kind of ['image','video','audio'])for(const [origin,route] of [['asset','assets'],['task','tasks']])assert.deepEqual(preview(origin,id,kind,'合成素材'),{src:`/api/${route}/${id}/file`,kind,title:'合成素材'});
  assert.deepEqual(preview('notice','https://untrusted.invalid','html','<script>'),{src:'/NOTICE.txt',kind:'text',title:'开源声明'});
});

test('canvas preview rejects URLs, path traversal, query injection and active document formats',()=>{
  for(const value of ['https://untrusted.invalid/x','//untrusted.invalid/x','javascript:alert(1)','../api/config','%2e%2e%2fconfig',id+'?download=1',id+'#x',id+'/../../config',id+'\n',id+'\r\n','',null,{}])assert.equal(preview('asset',value,'image','file'),null);
  for(const kind of ['iframe','html','svg','text',null])assert.equal(preview('task',id,kind,'file'),null);
  for(const origin of ['https://untrusted.invalid','/api/config','iframe',null])assert.equal(preview(origin,id,'image','file'),null);
});

function noticeFixture(fetch){
  let effect,cleanup,stateIndex=0;const states=[],dialog={showModal(){this.open=true;}};
  const scope=vm.createContext({preview:preview('notice'),fetch,AbortController,useRef:()=>({current:dialog}),useState:value=>{const index=stateIndex++;states[index]=value;return [value,value=>states[index]=value];},useEffect:fn=>effect=fn});
  const lifecycle=source.slice(source.indexOf('  const dialog=useRef(null),[text,setText]'),source.indexOf('  return <dialog ref={dialog} className="media-preview-dialog"'));
  vm.runInContext(lifecycle,scope);cleanup=effect();return {states,dialog,cleanup};
}
const flush=async()=>{for(let i=0;i<8;i++)await Promise.resolve();};

test('NOTICE opens locally and reads plain text without executing its content',async()=>{
  const calls=[],text='<script>do_not_execute()</script>',f=noticeFixture(async(url,options)=>{calls.push({url,options});return {ok:true,text:async()=>text};});await flush();
  assert.equal(f.dialog.open,true);assert.equal(calls.length,1);assert.equal(calls[0].url,'/NOTICE.txt');assert.equal(calls[0].options.credentials,'same-origin');assert.equal(f.states[0],text);
  assert.match(source,/<pre>\{text\}<\/pre>/);assert.doesNotMatch(source,/dangerouslySetInnerHTML|<iframe|target="_blank"|window\.open/);f.cleanup();assert.equal(calls[0].options.signal.aborted,true);
});

test('closing NOTICE aborts its one read and ignores late content',async()=>{
  let resolve;const f=noticeFixture(()=>new Promise(done=>resolve=done));f.cleanup();resolve({ok:true,text:async()=>'late content'});await flush();assert.equal(f.states[0],'正在读取…');assert.equal(f.states[1],false);
});

test('NOTICE read failures show only fixed local guidance',async()=>{
  const f=noticeFixture(async()=>{throw Error('https://private.invalid secret');});await flush();assert.equal(f.states[1],true);assert.match(source,/本地预览暂不可用，原文件仍保留，可下载后查看/);f.cleanup();
});

test('canvas previews retain explicit downloads and close without generation or billing actions',()=>{
  const dialog=source.slice(source.indexOf('function PreviewDialog('),source.indexOf('function Ports('));
  assert.match(dialog,/onCancel=.*onClose/);assert.match(dialog,/<button autoFocus onClick=\{onClose\}>关闭/);assert.match(dialog,/download=\{preview\.kind==='text'\?'NOTICE.txt':true\}/);assert.match(dialog,/preload="metadata"/);
  assert.doesNotMatch(dialog,/post\(|method:'POST'|execute\(|quote|confirm|iframe|target=/);
  assert.match(source,/useEffect\(\(\)=>setPreview\(null\),\[connection\.revision\]\)/);
});
