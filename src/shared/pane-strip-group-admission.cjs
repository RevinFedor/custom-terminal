'use strict';

const {stableJson}=require('./workflow-organization.cjs');
const {validatePaneStripColorGroups,paneStripColorGroupsBasis,paneStripLayoutOwner}=require('./pane-strip-color-groups.cjs');
const fail=reason=>{const code='workflow_drag_strip_group_release_'+reason;throw Object.assign(Error(code),{code,statusCode:409});};
const same=(a,b)=>stableJson(a)===stableJson(b);
const blank=()=>({version:1,revision:0,groups:[]});
const id=value=>typeof value==='string'&&value.length>0;
const order=slots=>slots.map(slot=>slot?.tabId?['tab',slot.projectId??null,slot.tabId]:['chooser',slot?.slotId??null]);

function paneStripReleaseOwner(owner) {
  if(!owner||Object.keys(owner).some(key=>!['paneIndex','windowId','centerKey'].includes(key)))fail('owner_changed');
  if(owner.paneIndex===null) {
    if(!id(owner.centerKey)||owner.windowId!=null)fail('owner_changed');
  } else if(!Number.isSafeInteger(owner.paneIndex)||owner.paneIndex<0
    ||owner.windowId!=null&&!id(owner.windowId)||owner.centerKey!=null)fail('owner_changed');
  return {paneIndex:owner.paneIndex,windowId:owner.windowId??null,centerKey:owner.centerKey??null};
}

/** Inventory of logical slots, including retained/hidden/profile owners. Focus,
 * geometry, selected-first direction and slot extensions are not order proof. */
function paneStripReleaseOwners(layout={},path=[]) {
  const result=[];
  for(const [paneIndex,pane] of (layout.splitPanes||[]).entries()) {
    if(!pane)continue;
    result.push({path,owner:{paneIndex,windowId:pane.windowId||null,centerKey:null},
      slots:Array.isArray(pane.tabs)?pane.tabs:pane.tabId?[{projectId:pane.projectId,tabId:pane.tabId}]:[]});
  }
  for(const [centerKey,slots] of Object.entries(layout.centerStrips||{}))if(Array.isArray(slots))
    result.push({path,owner:{paneIndex:null,windowId:null,centerKey},slots});
  if(!layout.splitPanes?.length&&!Object.keys(layout.centerStrips||{}).length&&layout.activeSpaceTab?.tabId)
    result.push({path,owner:{paneIndex:null,windowId:null,centerKey:layout.activeProjectId||layout.activeSpaceTab.projectId},slots:[layout.activeSpaceTab]});
  for(const [key,profile] of Object.entries(layout.windowDisplayLayouts||{}))if(profile)
    result.push(...paneStripReleaseOwners(profile,[...path,key]));
  return result;
}
const ownerKey=entry=>stableJson([entry.path,entry.owner.windowId?['window',entry.owner.windowId]
  :entry.owner.paneIndex===null?['center',entry.owner.centerKey]:['pane',entry.owner.paneIndex]]);

function resolvedOwner(layout,owner) {
  const value=paneStripLayoutOwner(layout,owner);
  if(!value)return null;
  const actual=value.pane?{paneIndex:value.paneIndex,windowId:value.pane.windowId||null,centerKey:null}
    :{paneIndex:null,windowId:null,centerKey:value.centerKey};
  return same(actual,owner)?value:null;
}

/** Reversible preview and released state use one pure rule. A free root joins
 * only strictly between peers. A grouped root can reorder at its own edge;
 * leaving its peers removes only that root. No foreign gap is auto-absorbed.
 * This value is an intent, never authority: Main recomputes it in its existing
 * transaction against current raw metadata, mixed slots and actual activity. */
function preparePaneStripGroupRelease({workflowId,field,beforeLayout,layout,rootTabIds,targetOwner,
  placementTabIds=rootTabIds,isActive=()=>undefined}) {
  if(!id(workflowId)||!beforeLayout||!layout||!Array.isArray(rootTabIds)||!rootTabIds.length
    ||rootTabIds.some(value=>!id(value))||new Set(rootTabIds).size!==rootTabIds.length)fail('invalid');
  const state=field===undefined?blank():validatePaneStripColorGroups(field);
  if(!Array.isArray(placementTabIds)||placementTabIds.some(value=>!id(value))
    ||new Set(placementTabIds).size!==placementTabIds.length||rootTabIds.some(value=>!placementTabIds.includes(value)))fail('invalid');
  const placements=new Set(placementTabIds);
  const roots=new Set(rootTabIds),activity=new Map(),active=tabId=>{
    if(!activity.has(tabId)){const value=isActive(tabId);activity.set(tabId,value===true?true:value===false?false:null);}
    return activity.get(tabId);
  };
  if(rootTabIds.some(tabId=>active(tabId)!==true))fail('source_changed');
  const owner=targetOwner==null?null:paneStripReleaseOwner(targetOwner);
  const before=paneStripReleaseOwners(beforeLayout),after=paneStripReleaseOwners(layout);
  let target=null,visible=[],first=-1,last=-1;
  if(owner) {
    target=resolvedOwner(layout,owner);if(!target)fail('owner_changed');
    if(!resolvedOwner(beforeLayout,owner)) {
      // An ordinary "beside" release creates one fresh window containing
      // exactly its moving roots. It cannot borrow an existing/reused owner,
      // absorb stationary tabs, manufacture a chooser, or rename the source.
      if(owner.paneIndex===null||!owner.windowId
        ||before.some(entry=>entry.owner.windowId===owner.windowId)
        ||target.slots.some(slot=>!slot?.tabId||!roots.has(slot.tabId)))fail('owner_changed');
    }
    visible=target.slots.filter(slot=>!slot?.tabId||active(slot.tabId)!==false);
    const ids=visible.filter(slot=>slot?.tabId).map(slot=>slot.tabId);
    if(new Set(ids).size!==ids.length)fail('owner_changed');
    const positions=visible.flatMap((slot,index)=>roots.has(slot?.tabId)?[index]:[]);
    if(positions.length!==rootTabIds.length)fail('source_changed');
    first=positions[0];last=positions.at(-1);
    if(last-first+1!==rootTabIds.length||!same(positions.map(index=>visible[index].tabId),rootTabIds))fail('source_order');
  } else if(after.some(entry=>entry.slots.some(slot=>roots.has(slot?.tabId))))fail('owner_changed');

  const byMember=new Map(state.groups.flatMap(group=>group.tabIds.map(tabId=>[tabId,group])));
  const left=visible[first-1],right=visible[last+1];
  const leftGroup=left?.tabId?byMember.get(left.tabId):null,rightGroup=right?.tabId?byMember.get(right.tabId):null;
  const incomingGroup=leftGroup&&leftGroup.id===rightGroup?.id?leftGroup:null;
  const contiguous=(group,assigned)=>{
    const members=new Set(group.tabIds.filter(tabId=>!roots.has(tabId)&&active(tabId)!==false));
    assigned.forEach(tabId=>members.add(tabId));
    const positions=visible.flatMap((slot,index)=>members.has(slot?.tabId)?[index]:[]);
    return members.size>0&&positions.length===members.size&&positions.at(-1)-positions[0]+1===members.size;
  };
  if(incomingGroup&&!contiguous(incomingGroup,rootTabIds))fail('not_contiguous');
  const assignments=rootTabIds.map(tabId=>{
    if(incomingGroup)return {tabId,groupId:incomingGroup.id};
    const group=byMember.get(tabId);
    if(!group||!owner)return {tabId,groupId:null};
    const selected=group.tabIds.filter(value=>roots.has(value));
    const peers=group.tabIds.filter(value=>!roots.has(value)&&active(value)!==false);
    // Edge reorder is internal only beside existing peers in the same source
    // owner. Moving all ordinary roots out is not an implicit whole-group action.
    const oldOwner=before.find(entry=>!entry.path.length&&same(entry.owner,owner)
      &&selected.every(value=>entry.slots.some(slot=>slot?.tabId===value)));
    return {tabId,groupId:oldOwner&&peers.length&&contiguous(group,selected)?group.id:null};
  });
  const destinations=new Map(assignments.map(value=>[value.tabId,value.groupId]));
  const changes=[],groups=[];
  for(const group of state.groups) {
    const removed=group.tabIds.filter(tabId=>roots.has(tabId)&&destinations.get(tabId)!==group.id);
    const added=rootTabIds.filter(tabId=>destinations.get(tabId)===group.id&&!group.tabIds.includes(tabId));
    if(!removed.length&&!added.length){groups.push(group);continue;}
    const tabIds=[...group.tabIds.filter(tabId=>!removed.includes(tabId)),...added];
    changes.push({groupId:group.id,added,removed});
    // Closed provenance keeps its group ID/color/extensions. An ordinary move
    // of every raw member leaves no group definition to own an empty set.
    if(tabIds.length)groups.push({...group,revision:group.revision+1,tabIds});
  }
  const nextState=changes.length?{...state,revision:state.revision+1,groups}:field;
  if(nextState!==undefined)validatePaneStripColorGroups(nextState);

  const touchedGroups=new Set([...changes.map(change=>change.groupId),...rootTabIds.map(tabId=>byMember.get(tabId)?.id).filter(Boolean)]);
  if(incomingGroup)touchedGroups.add(incomingGroup.id);
  const relevant=new Set([...placementTabIds,...state.groups.filter(group=>touchedGroups.has(group.id)).flatMap(group=>group.tabIds)]);
  const touched=entry=>entry.slots.some(slot=>relevant.has(slot?.tabId))
    ||owner&&!entry.path.length&&same(entry.owner,owner);
  const keys=new Set([...before.filter(touched),...after.filter(touched)].map(ownerKey));
  const scoped=entries=>entries.filter(entry=>keys.has(ownerKey(entry))).map(entry=>({path:entry.path,owner:entry.owner,slots:order(entry.slots)}));
  // Only roots move within this released footprint; another local owner edit
  // must have its own explicit intent instead of being smuggled with a join.
  for(const entry of before.filter(entry=>keys.has(ownerKey(entry)))) {
    const next=after.find(value=>ownerKey(value)===ownerKey(entry));
    const stationary=order(entry.slots.filter(slot=>!placements.has(slot?.tabId)));
    if(!next ? stationary.length!==0
      :!same(stationary,order(next.slots.filter(slot=>!placements.has(slot?.tabId)))))fail('order_changed');
  }
  for(const group of state.groups)for(const tabId of group.tabIds)active(tabId);
  for(const entry of [...before,...after].filter(entry=>keys.has(ownerKey(entry))))for(const slot of entry.slots)if(slot?.tabId)active(slot.tabId);
  const intent={version:2,workflowId,basis:paneStripColorGroupsBasis(field),rootTabIds:[...rootTabIds],placementTabIds:[...placementTabIds],targetOwner:owner,
    beforeOwners:scoped(before),afterOwners:scoped(after),activeBasis:[...activity].sort(([a],[b])=>a.localeCompare(b)),
    plan:{targetGroupId:incomingGroup?.id??null,assignments,changes},...(nextState===undefined?{}:{nextState})};
  return {intent,nextState};
}

function assertPaneStripGroupRelease(intent,context) {
  const prepared=preparePaneStripGroupRelease(context);
  if(!intent||!same(intent,prepared.intent))fail('changed');
  return prepared;
}

function paneStripGroupReleases(requested,raw) {
  if(raw===undefined)return new Map();
  if(!Array.isArray(raw))fail('invalid');
  const result=new Map();
  for(const intent of raw) {
    if(!intent||intent.version!==2||!id(intent.workflowId)||!requested.has(intent.workflowId)||result.has(intent.workflowId))fail('invalid');
    result.set(intent.workflowId,intent);
  }
  return result;
}

module.exports={preparePaneStripGroupRelease,assertPaneStripGroupRelease,paneStripGroupReleases,
  paneStripReleaseOwner,paneStripReleaseOwners};
