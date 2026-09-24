// Neighbours survive other closes; a numeric position alone does not.
export function captureTabOrder(ids, id) {
  const index = ids.indexOf(id);
  return { index: Math.max(0, index), before: ids.slice(0, index).reverse(), after: ids.slice(index + 1) };
}

export function restoredTabOrderIndex(ids, position) {
  for (const id of position?.after || []) {
    const index = ids.indexOf(id);
    if (index >= 0) return index;
  }
  for (const id of position?.before || []) {
    const index = ids.indexOf(id);
    if (index >= 0) return index + 1;
  }
  return Math.max(0, Math.min(ids.length, Number.isInteger(position?.index) ? position.index : ids.length));
}

export const tabSlotKey = slot => slot.tabId ? 'tab:' + slot.tabId : 'slot:' + slot.slotId;
