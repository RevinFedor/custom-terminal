// Small, host-neutral horizontal reorder helpers.
//
// Project chips, workflow chips and pane-tab chips have different persistence
// owners, but the pointer promise is identical: the visible preview and the
// committed order use the same insertion calculation.  Keeping that arithmetic
// here prevents three subtly different forward-move corrections.

export function reorderHorizontalIds(ids, sourceId, targetId, edge = 'left') {
  const list = Array.isArray(ids) ? ids.filter(Boolean) : [];
  if (!sourceId || !targetId || sourceId === targetId) return list;
  if (!list.includes(sourceId) || !list.includes(targetId)) return list;
  const next = list.filter((id) => id !== sourceId);
  const targetIndex = next.indexOf(targetId);
  if (targetIndex === -1) return list;
  const at = targetIndex + (edge === 'right' ? 1 : 0);
  next.splice(at, 0, sourceId);
  return next.every((id, index) => id === list[index]) ? list : next;
}

export function moveEntriesToIndex(entries, incomingEntries, at, idOf = (entry) => entry?.tabId ?? entry?.id) {
  const base = Array.isArray(entries) ? entries : [];
  const incoming = [];
  const incomingIds = new Set();
  (Array.isArray(incomingEntries) ? incomingEntries : []).forEach((entry) => {
    const id = idOf(entry);
    if (!id || incomingIds.has(id)) return;
    incomingIds.add(id);
    incoming.push(entry);
  });
  if (incoming.length === 0) return base;
  const rest = base.filter((entry) => !incomingIds.has(idOf(entry)));
  const insertAt = Math.max(0, Math.min(rest.length, Number.isFinite(at) ? Math.trunc(at) : rest.length));
  const next = rest.slice();
  next.splice(insertAt, 0, ...incoming);
  if (next.length === base.length && next.every((entry, index) => idOf(entry) === idOf(base[index]))) {
    return base;
  }
  return next;
}

export function horizontalInsertIndex(chips, clientX, excludedIds = []) {
  const excluded = excludedIds instanceof Set ? excludedIds : new Set(excludedIds || []);
  const visible = (Array.isArray(chips) ? chips : [])
    .filter((chip) => chip && chip.id && !excluded.has(chip.id))
    .sort((a, b) => Number(a.left) - Number(b.left));
  let at = 0;
  for (const chip of visible) {
    const left = Number(chip.left);
    const right = Number(chip.right);
    const midpoint = Number.isFinite(right)
      ? (left + right) / 2
      : left + Math.max(0, Number(chip.width) || 0) / 2;
    if (clientX < midpoint) break;
    at += 1;
  }
  return at;
}

export function sameHorizontalOrder(a, b) {
  return a === b || (
    Array.isArray(a)
    && Array.isArray(b)
    && a.length === b.length
    && a.every((value, index) => value === b[index])
  );
}
