import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source=fs.readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
function section(start,end){const a=source.indexOf(start),b=source.indexOf(end,a);assert(a>=0&&b>a);return source.slice(a,b);}
const previewSection=section('const pendingMediaCards = new Map()','// ---- 提示词素材引用 ----');
function fixture(){
  const attrs=new Map(),listeners=new Map(),calls={refresh:0,removed:[],mentioned:[],revoked:[]};
  const list={children:[],hidden:true,append(card){this.children.push(card);card.list=this;},insertBefore(card,next){card.remove();this.children.splice(next?this.children.indexOf(next):this.children.length,0,card);card.list=this;},addEventListener:(name,handler)=>listeners.set(name,handler)};
  function card(html){
    const attributes=new Map([...html.matchAll(/(?:^|\s)(class|data-media-key)="([^"]*)"/g)].map(match=>[match[1],match[2]]));
    const progress={textContent:'',title:''},thumbnail={src:html.match(/<img src="([^"]*)"/)?.[1]},node={
      dataset:{mediaKey:attributes.get('data-media-key')},progress,thumbnail,childNodes:[progress,thumbnail],replacements:0,
      get attributes(){return [...attributes].map(([name,value])=>({name,value}));},
      getAttribute:name=>attributes.get(name),hasAttribute:name=>attributes.has(name),
      setAttribute(name,value){attributes.set(name,value);},removeAttribute(name){attributes.delete(name);},
      querySelector:selector=>selector==='[data-upload-progress]'?progress:null,
      replaceChildren(...children){this.childNodes=children;this.progress=children[0];this.thumbnail=children[1];this.replacements++;},
      remove(){if(this.list){const at=this.list.children.indexOf(this);if(at>=0)this.list.children.splice(at,1);delete this.list;}},
    };
    return node;
  }
  let mounted;
  const state={media:[],pendingMedia:[]};
  const context={state,performance:{now:()=>1000},KIND_LABEL:{image:'图片',video:'视频',audio:'音频'},
    $:()=>list,document:{createElement:()=>({set innerHTML(html){this.content={firstElementChild:card(html)};}})},
    escapeHtml:value=>String(value).replaceAll('&','&amp;').replaceAll('"','&quot;').replaceAll('<','&lt;').replaceAll('>','&gt;'),
    refreshIcons(){},renderMediaLimits(){},updateMentionMenu(){},
    mountMaterialPreview(container,options){mounted={container,...options};return {refresh(){calls.refresh++;}};},
    removeMedia:key=>calls.removed.push(key),insertMention:tag=>calls.mentioned.push(tag),
  };
  vm.createContext(context);vm.runInContext(previewSection,context);
  const render=()=>context.renderMedia();
  const previewButton=key=>({closest:selector=>selector==='[data-media-key]'?{dataset:{mediaKey:key}}:null});
  return {context,state,list,calls,render,previewButton,bind(){context.bindGenerationMedia();return mounted;},click(target){listeners.get('click')({target});}};
}

test('an uploading local image exposes a preview before transfer finishes without rebuilding progress or thumbnail nodes',()=>{
  const f=fixture(),pending={uiKey:'image-a',kind:'image',local:'blob:http://127.0.0.1:12345/fixture-a',name:'scene.png',loaded:10,total:100,startedAt:10};
  f.state.pendingMedia.push(pending);const bound=f.bind();f.render();
  const card=f.list.children[0],progress=card.progress,thumbnail=card.thumbnail;
  assert.match(card._mediaHtml,/data-material-preview/);assert.match(card._mediaHtml,/aria-label="预览图片：scene.png"/);
  assert.equal(bound.resolve(f.previewButton(pending.uiKey)).src,pending.local);
  assert.equal(progress.textContent.startsWith('10%'),true);assert.equal(f.list.hidden,false);
  pending.loaded=80;f.render();
  assert.equal(f.list.children[0],card);assert.equal(card.progress,progress);assert.equal(card.thumbnail,thumbnail);assert.equal(card.replacements,0);
  assert.match(progress.textContent,/^80%/);assert.equal(f.calls.refresh,2);
});

test('pending to ready retains the card identity and reveals only the original reference and remove actions',()=>{
  const f=fixture(),item={uiKey:'ready-a',kind:'image',local:'blob:http://127.0.0.1:12345/fixture-b',name:'portrait.png',loaded:100,total:100};
  f.state.pendingMedia.push(item);f.render();const card=f.list.children[0];
  assert.doesNotMatch(card._mediaHtml,/data-remove-media|data-tag=/);
  f.state.pendingMedia=[];f.state.media.push({...item,tag:'图片1',url:'controlled-upload'});f.render();
  assert.equal(f.list.children[0],card);assert.equal(card.replacements,1);
  assert.match(card._mediaHtml,/data-tag="图片1"/);assert.match(card._mediaHtml,/data-remove-media="ready-a"/);
  assert.match(card._mediaHtml,/aria-label="引用 @图片1 到提示词"/);
  assert.match(card._mediaHtml,/aria-label="移除素材：portrait.png"/);
});

test('preview resolution follows the current queue item and cannot return an image after its removal',()=>{
  const f=fixture(),bound=f.bind(),button=f.previewButton('same-key');
  f.state.pendingMedia.push({uiKey:'same-key',kind:'image',local:'blob:current-local',name:'first.png'});
  assert.equal(bound.resolve(button).name,'first.png');
  f.state.pendingMedia=[];f.state.media.push({uiKey:'same-key',kind:'image',local:'/api/assets/controlled/file',name:'saved.png'});
  assert.equal(bound.resolve(button).src,'/api/assets/controlled/file');
  f.state.media=[];assert.equal(bound.resolve(button),null);
  f.state.media.push({uiKey:'same-key',kind:'video',local:'blob:video'});assert.equal(bound.resolve(button).kind,'video');
  f.state.media=[{uiKey:'same-key',kind:'document',local:'blob:document'}];assert.equal(bound.resolve(button),null);
});

test('pending local video and audio expose the shared kind without creating eager media players',()=>{
  for(const kind of ['video','audio']){
    const f=fixture(),item={uiKey:'local-'+kind,kind,local:'blob:local-'+kind,name:kind+'.fixture',loaded:1,total:100};
    f.state.pendingMedia.push(item);const bound=f.bind();f.render();const card=f.list.children[0];
    assert.match(card._mediaHtml,/data-material-preview/);assert.doesNotMatch(card._mediaHtml,/<(?:video|audio)\b/);
    assert.equal(bound.resolve(f.previewButton(item.uiKey)).kind,kind);
    item.loaded=50;f.render();assert.equal(f.list.children[0],card);assert.equal(card.replacements,0);
  }
});

test('delegated preview clicks do not invoke removal or mention, while the two corner actions retain their existing behavior',()=>{
  const f=fixture();const mounted=f.bind();assert.equal(mounted.container,f.list);assert.equal(mounted.selector,'[data-material-preview]');
  f.click({closest:selector=>selector==='[data-material-preview]'?{}:null});
  assert.deepEqual(f.calls.removed,[]);assert.deepEqual(f.calls.mentioned,[]);
  f.click({closest:selector=>selector==='[data-remove-media]'?{dataset:{removeMedia:'current-key'}}:null});
  f.click({closest:selector=>selector==='.media-tag'?{dataset:{tag:'图片7'}}:null});
  assert.deepEqual(f.calls.removed,['current-key']);assert.deepEqual(f.calls.mentioned,['图片7']);
});

test('material names are escaped in both labels and visible captions; non-images do not create an image preview button',()=>{
  const f=fixture();f.state.media.push({uiKey:'escaped',kind:'image',name:'<img src=x onerror="invalid">',local:'/fixture.png',tag:'图片1'});f.render();
  assert.doesNotMatch(f.list.children[0]._mediaHtml,/<img src=x/);assert.match(f.list.children[0]._mediaHtml,/&lt;img src=x onerror=&quot;invalid&quot;&gt;/);
  f.state.media=[{uiKey:'video',kind:'video',name:'video.mp4',tag:'视频1'}];f.render();
  assert.doesNotMatch(f.list.children[0]._mediaHtml,/data-material-preview/);assert.match(f.list.children[0]._mediaHtml,/media-kind-label">视频/);
});

test('address-like names use a customer label without changing the stored source or reference tag',()=>{
  for(const name of ['http://127.0.0.1:12345/api/assets/fixture/file','https://fixture.invalid/private-image.png','blob:http://127.0.0.1:12345/fixture','/api/assets/fixture/file','C:\\fixture\\private.png']){
    const f=fixture(),item={uiKey:'address-name',kind:'image',name,url:name,tag:'图片3'};
    f.state.media.push(item);const bound=f.bind();f.render();
    const html=f.list.children[0]._mediaHtml;
    assert.match(html,/aria-label="预览图片：图片3"/);assert.match(html,/class="media-name" title="图片3">图片3</);
    assert.match(html,/aria-label="移除素材：图片3"/);
    assert.equal(bound.resolve(f.previewButton(item.uiKey)).name,'图片3');
    assert.equal(bound.resolve(f.previewButton(item.uiKey)).src,name);
    assert.equal(item.name,name);assert.equal(item.url,name);assert.equal(item.tag,'图片3');
  }
  const f=fixture(),bound=f.bind();f.state.pendingMedia.push({uiKey:'unnamed',kind:'image',name:'blob:fixture',local:'/fixture.png',loaded:1,total:100});f.render();
  assert.equal(bound.resolve(f.previewButton('unnamed')).name,'图片素材');
  assert.match(f.list.children[0].getAttribute('aria-label'),/^图片素材正在上传/);
});
