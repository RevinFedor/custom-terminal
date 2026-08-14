// Pure model of the Ctrl+Tab / Cmd+P switcher.
//
// Input: open projects with their tabs + a GLOBAL cross-project tab MRU
// (most-recent-first). Output: flat rows where projects are non-selectable
// headers and tabs are selectable entries grouped under their project.
//
// Rules (approved, revised 2026-08-02):
//  • rows follow STRICT global tab recency (MRU) — the sequence never walks
//    the current project's remaining tabs before reaching the previous tab
//    of another project; unranked tabs go after all ranked ones in
//    project/natural order;
//  • project headers are pure TOC separators inserted at every project
//    change in that flat sequence — the same project may head several runs;
//  • selection skips project headers entirely (pos 1 → pos 3 jump);
//  • initial selection in ctrl-mode = globally previous tab, even when it
//    lives in another project;
//  • Cmd+P query filters by tab name (both keyboard layouts); a query that
//    matches the project name keeps all of that project's tabs.

const RU_TO_EN = {
  'й': 'q', 'ц': 'w', 'у': 'e', 'к': 'r', 'е': 't', 'н': 'y', 'г': 'u', 'ш': 'i', 'щ': 'o', 'з': 'p', 'х': '[', 'ъ': ']',
  'ф': 'a', 'ы': 's', 'в': 'd', 'а': 'f', 'п': 'g', 'р': 'h', 'о': 'j', 'л': 'k', 'д': 'l', 'ж': ';', 'э': "'",
  'я': 'z', 'ч': 'x', 'с': 'c', 'м': 'v', 'и': 'b', 'т': 'n', 'ь': 'm', 'б': ',', 'ю': '.',
};
const EN_TO_RU = Object.fromEntries(Object.entries(RU_TO_EN).map(([ru, en]) => [en, ru]));

export function getLayoutVariants(text) {
  const lower = String(text || '').toLowerCase();
  const toEn = lower.split('').map(c => RU_TO_EN[c] || c).join('');
  const toRu = lower.split('').map(c => EN_TO_RU[c] || c).join('');
  return [...new Set([lower, toEn, toRu])];
}

// projects: Array<{ projectId, projectName, tabs: Array<{ id, name, ... }>, tabHistory?: string[] }>
//   tabs come in natural sidebar order; extra fields pass through to rows.
// globalMru: Array<{ projectId, tabId }> most-recent-first.
// activeTabId: current tab (globally focused).
export function buildSwitcherRows({ projects, globalMru = [], query = '' }) {
  const mruRank = new Map();
  globalMru.forEach((entry, i) => {
    if (!entry || !entry.tabId) return;
    if (!mruRank.has(entry.tabId)) mruRank.set(entry.tabId, i);
  });

  const variants = query ? getLayoutVariants(query) : null;

  // One flat pool across ALL projects, sorted by pure global recency. A
  // project switch in the middle of the sequence just inserts a TOC header —
  // it never pulls the rest of that project's tabs forward.
  const pool = [];
  projects.forEach((project, projectIndex) => {
    const projectNameLower = String(project.projectName || '').toLowerCase();
    const projectMatches = variants ? variants.some(v => v && projectNameLower.includes(v)) : true;
    (project.tabs || []).forEach((tab, naturalIndex) => {
      if (variants && !projectMatches) {
        const nameLower = String(tab.name || '').toLowerCase();
        if (!variants.some(v => v && nameLower.includes(v))) return;
      }
      pool.push({
        project,
        projectIndex,
        naturalIndex,
        tab,
        rank: mruRank.has(tab.id) ? mruRank.get(tab.id) : Infinity,
      });
    });
  });
  pool.sort((a, b) => (a.rank - b.rank)
    || (a.projectIndex - b.projectIndex)
    || (a.naturalIndex - b.naturalIndex));

  const rows = [];
  let lastProjectId = null;
  for (const entry of pool) {
    if (entry.project.projectId !== lastProjectId) {
      rows.push({
        kind: 'project',
        projectId: entry.project.projectId,
        projectName: entry.project.projectName,
        projectIcon: entry.project.projectIcon || null,
      });
      lastProjectId = entry.project.projectId;
    }
    rows.push({
      kind: 'tab',
      projectId: entry.project.projectId,
      projectName: entry.project.projectName,
      tab: entry.tab,
      missing: !!entry.tab.missing,
    });
  }
  return rows;
}

// Missing linked files (file tab whose file vanished from disk) stay VISIBLE
// with a red icon but are not selectable — stepping jumps over them, exactly
// like project headers.
export function selectableIndices(rows) {
  const out = [];
  rows.forEach((row, i) => { if (row.kind === 'tab' && !row.missing) out.push(i); });
  return out;
}

// Initial highlight for ctrl-mode: the most recent tab that is NOT already on
// screen — Ctrl+Tab exists to bring back what you cannot see. Fallback chain:
// the most recent visible-but-not-focused tab (in a full split that is the only
// meaningful target, and the gesture must not become a dead key), then any row
// that is not the current tab, then the first selectable row.
//
// `onScreenTabIds` defaults to just the active tab, which is what single mode is:
// callers in a split pass every pane's tab. Without that, the highlight landed on
// the neighbouring pane's tab — i.e. offered to "switch to" something already
// visible, while the hidden tab the user wanted sat further down the list.
export function initialCtrlIndex(rows, globalMru, activeTabId, onScreenTabIds) {
  const byTabId = new Map();
  rows.forEach((row, i) => { if (row.kind === 'tab' && !row.missing) byTabId.set(row.tab.id, i); });
  const onScreen = new Set(
    Array.isArray(onScreenTabIds) && onScreenTabIds.length > 0
      ? onScreenTabIds
      : [activeTabId].filter(Boolean),
  );
  // Pass 1 — most recent tab that is not on screen at all.
  for (const entry of globalMru) {
    if (!entry || !entry.tabId || onScreen.has(entry.tabId)) continue;
    const idx = byTabId.get(entry.tabId);
    if (idx !== undefined) return idx;
  }
  // Pass 2 — everything visible (e.g. a two-pane split holding both tabs): the
  // neighbouring pane is then the only place left to go.
  for (const entry of globalMru) {
    if (!entry || !entry.tabId || entry.tabId === activeTabId) continue;
    const idx = byTabId.get(entry.tabId);
    if (idx !== undefined) return idx;
  }
  const selectable = selectableIndices(rows);
  const offScreen = selectable.find((i) => !onScreen.has(rows[i].tab.id));
  if (offScreen !== undefined) return offScreen;
  const nonActive = selectable.find(i => rows[i].tab.id !== activeTabId);
  return nonActive !== undefined ? nonActive : (selectable[0] ?? -1);
}

// Step selection over tab rows only, wrapping, skipping project headers.
export function stepIndex(rows, currentIndex, direction) {
  const selectable = selectableIndices(rows);
  if (selectable.length === 0) return -1;
  const pos = selectable.indexOf(currentIndex);
  if (pos === -1) return direction >= 0 ? selectable[0] : selectable[selectable.length - 1];
  const next = (pos + (direction >= 0 ? 1 : -1) + selectable.length) % selectable.length;
  return selectable[next];
}

// MRU maintenance helpers (shared by store writers and tests).
// Cap shared by the live toucher and the restore rebuild, so the two cannot
// disagree about how much history is kept.
export const GLOBAL_TAB_MRU_CAP = 60;

export function touchMru(globalMru, projectId, tabId, cap = GLOBAL_TAB_MRU_CAP) {
  const filtered = (globalMru || []).filter(e => e && e.tabId !== tabId);
  return [{ projectId, tabId }, ...filtered].slice(0, cap);
}

export function dropFromMru(globalMru, tabId) {
  return (globalMru || []).filter(e => e && e.tabId !== tabId);
}

export function dropProjectFromMru(globalMru, projectId) {
  return (globalMru || []).filter(e => e && e.projectId !== projectId);
}

// Shorten an absolute path for the muted right-hand column: $HOME → ~, keep
// the last two segments when it does not fit.
export function shortPath(cwd, homeDir) {
  if (!cwd) return '';
  let p = String(cwd);
  if (homeDir && p.startsWith(homeDir)) p = '~' + p.slice(homeDir.length);
  const parts = p.split('/').filter(Boolean);
  if (p.startsWith('~')) return p;
  if (parts.length <= 2) return p;
  return '…/' + parts.slice(-2).join('/');
}

// Rebuild the global tab-visit order after a restart.
//
// The saved array must NOT be the source of truth: restore used to filter it to
// surviving tabs and write the filtered version back, so every restart shaved it
// and the loss was permanent (seen live: 6 entries for 10 open projects). Worse,
// per-project visit lists start empty after a restart, so that shrinking array
// was the ONLY ranking left — hence "Ctrl+Tab shows just the current project".
//
// Now the order is DERIVED from each tab's own durable stamp, newest first, and
// the saved array only orders tabs that have no stamp yet (written by a build
// before the column existed). A cache of something durable cannot shrink
// irreversibly.
//
// tabs: Array<{ projectId, tabId, lastActivatedAt? }> — every open tab.
// savedMru: the persisted array, used only as the fallback order.
export function rebuildGlobalTabMru(tabs, savedMru = [], cap = GLOBAL_TAB_MRU_CAP) {
  const savedRank = new Map();
  (savedMru || []).forEach((entry, index) => {
    if (entry && entry.tabId && !savedRank.has(entry.tabId)) savedRank.set(entry.tabId, index);
  });

  const stamped = [];
  const unstamped = [];
  for (const tab of (tabs || [])) {
    if (!tab || !tab.tabId) continue;
    const at = Number(tab.lastActivatedAt);
    if (Number.isFinite(at) && at > 0) {
      stamped.push({ projectId: tab.projectId, tabId: tab.tabId, at });
    } else if (savedRank.has(tab.tabId)) {
      unstamped.push({ projectId: tab.projectId, tabId: tab.tabId, savedAt: savedRank.get(tab.tabId) });
    }
  }
  // Newest visit first; ties break by tabId so the result is deterministic.
  stamped.sort((a, b) => (b.at - a.at) || String(a.tabId).localeCompare(String(b.tabId)));
  unstamped.sort((a, b) => a.savedAt - b.savedAt);

  return [
    ...stamped.map(({ projectId, tabId }) => ({ projectId, tabId })),
    ...unstamped.map(({ projectId, tabId }) => ({ projectId, tabId })),
  ].slice(0, cap);
}
