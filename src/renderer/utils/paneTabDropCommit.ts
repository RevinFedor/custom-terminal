import { useWorkspaceStore } from '../store/useWorkspaceStore';
import type { PaneTabDragSource, PaneTabDropTarget } from './paneTabDragBridge';
import { isSamePaneDrop } from './paneTabDropIdentity.mjs';

export function commitPaneTabDrop(source: PaneTabDragSource, target: PaneTabDropTarget) {
  const store = useWorkspaceStore.getState();
  let shownTabId = source.rootTabId;
  // Reordering inside one strip changes order only. Crossing into another
  // window (or coming from the sidebar) also makes the moved root visible.
  if (isSamePaneDrop(source, target, store.activeSpaceId)) {
    if (target.paneIndex === null) {
      const key = store.centerStripKey();
      const shownProjectId = store.activeProjectId || '';
      shownTabId = shownProjectId
        ? store.openProjects.get(shownProjectId)?.activeTabId || source.rootTabId
        : source.rootTabId;
      if (key && !store.centerStrips[key]?.some((entry) => entry.tabId === shownTabId)) {
        shownTabId = source.rootTabId;
      }
    } else {
      shownTabId = store.splitPanes[target.paneIndex]?.tabId || source.rootTabId;
    }
  }
  return store.moveTabsToWindowStrip(
    target.paneIndex,
    source.entries,
    target.at,
    shownTabId,
  );
}
