// Adapted from BeatDesign canvas-projection.ts (Apache-2.0).
// Modified for HAMSTER's independent document schema; no provider or database dependency.
export const buildReferenceEdgeId=(sourceId,targetId)=>`reference:${sourceId}:${targetId}`;
// Measurements belong to the view, not the saved document. Losing them hides nodes
// until ResizeObserver runs again, including on every drag frame/server refresh.
export function reconcileViewNodes(nodes,previous,dragging=false){
  const old=new Map(previous.map(n=>[n.id,n]));
  return nodes.map(node=>{
    const prior=old.get(node.id);if(!prior)return node;
    const next={...node,measured:prior.measured,selected:prior.selected,dragging:prior.dragging};
    if(dragging)next.position=prior.position;
    if(JSON.stringify(next.data)===JSON.stringify(prior.data))next.data=prior.data;
    if(next.position.x===prior.position.x&&next.position.y===prior.position.y)next.position=prior.position;
    return Object.keys(next).every(key=>next[key]===prior[key])?prior:next;
  });
}
export const getAbsoluteNodePosition=(node,nodesById)=>{
  let {x,y}=node.position,parentId=node.parentId;const visited=new Set([node.id]);
  while(parentId&&!visited.has(parentId)){visited.add(parentId);const parent=nodesById.get(parentId);if(!parent)break;x+=parent.position.x;y+=parent.position.y;parentId=parent.parentId;}
  return {x,y};
};
