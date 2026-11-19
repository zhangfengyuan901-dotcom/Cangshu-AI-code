import {mediaCapabilities} from './core.mjs';
// PIKNO prices are authoritative. This module only formats exact decimal text.
const amountPattern=/^(?:0|[1-9]\d{0,9})(?:\.\d{1,6})?$/;
export function formatMoney(value) {
  if(typeof value!=='string'||!amountPattern.test(value))return '—';
  const [whole,fraction='']=value.split('.');
  const decimals=fraction.replace(/0+$/,'').padEnd(2,'0');
  return `¥${whole}.${decimals}`;
}
export const priceUnit=unit=>({image:'张',second:'秒',request:'次'}[unit]||'');
// A catalogue estimate is display-only. It never creates a signed quote.
export function estimatePrice(model,parameters={}) {
  const unknown=()=>({known:false,text:'预估￥？元'});
  if(!model||!parameters||typeof parameters!=='object'||Array.isArray(parameters)||model.billing_mode!=='relay'||model.currency!=='CNY')return unknown();
  const revision=model.line_revision??model.price_version;
  if(!Number.isSafeInteger(revision)||revision<1)return unknown();
  const tool=model.provider==='tool'||/^(?:pikno-)?tool-(?:digital|depth)$/.test(model.id||'');
  if(!['image','video'].includes(model.type)||tool&&model.type!=='video')return unknown();
  const quantity=Number(parameters.concurrency??1);
  if(!(tool?[1]:[1,2,4]).includes(quantity))return unknown();
  const counts=parameters.media_counts===undefined?{}:parameters.media_counts;
  if(!counts||typeof counts!=='object'||Array.isArray(counts))return unknown();
  const media=['images','videos','audios'].map(kind=>counts[kind]??0);
  const limits=mediaCapabilities(model),kinds=['image','video','audio'];
  if(media.some((count,index)=>!Number.isSafeInteger(count)||count<0||count>1000||limits[kinds[index]]!==undefined&&count>limits[kinds[index]])||limits.total!==undefined&&media.reduce((sum,count)=>sum+count,0)>limits.total)return unknown();
  const [images,videos,audios]=media;
  if(model.type==='image'&&(videos||audios))return unknown();
  if(['size','resolution'].some(field=>parameters[field]!==undefined&&typeof parameters[field]!=='string'))return unknown();
  const resolution=parameters.size||parameters.resolution||'',prices=Array.isArray(model.prices)?model.prices:[];
  const matches=prices.filter(price=>price?.resolution===resolution),defaults=prices.filter(price=>price?.resolution==='default');
  if(matches.length>1||!matches.length&&defaults.length>1)return unknown();
  const selected=matches[0]||defaults[0]||(prices.length===1&&['','auto','unspecified'].includes(resolution)?prices[0]:null);
  if(!selected||typeof selected.retail_cny!=='string'||!amountPattern.test(selected.retail_cny))return unknown();
  const unit=selected.unit;
  if(tool?unit!=='request':model.type==='image'?unit!=='image':!['second','request'].includes(unit))return unknown();
  let units=1;
  if(!tool&&model.type==='video'){
    const seconds=Number(parameters.duration);
    if(!Number.isSafeInteger(seconds)||seconds<1||!Array.isArray(model.durations)||!model.durations.includes(seconds))return unknown();
    if(unit==='second')units=seconds;
  }
  const micros=value=>{const [whole,fraction='']=value.split('.');return BigInt(whole)*1000000n+BigInt(fraction.padEnd(6,'0'));};
  const decimal=value=>`${value/1000000n}.${String(value%1000000n).padStart(6,'0')}`;
  const price=micros(selected.retail_cny);
  // Only the published depth tool has an explicit zero-price policy.
  if(price===0n&&!/^(?:pikno-)?tool-depth$/.test(model.id||''))return unknown();
  let surcharge=0n;
  if(!tool&&model.type==='video'&&images>0){
    if(typeof model.reference_surcharge_cny!=='string'||!amountPattern.test(model.reference_surcharge_cny))return unknown();
    surcharge=micros(model.reference_surcharge_cny);
  }
  const perItem=price*BigInt(units)+surcharge,total=perItem*BigInt(quantity);
  if(total>BigInt(Number.MAX_SAFE_INTEGER)||!amountPattern.test(decimal(total)))return unknown();
  const totalCny=decimal(total);
  return {known:true,currency:'CNY',unit,units,unit_price_cny:decimal(price),reference_surcharge_cny:decimal(surcharge),per_item_cny:decimal(perItem),quantity,total_cny:totalCny,text:`预估￥${formatMoney(totalCny).slice(1)}元`};
}
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
