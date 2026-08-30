import { paneColumns } from './splitPanesModel.mjs';

const ARROW_DIRECTIONS = {
  ArrowLeft: 'left',
  ArrowRight: 'right',
  ArrowUp: 'up',
  ArrowDown: 'down',
};

const BLOCKING_OVERLAYS = [
  '[role="dialog"]',
  '[data-tab-switcher-root]',
  '[data-project-switcher-root]',
  '[data-prompt-picker]',
  '[data-command-palette]',
  '[data-context-menu]',
  '[data-tab-context-menu]',
  '[data-project-context-menu]',
  '[data-workflow-context-menu]',
  '[data-window-picker-panel]',
  '[data-workspace-window-swap-picker]',
  '[data-split-direction-menu]',
].join(',');

export function resolveWorkspaceArrowCommand(event) {
  if (!event || event.defaultPrevented || event.isComposing) return null;
  if (!event.metaKey || event.altKey || event.ctrlKey) return null;
  const direction = ARROW_DIRECTIONS[event.code];
  if (!direction) return null;

  if (event.shiftKey) {
    if (direction === 'left') return { kind: 'workflow', direction: 'previous' };
    if (direction === 'right') return { kind: 'workflow', direction: 'next' };
    return null;
  }
  return { kind: 'pane', direction };
}

export function workspaceArrowNavigationBlocked(target, documentLike) {
  if (documentLike?.querySelector?.(BLOCKING_OVERLAYS)) return true;
  if (!target || typeof target.closest !== 'function') return false;
  if (target.closest(BLOCKING_OVERLAYS)) return true;
  const tag = String(target.tagName || '').toUpperCase();
  // Single-line fields use Cmd+Left/Right for editing and are also how tab,
  // project and workflow rename surfaces identify themselves. Composers are
  // textarea/contenteditable/xterm and intentionally keep the global window
  // shortcut requested by the product.
  return tag === 'INPUT' || tag === 'SELECT';
}

/**
 * Follow the saved column/row topology, not current pixel centres. A wide pane
 * left of a resized two-row column must enter row 0 first; choosing the nearest
 * visual centre could jump straight to row 1 and make navigation change after
 * every divider drag. Horizontal movement preserves row when possible and
 * clamps only when the adjacent column has fewer rows.
 */
export function resolveSpatialPaneTarget(panes, _sizes, focusedIndex, direction) {
  const list = Array.isArray(panes) ? panes : [];
  if (list.length < 2 || !Number.isInteger(focusedIndex) || !list[focusedIndex]) return null;
  const columns = paneColumns(list);
  let columnIndex = -1;
  let rowIndex = -1;
  columns.forEach((rows, c) => rows.forEach((row, r) => {
    if (row.index === focusedIndex) {
      columnIndex = c;
      rowIndex = r;
    }
  }));
  if (columnIndex < 0 || rowIndex < 0) return null;

  if (direction === 'up' || direction === 'down') {
    const targetRow = rowIndex + (direction === 'up' ? -1 : 1);
    return columns[columnIndex]?.[targetRow]?.index ?? null;
  }

  const targetColumn = columnIndex + (direction === 'left' ? -1 : 1);
  const rows = columns[targetColumn];
  if (!rows?.length) return null;
  return rows[Math.min(rowIndex, rows.length - 1)]?.index ?? null;
}

export function resolveWorkspaceCycleTarget(spaces, activeSpaceId, direction) {
  const ids = [];
  for (const space of Array.isArray(spaces) ? spaces : []) {
    const id = typeof space?.id === 'string' ? space.id : '';
    if (id && !ids.includes(id)) ids.push(id);
  }
  if (ids.length < 2) return null;
  const currentIndex = ids.indexOf(activeSpaceId);
  if (currentIndex < 0) return direction === 'previous' ? ids[ids.length - 1] : ids[0];
  const delta = direction === 'previous' ? -1 : 1;
  return ids[(currentIndex + delta + ids.length) % ids.length];
}
