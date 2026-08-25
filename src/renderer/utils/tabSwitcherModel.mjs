// Pure model of the Ctrl+Tab / Cmd+P switcher.
//
// Input: open projects with their tabs + a GLOBAL cross-project tab MRU
// (most-recent-first). Every tab carries its current workflow placement.
// Output: flat rows where workflows are non-selectable colored headers and
// tabs are selectable entries; their directory-project stays secondary data.
//
// Rules (approved, revised 2026-08-02):
//  • rows follow STRICT global tab recency (MRU) — the sequence never walks
//    the current project's remaining tabs before reaching the previous tab
//    of another project; unranked tabs go after all ranked ones in
//    project/natural order;
//  • workflow headers are pure TOC separators inserted at every workflow
//    change in that flat sequence — the same workflow may head several runs;
//  • selection skips workflow headers entirely (pos 1 → pos 3 jump);
//  • initial selection in ctrl-mode = globally previous tab, even when it
//    lives in another project;
//  • Cmd+P query filters by tab, project or workflow name in both layouts.

import {
  UNPLACED_WORKFLOW_ID,
  UNPLACED_WORKFLOW_NAME,
} from './workflowVisuals.mjs';

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
// pinnedFirstTabId: the tab that must head the list whatever its recency —
//   Ctrl+Tab puts the CURRENT tab there as an anchor ("ты здесь"), so the
//   highlighted second row reads as "and this is where I am going". It cannot
//   be left to the MRU: the anchor is a presentation contract, while MRU is a
//   durable visit log that may be absent after old-session restore or explicit
//   "forget row". These are different facts even though normal focus records a
//   visit (see tabVisitHistoryRule).
export function buildSwitcherRows({ projects, globalMru = [], query = '', pinnedFirstTabId = null }) {
  const mruRank = new Map();
  globalMru.forEach((entry, i) => {
    if (!entry || !entry.tabId) return;
    if (!mruRank.has(entry.tabId)) mruRank.set(entry.tabId, i);
  });

  const variants = query ? getLayoutVariants(query) : null;

  // One flat pool across ALL projects, sorted by pure global recency. A
  // workflow switch in the middle of the sequence just inserts a TOC header —
  // it never pulls the rest of that workflow's tabs forward.
  const pool = [];
  projects.forEach((project, projectIndex) => {
    const projectNameLower = String(project.projectName || '').toLowerCase();
    const projectMatches = variants ? variants.some(v => v && projectNameLower.includes(v)) : true;
    (project.tabs || []).forEach((tab, naturalIndex) => {
      const workflowId = tab.workflowId || UNPLACED_WORKFLOW_ID;
      const workflowName = tab.workflowName || UNPLACED_WORKFLOW_NAME;
      const workflowNameLower = String(workflowName).toLowerCase();
      const workflowMatches = variants
        ? variants.some(v => v && workflowNameLower.includes(v))
        : true;
      if (variants && !projectMatches && !workflowMatches) {
        const nameLower = String(tab.name || '').toLowerCase();
        if (!variants.some(v => v && nameLower.includes(v))) return;
      }
      pool.push({
        project,
        workflow: {
          id: workflowId,
          name: workflowName,
          icon: tab.workflowIcon || null,
          unplaced: workflowId === UNPLACED_WORKFLOW_ID || tab.workflowUnplaced === true,
        },
        projectIndex,
        naturalIndex,
        tab,
        // -1 outranks every MRU position, so the anchor row is first even when
        // the current tab has no history entry at all.
        rank: (pinnedFirstTabId && tab.id === pinnedFirstTabId)
          ? -1
          : (mruRank.has(tab.id) ? mruRank.get(tab.id) : Infinity),
      });
    });
  });
  pool.sort((a, b) => (a.rank - b.rank)
    || (a.projectIndex - b.projectIndex)
    || (a.naturalIndex - b.naturalIndex));

  const rows = [];
  let lastWorkflowId = null;
  for (const entry of pool) {
    if (entry.workflow.id !== lastWorkflowId) {
      rows.push({
        kind: 'workflow',
        workflowId: entry.workflow.id,
        workflowName: entry.workflow.name,
        workflowIcon: entry.workflow.icon,
        unplaced: entry.workflow.unplaced,
      });
      lastWorkflowId = entry.workflow.id;
    }
    rows.push({
      kind: 'tab',
      projectId: entry.project.projectId,
      projectName: entry.project.projectName,
      projectIcon: entry.project.projectIcon || null,
      workflowId: entry.workflow.id,
      tab: entry.tab,
      missing: !!entry.tab.missing,
    });
  }
  return rows;
}

// Missing linked files (file tab whose file vanished from disk) stay VISIBLE
// with a red icon but are not selectable — stepping jumps over them, exactly
// like workflow headers.
// Строки найденных промптов (поиск по итерациям) выбираются так же, как
// вкладки: список один, и стрелки не должны знать, чем именно он сейчас
// наполнен. Заголовок вкладки над найденным — такой же разделитель, как
// заголовок проекта, и точно так же пропускается.
export function selectableIndices(rows) {
  const out = [];
  rows.forEach((row, i) => {
    if (row.kind === 'iteration') { out.push(i); return; }
    if (row.kind === 'tab' && !row.missing) out.push(i);
  });
  return out;
}

// Initial highlight for ctrl-mode: the most recent history entry present in
// `rows`, skipping the active tab.
//
// Row 1 of the ctrl list is the ACTIVE tab — an anchor, not a destination — so
// skipping it here is what makes the highlight land on row 2, "where releasing
// Ctrl takes me". Everything else on screen is absent from `rows` entirely
// (TabSwitcherOverlay::computeRowsFromStores), so the freshest remaining row is
// the freshest thing the user cannot see. Filtering at the list level rather
// than at the highlight is what keeps the gesture consistent — stepping,
// wrapping and the fast tap all walk the same rows.
export function initialCtrlIndex(rows, globalMru, activeTabId) {
  const byTabId = new Map();
  rows.forEach((row, i) => { if (row.kind === 'tab' && !row.missing) byTabId.set(row.tab.id, i); });
  for (const entry of globalMru) {
    if (!entry || !entry.tabId || entry.tabId === activeTabId) continue;
    const idx = byTabId.get(entry.tabId);
    if (idx !== undefined) return idx;
  }
  const selectable = selectableIndices(rows);
  // initialCtrlIndex вызывается только для Ctrl+Tab, где строк-ходов не бывает;
  // проверка типа здесь — защита от падения, если список когда-нибудь смешают.
  const nonActive = selectable.find(i => rows[i].kind === 'tab' && rows[i].tab.id !== activeTabId);
  if (nonActive !== undefined) return nonActive;
  // Nothing but the anchor: the gesture has no destination, so it must select
  // NOTHING rather than fall back to the current tab. Re-activating the tab the
  // user is already on is not a no-op downstream — it switches the project view
  // to the terminal and yanks the sidebar to that row.
  if (activeTabId && selectable.length > 0) return -1;
  return selectable[0] ?? -1;
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
