/** Exact visible range between the active anchor and the hovered/clicked tab. */
export function resolveTabRangeSelection(orderedTabIds, anchorTabId, targetTabId) {
  const ordered = Array.from(new Set((Array.isArray(orderedTabIds) ? orderedTabIds : []).filter(Boolean)));
  const targetIndex = ordered.indexOf(targetTabId);
  if (targetIndex < 0) return [];
  const anchorIndex = ordered.indexOf(anchorTabId);
  if (anchorIndex < 0) return [targetTabId];
  const from = Math.min(anchorIndex, targetIndex);
  const to = Math.max(anchorIndex, targetIndex);
  return ordered.slice(from, to + 1);
}
