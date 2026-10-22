'use strict';

const {stableJson}=require('./workflow-organization.cjs');
const {validatePaneStripColorGroups}=require('./pane-strip-color-groups.cjs');

// A layout edit still owns its exact proposed order. This guard neither gathers
// members nor changes membership, and it does not make a missing placement into
// a new close/move prohibition. It prevents a NEW foreign/chooser gap in an
// existing group's strip. Existing legacy gaps retain their old write behavior.
function strips(layout={},path=[]) {
  layout=layout||{};
  const result=[];
  for(const [index,pane] of (layout.splitPanes||[]).entries()) {
    if(!pane)continue;
    const owner=[...path,'pane',pane.windowId || index];
    const slots=Array.isArray(pane.tabs)?pane.tabs:pane.tabId?[pane]:[];
    result.push({owner,slots});
  }
  for(const [key,slots] of Object.entries(layout.centerStrips||{}))
    if(Array.isArray(slots))result.push({owner:[...path,'center',key],slots});
  for(const [key,profile] of Object.entries(layout.windowDisplayLayouts||{}))
    if(profile)result.push(...strips(profile,[...path,'profile',key]));
  return result;
}

function groupGaps(layout,group,isActive) {
  const members=new Set(group.tabIds.filter(id=>isActive(id)!==false));
  if(members.size<2)return [];
  const gaps=[];
  for(const {owner,slots} of strips(layout)) {
    const visible=slots.filter(slot=>!slot?.tabId || isActive(slot.tabId)!==false);
    let previous=-1;
    for(let index=0;index<visible.length;index++) {
      if(!members.has(visible[index]?.tabId))continue;
      if(previous>=0 && index>previous+1)gaps.push({groupId:group.id,owner,
        leftTabId:visible[previous].tabId,rightTabId:visible[index].tabId});
      previous=index;
    }
  }
  return gaps;
}

/** Compare pairs without publishing either one. UNKNOWN activity retains the
 * member and slot; only a positive inactive proof excludes their projection.
 * A gap is addressed by stable owner and its two neighboring member IDs, not
 * by incidental slot extensions, focus, color or foreign content order. */
function paneStripPairConflicts({beforeLayout,afterLayout,beforeGroups,afterGroups,isActive=()=>undefined}) {
  if(beforeGroups===undefined || afterGroups===undefined)return [];
  const before=validatePaneStripColorGroups(beforeGroups),after=validatePaneStripColorGroups(afterGroups);
  const old=new Map(before.groups.map(group=>[group.id,group]));
  const activity=new Map(),active=id=>{
    if(!activity.has(id))activity.set(id,isActive(id));
    return activity.get(id);
  };
  const conflicts=[];
  for(const group of after.groups) {
    const previous=old.get(group.id);
    // CREATE is separately proved by the existing explicit gather contract.
    if(!previous)continue;
    const known=new Set(groupGaps(beforeLayout,previous,active).map(stableJson));
    for(const gap of groupGaps(afterLayout,group,active))if(!known.has(stableJson(gap)))conflicts.push(gap);
  }
  return conflicts;
}

function assertPaneStripPair({workflowId,...context}) {
  const conflicts=paneStripPairConflicts(context);
  if(!conflicts.length)return;
  const code='workflow_strip_groups_pair_conflict';
  throw Object.assign(Error(code),{code,statusCode:409,disposition:'not-applied',workflowId,conflicts});
}

module.exports={paneStripPairConflicts,assertPaneStripPair};
