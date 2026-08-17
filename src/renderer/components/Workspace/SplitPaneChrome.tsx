import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Columns2, FileText } from 'lucide-react';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';
import { useUIStore } from '../../store/useUIStore';
import { useProjectsStore } from '../../store/useProjectsStore';
import { isInboxProjectId, INBOX_PROJECT_NAME } from '../../constants/systemProjects';
import { getTabChromeColorConfig, flattenRgbaOnTabbarPanel, adjustRgbaAlpha } from './tabChrome';
import {
  resolveTabCardBackground,
  resolveTabCardMetrics,
  resolveSplitAttachRowHeight,
  TAB_CARD_LINE_HEIGHT,
} from '../../utils/tabCardVisual.mjs';
import {
  isEmptyPane,
  paneGridRects,
  normalizeSplitSizes,
  resizeFractions,
  splitAvailability,
  splitDividerDescriptors,
} from '../../utils/splitPanesModel.mjs';
import { clampMenuToViewport } from '../../utils/menuViewportClamp.mjs';
import { openTabContextMenuAt } from './TabBar';
import {
  TabProcessBar,
  TabStatusMarker,
  TabTaskMarker,
  TASK_MARKER_GAP_PX,
  TASK_MARKER_LANE_HEIGHT_PX,
  TASK_MARKER_DEFAULT_COLOR,
  useTabActivitySignals,
} from './TabSignals';
import { requestTaskPlanNavigation } from '../../utils/taskPlanNavigation';
import { PaneRecentTabsButton } from './PaneRecentTabsButton';
import { MarkdownEditor } from '@gt-editor/markdown-editor';
import '@gt-editor/markdown-editor/styles.css';

const { ipcRenderer } = window.require('electron');

// Fallback height only (empty-pane header, restore paths that render before
// settings are read). Real rows size themselves from the chip via
// useSplitAttachRowHeight — a 26px constant under a Settings-sized chip is
// exactly the bug where the chip poked over the pane separator above it.
export const SPLIT_ATTACH_ROW_H = 26;

/**
 * Live height of the pane header row, derived from the same Settings → Размеры
 * values the chip inside it obeys. Every surface that positions content BELOW
 * the row (pane content top, toast anchor, single-mode header slot, file
 * preview offset) must use this hook, not the constant — one of them reading a
 * different number is how the chip and the separator ended up crossing.
 */
export function useSplitAttachRowHeight(): number {
  const tabGeo = useUIStore((s) => s.tabGeometry);
  const tabsFontSize = useUIStore((s) => s.tabsFontSize);
  return resolveSplitAttachRowHeight(tabGeo, { fontSize: tabsFontSize });
}

// Fractional columns, fractional rows inside a column (equal when sizes are
// absent). Geometry comes from the pure model so the rectangles and the layout
// rules can never disagree — see splitPanesModel::paneGridRects.
export function splitPaneRectStyle(
  paneIndex: number,
  panes: Array<{ projectId: string; tabId: string; column?: number }>,
  sizes: { cols: number[]; rows: number[][] } | null = null,
): React.CSSProperties {
  const rect = paneGridRects(panes, sizes)[paneIndex];
  if (!rect) return { position: 'absolute', inset: 0 };
  return {
    position: 'absolute',
    left: `${rect.leftPct}%`,
    width: `${rect.widthPct}%`,
    top: `${rect.topPct}%`,
    height: `${rect.heightPct}%`,
  };
}

interface AttachRowProps {
  projectId: string;
  tabId: string;
  focused: boolean;
  /** Pane index in split mode — the split button inserts the new pane right
   *  after THIS pane. Omitted in single mode (append semantics). */
  paneIndex?: number;
}

// Top strip of a split pane: [project chip][tab chip], split button on the
// right. The tab chip reuses the shared tab chrome so the card language
// matches the sidebar. Middle-click on the tab chip removes the pane from the
// split (like middle-click closes things elsewhere) — there is no ✕ button.
// The terminal/transcript toggle lives in the composer's top line, not here.
//
// There is deliberately NO "pick target pane" toggle here: clicking a pane and
// then clicking a tab already does the same thing in the same two clicks, so a
// separate armed mode was pure surface for a rare case.

export function SplitPaneAttachRow({ projectId, tabId, focused, paneIndex }: AttachRowProps) {
  const projectMeta = useProjectsStore((s) => s.projects[projectId]);
  const projectName = projectMeta?.name
    || (isInboxProjectId(projectId) ? INBOX_PROJECT_NAME : null);
  const workspacePath = useWorkspaceStore((s) => s.openProjects.get(projectId)?.projectPath || '');
  // Subscribe to the PRIMITIVE fields, never to the tab object: rename mutates
  // `tab.name` in place and only swaps the openProjects Map, so the object
  // reference stays equal and an object-returning selector never re-renders —
  // the header kept the stale name until some unrelated update repainted it.
  // (Same Fingerprint-Pattern rule as fix-performance-lags.md.)
  const tabExists = useWorkspaceStore((s) => !!s.openProjects.get(projectId)?.tabs.get(tabId));
  const tabName = useWorkspaceStore((s) => s.openProjects.get(projectId)?.tabs.get(tabId)?.name || '');
  const tabColor = useWorkspaceStore((s) => s.openProjects.get(projectId)?.tabs.get(tabId)?.color);
  const tabType = useWorkspaceStore((s) => s.openProjects.get(projectId)?.tabs.get(tabId)?.tabType);
  const splitPanes = useWorkspaceStore((s) => s.splitPanes);
  const tabSessionStatus = useWorkspaceStore((s) => s.openProjects.get(projectId)?.tabs.get(tabId)?.sessionStatus);
  const sessionStatuses = useUIStore((s) => s.sessionStatuses);
  const statusMeta = tabSessionStatus
    ? sessionStatuses.find((s) => s.id === tabSessionStatus)
    : undefined;
  const { hasProcess, busy, inheritedBusy } = useTabActivitySignals(tabId);
  const [tabChipHovered, setTabChipHovered] = useState(false);
  const [splitMenu, setSplitMenu] = useState<{ x: number; y: number } | null>(null);
  // Rename in place: same action as double-click in the sidebar list, so a tab
  // can be renamed from whichever surface the user is already looking at.
  const [renaming, setRenaming] = useState(false);
  const [renameDraft, setRenameDraft] = useState('');
  // Measured position of the split-direction menu, clamped into the window.
  const splitMenuRef = React.useRef<HTMLDivElement | null>(null);
  const [splitMenuPos, setSplitMenuPos] = useState<{ x: number; y: number } | null>(null);
  const taskPlan = useWorkspaceStore((s) => s.openProjects.get(projectId)?.tabs.get(tabId)?.taskPlan);
  const taskStatuses = useUIStore((s) => s.taskStatuses);
  const taskStatusShape = useUIStore((s) => s.taskStatusMarker.shape);
  // The SAME size settings the sidebar card obeys (Settings → Размеры), so
  // changing them there moves this chip too instead of leaving two sizes.
  const tabGeo = useUIStore((s) => s.tabGeometry);
  const tabsFontSize = useUIStore((s) => s.tabsFontSize);
  const taskItems = taskPlan?.items || [];
  const displayProjectName = projectName || workspacePath.split('/').filter(Boolean).pop() || 'Project';
  // The button STAYS and greys out at the limit instead of disappearing: a
  // control that vanishes reads as a bug ("кнопка пропала"), a greyed one with
  // a tooltip states the rule. Each direction is asked about separately —
  // three columns full does not mean this column cannot still be stacked.
  const splitCan = splitAvailability(splitPanes, paneIndex ?? null);
  const inSplit = splitPanes.length > 0;

  const commitRename = () => {
    const next = renameDraft.trim();
    setRenaming(false);
    if (!next || next === tabName) return;
    useWorkspaceStore.getState().renameTab(projectId, tabId, next);
  };

  // Clamp the split-direction menu into the window once it has a measurable
  // box. useLayoutEffect, not useEffect: the corrected position must land in
  // the same frame, or the menu is visibly drawn outside the app and then
  // jumps. Declared ABOVE the early return below — hooks cannot be conditional.
  React.useLayoutEffect(() => {
    if (!splitMenu) { setSplitMenuPos(null); return; }
    const el = splitMenuRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const next = clampMenuToViewport({
      x: splitMenu.x,
      y: splitMenu.y + 4,
      width: rect.width,
      height: rect.height,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
    });
    setSplitMenuPos((prev) => (prev && prev.x === next.x && prev.y === next.y ? prev : next));
  }, [splitMenu]);

  if (!tabExists) return null;
  const chrome = getTabChromeColorConfig({ color: tabColor, tabType });
  const hasColor = !!tabColor && tabColor !== 'default';
  // Size, colour and hover all come from the shared card rules, so this chip
  // and the sidebar card cannot look like two different objects for the same
  // tab. Before this, the chip was 21px tall at 11.5px text next to a 27px
  // card at 14px, and its hover painted a flat white wash OVER the tab's own
  // colour — a green tab flashed grey-green and read as another widget.
  const cardMetrics = resolveTabCardMetrics(tabGeo, {
    fontSize: tabsFontSize,
    showTaskLane: taskItems.length > 0,
    hasStatusMarker: !!statusMeta,
  });
  const tabChipBg = flattenRgbaOnTabbarPanel(resolveTabCardBackground(
    { bgColor: chrome.bgColor, hasColor, hovered: tabChipHovered },
    adjustRgbaAlpha,
  ));
  // Derived from the SAME settings as the chip, so the row always fits it.
  // The wrapper that reserves this slot uses the same hook — see
  // useSplitAttachRowHeight.
  const rowH = resolveSplitAttachRowHeight(tabGeo, { fontSize: tabsFontSize });
  return (
    <div
      data-split-attach-row
      data-focused={focused ? 'true' : undefined}
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        height: rowH,
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: '0 8px',
        background: 'transparent',
        boxSizing: 'border-box',
        zIndex: 3,
        userSelect: 'none',
        // Pane wrappers are pointer-events:none; every interactive surface
        // re-enables its own hits.
        pointerEvents: 'auto',
      }}
    >
      {/* Project = an inert 12px badge, icon only. It answers "whose zone is
          this window" — the one mark that survives when the sidebar shows a
          different project. NOT a button (2026-08-17): with the one-pointer
          model a click anywhere in the pane already focuses it and the sidebar
          follows the tab's project, so a click here had nothing left to do —
          navigation lives on the titlebar cards and the tab chip. The name
          moved into the tooltip: next to the tab chip it repeated information
          the icon already carries and stole width from the tab's own name. */}
      <span
        title={displayProjectName + (workspacePath ? `\n${workspacePath}` : '')}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          flexShrink: 0,
        }}
      >
        {projectMeta?.icon ? (
          <img
            src={projectMeta.icon}
            alt=""
            draggable={false}
            style={{ width: 12, height: 12, borderRadius: 2, objectFit: 'cover', flexShrink: 0, opacity: 0.65 }}
          />
        ) : (
          // No icon set (or Inbox): the same dashed placeholder square as the
          // titlebar card, so the header never reads as "icon failed to load"
          // and the chip's left edge does not shift between projects.
          <span
            aria-hidden
            style={{
              width: 12,
              height: 12,
              borderRadius: 2,
              flexShrink: 0,
              border: '1px dashed rgba(148,163,184,0.8)',
              background: 'rgba(148,163,184,0.08)',
            }}
          />
        )}
      </span>

      <span
          // Named so a test can ask "does the chip FOR THIS TAB carry the
          // loader" — the question the process-bar bugs kept getting wrong,
          // and one that is unanswerable without knowing which tab a chip is.
          data-split-pane-tab-chip
          data-tab-id={tabId}
          title={inSplit
            ? 'Клик — перейти на вкладку. Средний клик — убрать вкладку из этого окна (окно останется)'
            : 'Клик — перейти на вкладку'}
          onMouseEnter={() => setTabChipHovered(true)}
          onMouseLeave={() => setTabChipHovered(false)}
          // Only a LEFT press may take focus. A right-click opens a menu about
          // this tab — inspecting a tab is not switching to it, and stealing
          // focus there moves the surface out from under the menu the user just
          // opened. (pointerdown fires for every button, hence the check.)
          onPointerDown={(e) => {
            e.stopPropagation();
            if (e.button !== 0) e.preventDefault();
          }}
          // Nothing in this header is draggable: a pane header shows ONE tab,
          // so there is no order to rearrange, and a drag here would only be a
          // way to start an action the surface cannot finish.
          draggable={false}
          onDragStart={(e) => e.preventDefault()}
          onClick={(e) => {
            // "Go to this tab". Activation itself brings the sidebar to the
            // tab's project now (one-pointer model), so the chip needs no
            // special project-following path anymore.
            e.stopPropagation();
            if (renaming) return;
            useWorkspaceStore.getState().activateCenterTab(projectId, tabId);
          }}
          onDoubleClick={(e) => {
            // Same gesture as in the sidebar list. File tabs keep their file
            // name — renaming one there would promise something the file
            // itself does not do.
            e.preventDefault();
            e.stopPropagation();
            if (tabType === 'file') return;
            setRenameDraft(tabName);
            setRenaming(true);
          }}
          onContextMenu={(e) => {
            // The sidebar's own menu, opened for THIS tab — not a second copy.
            // It renders downward from the click: the header is flush against
            // the top of the pane, so there is no room above it.
            e.preventDefault();
            e.stopPropagation();
            openTabContextMenuAt(projectId, tabId, e.clientX, e.clientY);
          }}
          onAuxClick={(e) => {
            // Middle-click takes this tab OUT OF THE WINDOW: the pane stays and
            // becomes an empty placeholder, and the tab keeps living in the
            // sidebar list — it is not closed. Closing the window itself is the
            // placeholder's own ✕, so a stray middle-click can never destroy a
            // layout the user built.
            //
            // It acts on the tab NAMED IN THIS CHIP and on nothing else. The
            // guard below is not defensive noise: the row is also rendered in
            // single mode from the CENTER tab, so a stale/foreign tabId here
            // would silently empty a pane the user is not even looking at.
            if (e.button !== 1 || !inSplit) return;
            const paneOfThisTab = useWorkspaceStore.getState().splitPanes
              .some((p) => p.projectId === projectId && p.tabId === tabId);
            if (!paneOfThisTab) return;
            e.preventDefault();
            e.stopPropagation();
            // A file pane steps BACK to whatever this pane showed before it.
            // Opening a file from an agent and middle-clicking it is "undo
            // that", not "clear this window" — the pane returns to its previous
            // tab instead of going empty. Falls through to clearing when there
            // is nothing to step back to, so the gesture is never dead.
            if (useWorkspaceStore.getState().restoreSplitPanePreviousTab(tabId)) return;
            useWorkspaceStore.getState().clearTabFromSplitPane(tabId);
          }}
          style={{
            // The signals below are absolutely positioned against THIS chip.
            position: 'relative',
            flexShrink: 1,
            minWidth: 0,
            // NOT `overflow: hidden`. The task squares hang a few px BELOW the
            // bottom edge on purpose — they mark the boundary, and a lane that
            // stops inside the card says nothing. Clipping here trimmed them
            // flush and made them look like a row inside the chip.
            // The name gets its own clipping instead, on the text node.
            whiteSpace: 'nowrap',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            fontSize: cardMetrics.fontSize,
            // Pinned, not browser-default: the row height PREDICTS the chip's
            // height from this number (resolveSplitAttachRowHeight), and the
            // default 'normal' is font-dependent — the prediction would drift.
            lineHeight: TAB_CARD_LINE_HEIGHT,
            color: '#e8e8e8',
            cursor: 'pointer',
            // Hover brightens the tab's OWN colour (shared rule), it does not
            // paint over it.
            background: tabChipBg,
            border: `1px solid ${chrome.borderColor}55`,
            borderRadius: cardMetrics.borderRadius,
            // Left padding clears the status marker when one is shown, so the
            // name never sits under it — same rule as the sidebar card.
            padding: cardMetrics.padding,
            transition: 'background-color 0.12s ease',
          }}
        >
          {/* Signals belong to the TAB, so they hang off the chip — not off the
              header row. The row is the full pane width (~1215px) while the chip
              is ~195px: anchoring the bar to the row put it ~900px away from the
              tab it describes, next to the split button, even though its width,
              color and edge were all correct. Shared component, so the sidebar
              card and this chip cannot drift apart again. */}
          <TabProcessBar
            hasProcess={hasProcess}
            busy={busy}
            inheritedBusy={inheritedBusy}
            radius={4}
            zIndex={4}
          />
          <TabStatusMarker color={statusMeta?.color} title={statusMeta?.label} />
          {tabType === 'file' && <FileText size={10} style={{ color: '#a78bfa', flexShrink: 0 }} />}
          {renaming ? (
            <input
              autoFocus
              value={renameDraft}
              onChange={(e) => setRenameDraft(e.target.value)}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => e.stopPropagation()}
              onBlur={commitRename}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === 'Enter') commitRename();
                else if (e.key === 'Escape') setRenaming(false);
              }}
              style={{
                width: Math.max(60, renameDraft.length * 6.5 + 12),
                minWidth: 60,
                padding: 0,
                border: 'none',
                outline: 'none',
                background: 'transparent',
                color: '#fff',
                font: 'inherit',
              }}
            />
          ) : (
            // The name clips itself now that the chip no longer clips its
            // children — otherwise a long tab name would stretch the header.
            <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {tabName}
            </span>
          )}
          {/* Task squares along the bottom seam of the chip — the same lane the
              sidebar card carries, from the same component. Partial overlap with
              the content below is intended: they mark the boundary. */}
          {taskItems.length > 0 && (
            <span
              data-task-plan-tab-markers
              style={{
                position: 'absolute',
                left: 6,
                right: 6,
                // Hangs below the bottom edge by the shared rule, same as the
                // sidebar card — the squares straddle the seam rather than
                // sitting inside it.
                bottom: `${cardMetrics.laneBottomPx}px`,
                height: `${TASK_MARKER_LANE_HEIGHT_PX}px`,
                display: 'flex',
                alignItems: 'flex-end',
                gap: `${TASK_MARKER_GAP_PX}px`,
                overflow: 'hidden',
                pointerEvents: 'none',
                zIndex: 7,
              }}
            >
              {taskItems.map((task: any) => {
                const status = task.statusId
                  ? taskStatuses.find((candidate) => candidate.id === task.statusId)
                  : undefined;
                return (
                  <TabTaskMarker
                    key={task.id}
                    color={status?.color || TASK_MARKER_DEFAULT_COLOR}
                    shape={taskStatusShape}
                    title={task.title}
                    onClick={(event) => {
                      event.stopPropagation();
                      useWorkspaceStore.getState().activateCenterTab(projectId, tabId);
                      requestTaskPlanNavigation({ tabId, taskId: task.id, view: 'active' });
                    }}
                  />
                );
              })}
            </span>
          )}
      </span>

      {/* Recent tabs — right of the name, as approved. Puts a tab into THIS
          pane WITHOUT taking focus; the chip's own click still navigates. Two
          neighbouring controls, two different questions: "go there" and "show
          it here". */}
      <PaneRecentTabsButton paneIndex={paneIndex ?? -1} currentTabId={tabId} />

      <span style={{ flex: 1 }} />

      {/* VS Code header pattern (approved 2026-08-17): pane ACTIONS show on
          the focused pane only; an unfocused pane reveals them on header
          hover (see globals.css [data-split-attach-row]). The button stays
          mounted either way — the reveal is opacity, so the header layout
          never shifts and the "кнопка пропала" bug class stays impossible. */}
      <button
        data-split-button
        data-split-horizontal={splitCan.horizontal ? '1' : '0'}
        data-split-vertical={splitCan.vertical ? '1' : '0'}
        title={splitCan.horizontal
          ? 'Разделить рабочую область. Правый клик — разделить по горизонтали'
          : splitCan.vertical
            ? 'Три колонки уже открыты. Правый клик — разделить эту колонку по горизонтали'
            : splitCan.reason === 'placeholder'
              ? 'Сначала выберите вкладку для пустой панели'
              : 'Рабочая область заполнена: три колонки, в этой уже две строки'}
        onClick={(e) => {
          e.stopPropagation();
          // Left click means "split sideways". When only the vertical
          // direction is left, the click OPENS THE MENU instead of doing
          // nothing: the gesture keeps leading somewhere, and the menu is the
          // place that names the remaining direction.
          if (splitCan.horizontal) {
            useWorkspaceStore.getState().addEmptySplitPane(paneIndex ?? null);
          } else if (splitCan.vertical) {
            const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
            setSplitMenu({ x: r.left, y: r.bottom });
          }
        }}
        // Right-click offers the OTHER direction. Two commands rather than a
        // modifier: "above" and "below" are not one action with a flag, and a
        // menu can say which pane it will act on.
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          if (!splitCan.vertical) return;
          setSplitMenu({ x: e.clientX, y: e.clientY });
        }}
        onPointerDown={(e) => {
          e.stopPropagation();
          // Left press may focus; a right press opens a menu ABOUT this pane
          // and must not move focus out from under it.
          if (e.button !== 0) e.preventDefault();
        }}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 18,
          height: 18,
          borderRadius: 4,
          cursor: (splitCan.horizontal || splitCan.vertical) ? 'pointer' : 'not-allowed',
          background: 'transparent',
          border: 'none',
          // Dimmed, not gone: the control keeps its place in the row so the
          // header layout never shifts when the last slot is taken.
          color: (splitCan.horizontal || splitCan.vertical) ? '#8f8f94' : '#4a4a4e',
          flexShrink: 0,
        }}
        onMouseEnter={(e) => {
          if (!splitCan.horizontal && !splitCan.vertical) return;
          (e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.10)';
          (e.currentTarget as HTMLElement).style.color = '#eee';
        }}
        onMouseLeave={(e) => {
          (e.currentTarget as HTMLElement).style.background = 'transparent';
          (e.currentTarget as HTMLElement).style.color = (splitCan.horizontal || splitCan.vertical) ? '#8f8f94' : '#4a4a4e';
        }}
      >
        <Columns2 size={12} />
      </button>

      {/* Rendered through a portal: the header is 26px tall with overflow
          clipping, so an inline menu would be cut off at the first row. */}
      {splitMenu && createPortal(
        <>
          <div
            onMouseDown={() => setSplitMenu(null)}
            onContextMenu={(e) => { e.preventDefault(); setSplitMenu(null); }}
            style={{ position: 'fixed', inset: 0, zIndex: 9998 }}
          />
          <div
            ref={splitMenuRef}
            data-split-direction-menu
            style={{
              position: 'fixed',
              // Clamped to the window: this menu is opened from the RIGHT-most
              // control of a pane header, so raw cursor coordinates put its body
              // outside the app — a DOM menu, unlike an OS one, is not moved back
              // by anyone. Measured after the first paint (see the effect above);
              // until then it renders at the cursor, which is already correct
              // everywhere except the edges.
              top: splitMenuPos ? splitMenuPos.y : splitMenu.y + 4,
              left: splitMenuPos ? splitMenuPos.x : splitMenu.x,
              zIndex: 9999,
              minWidth: 190,
              padding: '4px 0',
              background: '#242427',
              border: '1px solid rgba(255,255,255,0.12)',
              borderRadius: 6,
              boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
              fontSize: 12,
              color: '#ddd',
              userSelect: 'none',
            }}
          >
            {([
              { side: 'above' as const, label: 'Разделить: панель сверху' },
              { side: 'below' as const, label: 'Разделить: панель снизу' },
            ]).map(({ side, label }) => (
              <div
                key={side}
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  setSplitMenu(null);
                  useWorkspaceStore.getState().addVerticalSplitPane(paneIndex ?? null, side);
                }}
                style={{ padding: '5px 12px', cursor: 'pointer', whiteSpace: 'nowrap' }}
                onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.08)'; }}
                onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
              >
                {label}
              </div>
            ))}
          </div>
        </>,
        document.body,
      )}
    </div>
  );
}

/** Above every surface a pane can host, so the frame is never interrupted. */
export const SPLIT_PANE_FOCUS_FRAME_Z = 200;

/**
 * Gap between a pane's content and its frame.
 *
 * The frame is a 1px line drawn ON the pane's edge. Content flush against that
 * column touches it, and anything light there — a scrollbar thumb, the
 * Timeline's rail — fuses with the line, making the frame look thicker on that
 * side than on the other three. Two pixels separate them without costing any
 * visible layout.
 */
export const SPLIT_PANE_CONTENT_INSET_PX = 2;

/**
 * Contour shown while the cursor is over an UNFOCUSED pane.
 *
 * Its job is to explain the swallowed first click BEFORE it happens: the
 * pane lights up under the cursor, so "this click will select this pane"
 * is visible in advance instead of felt afterwards as a dead click.
 *
 * Between the two neighbour states (0.08 side lines) and the active-but-no-
 * keyboard state (0.30 full contour): loud enough to notice, quiet enough not
 * to be mistaken for focus itself.
 */
export const SPLIT_PANE_HOVER_RING = 'inset 0 0 0 1px rgba(255,255,255,0.20)';

// White focus frame of the focused pane; hairline separator on the others.
export function SplitPaneFocusFrame({ focused }: { focused: boolean }) {
  // Two states only: focused (full bright contour) and idle (side hairlines,
  // hover ring). The third state — "active but the keyboard is elsewhere" —
  // died with per-pane Ctrl+Tab (2026-08-17): the gesture is always global
  // now, so the frame has nothing extra to signal.
  //
  // Brightness, not colour: tabs carry their own colours and a coloured
  // contour would fight them, and violet already means "drag me" on the
  // resize handles.
  const state = focused ? 'focused' : 'idle';
  return (
    <div
      aria-hidden
      data-split-pane-focus-frame={focused ? '1' : '0'}
      data-split-pane-frame-state={state}
      style={{
        position: 'absolute',
        inset: 0,
        pointerEvents: 'none',
        // The frame draws the pane's BOUNDARY, so it must sit above everything
        // inside the pane. At z=4 it was painted under the docked input (z=140)
        // and the side panels (z=130): the composer covered the bottom edge and
        // the line visibly broke where they met. A boundary with a gap in it
        // reads as "this pane ends here", which is exactly wrong.
        zIndex: SPLIT_PANE_FOCUS_FRAME_Z,
        // 1px everywhere, same thickness as the inter-pane separators — focus
        // is carried by brightness, not by weight.
        // The idle frame leaves its box-shadow to the STYLESHEET (see
        // globals.css: `[data-split-pane-frame-state="idle"]`), because that is
        // the only state with a :hover variant — and an inline box-shadow here
        // would win over any :hover rule, which is exactly why the first
        // CSS-only attempt rendered nothing at all.
        ...(focused ? { boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.75)' } : null),
        transition: 'box-shadow 0.12s ease',
      }}
    />
  );
}

// ── Resizable dividers ────────────────────────────────────────────────────

/** 6px grab strip centred on the 1px boundary — same feel as the TabSidebar
 *  handle, and the same violet: violet already means "drag me" here. */
const SPLIT_DIVIDER_HIT_PX = 6;
const SPLIT_DIVIDER_HOVER_BG = 'rgba(99,102,241,0.4)';

type LiveSizes = { cols: number[]; rows: number[][] };

/**
 * One layer over the whole split, hosting every divider strip.
 *
 * The live drag does NOT write the store: pane wrappers are positioned
 * directly in the DOM from the in-flight fractions, and the store learns the
 * result once, on mouseup (commitSplitSizes). A store write per mousemove
 * would rebuild the terminals memo — every pane of every project — at
 * pointer speed. The strips themselves follow via this component's local
 * state, which re-renders only this thin layer.
 */
export function SplitDividerLayer() {
  const panes = useWorkspaceStore((s) => s.splitPanes);
  const committedSizes = useWorkspaceStore((s) => s.splitSizes);
  const [liveSizes, setLiveSizes] = useState<LiveSizes | null>(null);
  const layerRef = React.useRef<HTMLDivElement | null>(null);
  const liveRef = React.useRef<LiveSizes | null>(null);
  // The strip's violet is managed by HAND (mouseenter/leave + drag), never by
  // the style prop: this layer re-renders on every drag move to keep the strip
  // under the pointer, and a React-managed background would be wiped by each
  // of those renders the moment the prop reads undefined.
  const draggingIdRef = React.useRef<string | null>(null);
  const cancelDragRef = React.useRef<(() => void) | null>(null);

  // A pane write mid-drag (tab closed elsewhere, project closed — pane
  // HISTORY purges rewrite the array too) invalidates both the in-flight
  // fractions and the grab-time baseline: cancel, and put the wrappers back
  // on the COMMITTED geometry ourselves. The memo cannot be relied on for
  // that — a same-tabIds write (history purge) changes neither its key nor
  // the sizes fingerprint, so nothing else would ever repaint the wrappers
  // out of their mid-drag positions.
  useEffect(() => {
    if (!cancelDragRef.current && !liveRef.current) return;
    cancelDragRef.current?.();
    liveRef.current = null;
    setLiveSizes(null);
    const host = layerRef.current?.parentElement;
    if (!host || panes.length < 2) return;
    const rects = paneGridRects(panes, useWorkspaceStore.getState().splitSizes);
    host.querySelectorAll<HTMLElement>('[data-terminal-pane-wrapper][data-split-pane-index]').forEach((el) => {
      const idx = Number(el.getAttribute('data-split-pane-index'));
      const rect = rects[idx];
      if (!rect) return;
      el.style.left = `${rect.leftPct}%`;
      el.style.width = `${rect.widthPct}%`;
      el.style.top = `${rect.topPct}%`;
      el.style.height = `${rect.heightPct}%`;
    });
  }, [panes]);

  if (panes.length < 2) return null;
  const sizes = liveSizes ?? committedSizes;
  const dividers = splitDividerDescriptors(panes, sizes);
  if (dividers.length === 0) return null;

  // Reposition the pane wrappers straight in the DOM — the exact styles the
  // memo would write, minus the memo. Wrapper lookup by the pane-index attr
  // works because the wrappers are SIBLINGS of this layer in the same host.
  const applyLiveGeometry = (next: LiveSizes) => {
    const host = layerRef.current?.parentElement;
    if (!host) return;
    const rects = paneGridRects(panes, next);
    host.querySelectorAll<HTMLElement>('[data-terminal-pane-wrapper][data-split-pane-index]').forEach((el) => {
      const idx = Number(el.getAttribute('data-split-pane-index'));
      const rect = rects[idx];
      if (!rect) return;
      el.style.left = `${rect.leftPct}%`;
      el.style.width = `${rect.widthPct}%`;
      el.style.top = `${rect.topPct}%`;
      el.style.height = `${rect.heightPct}%`;
    });
  };

  const startDrag = (
    e: React.MouseEvent,
    divider: ReturnType<typeof splitDividerDescriptors>[number],
  ) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const layer = layerRef.current;
    const strip = e.currentTarget as HTMLElement;
    if (!layer) return;
    const hostRect = layer.getBoundingClientRect();
    if (hostRect.width === 0 || hostRect.height === 0) return;
    const startX = e.clientX;
    const startY = e.clientY;
    // Drag math runs against the sizes AT GRAB TIME (normalized to the current
    // structure), so the min-size clamp never accumulates across moves.
    const base = normalizeSplitSizes(panes, sizes) as LiveSizes;
    draggingIdRef.current = divider.id;
    strip.style.background = SPLIT_DIVIDER_HOVER_BG;
    const onMove = (ev: MouseEvent) => {
      let next: LiveSizes;
      if (divider.kind === 'col') {
        const deltaFr = (ev.clientX - startX) / hostRect.width;
        next = { cols: resizeFractions(base.cols, divider.dividerIndex, deltaFr), rows: base.rows };
      } else {
        // Columns are full height, so a row's fraction is of the host height.
        const deltaFr = (ev.clientY - startY) / hostRect.height;
        const rows = base.rows.map((r, c) => (
          c === divider.columnIndex ? resizeFractions(r, divider.dividerIndex, deltaFr) : r
        ));
        next = { cols: base.cols, rows };
      }
      liveRef.current = next;
      setLiveSizes(next); // repositions the strips (this thin layer only)
      applyLiveGeometry(next); // repositions the pane wrappers, no store write
    };
    const stopListening = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      draggingIdRef.current = null;
      cancelDragRef.current = null;
      if (!strip.matches(':hover')) strip.style.background = '';
    };
    const onUp = () => {
      stopListening();
      const finalSizes = liveRef.current;
      liveRef.current = null;
      setLiveSizes(null);
      // ONE store write per finished drag. The memo then repaints the wrappers
      // from the same fractions the DOM already shows — no visual jump. A
      // clean click (no move) commits nothing, which is what lets dblclick
      // below mean "reset" without the two mousedowns fighting it.
      if (finalSizes) useWorkspaceStore.getState().commitSplitSizes(finalSizes);
    };
    cancelDragRef.current = stopListening;
    document.body.style.cursor = divider.kind === 'col' ? 'col-resize' : 'row-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  };

  return (
    <div
      ref={layerRef}
      data-split-divider-layer
      aria-hidden
      style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 5 }}
    >
      {dividers.map((d) => (
        <div
          key={d.id}
          data-split-divider={d.id}
          onMouseDown={(e) => startDrag(e, d)}
          // Double-click = back to the equal split, all dividers at once.
          // (Micro-jitter between the two clicks is harmless: a near-equal
          // drag packs to null anyway — see EQUAL_EPS in the model.)
          onDoubleClick={() => useWorkspaceStore.getState().commitSplitSizes(null)}
          onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = SPLIT_DIVIDER_HOVER_BG; }}
          onMouseLeave={(e) => {
            if (draggingIdRef.current !== d.id) (e.currentTarget as HTMLElement).style.background = '';
          }}
          style={{
            position: 'absolute',
            pointerEvents: 'auto',
            ...(d.kind === 'col'
              ? {
                left: `calc(${d.xPct}% - ${SPLIT_DIVIDER_HIT_PX / 2}px)`,
                top: 0,
                bottom: 0,
                width: SPLIT_DIVIDER_HIT_PX,
                cursor: 'col-resize',
              }
              : {
                top: `calc(${d.yPct}% - ${SPLIT_DIVIDER_HIT_PX / 2}px)`,
                left: `${d.leftPct}%`,
                width: `${d.widthPct}%`,
                height: SPLIT_DIVIDER_HIT_PX,
                cursor: 'row-resize',
              }),
          }}
        />
      ))}
    </div>
  );
}

// Markdown/file content INSIDE a split pane. The global FilePreview overlay
// stays the single-mode surface; a pane needs its own reader because the
// overlay is a fixed singleton covering the whole window.
export function SplitFilePane({ filePath, visible }: { filePath: string; visible: boolean }) {
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fontSize = 13;

  useEffect(() => {
    let cancelled = false;
    if (!filePath) return undefined;
    setContent(null);
    setError(null);
    ipcRenderer.invoke('file:read', filePath).then((result: any) => {
      if (cancelled) return;
      if (result?.success) setContent(String(result.content ?? ''));
      else setError(result?.error || 'Не удалось прочитать файл');
    }).catch((e: any) => { if (!cancelled) setError(e?.message || String(e)); });
    return () => { cancelled = true; };
  }, [filePath, visible]);

  if (!visible) return null;
  return (
    <div style={{ position: 'absolute', inset: 0, background: '#161522', overflow: 'hidden', display: 'flex', flexDirection: 'column', pointerEvents: 'auto' }}>
      {error ? (
        <div style={{ padding: 16, color: '#f87171', fontSize: 12.5 }}>{error}</div>
      ) : content === null ? (
        <div style={{ padding: 16, color: '#777', fontSize: 12.5 }}>Загрузка…</div>
      ) : (
        <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
          <MarkdownEditor
            content={content}
            onChange={() => {}}
            readOnly
            fontSize={fontSize}
            showLineNumbers={false}
            compact
          />
        </div>
      )}
    </div>
  );
}
