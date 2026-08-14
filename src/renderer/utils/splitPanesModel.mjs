// Pure rules of the split workspace (up to 3 panes side-by-side).
//
// A pane = { projectId, tabId }. `panes.length === 0` — single mode: the
// center shows ONE tab (store.centerTab). Focus is an index into panes; the
// focused pane's tab (or centerTab in single mode) is what every tab-owned
// surface (control bar, History, Timeline, task plan) follows.
//
// The CENTER is decoupled from the sidebar project: activating a tab changes
// only what the center shows, and an explicit project click (titlebar,
// dashboard, project chip in the attach row) moves ONLY the sidebar pointer
// (focusedProjectId) — it never activates a tab and never touches the panes.
//
// Approved navigation rule (one rule for sidebar click / Ctrl+Tab / Cmd+P —
// i.e. every TAB activation):
//   • target tab already visible in a pane → focus that pane, composition
//     unchanged;
//   • otherwise → the pane in focus replaces its tab with the target.

export const MAX_SPLIT_PANES = 3;

// ── Two dimensions ────────────────────────────────────────────────────────
//
// A pane carries a `column` index. The panes array stays FLAT and stays the
// single source of identity: focus is still an index into it, and activation,
// removal, restore and the tab lookups are untouched by the second dimension.
// Only GEOMETRY reads `column`.
//
// That is deliberate. Turning the list into a real tree would have rewritten
// every one of those rules at once; here the invariant is small enough to state
// in one line and check in one function:
//
//   panes are ordered by column; within a column, array order is row order.
//
// STORAGE RULE, and the whole reason this stays readable:
//
//   a purely horizontal layout stores NO `column` at all — byte-identical to
//   what was saved before this feature existed. `column` appears only once a
//   layout actually stacks, and then it appears on EVERY pane.
//
// So a missing column means "this pane is its own column, at its array
// position". That is what every legacy session is, and it restores unchanged.
// Reading a missing column as 0 instead would have stacked every restored
// layout into one column — same panes, same order, completely different
// screen. The pre-existing horizontal-split test caught exactly that.
//
// The mixed case (some panes with a column, some without) is never produced:
// normalizeColumns writes all-or-nothing.
const paneColumn = (pane, index) => {
  const c = Number(pane && pane.column);
  return Number.isFinite(c) && c >= 0 ? Math.floor(c) : index;
};

/** Columns as arrays of {pane, index}, left to right, rows top to bottom. */
export function paneColumns(panes) {
  const list = Array.isArray(panes) ? panes : [];
  const byColumn = new Map();
  list.forEach((pane, index) => {
    const col = paneColumn(pane, index);
    if (!byColumn.has(col)) byColumn.set(col, []);
    byColumn.get(col).push({ pane, index });
  });
  return [...byColumn.keys()].sort((a, b) => a - b).map((col) => byColumn.get(col));
}

/**
 * Close gaps in column numbering and restore the sort invariant.
 *
 * Removing the only pane of a middle column would otherwise leave columns
 * [0, 2]: the geometry still renders two columns, but every index-based rule
 * that assumes "column N is the Nth column on screen" silently points one
 * column too far right.
 */
export function normalizeColumns(panes) {
  const columns = paneColumns(panes);
  // Nothing stacked → canonical legacy shape, no column fields at all. Keeps
  // saved sessions and object equality exactly as they were.
  const stacked = columns.some((rows) => rows.length > 1);
  const flat = [];
  columns.forEach((rows, columnIndex) => {
    rows.forEach(({ pane }) => {
      // When stacking, the column is written EXPLICITLY on every pane: after
      // this, a pane's column never depends on its array position again, so a
      // later splice cannot move it to a different column by accident.
      flat.push(stacked ? { ...pane, column: columnIndex } : stripColumn(pane));
    });
  });
  return flat;
}

// Column 0 is the default, so it is never stored — keeps saved layouts and
// equality checks identical to what they were before this feature.
const stripColumn = (pane) => {
  if (!pane || !('column' in pane)) return pane;
  const { column, ...rest } = pane;
  return rest;
};

// An EMPTY pane ({ projectId: '', tabId: '' }) is a placeholder slot: the
// user pressed the split button and has not picked the new pane's tab yet.
// It is focusable, invisible to tab lookups (no real tabId), never survives
// a restart (sanitizePanes drops it), and the next activation fills the
// focused placeholder through the standard replace rule.
export const isEmptyPane = (p) => !p || !p.tabId;

const clampIndex = (panes, index) => Math.max(0, Math.min(panes.length - 1, index | 0));

const finalizeRemoval = (panes, focusedIndex, idx) => {
  const filtered = panes.filter((_, i) => i !== idx);
  const real = filtered.filter((p) => !isEmptyPane(p));
  // A split needs ≥2 REAL panes to stay a split; a dangling [real, empty]
  // pair collapses too (placeholder without a purpose).
  if (real.length <= 1) {
    // Name the pane that SURVIVED. Collapsing returns an empty list, so there
    // is no focus index left to read the answer from — and the caller needs
    // one, because single mode shows exactly one tab. Without this the center
    // kept showing the tab whose pane had just been removed, which is visible
    // every time the removed pane was the focused one.
    return { panes: [], focusedIndex: 0, survivor: real[0] || null };
  }
  let focus = focusedIndex;
  if (idx < focus) focus -= 1;
  // Emptying a middle column must not leave a hole in the numbering — see
  // normalizeColumns. Order is preserved, so the focus index still points at
  // the same pane.
  const next = normalizeColumns(filtered);
  return { panes: next, focusedIndex: clampIndex(next, focus), survivor: null };
};

// Activation of (projectId, tabId) with split active. Returns next state.
export function resolveSplitActivation(panes, focusedIndex, projectId, tabId) {
  if (!Array.isArray(panes) || panes.length === 0) {
    return { panes: [], focusedIndex: 0, changed: false };
  }
  const existing = panes.findIndex((p) => p && p.tabId && p.tabId === tabId);
  if (existing >= 0) {
    return { panes, focusedIndex: existing, changed: existing !== focusedIndex };
  }
  const at = clampIndex(panes, focusedIndex);
  const next = panes.slice();
  // Keep the slot's COLUMN: activation changes which tab a pane shows, never
  // where that pane is. Writing a bare {projectId, tabId} dropped the column
  // and the pane silently jumped out of its stack — measured live: filling the
  // lower row of a split column turned two stacked 409px rows into two 623px
  // side-by-side columns.
  const slot = panes[at];
  next[at] = withPrevTab(
    slot && slot.column !== undefined
      ? { projectId, tabId, column: slot.column }
      : { projectId, tabId },
    slot,
  );
  return { panes: next, focusedIndex: at, changed: true };
}

// ── What this pane showed before ──────────────────────────────────────────
//
// Recency at PANE level, which the global tab history cannot answer: "what was
// in THIS slot before the current tab" is a different question from "which tab
// did the user visit before". Middle-clicking a file pane restores the pane's
// own previous tab, so the pane keeps existing and only its content steps back.
//
// One step is enough for the gesture (file → back to the agent that opened it)
// and one step cannot grow stale the way a list would.
const withPrevTab = (nextPane, previousPane) => {
  if (!previousPane || !previousPane.tabId) return nextPane;
  if (previousPane.tabId === nextPane.tabId) return nextPane;
  return { ...nextPane, prevProjectId: previousPane.projectId, prevTabId: previousPane.tabId };
};

/**
 * Middle-click on a pane showing a FILE: put the pane's previous tab back
 * instead of removing the pane.
 *
 * Returns null when there is nothing to step back to — the caller then falls
 * back to the normal "remove this pane" behaviour, so the gesture never becomes
 * a no-op.
 */
export function restorePanePreviousTab(panes, focusedIndex, tabId, tabExists = () => true) {
  const list = Array.isArray(panes) ? panes : [];
  const idx = list.findIndex((p) => p && p.tabId === tabId);
  if (idx === -1) return null;
  const pane = list[idx];
  if (!pane.prevTabId) return null;
  // A tab closed while the file was open must not resurrect as a dead pane.
  if (!tabExists(pane.prevProjectId, pane.prevTabId)) return null;
  if (list.some((p, i) => i !== idx && p.tabId === pane.prevTabId)) return null;
  const next = list.slice();
  const restored = { projectId: pane.prevProjectId, tabId: pane.prevTabId };
  if (pane.column !== undefined) restored.column = pane.column;
  // The file becomes the pane's "previous" in turn, so the gesture toggles.
  next[idx] = { ...restored, prevProjectId: pane.projectId, prevTabId: pane.tabId };
  return { panes: next, focusedIndex: clampIndex(next, focusedIndex), restoredIndex: idx };
}

// ПКМ «Добавить в рабочую область». From single mode the current center tab
// becomes pane 0 and the added tab pane 1. An existing empty placeholder is
// filled instead of appending a third column. Returns null when nothing to do
// (same tab, already present, or the workspace is full).
export function addPane(panes, focusedIndex, current, added) {
  if (!added || !added.tabId) return null;
  if (panes.some((p) => p.tabId === added.tabId)) return null;
  if (panes.length === 0) {
    if (!current || !current.tabId || current.tabId === added.tabId) return null;
    return { panes: [current, added], focusedIndex: 1 };
  }
  const emptyIdx = panes.findIndex(isEmptyPane);
  if (emptyIdx >= 0) {
    const next = panes.slice();
    // Same rule as resolveSplitActivation: the placeholder's COLUMN is part of
    // the layout the user built, not part of the tab being dropped into it.
    const slot = panes[emptyIdx];
    next[emptyIdx] = slot && slot.column !== undefined
      ? { ...added, column: slot.column }
      : added;
    return { panes: next, focusedIndex: emptyIdx };
  }
  if (panes.length >= MAX_SPLIT_PANES) return null;
  return { panes: [...panes, added], focusedIndex: panes.length };
}

// Split button in the attach row: open a new EMPTY pane and focus it. From
// single mode the current center tab becomes pane 0. Only one placeholder at
// a time — a second click while one is open is a no-op. `afterIndex` is the
// pane the button was pressed in: the placeholder opens immediately to its
// RIGHT (pressing split in pane 0 of [A,B] gives [A,∅,B], not [A,B,∅]).
export function addEmptyPane(panes, focusedIndex, current, afterIndex = null) {
  if (!Array.isArray(panes)) return null;
  if (panes.length === 0) {
    if (!current || !current.tabId) return null;
    return { panes: [stripColumn(current), { projectId: '', tabId: '' }], focusedIndex: 1 };
  }
  if (panes.length >= MAX_SPLIT_PANES) return null;
  if (panes.some(isEmptyPane)) return null;

  // A horizontal split opens a NEW COLUMN right of the pressed pane's column,
  // so everything at or beyond it shifts one column right. Without this, a
  // pane split sideways inside a column that was itself split vertically would
  // silently join that column as another row — i.e. the opposite direction.
  const anchorIndex = afterIndex === null
    ? clampIndex(panes, focusedIndex)
    : clampIndex(panes, afterIndex);
  const anchorColumn = paneColumn(panes[anchorIndex], anchorIndex);
  const newColumn = anchorColumn + 1;

  const shifted = panes.map((pane, index) => {
    const col = paneColumn(pane, index);
    return col >= newColumn ? { ...pane, column: col + 1 } : { ...pane, column: col };
  });
  // Keep the flat array sorted by column: the placeholder goes after the last
  // pane of the anchor's column.
  let insertAt = shifted.length;
  for (let i = 0; i < shifted.length; i += 1) {
    if (paneColumn(shifted[i], i) > anchorColumn) { insertAt = i; break; }
  }
  const next = shifted.slice();
  next.splice(insertAt, 0, { projectId: '', tabId: '', column: newColumn });
  // normalizeColumns strips the columns again if the result is purely
  // horizontal — the common case, and the one that must stay legacy-shaped.
  return { panes: normalizeColumns(next), focusedIndex: insertAt };
}

/**
 * Right-click on the split button: open an empty pane ABOVE or BELOW the pane
 * it was pressed in, inside that pane's own column.
 *
 * From single mode the current center tab becomes the first pane, exactly as
 * the horizontal split does — the two gestures differ only in which direction
 * the new slot opens.
 */
export function addEmptyPaneVertical(panes, focusedIndex, current, atIndex, side = 'below') {
  if (!Array.isArray(panes)) return null;
  const placeholder = { projectId: '', tabId: '' };

  if (panes.length === 0) {
    if (!current || !current.tabId) return null;
    // BOTH panes must carry column 0 explicitly. Leaving the column off would
    // mean "each pane is its own column" (the storage rule above) — i.e. the
    // horizontal split, which is the opposite of what was asked. Measured
    // live before this was fixed: two 623px columns side by side, equal
    // height, instead of one column of two half-height rows.
    const first = { ...current, column: 0 };
    const added = { ...placeholder, column: 0 };
    return side === 'above'
      ? { panes: [added, first], focusedIndex: 0 }
      : { panes: [first, added], focusedIndex: 1 };
  }

  if (panes.length >= MAX_SPLIT_PANES) return null;
  if (panes.some(isEmptyPane)) return null;

  const anchorIndex = clampIndex(panes, atIndex === null || atIndex === undefined ? focusedIndex : atIndex);
  const anchor = panes[anchorIndex];
  if (!anchor) return null;

  const column = paneColumn(anchor, anchorIndex);
  // Every column becomes explicit BEFORE splicing: with implicit columns an
  // insertion shifts array positions and therefore silently re-columns every
  // pane after it. This call always stacks, so the explicit form is the
  // canonical one here.
  const next = panes.map((pane, index) => ({ ...pane, column: paneColumn(pane, index) }));
  // Inserting directly beside the anchor keeps the flat array sorted by column
  // AND puts the new row in the right vertical position within that column.
  const insertAt = side === 'above' ? anchorIndex : anchorIndex + 1;
  next.splice(insertAt, 0, { ...placeholder, column });
  return { panes: next, focusedIndex: insertAt };
}

// Remove a tab's pane (close tab / ПКМ «Убрать»). A single remaining REAL
// pane collapses the split back to single mode.
export function removePaneByTab(panes, focusedIndex, tabId) {
  if (!tabId) return null;
  const idx = panes.findIndex((p) => p.tabId === tabId);
  if (idx === -1) return null;
  return finalizeRemoval(panes, focusedIndex, idx);
}

// Remove a pane by position — the only way to close an EMPTY placeholder
// (✕ in its row or Escape while it is focused).
export function removePaneAt(panes, focusedIndex, index) {
  if (!Array.isArray(panes) || index < 0 || index >= panes.length) return null;
  return finalizeRemoval(panes, focusedIndex, index);
}

export function removePanesByProject(panes, focusedIndex, projectId) {
  if (!projectId) return null;
  const next = panes.filter((p) => p.projectId !== projectId);
  if (next.length === panes.length) return null;
  if (next.filter((p) => !isEmptyPane(p)).length <= 1) return { panes: [], focusedIndex: 0 };
  const focusedTab = panes[clampIndex(panes, focusedIndex)];
  const keptFocus = next.findIndex((p) => p.tabId === focusedTab?.tabId);
  return { panes: next, focusedIndex: keptFocus >= 0 ? keptFocus : 0 };
}

// Restore-time validation: keep only panes whose tab still exists (this also
// drops empty placeholders — they are session-transient); a split needs at
// least two live panes to survive.
export function sanitizePanes(panes, focusedIndex, tabExists) {
  const valid = (Array.isArray(panes) ? panes : []).filter((p) => (
    p && typeof p.projectId === 'string' && typeof p.tabId === 'string'
    && p.tabId && tabExists(p.projectId, p.tabId)
  ));
  if (valid.length < 2) return { panes: [], focusedIndex: 0 };
  return { panes: valid.slice(0, MAX_SPLIT_PANES), focusedIndex: clampIndex(valid, focusedIndex) };
}

// Geometry: equal columns, no draggable divider (v1). Returns percent rects.
export function paneRects(count) {
  const n = Math.max(1, count);
  const w = 100 / n;
  return Array.from({ length: n }, (_, i) => ({ leftPct: i * w, widthPct: w }));
}

/**
 * Full 2-D geometry: equal columns across the width, equal rows inside each
 * column. Returns one rect per pane, in the SAME order as the panes array, so
 * callers index it directly.
 */
export function paneGridRects(panes) {
  const columns = paneColumns(panes);
  const colCount = Math.max(1, columns.length);
  const colW = 100 / colCount;
  const rects = new Array(Array.isArray(panes) ? panes.length : 0);
  columns.forEach((rows, columnIndex) => {
    const rowH = 100 / Math.max(1, rows.length);
    rows.forEach(({ index }, rowIndex) => {
      rects[index] = {
        leftPct: columnIndex * colW,
        widthPct: colW,
        topPct: rowIndex * rowH,
        heightPct: rowH,
      };
    });
  });
  return rects;
}

/** True when this pane shares its column with another — i.e. it is short. */
export function paneIsStacked(panes, index) {
  const list = Array.isArray(panes) ? panes : [];
  const target = list[index];
  if (!target) return false;
  const col = paneColumn(target, index);
  let seen = 0;
  list.forEach((pane, i) => { if (paneColumn(pane, i) === col) seen += 1; });
  return seen > 1;
}

// ── Layout map: "which pane is this tab in", drawn as cells ────────────────
//
// The sidebar card cannot answer "where is this tab open" with tints or edges:
// its edges already carry the process bar, its left inset the status marker,
// its bottom the task squares, and the active-tab background highlight was
// deliberately removed. So the answer is a tiny map whose CELL POSITION mirrors
// the pane's POSITION ON SCREEN — read without reading.
//
// Returns one cell per pane, left-to-right in screen order:
//   state 'self-focused' — this tab's pane, and it holds focus
//   state 'self'         — this tab's pane, not focused
//   state 'other'        — some other pane
// Single mode (panes.length === 0) still returns ONE cell so an open tab always
// carries a mark; `mine` is then simply "is this the center tab".
//
// Returns [] when the tab is in no pane at all. Callers must still RESERVE the
// slot in that case — a map that appears and disappears makes the tab name
// jitter every time the tab enters or leaves the workspace.
export function paneMapCells(panes, focusedIndex, projectId, tabId, centerTab = null) {
  const list = Array.isArray(panes) ? panes : [];
  if (list.length === 0) {
    const isCenter = !!centerTab
      && centerTab.projectId === projectId
      && centerTab.tabId === tabId;
    // The single center surface is always the focused one by definition.
    return isCenter ? [{ mine: true, state: 'self-focused' }] : [];
  }
  const focus = clampIndex(list, focusedIndex);
  let found = false;
  const cells = list.map((pane, index) => {
    const mine = !!pane && pane.projectId === projectId && pane.tabId === tabId;
    if (mine) found = true;
    return {
      mine,
      state: mine ? (index === focus ? 'self-focused' : 'self') : 'other',
    };
  });
  return found ? cells : [];
}

/**
 * Same answer as paneMapCells, but shaped as COLUMNS OF ROWS so the mark can
 * mirror a 2-D layout. A flat cell list cannot: two panes stacked in one column
 * would draw as two side-by-side cells, i.e. as a layout the user does not have.
 *
 * Returns [] when the tab is in no pane — callers still reserve the slot.
 */
export function paneMapGrid(panes, focusedIndex, projectId, tabId, centerTab = null) {
  const list = Array.isArray(panes) ? panes : [];
  if (list.length === 0) {
    const flat = paneMapCells(list, focusedIndex, projectId, tabId, centerTab);
    return flat.length > 0 ? [flat] : [];
  }
  const focus = clampIndex(list, focusedIndex);
  let found = false;
  const grid = paneColumns(list).map((rows) => rows.map(({ pane, index }) => {
    const mine = !!pane && pane.projectId === projectId && pane.tabId === tabId;
    if (mine) found = true;
    return { mine, state: mine ? (index === focus ? 'self-focused' : 'self') : 'other' };
  }));
  return found ? grid : [];
}
