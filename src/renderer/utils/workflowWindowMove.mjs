import {readWorkspaceLayoutWindow} from './workspaceWindowSwapModel.mjs';
import {ensureWindowIds,splitWindowPane,reconcileWindowDisplay,isWindowVisible} from './windowDisplayLayouts.mjs';
import {paneTabs,paneSlots} from './splitPanesModel.mjs';

const focusedLayout=(layout,panes,focusedId)=>{
  let next=panes;
  if(!next.some(isWindowVisible))next=[...ensureWindowIds([{projectId:'',tabId:'',column:0}]),...next];
  const found=next.findIndex(pane=>pane.windowId===focusedId && isWindowVisible(pane));
  const index=found>=0?found:next.findIndex(isWindowVisible),shown=next[index];
  return{...layout,splitPanes:next,splitFocusedIndex:index,splitSizes:null,
    activeSpaceTab:shown?.tabId?{projectId:shown.projectId,tabId:shown.tabId}:null,
    ...(shown?.tabId?{activeProjectId:shown.projectId,focusedProjectId:shown.projectId}:{})};
};

/** Move window inventory once; profiles retain only references and geometry. */
export function moveWorkflowWindow({sourceLayout,targetLayout,windowId,display}) {
  let sourcePanes=sourceLayout?.splitPanes || [];
  const center=sourcePanes.length===0;
  if(center && windowId)return null;
  if(center)sourcePanes=ensureWindowIds([readWorkspaceLayoutWindow(sourceLayout)]);
  const index=center?0:sourcePanes.findIndex(pane=>pane.windowId===windowId);
  if(index<0)return null;
  const moving=sourcePanes[index];
  let destination=targetLayout?.splitPanes || [];
  if(destination.some(pane=>pane.windowId===moving.windowId))return null;
  if(!destination.length){
    const oldCenter=readWorkspaceLayoutWindow(targetLayout);
    if(paneSlots(oldCenter).length)destination=ensureWindowIds([oldCenter]);
  }
  const promotedTargetCenter=destination.length && !(targetLayout.splitPanes || []).length;
  if(display?.key && destination.length) {
    targetLayout=reconcileWindowDisplay({...targetLayout,splitPanes:destination,
      ...(promotedTargetCenter?{centerStrips:{}}:{})},display);
    destination=targetLayout.splitPanes;
  }
  const {displayHidden,displayRect,column,...content}=moving;
  const targetCenterStrips=promotedTargetCenter?{}:targetLayout.centerStrips;
  let target;
  if(!destination.length)target=focusedLayout({...targetLayout,centerStrips:targetCenterStrips},[content],content.windowId);
  else {
    const withIncoming=[...destination,{...content,displayHidden:true}];
    const visibleFocus=destination[targetLayout.splitFocusedIndex || 0]?.displayHidden
      ? destination.findIndex(isWindowVisible):targetLayout.splitFocusedIndex || 0;
    const opened=splitWindowPane(withIncoming,visibleFocus,null,visibleFocus,'right',content.windowId);
    target=opened?focusedLayout({...targetLayout,centerStrips:targetCenterStrips},opened.panes,content.windowId)
      :{...targetLayout,splitPanes:withIncoming,centerStrips:targetCenterStrips};
  }
  const remaining=sourcePanes.filter((_,at)=>at!==index);
  const sourceFocus=sourcePanes[sourceLayout.splitFocusedIndex || 0]?.windowId;
  let source=focusedLayout({...sourceLayout,...(center?{centerStrips:{}}:{})},remaining,sourceFocus);
  // Never reintroduce the moved window from a different monitor's saved view.
  if(source.windowDisplayKey)source=reconcileWindowDisplay(source,{key:source.windowDisplayKey});
  if(target.windowDisplayKey)target=reconcileWindowDisplay(target,{key:target.windowDisplayKey});
  return{sourceLayout:source,targetLayout:target,windowId:content.windowId,
    entries:paneTabs(content).map(tab=>({...tab})),tabIds:paneTabs(content).map(tab=>tab.tabId),shown:content.tabId || null};
}
