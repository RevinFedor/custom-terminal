// ONE way a list of tabs looks. Rendered by the Ctrl+Tab / Cmd+P switcher and
// by the pane header's recent-tabs list — the same rows, the same colours, the
// same signals, only the container differs.
//
// Why this file exists: the recent-tabs list was written as its own, plainer
// list — a coloured dot, the tab name, the project name in grey. It answered
// the same question as the switcher and looked nothing like it, so the same
// tab read as two different things depending on which list you opened. A tab
// card carries meaning (colour = its group/kind, the strip = a live process,
// the shimmer = an answer in flight, the marker = its session status); a
// re-drawn simplified copy quietly drops most of that.
//
// The switcher's exact visual language, which this preserves:
//   • the project is a dim, small, NON-clickable header — a separator in a
//     flat recency-ordered list, not a landmark. It repeats.
//   • tabs are indented under it and carry the full chrome tint;
//   • the signals come from TabSignals, never re-drawn locally;
//   • a linked file whose target is gone renders red and dead, not clickable.
//
// The caller owns: which rows to show, what "selected" means, and what a click
// does. This file owns only how a row looks.

import React from 'react';
import { FileText } from 'lucide-react';
import {
  adjustRgbaAlpha,
  flattenRgbaOnTabbarPanel,
  getTabChromeColorConfig,
} from './tabChrome';
import { TabCmdHint, TabProcessBar, TabStatusMarker } from './TabSignals';
import { TabPaneMap } from './PaneMap';
import { paneTabs } from '../../utils/splitPanesModel.mjs';

export interface TabListTab {
  id: string;
  name: string;
  color?: string;
  tabType?: string;
  commandType?: string;
  groupId?: string;
  sessionStatus?: string;
  sdkProcessAlive?: boolean;
  cwd?: string;
  filePath?: string;
  missing?: boolean;
}

export interface TabListRowProject {
  kind: 'project';
  projectId: string;
  projectName: string;
  projectIcon?: string | null;
}
export interface TabListRowTab {
  kind: 'tab';
  projectId: string;
  projectName: string;
  tab: TabListTab;
  missing?: boolean;
}
export type TabListRow = TabListRowProject | TabListRowTab;

export interface SessionStatusLike { id: string; color?: string; label?: string }

export type TabWindowAction = 'add' | 'open' | null;

interface TabWindowStateLike {
  splitPanes: Array<{
    projectId: string;
    tabId: string;
    tabs?: Array<{ projectId: string; tabId: string }>;
  }>;
  splitFocusedIndex: number;
  activeProjectId: string | null;
  centerStrips: Record<string, Array<{ projectId: string; tabId: string }>>;
  openProjects: ReadonlyMap<string, { activeTabId: string | null }>;
}

/**
 * What Shift/plain click can do to this exact row in the focused window.
 *
 * `null` means the row is already SHOWN there, so an affordance would promise
 * a no-op. `open` means its chip is already in the target strip but another
 * chip is shown; `add` means it will be appended (or moved from another
 * window). One resolver feeds both the sidebar and the global switcher.
 */
export function resolveTabWindowAction(
  state: TabWindowStateLike,
  projectId: string,
  tabId: string,
): TabWindowAction {
  if (!projectId || !tabId) return null;

  if (state.splitPanes.length > 0) {
    const pane = state.splitPanes[state.splitFocusedIndex];
    if (!pane) return null;
    if (pane.projectId === projectId && pane.tabId === tabId) return null;
    return paneTabs(pane).some((entry: { projectId: string; tabId: string }) => (
      entry.projectId === projectId && entry.tabId === tabId
    )) ? 'open' : 'add';
  }

  const centerProjectId = state.activeProjectId;
  if (!centerProjectId) return null;
  const shownTabId = state.openProjects.get(centerProjectId)?.activeTabId || '';
  if (centerProjectId === projectId && shownTabId === tabId) return null;
  const strip = state.centerStrips[centerProjectId] || [];
  if (strip.some((entry) => entry.projectId === projectId && entry.tabId === tabId)) return 'open';
  // addTabToCenterStrip needs either a real strip or the currently shown chip
  // as its base. With neither, there is no honest target to advertise.
  return shownTabId || strip.length > 0 ? 'add' : null;
}

/** Project separator. Deliberately not clickable and deliberately quiet. */
export function TabListProjectHeader({
  projectName,
  projectIcon,
}: {
  projectName: string;
  projectIcon?: string | null;
}) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 5,
        padding: '6px 8px 2px',
        fontSize: 11,
        fontWeight: 600,
        color: '#8a8a8f',
        pointerEvents: 'none',
        userSelect: 'none',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
      }}
    >
      {projectIcon && (
        <img
          src={projectIcon}
          alt=""
          style={{ width: 12, height: 12, borderRadius: 2, objectFit: 'cover', flexShrink: 0, opacity: 0.65 }}
          draggable={false}
        />
      )}
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{projectName}</span>
    </div>
  );
}

export interface TabListTabRowProps {
  tab: TabListTab;
  /** Keyboard/hover selection ring. */
  selected?: boolean;
  /** Linked file gone from disk: red icon, dimmed, not a target. */
  missing?: boolean;
  /** A runtime is alive → static colored strip. */
  hasProcess?: boolean;
  /** An answer is streaming → shimmer over the strip. */
  busy?: boolean;
  /** Waiting for a delegated session → purple base under the same shimmer. */
  inheritedBusy?: boolean;
  sessionStatuses?: SessionStatusLike[];
  /** Marks the row for tests and for hover hit-testing by the caller. */
  index?: number;
  onPointerEnter?: () => void;
  onPointerDown?: (event: React.PointerEvent<HTMLDivElement>) => void;
  /**
   * Shown at the right, dimmed. The switcher groups by project header and
   * passes nothing; a short flat list has no headers and names the project
   * per row instead.
   */
  trailingLabel?: string | null;
  /**
   * Project of this tab. When set, the row carries the layout map ("which pane
   * is this tab open in") — the same mark as the sidebar card. Needed as a prop
   * because the map is per (project, tab) and a row alone does not know which
   * project it belongs to.
   */
  paneMapProjectId?: string | null;
  /** Shift/plain-click action in the currently focused window. */
  windowAction?: TabWindowAction;
  /**
   * "Ты здесь": the row is the tab the user is on, shown as a reference point
   * rather than as a destination (Ctrl+Tab's row 1).
   *
   * It reads as a starting point, not as a selection: a left rail plus dimmed
   * text, and no selection ring — the ring belongs to the row the keyboard is
   * on, and two rings would ask "which of these am I picking?". Colour, not
   * opacity alone: an alpha-only difference is what video codecs eat on dark
   * backgrounds (AI-Optimized UI rule).
   */
  anchor?: boolean;
}

export function TabListTabRow({
  tab,
  selected = false,
  missing = false,
  hasProcess = false,
  busy = false,
  inheritedBusy = false,
  sessionStatuses,
  index,
  onPointerEnter,
  onPointerDown,
  trailingLabel,
  paneMapProjectId,
  windowAction = null,
  anchor = false,
}: TabListTabRowProps) {
  const chrome = getTabChromeColorConfig(tab as any);
  const hasColor = !!tab.color && tab.color !== 'default';
  const rawBg = selected
    ? (hasColor || tab.tabType === 'file' ? adjustRgbaAlpha(chrome.bgColor, 0.25) : 'rgba(255,255,255,0.18)')
    : (hasColor || tab.tabType === 'file' ? chrome.bgColor : 'rgba(255,255,255,0.04)');
  const bg = flattenRgbaOnTabbarPanel(rawBg === '#181725' ? 'rgba(24,23,37,1)' : rawBg);
  const statusMeta = tab.sessionStatus && sessionStatuses
    ? sessionStatuses.find((s) => s.id === tab.sessionStatus)
    : null;

  return (
    <div
      data-tab-list-row={tab.id}
      data-switcher-index={index}
      data-tab-list-anchor={anchor ? '1' : undefined}
      data-tab-window-action={windowAction || undefined}
      onPointerEnter={onPointerEnter}
      onPointerDown={onPointerDown}
      title={anchor
        ? 'Вкладка, на которой вы сейчас — точка отсчёта'
        : (missing ? 'Файл не найден на диске (перемещён или удалён)' : tab.name)}
      style={{
        position: 'relative',
        marginLeft: 4, // tabs sit slightly inside their project header
        display: 'flex',
        alignItems: 'center',
        gap: 7,
        padding: '5px 10px',
        paddingLeft: 16, // room for the strip (3px) + the status marker
        borderRadius: 5,
        cursor: missing ? 'default' : 'pointer',
        background: bg,
        boxShadow: selected
          ? 'inset 0 0 0 1px rgba(255,255,255,0.30)'
          : (anchor ? 'inset 2px 0 0 0 #6e6e76' : 'none'),
        marginBottom: 1,
        // The modifier hint sits on the row's top seam. Text and trailing
        // labels own their clipping, so the host can stay open for that seam.
        overflow: 'visible',
        userSelect: 'none',
        opacity: missing ? 0.55 : 1,
      }}
    >
      {/* Shared tab signals — same component as the sidebar card and the pane
          header, so a strip here can never mean something else. */}
      <TabProcessBar
        hasProcess={hasProcess}
        busy={busy}
        inheritedBusy={inheritedBusy}
        radius={5}
        zIndex={1}
      />
      <TabStatusMarker color={statusMeta?.color} title={statusMeta?.label} left={6} />
      <TabCmdHint
        text={windowAction === 'open' ? 'открыть в этом окне' : 'добавить в это окно'}
        visible={windowAction !== null}
      />

      {tab.tabType === 'file' && (
        // Red icon = the linked file is gone from disk.
        <FileText size={12} style={{ color: missing ? '#f87171' : '#a78bfa', flexShrink: 0, opacity: 0.9 }} />
      )}

      <span
        style={{
          color: missing ? '#9a9a9e' : (anchor ? '#9a9a9f' : '#e6e6e6'),
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          flex: 1,
          minWidth: 0,
        }}
      >
        {tab.name}
      </span>

      {trailingLabel && (
        <span
          style={{
            flexShrink: 0,
            fontSize: 10,
            color: '#77777c',
            maxWidth: 92,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {trailingLabel}
        </span>
      )}

      {/* "Where is this tab open" — the same mark the sidebar card carries, from
          the same component. It belongs here most of all: in these lists you are
          choosing among tabs, some of which are already on screen, so "this one
          is the side pane's tab" is exactly what you need before committing.
          Rightmost, after the project label, so the row still reads name-first. */}
      {paneMapProjectId && <TabPaneMap projectId={paneMapProjectId} tabId={tab.id} />}
    </div>
  );
}
