'use strict';
const {stableJson}=require('./workflow-organization.cjs');
const {validatePaneStripColorGroups,projectActivePaneStripGroups}=require('./pane-strip-color-groups.cjs');
const {paneStripGroupDragBoundary}=require('./pane-strip-drag-boundary.cjs');
const fail=()=>{const code='workflow_drag_strip_group_changed';throw Object.assign(Error(code),{code,statusCode:409});};
const same=(a,b)=>stableJson(a)===stableJson(b);

function strips(layout={}) {
  if(layout.splitPanes?.length)return layout.splitPanes.map((pane,index)=>({
    key:pane.windowId?`window:${pane.windowId}`:`legacy-pane:${index}`,
    ids:(Array.isArray(pane.tabs)?pane.tabs:pane.tabId?[pane]:[]).filter(slot=>slot.tabId).map(slot=>slot.tabId),
  }));
  const values=Object.entries(layout.centerStrips||{}).map(([key,slots])=>({key:`center:${key}`,
    ids:(slots||[]).filter(slot=>slot.tabId).map(slot=>slot.tabId)}));
  if(!values.length&&layout.activeSpaceTab?.tabId)values.push({key:`center:${layout.activeProjectId||layout.activeSpaceTab.projectId}`,
    ids:[layout.activeSpaceTab.tabId]});
  return values;
}

/** Inside the existing Main transaction, after its typed family proofs. Group
 * authority comes from CURRENT metadata, including groups created after pickup.
 * This does not publish metadata or supply a new writer/replay authority. */
function assertPaneStripGroupDrag(currentWorkflows,changes,request,isActive=()=>undefined) {
  const moving=new Set(request.destinationKind==='window'?request.paneFamilyIds:request.sourceFamilyIds);
  const roots=new Set(request.destinationKind==='window'?request.paneRootTabIds:request.sourceRootTabIds);
  const changed=new Map(changes.map(({old,layout})=>[old.id,layout]));
  for(const workflow of currentWorkflows) {
    if(workflow.metadata?.stripColorGroups===undefined)continue;
    const groups=projectActivePaneStripGroups(validatePaneStripColorGroups(workflow.metadata.stripColorGroups).groups,isActive);
    const before=strips(workflow.layout),after=strips(changed.get(workflow.id)||workflow.layout);
    for(const group of groups) {
      if(!group.tabIds.some(id=>moving.has(id)))continue;
      const owners=before.filter(strip=>group.tabIds.every(id=>strip.ids.includes(id)));
      if(owners.length!==1)fail();
      const source=owners[0],target=after.find(strip=>strip.key===source.key);
      if(!target||group.tabIds.some(id=>!target.ids.includes(id)))fail();
      if(group.tabIds.some(id=>request.tabs.find(tab=>tab.tabId===id)?.workflowId
        &&request.tabs.find(tab=>tab.tabId===id).workflowId!==workflow.id))fail();
      // A same-workflow window drop places explicit roots, not independently
      // shown physical descendants. Family proofs still forbid removing a
      // grouped descendant from its existing window/workflow.
      if(!group.tabIds.some(id=>roots.has(id)))continue;
      const sourceIds=source.ids.filter(id=>roots.has(id)),selected=new Set(sourceIds);
      const boundary=paneStripGroupDragBoundary(groups,{sourceIds,order:source.ids});
      if(boundary.kind!=='group')fail();
      // The same stable block moves within its group. Foreign/chooser contents
      // retain their existing owner; chooser positions are not tab indices.
      const rest=source.ids.filter(id=>!selected.has(id));
      if(!same(rest,target.ids.filter(id=>!selected.has(id)))
        ||!same(sourceIds,target.ids.filter(id=>selected.has(id))))fail();
      const first=target.ids.findIndex(id=>selected.has(id));
      if(first<boundary.start||first>boundary.end
        ||!same(target.ids.slice(first,first+sourceIds.length),sourceIds))fail();
    }
  }
}
module.exports={assertPaneStripGroupDrag};
