const API = '/api/hypit';
const RUNTIME_NAMES = {node:'Node.js',hypit:'Hypit',ffmpeg:'FFmpeg',ffprobe:'FFprobe',chrome:'Chrome',codex:'Codex'};
const RUNTIME_STATES = {ready:'已检测',missing:'缺失',unverified:'未验证',unsupported:'不兼容',error:'检测失败'};
const ACCOUNT_STATES = {connected:'已连接；模型调用权限仍需实际验证',disconnected:'未连接',unavailable:'接入资格尚未确认，本轮不启用个人账户登录',blocked:'接入资格尚未确认，本轮不启用个人账户登录',unverified:'尚未验证',connecting:'等待本人完成登录'};
const VIDEO_STATES = {awaiting_confirmation:'待用户确认费用',confirmed:'费用已确认，尚未提交',preparing:'准备中',submitting:'提交中',queued:'排队中',processing:'生成中',unknown:'提交或结果未确认；仅查询原任务',succeeded:'已完成',failed:'已明确失败；不自动重发'};

// Only a server-selected loopback Studio root may be embedded. Never accept a
// user-entered URL, credentials, another host, or a privileged app route.
export function safeStudioUrl(value,appOrigin=globalThis.location?.origin) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.origin === appOrigin || !/^\d+$/.test(url.port) || Number(url.port) < 1024 || Number(url.port) > 65535 || url.username || url.password || url.pathname !== '/' || url.search || !['','#comments'].includes(url.hash)) return null;
    return url.href;
  } catch { return null; }
}

export function hypitRequestTimeout(path) {
  switch(path) {
    case `${API}/studio/open`: return 40000;
    case `${API}/video/import-result`: return 180000;
    case `${API}/video/start`: return 150000;
    default: return 15000;
  }
}

export async function requestHypitJson(path, {method='GET',body}={}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), hypitRequestTimeout(path));
  try {
    const response = await fetch(path, {method,signal:controller.signal,credentials:'same-origin',headers:body === undefined ? undefined : {'Content-Type':'application/json'},body:body === undefined ? undefined : JSON.stringify(body)});
    if (!response.ok) throw new Error('hypit_request_failed');
    return await response.json();
  } finally { clearTimeout(timer); }
}

export function mountHypit(container, {request=requestHypitJson,document=container?.ownerDocument || globalThis.document,onAgentSubmit,newOperationId=()=>globalThis.crypto?.randomUUID?.()}={}) {
  if (!container || !document) throw new TypeError('Hypit container is required');
  const make = (tag, className='', text='') => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
  };
  const button = (text, action, primary=false) => {
    const node = make('button', `hypit-button${primary ? ' hypit-button-primary' : ''}`, text);
    node.type = 'button'; node.dataset.hypit = action;
    return node;
  };
  const root = make('section','hypit-workspace');
  root.setAttribute('aria-label','Hypit 内部工作区');
  const heading = make('header','hypit-heading');
  const title = make('div');
  title.append(make('h1','','Hypit'),make('p','hypit-subtitle','原版 Web Studio · 仓鼠视频适配'));
  const refreshButton = button('重新检查','refresh');
  heading.append(title,refreshButton);
  const notice = make('p','hypit-notice','仅供本人或公司内部使用。保留 Hypit 原界面与版权；不属于对外托管服务。个人 GPT 账户与 PIKNO 视频 Key 分开管理。');
  const feedback = make('p','hypit-feedback');
  feedback.dataset.hypit = 'feedback'; feedback.setAttribute('role','status'); feedback.setAttribute('aria-live','polite');
  const columns = make('div','hypit-columns');
  const runtime = make('section','hypit-card');
  runtime.append(make('h2','','运行环境'));
  const runtimeSummary = make('p','hypit-muted','正在读取本地状态…');
  runtimeSummary.dataset.hypit = 'runtime-state';
  const runtimeList = make('ul','hypit-runtime-list');
  runtimeList.dataset.hypit = 'runtime-items';
  runtime.append(runtimeSummary,runtimeList,make('p','hypit-muted','依赖检测不代表完整视频生成或导出已验收。缺失依赖不会自动下载。'));
  const account = make('section','hypit-card');
  account.append(make('h2','','个人 GPT 账户'));
  const accountSummary = make('p','hypit-muted','尚未验证');
  accountSummary.dataset.hypit = 'account-state';
  const loginButton = button('连接本人账户','login');
  account.append(accountSummary,loginButton,make('p','hypit-muted','仅通过官方登录流程连接。不在此处输入密码、Key 或令牌。连接状态不代表额外模型额度。'));
  columns.append(runtime,account);
  const projectsPanel = make('section','hypit-card');
  projectsPanel.append(make('h2','','本地项目'));
  const form = make('form','hypit-create-form');
  const projectInput = make('input','hypit-input');
  projectInput.type = 'text'; projectInput.maxLength = 80; projectInput.placeholder = '项目名称';
  projectInput.dataset.hypit = 'project-name'; projectInput.setAttribute('aria-label','项目名称');
  const createButton = button('创建项目','create',true);
  createButton.type = 'submit';
  form.append(projectInput,createButton);
  const projectList = make('div','hypit-project-list');
  projectList.dataset.hypit = 'project-list';
  projectsPanel.append(form,projectList,make('p','hypit-muted','创建和打开项目不提交视频生成，也不扣费。视频生成必须另行核对规格、报价，并明确确认；状态不明时只查询原任务。'));
  const agentPanel = make('section','hypit-card');
  agentPanel.append(make('h2','','GPT 编排'));
  const agentSummary = make('p','hypit-muted','连接能力尚未验证，暂不发送模型请求。');
  agentSummary.dataset.hypit = 'agent-state';
  const agentForm = make('form','hypit-agent-form');
  const agentInput = make('textarea','hypit-input hypit-prompt');
  agentInput.rows = 3; agentInput.maxLength = 12000; agentInput.placeholder = '描述本项目的编辑目标';
  agentInput.dataset.hypit = 'agent-prompt'; agentInput.setAttribute('aria-label','Hypit 编辑目标');
  const agentButton = button('发送到 GPT','agent-send',true); agentButton.type = 'submit';
  agentForm.append(agentInput,agentButton); agentPanel.append(agentSummary,agentForm);
  const videoPanel = make('section','hypit-card');
  videoPanel.append(make('h2','','视频适配 · 手动验证'),make('p','hypit-muted','GPT 接入未启用时，可独立验证视频适配。本面板仅创建一个文生视频镜头；不上传参考素材。每次收费都须明确确认。'));
  const videoToolbar = make('div','hypit-video-toolbar');
  const projectSelect = make('select','hypit-input');
  projectSelect.dataset.hypit = 'video-project'; projectSelect.setAttribute('aria-label','视频所属项目');
  const videoRefreshButton = button('读取线路与任务','video-refresh');
  videoToolbar.append(projectSelect,videoRefreshButton);
  const videoForm = make('form','hypit-video-form');
  const modelSelect = make('select','hypit-input'); modelSelect.dataset.hypit = 'video-model'; modelSelect.setAttribute('aria-label','视频线路');
  const durationSelect = make('select','hypit-input'); durationSelect.dataset.hypit = 'video-duration'; durationSelect.setAttribute('aria-label','视频时长');
  const resolutionSelect = make('select','hypit-input'); resolutionSelect.dataset.hypit = 'video-resolution'; resolutionSelect.setAttribute('aria-label','视频分辨率');
  const ratioSelect = make('select','hypit-input'); ratioSelect.dataset.hypit = 'video-ratio'; ratioSelect.setAttribute('aria-label','视频比例');
  const specRow = make('div','hypit-video-specs'); specRow.append(durationSelect,resolutionSelect,ratioSelect);
  const videoPrompt = make('textarea','hypit-input hypit-prompt'); videoPrompt.dataset.hypit = 'video-prompt'; videoPrompt.rows=3;videoPrompt.maxLength=12000;videoPrompt.placeholder='描述这个镜头的画面、动作与运镜';videoPrompt.setAttribute('aria-label','视频镜头描述');
  const operationLabel = make('p','hypit-muted'); operationLabel.dataset.hypit = 'video-operation';
  const videoQuoteButton = button('获取本镜头报价（不扣费）','video-quote',true);videoQuoteButton.type='submit';
  const newShotButton = button('新建下一镜头','video-new');
  const videoActions = make('div','hypit-video-actions');videoActions.append(videoQuoteButton,newShotButton);
  videoForm.append(modelSelect,specRow,videoPrompt,operationLabel,videoActions);
  const videoSummary = make('p','hypit-muted','请先选择项目并读取当前已发布的视频线路。');videoSummary.dataset.hypit='video-state';
  const videoOperations = make('div','hypit-video-operations');videoOperations.dataset.hypit='video-operations';
  videoPanel.append(videoToolbar,videoSummary,videoForm,make('h3','hypit-section-title','本项目任务与待确认费用'),videoOperations);
  const quoteDialog = make('dialog','hypit-quote-dialog');
  const quoteName = make('h2');quoteName.setAttribute('data-quote-name','');
  const quoteSpec = make('p','hypit-muted');quoteSpec.setAttribute('data-quote-spec','');
  const quoteRows = make('dl','hypit-quote-rows');quoteRows.setAttribute('data-quote-rows','');
  const quoteTotal = make('strong','hypit-quote-total');quoteTotal.setAttribute('data-quote-total','');
  const quoteStatus = make('p','hypit-muted');quoteStatus.setAttribute('data-quote-status','');
  const quoteAccept = button('确认费用并提交','quote-accept',true);quoteAccept.setAttribute('data-quote-accept','');
  const quoteCancel = button('取消，不生成','quote-cancel');quoteCancel.setAttribute('data-quote-cancel','');
  const quoteActions = make('div','hypit-video-actions');quoteActions.append(quoteCancel,quoteAccept);
  quoteDialog.append(quoteName,quoteSpec,quoteRows,quoteTotal,quoteStatus,quoteActions);
  const quoteConfirmation = createQuoteConfirmation({dialog:quoteDialog,document});
  const studioPanel = make('section','hypit-card hypit-studio-panel');
  studioPanel.hidden = true;
  const studioHeading = make('div','hypit-studio-heading');
  const studioTitle = make('h2','','Hypit Studio');
  const closeButton = button('关闭工作区','close');
  studioHeading.append(studioTitle,closeButton);
  const studioHost = make('div','hypit-studio-host');
  studioHost.dataset.hypit = 'studio-host';
  studioPanel.append(studioHeading,studioHost);
  const previewDialog=make('dialog','hypit-quote-dialog hypit-media-preview');previewDialog.dataset.hypit='video-preview';previewDialog.setAttribute('aria-label','本地视频预览');
  const previewTitle=make('h2','','本地视频预览'),previewMedia=make('video');previewMedia.dataset.hypit='video-preview-media';previewMedia.controls=true;previewMedia.preload='metadata';
  const previewError=make('p','hypit-muted','本地预览暂不可用，原视频仍保留，可下载后查看。');previewError.hidden=true;previewError.setAttribute('role','alert');
  const previewDownload=make('a','hypit-button','下载原视频');previewDownload.dataset.hypit='video-preview-download';previewDownload.download='';
  const previewClose=button('关闭','video-preview-close'),previewActions=make('div','hypit-video-actions');previewActions.append(previewDownload,previewClose);
  previewDialog.append(previewTitle,previewMedia,previewError,previewActions);
  root.append(heading,notice,feedback,columns,projectsPanel,agentPanel,videoPanel,studioPanel,quoteDialog,previewDialog);
  container.append(root);

  let snapshot = null, busy = false, destroyed = false, studio = null, selectedProjectId = '', agentBusy = false;
  let executionKey=null,executionScope=null,executionEpoch=0,statusReadVersion=0,statusRefresh=null;
  let videoModels=[],videoRevision=null,operations=[],videoLoaded=false,videoProjectId='',shotId=newOperationId(),shotRequestId=null,shotLocked=false,shotPayload=null,shotExecutionScope=null,shotNeedsReconciliation=false;
  const mustQueryRequests=new Set();
  const currentShot=()=>operations.find(item=>item.requestId===shotRequestId);
  const validVideoQuote=item=>quoteValid(item?.quote,{model:item?.model,quantity:1});
  const localVideoResult=item=>item?.status==='succeeded'&&typeof item.requestId==='string'&&/^[a-zA-Z0-9_-]{1,100}$/.test(item.requestId)&&item.result?.url===`${API}/video/operations/${item.requestId}/file`;
  const availableProject=()=>Array.isArray(snapshot?.projects)&&snapshot.projects.some(item=>item.id===projectSelect.value);
  const hasSpecs=()=>modelSelect.value && durationSelect.value && resolutionSelect.value && ratioSelect.value;
  const matchesExistingShot=()=>operations.some(item=>item.status!=='succeeded'&&item.model===modelSelect.value&&item.prompt===videoPrompt.value.trim()&&item.options?.duration===Number(durationSelect.value)&&item.options?.resolution===resolutionSelect.value&&item.options?.ratio===ratioSelect.value&&!(item.assetIds?.length));
  function fillSelect(select,items,selected,label=value=>value) {
    select.replaceChildren();
    for(const value of items) {const option=make('option','',String(label(value)));option.value=String(value);select.append(option);}
    select.value=items.map(String).includes(String(selected))?String(selected):String(items[0]??'');
  }
  function updateVideoSpecs() {
    const model=videoModels.find(item=>item.id===modelSelect.value);
    fillSelect(durationSelect,Array.isArray(model?.durations)?model.durations:[],durationSelect.value,value=>`${value} 秒`);
    fillSelect(resolutionSelect,Array.isArray(model?.resolutions)?model.resolutions:[],resolutionSelect.value);
    fillSelect(ratioSelect,Array.isArray(model?.ratios)?model.ratios:[],ratioSelect.value);
  }
  const permitted = () => snapshot?.enabled === true && snapshot?.internalOnly === true;
  const runtimeReady = () => permitted() && snapshot?.runtime?.state === 'ready';
  const canAgent = () => runtimeReady() && snapshot?.account?.state === 'connected' && snapshot?.agent?.available === true && typeof onAgentSubmit === 'function' && selectedProjectId;
  const say = (message,error=false) => { feedback.textContent = message; feedback.className = `hypit-feedback${error ? ' hypit-error' : ''}`; };
  function clearExecutionView() {
    executionEpoch++;quoteConfirmation.cancel();closeVideoPreview();
    quoteName.textContent='';quoteSpec.textContent='';quoteRows.replaceChildren();quoteTotal.textContent='';quoteStatus.textContent='';
    operations=[];videoModels=[];videoRevision=null;videoLoaded=false;mustQueryRequests.clear();
    shotNeedsReconciliation=shotLocked;
    fillSelect(modelSelect,[]);updateVideoSpecs();videoPrompt.value='';agentInput.value='';
    studioHost.replaceChildren();studio=null;selectedProjectId='';
    videoSummary.textContent='账户状态已变化或未能复核，请重新读取当前账户的线路与原任务。原任务和服务端记录均未删除。';
  }
  function controls() {
    const active=busy||Boolean(statusRefresh);
    refreshButton.disabled = active;
    projectInput.disabled = active || !permitted();
    createButton.disabled = active || !permitted();
    loginButton.disabled = active || !permitted() || snapshot?.account?.loginAvailable !== true || snapshot?.account?.state === 'connected';
    closeButton.disabled = active || !studio;
    agentInput.disabled = active || agentBusy || !canAgent();
    agentButton.disabled = active || agentBusy || !canAgent();
    projectSelect.disabled=active||!permitted();videoRefreshButton.disabled=active||!permitted()||!availableProject();
    for(const node of [modelSelect,durationSelect,resolutionSelect,ratioSelect,videoPrompt])node.disabled=active||!permitted()||!videoLoaded||shotLocked;
    const recoveringQuote=shotLocked&&shotPayload&&!currentShot()&&!shotNeedsReconciliation;
    videoQuoteButton.textContent=recoveringQuote?'重新核对原镜头报价（不扣费）':'获取本镜头报价（不扣费）';
    videoQuoteButton.disabled=busy||Boolean(statusRefresh)||!permitted()||!availableProject()||!videoLoaded||!hasSpecs()||!shotId||shotNeedsReconciliation||shotLocked&&!recoveringQuote||!recoveringQuote&&matchesExistingShot();
    newShotButton.disabled=active||!permitted()||!shotLocked||currentShot()?.status!=='succeeded';
    for (const row of projectList.children) {
      const open = row._hypitOpen;
      if (open) open.disabled = active || !runtimeReady();
    }
    for(const row of videoOperations.children)for(const action of row._hypitActions||[])action.disabled=active||!permitted();
  }
  function render() {
    if (destroyed) return;
    runtimeSummary.textContent = !snapshot ? '本地状态未验证，功能未启用。' : snapshot.enabled !== true ? '此安装尚未启用内部 Hypit 模块。' : snapshot.internalOnly !== true ? '内部使用范围尚未确认，功能未启用。' : snapshot.runtime?.state === 'ready' ? 'Studio 组件已检测；生成与导出依赖仍需分别核验。' : snapshot.runtime?.state === 'missing' ? '运行依赖不完整，请先准备缺失项。' : '运行环境尚未验证，暂不能打开 Studio。';
    runtimeList.replaceChildren();
    for (const item of Array.isArray(snapshot?.runtime?.items) ? snapshot.runtime.items : []) {
      const name = RUNTIME_NAMES[item?.id] || RUNTIME_NAMES[String(item?.name).toLowerCase()] || '运行组件';
      const state = RUNTIME_STATES[item?.state] || '未验证';
      runtimeList.append(make('li','',`${name}：${state}`));
    }
    accountSummary.textContent = ACCOUNT_STATES[snapshot?.account?.state] || '尚未验证';
    agentSummary.textContent = agentBusy ? '正在处理本项目的请求；不会自动确认视频收费。' : snapshot?.agent?.available === true && snapshot?.account?.state === 'connected' ? '打开一个项目后可发送编辑目标。视频收费仍需单独确认。' : '个人账户接入资格尚未确认；GPT 编排保持关闭，不发送模型请求。视频适配可独立手动验证。';
    projectList.replaceChildren();
    const projects = Array.isArray(snapshot?.projects) ? snapshot.projects.filter(project => typeof project?.id === 'string' && typeof project.name === 'string') : [];
    if (!projects.length) projectList.append(make('p','hypit-muted',snapshot ? '暂无本地项目。' : '项目列表尚未读取。'));
    for (const project of projects) {
      const row = make('div','hypit-project-row');
      const label = make('span','hypit-project-name',project.name);
      const open = button(studio?.projectId === project.id ? '重新打开' : '打开 Studio','open');
      open.dataset.projectId = project.id;
      open.addEventListener('click',() => openProject(project.id));
      row._hypitOpen = open;
      row.append(label,open); projectList.append(row);
    }
    fillSelect(projectSelect,projects.map(item=>item.id),projectSelect.value||videoProjectId,id=>projects.find(item=>item.id===id)?.name||'本地项目');
    if(projectSelect.value)videoProjectId=projectSelect.value;
    operationLabel.textContent=shotNeedsReconciliation?'原镜头标识已保留。请先在原账户读取并核对原任务，不更换标识重复提交。':shotLocked?'本镜头标识已固定。失败或状态不明时仅查询原任务，不更换标识重发。':'新镜头尚未报价；首次报价后固定任务标识。';
    renderVideoOperations();
    studioPanel.hidden = !studio;
    if (studio) studioTitle.textContent = `Hypit Studio · ${projects.find(project => project.id === studio.projectId)?.name || '本地项目'}`;
    controls();
  }
  function renderVideoOperations() {
    videoOperations.replaceChildren();
    if(!operations.length)videoOperations.append(make('p','hypit-muted',videoLoaded?'本项目暂无视频任务。':'请手动读取本项目任务。'));
    for(const item of operations) {
      const row=make('div','hypit-video-operation');
      row.append(make('strong','',typeof item.name==='string'?item.name:'视频任务'),make('p','hypit-muted',VIDEO_STATES[item.status]||'状态待核实'));
      if(validVideoQuote(item))row.append(make('p','hypit-video-cost',`本次预计费用 ${formatMoney(item.quote.total_cny)}`));
      const actions=make('div','hypit-video-actions');row._hypitActions=[];
      const addAction=(text,fn)=>{const action=button(text,'video-task-action');action.dataset.requestId=item.requestId;action.addEventListener('click',fn);actions.append(action);row._hypitActions.push(action);};
      if(item.status==='awaiting_confirmation'&&!mustQueryRequests.has(item.requestId)&&Number.isSafeInteger(videoRevision)) {
        if(validVideoQuote(item))addAction(`确认并提交（${formatMoney(item.quote.total_cny)}）`,()=>confirmVideo(item));
        else addAction('重新获取本任务报价（不扣费）',()=>requoteVideo(item));
      } else if(item.status==='confirmed'&&!mustQueryRequests.has(item.requestId)&&Number.isSafeInteger(videoRevision))addAction('提交已确认任务',()=>startConfirmedVideo(item));
      addAction('查询原任务',()=>queryVideo(item.requestId));
      if(localVideoResult(item)) {
        addAction('查看本地视频',()=>openVideoPreview(item));
        addAction('放入 Hypit Studio',()=>importVideoResult(item));
      }
      row.append(actions);videoOperations.append(row);
    }
  }
  function mergeOperation(value) {
    if(!value||typeof value.requestId!=='string'||typeof value.projectId!=='string'||value.projectId!==projectSelect.value)throw new Error('invalid_video_operation');
    const index=operations.findIndex(item=>item.requestId===value.requestId);
    if(index<0)operations.unshift(value);else operations[index]=value;
    return value;
  }
  async function readVideo() {
    if(!permitted()||!availableProject())return false;
    return operation(async current=>{
      videoLoaded=false;videoRevision=null;
      const projectId=projectSelect.value;
      const catalog=await request(`${API}/video/models`);
      if(!current())return;
      if(!Array.isArray(catalog?.models)||!Number.isSafeInteger(catalog?.revision))throw new Error('invalid_video_catalog');
      const result=await request(`${API}/video/operations?projectId=${encodeURIComponent(projectId)}`);
      if(!Array.isArray(result?.operations))throw new Error('invalid_video_operations');
      if(!current())return;
      videoModels=catalog.models.filter(item=>typeof item?.id==='string'&&typeof item.name==='string');videoRevision=catalog.revision;
      operations=result.operations.filter(item=>typeof item?.requestId==='string'&&item.projectId===projectId);videoLoaded=true;
      for(const item of operations)if(['awaiting_confirmation','confirmed'].includes(item.status))mustQueryRequests.delete(item.requestId);
      const recovered=operations.find(item=>item.operationId===`manual-${shotId}`);
      if(recovered){shotRequestId=recovered.requestId;shotNeedsReconciliation=false;}
      else if(shotNeedsReconciliation&&shotExecutionScope===executionScope){shotNeedsReconciliation=false;if(shotPayload)shotPayload={...shotPayload,revision:videoRevision};}
      fillSelect(modelSelect,videoModels.map(item=>item.id),modelSelect.value,id=>videoModels.find(item=>item.id===id)?.name||'视频线路');updateVideoSpecs();
      videoSummary.textContent=videoModels.length?'已读取当前线路。只读检查不代表真实视频生成验收成功。':'当前账户没有可用的视频线路，请检查视频 Key 分组及线路开放状态。';
      say('已读取视频线路和本项目任务。未提交生成请求。');
    },'未能读取视频线路或任务。请检查账户连接后重新读取。');
  }
  const quotePayload=item=>({projectId:item.projectId,operationId:item.operationId,revision:videoRevision,model:item.model,prompt:item.prompt,options:item.options,assetIds:Array.isArray(item.assetIds)?item.assetIds:[]});
  async function quoteVideo() {
    const recoveringQuote=shotLocked&&shotPayload&&!currentShot()&&!shotNeedsReconciliation;
    if(!permitted()||!availableProject()||!videoLoaded||!hasSpecs()||!shotId||shotNeedsReconciliation||shotLocked&&!recoveringQuote||!videoPrompt.value.trim()&&!recoveringQuote)return false;
    if(!recoveringQuote&&matchesExistingShot()){say('本项目已有相同镜头。请操作原任务，不更换标识重复提交。',true);return false;}
    return operation(async current=>{
      // Lock before sending: a lost response must not mint another operation ID.
      if(!shotPayload)shotPayload={projectId:projectSelect.value,operationId:`manual-${shotId}`,revision:videoRevision,model:modelSelect.value,prompt:videoPrompt.value.trim(),options:{duration:Number(durationSelect.value),resolution:resolutionSelect.value,ratio:ratioSelect.value},assetIds:[]};
      shotLocked=true;shotExecutionScope=executionScope;
      const result=await request(`${API}/video/quote`,{method:'POST',body:shotPayload});
      if(!current())return;
      mergeOperation(result);shotRequestId=result.requestId;
      say('已获取本镜头报价。请核对费用并明确确认后再生成。');
    },'报价状态未确认。镜头标识已保留，请先读取本项目任务；不要新建标识重复提交。');
  }
  async function requoteVideo(item) {
    if(!permitted()||!operations.includes(item)||item.status!=='awaiting_confirmation'||!Number.isSafeInteger(videoRevision))return false;
    return operation(async current=>{const value=await request(`${API}/video/quote`,{method:'POST',body:quotePayload(item)});if(current()){mergeOperation(value);say('已更新本任务报价。需要重新确认费用。');}},'报价更新未确认，请先查询原任务。');
  }
  async function confirmVideo(item) {
    if(!permitted()||!operations.includes(item)||item.status!=='awaiting_confirmation'||!validVideoQuote(item)||!Number.isSafeInteger(videoRevision))return false;
    return operation(async current=>{
      const projectId=projectSelect.value;
      const accepted=await quoteConfirmation.confirm({quote:item.quote,details:`视频 · ${item.options?.duration??''} 秒 · ${item.options?.resolution??''} · ${item.options?.ratio??''}`,isCurrent:()=>!destroyed&&projectSelect.value===projectId&&operations.includes(item)&&validVideoQuote(item)});
      if(!accepted||!current()){if(current())say('已取消确认。未发送视频生成请求。');return;}
      mustQueryRequests.add(item.requestId);
      await request(`${API}/video/confirm`,{method:'POST',body:{requestId:item.requestId,quoteId:item.quote.id,revision:videoRevision,confirmed:true}});
      if(!current())return;
      const value=await request(`${API}/video/start`,{method:'POST',body:{requestId:item.requestId,revision:videoRevision}});
      if(current()){mergeOperation(value);say(value.status==='unknown'?'提交状态未确认。后续仅查询原任务，不自动重发。':'本次提交处理已返回。后续仅查询原任务，不自动重发。');}
    },'确认或提交状态未确认。请先查询原任务，不要重复生成。');
  }
  async function startConfirmedVideo(item) {
    if(!permitted()||!operations.includes(item)||item.status!=='confirmed'||!Number.isSafeInteger(videoRevision))return false;
    return operation(async current=>{mustQueryRequests.add(item.requestId);const value=await request(`${API}/video/start`,{method:'POST',body:{requestId:item.requestId,revision:videoRevision}});if(current()){mergeOperation(value);say(value.status==='unknown'?'提交状态未确认，后续仅查询原任务。':'本次提交处理已返回；后续仅查询原任务。');}},'提交状态未确认，请先查询原任务，不要重复生成。');
  }
  async function queryVideo(requestId) {
    if(!permitted()||!operations.some(item=>item.requestId===requestId))return false;
    return operation(async current=>{const value=await request(`${API}/video/operations/${encodeURIComponent(requestId)}`);if(current()){mergeOperation(value);if(['awaiting_confirmation','confirmed'].includes(value.status))mustQueryRequests.delete(requestId);say('已查询原任务。未新建或重发生成请求。');}},'原任务查询暂未完成，请稍后查询同一任务。');
  }
  async function importVideoResult(item) {
    if(!permitted()||!operations.includes(item)||item.projectId!==projectSelect.value||!localVideoResult(item))return false;
    return operation(async current=>{
      const result=await request(`${API}/video/import-result`,{method:'POST',body:{requestId:item.requestId}});
      if(!current())return;
      mountStudio(result,item.projectId);
      if(!destroyed)say('已打开本地视频预览；原视频仍保留。本次未提交生成或扣费。');
    },'本地预览未完成，原视频仍保留；请检查本地媒体组件');
  }
  function closeVideoPreview(){
    previewMedia.pause();previewMedia.removeAttribute('src');previewMedia.load();previewDownload.removeAttribute('href');previewError.hidden=true;
    if(previewDialog.open)previewDialog.close();
  }
  function openVideoPreview(item){
    if(destroyed||!permitted()||!operations.includes(item)||item.projectId!==projectSelect.value||!localVideoResult(item))return false;
    closeVideoPreview();const url=`${API}/video/operations/${encodeURIComponent(item.requestId)}/file`;previewMedia.src=url;previewDownload.href=url;previewDialog.showModal();previewClose.focus();return true;
  }
  previewClose.addEventListener('click',closeVideoPreview);
  previewDialog.addEventListener('cancel',event=>{event.preventDefault();closeVideoPreview();});
  previewMedia.addEventListener('error',()=>{if(previewDialog.open)previewError.hidden=false;});
  async function readStatus() {
    const version=++statusReadVersion;
    try {
      const value = await request(`${API}/status`);
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_status');
      if(destroyed||version!==statusReadVersion)return;
      const scope=typeof value.execution?.scope==='string'?value.execution.scope:null;
      const key=value.execution&&Object.hasOwn(value.execution,'scope')&&(value.execution.scope===null||typeof value.execution.scope==='string')&&Number.isSafeInteger(value.execution.revision)?JSON.stringify([scope,value.execution.revision]):null;
      if(executionKey!==null&&key===null)throw new Error('invalid_execution');
      if(executionKey!==null&&key!==executionKey)clearExecutionView();
      executionKey=key;executionScope=scope;snapshot=value;
    } catch(error) { if(!destroyed&&version===statusReadVersion){snapshot=null;clearExecutionView();}throw error; }
  }
  async function operation(action, failure) {
    if (busy || statusRefresh || destroyed) return false;
    const epoch=executionEpoch,current=()=>!destroyed&&executionEpoch===epoch;
    busy = true; controls(); say('正在处理…');
    try { await action(current); return current(); }
    catch { if (current()) say(failure,true); return false; }
    finally { busy = false; render(); }
  }
  async function refresh() {
    if(destroyed)return false;
    if(statusRefresh)return statusRefresh;
    const wasBusy=busy;if(!wasBusy){busy=true;controls();say('正在读取本地状态…');}
    statusRefresh=(async()=>{
      try{await readStatus();if(!destroyed)say('已读取本地状态。未提交模型或视频生成请求。');return true;}
      catch{if(!destroyed)say('无法读取本地 Hypit 状态。请稍后重新检查。',true);return false;}
      finally{if(!wasBusy)busy=false;statusRefresh=null;render();}
    })();
    return statusRefresh;
  }
  async function createProject() {
    const name = projectInput.value.trim();
    if (!permitted() || !name || name.length > 80) { if (!busy) say('请先确认模块已启用，并填写 1～80 字的项目名称。',true); return false; }
    return operation(async() => {
      await request(`${API}/projects`,{method:'POST',body:{name}});
      if (destroyed) return;
      projectInput.value = '';
      await readStatus();
      if (!destroyed) say('项目列表已更新。未提交生成请求。');
    },'创建或读取项目未完成。请重新检查项目列表后再操作，避免重复创建。');
  }
  async function openProject(projectId) {
    if (!runtimeReady() || !snapshot.projects?.some(project => project.id === projectId)) return false;
    return operation(async current => {
      const result = await request(`${API}/studio/open`,{method:'POST',body:{projectId}});
      if(!current())return;
      mountStudio(result,projectId);
      if(!destroyed)say('已打开本地 Studio。预览不代表生成或导出已完成。');
    },'Studio 未能安全打开。请检查本地运行依赖后重试。');
  }
  function mountStudio(result,projectId) {
    const url=safeStudioUrl(result?.url);
    if(!url||result?.projectId!==projectId)throw new Error('invalid_studio_url');
    if(destroyed)return;
    const frame=make('iframe','hypit-studio-frame');
    frame.title='Hypit Studio';frame.setAttribute('sandbox','allow-scripts allow-same-origin allow-downloads');
    frame.setAttribute('referrerpolicy','no-referrer');frame.src=url;
    studioHost.replaceChildren(frame);studio={projectId,url};selectedProjectId=projectId;
  }
  refreshButton.addEventListener('click',refresh);
  videoRefreshButton.addEventListener('click',readVideo);
  modelSelect.addEventListener('change',()=>{updateVideoSpecs();controls();});
  for(const node of [durationSelect,resolutionSelect,ratioSelect,videoPrompt])node.addEventListener('input',controls);
  videoForm.addEventListener('submit',event=>{event.preventDefault();quoteVideo();});
  newShotButton.addEventListener('click',()=>{if(busy||currentShot()?.status!=='succeeded')return;shotId=newOperationId();shotRequestId=null;shotLocked=false;shotPayload=null;videoPrompt.value='';render();});
  projectSelect.addEventListener('change',()=>{if(busy)return;closeVideoPreview();videoProjectId=projectSelect.value;videoLoaded=false;videoModels=[];operations=[];videoRevision=null;shotId=newOperationId();shotRequestId=null;shotLocked=false;shotPayload=null;shotExecutionScope=null;shotNeedsReconciliation=false;fillSelect(modelSelect,[]);updateVideoSpecs();videoSummary.textContent='项目已切换，请重新读取当前项目的视频线路与任务。';render();});
  form.addEventListener('submit',event => { event.preventDefault(); createProject(); });
  loginButton.addEventListener('click',() => {
    if (!permitted() || snapshot?.account?.loginAvailable !== true || snapshot?.account?.state === 'connected') return;
    operation(async() => {
      await request(`${API}/account/login`,{method:'POST',body:{}});
      await readStatus();
      if (!destroyed) say('请在官方登录页面完成本人授权，然后重新检查。');
    },'登录流程未能启动。请重新检查本机连接资格与登录状态。');
  });
  closeButton.addEventListener('click',() => {
    if (!studio) return;
    operation(async() => {
      await request(`${API}/studio/close`,{method:'POST',body:{}});
      if (destroyed) return;
      studioHost.replaceChildren(); studio = null; selectedProjectId = '';
      say('工作区已关闭。关闭页面不等于取消已提交的任务或退款。');
    },'工作区关闭未确认，请重新检查。');
  });
  agentForm.addEventListener('submit',async event => {
    event.preventDefault();
    const prompt = agentInput.value.trim();
    if (agentBusy || busy || !canAgent() || !prompt) return;
    agentBusy = true; render(); say('正在发送本项目的编辑目标…');
    try {
      await onAgentSubmit({projectId:selectedProjectId,prompt});
      if (!destroyed) { agentInput.value = ''; say('编辑请求已交接。实际结果请查看项目任务；不会自动确认视频收费。'); }
    } catch { if (!destroyed) say('编辑请求状态未确认。请先检查项目任务，不要重复发送。',true); }
    finally { agentBusy = false; render(); }
  });
  render();
  const ready = refresh();
  return {ready,refresh,destroy() { destroyed = true;quoteConfirmation.cancel();closeVideoPreview();studioHost.replaceChildren();root.remove(); }};
}
import {createQuoteConfirmation} from './quote-ui.mjs';
import {formatMoney,quoteValid} from './canvas-pricing.mjs';

