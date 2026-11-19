import {quoteValid,formatMoney,priceUnit} from './canvas-pricing.mjs';

export const quoteFingerprint=snapshot=>snapshot?JSON.stringify([snapshot.revision,snapshot.version,snapshot.payload,snapshot.context]):'';
export function createQuoteController({request,onChange=()=>{},isCurrent=()=>true,now=Date.now,delay=250}){
  const entries=new Map();
  const clear=entry=>{clearTimeout(entry?.timer);clearTimeout(entry?.expiry);entry?.resolve?.(null);if(entry)entry.start=null;};
  function state(key){const entry=entries.get(key);if(entry?.status==='ready'&&!quoteValid(entry.quote,{now:now(),model:entry.snapshot.payload.model,quantity:entry.snapshot.payload.concurrency})){entry.status='expired';onChange(key,entry);}return entry||{status:'empty',quote:null};}
  function prepare(key,snapshot){
    const prior=entries.get(key);
    if(!snapshot){clear(prior);entries.delete(key);if(prior)onChange(key,{status:'empty',quote:null});return null;}
    const fingerprint=quoteFingerprint(snapshot);
    if(prior?.fingerprint===fingerprint)return state(key);
    clear(prior);
    const entry={snapshot:JSON.parse(JSON.stringify(snapshot)),fingerprint,status:'preview',quote:null};
    entries.set(key,entry);onChange(key,entry);return entry;
  }
  function update(key,snapshot,{immediate=false,force=false,checkBalance=false}={}){
    if(!snapshot){const prior=entries.get(key);clear(prior);entries.delete(key);if(prior)onChange(key,{status:'empty',quote:null});return null;}
    const fingerprint=quoteFingerprint(snapshot),prior=state(key);
    if(!force&&prior.fingerprint===fingerprint){if(immediate&&prior.start)prior.start();return prior;}
    clear(prior);
    const entry={snapshot:JSON.parse(JSON.stringify(snapshot)),fingerprint,status:'loading',quote:null,timer:null,expiry:null,pending:null,start:null};
    entries.set(key,entry);onChange(key,entry);
    entry.pending=new Promise(resolve=>{
      entry.resolve=resolve;
      entry.start=()=>{
        if(!entry.start)return;entry.start=null;clearTimeout(entry.timer);
        if(entries.get(key)!==entry||!isCurrent(key,entry.snapshot)){resolve(null);return;}
        Promise.resolve().then(()=>request(entry.snapshot,{checkBalance})).then(result=>{
          if(entries.get(key)!==entry||entry.status!=='loading'||!isCurrent(key,entry.snapshot))return null;
          if(result?.revision!==entry.snapshot.revision||checkBalance&&result.balance_checked!==true||!quoteValid(result?.quote,{now:now(),model:entry.snapshot.payload.model,quantity:entry.snapshot.payload.concurrency}))throw Error('invalid quote');
          entry.quote=result.quote;entry.status='ready';
          entry.expiry=setTimeout(()=>{if(entries.get(key)===entry){entry.status='expired';onChange(key,entry);}},Math.min(2147483647,Math.max(1,result.quote.expires_at*1000-now())));
          entry.expiry.unref?.();onChange(key,entry);return entry.quote;
        }).catch(error=>{
          if(entries.get(key)===entry&&entry.status==='loading'&&isCurrent(key,entry.snapshot)){
            entry.status='error';
            entry.insufficientBalance=checkBalance&&error?.status===402&&error.code==='insufficient_balance';
            onChange(key,entry);
          }
          return null;
        }).then(resolve);
      };
      if(immediate)entry.start();else{entry.timer=setTimeout(()=>entry.start?.(),delay);entry.timer.unref?.();}
    });
    return entry;
  }
  async function ensure(key,snapshot){let entry=state(key);if(entry.status==='ready'&&entry.fingerprint===quoteFingerprint(snapshot))return entry.quote;entry=update(key,snapshot,{immediate:true,force:entry.status!=='loading'});if(!entry)return null;await entry.pending;return entries.get(key)===entry&&state(key).status==='ready'&&isCurrent(key,entry.snapshot)?entry.quote:null;}
  function invalidate(key,status='error'){const entry=entries.get(key);if(!entry)return;clear(entry);entry.status=status;entry.start=null;onChange(key,entry);}
  function reset(){for(const entry of entries.values())clear(entry);entries.clear();for(const key of ['generate','digital','depth'])onChange(key,{status:'empty',quote:null});}
  return {state,prepare,update,ensure,invalidate,reset,refresh:key=>{const entry=entries.get(key);return entry?update(key,entry.snapshot,{immediate:true,force:true}):null;}};
}

export function createQuoteConfirmation({dialog,document=globalThis.document,now=Date.now}){
  let active=null;
  function cancel(){active?.finish(false);}
  function confirm({quote,details='',isCurrent=()=>true}){
    if(active)return Promise.resolve(false);
    const name=dialog.querySelector('[data-quote-name]'),spec=dialog.querySelector('[data-quote-spec]'),rows=dialog.querySelector('[data-quote-rows]'),total=dialog.querySelector('[data-quote-total]'),status=dialog.querySelector('[data-quote-status]'),accept=dialog.querySelector('[data-quote-accept]'),reject=dialog.querySelector('[data-quote-cancel]');
    name.textContent=quote.name;spec.textContent=details;total.textContent=formatMoney(quote.total_cny);rows.replaceChildren();
    for(const [label,value] of [['单价',`${formatMoney(quote.unit_price_cny)}/${priceUnit(quote.unit)}`],['每份计量',`${quote.units} ${priceUnit(quote.unit)}`],['参考素材附加费',`${formatMoney(quote.reference_surcharge_cny)}/份`],['每份预计费用',formatMoney(quote.per_item_cny)],['任务份数',`${quote.quantity} 份`]]){
      const row=document.createElement('div'),key=document.createElement('dt'),text=document.createElement('dd');key.textContent=label;text.textContent=value;row.append(key,text);rows.append(row);
    }
    return new Promise(resolve=>{
      let done=false,timer;
      const valid=()=>isCurrent()&&quoteValid(quote,{now:now()});
      const check=()=>{accept.disabled=!valid();status.textContent=accept.disabled?'报价已失效或参数已变化。请取消后重新获取报价并确认。':'确认后提交本次任务；取消不会生成或扣费。';};
      const finish=value=>{if(done)return;done=true;clearInterval(timer);accept.removeEventListener('click',onAccept);reject.removeEventListener('click',onReject);dialog.removeEventListener('cancel',onCancel);dialog.removeEventListener('close',onClose);active=null;if(dialog.open)dialog.close();resolve(value);};
      const onAccept=()=>{check();if(!accept.disabled){accept.disabled=true;finish(true);}};
      const onReject=()=>finish(false),onCancel=event=>{event.preventDefault();finish(false);},onClose=()=>finish(false);
      active={finish};accept.addEventListener('click',onAccept);reject.addEventListener('click',onReject);dialog.addEventListener('cancel',onCancel);dialog.addEventListener('close',onClose);
      check();dialog.showModal();reject.focus();timer=setInterval(check,200);timer.unref?.();
    });
  }
  return {confirm,cancel};
}
