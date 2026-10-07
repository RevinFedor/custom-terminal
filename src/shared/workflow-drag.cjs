'use strict';
const {stableJson,clone}=require('./workflow-organization.cjs');

// The same scope guard is captured by the renderer and checked in Main's
// transaction. Focus/scroll/geometry may change during Cmd navigation; window
// identities, inventory, order and physical/visual ownership may not.
function dragPlacement(layout = {}) {
  const panes = (layout.splitPanes || []).map(pane => ({ windowId: pane.windowId || null,
    hidden: !!pane.displayHidden,
    tabs: (pane.tabs?.length ? pane.tabs : pane.tabId ? [{projectId:pane.projectId,tabId:pane.tabId}] : [])
      .map(entry => typeof entry === 'string' ? {tabId:entry} : entry.tabId
        ? {projectId:entry.projectId || null,tabId:entry.tabId} : {slotId:entry.slotId,cwd:entry.cwd || null}) }));
  return { panes, centerStrips: layout.centerStrips || {},
    center: panes.length ? null : layout.activeSpaceTab || null,
    profiles: Object.fromEntries(Object.entries(layout.windowDisplayLayouts || {})
      .filter(([,profile]) => profile?.splitPanes || profile?.centerStrips || profile?.activeSpaceTab)
      .map(([key,profile]) => [key,dragPlacement({...profile,windowDisplayLayouts:{}})])) };
}

function dragRelation(tab = {}) {
  const type=tab.tabType ?? tab.tab_type;
  return { parentTabId:(tab.parentTabId ?? tab.parent_tab_id) || null,
    visualParentTabId:(tab.visualParentTabId ?? tab.visual_parent_tab_id) || null,
    tabType:!type || type==='browser' ? 'terminal' : type };
}
function dragFamily(records, rootIds, {physicalOnly=false}={}) {
  const family = new Set(rootIds);
  let added = true;
  while (added) {
    added = false;
    for (const [id,record] of Object.entries(records)) {
      const relation = dragRelation(record);
      const parent=relation.parentTabId || (!physicalOnly || relation.tabType==='file' ? relation.visualParentTabId:null);
      if (!family.has(id) && family.has(parent)) {
        family.add(id); added = true;
      }
    }
  }
  return [...family];
}
// Apply only the painted placement delta. A concurrent resize/focus update is
// not permission to overwrite it with the pickup frame's complete layout.
function applyDragLayout(current,before,after) {
  const same=before===undefined || after===undefined ? before===after : stableJson(before)===stableJson(after);
  if(same)return current===undefined ? undefined : clone(current);
  if(Array.isArray(after)) {
    const key=value=>value?.windowId || value?.tabId || value?.slotId;
    const shape=list=>Array.isArray(list) ? list.map(value=>key(value) || value) : list;
    // A newer local placement/order owns its array. Otherwise apply the
    // accepted order while preserving newer per-window focus/resize fields.
    if(current!==undefined && !sameValue(shape(current),shape(before)))return clone(current);
    return after.map((value,index)=>{
      const match=(list)=>key(value)?list?.find(item=>key(item)===key(value)):list?.[index];
      return applyDragLayout(match(current),match(before),value);
    });
  }
  if(after && typeof after==='object') {
    const next={...(current || {})};
    for(const key of new Set([...Object.keys(before || {}),...Object.keys(after)])) {
      if(!Object.hasOwn(after,key)) {if(Object.hasOwn(before || {},key) && sameValue(current?.[key],before[key]))delete next[key];}
      else {
        const value=applyDragLayout(current?.[key],before?.[key],after[key]);
        if(value===undefined)delete next[key];else next[key]=value;
      }
    }
    return next;
  }
  if(current!==undefined && !sameValue(current,before))return clone(current);
  return after===undefined ? undefined : clone(after);
}
const sameValue=(left,right)=>left===undefined || right===undefined ? left===right : stableJson(left)===stableJson(right);
module.exports = {dragPlacement,dragRelation,dragFamily,applyDragLayout};
