const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const {execFile} = require('node:child_process');
const {StringDecoder} = require('node:string_decoder');

const MESSAGES = {
  PATH_TOO_LONG:'运行环境路径超出系统支持范围，请联系支持',
  RUNTIME_EXTRACT_TIMEOUT:'运行环境释放超时，请检查磁盘与安全软件后重试',
  RUNTIME_EXTRACT_FAILED:'内置运行环境解压失败，请联系支持；无需自行安装运行环境',
  PORT_IN_USE:'工作台端口被占用，请稍后重试；不要随意结束其他程序',
  PORT_UNAVAILABLE:'无法使用本地工作台端口，请检查系统权限、安全软件或端口保留策略',
  PERMISSION_DENIED:'系统拒绝启动或访问所需文件，请检查文件权限、安全软件及端口保留策略',
  DEPENDENCY_MISSING:'Python 依赖缺失或无法加载，请检查首次环境安装是否完成',
  NETWORK_SETUP_FAILED:'环境准备遇到网络或证书错误，请检查网络、代理和安全软件',
  DISK_FULL:'磁盘空间不足，请清理空间后重试',
  RUNTIME_MISSING:'启动器、Python 或工作流文件缺失，请检查安装是否完整',
  WORKFLOW_MISSING:'未找到本地工作流文件，请检查安装是否完整或联系支持',
  WORKFLOW_VERSION_MISMATCH:'本地工作流版本不兼容，请检查安装是否完整',
  STARTUP_TIMEOUT:'本地工作台未在预期时间内通过健康检查，请稍后重试或联系支持',
  STARTUP_FAILED:'本地工作台启动失败，请稍后重试或联系支持',
};
const FAILURE_PATTERNS = [
  ['PATH_TOO_LONG',/ENAMETOOLONG|PathTooLongException/i],
  ['RUNTIME_EXTRACT_TIMEOUT',/RUNTIME_EXTRACT_TIMEOUT/i],
  ['RUNTIME_EXTRACT_FAILED',/RUNTIME_EXTRACT_FAILED|内置环境解压失败/i,/EACCES|EPERM|ENOSPC/i],
  ['PORT_IN_USE',/EADDRINUSE|10048|address already in use/i],
  ['PERMISSION_DENIED',/10013|EACCES|EPERM|PermissionError|permission denied|access is denied|拒绝访问/i],
  ['DEPENDENCY_MISSING',/ModuleNotFoundError|ImportError|no module named/i],
  ['NETWORK_SETUP_FAILED',/certificate|CERT_|SSL|TLS|connection|timed? ?out|name resolution|failed to download|failed to fetch|dns/i],
  ['DISK_FULL',/ENOSPC|no space left|disk full/i],
  ['RUNTIME_MISSING',/ENOENT|not found|no such file|cannot find|找不到/i],
];
const failureRank = text => FAILURE_PATTERNS.findIndex(([,match,exclude]) => match.test(text) && !exclude?.test(text));
function classifyFailure(text, fallback=MESSAGES.STARTUP_FAILED) {
  const code=FAILURE_PATTERNS[failureRank(text)]?.[0];
  return code ? {code,message:MESSAGES[code]} : {code:'STARTUP_FAILED',message:fallback};
}

const EVENTS = new Set([
  'desktop-start','desktop-ready','desktop-start-error','installed-runtime-ready','installed-runtime-reuse',
  'runtime-reuse','runtime-extract','runtime-ready','port-preflight','port-switch','launch','health-ready',
  'ready','stdout','stderr','spawn-error','process-close','prepare-error','reuse-service','stop','failure',
]);
const LOG_NAME='startup-safe.log';
const PORT_STATES=['available','occupied','restricted','unknown','own-service'];
const isTimestamp=value=>typeof value==='string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value);
const isVersion=value=>typeof value==='string' && /^(?:\d{1,3}\.\d{1,3}\.\d{1,3}(?:-QA|-internal\.\d{8}\.\d{1,3})?|test|unknown)$/.test(value);
const isPort=value=>Number.isInteger(value) && value>=1 && value<=65535;
const isCode=value=>typeof value==='string' && Object.hasOwn(MESSAGES,value);
const isExitCode=value=>Number.isInteger(value) && value>=0 && value<=0xffffffff;

function safeFields(value={}) {
  const fields={};
  if(isPort(value?.port))fields.port=value.port;
  if(isPort(value?.previous))fields.previous=value.previous;
  if(isVersion(value?.version) || Number.isSafeInteger(value?.version) && value.version>=0)fields.version=value.version;
  if(typeof value?.packaged==='boolean')fields.packaged=value.packaged;
  if(PORT_STATES.includes(value?.state))fields.state=value.state;
  if(PORT_STATES.includes(value?.reason))fields.reason=value.reason;
  if(['python-venv','uv-bootstrap','embedded'].includes(value?.runtime))fields.runtime=value.runtime;
  if(isCode(value?.code))fields.code=value.code;
  if(isExitCode(value?.exitCode))fields.exitCode=value.exitCode;
  if(typeof value?.signal==='string' && Object.hasOwn(os.constants.signals,value.signal))fields.signal=value.signal;
  return fields;
}

function safeFailure(value) {
  if(!value || typeof value!=='object')return null;
  const code=isCode(value.code)?value.code:'STARTUP_FAILED';
  const failure={code,message:MESSAGES[code]};
  if(isExitCode(value.exitCode))failure.exitCode=value.exitCode;
  if(isPort(value.port))failure.port=value.port;
  if(isTimestamp(value.at))failure.at=value.at;
  return failure;
}

function normalizePortCheck(value) {
  if(!value || !PORT_STATES.includes(value.state))return null;
  const check={state:value.state};
  if(isPort(value.port))check.port=value.port;
  if(Number.isSafeInteger(value.version) && value.version>=0)check.version=value.version;
  return check;
}

function normalizeDiagnosticChecks(value={}) {
  const service=['ready','starting','error','stopped'].includes(value?.service)?value.service:'unknown';
  const workflow={};
  for(const key of ['found','deferred','webEntry','manifest','python','bundledRuntime','bundledLauncher']){
    if(typeof value?.workflow?.[key]==='boolean')workflow[key]=value.workflow[key];
  }
  return {service,port:normalizePortCheck(value?.port),lastPortCheck:normalizePortCheck(value?.lastPortCheck),
    workflow,currentFailure:safeFailure(value?.currentFailure)};
}

async function portOwners(port) {
  if (process.platform !== 'win32') return [];
  return new Promise(resolve => {
    // Port is a validated integer; only inspect the processes owning this listener.
    const command = `$items = Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue; @($items | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object { $proc = Get-Process -Id $_ -ErrorAction SilentlyContinue; [PSCustomObject]@{pid=$_;name=$proc.ProcessName} }) | ConvertTo-Json -Compress`;
    execFile('powershell.exe',['-NoProfile','-NonInteractive','-Command',command],{windowsHide:true,timeout:5000,maxBuffer:8192},(err,stdout)=>{
      if (err) return resolve([]);
      try {const items=JSON.parse(stdout);resolve((Array.isArray(items)?items:[items]).filter(Boolean).map(x=>({pid:Number(x.pid),name:String(x.name || '未知进程').slice(0,100)})));}
      catch {resolve([]);}
    });
  });
}
async function inspectPort(port, host='127.0.0.1', owners=portOwners) {
  if (!Number.isInteger(port) || port<1 || port>65535 || host!=='127.0.0.1') throw new Error('诊断仅支持本机有效端口');
  const check=await new Promise(resolve=>{
    const probe=net.createServer();
    probe.once('error',error=>resolve({port,host,state:error.code==='EADDRINUSE'?'occupied':error.code==='EACCES'?'restricted':'unknown',code:error.code}));
    probe.listen({port,host,exclusive:true},()=>probe.close(()=>resolve({port,host,state:'available'})));
  });
  return {...check,owners:check.state==='occupied'?await owners(port):[]};
}

function createDiagnostics({dir,exportDir,version='unknown',maxBytes=512*1024,reporter}={}) {
  let persistenceError='', recent=[], lastFailure=null;
  function log(event,details) {
    if(!EVENTS.has(event))return;
    const entry={at:new Date().toISOString(),event,...safeFields(details)};
    const line=JSON.stringify(entry)+'\n';
    const bytes=Buffer.byteLength(line);
    if(bytes>maxBytes)return;
    recent.push(entry);recent=recent.slice(-200);
    try {
      fs.mkdirSync(dir,{recursive:true});
      const file=path.join(dir,LOG_NAME);
      const stat=fs.lstatSync(file,{throwIfNoEntry:false});
      if(stat && !stat.isFile())throw Error('Diagnostic log is not a regular file');
      if(stat && stat.size+bytes>maxBytes){
        const older=file+'.2',old=file+'.1';
        if(fs.existsSync(older))fs.unlinkSync(older);
        if(fs.existsSync(old))fs.renameSync(old,older);
        fs.renameSync(file,old);
      }
      fs.appendFileSync(file,line,{mode:0o600});persistenceError='';
    } catch {persistenceError='启动日志无法写入磁盘，诊断导出将使用本次运行的内存日志';}
  }
  function failure(value={}) {
    try{reporter?.capture('startup',{}, {code:value.code,exitCode:value.exitCode});}catch{}
    lastFailure=safeFailure({...value,at:new Date().toISOString()});
    log('failure',lastFailure);
    try {fs.writeFileSync(path.join(dir,'last-failure.json'),JSON.stringify(lastFailure,null,2),{mode:0o600});}catch{}
  }
  try {
    const file=path.join(dir,'last-failure.json');
    const stat=fs.lstatSync(file);
    if(stat.isFile() && stat.size<=8192)lastFailure=safeFailure(JSON.parse(fs.readFileSync(file,'utf8')));
  }catch{}
  function capture(stream,label,onObservation,enabled=()=>true) {
    if(!stream?.on)return ()=>{};
    const decoder=new StringDecoder('utf8');let pending='',overflow=false;
    const emit=text=>{
      if(!enabled())return;
      const line=text.replace(/\x1b\[[0-9;]*[A-Za-z]/g,'');
      if(/prompt|nodeInfoList|messages\s*[:=]|api[_-]?key\s*[:=]|Authorization\s*[:=]|request body|response body/i.test(line))return;
      if(/^\s*(?:INFO:\s*)?Uvicorn running on\b/i.test(line)){onObservation?.({ready:true});return;}
      if(!/^\s*(?:[A-Za-z_.]*(?:Error|Exception)(?:\b|:)|error:|warning:|INFO:|Caused by:|×|╰|├|│|└)/i.test(line))return;
      const rank=failureRank(line);
      if(rank<0)return;
      const code=FAILURE_PATTERNS[rank][0];
      log(label,{code});
      onObservation?.({rank,failure:{code,message:MESSAGES[code]}});
    };
    const consume=text=>{
      for(const char of text){
        if(char==='\n'||char==='\r'){if(!overflow&&pending)emit(pending);pending='';overflow=false;}
        else if(!overflow){pending+=char;if(pending.length>16384){pending='';overflow=true;}}
      }
    };
    stream.on('data',chunk=>consume(decoder.write(chunk)));
    let flushed=false;
    const flush=()=>{if(flushed)return;flushed=true;consume(decoder.end());if(!overflow&&pending)emit(pending);pending='';};
    stream.on('end',flush);return flush;
  }
  function snapshot() {return {lastFailure,persistenceError};}
  function readLog(name) {
    const file=path.join(dir,name);
    try {
      const stat=fs.lstatSync(file);
      if(!stat.isFile() || stat.size>maxBytes)return [];
      return fs.readFileSync(file,'utf8').split('\n').flatMap(line=>{
        try {
          const entry=JSON.parse(line);
          return EVENTS.has(entry?.event) && isTimestamp(entry.at) ? [{at:entry.at,event:entry.event,...safeFields(entry)}] : [];
        }catch{return [];}
      });
    }catch{return [];}
  }
  function exportReport(checks={}) {
    const logs=[`${LOG_NAME}.2`,`${LOG_NAME}.1`,LOG_NAME].flatMap(readLog);
    const report={format:'hamster-startup-diagnostics-v2',exportedAt:new Date().toISOString(),
      appVersion:isVersion(version)?version:'unknown',
      system:{platform:process.platform,arch:process.arch,node:process.versions.node,electron:process.versions.electron || null},
      ...snapshot(),checks:normalizeDiagnosticChecks(checks),logs:persistenceError?[...logs,...recent]:logs.length?logs:recent};
    const content=JSON.stringify(report,null,2);
    fs.mkdirSync(exportDir,{recursive:true});
    const fileName=`仓鼠AI-启动诊断-${Date.now()}-${require('node:crypto').randomBytes(3).toString('hex')}.json`;
    const localPath=path.join(exportDir,fileName);
    fs.writeFileSync(localPath,content,{flag:'wx',mode:0o600});
    return {fileName,localPath,content};
  }
  return {log,failure,capture,snapshot,exportReport};
}
module.exports={createDiagnostics,inspectPort,classifyFailure,normalizeDiagnosticChecks,normalizePortCheck};
