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

// ── How much the workspace holds ──────────────────────────────────────────
//
// The limit is stated in the dimension it is actually about: SCREEN COLUMNS.
// Width is the scarce resource — a terminal squeezed under ~300px stops being
// usable — so at most three columns stand side by side. Height is cheaper, so a
// column may be split once into two rows.
//
// It used to be a single flat "at most 3 panes", written when a pane and a
// column were the same thing. Vertical splitting arrived later and silently
// changed what that number meant: it stopped capping the columns on screen and
// started capping the whole GRID, which forbids a 2×2 layout even though that
// is only two columns wide. Reported live: three panes (one column + a stacked
// pair), and splitting the single column was impossible.
export const MAX_SPLIT_COLUMNS = 3;
export const MAX_ROWS_PER_COLUMN = 2;
/** Total cap, derived — used for restore-time truncation, not for decisions. */
export const MAX_SPLIT_PANES = MAX_SPLIT_COLUMNS * MAX_ROWS_PER_COLUMN;

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
  next[at] = paneWithHistoryFrom(
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
// did the user visit before". Started as a single prev slot (one step back for
// the file middle-click); now a LIST, because the per-pane Ctrl+Tab switcher
// navigates the pane's own past — same mechanism, deeper.
//
// The list holds what the pane showed BEFORE its current tab, most recent
// first, deduped, capped. It rides on the pane object itself, so it persists
// with the layout and dies with the pane — a pane's history has no meaning
// once the pane is gone.
export const PANE_HISTORY_CAP = 60; // = GLOBAL_TAB_MRU_CAP; both lists answer "where was I"

/**
 * The pane's visit list. Reads the legacy one-step `prevProjectId/prevTabId`
 * shape as a one-entry history, so sessions saved before the list existed
 * restore with their memory intact.
 */
export function paneHistory(pane) {
  if (!pane) return [];
  if (Array.isArray(pane.history)) return pane.history;
  if (pane.prevTabId) return [{ projectId: pane.prevProjectId, tabId: pane.prevTabId }];
  return [];
}

const pushHistoryEntry = (history, outgoing) => {
  if (!outgoing || !outgoing.tabId) return history.slice(0, PANE_HISTORY_CAP);
  const filtered = history.filter((e) => e && e.tabId !== outgoing.tabId);
  return [{ projectId: outgoing.projectId, tabId: outgoing.tabId }, ...filtered]
    .slice(0, PANE_HISTORY_CAP);
};

/**
 * Build the pane object that replaces `previousPane` with `nextPane`, carrying
 * the history forward with the outgoing tab pushed on top.
 *
 * EVERY writer that swaps a pane's tab must go through this. The pane object is
 * rebuilt from scratch on activation, so anything not explicitly carried is
 * silently erased — that is exactly how the one-step prev field would have
 * vanished, and how the history would quietly reset on every switch.
 */
export function paneWithHistoryFrom(nextPane, previousPane) {
  const prior = paneHistory(previousPane).filter((e) => e && e.tabId !== nextPane.tabId);
  if (!previousPane || !previousPane.tabId || previousPane.tabId === nextPane.tabId) {
    return prior.length > 0 ? { ...nextPane, history: prior } : nextPane;
  }
  return { ...nextPane, history: pushHistoryEntry(prior, previousPane) };
}

/**
 * The pane's history filtered down to what can actually be SHOWN here now:
 * entries whose tab still exists and is not currently visible in any pane
 * (including this pane's own current tab). This is the row source for the
 * per-pane switcher and the step-back target list — one filter, two consumers.
 */
export function restorablePaneHistory(panes, paneIndex, tabExists = () => true) {
  const list = Array.isArray(panes) ? panes : [];
  const pane = list[paneIndex];
  if (!pane) return [];
  const visible = new Set(list.map((p) => p && p.tabId).filter(Boolean));
  return paneHistory(pane).filter((e) => (
    e && e.tabId && !visible.has(e.tabId) && tabExists(e.projectId, e.tabId)
  ));
}

/**
 * Middle-click on a pane showing a FILE: put the pane's previous tab back
 * instead of removing the pane. Steps to the first RESTORABLE entry — a dead
 * or elsewhere-visible head does not kill the gesture when an older entry is
 * still valid.
 *
 * Returns null when there is nothing to step back to — the caller then falls
 * back to the normal "remove this pane" behaviour, so the gesture never becomes
 * a no-op.
 */
export function restorePanePreviousTab(panes, focusedIndex, tabId, tabExists = () => true) {
  const list = Array.isArray(panes) ? panes : [];
  const idx = list.findIndex((p) => p && p.tabId === tabId);
  if (idx === -1) return null;
  const candidates = restorablePaneHistory(list, idx, tabExists);
  if (candidates.length === 0) return null;
  const target = candidates[0];
  const pane = list[idx];
  const next = list.slice();
  const restored = { projectId: target.projectId, tabId: target.tabId };
  if (pane.column !== undefined) restored.column = pane.column;
  // The outgoing tab becomes the newest history entry, so the gesture toggles;
  // everything older survives underneath.
  next[idx] = paneWithHistoryFrom(restored, pane);
  return { panes: next, focusedIndex: clampIndex(next, focusedIndex), restoredIndex: idx };
}

/**
 * Drop one tab from ONE pane's history (middle-click on a row of the pane's
 * switcher list — "forget this", not "close this"). Returns null when nothing
 * changed, so callers can skip the store write.
 */
export function dropFromPaneHistory(panes, paneIndex, tabId) {
  const list = Array.isArray(panes) ? panes : [];
  const pane = list[paneIndex];
  if (!pane || !tabId) return null;
  const history = paneHistory(pane);
  const filtered = history.filter((e) => e && e.tabId !== tabId);
  const hadLegacy = !Array.isArray(pane.history) && !!pane.prevTabId;
  if (filtered.length === history.length && !hadLegacy) return null;
  const next = list.slice();
  // Normalise to the list shape while dropping the legacy prev fields — after a
  // removal they would resurrect the entry on the next paneHistory read.
  const { prevProjectId, prevTabId, ...rest } = pane;
  next[paneIndex] = filtered.length > 0 ? { ...rest, history: filtered } : stripHistory(rest);
  return { panes: next };
}

/**
 * A tab was CLOSED: purge it from every pane's history. A closed tab must not
 * be offered as a step-back target anywhere (restorablePaneHistory would skip
 * it anyway, but a dead entry also wastes the cap and survives into the saved
 * session).
 */
export function dropTabFromAllPaneHistories(panes, tabId) {
  const list = Array.isArray(panes) ? panes : [];
  if (!tabId) return null;
  let changed = false;
  const next = list.map((pane, i) => {
    const res = dropFromPaneHistory(list, i, tabId);
    if (!res) return pane;
    changed = true;
    return res.panes[i];
  });
  return changed ? { panes: next } : null;
}

const stripHistory = (pane) => {
  if (!pane || !('history' in pane)) return pane;
  const { history, ...rest } = pane;
  return rest;
};

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
  // Appending puts the tab in a NEW column, so the column cap decides.
  if (paneColumns(panes).length >= MAX_SPLIT_COLUMNS) return null;
  return { panes: [...panes, added], focusedIndex: panes.length };
}

/**
 * Can this pane still be split, and in which direction?
 *
 * ONE answer for the button, its menu and the model, so the control can be
 * DISABLED with a reason instead of vanishing — a control that disappears at
 * the limit reads as a bug ("кнопка пропала"), while a greyed one with a
 * tooltip states the rule.
 */
export function splitAvailability(panes, paneIndex) {
  const list = Array.isArray(panes) ? panes : [];
  if (list.length === 0) return { horizontal: true, vertical: true, reason: null };
  if (list.some(isEmptyPane)) {
    return { horizontal: false, vertical: false, reason: 'placeholder' };
  }
  const columns = paneColumns(list);
  const horizontal = columns.length < MAX_SPLIT_COLUMNS;
  const idx = clampIndex(list, paneIndex === null || paneIndex === undefined ? 0 : paneIndex);
  const column = paneColumn(list[idx], idx);
  const rowsHere = list.filter((pane, i) => paneColumn(pane, i) === column).length;
  const vertical = rowsHere < MAX_ROWS_PER_COLUMN;
  return {
    horizontal,
    vertical,
    reason: horizontal || vertical ? null : (columns.length >= MAX_SPLIT_COLUMNS ? 'columns-full' : 'rows-full'),
  };
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
  // This gesture opens a NEW COLUMN, so it is capped by columns — not by the
  // total pane count, which would refuse while the screen still has room.
  if (paneColumns(panes).length >= MAX_SPLIT_COLUMNS) return null;
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

  if (panes.some(isEmptyPane)) return null;

  const anchorIndex = clampIndex(panes, atIndex === null || atIndex === undefined ? focusedIndex : atIndex);
  const anchor = panes[anchorIndex];
  if (!anchor) return null;

  const column = paneColumn(anchor, anchorIndex);
  // This gesture stacks INSIDE one column, so only that column's height is at
  // stake: a full neighbouring column must not block it.
  const rowsHere = panes.filter((pane, index) => paneColumn(pane, index) === column).length;
  if (rowsHere >= MAX_ROWS_PER_COLUMN) return null;
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

/**
 * Take a tab OUT OF ITS PANE, leaving the pane itself in place and empty.
 *
 * Two intentions used to run the same code, and both of them destroyed the
 * slot the user had built:
 *   • «закрыть вкладку» (sidebar list, ✕) — the tab is deleted, but the layout
 *     is not part of what was deleted;
 *   • «убрать вкладку из окна» (middle-click on the pane's chip) — the tab goes
 *     on living in the sidebar, it simply stops being SHOWN here.
 * Both end the same way: the pane stays and becomes a placeholder waiting for
 * the next tab. Closing the pane itself is a separate gesture (the ✕ that a
 * placeholder shows) — a window is not something you dismiss by accident while
 * clearing what is inside it.
 *
 * Reported live, twice: a tab open in the second column was closed from the
 * sidebar and the whole pane vanished with it; and the middle-click on the
 * chip removed the pane instead of just emptying it.
 *
 * TWO panes count exactly like three: the second window STAYS and goes empty.
 * The first version collapsed a two-pane split to single mode here, reasoning
 * that "one live pane plus a placeholder is a split of one" — but that is the
 * layout question, and this gesture is not about the layout at all. Reported
 * live: with two windows open, clearing one closed it, because two is the
 * common case and the collapse rule swallowed it. Only the placeholder's own ✕
 * closes a window.
 *
 * Returns null when the tab has no pane.
 */
export function emptyPaneByClosedTab(panes, focusedIndex, tabId) {
  const list = Array.isArray(panes) ? panes : [];
  if (!tabId) return null;
  const idx = list.findIndex((p) => p && p.tabId === tabId);
  if (idx === -1) return null;
  const pane = list[idx];
  const next = list.slice();
  // The slot keeps its COLUMN — the geometry the user built is what stays.
  // History goes with the tab: it named tabs shown in this slot, and the entry
  // for a closed tab is purged anyway (dropTabFromAllPaneHistories).
  next[idx] = pane.column !== undefined
    ? { projectId: '', tabId: '', column: pane.column }
    : { projectId: '', tabId: '' };
  return { panes: next, focusedIndex: clampIndex(next, focusedIndex), emptiedIndex: idx };
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

// Restore-time validation: keep panes whose tab still exists, PLUS windows the
// user deliberately left empty. A split needs at least two panes to survive.
// Each surviving pane's HISTORY is scrubbed of dead tabs too — entries for tabs
// deleted while the app was closed would otherwise sit in the saved layout
// forever.
//
// An empty pane used to be purely session-transient (the split button opens one
// and the next activation fills it, so losing it on restart cost nothing). Once
// clearing a window became a normal gesture, that stopped being true: a window
// the user emptied on purpose is part of the layout, and dropping it on restart
// silently closed a window they had chosen to keep.
export function sanitizePanes(panes, focusedIndex, tabExists) {
  const valid = (Array.isArray(panes) ? panes : [])
    .filter((p) => (
      p && typeof p.projectId === 'string' && typeof p.tabId === 'string'
      && (!p.tabId || tabExists(p.projectId, p.tabId))
    ))
    .map((p) => {
      const history = paneHistory(p).filter((e) => e && e.tabId && tabExists(e.projectId, e.tabId));
      const { prevProjectId, prevTabId, ...rest } = p;
      return history.length > 0 ? { ...rest, history } : stripHistory(rest);
    });
  // An all-empty layout is not a layout — nothing to come back to.
  if (valid.length < 2 || !valid.some((p) => p.tabId)) return { panes: [], focusedIndex: 0 };
  // Truncation keeps whole COLUMNS: a flat slice can cut a stacked column in
  // half and leave a lone row where the user had a pair. Restores are already
  // within the caps in practice — this is the backstop for a hand-edited or
  // future-version session.
  const kept = [];
  paneColumns(valid).slice(0, MAX_SPLIT_COLUMNS).forEach((rows) => {
    rows.slice(0, MAX_ROWS_PER_COLUMN).forEach(({ pane }) => kept.push(pane));
  });
  const next = normalizeColumns(kept);
  if (next.length < 2) return { panes: [], focusedIndex: 0 };
  return { panes: next, focusedIndex: clampIndex(next, focusedIndex) };
}

// Geometry: equal columns, no draggable divider (v1). Returns percent rects.
export function paneRects(count) {
  const n = Math.max(1, count);
  const w = 100 / n;
  return Array.from({ length: n }, (_, i) => ({ leftPct: i * w, widthPct: w }));
}

// ── Resizable dividers ────────────────────────────────────────────────────
//
// Sizes are FRACTIONS, not pixels: `cols[c]` is column c's share of the full
// width (summing to 1), `rows[c][j]` is row j's share of column c's height.
// Fractions survive window resizes and monitor moves unchanged, which is what
// a saved layout must do.
//
// The sizes object lives BESIDE the panes (its own store/session field), not
// on the pane objects: a column's width belongs to the column, not to any one
// pane in it — and pane objects are rebuilt wholesale on every activation, so
// geometry riding on them would need carrying through every writer (the
// paneWithHistoryFrom lesson, for a field no tab writer cares about).
//
// DRIFT RULE: panes change without the sizes knowing (pane added or removed,
// whole project closed). Every reader therefore normalizes AT READ TIME
// against the current structure — a dimension whose stored count still
// matches keeps its fractions, a dimension that no longer matches resets to
// equal. No pane writer needs to know sizes exist, which is the whole reason
// none of them had to change for this feature.

export const SPLIT_MIN_FRACTION = 0.15;

const equalFractions = (n) => {
  const count = Math.max(1, n | 0);
  return Array.from({ length: count }, () => 1 / count);
};

const validFractionList = (list, count) => (
  Array.isArray(list) && list.length === count
  && list.every((f) => Number.isFinite(f) && f > 0)
);

// Stored fractions may carry float drift from earlier resizes; readers always
// see an exact sum of 1.
const renormalizeFractions = (list) => {
  const sum = list.reduce((a, b) => a + b, 0);
  return sum > 0 ? list.map((f) => f / sum) : equalFractions(list.length);
};

/**
 * Materialize sizes for the CURRENT pane structure: kept where the stored
 * count matches, equal where it does not (or where nothing is stored).
 */
export function normalizeSplitSizes(panes, sizes) {
  const columns = paneColumns(panes);
  if (columns.length === 0) return { cols: [], rows: [] };
  const cols = validFractionList(sizes && sizes.cols, columns.length)
    ? renormalizeFractions(sizes.cols)
    : equalFractions(columns.length);
  const rows = columns.map((rowsOfCol, c) => (
    validFractionList(sizes && sizes.rows && sizes.rows[c], rowsOfCol.length)
      ? renormalizeFractions(sizes.rows[c])
      : equalFractions(rowsOfCol.length)
  ));
  return { cols, rows };
}

const EQUAL_EPS = 1e-3;
const isEqualSplit = (list) => list.every((f) => Math.abs(f - 1 / list.length) < EQUAL_EPS);

/**
 * The STORED form: null when every dimension is an equal split. An untouched
 * layout stores no sizes at all — same storage philosophy as `column`: the
 * default is absent, so legacy sessions and equality checks stay byte-stable,
 * and stale sizes from a dead layout self-clean on the next pack.
 */
export function packSplitSizes(panes, sizes) {
  const norm = normalizeSplitSizes(panes, sizes);
  if (norm.cols.length === 0) return null;
  if (isEqualSplit(norm.cols) && norm.rows.every(isEqualSplit)) return null;
  return norm;
}

/**
 * Drag math for ONE divider in a fraction list: move `deltaFr` from the right
 * neighbour to the left one (negative = the other way), clamped so neither
 * drops below `minFr`. Total is preserved by construction. Returns the input
 * list unchanged when the divider index is invalid or there is no room.
 */
export function resizeFractions(fractions, dividerIndex, deltaFr, minFr = SPLIT_MIN_FRACTION) {
  const list = Array.isArray(fractions) ? fractions : [];
  const k = dividerIndex | 0;
  if (k < 0 || k >= list.length - 1 || !Number.isFinite(deltaFr)) return list;
  const a = list[k];
  const b = list[k + 1];
  const low = minFr - a;
  const high = b - minFr;
  if (low > high) return list; // both neighbours already at the minimum
  const d = Math.max(low, Math.min(high, deltaFr));
  if (d === 0) return list;
  const next = list.slice();
  next[k] = a + d;
  next[k + 1] = b - d;
  return next;
}

/** Short stable string for memo/selector keys; '' when sizes are absent. */
export function splitSizesFingerprint(sizes) {
  if (!sizes) return '';
  const f = (x) => Math.round(x * 1000);
  return (sizes.cols || []).map(f).join(',')
    + '|' + (sizes.rows || []).map((r) => r.map(f).join(',')).join(';');
}

/**
 * The dividers to render, with their line positions in percent:
 *   {kind:'col', dividerIndex, xPct}                       — between columns
 *   {kind:'row', columnIndex, dividerIndex, yPct, leftPct, widthPct}
 *                                                          — between rows
 * `id` is stable across drags ('col:0', 'row:1:0') for React keys and DOM
 * lookup during the live drag.
 */
export function splitDividerDescriptors(panes, sizes = null) {
  const columns = paneColumns(panes);
  if (columns.length === 0) return [];
  const norm = normalizeSplitSizes(panes, sizes);
  const out = [];
  let left = 0;
  columns.forEach((rows, c) => {
    const widthPct = norm.cols[c] * 100;
    if (c < columns.length - 1) {
      out.push({ id: `col:${c}`, kind: 'col', dividerIndex: c, xPct: left + widthPct });
    }
    let top = 0;
    rows.forEach((_, j) => {
      const heightPct = norm.rows[c][j] * 100;
      if (j < rows.length - 1) {
        out.push({
          id: `row:${c}:${j}`,
          kind: 'row',
          columnIndex: c,
          dividerIndex: j,
          yPct: top + heightPct,
          leftPct: left,
          widthPct,
        });
      }
      top += heightPct;
    });
    left += widthPct;
  });
  return out;
}

/**
 * Full 2-D geometry: fractional columns across the width, fractional rows
 * inside each column — equal splits when `sizes` is absent. Returns one rect
 * per pane, in the SAME order as the panes array, so callers index it
 * directly.
 */
export function paneGridRects(panes, sizes = null) {
  const columns = paneColumns(panes);
  const rects = new Array(Array.isArray(panes) ? panes.length : 0);
  if (!sizes) {
    // The exact pre-resize arithmetic (i * 100/n, not cumsum of 1/n): the two
    // differ in the last float digit, and every consumer of the default
    // geometry — tests included — is pinned to this form.
    const colCount = Math.max(1, columns.length);
    const colW = 100 / colCount;
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
  const norm = normalizeSplitSizes(panes, sizes);
  let left = 0;
  columns.forEach((rows, columnIndex) => {
    const widthPct = norm.cols[columnIndex] * 100;
    let top = 0;
    rows.forEach(({ index }, rowIndex) => {
      const heightPct = norm.rows[columnIndex][rowIndex] * 100;
      rects[index] = { leftPct: left, widthPct, topPct: top, heightPct };
      top += heightPct;
    });
    left += widthPct;
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
