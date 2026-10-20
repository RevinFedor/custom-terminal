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

// A wrapped strip is ordered by ROW first. Sorting all rectangles by X mixes
// the second row into the first and can reorder even at the pickup position.
// Keep excluded/source chips in the row geometry: an otherwise empty source
// row still owns a valid insertion slot until the gesture ends.
export function wrappedInsertIndex(chips, clientX, clientY, excludedIds = []) {
  return wrappedInsertTarget(chips, clientX, clientY, excludedIds).at;
}

// Two pointer positions can name the same flat index: the previous row's tail
// and the next row's start. Keep that visual distinction without changing order.
export function wrappedInsertTarget(chips, clientX, clientY, excludedIds = []) {
  const excluded = excludedIds instanceof Set ? excludedIds : new Set(excludedIds || []);
  const rows = [];
  for (const chip of chips || []) {
    if (!chip?.id) continue;
    const top = Number(chip.top) || 0;
    const bottom = Math.max(top + 1, Number(chip.bottom) || top + 1);
    const row = rows[rows.length - 1];
    if (!row || top >= row.bottom - 0.5) rows.push({ top, bottom, chips: [chip] });
    else {
      row.top = Math.min(row.top, top);
      row.bottom = Math.max(row.bottom, bottom);
      row.chips.push(chip);
    }
  }
  let before = 0;
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    const next = rows[i + 1];
    if (!next || clientY < (row.bottom + next.top) / 2) {
      const within = horizontalInsertIndex(row.chips, clientX, excluded);
      const first = row.chips.find(chip => !excluded.has(chip.id));
      return {at: before + within,
        rowStartId: i > 0 && within === 0 && first ? first.id : null};
    }
    before += row.chips.filter((chip) => !excluded.has(chip.id)).length;
  }
  return {at: before, rowStartId: null};
}

export function sameHorizontalOrder(a, b) {
  return a === b || (
    Array.isArray(a)
    && Array.isArray(b)
    && a.length === b.length
    && a.every((value, index) => value === b[index])
  );
}
