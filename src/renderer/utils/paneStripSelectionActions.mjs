import {readPaneStripOwnerEntries} from './paneStripGroupsModel.mjs';
import {isBareEmptyPane} from './splitPanesModel.mjs';

/** Metadata/presentation commands use the same window and notification owners
 * as single-tab commands. Process Stop/Full are deliberately injected by Main's
 * captured-selection admission, never substituted with whole-workflow actions. */
export function paneStripSelectionTargets(state,lease) {
  if(!lease.isCurrent())throw Error('strip_selection_changed');
  const strip=readPaneStripOwnerEntries(state,lease);
  if(!strip || !lease.entries.length)throw Error('strip_selection_changed');
  return lease.entries.map(entry=>{
    const workspace=state.openProjects.get(entry.projectId),tab=workspace?.tabs.get(entry.tabId);
    if(!tab || state.tabCatalog?.[entry.tabId]?.active===false
      || !strip.some(item=>item.projectId===entry.projectId&&item.tabId===entry.tabId))throw Error('strip_selection_changed');
    return {...entry,tab,workspace};
  });
}

export function removePaneStripSelection(getState,lease) {
  const state=getState();paneStripSelectionTargets(state,lease);
  // These existing synchronous executors cannot interleave another user's
  // action between validation and the captured set. No runtime is stopped.
  for(const entry of lease.entries) {
    const current=getState();
    if(current.splitPanes.length) {
      if(!current.clearTabFromSplitPane(entry.tabId))throw Error('strip_placement_not_removed');
    } else if(!current.detachTabFromWindow(entry.projectId,entry.tabId,null))throw Error('strip_placement_not_removed');
  }
}

export function openPaneStripSelectionBeside(getState,lease) {
  const state=getState();paneStripSelectionTargets(state,lease);
  const index=lease.windowId?state.splitPanes.findIndex(pane=>pane.windowId===lease.windowId):lease.paneIndex;
  if(index!==null && index<0)throw Error('strip_selection_changed');
  const vacant=state.splitPanes.findIndex((pane,at)=>at!==index&&!pane.displayHidden&&isBareEmptyPane(pane));
  const result=state.commitWorkspaceWindowAction({sourceTabId:lease.entries[0].tabId,
    target:{spaceId:lease.workflowId,anchor:'focused',...(vacant>=0?{windowIndex:vacant}:index!==null?{windowIndex:index}:{}),
      mode:vacant>=0?'same-window':'new-window',side:'right'},entries:lease.entries.map(entry=>({...entry})),
    show:true,focus:true,reveal:true});
  if(!result?.ok)throw Error(result?.reason || 'strip_placement_not_confirmed');
  return result;
}

export function notifyPaneStripSelection(getState,lease,kind,enabled) {
  const targets=paneStripSelectionTargets(getState(),lease).filter(({tab})=>tab.tabType!=='file');
  for(const {projectId,tabId} of targets) {
    const store=getState();
    if(kind==='persistent')store.setTabCompletionNotificationPersistent(projectId,tabId,enabled);
    else store.setTabCompletionNotificationArmed(projectId,tabId,enabled);
  }
}

/** Shared with the existing single-tab UUID/Path row. Preserve text format. */
export const tabSessionUuid=tab=>tab?.claudeSessionId || tab?.geminiSessionId || tab?.codexSessionId || null;
export const tabUuidPathText=rows=>rows.map(({uuid,cwd})=>`${uuid}\ncwd: ${cwd || '/'}`).join('\n\n');
