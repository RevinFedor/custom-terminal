import { addTabToPane, collapseLonePane, insertIntoStrip, paneTabs } from './splitPanesModel.mjs';
import { tabContextPaneIndex } from './tabContextSurface.mjs';

// The factory's existing onPublish boundary: exact durable child and strip
// appear together. No store calls, activation or async work here.
export function contextCreatedTabPlacement(state, surface, projectId, sourceTabId, tabId, origin) {
  if (state.activeSpaceId !== origin.spaceId
    || (state.navigationRevision || 0) !== origin.navigationRevision) return null;
  if (surface?.kind === 'pane' || surface?.kind === 'window') {
    const paneIndex = tabContextPaneIndex(surface, state, sourceTabId);
    if (paneIndex < 0) return null;
    const strip = paneTabs(state.splitPanes[paneIndex]);
    const at = strip.findIndex(entry => entry.tabId === sourceTabId);
    const result = addTabToPane(state.splitPanes, paneIndex, projectId, tabId, at + 1);
    if (!result) return null;
    const patch = collapseLonePane(result.panes)
      ? { splitPanes: [], splitFocusedIndex: 0, splitSizes: null }
      : { splitPanes: result.panes };
    return { patch, paneIndex };
  }
  if (surface?.kind !== 'center' || !state.activeProjectId) return null;
  const key = state.activeProjectId;
  const shown = state.openProjects.get(key)?.activeTabId || '';
  const stored = state.centerStrips[key] || [];
  const strip = stored.length ? stored : shown ? [{ projectId: key, tabId: shown }] : [];
  const at = strip.findIndex(entry => entry.tabId === sourceTabId);
  if (at < 0) return null;
  return { patch: { centerStrips: { ...state.centerStrips,
    [key]: insertIntoStrip(strip, projectId, tabId, at + 1) } }, paneIndex: null };
}
