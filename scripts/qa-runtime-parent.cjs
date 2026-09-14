// Disposable parent used to verify the Windows process-handle watchdog.
const {spawn}=require('node:child_process');
const [python,bootstrap,workflow,port]=process.argv.slice(2);
const child=spawn(python,['-I','-B',bootstrap,workflow,'--port',port],{cwd:workflow,windowsHide:true,stdio:'ignore',
  env:{...process.env,HAMSTER_PARENT_PID:String(process.pid),HAMSTER_SERVICE_INSTANCE:'qa-parent-watchdog'}});
child.once('spawn',()=>process.send({pid:child.pid}));
child.once('error',()=>process.exit(1));
setInterval(()=>{},1000);
