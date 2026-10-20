'use strict';

// Window presentation only. Callers own geometry, canonical order, membership
// and persistence. A descriptor never supplies authority to change any of them.
const validWidth = width => typeof width === 'number' && Number.isFinite(width) && width > 0;
function sameOrder(a, b) {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index++) if (a[index] !== b[index]) return false;
  return true;
}
function idSet(ids) {
  if (!Array.isArray(ids)) return null;
  const result = new Set();
  for (const id of ids) {
    if (typeof id !== 'string' || !id.length || result.has(id)) return null;
    result.add(id);
  }
  return result;
}

function descriptor(order, width, starts) {
  // Canonical order without sorting; a break before item zero is redundant.
  const rowStartIds = order.filter((id, index) => index > 0 && starts.has(id));
  return rowStartIds.length ? {version: 1, width, order: [...order], rowStartIds} : null;
}

/** Read unknown/stale metadata as natural wrapping (null). The FULL expected
 * order is required, width is optional; when supplied it must match within
 * 0.5 CSS px. Invalid/duplicate/foreign breaks reject the descriptor. A valid
 * first-item break is omitted, and no effective breaks canonicalize to null.
 * Arrays are fresh copies, never aliases of the input.
 */
function normalizePaneStripRowPlacement(value, options = {}) {
  if (!options || !value || value.version !== 1 || !validWidth(value.width)) return null;
  const {order, width} = options;
  const members = idSet(order);
  if (!members || !Array.isArray(value.order) || !sameOrder(value.order, order)) return null;
  if (width !== undefined && (!validWidth(width) || Math.abs(value.width - width) > 0.5)) return null;
  const starts = idSet(value.rowStartIds);
  if (!starts) return null;
  for (const id of starts) if (!members.has(id)) return null;
  return descriptor(order, value.width, starts);
}

/** Project ONLY a source move onto the caller's complete target order.
 * Non-source order/membership must be unchanged; otherwise return null rather
 * than inventing a repair. Incoming/outgoing source IDs are allowed. Sources
 * are never narrowed to a group or to IDs present in one of the two strips.
 *
 * Old breaks survive only from an exact base-order / matching-width descriptor,
 * and breaks owned by any source are removed. An explicit rowStartId transfers
 * (or creates) a break to the first incoming source, but only when ALL sources
 * form one contiguous block immediately before that non-source anchor. Invalid
 * anchors are ignored; unaffected old breaks still survive. No implicit anchor
 * inference: the same flat order can mean a previous-row tail or a new row.
 *
 * O(baseOrder.length + order.length + sourceIds.length + current size).
 */
function projectPaneStripRowPlacement(options = {}) {
  if (!options) return null;
  const {current, baseOrder, order, sourceIds, rowStartId, width} = options;
  if (!validWidth(width) || !idSet(baseOrder) || !idSet(order)) return null;
  const sources = idSet(sourceIds);
  if (!sources) return null;
  const before = baseOrder.filter(id => !sources.has(id));
  const after = order.filter(id => !sources.has(id));
  if (!sameOrder(before, after)) return null;

  const previous = normalizePaneStripRowPlacement(current, {order: baseOrder, width});
  const starts = new Set((previous?.rowStartIds || []).filter(id => !sources.has(id)));
  if (typeof rowStartId === 'string' && !sources.has(rowStartId) && sources.size) {
    let first = -1, incomingCount = 0, anchor = -1;
    for (let index = 0; index < order.length; index++) {
      if (order[index] === rowStartId) anchor = index;
      if (sources.has(order[index])) {
        if (first < 0) first = index;
        incomingCount++;
      }
    }
    let contiguous = incomingCount === sources.size && anchor === first + incomingCount;
    if (contiguous) {
      for (let index = first; index < anchor; index++) {
        if (!sources.has(order[index])) { contiguous = false; break; }
      }
    }
    if (contiguous) {
      starts.delete(rowStartId);
      if (first > 0) starts.add(order[first]);
    }
  }
  return descriptor(order, width, starts);
}

/** Equality of normalized presentation, treating invalid/absent as null.
 * Width equality is exact: the 0.5 px read tolerance is NOT an equivalence
 * relation and must not conceal a newly captured width from a caller's writer.
 */
function samePaneStripRowPlacement(a, b) {
  const left = normalizePaneStripRowPlacement(a, {order: a?.order});
  const right = normalizePaneStripRowPlacement(b, {order: b?.order});
  if (!left || !right) return left === right;
  return left.width === right.width && sameOrder(left.order, right.order)
    && sameOrder(left.rowStartIds, right.rowStartIds);
}

module.exports = {normalizePaneStripRowPlacement, projectPaneStripRowPlacement, samePaneStripRowPlacement};
