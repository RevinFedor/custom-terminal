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
import { useProjectsStore } from '../../store/useProjectsStore';
import { resolveWorkflowIcon, workflowInitial } from '../../utils/workflowVisuals.mjs';

// Иконка ЧУЖОГО пространства рядом с картой.
//
// Карта рисует раскладку того пространства, где вкладка лежит, а не того, в
// котором человек сейчас. Значит нужен ответ на третий вопрос — в каком именно,
// — и приглушением его дать нельзя: самый блёклый цвет уже занят чужими окнами,
// ниже него ничего нет. Поэтому чужое пространство помечается РАМКОЙ вокруг
// карты и его иконкой из полосы: клетки сохраняют свои цвета, позиция и
// заливка читаются как раньше, а иконка различает два пространства одинаковой
// формы — случай, где форма карты бессильна.
//
// Место под иконку резервируется ВСЕГДА, иначе имена вкладок дёргались бы при
// каждом переносе вкладки между пространствами.
export const PANE_MAP_SPACE_SLOT_W_PX = 9;

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

/** Обёртка карты, помечающая ЧУЖОЕ пространство рамкой и его иконкой. */
function SpaceBadge({ spaceIndex, spaceName, children }: {
  spaceIndex: number;
  spaceName: string;
  children: React.ReactNode;
}) {
  const foreign = spaceIndex >= 0;
  // Same icon authority as SpaceStrip. Primitive selectors keep ordinary
  // layout writes from making every sidebar row rerender an icon object.
  const spaceId = useWorkspaceStore((s) => s.spaces[spaceIndex]?.id || '');
  const configuredIcon = useWorkspaceStore((s) => s.spaces[spaceIndex]?.icon);
  const defaultProjectId = useWorkspaceStore((s) => s.spaces[spaceIndex]?.projectIds?.[0] || '');
  const fallbackProjectIcon = useProjectsStore((s) => (
    defaultProjectId ? s.projects[defaultProjectId]?.icon || null : null
  ));
  const icon = resolveWorkflowIcon(
    { icon: configuredIcon, projectIds: defaultProjectId ? [defaultProjectId] : [] },
    () => fallbackProjectIcon,
  );
  return (
    <span
      data-tab-pane-map-space={foreign ? spaceIndex + 1 : undefined}
      title={foreign ? `Разложена в пространстве «${spaceName}»` : undefined}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 2,
        flexShrink: 0,
        // Рамка обнимает карту целиком: она про то, ГДЕ эта раскладка, а не про
        // отдельную клетку. Внутренняя тень, а не border — border съел бы
        // ширину у самих клеток и карта выглядела бы другой раскладкой.
        padding: foreign ? '1px 2px' : 0,
        borderRadius: 3,
        boxShadow: foreign ? 'inset 0 0 0 1px rgba(255,255,255,0.28)' : undefined,
      }}
    >
      {children}
      <span
        aria-hidden
        data-pane-map-workflow-icon={foreign ? spaceId : undefined}
        style={{
          width: `${PANE_MAP_SPACE_SLOT_W_PX}px`,
          height: `${PANE_MAP_SPACE_SLOT_W_PX}px`,
          flexShrink: 0,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {foreign && (icon ? (
          <img src={icon} alt="" draggable={false}
            style={{ width: '100%', height: '100%', borderRadius: 2, objectFit: 'contain' }} />
        ) : (
          <span style={{ width: '100%', height: '100%', display: 'inline-flex',
            alignItems: 'center', justifyContent: 'center', borderRadius: 2,
            boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.16)',
            background: 'rgba(255,255,255,0.06)', color: '#9b9ba1',
            fontSize: 6.5, fontWeight: 700, lineHeight: 1 }}>
            {workflowInitial(spaceName)}
          </span>
        ))}
      </span>
    </span>
  );
}

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
  return usePaneMapPlacement(projectId, tabId).columns;
}

/**
 * Где эта вкладка разложена: карта окон ПЛЮС пространство, которому эти окна
 * принадлежат.
 *
 * Карта рисует раскладку ТОГО пространства, где вкладка лежит, а не того, в
 * котором человек сейчас: вопрос «где она открыта» не перестаёт иметь ответ
 * оттого, что смотрят в другую раскладку. `spaceIndex` — внутренний адрес
 * чужого пространства (или -1, если вкладка здесь же); по нему badge берёт
 * ту же иконку, что верхняя полоса, различая раскладки одинаковой формы.
 */
export function usePaneMapPlacement(projectId: string, tabId: string): {
  columns: Array<Array<PaneMapCell>>;
  spaceIndex: number;
  spaceName: string;
} {
  // Одна строка на всё: и клетки, и номер, и имя. Селектор, отдающий объект, —
  // новая ссылка на каждую запись в стор, то есть перерисовка КАЖДОЙ строки
  // списка (правило Fingerprint, fix-performance-lags).
  const fingerprint = useWorkspaceStore((s) => {
    const here = paneMapGridModel(
      s.splitPanes,
      s.splitFocusedIndex,
      projectId,
      tabId,
      s.activeProjectId
        ? { projectId: s.activeProjectId, tabId: s.openProjects.get(s.activeProjectId)?.activeTabId || '' }
        : null,
    );
    const draw = (grid: any[]) => grid.map((column: any[]) => column.map((c: any) => c.state).join(',')).join('|');
    if (here.length > 0) return draw(here) + '#-1#';
    // Здесь её нет — ищем в остальных пространствах и рисуем ИХ раскладку.
    const at = s.workspaceSpaceIndexOfTab(tabId);
    if (at < 0) return '#-1#';
    const space = s.spaces[at];
    const layout = space?.layout || {};
    const grid = paneMapGridModel(
      layout.splitPanes || [],
      layout.splitFocusedIndex ?? 0,
      projectId,
      tabId,
      layout.activeProjectId ? { projectId: layout.activeProjectId, tabId } : null,
    );
    return draw(grid) + '#' + at + '#' + (space?.name || '');
  });
  return useMemo(() => {
    const [cells, indexPart, namePart] = fingerprint.split('#');
    return {
      columns: cells
        ? cells.split('|').map((column) => column.split(',').map((state) => ({ mine: state !== 'other', state })))
        : [],
      spaceIndex: Number(indexPart ?? -1),
      spaceName: namePart || '',
    };
  }, [fingerprint]);
}

/** Drop-in for a list row: subscribes itself and renders the mark. */
export function TabPaneMap({ projectId, tabId }: { projectId: string; tabId: string }) {
  const { columns, spaceIndex, spaceName } = usePaneMapPlacement(projectId, tabId);
  return (
    <SpaceBadge spaceIndex={spaceIndex} spaceName={spaceName}>
      <PaneMapCells columns={columns} />
    </SpaceBadge>
  );
}
