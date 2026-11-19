// Synthetic customer confirmation for existing lifecycle fixtures only.
// Production never imports this module; price-specific tests call the raw API.
function syntheticQuote(parameters,name='已发布测试线路'){
  const units=parameters.operation==='video'?parameters.seconds:1;
  return {quote_id:'synthetic-signed-quote-'+require('node:crypto').randomUUID(),name,line_revision:1,currency:'CNY',unit:parameters.operation==='video'?'second':parameters.operation==='image'||parameters.operation==='image_edit'?'image':'request',unit_price_cny:'1',units,reference_surcharge_cny:'0',per_item_cny:String(units),quantity:parameters.quantity,total_cny:String(units*parameters.quantity),expires_at:Math.floor(Date.now()/1000)+300};
}
function withQuotedApi(raw,{canQuote=()=>true}={}){
  const cached=new Map();
  return async(route,body,headers={})=>{
    if(body&&/^\/api\/(?:images|videos|tools\/(?:digital|depth))$/.test(route)&&body.model&&!body.quote_id&&canQuote(route)){
      const defaults=route==='/api/videos'?{duration:5,resolution:'720p',ratio:'16:9'}:route==='/api/images'?{size:'1024x1024',aspect_ratio:'1:1',quality:'auto'}:{};
      const payload={...defaults,...body},identity=(headers['Idempotency-Key']||'')+JSON.stringify(payload);
      let quote=cached.get(identity);
      if(!quote){const response=await raw('/api/quotes',payload,headers);if(!response.ok)return response;quote=(await response.json()).quote;cached.set(identity,quote);}
      return raw(route,{...payload,quote_id:quote.id},headers);
    }
    return raw(route,body,headers);
  };
}
module.exports={syntheticQuote,withQuotedApi};
