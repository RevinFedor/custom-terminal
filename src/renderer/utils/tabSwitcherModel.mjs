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

// Initial highlight for ctrl-mode: the globally previous tab — the first MRU
// entry that is not the current tab and still exists among rows. Fallback:
// first selectable row that is not the current tab, then the first selectable.
export function initialCtrlIndex(rows, globalMru, activeTabId) {
  const byTabId = new Map();
  rows.forEach((row, i) => { if (row.kind === 'tab' && !row.missing) byTabId.set(row.tab.id, i); });
  for (const entry of globalMru) {
    if (!entry || !entry.tabId || entry.tabId === activeTabId) continue;
    const idx = byTabId.get(entry.tabId);
    if (idx !== undefined) return idx;
  }
  const selectable = selectableIndices(rows);
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
export function touchMru(globalMru, projectId, tabId, cap = 60) {
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
