export function tabNavigationLocation(state) {
  const workspace = state.openProjects.get(state.activeProjectId || '');
  const pane = state.splitPanes[state.splitFocusedIndex];
  return JSON.stringify([state.view,state.activeSpaceId,state.activeProjectId,workspace?.activeTabId,
    workspace?.currentView,workspace?.viewingSubAgentTabId,state.splitFocusedIndex,
    pane?.windowId,pane?.displayHidden,pane?.projectId,pane?.tabId]);
}
