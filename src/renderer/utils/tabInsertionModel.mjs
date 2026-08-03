export function resolveTabInsertionIndex({
  tabIds = [],
  appendToEnd = false,
  referenceTabId,
  groupAnchorTabId,
} = {}) {
  if (appendToEnd) return tabIds.length;

  if (!referenceTabId && groupAnchorTabId) {
    const anchorIndex = tabIds.indexOf(groupAnchorTabId);
    if (anchorIndex >= 0) return anchorIndex;
  }

  if (referenceTabId) {
    const referenceIndex = tabIds.indexOf(referenceTabId);
    if (referenceIndex >= 0) return referenceIndex + 1;
  }

  return tabIds.length;
}
