'use strict';
const {stableJson}=require('./workflow-organization.cjs');
const fail=code=>{const value='workflow_strip_groups_'+code;throw Object.assign(Error(value),{code:value,statusCode:409});};
const blank=()=>({version:1,revision:0,groups:[]});
function validatePaneStripColorGroups(value) {
  if(!value||value.version!==1)fail('forward_version');
  if(!Number.isSafeInteger(value.revision)||value.revision<0||!Array.isArray(value.groups))fail('invalid');
  const groups=new Set(),members=new Set();
  for(const group of value.groups) {
    if(!group||typeof group.id!=='string'||!group.id||groups.has(group.id)||!Number.isSafeInteger(group.revision)||group.revision<1
      ||!/^#[\da-f]{6}$/i.test(group.color)||!Array.isArray(group.tabIds)||!group.tabIds.length)fail('invalid');
    groups.add(group.id);
    for(const id of group.tabIds) {if(typeof id!=='string'||!id||members.has(id))fail('invalid');members.add(id);}
  }
  return value;
}
const paneStripColorGroupsBasis=value=>stableJson(validatePaneStripColorGroups(value===undefined?blank():value));
/** Omit only positively inactive subjects. Unknown catalog coverage retains
 * the original member; raw definition/provenance never changes here. */
function projectActivePaneStripGroups(groups,isActive) {
  let changed=false;const result=[];
  for(const group of groups) {
    const tabIds=group.tabIds.filter(id=>isActive(id)!==false);
    if(tabIds.length===group.tabIds.length)result.push(group);
    else {changed=true;if(tabIds.length)result.push({...group,tabIds});}
  }
  return changed?result:groups;
}

/** Only an explicit field intent can write this metadata. An incidental old
 * complete snapshot may still save its layout/settings, never a stale color.
 * The exact original basis is part of the existing mutation fingerprint. */
function mergePaneStripColorGroups(current,requested,edit,isMember=()=>true) {
  if(edit===undefined)return current;
  if(!edit||typeof edit.basis!=='string'||edit.basis!==paneStripColorGroupsBasis(current))fail('revision_changed');
  const before=current===undefined?blank():current,next=validatePaneStripColorGroups(requested);
  if(paneStripColorGroupsBasis(before)===paneStripColorGroupsBasis(next))return current;
  if(next.revision!==before.revision+1)fail('revision_changed');
  const previous=new Map(before.groups.map(group=>[group.id,group]));
  for(const group of next.groups) {
    const old=previous.get(group.id);
    if(group.tabIds.some(id=>{
      const verdict=isMember(id),active=verdict===true||verdict?.active===true;
      return !active&&!(old?.tabIds.includes(id)&&verdict?.member===true);
    }))fail('membership_changed');
    if(old) {
      // Recolor cannot merge/replace an old membership. Order belongs to
      // the window layout, so color metadata keeps its original member set.
      if(stableJson([...old.tabIds].sort())!==stableJson([...group.tabIds].sort()))fail('membership_changed');
      const changed=old.color!==group.color;
      if(group.revision!==old.revision+Number(changed))fail('revision_changed');
    } else if(group.revision!==1)fail('revision_changed');
  }
  return next;
}
function paneStripColorGroupEdits(requested,raw) {
  if(raw===undefined)return new Map();
  if(!Array.isArray(raw))fail('basis_invalid');
  const result=new Map();
  for(const edit of raw) {
    if(!edit||typeof edit.workflowId!=='string'||!requested.has(edit.workflowId)||result.has(edit.workflowId)
      ||typeof edit.basis!=='string'||Object.keys(edit).some(key=>!['workflowId','basis','gather'].includes(key)))fail('basis_invalid');
    result.set(edit.workflowId,edit);
  }
  return result;
}
function paneStripLayoutOwner(layout,owner) {
  if(!layout||!owner)return null;
  if(owner.paneIndex!==null) {
    const index=owner.windowId?(layout.splitPanes||[]).findIndex(pane=>pane.windowId===owner.windowId):owner.paneIndex;
    const pane=layout.splitPanes?.[index];
    if(!pane||pane.displayHidden)return null;
    return {paneIndex:index,pane,slots:Array.isArray(pane.tabs)?pane.tabs:pane.tabId?[{projectId:pane.projectId,tabId:pane.tabId}]:[]};
  }
  if(layout.splitPanes?.length)return null;
  const key=owner.centerKey || layout.activeProjectId;
  return {centerKey:key,slots:layout.centerStrips?.[key] || (layout.activeSpaceTab?[layout.activeSpaceTab]:[])};
}
/** Stable gather at the first selected slot, preserving foreign/chooser order. */
function gatherPaneStripSlots(slots,selectedIds) {
  const selected=new Set(selectedIds),first=slots.findIndex(slot=>selected.has(slot.tabId));
  if(first<0)fail('order_changed');
  const incoming=slots.filter(slot=>selected.has(slot.tabId)),rest=slots.filter(slot=>!selected.has(slot.tabId));
  if(incoming.length!==selected.size)fail('order_changed');
  const next=[...rest.slice(0,first),...incoming,...rest.slice(first)];
  return next.every((slot,index)=>slot===slots[index])?slots:next;
}
const paneStripSlotOrder=slots=>slots.map(slot=>slot.tabId?['tab',slot.projectId,slot.tabId]:['chooser',slot.slotId]);
function assertPaneStripGather(beforeLayout,afterLayout,beforeGroups,afterGroups,edit) {
  const previous=new Set((beforeGroups?.groups||[]).map(group=>group.id));
  const created=(afterGroups?.groups||[]).filter(group=>!previous.has(group.id));
  if(!edit?.gather) {
    // Recolor has no order intent. Creating a group without a gather is valid
    // only when its source was already consecutive and unchanged.
    for(const group of created) {
      const panes=beforeLayout?.splitPanes||[];
      const owners=panes.length?panes.map((pane,paneIndex)=>({windowId:pane.windowId||null,paneIndex})):
        [...new Set([...Object.keys(beforeLayout?.centerStrips||{}),beforeLayout?.activeProjectId])].filter(Boolean).map(centerKey=>({paneIndex:null,centerKey}));
      const valid=owners.some(owner=>{
        const before=paneStripLayoutOwner(beforeLayout,owner),after=paneStripLayoutOwner(afterLayout,owner);
        if(!before||!after||stableJson(paneStripSlotOrder(before.slots))!==stableJson(paneStripSlotOrder(after.slots)))return false;
        const indices=group.tabIds.map(id=>before.slots.findIndex(slot=>slot.tabId===id));
        return indices.every(index=>index>=0)&&Math.max(...indices)-Math.min(...indices)+1===indices.length;
      });
      if(!valid)fail('order_changed');
    }
    return;
  }
  const gather=edit.gather,owner=gather.owner;
  if(created.length!==1||!owner||Object.keys(gather).some(key=>!['owner','beforeSlots'].includes(key))
    ||Object.keys(owner).some(key=>!['windowId','paneIndex','centerKey'].includes(key))
    ||!Array.isArray(gather.beforeSlots)||!(owner.paneIndex===null||Number.isInteger(owner.paneIndex)&&owner.paneIndex>=0))fail('basis_invalid');
  const before=paneStripLayoutOwner(beforeLayout,owner),after=paneStripLayoutOwner(afterLayout,owner);
  if(!before||!after||stableJson(paneStripSlotOrder(before.slots))!==stableJson(paneStripSlotOrder(gather.beforeSlots)))fail('order_changed');
  const slots=gatherPaneStripSlots(before.slots,created[0].tabIds);
  if(stableJson(paneStripSlotOrder(slots))!==stableJson(paneStripSlotOrder(after.slots)))fail('order_changed');
  if(before.pane&&['tabId','projectId','selectedSlotId'].some(key=>before.pane[key]!==after.pane?.[key]))fail('order_changed');
  return {...after,slots}; // preserve Main's canonical chooser/unknown slot fields
}
/** Only this field is adopted; newer local layout/settings are not replaced. */
function adoptPaneStripColorGroups(currentSpaces,publishedSpaces) {
  const published=new Map(publishedSpaces.map(space=>[space.id,space]));
  return currentSpaces.map(space=>{
    const incoming=published.get(space.id);
    if(!incoming)return space;
    const before=space.stripColorGroups,next=incoming.stripColorGroups;
    if(before===undefined&&next===undefined || before!==undefined&&next!==undefined&&stableJson(before)===stableJson(next))return space;
    // Explicit edits stay in the serial committer until ACK, not optimistically
    // in spaces; a fresh publication can therefore safely replace this field.
    const copy={...space};if(next===undefined)delete copy.stripColorGroups;else copy.stripColorGroups=next;return copy;
  });
}
module.exports={validatePaneStripColorGroups,paneStripColorGroupsBasis,mergePaneStripColorGroups,paneStripColorGroupEdits,
  adoptPaneStripColorGroups,paneStripLayoutOwner,gatherPaneStripSlots,assertPaneStripGather,paneStripSlotOrder};
module.exports.projectActivePaneStripGroups=projectActivePaneStripGroups;
