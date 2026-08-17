const noSelection = (reason) => ({ selection: null, reason });

/**
 * Resolve the terminal surface the user is actually working in.
 *
 * The center tab remains the compatibility pointer, while split focus and the
 * temporary child-session view can make another tab the visible surface. Keep
 * this pure so HTTP/Application API callers use the same deterministic rule.
 */
export function resolveFocusedTerminalSelection(state) {
  if (!state || state.view !== 'workspace') return noSelection('workspace-not-visible');

  const panes = Array.isArray(state.splitPanes) ? state.splitPanes : [];
  let projectId = null;
  let tabId = null;

  if (panes.length > 0) {
    const index = Number.isInteger(state.splitFocusedIndex) ? state.splitFocusedIndex : 0;
    const pane = panes[index] || null;
    if (!pane?.projectId || !pane?.tabId) return noSelection('focused-pane-empty');
    projectId = pane.projectId;
    tabId = pane.tabId;
  } else {
    projectId = state.activeProjectId || null;
    if (!projectId) return noSelection('no-active-project');
    const workspace = state.openProjects?.get?.(projectId) || null;
    tabId = workspace?.activeTabId || null;
    if (!tabId) return noSelection('no-active-tab');
  }

  const workspace = state.openProjects?.get?.(projectId) || null;
  if (!workspace) return noSelection('project-not-open');
  if (workspace.currentView !== 'terminal') return noSelection('terminal-view-not-visible');

  // Opening a child session from an orchestration card temporarily replaces
  // its parent surface without changing the durable activeTabId. The attached
  // context must describe what is visibly in front of the user.
  const viewedChildId = workspace.viewingSubAgentTabId || null;
  const viewedChild = viewedChildId ? workspace.tabs?.get?.(viewedChildId) : null;
  if (viewedChild && viewedChild.parentTabId === tabId) tabId = viewedChildId;

  if (!workspace.tabs?.get?.(tabId)) return noSelection('focused-tab-not-found');
  return { selection: { projectId, tabId }, reason: null };
}
