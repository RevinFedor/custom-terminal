import { resolveTabLinkNavigation } from './tabLinkNavigation.mjs';

// A separate file tab is a placement, not a second link or a path match.
// Keep dormant/hidden/parked chips distinct from a reader visible right now.
export function linkedFileWindowState(state, file) {
  const tab = state.openProjects?.get(file.projectId)?.tabs.get(file.id);
  if (tab?.tabType !== 'file' || tab.filePath !== file.path || state.tabCatalog?.[file.id]?.active === false) return null;
  const place = resolveTabLinkNavigation(state, file.id);
  if (!place || place.kind === 'append') return null;
  if (place.kind === 'reveal-profile' || place.spaceId !== state.activeSpaceId || state.view !== 'workspace') return 'parked';
  if (place.paneIndex >= 0) {
    const pane = state.splitPanes[place.paneIndex];
    return pane && !pane.displayHidden && pane.tabId === file.id && pane.projectId === file.projectId ? 'shown' : 'parked';
  }
  const shown = state.activeSpaceTab;
  return shown?.tabId === file.id && shown.projectId === file.projectId ? 'shown' : 'parked';
}

// The component subscribes to this value, not the whole workspace Map.
export function linkedFileWindowSnapshot(state, files) {
  return JSON.stringify(files.map(file => [file.id, linkedFileWindowState(state, file)]));
}
