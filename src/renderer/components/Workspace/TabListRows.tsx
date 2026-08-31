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
//   • workflow is a small NON-clickable header with its bright icon — a
//     separator in a flat recency-ordered list, not a destination. It repeats;
//   • tabs are indented under it, carry the full chrome tint and keep their
//     directory-project as a quiet grayscale label on the right;
//   • the signals come from TabSignals, never re-drawn locally;
//   • a linked file whose target is gone renders red and dead, not clickable.
//
// The caller owns: which rows to show, what "selected" means, and what a click
// does. This file owns only how a row looks.

import React from 'react';
import { FileText, Folder } from 'lucide-react';
import {
  adjustRgbaAlpha,
  flattenRgbaOnTabbarPanel,
  getTabChromeColorConfig,
} from './tabChrome';
import {
  TabProcessBar,
  TabSessionAvailabilityMarker,
  TabStatusMarker,
} from './TabSignals';
import {
  resolveTabSessionDescriptor,
  useSessionAvailability,
} from '../../utils/sessionAvailabilityTracker';
import {
  sessionAvailabilityBackgroundImage,
  sessionAvailabilityRailShadow,
} from '../../utils/sessionAvailabilityVisual.mjs';
import { TabPaneMap } from './PaneMap';
import {
  workflowFallbackColor,
  workflowInitial,
} from '../../utils/workflowVisuals.mjs';

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
  claudeSessionId?: string;
  codexSessionId?: string;
  geminiSessionId?: string;
}

export interface TabListRowWorkflow {
  kind: 'workflow';
  workflowId: string;
  workflowName: string;
  workflowIcon?: string | null;
  unplaced?: boolean;
}
export interface TabListRowTab {
  kind: 'tab';
  projectId: string;
  projectName: string;
  projectIcon?: string | null;
  workflowId: string;
  tab: TabListTab;
  missing?: boolean;
}
export type TabListRow = TabListRowWorkflow | TabListRowTab;

export interface SessionStatusLike { id: string; color?: string; label?: string }

/** Workflow separator: bright identity, but still not a clickable row. */
export function TabListWorkflowHeader({
  workflowId,
  workflowName,
  workflowIcon,
  unplaced = false,
}: {
  workflowId: string;
  workflowName: string;
  workflowIcon?: string | null;
  unplaced?: boolean;
}) {
  return (
    <div
      data-tab-list-workflow={workflowId}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: '6px 8px 2px',
        fontSize: 11,
        fontWeight: 600,
        color: unplaced ? '#77777d' : '#aaaab0',
        pointerEvents: 'none',
        userSelect: 'none',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
      }}
    >
      {workflowIcon ? (
        <img
          data-workflow-icon={workflowId}
          src={workflowIcon}
          alt=""
          style={{ width: 14, height: 14, borderRadius: 3, objectFit: 'cover', flexShrink: 0 }}
          draggable={false}
        />
      ) : (
        <span
          aria-hidden
          style={{
            width: 14,
            height: 14,
            borderRadius: 3,
            flexShrink: 0,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            border: unplaced ? '1px dashed rgba(148,163,184,0.72)' : 'none',
            background: unplaced ? 'rgba(148,163,184,0.08)' : workflowFallbackColor(workflowId),
            color: '#fff',
            fontSize: 8,
            fontWeight: 800,
          }}
        >
          {unplaced ? '' : workflowInitial(workflowName)}
        </span>
      )}
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{workflowName}</span>
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
  /** Directory-project stays secondary to the workflow group. */
  projectName?: string | null;
  projectIcon?: string | null;
  /**
   * Project of this tab. When set, the row carries the layout map ("which pane
   * is this tab open in") — the same mark as the sidebar card. Needed as a prop
   * because the map is per (project, tab) and a row alone does not know which
   * project it belongs to.
   */
  paneMapProjectId?: string | null;
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
  projectName,
  projectIcon,
  paneMapProjectId,
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
  const sessionAvailability = useSessionAvailability(resolveTabSessionDescriptor(tab, tab.id));
  const rowBoxShadow = [
    selected
      ? 'inset 0 0 0 1px rgba(255,255,255,0.30)'
      : (anchor ? 'inset 2px 0 0 0 #6e6e76' : null),
    sessionAvailabilityRailShadow(sessionAvailability),
  ].filter(Boolean).join(', ') || undefined;

  return (
    <div
      data-tab-list-row={tab.id}
      data-switcher-index={index}
      data-tab-list-anchor={anchor ? '1' : undefined}
      data-tab-session-availability={sessionAvailability.state === 'none' ? undefined : sessionAvailability.state}
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
        backgroundImage: sessionAvailabilityBackgroundImage(sessionAvailability),
        boxShadow: rowBoxShadow,
        marginBottom: 1,
        // Signals and the pane map may touch the row edge; text/trailing labels
        // own their own clipping, so the host itself stays open.
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

      <TabSessionAvailabilityMarker availability={sessionAvailability} size={10} />

      {(projectName || trailingLabel) && (
        <span
          style={{
            flexShrink: 0,
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            fontSize: 9.5,
            color: '#77777c',
            maxWidth: 92,
          }}
        >
          {projectIcon ? (
            <img
              data-project-icon="true"
              src={projectIcon}
              alt=""
              draggable={false}
              style={{ width: 11, height: 11, borderRadius: 2, objectFit: 'cover', flexShrink: 0, opacity: 0.72 }}
            />
          ) : projectName ? (
            <Folder size={10} strokeWidth={1.8} style={{ flexShrink: 0, opacity: 0.65 }} />
          ) : null}
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {projectName || trailingLabel}
          </span>
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
