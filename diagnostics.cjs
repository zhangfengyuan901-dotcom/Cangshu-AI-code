const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const {execFile} = require('node:child_process');
const {StringDecoder} = require('node:string_decoder');

function classifyFailure(text, fallback='本地工作台启动失败，请导出诊断信息联系支持') {
  if (/ENAMETOOLONG|PathTooLongException/i.test(text)) return {code:'PATH_TOO_LONG',message:'运行环境路径超出系统支持范围，请导出诊断信息'};
  if (/RUNTIME_EXTRACT_TIMEOUT/i.test(text)) return {code:'RUNTIME_EXTRACT_TIMEOUT',message:'运行环境释放超时，请检查磁盘与安全软件并导出诊断信息'};
  if (/RUNTIME_EXTRACT_FAILED|内置环境解压失败/i.test(text) && !/EACCES|EPERM|ENOSPC/i.test(text)) return {code:'RUNTIME_EXTRACT_FAILED',message:'内置运行环境解压失败，请导出诊断信息；无需自行安装 Python'};
  if (/EADDRINUSE|10048|address already in use/i.test(text)) return {code:'PORT_IN_USE',message:'工作台端口被占用，请检查端口诊断；不要随意结束其他程序'};
  if (/10013|EACCES|EPERM|PermissionError|permission denied|access is denied|拒绝访问/i.test(text)) return {code:'PERMISSION_DENIED',message:'系统拒绝启动或访问所需文件，请检查文件权限、安全软件及端口保留策略'};
  if (/ModuleNotFoundError|ImportError|no module named/i.test(text)) return {code:'DEPENDENCY_MISSING',message:'Python 依赖缺失或无法加载，请检查首次环境安装是否完成'};
  if (/certificate|CERT_|SSL|TLS|connection|timed? ?out|name resolution|failed to download|failed to fetch|dns/i.test(text)) return {code:'NETWORK_SETUP_FAILED',message:'环境准备遇到网络或证书错误，请检查网络、代理和安全软件'};
  if (/ENOSPC|no space left|disk full/i.test(text)) return {code:'DISK_FULL',message:'磁盘空间不足，请清理空间后重试'};
  if (/ENOENT|not found|no such file|cannot find|找不到/i.test(text)) return {code:'RUNTIME_MISSING',message:'启动器、Python 或工作流文件缺失，请检查安装是否完整'};
  return {code:'STARTUP_FAILED',message:fallback};
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

function createDiagnostics({dir,exportDir,configPath,version='unknown',maxBytes=512*1024}={}) {
  const known=new Set();
  let persistenceError='', recent=[], lastFailure=null;
  const addSecrets = values => {
    for (const [key,value] of Object.entries(values || {})) if (/key|token|secret|password|authorization/i.test(key) && typeof value==='string' && value.length>=4) known.add(value);
  };
  addSecrets(process.env);
  function configuration() {try{return JSON.parse(fs.readFileSync(configPath,'utf8'));}catch{return {};}}
  addSecrets(configuration());
  function redact(value) {
    let text=String(value || '');
    addSecrets(configuration());
    for (const secret of known) text=text.split(secret).join('[REDACTED]');
    text=text.replace(/\x1b\[[0-9;]*[A-Za-z]/g,'');
    for (const home of [os.homedir().replace(/\\/g,'\\\\'),os.homedir(),os.homedir().replace(/\\/g,'/')]) text=text.split(home).join('%USERPROFILE%');
    return text.replace(/(?:sk[-_][\w-]{8,}|gh[pousr]_[\w]{10,}|github_pat_[\w_]+|AKIA[A-Z0-9]{16}|\b[a-f0-9]{32,}\b)/gi,'[REDACTED]')
      .replace(/(Bearer\s+)\S+/gi,'$1[REDACTED]')
      .replace(/((?:api[_-]?key|access[_-]?key|secret[_-]?key|token|password|authorization)\s*["']?\s*[:=]\s*)[^,\s}]+/gi,'$1[REDACTED]')
      .replace(/https?:\/\/[^\s"'<>]+/g,url=>{try{const u=new URL(url);return `${u.protocol}//${u.host}/[URL-PATH-REDACTED]`;}catch{return '[URL-REDACTED]';}});
  }
  function sanitize(value) {
    if(typeof value==='string')return redact(value);
    if(Array.isArray(value))return value.map(sanitize);
    if(value && typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,sanitize(item)]));
    return value;
  }
  function log(event,details='') {
    const line=`${new Date().toISOString()} [${event}] ${redact(typeof details==='string'?details:JSON.stringify(details))}`;
    recent.push(line);recent=recent.slice(-200);
    try {
      fs.mkdirSync(dir,{recursive:true});
      const file=path.join(dir,'startup.log');
      if(fs.existsSync(file) && fs.statSync(file).size+Buffer.byteLength(line)>maxBytes){
        const older=file+'.2',old=file+'.1';
        if(fs.existsSync(older))fs.unlinkSync(older);
        if(fs.existsSync(old))fs.renameSync(old,older);
        fs.renameSync(file,old);
      }
      fs.appendFileSync(file,line+'\n',{mode:0o600});persistenceError='';
    } catch {persistenceError='启动日志无法写入磁盘，诊断导出将使用本次运行的内存日志';}
  }
  function failure(value) {
    lastFailure=sanitize({...value,at:new Date().toISOString()});
    log('failure',lastFailure);
    try {fs.writeFileSync(path.join(dir,'last-failure.json'),JSON.stringify(lastFailure,null,2),{mode:0o600});}catch{}
  }
  try {lastFailure=JSON.parse(fs.readFileSync(path.join(dir,'last-failure.json'),'utf8'));}catch{}
  // Only initialization diagnostics are retained. Job-era stdout/stderr, source
  // code snippets and request payloads are not diagnostic material.
  function capture(stream,label,onLine,enabled=()=>true) {
    if(!stream?.on)return ()=>{};
    const decoder=new StringDecoder('utf8');let pending='',overflow=false;
    const emit=line=>{
      if(!enabled())return;
      if(/prompt|nodeInfoList|messages\s*[:=]|api[_-]?key\s*[:=]|Authorization\s*[:=]|request body|response body/i.test(line)) {log(label,'[敏感业务输出已省略]');return;}
      if(!/^\s*(?:Traceback|File ["']|[A-Za-z_.]*(?:Error|Exception)(?:\b|:)|error:|warning:|INFO:|ERROR:|WARNING:|Caused by:|Using |Resolved |Prepared |Installed |Downloading |Downloaded |Building |Built |×|╰|├|│|└)/i.test(line))return;
      const safe=redact(line);log(label,safe);onLine?.(safe);
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
  function exportReport(checks={}) {
    const cfg=configuration();
    const logs=[];
    for(const name of ['startup.log.2','startup.log.1','startup.log'])try{logs.push(fs.readFileSync(path.join(dir,name),'utf8'));}catch{}
    const report={format:'hamster-startup-diagnostics-v1',exportedAt:new Date().toISOString(),appVersion:version,
      privacy:'仅包含本地启动检查与脱敏日志。不包含 API Key、完整环境变量、提示词、任务记录、素材或生成文件。未自动上传。',
      system:{platform:process.platform,release:os.release(),arch:process.arch,node:process.versions.node,electron:process.versions.electron || null},
      configuration:{mediaKeyConfigured:!!cfg.apiKey,toolKeyConfigured:!!cfg.rhApiKey,intelligenceKeyConfigured:!!cfg.llmApiKey},
      ...snapshot(),checks,logs:persistenceError?[...logs,...recent]:logs.length?logs:recent};
    const content=JSON.stringify(sanitize(report),null,2);
    fs.mkdirSync(exportDir,{recursive:true});
    const fileName=`仓鼠AI-启动诊断-${Date.now()}-${require('node:crypto').randomBytes(3).toString('hex')}.json`;
    const localPath=path.join(exportDir,fileName);
    fs.writeFileSync(localPath,content,{flag:'wx',mode:0o600});
    return {fileName,localPath,content};
  }
  return {log,failure,redact,capture,addSecrets,snapshot,exportReport};
}
module.exports={createDiagnostics,inspectPort,classifyFailure};
