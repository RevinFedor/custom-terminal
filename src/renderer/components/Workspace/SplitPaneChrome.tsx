import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Columns2, FileText } from 'lucide-react';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';
import { useUIStore } from '../../store/useUIStore';
import { useProjectsStore } from '../../store/useProjectsStore';
import { isInboxProjectId, INBOX_PROJECT_NAME } from '../../constants/systemProjects';
import { getTabChromeColorConfig, flattenRgbaOnTabbarPanel, adjustRgbaAlpha } from './tabChrome';
import { resolveTabCardBackground, resolveTabCardMetrics } from '../../utils/tabCardVisual.mjs';
import { isEmptyPane, paneGridRects } from '../../utils/splitPanesModel.mjs';
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

export const SPLIT_ATTACH_ROW_H = 26;

// Equal columns, equal rows inside a column; v1 has no draggable divider.
// Geometry comes from the pure model so the rectangles and the layout rules can
// never disagree — see splitPanesModel::paneGridRects.
export function splitPaneRectStyle(
  paneIndex: number,
  panes: Array<{ projectId: string; tabId: string; column?: number }>,
): React.CSSProperties {
  const rect = paneGridRects(panes)[paneIndex];
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
  const { hasProcess, busy } = useTabActivitySignals(tabId);
  const [tabChipHovered, setTabChipHovered] = useState(false);
  const [splitMenu, setSplitMenu] = useState<{ x: number; y: number } | null>(null);
  // Rename in place: same action as double-click in the sidebar list, so a tab
  // can be renamed from whichever surface the user is already looking at.
  const [renaming, setRenaming] = useState(false);
  const [renameDraft, setRenameDraft] = useState('');
  const taskPlan = useWorkspaceStore((s) => s.openProjects.get(projectId)?.tabs.get(tabId)?.taskPlan);
  const taskStatuses = useUIStore((s) => s.taskStatuses);
  const taskStatusShape = useUIStore((s) => s.taskStatusMarker.shape);
  // The SAME size settings the sidebar card obeys (Settings → Размеры), so
  // changing them there moves this chip too instead of leaving two sizes.
  const tabGeo = useUIStore((s) => s.tabGeometry);
  const tabsFontSize = useUIStore((s) => s.tabsFontSize);
  const taskItems = taskPlan?.items || [];
  const displayProjectName = projectName || workspacePath.split('/').filter(Boolean).pop() || 'Project';
  const canSplit = splitPanes.length < 3 && !splitPanes.some(isEmptyPane);
  const inSplit = splitPanes.length > 0;

  const commitRename = () => {
    const next = renameDraft.trim();
    setRenaming(false);
    if (!next || next === tabName) return;
    useWorkspaceStore.getState().renameTab(projectId, tabId, next);
  };

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
  return (
    <div
      data-split-attach-row
      data-focused={focused ? 'true' : undefined}
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        height: SPLIT_ATTACH_ROW_H,
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
      <button
        title={workspacePath || displayProjectName}
        onClick={(e) => {
          e.stopPropagation();
          if (workspacePath) useWorkspaceStore.getState().openProject(projectId, workspacePath);
        }}
        onPointerDown={(e) => e.stopPropagation()}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 5,
          flexShrink: 1,
          minWidth: 0,
          padding: 0,
          background: 'transparent',
          border: 'none',
          fontSize: 11,
          fontWeight: 600,
          color: '#8a8a8f',
          cursor: 'pointer',
        }}
        onMouseEnter={(e) => { e.currentTarget.style.color = '#b4b4b8'; }}
        onMouseLeave={(e) => { e.currentTarget.style.color = '#8a8a8f'; }}
      >
        {projectMeta?.icon ? (
          <img
            src={projectMeta.icon}
            alt=""
            draggable={false}
            style={{ width: 12, height: 12, borderRadius: 2, objectFit: 'cover', flexShrink: 0, opacity: 0.65 }}
          />
        ) : isInboxProjectId(projectId) ? (
          // Inbox has no picture of its own, so it gets the same dashed
          // placeholder square as its card in the titlebar — otherwise the chip
          // is the one place where this project has no mark at all and reads as
          // "icon failed to load". Same size as a real icon so the name does not
          // shift between projects.
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
        ) : null}
        <span
          style={{
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {displayProjectName}
        </span>
      </button>

      <span
          // Named so a test can ask "does the chip FOR THIS TAB carry the
          // loader" — the question the process-bar bugs kept getting wrong,
          // and one that is unanswerable without knowing which tab a chip is.
          data-split-pane-tab-chip
          data-tab-id={tabId}
          title={inSplit
            ? 'Клик — перейти на вкладку. Средний клик — убрать из рабочей области'
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
            // "Go to this tab" — and, unlike a click in the sidebar list, also
            // go to its PROJECT. This chip is the one place that can name a tab
            // from a project the sidebar is not showing (panes are
            // cross-project), so "смена вкладки ≠ смена проекта" gives the
            // wrong answer here: the tab appeared in the center while the
            // sidebar still listed a different project's tabs, and the row the
            // user had just clicked was nowhere in it.
            e.stopPropagation();
            if (renaming) return;
            useWorkspaceStore.getState().activateTabAndProject(projectId, tabId);
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
            // Middle-click removes THIS pane from the split — same gesture as
            // closing a tab in the sidebar list. No ✕ button needed.
            //
            // It acts on the tab NAMED IN THIS CHIP and on nothing else. The
            // guard below is not defensive noise: the row is also rendered in
            // single mode from the CENTER tab, so a stale/foreign tabId here
            // would silently remove a pane the user is not even looking at.
            if (e.button !== 1 || !inSplit) return;
            const paneOfThisTab = useWorkspaceStore.getState().splitPanes
              .some((p) => p.projectId === projectId && p.tabId === tabId);
            if (!paneOfThisTab) return;
            e.preventDefault();
            e.stopPropagation();
            // A file pane steps BACK to whatever this pane showed before it —
            // the pane stays, only its content changes. Opening a file from an
            // agent and middle-clicking it is "undo that", not "close this
            // pane". Falls through to removal when there is nothing to step
            // back to, so the gesture is never a dead click.
            if (useWorkspaceStore.getState().restoreSplitPanePreviousTab(tabId)) return;
            useWorkspaceStore.getState().removeTabFromSplit(tabId);
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
          <TabProcessBar hasProcess={hasProcess} busy={busy} radius={4} zIndex={4} />
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

      {canSplit && (
        <button
          title="Разделить рабочую область. Правый клик — разделить по горизонтали"
          onClick={(e) => {
            e.stopPropagation();
            useWorkspaceStore.getState().addEmptySplitPane(paneIndex ?? null);
          }}
          // Right-click offers the OTHER direction. Two commands rather than a
          // modifier: "above" and "below" are not one action with a flag, and a
          // menu can say which pane it will act on.
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
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
            cursor: 'pointer',
            background: 'transparent',
            border: 'none',
            color: '#8f8f94',
            flexShrink: 0,
          }}
          onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.10)'; (e.currentTarget as HTMLElement).style.color = '#eee'; }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent'; (e.currentTarget as HTMLElement).style.color = '#8f8f94'; }}
        >
          <Columns2 size={12} />
        </button>
      )}

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
            data-split-direction-menu
            style={{
              position: 'fixed',
              top: splitMenu.y + 4,
              left: splitMenu.x,
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

// White focus frame of the focused pane; hairline separator on the others.
export function SplitPaneFocusFrame({ focused }: { focused: boolean }) {
  return (
    <div
      aria-hidden
      data-split-pane-focus-frame={focused ? '1' : '0'}
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
        // 1px, same thickness as the inter-pane separators below — focus is
        // carried by brightness, not by weight. Alpha raised from 0.55 to
        // compensate the halved line so it stays as readable as the old 2px.
        boxShadow: focused
          ? 'inset 0 0 0 1px rgba(255,255,255,0.75)'
          : 'inset -1px 0 0 rgba(255,255,255,0.08), inset 1px 0 0 rgba(255,255,255,0.08)',
      }}
    />
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
