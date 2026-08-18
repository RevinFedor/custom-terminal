// "Where is this tab open" — the tiny layout map on a tab row.
//
// Cell position mirrors the pane's POSITION ON SCREEN, in both axes, so the
// answer is read without being decoded: the left cell is the left pane, a
// stacked column draws as a stacked column. Filled = this tab's pane, bright =
// the focused one, HOLLOW = its window, but a neighbouring chip is showing.
//
// The hollow state arrived with strips (2026-08-18): a window holds several tabs
// and shows one, so "which window" and "can I see it" stopped being the same
// question. Two marks would have been the obvious answer and the wrong one — the
// row has no width for a second one, and the two would have to be read together
// anyway. Position keeps answering the first question, fill answers the second.
//
// This lived inside TabBar and was therefore available on exactly one surface —
// the sidebar list. But the question it answers ("is this the tab of the side
// pane?") is asked just as much while picking a tab in Ctrl+Tab / Cmd+P or in
// the pane header's recent list, where you are choosing among tabs that may
// already be on screen. Extracted so those lists show the same mark rather than
// growing a second, drifting copy — the same reason TabListRows and TabSignals
// exist.
//
// Sizing/geometry live here; WHICH cell is which lives in the pure model
// (splitPanesModel::paneMapGrid).

import React, { useMemo } from 'react';
import { paneMapGrid as paneMapGridModel } from '../../utils/splitPanesModel.mjs';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';

export const PANE_MAP_CELL_W_PX = 4;
export const PANE_MAP_CELL_H_PX = 9;
export const PANE_MAP_CELL_GAP_PX = 1.5;
export const PANE_MAP_MAX_CELLS = 3;
// The slot keeps its full width even with no cells: a mark that appears and
// disappears would shift the tab name every time the tab enters or leaves the
// workspace.
export const PANE_MAP_SLOT_W_PX = (PANE_MAP_CELL_W_PX * PANE_MAP_MAX_CELLS)
  + (PANE_MAP_CELL_GAP_PX * (PANE_MAP_MAX_CELLS - 1));

// Focus is carried by COLOR, not by opacity alone: an alpha-only difference is
// exactly what H.264/JPEG eats on dark backgrounds, and these marks must stay
// readable on screen recordings (AI-Optimized UI rule).
const PANE_MAP_COLORS = {
  'self-focused': '#e8e8ea',
  self: '#8a8a92',
  // 'held' is drawn HOLLOW instead (see below) — a window this tab is in, with a
  // neighbouring chip on screen. It has no fill colour at all.
  held: 'transparent',
  other: 'rgba(255,255,255,0.13)',
} as const;

// The hollow cell: an outline in the same grey the filled "self" uses, so the
// pair reads as one thing in two states rather than two different marks. Which
// WINDOW is answered by the cell's position, as always; whether the tab is
// SHOWING there is answered by whether the cell is filled.
const PANE_MAP_HELD_OUTLINE = 'inset 0 0 0 1px #8a8a92';

export interface PaneMapCell { mine: boolean; state: string }

/**
 * Columns of rows, mirroring the workspace. A flat row of cells cannot express a
 * stacked column — it would draw two panes side by side that are actually one
 * above the other, i.e. a layout the user does not have.
 */
export function PaneMapCells({ columns }: { columns: Array<Array<PaneMapCell>> }) {
  return (
    <span
      data-tab-pane-map
      aria-hidden
      title={columns.length > 0 ? 'Панель рабочей области, в которой открыта вкладка' : undefined}
      style={{
        width: `${PANE_MAP_SLOT_W_PX}px`,
        flexShrink: 0,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'flex-end',
        gap: `${PANE_MAP_CELL_GAP_PX}px`,
        pointerEvents: 'none',
      }}
    >
      {columns.map((rows, columnIndex) => (
        <span
          key={columnIndex}
          style={{
            display: 'inline-flex',
            flexDirection: 'column',
            gap: `${PANE_MAP_CELL_GAP_PX}px`,
            height: `${PANE_MAP_CELL_H_PX}px`,
          }}
        >
          {rows.map((cell, rowIndex) => (
            <span
              key={rowIndex}
              data-pane-map-cell={cell.state}
              style={{
                width: `${PANE_MAP_CELL_W_PX}px`,
                // Rows share the column's height, minus the gaps between them —
                // so the mark keeps the same outer size however it is divided.
                flex: 1,
                minHeight: 0,
                borderRadius: 1.5,
                background: PANE_MAP_COLORS[cell.state as keyof typeof PANE_MAP_COLORS]
                  || PANE_MAP_COLORS.other,
                // An OUTLINE, not a border: a border would eat into the 4px cell
                // and make the hollow one visibly smaller than its filled
                // neighbours — the map would then look like a different layout.
                ...(cell.state === 'held' ? { boxShadow: PANE_MAP_HELD_OUTLINE } : null),
              }}
            />
          ))}
        </span>
      ))}
    </span>
  );
}

/**
 * The map cells for ONE tab, subscribed to the live layout.
 *
 * The selector returns a STRING, never the cells array: an array/object selector
 * allocates on every store write, Object.is then sees a new reference and
 * re-renders every row in the list (Fingerprint Pattern, fix-performance-lags).
 * Columns are separated by '|', rows inside a column by ',' — so a stacked
 * layout survives the round-trip through the fingerprint.
 */
export function usePaneMapColumns(projectId: string, tabId: string): Array<Array<PaneMapCell>> {
  const fingerprint = useWorkspaceStore((s) => {
    const grid = paneMapGridModel(
      s.splitPanes,
      s.splitFocusedIndex,
      projectId,
      tabId,
      s.activeProjectId
        ? { projectId: s.activeProjectId, tabId: s.openProjects.get(s.activeProjectId)?.activeTabId || '' }
        : null,
    );
    return grid.map((column) => column.map((c) => c.state).join(',')).join('|');
  });
  return useMemo(
    () => (fingerprint
      ? fingerprint.split('|').map((column) => (
        column.split(',').map((state) => ({ mine: state !== 'other', state }))
      ))
      : []),
    [fingerprint],
  );
}

/** Drop-in for a list row: subscribes itself and renders the mark. */
export function TabPaneMap({ projectId, tabId }: { projectId: string; tabId: string }) {
  const columns = usePaneMapColumns(projectId, tabId);
  return <PaneMapCells columns={columns} />;
}
