// One shared window-picker menu item for both entry points:
//
//   • tab context menu → Move to window;
//   • split-button context menu → Поменять местами.
//
// The question is identical — “which window?” — so the trigger, hover
// lifecycle, viewport-aware flyout and layout map live here together. Callers
// only state which operation selection performs.

import React from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeftRight, Columns2 } from 'lucide-react';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';
import {
  describeWorkspace,
  paneColumns,
  paneGridRects,
  splitPanesFingerprint,
  splitSizesFingerprint,
} from '../../utils/splitPanesModel.mjs';
import { resolveSubmenuSide, submenuArrow } from '../../utils/submenuSide.mjs';
import {
  CONTEXT_MENU_ICON_SLOT_STYLE,
  CONTEXT_MENU_METRICS,
  CONTEXT_MENU_METRICS_HOOK,
  CONTEXT_MENU_PANEL_STYLE,
  CONTEXT_MENU_ROW_STYLE,
  WINDOW_PICKER_METRICS,
  windowPickerNaturalHeight,
  windowPickerNaturalWidth,
} from '../UI/contextMenuMetrics.mjs';
import SideFlyout from '../UI/SideFlyout';

const FLYOUT_GAP_PX = 4;
const FLYOUT_Z_INDEX = 100060;

interface WindowCell {
  index: number;
  column: number;
  row: number;
  focused: boolean;
  empty?: boolean;
  shownTabId: string | null;
  tabs: Array<{ projectId: string; tabId: string }>;
  /** Same fractions that draw the real workspace. */
  heightPct: number;
  widthPct: number;
}

/** `move` moves one tab; `swap` exchanges two complete window contents. */
export type WindowPickMode = 'move' | 'swap';

interface MoveToWindowMenuProps {
  projectId?: string;
  tabId?: string;
  mode?: WindowPickMode;
  /** For swap: the window whose complete contents are being exchanged. */
  sourcePaneIndex?: number | null;
  /** TabBar already chooses one side for all of its submenus. */
  preferredSide?: 'left' | 'right';
  onDone: () => void;
}

const pointInside = (x: number, y: number, rect: DOMRect, tolerance = 2) => (
  x >= rect.left - tolerance
  && x <= rect.right + tolerance
  && y >= rect.top - tolerance
  && y <= rect.bottom + tolerance
);

/**
 * Complete context-menu row plus its flyout.
 *
 * Opening is hover-first: there is no click-gate before the layout appears.
 * `SideFlyout` keeps the transparent gap inside its own hitbox, flips left or
 * right from live viewport space, and clamps the independently measured child
 * vertically. A geometric mousemove guard owns closing because the flyout is a
 * portal and therefore cannot rely on DOM ancestry for mouseleave.
 */
export default function MoveToWindowMenu({
  projectId,
  tabId,
  mode = 'move',
  sourcePaneIndex = null,
  preferredSide,
  onDone,
}: MoveToWindowMenuProps) {
  const triggerRef = React.useRef<HTMLButtonElement | null>(null);
  const flyoutRef = React.useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = React.useState(false);
  const [resolvedSide, setResolvedSide] = React.useState<'left' | 'right'>(preferredSide || 'right');

  const resolveSide = React.useCallback(() => {
    if (preferredSide) {
      setResolvedSide(preferredSide);
      return;
    }
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    setResolvedSide(resolveSubmenuSide({
      menuLeft: rect.left,
      menuRight: rect.right,
      // Include the bridge gap: SideFlyout measures its wrapper, not only the
      // painted card, so both calculations answer with the same side.
      submenuWidth: WINDOW_PICKER_METRICS.panelMaxWidth + FLYOUT_GAP_PX,
      viewportWidth: window.innerWidth,
      pad: CONTEXT_MENU_METRICS.viewportInset,
    }));
  }, [preferredSide]);

  const show = React.useCallback(() => {
    resolveSide();
    setOpen(true);
  }, [resolveSide]);

  const getAnchorRect = React.useCallback(
    () => triggerRef.current?.getBoundingClientRect() || null,
    [],
  );

  React.useEffect(() => {
    if (!open) return undefined;
    const onResize = () => resolveSide();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [open, resolveSide]);

  React.useEffect(() => {
    if (!open) return undefined;
    const onMove = (event: MouseEvent) => {
      const trigger = triggerRef.current?.getBoundingClientRect();
      const flyout = flyoutRef.current?.getBoundingClientRect();
      // The first move may arrive before the portal has measured itself. Do
      // not close from incomplete geometry; the next move has both boxes.
      if (!trigger || !flyout) return;
      if (
        pointInside(event.clientX, event.clientY, trigger)
        || pointInside(event.clientX, event.clientY, flyout)
      ) return;
      setOpen(false);
    };
    window.addEventListener('mousemove', onMove, true);
    return () => window.removeEventListener('mousemove', onMove, true);
  }, [open]);

  const finish = React.useCallback(() => {
    setOpen(false);
    onDone();
  }, [onDone]);

  const isSwap = mode === 'swap';
  const Icon = isSwap ? ArrowLeftRight : Columns2;
  const label = isSwap ? 'Поменять местами' : 'Move to window';

  return (
    <div
      data-window-picker-menu-item={mode}
      style={{ position: 'relative' }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') setOpen(false);
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        role="menuitem"
        data-context-menu-row="ordinary"
        data-tab-context-action={isSwap ? undefined : 'move-to-window'}
        data-split-swap-item={isSwap ? true : undefined}
        aria-haspopup="menu"
        aria-expanded={open}
        className="w-full text-left text-[13px] text-[#ccc] hover:bg-white/10 cursor-pointer flex items-center justify-between"
        style={CONTEXT_MENU_ROW_STYLE}
        onMouseEnter={show}
        onFocus={show}
        onClick={(event) => {
          event.stopPropagation();
          show();
        }}
      >
        <span className="flex items-center min-w-0" style={{ columnGap: CONTEXT_MENU_METRICS.gap }}>
          <span style={CONTEXT_MENU_ICON_SLOT_STYLE}>
            <Icon size={12} className="text-[#888]" />
          </span>
          <span className="truncate">{label}</span>
        </span>
        <span className="text-[#666]">{submenuArrow(resolvedSide)}</span>
      </button>

      {open && createPortal(
        <SideFlyout
          ref={flyoutRef}
          data-window-picker-flyout={mode}
          role="menu"
          getAnchorRect={getAnchorRect}
          side={resolvedSide}
          gap={FLYOUT_GAP_PX}
          edgePadding={CONTEXT_MENU_METRICS.viewportInset}
          zIndex={FLYOUT_Z_INDEX}
          onMouseDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
        >
          <WindowLayoutPicker
            projectId={projectId}
            tabId={tabId}
            mode={mode}
            sourcePaneIndex={sourcePaneIndex}
            onDone={finish}
          />
        </SideFlyout>,
        document.body,
      )}
    </div>
  );
}

/** Compact picture of the current window layout; only a long vertical list scrolls. */
function WindowLayoutPicker({
  projectId,
  tabId,
  mode,
  sourcePaneIndex,
  onDone,
}: Required<Pick<MoveToWindowMenuProps, 'mode' | 'onDone'>> & Pick<
  MoveToWindowMenuProps,
  'projectId' | 'tabId' | 'sourcePaneIndex'
>) {
  // String fingerprint instead of an allocated selector result: this menu is
  // mounted over a busy app-wide store and should repaint only for layout data.
  const layoutKey = useWorkspaceStore((s) => (
    splitPanesFingerprint(s.splitPanes)
      + '#' + s.splitFocusedIndex
      + '#' + (s.activeProjectId || '')
      + '#' + (s.centerStrips[s.activeProjectId || ''] || []).map((entry) => entry.tabId).join('~')
      + '#' + splitSizesFingerprint(s.splitSizes)
  ));

  const windows: WindowCell[] = React.useMemo(() => {
    const st = useWorkspaceStore.getState();
    const centerTabId = st.activeProjectId
      ? st.openProjects.get(st.activeProjectId)?.activeTabId || ''
      : '';
    const view = describeWorkspace(
      st.splitPanes,
      st.splitFocusedIndex,
      st.activeProjectId && centerTabId
        ? { projectId: st.activeProjectId, tabId: centerTabId }
        : null,
    );
    const rects = paneGridRects(st.splitPanes, st.splitSizes);
    const cells = (view.windows as WindowCell[]).map((windowCell) => ({
      ...windowCell,
      heightPct: rects[windowCell.index]?.heightPct ?? 100,
      widthPct: rects[windowCell.index]?.widthPct ?? 100,
    }));

    // The single centre's strip lives outside splitPanes but is still part of
    // the picture the user sees.
    if (st.splitPanes.length === 0 && cells.length === 1) {
      const strip = st.centerStrips[st.activeProjectId || ''] || [];
      const only = { ...cells[0], heightPct: 100, widthPct: 100 };
      return strip.length > 1
        ? [{ ...only, tabs: strip.map((entry) => ({ ...entry })) }]
        : [only];
    }
    return cells;
  }, [layoutKey]);

  const columnWidths = React.useMemo(() => {
    const state = useWorkspaceStore.getState();
    const count = Math.max(1, paneColumns(state.splitPanes).length || 1);
    return Array.from({ length: count }, (_, columnIndex) => (
      windows.find((windowCell) => windowCell.column === columnIndex)?.widthPct
        ?? (100 / count)
    ));
  }, [windows]);

  const columnCount = columnWidths.length;
  const maxRows = Math.max(
    1,
    ...Array.from({ length: columnCount }, (_, columnIndex) => (
      windows.filter((windowCell) => windowCell.column === columnIndex).length
    )),
  );
  const naturalHeight = windowPickerNaturalHeight(maxRows);
  const naturalWidth = windowPickerNaturalWidth(columnCount);
  const panelWidth = Math.max(
    CONTEXT_MENU_METRICS.minWidth,
    Math.min(WINDOW_PICKER_METRICS.panelMaxWidth, naturalWidth + 8),
  );

  const pick = (target: WindowCell) => {
    const store = useWorkspaceStore.getState();
    if (mode === 'swap') {
      if (sourcePaneIndex === null || sourcePaneIndex === undefined) return;
      store.swapSplitPanes(sourcePaneIndex, target.index);
      onDone();
      return;
    }
    if (!projectId || !tabId) return;
    if (store.splitPanes.length === 0) {
      store.addTabToCenterStrip(projectId, tabId);
    } else {
      store.addTabToSplitPaneStrip(target.index, projectId, tabId);
    }
    onDone();
  };

  // The current window stays visible but cannot be selected as its own target.
  const homeIndex = mode === 'swap'
    ? (sourcePaneIndex ?? -1)
    : (windows.find((w) => w.tabs.some((e) => e.tabId === tabId))?.index ?? -1);

  return (
    <div
      data-window-picker-panel
      data-context-menu-metrics={CONTEXT_MENU_METRICS_HOOK}
      style={{
        ...CONTEXT_MENU_PANEL_STYLE,
        width: panelWidth,
        padding: 4,
        background: '#2a2a2a',
        border: '1px solid #444',
        boxShadow: '0 12px 28px rgba(0,0,0,0.55)',
        color: '#ddd',
        fontSize: 11,
        userSelect: 'none',
      }}
    >
      <div
        data-window-picker-scroll
        style={{
          maxWidth: '100%',
          maxHeight: `min(${WINDOW_PICKER_METRICS.viewportMaxHeight}px, calc(100vh - ${CONTEXT_MENU_METRICS.viewportInset * 2 + 8}px))`,
          overflowX: 'hidden',
          overflowY: 'auto',
          overscrollBehavior: 'contain',
        }}
      >
        <div
          data-move-to-window-map
          style={{
            display: 'grid',
            // A bare `fr` has an automatic min-content floor. Labels such as
            // “Окно 3 · 2 вкладки” therefore widened three tracks to 334px
            // inside a 216px map, and overflow:hidden cut the whole last
            // column off. Zero is the real minimum; text truncates inside its
            // compact target while the column proportions still mirror panes.
            gridTemplateColumns: columnWidths
              .map((w) => `minmax(0, ${Math.max(w, 8)}fr)`)
              .join(' '),
            gap: WINDOW_PICKER_METRICS.gap,
            // Natural width chooses the flyout width above; the map itself
            // consumes the INNER content box. Keeping `naturalWidth` here made
            // it 2px wider than panel content after padding+border and produced
            // a pointless horizontal scrollbar even for two windows.
            width: '100%',
            height: naturalHeight,
          }}
        >
          {Array.from({ length: columnCount }, (_, columnIndex) => (
            <div
              key={columnIndex}
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: WINDOW_PICKER_METRICS.gap,
                minHeight: 0,
              }}
            >
              {windows.filter((w) => w.column === columnIndex)
                .map((w) => {
                  const here = w.index === homeIndex;
                  const secondary = here
                    ? (mode === 'swap' ? 'это окно' : 'вкладка здесь')
                    : (w.empty
                      ? 'пусто'
                      : (w.tabs.length > 1 ? `${w.tabs.length} вкладки` : ''));
                  const title = mode === 'swap'
                    ? (here
                      ? 'Это и есть текущее окно'
                      : `Поменять местами с окном ${w.index + 1}`)
                    : (here
                      ? 'Вкладка уже в этом окне'
                      : `Перенести в окно ${w.index + 1}`);
                  return (
                    <button
                      key={w.index}
                      type="button"
                      role="menuitem"
                      disabled={here}
                      aria-disabled={here}
                      aria-label={title}
                      data-move-to-window={w.index}
                      data-window-picker-current={here ? '1' : undefined}
                      onMouseEnter={(event) => {
                        if (here) return;
                        event.currentTarget.style.borderColor = 'rgba(255,255,255,0.75)';
                        event.currentTarget.style.background = 'rgba(255,255,255,0.10)';
                      }}
                      onMouseLeave={(event) => {
                        event.currentTarget.style.borderColor = w.focused
                          ? 'rgba(255,255,255,0.45)'
                          : 'rgba(255,255,255,0.15)';
                        event.currentTarget.style.background = here
                          ? 'rgba(255,255,255,0.03)'
                          : 'rgba(255,255,255,0.06)';
                      }}
                      onClick={() => { if (!here) pick(w); }}
                      style={{
                        // A layout preview is not a miniature dashboard. Keep
                        // every target exactly one compact menu row high; a
                        // full-height pane must not turn into a 104px button.
                        flex: `0 0 ${WINDOW_PICKER_METRICS.cellHeight}px`,
                        minHeight: WINDOW_PICKER_METRICS.cellHeight,
                        minWidth: 0,
                        height: WINDOW_PICKER_METRICS.cellHeight,
                        padding: '0 6px',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        columnGap: 5,
                        overflow: 'hidden',
                        borderRadius: 5,
                        border: `1px solid ${w.focused ? 'rgba(255,255,255,0.45)' : 'rgba(255,255,255,0.15)'}`,
                        background: here ? 'rgba(255,255,255,0.03)' : 'rgba(255,255,255,0.06)',
                        color: here ? '#5f5f65' : '#c8c8ce',
                        cursor: here ? 'default' : 'pointer',
                        textAlign: 'left',
                        whiteSpace: 'nowrap',
                        transition: 'background-color 0.12s, border-color 0.12s',
                      }}
                    >
                      <span style={{ flexShrink: 0 }}>{`Окно ${w.index + 1}`}</span>
                      {secondary && (
                        <span style={{
                          minWidth: 0,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          opacity: 0.62,
                          fontSize: 9,
                        }}>
                          {secondary}
                        </span>
                      )}
                    </button>
                  );
                })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
