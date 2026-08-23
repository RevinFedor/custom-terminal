// Pure model of Ctrl+Q — the switcher of top-level places.
//
// Projects are directories inside workflows, not peer workspaces. Ctrl+Q
// therefore walks the actual layout surfaces: workflows plus the two special
// roots Home and Inbox. Row 1 is always where the user is; release commits the
// first different row, matching Ctrl+Tab's hold-and-release contract.

export const HOME_ROW_ID = '__home__';

export function buildWorkflowSwitcherRows({
  spaces,
  activeSpaceId = null,
  onDashboard = false,
  onInbox = false,
  inboxId = '__noted_inbox__',
  inboxName = 'Inbox',
  inboxIcon = null,
} = {}) {
  const list = (Array.isArray(spaces) ? spaces : []).filter((space) => space?.id);
  const activeIndex = list.findIndex((space) => space.id === activeSpaceId);
  // The active workflow heads the list; then Ctrl+Q follows the visible strip
  // to the right and wraps. This is a map, not a recency journal.
  const ordered = activeIndex >= 0
    ? [...list.slice(activeIndex), ...list.slice(0, activeIndex)]
    : list;
  const rows = ordered.map((space) => ({
    id: space.id,
    name: space.name || 'Workflow',
    icon: typeof space.icon === 'string' && space.icon ? space.icon : null,
    kind: 'workflow',
    current: !onDashboard && !onInbox && space.id === activeSpaceId,
  }));

  rows.push({
    id: inboxId,
    name: inboxName,
    icon: inboxIcon || null,
    kind: 'inbox',
    current: !onDashboard && !!onInbox,
  });
  rows.push({
    id: HOME_ROW_ID,
    name: 'Home',
    icon: null,
    kind: 'home',
    current: !!onDashboard,
  });

  const currentAt = rows.findIndex((row) => row.current);
  if (currentAt > 0) {
    const [current] = rows.splice(currentAt, 1);
    rows.unshift(current);
  }
  return rows;
}

export function initialWorkflowIndex(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const index = list.findIndex((row) => !row.current);
  return index >= 0 ? index : -1;
}

export function stepWorkflowIndex(rows, currentIndex, direction) {
  const list = Array.isArray(rows) ? rows : [];
  if (list.length === 0) return -1;
  const from = currentIndex >= 0 && currentIndex < list.length
    ? currentIndex
    : (direction >= 0 ? -1 : 0);
  return (from + (direction >= 0 ? 1 : -1) + list.length) % list.length;
}
