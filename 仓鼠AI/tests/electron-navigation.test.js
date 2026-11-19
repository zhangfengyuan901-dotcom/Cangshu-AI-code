const {test}=require('node:test'),assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');
const {installNavigationPolicy}=require('../electron/navigation.cjs');

function fixture(){
  const contents=new EventEmitter(),opened=[];
  contents.setWindowOpenHandler=handler=>{contents.popup=handler;};
  installNavigationPolicy(contents,{appUrl:'http://127.0.0.1:12000/',openExternal:url=>{opened.push(url);}});
  function navigate(type,url,isMainFrame=true){
    let prevented=false;
    contents.emit(type,{url,isMainFrame,preventDefault(){prevented=true;}});
    return !prevented;
  }
  return {contents,opened,navigate};
}

test('self-owned pages stay in the single main window; subframes may only use loopback HTTP',()=>{
  const f=fixture();
  for(const type of ['will-frame-navigate','will-redirect']){
    assert.equal(f.navigate(type,'http://127.0.0.1:12000/'),true);
    assert.equal(f.navigate(type,'http://127.0.0.1:12000/?view=history'),true);
    assert.equal(f.navigate(type,'http://127.0.0.1:13000/chat/',false),true);
    assert.equal(f.navigate(type,'http://127.0.0.1:14000/?project=fixture',false),true);
    for(const url of ['http://127.0.0.1:13000/chat/','https://app.chatcut.io/','file:///C:/private','javascript:alert(1)','data:text/html,fixture','http://localhost:12000/','http://127.0.0.1:80/','http://user:pass@127.0.0.1:12000/','http://127.0.0.1.evil.test:12000/','not a URL'])
      assert.equal(f.navigate(type,url),false,url);
    for(const url of ['https://example.test/','https://127.0.0.1:13000/','file:///C:/private','about:blank','http://user@127.0.0.1:14000/'])
      assert.equal(f.navigate(type,url,false),false,url);
  }
  assert.deepEqual(f.opened,[]);
});

test('all popup windows are denied; only approved external HTTPS shortcuts use OS browser',async()=>{
  const f=fixture();
  assert.deepEqual(f.contents.popup({url:'https://www.piknoai.com/console'}),{action:'deny'});
  for(const url of ['https://app.chatcut.io/','http://127.0.0.1:12000/','http://127.0.0.1:13000/chat/','https://example.test/','https://www.piknoai.com.evil.test/','https://user@www.piknoai.com/','http://www.piknoai.com/','file:///C:/private','javascript:alert(1)','bad'])assert.deepEqual(f.contents.popup({url}),{action:'deny'});
  await Promise.resolve();
  assert.deepEqual(f.opened,['https://www.piknoai.com/console']);
});

test('legacy redirect event arguments remain guarded and a failed OS shortcut is contained',async()=>{
  const f=fixture();let prevented=false;
  f.contents.emit('will-redirect',{preventDefault(){prevented=true;}},'https://example.test/',false,true);
  assert.equal(prevented,true);
  const contents=new EventEmitter();contents.setWindowOpenHandler=handler=>{contents.popup=handler;};
  installNavigationPolicy(contents,{appUrl:'http://127.0.0.1:12000/',openExternal:()=>{throw Error('synthetic');}});
  assert.deepEqual(contents.popup({url:'https://www.piknoai.com/console'}),{action:'deny'});
  await new Promise(resolve=>setImmediate(resolve));
});
