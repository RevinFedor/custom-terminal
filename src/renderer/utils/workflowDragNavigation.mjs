import {applyDragLayout} from '../../shared/workflow-drag.cjs';

// Durable placement still applies after navigation. Only foreground selection
// is conditional: away/back must not revive an older reveal intent.
export function applyWorkflowDragLayout(current,change,{reveal=true}={}) {
  const next=applyDragLayout(current,change.beforeLayout,change.layout);
  if(reveal)return next;
  const previousPanes=current.splitPanes || [];
  const focusedId=previousPanes[current.splitFocusedIndex || 0]?.windowId;
  next.splitPanes=(next.splitPanes || []).map(pane=>{
    const previous=previousPanes.find(item=>item.windowId===pane.windowId);
    if(!previous)return pane;
    const retainSelection=()=>{
      const retained={...pane,tabId:previous.tabId,projectId:previous.projectId};
      if(Object.hasOwn(previous,'selectedSlotId'))retained.selectedSlotId=previous.selectedSlotId;
      else delete retained.selectedSlotId;
      return retained;
    };
    const slots=pane.tabs?.length ? pane.tabs : pane.tabId?[{projectId:pane.projectId,tabId:pane.tabId}]:[];
    if(previous.selectedSlotId && slots.some(slot=>slot.slotId===previous.selectedSlotId))
      return retainSelection();
    if(previous.tabId && slots.some(slot=>slot.tabId===previous.tabId && slot.projectId===previous.projectId))
      return retainSelection();
    return pane;
  });
  const focus=next.splitPanes.findIndex(pane=>pane.windowId===focusedId && !pane.displayHidden);
  if(focus>=0)next.splitFocusedIndex=focus;
  const pane=next.splitPanes[next.splitFocusedIndex || 0];
  const centered=current.activeSpaceTab;
  const centerExists=!next.splitPanes.length && centered && Object.values(next.centerStrips || {})
    .some(strip=>strip.some(ref=>ref.tabId===centered.tabId && ref.projectId===centered.projectId));
  if(pane || centerExists) {
    const shown=pane ? pane.tabId?{projectId:pane.projectId,tabId:pane.tabId}:null : centered;
    next.activeSpaceTab=shown;
    if(shown)next.activeProjectId=shown.projectId;
    next.focusedProjectId=current.focusedProjectId;
  }
  return next;
}
