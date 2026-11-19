// The upload boundary accepts no free-form text, payloads, identifiers or file paths.
const MODULES = ['startup','desktop','interface','service','generation','chat','creative'];
const CODES = ['UNEXPECTED','STARTUP_FAILED','STARTUP_TIMEOUT','WORKFLOW_MISSING','PATH_TOO_LONG','RUNTIME_EXTRACT_TIMEOUT','RUNTIME_EXTRACT_FAILED','PORT_IN_USE','PERMISSION_DENIED','DEPENDENCY_MISSING','NETWORK_SETUP_FAILED','DISK_FULL','RUNTIME_MISSING','AUTH_FAILED','RATE_LIMITED','REQUEST_FAILED','TASK_FAILED','RESULT_FAILED','RENDERER_CRASH','PROCESS_CRASH','TEST_REPORT'];
const FILES = ['main.cjs','server.js','tasks.cjs','assets.cjs','runtime.cjs','installed-runtime.cjs','inference.cjs','media.cjs','app.js','core.mjs','chat.py','creative.py','studio.py','chat.js','creative.js'];
const pick = (list, value, fallback) => list.includes(value) ? value : fallback;
const number = (n,max) => Number.isInteger(n) && n >= 0 && n <= max ? n : 0;
function normalizeReport(input={}) {
  if(!input || typeof input!=='object')input={};
  return {
    format:1,
    version:/^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(input.version) ? input.version : '0.0.0',
    module:pick(MODULES,input.module,'service'), code:pick(CODES,input.code,'UNEXPECTED'),
    platform:pick(['win32','darwin','linux'],input.platform,'win32'),
    arch:pick(['x64','arm64','ia32'],input.arch,'x64'),
    httpStatus:number(input.httpStatus,599), exitCode:number(input.exitCode,4294967295),
    frames:(Array.isArray(input.frames)?input.frames:[]).slice(0,6)
      .filter(f=>f && FILES.includes(f.file)).map(f=>({file:f.file,line:number(f.line,100000)})),
  };
}
function codeFor(error) {
  const status=Number(error?.statusCode || error?.status_code || error?.status);
  if(status===401 || status===403)return 'AUTH_FAILED';
  if(status===429)return 'RATE_LIMITED';
  if(status>=400)return 'REQUEST_FAILED';
  return pick(CODES,error?.code,'UNEXPECTED');
}
function framesFromStack(stack) {
  const frames=[];
  for(const line of String(stack || '').split('\n').slice(1)) {
    const m=line.match(/(?:[/\\]|^)([\w.-]+\.(?:cjs|mjs|js|py)):(\d+)(?::\d+)?\)?$/);
    if(m && FILES.includes(m[1]))frames.push({file:m[1],line:Number(m[2])});
  }
  return frames.slice(0,6);
}
module.exports={normalizeReport,codeFor,framesFromStack};
