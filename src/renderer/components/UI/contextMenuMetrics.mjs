/**
 * Shared geometry for dense right-click menus.
 *
 * This module deliberately owns only measurements and small style fragments.
 * Menus keep their own markup, actions, visibility and safety logic.
 */
export const CONTEXT_MENU_METRICS = Object.freeze({
  rowHeight: 28,
  compactRowHeight: 26,
  xPadding: 8,
  iconSlot: 16,
  gap: 6,
  radius: 7,
  dividerWidth: 1,
  dividerColor: '#3a3a3a',
  minWidth: 168,
  maxWidth: 280,
  viewportInset: 8,
});

export const CONTEXT_MENU_METRICS_HOOK = 'compact-v1';

/**
 * Geometry of the window-layout picker used by both tab and split menus.
 *
 * A one-row layout used to reserve 104px for every window card. That made the
 * common two-window case look like a dashboard inside a context menu. Cards
 * now have the same compact height as an action row; the map grows only when a
 * column really contains more rows, then scrolls inside a bounded flyout.
 */
export const WINDOW_PICKER_METRICS = Object.freeze({
  cellHeight: CONTEXT_MENU_METRICS.compactRowHeight,
  gap: 4,
  mapMinWidth: CONTEXT_MENU_METRICS.minWidth - 8,
  columnMinWidth: 70,
  panelMaxWidth: 240,
  viewportMaxHeight: 176,
});

const positiveCount = (value) => (
  Number.isFinite(value) ? Math.max(1, Math.floor(value)) : 1
);

export function windowPickerNaturalHeight(rowCount = 1) {
  const rows = positiveCount(rowCount);
  return (
    rows * WINDOW_PICKER_METRICS.cellHeight
    + (rows - 1) * WINDOW_PICKER_METRICS.gap
  );
}

export function windowPickerNaturalWidth(columnCount = 1) {
  const columns = positiveCount(columnCount);
  return Math.max(
    WINDOW_PICKER_METRICS.mapMinWidth,
    columns * WINDOW_PICKER_METRICS.columnMinWidth
      + (columns - 1) * WINDOW_PICKER_METRICS.gap,
  );
}

const viewportGutter = CONTEXT_MENU_METRICS.viewportInset * 2;

export const CONTEXT_MENU_PANEL_STYLE = Object.freeze({
  boxSizing: 'border-box',
  minWidth: CONTEXT_MENU_METRICS.minWidth,
  maxWidth: `min(${CONTEXT_MENU_METRICS.maxWidth}px, calc(100vw - ${viewportGutter}px))`,
  borderRadius: CONTEXT_MENU_METRICS.radius,
});

const rowStyle = (height) => Object.freeze({
  boxSizing: 'border-box',
  height,
  minHeight: height,
  padding: `0 ${CONTEXT_MENU_METRICS.xPadding}px`,
  columnGap: CONTEXT_MENU_METRICS.gap,
  whiteSpace: 'nowrap',
});

export const CONTEXT_MENU_ROW_STYLE = rowStyle(CONTEXT_MENU_METRICS.rowHeight);
export const CONTEXT_MENU_COMPACT_ROW_STYLE = rowStyle(CONTEXT_MENU_METRICS.compactRowHeight);

export const CONTEXT_MENU_ICON_SLOT_STYLE = Object.freeze({
  width: CONTEXT_MENU_METRICS.iconSlot,
  height: CONTEXT_MENU_METRICS.iconSlot,
  flex: `0 0 ${CONTEXT_MENU_METRICS.iconSlot}px`,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
});

export const CONTEXT_MENU_TOP_DIVIDER_STYLE = Object.freeze({
  borderTop: `${CONTEXT_MENU_METRICS.dividerWidth}px solid ${CONTEXT_MENU_METRICS.dividerColor}`,
});

export const CONTEXT_MENU_BOTTOM_DIVIDER_STYLE = Object.freeze({
  borderBottom: `${CONTEXT_MENU_METRICS.dividerWidth}px solid ${CONTEXT_MENU_METRICS.dividerColor}`,
});

export const CONTEXT_MENU_BLOCK_DIVIDER_STYLE = Object.freeze({
  ...CONTEXT_MENU_TOP_DIVIDER_STYLE,
  ...CONTEXT_MENU_BOTTOM_DIVIDER_STYLE,
});

export function contextMenuEstimatedHeight({ rows = 0, compactRows = 0, dividers = 0 } = {}) {
  return (
    rows * CONTEXT_MENU_METRICS.rowHeight
    + compactRows * CONTEXT_MENU_METRICS.compactRowHeight
    + dividers * CONTEXT_MENU_METRICS.dividerWidth
    + 2 // one-pixel panel border on both outer edges
  );
}
