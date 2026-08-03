// Pure rules of the split workspace (up to 3 panes side-by-side).
//
// A pane = { projectId, tabId }. `panes.length === 0` — single mode: the
// center shows ONE tab (store.centerTab). Focus is an index into panes; the
// focused pane's tab (or centerTab in single mode) is what every tab-owned
// surface (control bar, History, Timeline, task plan) follows.
//
// The CENTER is decoupled from the sidebar project: activating a tab changes
// only what the center shows. activeProjectId (sidebar/toolbar/git) moves
// ONLY on an explicit project click (titlebar, dashboard, project chip in the
// attach row) — never as a side effect of a tab switch or pane focus.
//
// Approved navigation rule (one rule for sidebar click / Ctrl+Tab / Cmd+P /
// project click):
//   • target tab already visible in a pane → focus that pane, composition
//     unchanged;
//   • otherwise → the pane in focus replaces its tab with the target.

export const MAX_SPLIT_PANES = 3;

// An EMPTY pane ({ projectId: '', tabId: '' }) is a placeholder slot: the
// user pressed the split button and has not picked the new pane's tab yet.
// It is focusable, invisible to tab lookups (no real tabId), never survives
// a restart (sanitizePanes drops it), and the next activation fills the
// focused placeholder through the standard replace rule.
export const isEmptyPane = (p) => !p || !p.tabId;

const clampIndex = (panes, index) => Math.max(0, Math.min(panes.length - 1, index | 0));

const finalizeRemoval = (panes, focusedIndex, idx) => {
  const next = panes.filter((_, i) => i !== idx);
  // A split needs ≥2 REAL panes to stay a split; a dangling [real, empty]
  // pair collapses too (placeholder without a purpose).
  if (next.filter((p) => !isEmptyPane(p)).length <= 1) {
    return { panes: [], focusedIndex: 0 };
  }
  let focus = focusedIndex;
  if (idx < focus) focus -= 1;
  return { panes: next, focusedIndex: clampIndex(next, focus) };
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
  next[at] = { projectId, tabId };
  return { panes: next, focusedIndex: at, changed: true };
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
    next[emptyIdx] = added;
    return { panes: next, focusedIndex: emptyIdx };
  }
  if (panes.length >= MAX_SPLIT_PANES) return null;
  return { panes: [...panes, added], focusedIndex: panes.length };
}

// Split button in the attach row: open a new EMPTY pane and focus it. From
// single mode the current center tab becomes pane 0. Only one placeholder at
// a time — a second click while one is open is a no-op.
export function addEmptyPane(panes, focusedIndex, current) {
  if (!Array.isArray(panes)) return null;
  if (panes.length === 0) {
    if (!current || !current.tabId) return null;
    return { panes: [current, { projectId: '', tabId: '' }], focusedIndex: 1 };
  }
  if (panes.length >= MAX_SPLIT_PANES) return null;
  if (panes.some(isEmptyPane)) return null;
  return { panes: [...panes, { projectId: '', tabId: '' }], focusedIndex: panes.length };
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
