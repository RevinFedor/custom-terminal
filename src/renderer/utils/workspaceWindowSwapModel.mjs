import { paneTabs } from './splitPanesModel.mjs';

const cloneEntries = (value) => (
  Array.isArray(value)
    ? value.filter((entry) => entry?.tabId).map((entry) => ({ ...entry }))
    : value
);

const clonePane = (pane) => {
  if (!pane || typeof pane !== 'object') return { projectId: '', tabId: '' };
  const next = { ...pane };
  if (Array.isArray(pane.tabs)) next.tabs = cloneEntries(pane.tabs);
  if (Array.isArray(pane.history)) next.history = cloneEntries(pane.history);
  if (Array.isArray(pane.detachedTabs)) next.detachedTabs = cloneEntries(pane.detachedTabs);
  delete next.column;
  return next;
};

const shownEntry = (pane) => {
  const tabs = paneTabs(pane);
  return tabs.find((entry) => entry.tabId === pane?.tabId)
    || tabs[0]
    || null;
};

/** Materialize the single-centre representation as the same pane shape used by split windows. */
export function readWorkspaceLayoutWindow(layout, paneIndex = null) {
  const source = layout && typeof layout === 'object' ? layout : {};
  const panes = Array.isArray(source.splitPanes) ? source.splitPanes : [];
  if (panes.length > 0) {
    const index = Number(paneIndex);
    if (!Number.isInteger(index) || index < 0 || !panes[index]) return null;
    return clonePane(panes[index]);
  }
  if (paneIndex !== null && paneIndex !== undefined && Number(paneIndex) !== 0) return null;

  const shown = source.activeSpaceTab?.tabId
    ? { ...source.activeSpaceTab }
    : source.activeProjectId && source.activeTabId
      ? { projectId: source.activeProjectId, tabId: source.activeTabId }
      : null;
  const stripKey = source.activeProjectId || shown?.projectId || '';
  const stored = cloneEntries(source.centerStrips?.[stripKey]) || [];
  const tabs = shown && !stored.some((entry) => entry.tabId === shown.tabId)
    ? [shown, ...stored]
    : stored;
  const finalTabs = tabs.length > 0 ? tabs : (shown ? [shown] : []);
  const finalShown = finalTabs.find((entry) => entry.tabId === shown?.tabId)
    || finalTabs[0]
    || null;
  if (!finalShown) return { projectId: '', tabId: '' };
  return finalTabs.length > 1
    ? { ...finalShown, tabs: finalTabs }
    : { ...finalShown };
}

function writeWorkspaceLayoutWindow(layout, paneIndex, incomingPane) {
  const source = layout && typeof layout === 'object' ? layout : {};
  const panes = Array.isArray(source.splitPanes) ? source.splitPanes : [];
  const incoming = clonePane(incomingPane);

  if (panes.length > 0) {
    const index = Number(paneIndex);
    if (!Number.isInteger(index) || index < 0 || !panes[index]) return null;
    const slot = panes[index];
    const placed = Object.prototype.hasOwnProperty.call(slot, 'column')
      ? { ...incoming, column: slot.column }
      : incoming;
    const nextPanes = panes.slice();
    nextPanes[index] = placed;
    return { ...source, splitPanes: nextPanes };
  }

  if (paneIndex !== null && paneIndex !== undefined && Number(paneIndex) !== 0) return null;
  const previousKey = source.activeProjectId || source.activeSpaceTab?.projectId || '';
  const centerStrips = { ...(source.centerStrips || {}) };
  if (previousKey) delete centerStrips[previousKey];

  const tabs = paneTabs(incoming).map((entry) => ({ ...entry }));
  const shown = shownEntry(incoming);
  if (shown) {
    // The centre strip is keyed by the project of the shown tab. It may still
    // contain cross-project chips; the key owns the visible centre slot, not
    // every tab inside it.
    delete centerStrips[shown.projectId];
    if (tabs.length > 1) centerStrips[shown.projectId] = tabs;
  }
  return {
    ...source,
    splitPanes: [],
    splitFocusedIndex: 0,
    splitSizes: null,
    centerStrips,
    activeProjectId: shown?.projectId || source.activeProjectId || null,
    focusedProjectId: shown?.projectId || source.focusedProjectId || source.activeProjectId || null,
    activeSpaceTab: shown ? { ...shown } : null,
  };
}

/**
 * Exchange two complete window contents without changing either workflow's
 * geometry or active workflow identity. `paneIndex=null` addresses a workflow's
 * single centre window; split layouts use their real pane index.
 */
export function swapWorkspaceLayoutWindows({
  sourceLayout,
  sourcePaneIndex = null,
  targetLayout,
  targetPaneIndex = null,
} = {}) {
  const sourceWindow = readWorkspaceLayoutWindow(sourceLayout, sourcePaneIndex);
  const targetWindow = readWorkspaceLayoutWindow(targetLayout, targetPaneIndex);
  if (!sourceWindow || !targetWindow) return null;

  const nextSourceLayout = writeWorkspaceLayoutWindow(sourceLayout, sourcePaneIndex, targetWindow);
  const nextTargetLayout = writeWorkspaceLayoutWindow(targetLayout, targetPaneIndex, sourceWindow);
  if (!nextSourceLayout || !nextTargetLayout) return null;
  return {
    sourceLayout: nextSourceLayout,
    targetLayout: nextTargetLayout,
    sourceShown: shownEntry(targetWindow),
    targetShown: shownEntry(sourceWindow),
  };
}
