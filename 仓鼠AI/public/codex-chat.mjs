const node=(doc,tag,text,cls)=>{const el=doc.createElement(tag);if(text)el.textContent=text;if(cls)el.className=cls;return el;};
export function mountCodexChat(container,{request=fetch,setTimer=setTimeout,clearTimer=clearTimeout}={}){
  const doc=container.ownerDocument,root=node(doc,'div','','codex-chat');
  const sidebar=node(doc,'aside','','codex-sidebar'),main=node(doc,'div','','codex-main');
  const title=node(doc,'h2','本机 Codex'),notice=node(doc,'p','使用本机 CLI 的登录；发送内容可能通过其账户联网处理。始终只读，不修改文件或执行写入任务。','hint');
  const status=node(doc,'p','尚未检测','codex-status'),refresh=node(doc,'button','重新检测','plain-button subtle');refresh.type='button';
  const directory=node(doc,'input');directory.type='text';directory.placeholder='工程目录的完整路径';directory.setAttribute('aria-label','Codex 只读工程目录');
  const choose=node(doc,'button','选择目录','plain-button subtle');choose.type='button';
  const create=node(doc,'button','新建本机会话','plain-button');create.type='submit';
  const setup=node(doc,'form','','codex-setup'),directoryLabel=node(doc,'label','只读工作目录');directoryLabel.append(directory);setup.append(directoryLabel,choose,create);
  const list=node(doc,'nav','','codex-sessions');list.setAttribute('aria-label','Codex 独立会话');
  sidebar.append(title,node(doc,'span','独立会话 · 始终只读','codex-readonly'),notice,status,refresh,setup,node(doc,'p','最近会话','codex-session-label'),list);
  const heading=node(doc,'p','选择工程目录后新建会话。','codex-heading'),messages=node(doc,'div','','codex-messages');messages.setAttribute('aria-live','polite');
  const feedback=node(doc,'p','','codex-feedback');feedback.setAttribute('role','status');
  const input=node(doc,'textarea');input.maxLength=12000;input.rows=3;input.placeholder='提问或分析工程文件（只读）';input.setAttribute('aria-label','Codex 消息');
  const submit=node(doc,'button','发送','plain-button');submit.type='submit';
  const stop=node(doc,'button','停止','plain-button subtle');stop.type='button';
  const actions=node(doc,'div','','codex-actions');actions.append(submit,stop);
  const composer=node(doc,'form','','codex-composer');composer.append(input,actions);
  main.append(heading,messages,feedback,composer);root.append(sidebar,main);container.replaceChildren(root);
  function showEmpty(){
    const empty=node(doc,'section','','codex-empty'),mark=node(doc,'span','⌘','codex-empty-mark');mark.setAttribute('aria-hidden','true');
    empty.append(mark,node(doc,'h3','从一个问题开始'),node(doc,'p','选择工程目录并新建会话，一起阅读文件、分析问题，梳理下一步。'));
    messages.append(empty);
  }
  showEmpty();
  let current=null,sessions=[],ready=false,busy=false,visible=false,opened=false,timer=null,selection=0,closed=false;
  const running=()=>current?.status==='running';
  const activeId=()=>current?.id;
  async function api(path,options={}){
    const response=await request('/api/codex'+path,{cache:'no-store',signal:AbortSignal.timeout(20000),...options});
    if(!response.ok)throw Error('本机操作未确认，请查看原会话状态，勿重复发送。');
    return response.json();
  }
  const post=value=>({method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(value)});
  function controls(){
    submit.disabled=!ready||!current||busy||running()||!input.value.trim();stop.hidden=!running();stop.disabled=busy;
    create.disabled=busy;choose.disabled=busy;refresh.disabled=busy;directory.disabled=busy;
    input.disabled=busy||running();
  }
  function renderList(){
    list.replaceChildren();
    for(const session of sessions){const button=node(doc,'button',session.title||'本机会话',session.id===activeId()?'active':'');button.type='button';button.disabled=busy;button.onclick=()=>select(session.id);list.append(button);}
  }
  function render(){
    if(current){const index=sessions.findIndex(item=>item.id===current.id);if(index>=0)sessions[index]=current;else sessions.unshift(current);}
    heading.textContent=current?`${current.directory} · 始终只读`:'选择工程目录后新建会话。';
    messages.replaceChildren();
    for(const message of current?.messages||[]){
      if(!['user','assistant'].includes(message.role))continue;
      const item=node(doc,'article','',`codex-message ${message.role}`);item.append(node(doc,'strong',message.role==='user'?'你':'Codex'),node(doc,'pre',message.text||''));messages.append(item);
    }
    if(!(current?.messages||[]).some(message=>['user','assistant'].includes(message.role)))showEmpty();
    const state=current?.status;
    feedback.textContent=state==='running'?'正在只读分析，可随时停止。':state==='interrupted'?'本次已中断，未自动重新发送。':state==='unknown'?'本次结果暂未确认，未自动重新发送。':state==='failed'?'本次未完成，请检查本机 CLI 与网络后重试。':'';
    renderList();controls();
  }
  function schedule(){
    clearTimer(timer);timer=null;
    if(!visible||closed||!running())return;
    const id=activeId(),epoch=selection;
    timer=setTimer(async()=>{
      try{const value=await api('/sessions/'+encodeURIComponent(id));if(epoch===selection){current=value;render();}}
      catch{if(epoch===selection)feedback.textContent='暂时无法读取本机进度，请重新检测；不会重新发送消息。';}
      finally{schedule();}
    },1200);
  }
  async function select(id){
    if(busy)return;
    const epoch=++selection;clearTimer(timer);busy=true;controls();renderList();
    try{const value=await api('/sessions/'+encodeURIComponent(id));if(epoch!==selection)return;current=value;input.value='';render();schedule();}
    catch{feedback.textContent='无法读取本机会话，请稍后重试。';}
    finally{busy=false;controls();renderList();schedule();}
  }
  async function detect(){
    if(busy)return;
    busy=true;controls();status.textContent='正在检测本机 CLI…';
    try{
      const value=await api('/status');
      ready=value.available===true&&value.installed===true&&value.authState==='authenticated';
      const reason=value.errorCode==='CODEX_VERSION_UNSUPPORTED'?'此版本尚未通过只读兼容校验，暂不启用。':value.errorCode==='CODEX_LOGIN_MODE_UNSUPPORTED'?'请使用本机 CLI 的 ChatGPT 登录方式。':'登录状态未确认，请在本机 CLI 完成登录后重新检测。';
      status.textContent=!value.installed?'未检测到 Codex CLI，请先在本机安装。':ready?`Codex ${value.version||''} · 已检测到登录。此状态不代表联网或额度可用。`:`Codex ${value.version||''} · ${reason}`;
      const result=await api('/sessions');sessions=Array.isArray(result)?result:result.sessions||[];
      if(current){const found=sessions.find(item=>item.id===current.id);if(found)current=await api('/sessions/'+encodeURIComponent(current.id));}
      render();schedule();
    }catch{ready=false;status.textContent='无法检测本机 Codex，请检查安装后重试。';}
    finally{busy=false;controls();renderList();}
  }
  refresh.onclick=detect;
  choose.onclick=async()=>{
    if(busy)return;busy=true;controls();
    try{const result=await api('/directory',post({}));if(result.directory)directory.value=result.directory;else if(!result.available)feedback.textContent='当前运行方式请手动填写工程目录的完整路径。';}
    catch{feedback.textContent='无法选择目录，可手动填写完整路径。';}
    finally{busy=false;controls();}
  };
  setup.onsubmit=async event=>{
    event.preventDefault();if(busy||!directory.value.trim())return;busy=true;controls();
    try{current=await api('/sessions',post({directory:directory.value.trim()}));selection++;input.value='';sessions=await api('/sessions');render();}
    catch{feedback.textContent='无法创建本机会话，请检查所选工程目录。';}
    finally{busy=false;controls();renderList();}
  };
  input.addEventListener('input',controls);
  composer.onsubmit=async event=>{
    event.preventDefault();if(busy||!ready||!current||running()||!input.value.trim())return;
    const id=current.id,text=input.value,epoch=selection;busy=true;controls();
    try{
      const value=await api('/sessions/'+encodeURIComponent(id)+'/messages',post({text,requestId:crypto.randomUUID()}));
      if(epoch===selection){current=value;input.value='';render();}
    }catch{
      // Only read the original session after a lost response. Never retry a turn.
      try{const value=await api('/sessions/'+encodeURIComponent(id));if(epoch===selection){current=value;if(value.status==='running')input.value='';render();}}catch{}
      feedback.textContent='发送结果未确认，请查看原会话。未自动重新发送。';
    }finally{busy=false;controls();schedule();}
  };
  stop.onclick=async()=>{
    if(busy||!running())return;const id=current.id,epoch=selection;busy=true;controls();
    try{const value=await api('/sessions/'+encodeURIComponent(id)+'/stop',post({}));if(epoch===selection){current=value;render();}}
    catch{feedback.textContent='停止状态未确认，请查看原会话。';}
    finally{busy=false;controls();schedule();}
  };
  controls();
  return {
    async open(){visible=true;if(!opened){opened=true;await detect();}else schedule();},
    setVisible(value){visible=Boolean(value);schedule();},
    destroy(){closed=true;clearTimer(timer);container.replaceChildren();},
  };
}
