'use strict';
const orderedIds=entries=>[...new Set((entries||[]).map(entry=>typeof entry==='string'?entry:entry?.tabId).filter(Boolean))];

/** Parent DnD reads this captured boundary; this module neither measures DOM
 * nor writes group/layout state. `at` is an insertion slot AFTER removing source IDs,
 * exactly like horizontalInsertIndex; end is the inclusive last allowed slot. */
function paneStripGroupDragBoundary(groups,{sourceIds,order}={}) {
  const ids=orderedIds(sourceIds),shown=orderedIds(order),selected=new Set(ids);
  const touched=(groups||[]).filter(group=>(group.tabIds||[]).some(id=>selected.has(id)));
  if(!touched.length)return {kind:'free'};
  if(touched.length!==1)return {kind:'blocked',reason:'mixed-group-sources'};
  const group=touched[0],members=orderedIds(group.tabIds);
  if(ids.some(id=>!members.includes(id)))return {kind:'blocked',reason:'mixed-group-sources'};
  const positions=members.map(id=>shown.indexOf(id));
  if(positions.some(index=>index<0))return {kind:'blocked',reason:'group-members-not-in-strip'};
  const first=Math.min(...positions),start=shown.slice(0,first).filter(id=>!selected.has(id)).length;
  // A legacy group can have foreign holes. Preserve those holes and the
  // source's no-op slot; counting only members would compact it by accident.
  const end=shown.slice(0,Math.max(...positions)+1).filter(id=>!selected.has(id)).length;
  return {kind:'group',groupId:group.id,groupRevision:group.revision ?? 1,memberIds:members,
    sourceIds:ids,start,end,
    wholeGroup:members.length===ids.length,allowIndividualExternal:false};
}
function clampPaneStripGroupInsertion(boundary,at) {
  if(boundary.kind==='blocked')return null;
  if(boundary.kind!=='group')return at;
  return Math.max(boundary.start,Math.min(boundary.end,Number.isInteger(at)?at:boundary.start));
}

module.exports={paneStripGroupDragBoundary,clampPaneStripGroupInsertion};
