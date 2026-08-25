// Pure model of the Ctrl+Q project switcher.
//
// Same gesture as Ctrl+Tab, one level up: hold Ctrl, step with Q, release to
// commit. Projects are deliberately simpler than tabs: every open project is
// shown, the current project is the anchor row, and recency defines the order.

/** A destination that has no project record. */
export const HOME_ROW_ID = '__home__';

/**
 * @param {object} args
 * @param {string[]} args.openProjectIds every open project (any order)
 * @param {string[]} args.projectHistory activation order, oldest first
 * @param {string} [args.currentProjectId] sidebar project, pinned to row 1
 * @param {boolean} [args.onDashboard]
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
  const recentFirst = [...(projectHistory || [])].filter(Boolean).reverse();
  const rank = new Map();
  recentFirst.forEach((id, index) => { if (!rank.has(id)) rank.set(id, index); });

  const ordered = [...new Set(open)].sort((a, b) => {
    const rankA = rank.has(a) ? rank.get(a) : Infinity;
    const rankB = rank.has(b) ? rank.get(b) : Infinity;
    if (rankA !== rankB) return rankA - rankB;
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

  rows.push({
    id: HOME_ROW_ID,
    name: 'Home',
    icon: null,
    kind: 'home',
    current: !!onDashboard,
  });

  const anchorAt = rows.findIndex((row) => row.current);
  if (anchorAt > 0) {
    const [anchor] = rows.splice(anchorAt, 1);
    rows.unshift(anchor);
  }
  return rows;
}

/** Initial highlight: the freshest destination that is not current. */
export function initialProjectIndex(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const index = list.findIndex((row) => !row.current);
  return index >= 0 ? index : -1;
}

/** Step the selection in either direction, wrapping at both ends. */
export function stepProjectIndex(rows, currentIndex, direction) {
  const list = Array.isArray(rows) ? rows : [];
  if (list.length === 0) return -1;
  const from = currentIndex >= 0 && currentIndex < list.length
    ? currentIndex
    : (direction >= 0 ? -1 : 0);
  return (from + (direction >= 0 ? 1 : -1) + list.length) % list.length;
}
