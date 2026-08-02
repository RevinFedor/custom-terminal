// Pure rules of the split workspace (up to 3 panes side-by-side).
//
// A pane = { projectId, tabId }. `panes.length === 0` — single mode (today's
// behavior, untouched). Focus is an index into panes; the focused pane's tab
// IS the app's active tab (activeProjectId/activeTabId follow it), so the
// toolbar, git, sidebars and History need no separate "split focus" source.
//
// Approved navigation rule (one rule for sidebar click / Ctrl+Tab / Cmd+P /
// project click):
//   • target tab already visible in a pane → focus that pane, composition
//     unchanged;
//   • otherwise → the pane in focus replaces its tab with the target.

export const MAX_SPLIT_PANES = 3;

const clampIndex = (panes, index) => Math.max(0, Math.min(panes.length - 1, index | 0));

// Activation of (projectId, tabId) with split active. Returns next state.
export function resolveSplitActivation(panes, focusedIndex, projectId, tabId) {
  if (!Array.isArray(panes) || panes.length === 0) {
    return { panes: [], focusedIndex: 0, changed: false };
  }
  const existing = panes.findIndex((p) => p && p.tabId === tabId);
  if (existing >= 0) {
    return { panes, focusedIndex: existing, changed: existing !== focusedIndex };
  }
  const at = clampIndex(panes, focusedIndex);
  const next = panes.slice();
  next[at] = { projectId, tabId };
  return { panes: next, focusedIndex: at, changed: true };
}

// ПКМ «Добавить в рабочую область». From single mode the current active tab
// becomes pane 0 and the added tab pane 1. Returns null when nothing to do
// (same tab, already present, or the workspace is full).
export function addPane(panes, focusedIndex, current, added) {
  if (!added || !added.tabId) return null;
  if (panes.some((p) => p.tabId === added.tabId)) return null;
  if (panes.length === 0) {
    if (!current || !current.tabId || current.tabId === added.tabId) return null;
    return { panes: [current, added], focusedIndex: 1 };
  }
  if (panes.length >= MAX_SPLIT_PANES) return null;
  return { panes: [...panes, added], focusedIndex: panes.length };
}

// Remove a tab's pane (close tab / ПКМ «Убрать»). A single remaining pane
// collapses the split back to single mode.
export function removePaneByTab(panes, focusedIndex, tabId) {
  const idx = panes.findIndex((p) => p.tabId === tabId);
  if (idx === -1) return null;
  const next = panes.filter((_, i) => i !== idx);
  if (next.length <= 1) return { panes: [], focusedIndex: 0 };
  let focus = focusedIndex;
  if (idx < focus) focus -= 1;
  return { panes: next, focusedIndex: clampIndex(next, focus) };
}

export function removePanesByProject(panes, focusedIndex, projectId) {
  const next = panes.filter((p) => p.projectId !== projectId);
  if (next.length === panes.length) return null;
  if (next.length <= 1) return { panes: [], focusedIndex: 0 };
  const focusedTab = panes[clampIndex(panes, focusedIndex)];
  const keptFocus = next.findIndex((p) => p.tabId === focusedTab?.tabId);
  return { panes: next, focusedIndex: keptFocus >= 0 ? keptFocus : 0 };
}

// Pick mode / explicit placement into pane `index`. If the tab already sits
// in another pane — focus travels there instead (no duplicates, approved).
export function setPaneTab(panes, index, projectId, tabId) {
  if (panes.length === 0) return null;
  const existing = panes.findIndex((p) => p.tabId === tabId);
  if (existing >= 0) return { panes, focusedIndex: existing };
  const at = clampIndex(panes, index);
  const next = panes.slice();
  next[at] = { projectId, tabId };
  return { panes: next, focusedIndex: at };
}

// Restore-time validation: keep only panes whose tab still exists; a split
// needs at least two live panes to survive.
export function sanitizePanes(panes, focusedIndex, tabExists) {
  const valid = (Array.isArray(panes) ? panes : []).filter((p) => (
    p && typeof p.projectId === 'string' && typeof p.tabId === 'string' && tabExists(p.projectId, p.tabId)
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
