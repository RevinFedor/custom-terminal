/**
 * Identifies which visible tab surface opened the shared context menu.
 * A null result means the left project list owns the gesture.
 */
export function tabContextSurface(host, tabId) {
  if (typeof host !== 'string' || typeof tabId !== 'string' || !tabId) return null;
  const prefix = 'split-pane-header:';
  if (!host.startsWith(prefix) || !host.endsWith(':' + tabId)) return null;
  const token = host.slice(prefix.length, host.length - tabId.length - 1);
  if (token === 'center') return { kind: 'center' };
  const paneIndex = Number(token);
  return Number.isInteger(paneIndex) && paneIndex >= 0
    ? { kind: 'pane', paneIndex }
    : null;
}
