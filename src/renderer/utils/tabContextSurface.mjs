import { paneHoldsTab } from './splitPanesModel.mjs';

/**
 * Identifies which visible tab surface opened the shared context menu.
 * A null result means the left project list owns the gesture.
 */
export function hiddenWindowTabContextHost(instance, spaceId, windowId, tabId) {
  return 'hidden-window-picker:' + [instance, spaceId, windowId].map(encodeURIComponent).join(':') + ':' + tabId;
}

export function tabContextSurface(host, tabId) {
  if (typeof host !== 'string' || typeof tabId !== 'string' || !tabId) return null;
  if (host.startsWith('hidden-window-picker:') && host.endsWith(':' + tabId)) {
    const parts = host.slice('hidden-window-picker:'.length, -tabId.length - 1).split(':');
    if (parts.length !== 3) return null;
    try {
      const [, spaceId, windowId] = parts.map(decodeURIComponent);
      return spaceId && windowId ? { kind: 'window', spaceId, windowId } : null;
    } catch { return null; }
  }
  const prefix = 'split-pane-header:';
  if (!host.startsWith(prefix) || !host.endsWith(':' + tabId)) return null;
  const token = host.slice(prefix.length, host.length - tabId.length - 1);
  if (token === 'center') return { kind: 'center' };
  const paneIndex = Number(token);
  return Number.isInteger(paneIndex) && paneIndex >= 0
    ? { kind: 'pane', paneIndex }
    : null;
}

/** Resolve a captured window by identity at action time, never by its old index. */
export function tabContextPaneIndex(surface, state, tabId) {
  const panes = state?.splitPanes || [];
  const index = surface?.kind === 'window'
    ? (surface.spaceId === state?.activeSpaceId ? panes.findIndex(p => p.windowId === surface.windowId) : -1)
    : surface?.kind === 'pane' ? surface.paneIndex : -1;
  const pane = panes[index];
  if (!pane) return -1;
  return paneHoldsTab(pane, tabId) ? index : -1;
}
