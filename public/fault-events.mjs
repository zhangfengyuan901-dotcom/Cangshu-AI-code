// Browser errors can contain customer text. Report only a fixed event category.
export function installFaultEvents(endpoint='/api/error-report') {
  let next=0;
  const report=()=>{
    if(Date.now()<next)return;next=Date.now()+60000;
    void fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({module:'interface',code:'UNEXPECTED'})}).catch(()=>{});
  };
  window.addEventListener('error',report);
  window.addEventListener('unhandledrejection',report);
}
