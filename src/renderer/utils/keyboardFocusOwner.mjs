/**
 * Resolve the visible keyboard-focus owner into one stable tab scope.
 *
 * `activeProjectId` and `workspace.activeTabId` answer which project/sidebar
 * row is current. They do NOT prove that keyboard actions belong there: the
 * user may have explicitly clicked a cross-project pane, or the left sidebar.
 * Cmd+T and Cmd+W must ask the same resolver or creation and closing diverge.
 */
export function resolveKeyboardFocusTarget({
  activeArea,
  splitPanes,
  splitFocusedIndex,
  sidebarProjectId,
  sidebarTabId,
  activeProjectId,
  effectiveProjectId,
  effectiveTabId,
} = {}) {
  const fallbackProjectId = sidebarProjectId || activeProjectId || null;

  if (activeArea === 'projects') {
    return {
      kind: 'project-rail',
      projectId: fallbackProjectId,
      tabId: sidebarTabId || null,
      paneIndex: -1,
    };
  }

  if (activeArea === 'sidebar') {
    return {
      kind: 'sidebar',
      projectId: fallbackProjectId,
      tabId: sidebarTabId || null,
      paneIndex: -1,
    };
  }

  const panes = Array.isArray(splitPanes) ? splitPanes : [];
  if (panes.length > 0) {
    const rawIndex = Number.isInteger(splitFocusedIndex) ? splitFocusedIndex : 0;
    const paneIndex = Math.max(0, Math.min(panes.length - 1, rawIndex));
    const pane = panes[paneIndex] || null;
    return {
      kind: 'pane',
      projectId: pane?.projectId || fallbackProjectId,
      tabId: pane?.tabId || null,
      paneIndex,
    };
  }

  return {
    kind: 'pane',
    projectId: effectiveProjectId || activeProjectId || fallbackProjectId,
    tabId: effectiveTabId || null,
    paneIndex: -1,
  };
}
