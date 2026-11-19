// Browser errors can contain customer text. Report only a fixed event category.
const ACCOUNT_CODES=new Set(['ACCOUNT_CONNECT_FAILED','ACCOUNT_KEY_IMPORT_FAILED','ACCOUNT_PAYMENT_UNKNOWN','ACCOUNT_KEY_CREATE_UNKNOWN']);
const accountNext=new Map();
export function reportAccountFailure(input) {
  if(!input||typeof input!=='object'||!ACCOUNT_CODES.has(input.code))return;
  const code=input.code,now=Date.now();
  if((accountNext.get(code)||0)>now)return;
  accountNext.set(code,now+60000);
  const httpStatus=Number.isInteger(input.httpStatus)&&input.httpStatus>=100&&input.httpStatus<=599?input.httpStatus:0;
  // No exception object, URL, account identity, Key, payment ID or user text crosses this boundary.
  try{
    void fetch('/api/error-report',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({module:'account',code,httpStatus})}).catch(()=>{});
  }catch{} // Feedback must never reject or retry the customer's operation.
}
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
