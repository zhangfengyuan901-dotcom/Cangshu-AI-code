// PIKNO prices are authoritative. This module only formats exact decimal text.
const amountPattern=/^(?:0|[1-9]\d{0,9})(?:\.\d{1,6})?$/;
export function formatMoney(value) {
  if(typeof value!=='string'||!amountPattern.test(value))return '—';
  const [whole,fraction='']=value.split('.');
  const decimals=fraction.replace(/0+$/,'').padEnd(2,'0');
  return `¥${whole}.${decimals}`;
}
export const priceUnit=unit=>({image:'张',second:'秒',request:'次'}[unit]||'');
export function quoteValid(quote,{now=Date.now(),quantity,model}={}) {
  return Boolean(quote&&typeof quote.id==='string'&&/^[a-zA-Z0-9_-]{8,80}$/.test(quote.id)
    &&quote.currency==='CNY'&&priceUnit(quote.unit)&&[1,2,4].includes(quote.quantity)
    &&Number.isSafeInteger(quote.price_version)&&quote.price_version>0
    &&Number.isSafeInteger(quote.units)&&quote.units>0
    &&Number.isSafeInteger(quote.expires_at)&&quote.expires_at*1000>now
    &&['unit_price_cny','reference_surcharge_cny','per_item_cny','total_cny'].every(key=>typeof quote[key]==='string'&&amountPattern.test(quote[key]))
    &&(quantity===undefined||Number(quantity)===quote.quantity)
    &&(model===undefined||(typeof model==='string'?model:model?.id)===quote.model));
}
export function quoteSummary(quote) {
  if(!quoteValid(quote))return '暂时无法确认费用，请重新获取报价';
  return `${formatMoney(quote.unit_price_cny)}/${priceUnit(quote.unit)} · 本次 ${quote.quantity} 份 · 预计费用 ${formatMoney(quote.total_cny)}`;
}
export function catalogPriceText(model,{size,resolution}={}) {
  if(model?.billing_mode!=='relay')return '';
  const prices=(Array.isArray(model.prices)?model.prices:[]).filter(p=>priceUnit(p?.unit)&&typeof p.retail_cny==='string'&&amountPattern.test(p.retail_cny));
  const selected=prices.find(p=>p.resolution===(size||resolution))||prices.find(p=>p.resolution==='default');
  if(selected)return `${formatMoney(selected.retail_cny)}/${priceUnit(selected.unit)}`;
  if(size||resolution)return '此规格暂无售价';
  if(prices.length===1)return `${formatMoney(prices[0].retail_cny)}/${priceUnit(prices[0].unit)}`;
  return prices.length?prices.map(p=>`${p.resolution==='auto'?'自动':p.resolution} ${formatMoney(p.retail_cny)}/${priceUnit(p.unit)}`).join('；'):'价格待确认';
}
export function pricingQuote(model, {duration, resolution, concurrency=1,quote}={}) {
  if (!model) return {text:'请选择线路', total:null};
  if (model.billing_mode==='relay') {
    const known=quoteValid(quote,{model,quantity:concurrency});
    return {known,external:true,text:known?quoteSummary(quote):'暂时无法确认费用，请获取当前报价',note:'预计费用以当前报价为准；确认后才提交生成',total:null,quote:known?quote:null};
  }
  const perSecond=model.price_per_second_by_resolution_credits?.[resolution] ?? model.display_price_yuan_per_second ?? model.price_per_second_credits;
  const fixed=model.price_by_resolution_credits?.[resolution] ?? model.display_price_yuan ?? model.price_credits;
  const unit=Number(perSecond ?? fixed);
  if (!Number.isFinite(unit) || (unit < 0 || unit === 0 && model.free !== true)) return {known:false,reason:'售价待确认',text:'售价待确认', total:null};
  const total=unit*(perSecond!=null?Number(duration||model.default_duration_seconds||4):1)*concurrency;
  return {known:true,currency:'CNY',min:total,max:total,note:'按已发布售价预冻结，成功交付后扣费',text:total===0?'免费':`¥${total.toFixed(2)}`, total, amount:total, label:perSecond!=null?`${unit}元/秒`:`${unit}元/次`};
}
