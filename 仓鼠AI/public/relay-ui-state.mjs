// Pure state shared by generation tools and canvas. Never surface remote messages.
export function toolAvailability({configured=false,checking=false,connection,lineState,model,catalogReady=false}={}) {
  if(!configured)return {state:'unconfigured',message:'请先到「个人中心」配置 PIKNO 工具 Key'};
  if(checking||!catalogReady)return {state:'checking',message:'正在检测工具线路，请稍候再上传'};
  if(connection?.state==='forbidden'||lineState==='forbidden')return {state:'forbidden',message:'工具 Key 没有此功能权限，请到 PIKNO 检查分组与授权'};
  if(lineState==='unpublished')return {state:'unpublished',message:'此工具线路尚未发布，请等待开放后再上传'};
  if(connection?.state==='error'||!connection)return {state:'error',message:'工具连接暂不可用，请重新检测线路后再上传'};
  if(lineState==='error')return {state:'error',message:'工具连接暂不可用，请重新检测线路后再上传'};
  if(!model)return {state:'unpublished',message:'此工具线路尚未开放或当前 Key 无调用权限，请重新检测线路'};
  if(connection.state!=='ready')return {state:'error',message:'工具连接暂不可用，请重新检测线路后再上传'};
  return {state:'ready',message:''};
}
export function batchIsActive(batch) {
  return Boolean(batch&&['accepted','running','submitting','pending'].includes(batch.status)&&!batch.stopped&&batch.remaining>0);
}
export function batchProgressText(batch) {
  if(batch?.stopped||batch?.status==='completed')return '';
  const submitted=Number.isSafeInteger(batch?.submitted)?batch.submitted:0,quantity=Number.isSafeInteger(batch?.quantity)?batch.quantity:0;
  return `批次已受理，已发送 ${submitted}/${quantity} 份。停止只影响尚未发送的份数。`;
}
