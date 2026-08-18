// Pure model of the Ctrl+Q project switcher.
//
// Same gesture as Ctrl+Tab, one level up: hold Ctrl, step with Q, release to
// commit. And deliberately SIMPLER, because projects are not tabs:
//
//   • THE LIST IS EVERYTHING. Six or seven projects fit on screen at once, so
//     there is no search box and no scrolling to design around. Ctrl+Tab hides
//     what is already visible because with dozens of tabs a list of "everything"
//     would be useless; here "everything" IS the useful list.
//   • ROW 1 IS WHERE YOU ARE, row 2 is where releasing Ctrl takes you. Same
//     anchor rule as the tab switcher, and same reason: without a reference
//     point the panel opens straight onto the target and the first row reads as
//     "current" while pointing somewhere else.
//   • HOME AND INBOX ARE ROWS. They are destinations in the titlebar, so they
//     are destinations here — a switcher that silently omits two of the places
//     you can be is a map with holes in it.
//
// Order is RECENCY (`projectHistory`, newest first), like the tab list: this is
// a blind step-back gesture, not a place to hunt with the eyes. The sidebar and
// the titlebar are the map; this is the journal.

/** Rows that are not real projects, and therefore have no project record. */
export const HOME_ROW_ID = '__home__';

/**
 * @param {object} args
 * @param {string[]} args.openProjectIds  every open project (any order)
 * @param {string[]} args.projectHistory  activation order, OLDEST first (store shape)
 * @param {string} [args.currentProjectId] the project in focus — pinned to row 1
 * @param {boolean} [args.onDashboard]    true when Home is the current surface
 * @param {(id: string) => {name?: string, icon?: string|null}} [args.meta]
 * @returns {Array<{id: string, name: string, icon: string|null, kind: 'home'|'project', current: boolean}>}
 */
export function buildProjectSwitcherRows({
  openProjectIds,
  projectHistory = [],
  currentProjectId = null,
  onDashboard = false,
  meta = () => ({}),
}) {
  const open = Array.isArray(openProjectIds) ? openProjectIds.filter(Boolean) : [];
  // The store keeps history oldest-first; the switcher reads newest-first.
  const recentFirst = [...(projectHistory || [])].filter(Boolean).reverse();
  const rank = new Map();
  recentFirst.forEach((id, index) => { if (!rank.has(id)) rank.set(id, index); });

  const ordered = [...new Set(open)].sort((a, b) => {
    const ra = rank.has(a) ? rank.get(a) : Infinity;
    const rb = rank.has(b) ? rank.get(b) : Infinity;
    if (ra !== rb) return ra - rb;
    // Never-activated projects keep the caller's order, deterministically.
    return open.indexOf(a) - open.indexOf(b);
  });

  const rows = ordered.map((id) => {
    const info = meta(id) || {};
    return {
      id,
      name: info.name || 'Project',
      icon: info.icon || null,
      kind: 'project',
      current: !onDashboard && id === currentProjectId,
    };
  });

  // Home sits LAST among the unpinned rows rather than first: it is a place to
  // go, not the place you usually came from, and putting it at the top would
  // push the actual previous project down a row on every single press.
  rows.push({
    id: HOME_ROW_ID,
    name: 'Home',
    icon: null,
    kind: 'home',
    current: !!onDashboard,
  });

  // The anchor is pinned to row 1 wherever recency happened to place it — same
  // rule as the tab switcher, and for the same reason: "where I am" is not a
  // ranking, it is a fixed reference point.
  const anchorAt = rows.findIndex((row) => row.current);
  if (anchorAt > 0) {
    const [anchor] = rows.splice(anchorAt, 1);
    rows.unshift(anchor);
  }
  return rows;
}

/**
 * Initial highlight: row 2 — the freshest row that is NOT where you are.
 * Returns -1 when there is nowhere else to go (a single row).
 */
export function initialProjectIndex(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const index = list.findIndex((row) => !row.current);
  return index >= 0 ? index : -1;
}

/** Step the selection, wrapping. Every row is selectable — no headers here. */
export function stepProjectIndex(rows, currentIndex, direction) {
  const list = Array.isArray(rows) ? rows : [];
  if (list.length === 0) return -1;
  const from = currentIndex >= 0 && currentIndex < list.length
    ? currentIndex
    : (direction >= 0 ? -1 : 0);
  const next = (from + (direction >= 0 ? 1 : -1) + list.length) % list.length;
  return next;
}
