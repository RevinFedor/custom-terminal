import React, { useState, useRef, useEffect, useLayoutEffect, memo, useCallback, useMemo } from 'react';
import { useWorkspaceStore, TabColor, TabGroup, isTabInterrupted } from '../../store/useWorkspaceStore';
import { useProjectsStore } from '../../store/useProjectsStore';
import Tooltip from '../UI/Tooltip';
import { useUIStore } from '../../store/useUIStore';
import { useCmdKey, useCmdHoverPopover } from '../../hooks/useCmdHoverPopover';
import TabPreviewPopover from './TabPreviewPopover';
import { refreshGeneratedTabTitle, type RefreshTabTitleReason } from '../../utils/generateTabTitle';
import '@gt-editor/markdown-editor/styles.css';
// Removed: framer-motion import - was causing lag on project switch
import { draggable, dropTargetForElements, monitorForElements } from '@atlaskit/pragmatic-drag-and-drop/element/adapter';
import { attachClosestEdge, extractClosestEdge, type Edge } from '@atlaskit/pragmatic-drag-and-drop-hitbox/closest-edge';
import {
  attachInstruction as attachListInstruction,
  extractInstruction as extractListInstruction,
  type Availability as ListInstructionAvailability,
  type Instruction as ListInstruction,
} from '@atlaskit/pragmatic-drag-and-drop-hitbox/list-item';
import { combine } from '@atlaskit/pragmatic-drag-and-drop/combine';
import { autoScrollForElements } from '@atlaskit/pragmatic-drag-and-drop-auto-scroll/element';
import { setCustomNativeDragPreview } from '@atlaskit/pragmatic-drag-and-drop/element/set-custom-native-drag-preview';
import { ChevronDown, Globe, Bot, Play, PanelLeft, Plus, StickyNote, RotateCw, Folder, ArrowUp, ArrowDown, Square, Bell, BellRing, FileText, X } from 'lucide-react';

const { ipcRenderer } = window.require('electron');

const CLAUDE_SPINNER_VISUAL_IDLE_GRACE_MS = 300;
const COMPLETION_NOTIFICATION_DISMISS_MS = 420;
const TABBAR_DRAG_VISUAL_LOCK_ATTR = 'data-tabbar-drag-visual-lock';
const GROUP_COLLAPSE_FLIP_SUPPRESS_MS = 320;
const isNaturalRestartAfterEnd = (reason?: string) => !reason || reason === 'task_complete';

let forcedDragCursorDepth = 0;
let forcedDragCursorStyleEl: HTMLStyleElement | null = null;

const isTabbarDragVisualLockActive = () =>
  typeof document !== 'undefined' && document.documentElement.hasAttribute(TABBAR_DRAG_VISUAL_LOCK_ATTR);

const acquireForcedDragCursor = () => {
  if (typeof document === 'undefined') return;
  const wasInactive = forcedDragCursorDepth === 0;
  forcedDragCursorDepth += 1;
  document.documentElement.setAttribute(TABBAR_DRAG_VISUAL_LOCK_ATTR, 'true');
  if (wasInactive) {
    console.log(`[TabDnd:bg-lock] active=1 depth=${forcedDragCursorDepth} t=${Math.round(performance.now())}`);
  }
  if (forcedDragCursorStyleEl) return;
  forcedDragCursorStyleEl = document.createElement('style');
  forcedDragCursorStyleEl.setAttribute('data-tabbar-forced-drag-cursor', 'true');
  forcedDragCursorStyleEl.textContent = `
    html, html *, body, body * {
      cursor: grabbing !important;
    }
    html[${TABBAR_DRAG_VISUAL_LOCK_ATTR}="true"] [data-tab-item],
    html[${TABBAR_DRAG_VISUAL_LOCK_ATTR}="true"] [data-tab-group-header] {
      transition-property: transform, box-shadow, border-color !important;
    }
  `;
  document.head.appendChild(forcedDragCursorStyleEl);
};

const releaseForcedDragCursor = () => {
  if (typeof document === 'undefined') return;
  forcedDragCursorDepth = Math.max(0, forcedDragCursorDepth - 1);
  if (forcedDragCursorDepth > 0) return;
  document.documentElement.removeAttribute(TABBAR_DRAG_VISUAL_LOCK_ATTR);
  console.log(`[TabDnd:bg-lock] active=0 depth=${forcedDragCursorDepth} t=${Math.round(performance.now())}`);
  forcedDragCursorStyleEl?.remove();
  forcedDragCursorStyleEl = null;
};

// VERTICAL MODE (TabSidebar) — геометрия в Settings → Размеры → ТАБЫ → Терминал.
// Подписка: useUIStore.tabGeometry { paddingX, paddingY, paddingLeft, borderRadius, gap }.

// OSC 133 event-driven process status (no more polling!)

interface TabBarProps {
  projectId: string;
  /**
   * 'horizontal' — legacy single-row bar above terminal. Main-zone scrolls horizontally,
   *   utility zone is a dropdown.
   * 'vertical' — left sidebar mode. Main-zone scrolls vertically, utility zone is rendered
   *   inline below main with a divider. Tab rows span full width.
   */
  layout?: 'horizontal' | 'vertical';
}

interface TabData {
  id: string;
  name: string;
  color?: TabColor;
  isUtility?: boolean;
  commandType?: string;
  wasInterrupted?: boolean;
  claudeSessionId?: string;
  geminiSessionId?: string;
  codexSessionId?: string;
  tabType?: string;
  filePath?: string;
  notes?: string;
  aiClosing?: boolean;
  isCollapsed?: boolean;
  groupId?: string;
  visualParentTabId?: string;
  parentTabId?: string;
  sessionStatus?: string;
  completionNotificationPersistent?: boolean;
  completionNotificationArmed?: boolean;
  completionNotificationFired?: boolean;
  restartAfterTabId?: string;
  restartAfterPersistent?: boolean;
  restartAfterArmed?: boolean;
}

type TabDragData = {
  type: 'TAB';
  id: string;
  zone: 'main' | 'utility';
  index: number;
  projectId?: string; // For cross-project drag
  selectedTabIds?: string[]; // For multi-tab drag
  groupId?: string;
  groupIndex?: number;
};

type GroupDragData = {
  type: 'TAB_GROUP';
  groupId: string;
  zone: 'main';
  projectId: string;
};

type DragData = TabDragData | GroupDragData;

type DragPreviewLayout = {
  orderedIds: string[];
  groupAssignments: Record<string, string | null | undefined>;
  visualParentAssignments?: Record<string, string | null | undefined>;
  groupAnchorAssignments?: Record<string, string | null | undefined>;
};

type VerticalRow =
  | { type: 'tab'; tab: TabData; index: number }
  | { type: 'group'; group: TabGroup; tabs: TabData[]; index: number };

type RectSnap = { left: number; right: number; top: number; bottom: number; height: number; midY: number };
type VerticalDragTabRow = { type: 'tab'; tabId: string; rect: RectSnap };
type VerticalDragGroupRow = {
  type: 'group';
  groupId: string;
  rect: RectSnap;
  header: RectSnap;
  collapsed: boolean;
  memberIds: string[];
  tabRows: { tabId: string; rect: RectSnap }[];
};
type VerticalDragGeometry = {
  id: number;
  reason: string;
  capturedAtMs: number;
  list: RectSnap;
  rows: Array<VerticalDragTabRow | VerticalDragGroupRow>;
};
type VerticalDragAnchor = {
  offsetY: number;
  startY: number;
  sourceTop: number;
  sourceBottom: number;
  sourceMidY: number;
};
type VerticalRowFlipRect = {
  top: number;
  left: number;
  width: number;
  height: number;
};

const measureVerticalRowFlipRect = (row: HTMLElement, root: HTMLElement): VerticalRowFlipRect => {
  let top = 0;
  let left = 0;
  let current: HTMLElement | null = row;
  const seen = new Set<HTMLElement>();

  while (current && current !== root && root.contains(current) && !seen.has(current)) {
    seen.add(current);
    top += current.offsetTop;
    left += current.offsetLeft;
    current = current.offsetParent as HTMLElement | null;
  }

  if (current === root) {
    return {
      top,
      left,
      width: row.offsetWidth,
      height: row.offsetHeight,
    };
  }

  const rowRect = row.getBoundingClientRect();
  const rootRect = root.getBoundingClientRect();
  return {
    top: rowRect.top - rootRect.top + root.scrollTop,
    left: rowRect.left - rootRect.left + root.scrollLeft,
    width: row.offsetWidth,
    height: row.offsetHeight,
  };
};

const snapRect = (el: Element): RectSnap => {
  const r = el.getBoundingClientRect();
  return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, height: r.height, midY: r.top + r.height / 2 };
};

const shortDndId = (id?: string | null) => {
  if (!id) return '-';
  return id.length > 12 ? id.slice(-12) : id;
};

const shortVerticalRowKey = (key?: string | null) => {
  if (!key) return '-';
  const [kind, id] = key.split(':');
  if (!id) return shortDndId(key);
  return `${kind}:${shortDndId(id)}`;
};

const describePaintNode = (element: HTMLElement | null) => {
  if (!element) return 'none';
  const styles = window.getComputedStyle(element);
  const before = window.getComputedStyle(element, '::before');
  const after = window.getComputedStyle(element, '::after');
  return JSON.stringify({
    tag: element.tagName.toLowerCase(),
    rowType: element.dataset.rowType || undefined,
    tab: shortDndId(element.dataset.tabId),
    group: shortDndId(element.dataset.groupId),
    bg: styles.backgroundColor,
    opacity: styles.opacity,
    transform: styles.transform,
    willChange: styles.willChange,
    filter: styles.filter,
    boxShadow: styles.boxShadow,
    transitionProperty: styles.transitionProperty,
    transitionDuration: styles.transitionDuration,
    beforeBg: before.backgroundColor,
    afterBg: after.backgroundColor,
  });
};

const describeCollapseNode = (element: HTMLElement | null, root?: HTMLElement | null) => {
  if (!element) return 'none';
  const rect = element.getBoundingClientRect();
  const rootRect = root?.getBoundingClientRect();
  const styles = window.getComputedStyle(element);
  return JSON.stringify({
    tag: element.tagName.toLowerCase(),
    rowType: element.dataset.rowType || undefined,
    tab: shortDndId(element.dataset.tabId),
    group: shortDndId(element.dataset.groupId),
    collapsed: element.dataset.groupCollapsed,
    top: Math.round(rect.top),
    relTop: rootRect ? Math.round(rect.top - rootRect.top + (root?.scrollTop || 0)) : undefined,
    height: Math.round(rect.height),
    offsetHeight: element.offsetHeight,
    scrollHeight: element.scrollHeight,
    display: styles.display,
    gridTemplateRows: styles.gridTemplateRows,
    opacity: styles.opacity,
    transform: styles.transform,
    overflow: styles.overflow,
    gap: styles.gap,
    transitionProperty: styles.transitionProperty,
    transitionDuration: styles.transitionDuration,
  });
};

const fmtDndY = (rect: RectSnap) =>
  `${Math.round(rect.top)}/${Math.round(rect.midY)}/${Math.round(rect.bottom)}`;

type ListInstructionOperations = Partial<Record<ListInstruction['operation'], ListInstructionAvailability>>;

const REORDER_ONLY_OPERATIONS: ListInstructionOperations = {
  'reorder-before': 'available',
  'reorder-after': 'available',
};

const GROUP_CONTAINER_OPERATIONS: ListInstructionOperations = {
  'reorder-before': 'available',
  combine: 'available',
};

const summarizeListInstruction = (instruction: ListInstruction | null) => {
  if (!instruction) return '-';
  return `${instruction.operation}${instruction.blocked ? ':blocked' : ''}/${instruction.axis}`;
};

const listInstructionToEdge = (instruction: ListInstruction | null): Edge | null => {
  if (!instruction || instruction.operation === 'combine') return null;
  if (instruction.axis === 'horizontal') {
    return instruction.operation === 'reorder-before' ? 'left' : 'right';
  }
  return instruction.operation === 'reorder-before' ? 'top' : 'bottom';
};

const extractDropIndicatorEdge = (data?: Record<string | symbol, unknown> | null): Edge | null => {
  if (!data) return null;
  return listInstructionToEdge(extractListInstruction(data)) || extractClosestEdge(data);
};

const getStaticListInstruction = (
  rect: RectSnap,
  clientX: number,
  clientY: number,
  operations: ListInstructionOperations,
  axis: 'vertical' | 'horizontal' = 'vertical'
): ListInstruction | null => {
  const point = axis === 'vertical' ? clientY : clientX;
  const start = axis === 'vertical' ? rect.top : rect.left;
  const end = axis === 'vertical' ? rect.bottom : rect.right;
  const size = axis === 'vertical' ? rect.height : rect.right - rect.left;
  const possible = (availability: ListInstructionAvailability | undefined) =>
    availability === 'available' || availability === 'blocked';
  const combine = operations.combine || 'not-available';
  const before = operations['reorder-before'] || 'not-available';
  const after = operations['reorder-after'] || 'not-available';
  let operation: ListInstruction['operation'] | null = null;

  if (!possible(combine)) {
    if (possible(before) && possible(after)) {
      operation = point < start + size / 2 ? 'reorder-before' : 'reorder-after';
    } else if (possible(before)) {
      operation = 'reorder-before';
    } else if (possible(after)) {
      operation = 'reorder-after';
    }
  } else {
    const quarter = size / 4;
    if (point <= start + quarter) {
      operation = possible(before) ? 'reorder-before' : 'combine';
    } else if (point >= end - quarter) {
      operation = possible(after) ? 'reorder-after' : 'combine';
    } else {
      operation = 'combine';
    }
  }

  if (!operation) return null;
  return {
    operation,
    blocked: operations[operation] === 'blocked',
    axis,
  };
};

const verticalRowDebugKey = (row: VerticalDragGeometry['rows'][number]) => {
  if (row.type === 'tab') return `tab:${shortDndId(row.tabId)}@${fmtDndY(row.rect)}`;
  return `group:${shortDndId(row.groupId)}(v=${row.tabRows.length},m=${row.memberIds.length},c=${row.collapsed ? 1 : 0})@h${fmtDndY(row.header)}r${fmtDndY(row.rect)}`;
};

const summarizeVerticalGeometry = (geometry: VerticalDragGeometry | null) => {
  if (!geometry) return 'none';
  const keys = geometry.rows.map(verticalRowDebugKey);
  return `gid=${geometry.id} reason=${geometry.reason} rows=${geometry.rows.length} keys=${keys.join('>')} list=${Math.round(geometry.list.top)}..${Math.round(geometry.list.bottom)}`;
};

const summarizeVerticalAnchor = (anchor: VerticalDragAnchor | null) => {
  if (!anchor) return 'none';
  return `startY=${Math.round(anchor.startY)} source=${Math.round(anchor.sourceTop)}..${Math.round(anchor.sourceBottom)}` +
    ` mid=${Math.round(anchor.sourceMidY)} offset=${Math.round(anchor.offsetY)}`;
};

const summarizeDropTargetData = (data?: Record<string | symbol, unknown> | null) => {
  if (!data) return 'none';
  const type = data.type;
  const instruction = summarizeListInstruction(extractListInstruction(data));
  if (type === 'TAB') {
    return `TAB:${shortDndId(data.id as string | undefined)} edge=${extractClosestEdge(data) || '-'} instr=${instruction}`;
  }
  if (type === 'GROUP') {
    return `GROUP:${shortDndId(data.groupId as string | undefined)} edge=${extractClosestEdge(data) || '-'} instr=${instruction}`;
  }
  if (type === 'TAB_GROUP') {
    return `TAB_GROUP:${shortDndId(data.groupId as string | undefined)}`;
  }
  return String(type || 'unknown');
};

const summarizePreviewLayout = (preview: DragPreviewLayout | null) => {
  if (!preview) return 'none';
  const groups = Object.entries(preview.groupAssignments)
    .map(([id, groupId]) => `${shortDndId(id)}=${shortDndId(groupId || null)}`)
    .join(',');
  const visual = Object.entries(preview.visualParentAssignments || {})
    .map(([id, parentId]) => `${shortDndId(id)}=${shortDndId(parentId || null)}`)
    .join(',');
  const anchors = Object.entries(preview.groupAnchorAssignments || {})
    .map(([id, anchorId]) => `${shortDndId(id)}=${shortDndId(anchorId || null)}`)
    .join(',');
  return [
    `order=${preview.orderedIds.map(shortDndId).join('>')}`,
    `groups=${groups || '-'}`,
    `visual=${visual || '-'}`,
    `anchors=${anchors || '-'}`,
  ].join(' ');
};

const summarizeResolveTrace = (trace: string | null | undefined) => trace || 'resolve=none';

const findVerticalDragSourceRect = (sourceData: DragData, geometry: VerticalDragGeometry | null): RectSnap | null => {
  if (!geometry) return null;
  for (const row of geometry.rows) {
    if (sourceData.type === 'TAB') {
      if (row.type === 'tab' && row.tabId === sourceData.id) return row.rect;
      if (row.type === 'group') {
        const tabRow = row.tabRows.find((candidate) => candidate.tabId === sourceData.id);
        if (tabRow) return tabRow.rect;
      }
    } else if (row.type === 'group' && row.groupId === sourceData.groupId) {
      return row.header;
    }
  }
  return null;
};

// Status palette теперь динамическая: SessionStatusDef из useUIStore.
// Tab.sessionStatus хранит id; render lookup через store.sessionStatuses.find().
// Если id больше нет в сторе (юзер удалил статус) — маркер просто не рендерится,
// данные в Tab.sessionStatus остаются (если статус вернут — маркер появится снова).
type SessionStatus = string;

const TAB_COLORS: { color: TabColor; bgColor: string; borderColor: string; label: string }[] = [
  { color: 'default', bgColor: 'transparent', borderColor: '#666', label: '⚪ Default' },
  { color: 'red', bgColor: 'rgba(239, 68, 68, 0.2)', borderColor: 'rgb(239, 68, 68)', label: '🔴 Red' },
  { color: 'yellow', bgColor: 'rgba(234, 179, 8, 0.2)', borderColor: 'rgb(234, 179, 8)', label: '🟡 Yellow' },
  { color: 'green', bgColor: 'rgba(34, 197, 94, 0.2)', borderColor: 'rgb(34, 197, 94)', label: '🟢 Green' },
  { color: 'blue', bgColor: 'rgba(59, 130, 246, 0.2)', borderColor: 'rgb(59, 130, 246)', label: '🔵 Blue' },
  { color: 'purple', bgColor: 'rgba(168, 85, 247, 0.2)', borderColor: 'rgb(168, 85, 247)', label: '🟣 Purple' },
  { color: 'claude', bgColor: 'rgba(218, 119, 86, 0.2)', borderColor: '#DA7756', label: '🟠 Claude' },
  { color: 'gemini', bgColor: 'rgba(78, 134, 248, 0.2)', borderColor: '#4E86F8', label: '💎 Gemini' },
  { color: 'codex', bgColor: 'rgba(16, 163, 127, 0.18)', borderColor: '#10A37F', label: 'Codex' },
];

const adjustRgbaAlpha = (rgba: string, delta: number): string => {
  const m = rgba.match(/rgba?\((\d+),\s*(\d+),\s*(\d+),?\s*([\d.]+)?\)/);
  if (!m) return rgba;
  const [, r, g, b, a = '0.2'] = m;
  const newAlpha = Math.max(0, Math.min(1, parseFloat(a) + delta));
  return `rgba(${r}, ${g}, ${b}, ${newAlpha})`;
};

const TABBAR_PANEL_RGB = { r: 37, g: 37, b: 38 };
const TABBAR_PANEL_BG = `rgb(${TABBAR_PANEL_RGB.r}, ${TABBAR_PANEL_RGB.g}, ${TABBAR_PANEL_RGB.b})`;

const flattenRgbaOnTabbarPanel = (color: string): string => {
  if (color === 'transparent') return TABBAR_PANEL_BG;
  const m = color.match(/rgba?\(\s*(\d+),\s*(\d+),\s*(\d+)(?:,?\s*([\d.]+))?\s*\)/);
  if (!m) return color;
  const [, rText, gText, bText, aText] = m;
  const alpha = aText === undefined ? 1 : Math.max(0, Math.min(1, parseFloat(aText)));
  const r = Number(rText);
  const g = Number(gText);
  const b = Number(bText);
  if (alpha >= 1) return `rgb(${r}, ${g}, ${b})`;
  const blend = (fg: number, bg: number) => Math.round((fg * alpha) + (bg * (1 - alpha)));
  return `rgb(${blend(r, TABBAR_PANEL_RGB.r)}, ${blend(g, TABBAR_PANEL_RGB.g)}, ${blend(b, TABBAR_PANEL_RGB.b)})`;
};

const getTabChromeColorConfig = (tab: Pick<TabData, 'color' | 'tabType'>) => {
  const base = TAB_COLORS.find(c => c.color === tab.color) || TAB_COLORS[0];
  return tab.tabType === 'claude-sdk' && tab.color === 'claude'
    ? { ...base, bgColor: 'rgba(210, 140, 90, 0.30)', borderColor: '#D28C5A' }
    : tab.tabType === 'file'
      ? { ...base, bgColor: '#181725', borderColor: '#8b5cf6' }
    : base;
};

const getVisualConnectorColor = (tab: TabData, isActive: boolean) => {
  const config = getTabChromeColorConfig(tab);
  const hasColor = tab.color && tab.color !== 'default';
  if (hasColor) {
    return adjustRgbaAlpha(config.bgColor, isActive ? 0.28 : 0.22);
  }
  return isActive ? 'rgba(255,255,255,0.24)' : 'rgba(255,255,255,0.14)';
};

const AI_COMMAND_TYPES = new Set(['claude', 'gemini', 'codex']);

const isAiRuntimeTab = (tab?: { commandType?: string; tabType?: string } | null): boolean => {
  return !!tab && (tab.tabType === 'claude-sdk' || AI_COMMAND_TYPES.has(tab.commandType || ''));
};

const isAiForegroundProcess = (info?: { hasProcess?: boolean; processName?: string; command?: string } | null): boolean => {
  if (!info?.hasProcess) return false;
  const text = `${info.processName || ''} ${info.command || ''}`.toLowerCase();
  return /\b(claude|gemini|codex)\b/.test(text) || text.includes('@openai/codex');
};


// Drop Indicator Line - absolute overlay (doesn't affect layout)
interface IndicatorProps {
  edge: 'left' | 'right' | 'top' | 'bottom';
}

const DropIndicatorLine = memo(({ edge }: IndicatorProps) => {
  const isVertical = edge === 'left' || edge === 'right';

  if (isVertical) {
    const positionClass = edge === 'left'
      ? 'left-0 -translate-x-1/2'
      : 'right-0 translate-x-1/2';

    return (
      <div
        className={`absolute top-0 bottom-0 bg-white pointer-events-none ${positionClass}`}
        style={{ zIndex: 99999, width: '2px' }}
      />
    );
  }

  const positionClass = edge === 'top'
    ? 'top-0 -translate-y-1/2'
    : 'bottom-0 translate-y-1/2';

  return (
    <div
      className={`absolute left-0 right-0 bg-white pointer-events-none ${positionClass}`}
      style={{ zIndex: 99999, height: '2px' }}
    />
  );
});

// Restart zone - left part of tab, shows restart button on hover when process is running
// Only shows restart for devServer commands (npm/yarn/etc), not for claude/gemini
const RestartZone = memo(({ hasProcess, hasColor, commandType, hasSession, isBusy, isStopping, onRestart, onStop }: {
  hasProcess: boolean;
  hasColor: boolean;
  commandType?: string;
  hasSession?: boolean;
  isBusy?: boolean;
  // Deterministic stop/restart is mid-cycle for this tab. While true: clicks are
  // ignored (cursor stays as wait), and the ↻ icon rotates to signal that the
  // system is busy killing descendants and waiting for ports to release.
  // Cleared by terminal:stop-progress { phase: 'done' } in the parent.
  isStopping?: boolean;
  onRestart: () => void;
  onStop: () => void;
}) => {
  const [isHovered, setIsHovered] = useState(false);

  // Only show restart button for devServer commands
  const showRestart = hasProcess && commandType === 'devServer';

  return (
    <div
      style={{
        position: 'absolute',
        left: 0,
        top: 0,
        bottom: 0,
        width: '32px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 10,
        cursor: isStopping ? 'wait' : undefined,
      }}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      onClick={(e) => {
        if (showRestart && !isStopping) {
          e.stopPropagation();
          onRestart();
        }
      }}
      onAuxClick={(e) => {
        if (e.button === 1 && showRestart && !isStopping) {
          e.preventDefault();
          e.stopPropagation();
          onStop();
        }
      }}
    >
      {hasProcess ? (
        isStopping && showRestart ? (
          // Deterministic-stop in flight: spinning ↻ icon, cursor:wait. The
          // animation runs whether or not the mouse is over the zone, so the
          // user sees that a stop is actually happening even after moving away.
          <Tooltip content="Stopping…">
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: '24px',
              height: '24px',
              borderRadius: '4px',
              backgroundColor: 'rgba(255,255,255,0.06)',
              color: '#999',
              fontSize: '14px',
              animation: 'tab-dot-spin 0.8s linear infinite',
            }}
          >
            ↻
          </div>
          </Tooltip>
        ) : isHovered && showRestart ? (
          // Restart button when hovered (only for devServer)
          <Tooltip content="Restart (kill descendants + ports, then re-run)">
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: '24px',
              height: '24px',
              borderRadius: '4px',
              backgroundColor: 'rgba(255,255,255,0.1)',
              color: '#fff',
              cursor: 'pointer',
              fontSize: '14px',
              transition: 'all 0.15s',
            }}
          >
            ↻
          </div>
          </Tooltip>
        ) : (
          // Green dot (process running) or red dot (claude without saved session)
          // Claude/Gemini tabs show spinning arc when busy
          ((commandType === 'claude' || commandType === 'gemini' || commandType === 'codex') && isBusy) ? (
            <span
              style={{
                display: 'block',
                width: '8px',
                height: '8px',
                borderRadius: '50%',
                border: '1.5px solid rgba(74, 222, 128, 0.2)',
                borderTopColor: '#4ade80',
                boxSizing: 'border-box',
                animation: 'tab-dot-spin 0.8s linear infinite',
              }}
            />
          ) : (
            <span
              style={{
                display: 'block',
                width: '6px',
                height: '6px',
                borderRadius: '50%',
                backgroundColor: ((commandType === 'claude' || commandType === 'codex') && !hasSession) ? '#f87171' : '#4ade80',
                opacity: hasColor ? 0.9 : 0.8,
                boxShadow: ((commandType === 'claude' || commandType === 'codex') && !hasSession)
                  ? '0 0 4px rgba(248, 113, 113, 0.5)'
                  : '0 0 4px rgba(74, 222, 128, 0.5)',
              }}
            />
          )
        )
      ) : null}
    </div>
  );
});

// Draggable Tab Item
interface TabItemProps {
  tab: TabData;
  index: number;
  groupId?: string;
  groupIndex?: number;
  zone: 'main' | 'utility';
  projectId: string; // For cross-project drag
  isActive: boolean;
  isSelected: boolean; // Added for multi-select
  isEditing: boolean;
  editValue: string;
  onSwitch: (e: React.MouseEvent) => void; // Pass event for modifier checks
  onClose: (e: React.MouseEvent) => void;
  onDoubleClick: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
  onEditChange: (value: string) => void;
  onEditSubmit: () => void;
  onEditKeyDown: (e: React.KeyboardEvent) => void;
  inputRef: React.RefObject<HTMLInputElement>;
  forceRightIndicator?: boolean; // Show right indicator when empty zone is hovered
  suppressDropIndicator?: boolean;
  fontSize: number;
  hasProcess?: boolean; // Whether tab has a running process
  commandType?: string; // Type of command running (devServer, claude, gemini, generic)
  onRestart?: (tabId: string) => void; // Restart process (deterministic stop + !!)
  onStop?: (tabId: string) => void; // Stop process (deterministic stop only)
  isStopping?: boolean; // Deterministic-stop is mid-cycle; lock the click + spin icon
  isInterrupted?: boolean; // Tab has an interrupted AI session
  draggingGroupIds?: string[]; // IDs of tabs being dragged as a group
  isAnyDragging?: boolean;
  onHoverChange?: (hovering: boolean, rect?: DOMRect) => void; // CMD+hover notes preview
  showNotesPeek?: boolean; // CMD held + cursor in TabBar + tab has notes → show the notes
                            // button as a CLICKABLE peek affordance (not just visual indicator).
                            // Replaces the old orange dot.
  slideoutOpenHere?: boolean; // The notes slideout is currently anchored to THIS tab. Forces
                              //  the button visible (solid-indigo), independent of active/peek.
  anySlideoutOpen?: boolean; // Slideout is open on SOME tab (possibly another one). When true,
                             // the default-on-active rule is suppressed — the button only shows
                             // on the tab where slideout is actually anchored.
  cmdPeekMode?: boolean; // CMD held AND cursor in TabBar. Suppresses default-on-active so an
                         // active tab WITHOUT notes doesn't keep showing the button — peek-mode
                         // is "buttons only where there are notes".
  isCollapsed?: boolean; // Collapsed tab — icon-only
  hasSession?: boolean; // Whether tab has an active AI session
  isBusy?: boolean; // AI agent is actively thinking/streaming
  isTitleNaming?: boolean; // Gemini is generating/applying this tab's title
  isAwaitingInput?: boolean; // Claude blocked on AskUserQuestion, waiting for human answer
  sdkProcessAlive?: boolean; // SDK tab: the CLI process is alive (parked between
                             // turns or generating). SDK has no PTY → hasProcess
                             // is always false; this feeds the activity-plate so
                             // the bar stays lit while the process lives, matching
                             // the control-bar process indicator (single signal).
  isViewingSubAgent?: boolean; // User is viewing a sub-agent of this tab
  orientation?: 'horizontal' | 'vertical'; // Layout direction. Main-zone defaults to horizontal,
                                            // utility-zone (dropdown) defaults to vertical. TabSidebar
                                            // overrides main-zone to vertical.
  sessionStatus?: SessionStatus; // Status marker color (vertical mode only).
  completionNotificationArmed?: boolean;
  completionNotificationFired?: boolean;
  completionNotificationPersistent?: boolean;
}

const TabItem = memo(({
  tab,
  index,
  groupId,
  groupIndex,
  zone,
  projectId,
  isActive,
  isSelected,
  isEditing,
  editValue,
  onSwitch,
  onClose,
  onDoubleClick,
  onContextMenu,
  onEditChange,
  onEditSubmit,
  onEditKeyDown,
  inputRef,
  forceRightIndicator = false,
  suppressDropIndicator = false,
  fontSize,
  hasProcess = false,
  commandType,
  onRestart,
  onStop,
  isStopping = false,
  isInterrupted = false,
  draggingGroupIds = [],
  isAnyDragging = false,
  onHoverChange,
  showNotesPeek = false,
  slideoutOpenHere = false,
  anySlideoutOpen = false,
  cmdPeekMode = false,
  isCollapsed = false,
  hasSession = false,
  isBusy = false,
  isTitleNaming = false,
  isAwaitingInput = false,
  sdkProcessAlive = false,
  isViewingSubAgent = false,
  orientation,
  sessionStatus,
  completionNotificationArmed = false,
  completionNotificationFired = false,
}: TabItemProps) => {
  const ref = useRef<HTMLDivElement>(null);
  const [closestEdge, setClosestEdge] = useState<Edge | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [isPressing, setIsPressing] = useState(false);
  const [isAdoptTarget, setIsAdoptTarget] = useState(false);
  const [isHovered, setIsHovered] = useState(false);
  const [isRestartButtonHovered, setIsRestartButtonHovered] = useState(false);
  const bodyCursorRef = useRef<string | null>(null);

  const setDropIndicatorEdge = useCallback((edge: Edge | null) => {
    if (suppressDropIndicator) return;
    setClosestEdge((previous) => previous === edge ? previous : edge);
  }, [suppressDropIndicator]);

  useEffect(() => {
    if (!suppressDropIndicator) return;
    setClosestEdge((previous) => previous === null ? previous : null);
  }, [suppressDropIndicator]);

  const setBodyGrabbing = useCallback(() => {
    if (bodyCursorRef.current === null) {
      bodyCursorRef.current = document.body.style.cursor;
      document.body.style.cursor = 'grabbing';
      acquireForcedDragCursor();
    }
  }, []);

  const clearBodyGrabbing = useCallback(() => {
    if (bodyCursorRef.current !== null) {
      document.body.style.cursor = bodyCursorRef.current;
      bodyCursorRef.current = null;
      releaseForcedDragCursor();
    }
  }, []);

  useEffect(() => () => clearBodyGrabbing(), [clearBodyGrabbing]);

  useEffect(() => {
    if (!isAnyDragging) return;
    if (isHovered) {
      setIsHovered(false);
      onHoverChange?.(false);
    }
    if (isRestartButtonHovered) setIsRestartButtonHovered(false);
  }, [isAnyDragging, isHovered, isRestartButtonHovered, onHoverChange]);

  useEffect(() => {
    if (!isPressing) return;
    const clearPress = () => {
      setIsPressing(false);
      clearBodyGrabbing();
    };
    window.addEventListener('mouseup', clearPress);
    window.addEventListener('blur', clearPress);
    window.addEventListener('dragend', clearPress);
    return () => {
      window.removeEventListener('mouseup', clearPress);
      window.removeEventListener('blur', clearPress);
      window.removeEventListener('dragend', clearPress);
    };
  }, [clearBodyGrabbing, isPressing]);

  // Tab adoption (Gemini → Claude sub-agent) was removed; no drag source is adoptable.
  const isAdoptDrop = useCallback((_sourceData: DragData) => false, []);

  // Resolve effective orientation: explicit prop wins, otherwise zone fallback
  // (main = horizontal in legacy TabBar, utility dropdown = vertical).
  const effectiveOrientation: 'horizontal' | 'vertical' = orientation ?? (zone === 'main' ? 'horizontal' : 'vertical');
  const isHorizontal = effectiveOrientation === 'horizontal';

  useEffect(() => {
    const element = ref.current;
    if (!element) return;

    const allowedEdges: Edge[] = isHorizontal ? ['left', 'right'] : ['top', 'bottom'];

    return combine(
      draggable({
        element,
        getInitialData: (): DragData => {
          const ws = useWorkspaceStore.getState().openProjects.get(projectId);
          const sel = ws?.selectedTabIds || [];
          const tabIds = sel.includes(tab.id) ? sel : [tab.id];
          return { type: 'TAB', id: tab.id, zone, index, projectId, selectedTabIds: tabIds, groupId, groupIndex };
        },
        onGenerateDragPreview: ({ nativeSetDragImage }) => {
          if (!isHorizontal) {
            setCustomNativeDragPreview({
              nativeSetDragImage,
              render({ container }) {
                Object.assign(container.style, {
                  width: '1px',
                  height: '1px',
                  opacity: '0',
                  pointerEvents: 'none',
                });
              },
            });
            return;
          }

          const ws = useWorkspaceStore.getState().openProjects.get(projectId);
          const sel = ws?.selectedTabIds || [];
          const count = sel.includes(tab.id) ? sel.length : 1;
          if (count <= 1) return;

          setCustomNativeDragPreview({
            nativeSetDragImage,
            render({ container }) {
              Object.assign(container.style, {
                display: 'flex', alignItems: 'center', gap: '6px',
                padding: '6px 12px', backgroundColor: '#1e1e1e',
                border: '1px solid #555', borderRadius: '6px',
                color: '#fff', fontSize: '13px', fontFamily: 'system-ui',
                whiteSpace: 'nowrap', boxShadow: '0 4px 12px rgba(0,0,0,0.4)',
              });
              const name = document.createElement('span');
              name.textContent = tab.name;
              container.appendChild(name);
              const badge = document.createElement('span');
              badge.textContent = '+' + (count - 1);
              Object.assign(badge.style, {
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                minWidth: '20px', height: '20px', padding: '0 6px',
                borderRadius: '10px', backgroundColor: '#3b82f6',
                color: '#fff', fontSize: '11px', fontWeight: '600',
              });
              container.appendChild(badge);
            },
          });
        },
        onDragStart: () => {
          setIsDragging(true);
          setBodyGrabbing();
        },
        onDrop: () => {
          setIsDragging(false);
          setIsPressing(false);
          clearBodyGrabbing();
        },
      }),
      dropTargetForElements({
        element,
        getData: ({ input, element }) => {
          const data = attachClosestEdge(
            { type: 'TAB', id: tab.id, zone, index, groupId, groupIndex },
            { element, input, allowedEdges }
          );
          return attachListInstruction(data, {
            element,
            input,
            axis: isHorizontal ? 'horizontal' : 'vertical',
            operations: REORDER_ONLY_OPERATIONS,
          });
        },
        canDrop: ({ source }) => source.data.type === 'TAB' || source.data.type === 'TAB_GROUP',
        onDragEnter: ({ source, self }) => {
          const sourceData = source.data as DragData;
          if (sourceData.type === 'TAB' && sourceData.id === tab.id) return;
          if (sourceData.type === 'TAB' && isAdoptDrop(sourceData)) {
            setIsAdoptTarget(true);
            setDropIndicatorEdge(null);
          } else {
            setDropIndicatorEdge(extractDropIndicatorEdge(self.data));
          }
        },
        onDrag: ({ source, self }) => {
          const sourceData = source.data as DragData;
          if (sourceData.type === 'TAB' && sourceData.id === tab.id) {
            setDropIndicatorEdge(null);
            setIsAdoptTarget(false);
            return;
          }
          if (sourceData.type === 'TAB' && isAdoptDrop(sourceData)) {
            setIsAdoptTarget(true);
            setDropIndicatorEdge(null);
          } else {
            setIsAdoptTarget(false);
            setDropIndicatorEdge(extractDropIndicatorEdge(self.data));
          }
        },
        onDragLeave: () => { setDropIndicatorEdge(null); setIsAdoptTarget(false); },
        onDrop: () => { setDropIndicatorEdge(null); setIsAdoptTarget(false); },
      })
    );
  }, [tab.id, zone, index, projectId, isAdoptDrop, isHorizontal, groupId, groupIndex, setDropIndicatorEdge]);

  // Settings → Размеры → ТАБЫ → Терминал. Геометрия каждой карточки таба.
  // Поднято в начало TabItem чтобы быть до объявления tabStyle ниже.
  const tabGeo = useUIStore((s) => s.tabGeometry);

  // Get color config
  // SDK tabs share `color: 'claude'` with PTY claude tabs (so existing palette
  // logic — copy buttons, sticky-note tints, etc — keeps working) but the *tab
  // chrome* needs a distinct peach hue to signal "this is the headless SDK
  // surface, not the live TUI". Override only the bg+border at the chrome
  // layer; everything else continues to read from `colorConfig`.
  const baseColorConfig = TAB_COLORS.find(c => c.color === tab.color) || TAB_COLORS[0];
  const colorConfig = tab.tabType === 'claude-sdk' && tab.color === 'claude'
    ? { ...baseColorConfig, bgColor: 'rgba(210, 140, 90, 0.30)', borderColor: '#D28C5A' }
    : tab.tabType === 'file'
      ? { ...baseColorConfig, bgColor: '#181725', borderColor: '#8b5cf6' }
    : baseColorConfig;


  // Determine background color
  const hasColor = tab.color && tab.color !== 'default';

  // Helper: increase/decrease alpha of an rgba() colour string. Used in vertical mode to make
  // active tab background ~3× saturated vs. inactive (clear visual hierarchy without top-stripe).
  const adjustAlpha = (rgba: string, delta: number): string => {
    const m = rgba.match(/rgba?\((\d+),\s*(\d+),\s*(\d+),?\s*([\d.]+)?\)/);
    if (!m) return rgba;
    const [, r, g, b, a = '0.2'] = m;
    const newAlpha = Math.max(0, Math.min(1, parseFloat(a) + delta));
    return `rgba(${r}, ${g}, ${b}, ${newAlpha})`;
  };

  // In vertical mode the activity signal is BACKGROUND SATURATION, not a top/left border.
  // Юзер: «насчёт прозрачности — неактивные слишком тусклые, hover нормальный, active нормальный».
  // Поэтому ступеньки в vertical: inactive=base, hover=base+0.08, active=base+0.25.
  // Без -0.10 дампера: inactive coloured tab уже видно как сейчас hover'нутый.
  // SDK Claude override на 0.30 (выше PTY claude 0.20) → SDK active = 0.55 vs PTY active = 0.45,
  // SDK явно светлее/жёлтее на одинаковом #252526 фоне.
  const isVerticalMode = !isHorizontal;
  const isVertActive = !isHorizontal && isActive;
  const isDraggedByMonitor = draggingGroupIds.includes(tab.id);
  const effectiveHovered = isHovered && !isAnyDragging;
  const shouldFlattenDragBackground = isVerticalMode;
  const getBgColor = () => {
    if (tab.tabType === 'file') {
      if (isActive) return isVertActive ? '#211f36' : '#181725';
      if (isSelected) return '#1f1d31';
      if (effectiveHovered) return '#201e32';
      return '#181725';
    }
    if (isActive) {
      if (hasColor) {
        return isVertActive ? adjustAlpha(colorConfig.bgColor, 0.25) : colorConfig.bgColor;
      }
      return isVertActive ? 'rgba(255,255,255,0.20)' : 'rgba(255,255,255,0.08)';
    }
    // Selected but NOT active tabs
    if (isSelected) {
      if (hasColor) {
        return adjustAlpha(colorConfig.bgColor, 0.1);
      }
      return 'rgba(255,255,255,0.06)';
    }
    // Hovered tabs — чуть ярче inactive чтобы hover работал как лёгкая подсветка.
    if (effectiveHovered) {
      if (hasColor) {
        return !isHorizontal ? adjustAlpha(colorConfig.bgColor, 0.08) : colorConfig.bgColor;
      }
      return !isHorizontal ? 'rgba(255,255,255,0.12)' : 'rgba(255,255,255,0.05)';
    }
    // Inactive coloured tab.
    // Vertical: НЕ дамперим — base alpha уже подобран чтоб inactive было читаемо
    // (PTY 0.20, SDK 0.30). Дампер -0.10 убран потому что юзер не различал вкладки.
    if (hasColor) {
      return colorConfig.bgColor;
    }
    // Inactive uncoloured: в vertical — лёгкая белая подложка чтоб не сливаться с панелью.
    return !isHorizontal ? 'rgba(255,255,255,0.04)' : 'transparent';
  };
  const rawTabBackgroundColor = getBgColor();
  const rawEffectiveTabBackgroundColor = isAdoptTarget ? 'rgba(99, 102, 241, 0.15)' : rawTabBackgroundColor;
  const tabBackgroundColor = shouldFlattenDragBackground
    ? flattenRgbaOnTabbarPanel(rawEffectiveTabBackgroundColor)
    : rawEffectiveTabBackgroundColor;

  // Border/indicator for active, selected, or interrupted tabs
  const getTopBorder = () => {
    if (isActive) {
      // Active tab gets solid colored line
      const borderColor = !hasColor ? 'rgba(255,255,255,0.7)' : colorConfig.borderColor;
      return `2px solid ${borderColor}`;
    }
    if (isInterrupted) {
      // Interrupted tab gets dashed blue line
      return '2px dashed #3b82f6';
    }
    if (isSelected) {
      // Selected but not active - subtle dashed outline
      return '2px dashed rgba(255,255,255,0.3)';
    }
    return '2px solid transparent';
  };

  const getLeftBorder = () => {
    if (isActive) {
      const borderColor = !hasColor ? 'rgba(255,255,255,0.7)' : colorConfig.borderColor;
      return `2px solid ${borderColor}`;
    }
    if (isInterrupted) {
      return '2px dashed #3b82f6';
    }
    if (isSelected) {
      return '2px dashed rgba(255,255,255,0.3)';
    }
    return '2px solid transparent';
  };

  // Collapsed tab icon color based on tab brand
  const getCollapsedIconColor = () => {
    if (tab.tabType === 'file') return '#a78bfa';
    if (tab.color === 'claude') return '#DA7756';
    if (tab.color === 'gemini') return '#4E86F8';
    if (tab.color === 'codex') return '#10A37F';
    if (hasColor) return colorConfig.borderColor;
    return '#888';
  };

  // Vertical mode = TabSidebar:
  // — top/left activity border убирается, активность кодируется НАСЫЩЕННОСТЬЮ ФОНА.
  // — RestartZone / SDK-status zone не рендерится (их функцию забирают левая полоса процесса
  //   и SVG-маркер статуса справа от неё). Поэтому исчезает 32px-gutter слева.
  // — Тонкая полоса процесса 2px + маркер статуса 8px рисуются абсолютом, поэтому в padding
  //   достаточно резервировать ~20px слева.
  const dragLiftActive = isVerticalMode && (isPressing || isDragging || isDraggedByMonitor);
  const completionNotificationWaiting = completionNotificationArmed && !completionNotificationFired;
  const [completionNotificationDismissing, setCompletionNotificationDismissing] = useState(false);
  const completionNotificationWasVisibleRef = useRef(completionNotificationFired);
  const completionNotificationDismissTimerRef = useRef<number | null>(null);
  const completionNotificationShadow = !isCollapsed && completionNotificationFired
    ? 'inset 0 0 0 1.5px rgba(239, 68, 68, 0.9), 0 0 12px rgba(239, 68, 68, 0.22)'
    : (!isCollapsed && completionNotificationWaiting
      ? 'inset 0 0 0 1px rgba(248, 113, 113, 0.55)'
      : null);
  const tabBoxShadow = [
    completionNotificationShadow,
    isAdoptTarget ? 'inset 0 0 0 1.5px rgba(99, 102, 241, 0.7)' : null,
  ].filter(Boolean).join(', ') || undefined;

  // Build inline styles - full control to avoid Tailwind conflicts
  const tabStyle: React.CSSProperties = {
    position: 'relative',
    display: 'flex',
    alignItems: 'center',
    justifyContent: isVerticalMode ? 'flex-start' : 'center',
    gap: isCollapsed ? '0' : '8px',
    cursor: dragLiftActive ? 'grabbing' : 'pointer',
    overflow: 'visible',
    padding: isCollapsed
      ? '0'
      : (tab.tabType === 'browser'
        // Browser tabs: no left gutter at all.
        ? (isHorizontal ? '0 12px' : `${tabGeo.paddingY}px ${tabGeo.paddingX}px`)
        // Vertical mode: всё из стора tabGeometry (Settings → Размеры).
        : (isVerticalMode
          ? `${tabGeo.paddingY}px ${tabGeo.paddingX}px ${tabGeo.paddingY}px ${tabGeo.paddingLeft}px`
          // SDK tabs: left gutter 32px (matches PTY claude — keeps the green dot
          // the same distance from the left edge so adjacent PTY+SDK tabs align
          // perfectly).
          : (tab.tabType === 'claude-sdk'
            ? '0 12px 0 32px'
            : '0 16px 0 32px'))),
    fontSize: `${fontSize}px`,
    height: isVerticalMode ? 'auto' : '30px',
    minHeight: isVerticalMode ? '24px' : undefined,
    borderRadius: isVerticalMode ? `${tabGeo.borderRadius}px` : undefined,
    width: isCollapsed ? '28px' : undefined,
    minWidth: isCollapsed ? '28px' : (isHorizontal ? 'auto' : '100%'),
    maxWidth: isCollapsed ? '28px' : undefined,
    color: (isActive || effectiveHovered || isSelected || isDraggedByMonitor) ? '#fff' : '#888',
    backgroundColor: tabBackgroundColor,
    // Vertical mode: NO activity border — насыщенность фона сама показывает активную вкладку.
    // Interrupted (dashed blue) и selected (dashed white) сохраняем как маркеры состояния.
    borderTop: isHorizontal ? getTopBorder() : 'none',
    borderLeft: isVerticalMode
      ? (isInterrupted
        ? '2px dashed #3b82f6'
        : (isSelected && !isActive ? '2px dashed rgba(255,255,255,0.3)' : '2px solid transparent'))
      : 'none',
    opacity: isVerticalMode && isAnyDragging ? 1 : (isDragging ? (isVerticalMode ? 1 : 0.5) : (isDraggedByMonitor && !dragLiftActive ? 0.5 : (isCollapsed && !isActive ? 0.6 : 1))),
    transform: undefined,
    transformOrigin: 'center',
    outline: dragLiftActive ? '1px solid rgba(139, 92, 246, 0.78)' : undefined,
    outlineOffset: dragLiftActive ? '-1px' : undefined,
    transition: isAnyDragging
      ? 'transform 90ms ease, box-shadow 90ms ease'
      : 'color 0.15s ease, background-color 0.15s ease, transform 90ms ease, box-shadow 90ms ease, opacity 0.12s ease',
    borderRight: isViewingSubAgent ? '2px solid rgba(168, 85, 247, 0.6)' : 'none',
    boxShadow: tabBoxShadow,
  };

  // Vertical mode разделяет два сигнала:
  //   hasProcess (PTY жив) → узкая 3px полоса слева/справа горит статично.
  //     PTY-источники: terminal:command-started/finished (claude CLI, npm run dev, bash, gemini CLI).
  //   isBusy (AI «думает»/стримит)   → shimmer-блик внутри этой полосы.
  //     AI-источники: claude:busy-state, gemini:busy-state, claude-sdk:busy-state.
  //   SDK claude — нет PTY → hasProcess=false. Раньше единственным сигналом был
  //   isBusy → плашка горела ТОЛЬКО пока генерится ответ, а после soft-interrupt
  //   (процесс жив, простаивает) гасла, хотя процесс жив. Теперь sdkProcessAlive
  //   кормит тот же канал что hasProcess: полоса горит пока процесс жив (ровно,
  //   если не busy; shimmer поверх неё пока busy), гаснет только на hard-kill —
  //   единый сигнал с индикатором в ControlBar.
  //   Если оба true (PTY claude думает) — рендерятся оба: полоса слева + shimmer.
  const verticalHasProcess = hasProcess || sdkProcessAlive;
  const verticalIsAiBusy = isBusy;
  // Awaiting-input pulses purple OVER the busy shimmer (awaiting ⊆ busy). Kept
  // separate so "Claude needs my answer" reads differently from "Claude is thinking".
  const verticalIsAwaiting = isAwaitingInput;
  // Lookup status definition by id из глобального стора.
  // useUIStore делает гранулярный subscribe — TabItem ре-рендерится только когда
  // массив sessionStatuses изменится (юзер отредактировал палитру в SettingsModal).
  const sessionStatuses = useUIStore((s) => s.sessionStatuses);
  const statusMeta = sessionStatus
    ? sessionStatuses.find((s) => s.id === sessionStatus)
    : null;
  // position — left|right (юзер выбирает в Settings). Цвет полоски и shimmer
  // читаются через CSS-переменные на :root (App.tsx синхронизирует).
  const processBarPosition = useUIStore((s) => s.processBar.position);
  const canShowVerticalRestartButton = isVerticalMode && tab.color === 'green' && hasProcess;
  const verticalRestartStopMode = canShowVerticalRestartButton
    && isRestartButtonHovered
    && cmdPeekMode
    && commandType === 'devServer'
    && !!onStop
    && !isStopping;
  const verticalRestartHoverActive = canShowVerticalRestartButton && isRestartButtonHovered && !isStopping;
  const verticalRestartButtonBackground = verticalRestartStopMode
    ? 'rgba(248, 113, 113, 0.16)'
    : (verticalRestartHoverActive ? 'rgba(34,197,94,0.18)' : '#1e1e2e');
  const verticalRestartButtonColor = isStopping
    ? '#666'
    : (verticalRestartStopMode ? '#f87171' : (verticalRestartHoverActive ? '#bbf7d0' : '#86efac'));
  const verticalRestartButtonBorder = verticalRestartStopMode
    ? '1px solid rgba(248, 113, 113, 0.35)'
    : '1px solid rgba(34,197,94,0.25)';
  // Settings → форма маркера статуса (круг или квадрат) + размер в px.
  const statusMarkerShape = useUIStore((s) => s.statusMarker.shape);
  const statusMarkerSize = useUIStore((s) => s.statusMarker.sizePx);
  const visualStateLogRef = useRef<string>('');
  const bgDiagRenderRef = useRef<string>('');
  const bgDiagComputedRef = useRef<string>('');
  const bgDiagFrameRef = useRef<number | null>(null);

  useLayoutEffect(() => {
    const lock = isTabbarDragVisualLockActive();
    const activeDiag = isVerticalMode && (lock || isAnyDragging || isPressing || isDragging || isDraggedByMonitor);

    if (!activeDiag) {
      bgDiagRenderRef.current = '';
      bgDiagComputedRef.current = '';
      if (bgDiagFrameRef.current !== null) {
        window.cancelAnimationFrame(bgDiagFrameRef.current);
        bgDiagFrameRef.current = null;
      }
      return;
    }

    const inlineBg = String(tabStyle.backgroundColor || '');
    const inlineTransition = String(tabStyle.transition || '');
    const inlineShadow = String(tabStyle.boxShadow || '');
    const inlineOutline = String(tabStyle.outline || '');
    const renderSig = [
      inlineBg,
      rawEffectiveTabBackgroundColor,
      shouldFlattenDragBackground ? 1 : 0,
      inlineTransition,
      inlineShadow,
      inlineOutline,
      isActive ? 1 : 0,
      isSelected ? 1 : 0,
      isHovered ? 1 : 0,
      effectiveHovered ? 1 : 0,
      isDragging ? 1 : 0,
      isPressing ? 1 : 0,
      isDraggedByMonitor ? 1 : 0,
      dragLiftActive ? 1 : 0,
      isAdoptTarget ? 1 : 0,
      closestEdge || '-',
      lock ? 1 : 0,
      isAnyDragging ? 1 : 0,
    ].join('|');

    if (bgDiagRenderRef.current !== renderSig) {
      bgDiagRenderRef.current = renderSig;
      console.log(
        `[TabDnd:bg] kind=tab phase=render tab=${shortDndId(tab.id)}` +
        ` name=${JSON.stringify(tab.name || '')}` +
        ` inlineBg=${inlineBg}` +
        ` rawBg=${rawEffectiveTabBackgroundColor}` +
        ` opaqueBg=${shouldFlattenDragBackground ? 1 : 0}` +
        ` inlineTransition=${JSON.stringify(inlineTransition)}` +
        ` inlineShadow=${JSON.stringify(inlineShadow)}` +
        ` inlineOutline=${JSON.stringify(inlineOutline)}` +
        ` active=${isActive ? 1 : 0}` +
        ` selected=${isSelected ? 1 : 0}` +
        ` hovered=${isHovered ? 1 : 0}` +
        ` effectiveHovered=${effectiveHovered ? 1 : 0}` +
        ` dragging=${isDragging ? 1 : 0}` +
        ` pressing=${isPressing ? 1 : 0}` +
        ` draggedByMonitor=${isDraggedByMonitor ? 1 : 0}` +
        ` lift=${dragLiftActive ? 1 : 0}` +
        ` adopt=${isAdoptTarget ? 1 : 0}` +
        ` edge=${closestEdge || '-'}` +
        ` lock=${lock ? 1 : 0}` +
        ` anyDragging=${isAnyDragging ? 1 : 0}`
      );
    }

    const element = ref.current;
    if (!element) return;
    if (bgDiagFrameRef.current !== null) {
      window.cancelAnimationFrame(bgDiagFrameRef.current);
    }
    bgDiagFrameRef.current = window.requestAnimationFrame(() => {
      bgDiagFrameRef.current = null;
      const styles = window.getComputedStyle(element);
      const computedSig = [
        styles.backgroundColor,
        styles.transitionProperty,
        styles.transitionDuration,
        styles.transitionTimingFunction,
      ].join('|');
      if (bgDiagComputedRef.current === computedSig) return;
      bgDiagComputedRef.current = computedSig;
      console.log(
        `[TabDnd:bg] kind=tab phase=computed tab=${shortDndId(tab.id)}` +
        ` computedBg=${styles.backgroundColor}` +
        ` transitionProperty=${JSON.stringify(styles.transitionProperty)}` +
        ` transitionDuration=${JSON.stringify(styles.transitionDuration)}` +
        ` transitionTiming=${JSON.stringify(styles.transitionTimingFunction)}` +
        ` inlineBg=${inlineBg}` +
        ` rawBg=${rawEffectiveTabBackgroundColor}` +
        ` opaqueBg=${shouldFlattenDragBackground ? 1 : 0}` +
        ` lock=${isTabbarDragVisualLockActive() ? 1 : 0}` +
        ` anyDragging=${isAnyDragging ? 1 : 0}`
      );
    });

    return () => {
      if (bgDiagFrameRef.current !== null) {
        window.cancelAnimationFrame(bgDiagFrameRef.current);
        bgDiagFrameRef.current = null;
      }
    };
  }, [
    closestEdge,
    dragLiftActive,
    effectiveHovered,
    isActive,
    isAdoptTarget,
    isAnyDragging,
    isDraggedByMonitor,
    isDragging,
    isHovered,
    isPressing,
    isSelected,
    isVerticalMode,
    tab.id,
    tab.name,
    rawEffectiveTabBackgroundColor,
    shouldFlattenDragBackground,
    tabStyle.backgroundColor,
    tabStyle.boxShadow,
    tabStyle.outline,
    tabStyle.transition,
  ]);

  useEffect(() => {
    if (!isVerticalMode) return;
    const element = ref.current;
    if (!element) return;

    const onBgTransition = (event: TransitionEvent) => {
      if (event.target !== element) return;
      if (!event.propertyName.includes('background')) return;
      const lock = isTabbarDragVisualLockActive();
      const activeDiag = lock || isAnyDragging || isPressing || isDragging || isDraggedByMonitor;
      if (!activeDiag) return;
      const styles = window.getComputedStyle(element);
      console.log(
        `[TabDnd:bg] kind=tab phase=${event.type} tab=${shortDndId(tab.id)}` +
        ` prop=${event.propertyName}` +
        ` elapsed=${event.elapsedTime}` +
        ` inlineBg=${String(tabStyle.backgroundColor || '')}` +
        ` rawBg=${rawEffectiveTabBackgroundColor}` +
        ` opaqueBg=${shouldFlattenDragBackground ? 1 : 0}` +
        ` computedBg=${styles.backgroundColor}` +
        ` transitionProperty=${JSON.stringify(styles.transitionProperty)}` +
        ` transitionDuration=${JSON.stringify(styles.transitionDuration)}` +
        ` hovered=${isHovered ? 1 : 0}` +
        ` effectiveHovered=${effectiveHovered ? 1 : 0}` +
        ` dragging=${isDragging ? 1 : 0}` +
        ` pressing=${isPressing ? 1 : 0}` +
        ` draggedByMonitor=${isDraggedByMonitor ? 1 : 0}` +
        ` lock=${lock ? 1 : 0}` +
        ` anyDragging=${isAnyDragging ? 1 : 0}`
      );
    };

    element.addEventListener('transitionrun', onBgTransition);
    element.addEventListener('transitionstart', onBgTransition);
    return () => {
      element.removeEventListener('transitionrun', onBgTransition);
      element.removeEventListener('transitionstart', onBgTransition);
    };
  }, [
    effectiveHovered,
    isAnyDragging,
    isDraggedByMonitor,
    isDragging,
    isHovered,
    isPressing,
    isVerticalMode,
    tab.id,
    tabStyle.backgroundColor,
  ]);

  useLayoutEffect(() => {
    if (completionNotificationDismissTimerRef.current !== null) {
      window.clearTimeout(completionNotificationDismissTimerRef.current);
      completionNotificationDismissTimerRef.current = null;
    }

    if (completionNotificationFired) {
      setCompletionNotificationDismissing(false);
    } else if (completionNotificationWasVisibleRef.current) {
      setCompletionNotificationDismissing(true);
      completionNotificationDismissTimerRef.current = window.setTimeout(() => {
        setCompletionNotificationDismissing(false);
        completionNotificationDismissTimerRef.current = null;
      }, COMPLETION_NOTIFICATION_DISMISS_MS);
    }

    completionNotificationWasVisibleRef.current = completionNotificationFired;

    return () => {
      if (completionNotificationDismissTimerRef.current !== null) {
        window.clearTimeout(completionNotificationDismissTimerRef.current);
        completionNotificationDismissTimerRef.current = null;
      }
    };
  }, [completionNotificationFired]);

  useEffect(() => {
    const rendersProcessBar = isVerticalMode && !isCollapsed && (verticalHasProcess || verticalIsAiBusy);
    const rendersShimmer = rendersProcessBar && verticalIsAiBusy;
    const signature = [
      isVerticalMode ? 1 : 0,
      isCollapsed ? 1 : 0,
      verticalHasProcess ? 1 : 0,
      verticalIsAiBusy ? 1 : 0,
      verticalIsAwaiting ? 1 : 0,
      isTitleNaming ? 1 : 0,
      processBarPosition,
      tab.commandType || '',
      tab.tabType || '',
      tab.name || '',
    ].join('|');
    if (visualStateLogRef.current === signature) return;
    visualStateLogRef.current = signature;
    if (!rendersProcessBar && !isTitleNaming && !verticalIsAwaiting) return;
    console.warn(
      '[TabItem:VisualState]' +
      ' tab=' + tab.id.slice(-8) +
      ' cmd=' + (tab.commandType || 'none') +
      ' type=' + (tab.tabType || 'terminal') +
      ' vertical=' + isVerticalMode +
      ' collapsed=' + isCollapsed +
      ' hasProcess=' + hasProcess +
      ' sdkProcess=' + sdkProcessAlive +
      ' busy=' + isBusy +
      ' awaiting=' + isAwaitingInput +
      ' titleNaming=' + isTitleNaming +
      ' processBar=' + rendersProcessBar +
      ' shimmer=' + rendersShimmer +
      ' position=' + processBarPosition +
      ' name=' + JSON.stringify(tab.name)
    );
  }, [
    isVerticalMode,
    isCollapsed,
    verticalHasProcess,
    verticalIsAiBusy,
    verticalIsAwaiting,
    isTitleNaming,
    processBarPosition,
    tab.id,
    tab.name,
    tab.commandType,
    tab.tabType,
    hasProcess,
    sdkProcessAlive,
    isBusy,
    isAwaitingInput,
  ]);

  return (
    <div
      ref={ref}
      className="group"
      data-tab-item
      data-tab-id={tab.id}
      data-tab-zone={zone}
      data-tab-group-id={groupId}
      style={tabStyle}
      onMouseDown={(e) => {
        if (e.button !== 0) return;
        const target = e.target as HTMLElement | null;
        if (target?.closest('[data-no-tab-drag],button,input,textarea,select,a')) return;
        setIsPressing(true);
        setBodyGrabbing();
      }}
      onClick={(e) => onSwitch(e)}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu}
      onMouseEnter={() => {
        const lock = isTabbarDragVisualLockActive();
        if (isAnyDragging || lock) {
          console.log(
            `[TabDnd:bg] kind=tab phase=mouseenter tab=${shortDndId(tab.id)}` +
            ` action=suppress lock=${lock ? 1 : 0}` +
            ` anyDragging=${isAnyDragging ? 1 : 0}` +
            ` hoveredBefore=${isHovered ? 1 : 0}`
          );
          onHoverChange?.(false);
          return;
        }
        console.log(
          `[TabDnd:bg] kind=tab phase=mouseenter tab=${shortDndId(tab.id)}` +
          ` action=accept lock=0 anyDragging=0 hoveredBefore=${isHovered ? 1 : 0}`
        );
        setIsHovered(true);
        if (onHoverChange && ref.current) {
          onHoverChange(true, ref.current.getBoundingClientRect());
        }
      }}
      onMouseLeave={() => {
        setIsHovered(false);
        onHoverChange?.(false);
      }}
      onAuxClick={(e) => {
        // Middle mouse button (button === 1) closes tab
        if (e.button === 1) {
          e.preventDefault();
          e.stopPropagation();
          onClose(e as any);
        }
      }}
    >
      {/* Collapsed: Bot icon only */}
      {isCollapsed ? (
        tab.tabType === 'file' ? (
          <FileText size={14} style={{ color: getCollapsedIconColor(), flexShrink: 0 }} />
        ) : (
          <Bot size={14} style={{ color: getCollapsedIconColor(), flexShrink: 0 }} />
        )
      ) : (
        <>
          {/* Vertical mode: thin process bar on the very left + status SVG marker
              just to the right of it. Replaces RestartZone/SDK-status zone. */}
          {isVerticalMode && (
            <>
              {/* Process bar — 3px полоска по полной высоте вкладки. Внутри неё
                  рендерятся ДВА независимых сигнала одновременно:
                    • process-alive (hasProcess) → статичная цветная полоска.
                    • AI-busy (isBusy) → настраиваемый блик ползёт сверху вниз поверх цвета.
                  Если активен только один сигнал — рисуется только он. Если AI думает
                  без PTY (SDK-таб) — цвет полоски статичный colorA, блик ползёт.
                  overflow:hidden держит shimmer-overlay строго внутри полоски. */}
              {(verticalHasProcess || verticalIsAiBusy) && (
                <div
                  className="tab-process-bar-static"
                  style={{
                    position: 'absolute',
                    // Слева -2px компенсирует 2px transparent border (резерв под dashed-states).
                    // Справа такого border нет: right:0 держит полоску на правой границе карточки/меню.
                    ...(processBarPosition === 'right' ? { right: 0 } : { left: '-2px' }),
                    top: 0,
                    bottom: 0,
                    width: '3px',
                    pointerEvents: 'none',
                    zIndex: 5,
                    overflow: 'hidden',
                    // Закруглённые углы только на «своей» стороне вкладки.
                    ...(processBarPosition === 'right'
                      ? { borderTopRightRadius: tabGeo.borderRadius, borderBottomRightRadius: tabGeo.borderRadius }
                      : { borderTopLeftRadius: tabGeo.borderRadius, borderBottomLeftRadius: tabGeo.borderRadius }),
                  }}
                >
                  {verticalIsAiBusy && <div className="tab-process-bar-ai-shimmer-overlay" />}
                </div>
              )}
              {/* AI-busy loader = the process-bar shimmer STRIP (left/right edge,
                  rendered above). The whole-tab background pulse was removed —
                  the loader is the переливающаяся полоска у края, not a tint of
                  the entire tab. See fact-process-bar.md::AIPulse removed. */}
              {/* Awaiting-user-input purple wash — layers above the busy shimmer
                  (zIndex:1 vs 0) but still under tab content (text z:5–6). */}
              {verticalIsAwaiting && (
                <div
                  className="tab-awaiting-input"
                  style={{
                    position: 'absolute',
                    top: 0,
                    bottom: 0,
                    left: '-2px',
                    right: '-2px',
                    pointerEvents: 'none',
                    zIndex: 1,
                    borderRadius: tabGeo.borderRadius,
                  }}
                  aria-hidden
                />
              )}
              {(completionNotificationFired || completionNotificationDismissing) && (
                <div
                  className={`tab-completion-notification-alert ${
                    completionNotificationDismissing && !completionNotificationFired
                      ? 'tab-completion-notification-alert--dismiss'
                      : ''
                  }`}
                  style={{
                    position: 'absolute',
                    top: 0,
                    bottom: 0,
                    left: '-2px',
                    right: '-2px',
                    pointerEvents: 'none',
                    zIndex: 2,
                    borderRadius: tabGeo.borderRadius,
                  }}
                  aria-hidden
                />
              )}
              {/* Status marker — shape (dot|square) + sizePx из Settings.
                  Левый отступ 5px: после 3px polosky процесса (z:5) + 2px зазор → 5px.
                  По вертикали top:calc(50% + 1px) компенсирует оптический baseline-шифт
                  строчных букв ('claude-03' без descender'ов выглядит чуть ниже
                  геометрического центра карточки).
                  Если полоска процесса справа — маркер всё равно слева (так лучше читается
                  рядом с текстом названия таба). */}
              {statusMeta && (
                <span
                  title={statusMeta.label}
                  style={{
                    position: 'absolute',
                    left: '5px',
                    top: 'calc(50% + 1px)',
                    transform: 'translateY(-50%)',
                    width: `${statusMarkerSize}px`,
                    height: `${statusMarkerSize}px`,
                    borderRadius: statusMarkerShape === 'square' ? '2px' : '50%',
                    backgroundColor: statusMeta.color,
                    border: '1px solid rgba(0,0,0,0.4)',
                    pointerEvents: 'none',
                    zIndex: 6,
                  }}
                />
              )}
              {/* В вертикальном режиме middle-click по всей вкладке = close tab (стандартное
                  поведение TabItem root). Stop devServer живёт в правой restart-кнопке:
                  Cmd+hover показывает красный square, click отправляет stop без restart. */}
            </>
          )}

          {/* Restart zone - left part of tab (horizontal only; not for browser/SDK) */}
          {!isVerticalMode && tab.tabType !== 'browser' && tab.tabType !== 'claude-sdk' && (
            <RestartZone
              hasProcess={hasProcess}
              hasColor={!!hasColor}
              commandType={commandType}
              hasSession={hasSession}
              isBusy={isBusy}
              isStopping={isStopping}
              onRestart={() => onRestart && onRestart(tab.id)}
              onStop={() => onStop && onStop(tab.id)}
            />
          )}
          {/* SDK status zone - left side, status-only (no restart action). Click
              forwards to onStop when busy so it mirrors PTY claude middle-click
              Stop. Three states: BUSY = peach spinner, has session (idle) = green
              dot, fresh tab = nothing. */}
          {!isVerticalMode && tab.tabType === 'claude-sdk' && (
            <div
              style={{
                position: 'absolute',
                left: 0,
                top: 0,
                bottom: 0,
                width: '32px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                zIndex: 10,
                cursor: isBusy ? 'pointer' : 'default',
              }}
              onClick={(e) => {
                if (isBusy) {
                  e.stopPropagation();
                  onStop && onStop(tab.id);
                }
              }}
              onAuxClick={(e) => {
                // Middle-click Stop, same gesture as PTY claude RestartZone.
                if (e.button === 1 && isBusy) {
                  e.preventDefault();
                  e.stopPropagation();
                  onStop && onStop(tab.id);
                }
              }}
              title={isBusy ? 'Stop SDK query' : (hasSession ? 'Claude SDK session active' : '')}
            >
              {isBusy ? (
                <span
                  style={{
                    display: 'block',
                    width: '8px',
                    height: '8px',
                    borderRadius: '50%',
                    border: '1.5px solid rgba(255, 178, 130, 0.25)',
                    borderTopColor: '#FFB382',
                    boxSizing: 'border-box',
                    animation: 'tab-dot-spin 0.8s linear infinite',
                  }}
                />
              ) : hasSession ? (
                <span
                  style={{
                    display: 'block',
                    width: '6px',
                    height: '6px',
                    borderRadius: '50%',
                    backgroundColor: '#4ade80',
                    boxShadow: '0 0 4px rgba(74, 222, 128, 0.5)',
                    opacity: 0.9,
                  }}
                />
              ) : null}
            </div>
          )}
          {isEditing ? (
            <input
              ref={inputRef}
              type="text"
              className="bg-[#333] border border-accent rounded px-2 py-0.5 text-[13px] text-white outline-none"
              style={{
                // Vertical mode (TabSidebar): растягиваем input на остаток ширины, чтобы
                // кнопка заметок справа осталась прижата к правому краю TabItem (а не
                // прилипла к short input'у с пустой зоной за ней).
                // Horizontal mode: legacy fixed 100px — там кнопки заметок нет.
                width: isHorizontal ? 100 : undefined,
                flex: isHorizontal ? 'none' : 1,
                minWidth: 0,
              }}
              value={editValue}
              onChange={(e) => onEditChange(e.target.value)}
              onBlur={onEditSubmit}
              onKeyDown={onEditKeyDown}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => e.stopPropagation()}
            />
          ) : (
            <span
              className="select-none whitespace-nowrap overflow-hidden text-ellipsis flex items-center gap-1"
              style={{
                flex: isHorizontal ? 'none' : 1,
                color: tab.aiClosing ? '#8a8a8a' : undefined,
                fontStyle: tab.aiClosing ? 'italic' : undefined,
              }}
            >
              {tab.tabType === 'browser' && <Globe size={12} className="flex-shrink-0 opacity-60" />}
              {tab.tabType === 'file' && <FileText size={12} className="flex-shrink-0 text-[#a78bfa] opacity-90" />}
              {tab.aiClosing && (
                <span
                  className="flex-shrink-0"
                  style={{
                    width: 9,
                    height: 9,
                    borderRadius: '50%',
                    border: '1.5px solid rgba(138,138,138,0.25)',
                    borderTopColor: '#8a8a8a',
                    boxSizing: 'border-box',
                    animation: 'tab-dot-spin 0.8s linear infinite',
                  }}
                />
              )}
              {tab.aiClosing ? 'остановка сессии...' : isTitleNaming ? (
                <span className="tab-title-naming-frame" title={tab.name}>
                  <span className="tab-title-naming-ghost">{tab.name}</span>
                  <span className="tab-title-naming-text">naming...</span>
                </span>
              ) : tab.name}
            </span>
          )}

          {/* Restart button — для зелёных (devServer) вкладок с активным процессом
                занимает место notes-кнопки. Логика: зелёный таб обычно = npm run dev,
                заметок там почти не пишут, зато перезапуск из меню вкладки нужен часто.
                Mutex с notes: если рендерится restart — notes не рендерится. Кнопка
                делегирует в onRestart (детерминистический stop+!! в одном IPC);
                Cmd+hover превращает эту же кнопку в Stop (красный square, без
                отдельной hit-zone на полоске процесса).
                Пока stop в полёте — иконка крутится, click заблокирован. */}
          {canShowVerticalRestartButton && (
            <button
              type="button"
              data-no-tab-drag
              onClick={(e) => {
                e.stopPropagation();
                if (isStopping) return;
                if (verticalRestartStopMode) {
                  onStop?.(tab.id);
                } else {
                  onRestart?.(tab.id);
                }
              }}
              onMouseDown={(e) => e.stopPropagation()}
              onDoubleClick={(e) => e.stopPropagation()}
              title={isStopping
                ? 'Stopping…'
                : (verticalRestartStopMode
                  ? 'Stop process (Cmd+click)'
                  : 'Restart process (kill descendants + ports, then re-run)')}
              aria-label={verticalRestartStopMode ? 'Stop running dev process' : 'Restart process'}
              className="flex-shrink-0 inline-flex items-center justify-center transition-colors"
              style={{
                width: 20,
                height: 18,
                marginLeft: 6,
                padding: 0,
                borderRadius: 4,
                backgroundColor: verticalRestartButtonBackground,
                color: verticalRestartButtonColor,
                border: verticalRestartButtonBorder,
                cursor: isStopping ? 'wait' : 'pointer',
              }}
              onMouseEnter={() => {
                const lock = isTabbarDragVisualLockActive();
                if (isStopping || isAnyDragging || lock) {
                  setIsRestartButtonHovered(false);
                  console.log(
                    `[TabDnd:bg] kind=tab-child phase=mouseenter child=restart tab=${shortDndId(tab.id)}` +
                    ` action=suppress stopping=${isStopping ? 1 : 0}` +
                    ` lock=${lock ? 1 : 0}` +
                    ` anyDragging=${isAnyDragging ? 1 : 0}`
                  );
                  return;
                }
                console.log(
                  `[TabDnd:bg] kind=tab-child phase=mouseenter child=restart tab=${shortDndId(tab.id)}` +
                  ` action=accept lock=0 anyDragging=0`
                );
                setIsRestartButtonHovered(true);
              }}
              onMouseLeave={() => setIsRestartButtonHovered(false)}
            >
              {verticalRestartStopMode ? (
                <Square size={9} fill="currentColor" strokeWidth={1.9} aria-hidden />
              ) : (
                <RotateCw
                  size={11}
                  strokeWidth={2.2}
                  style={isStopping ? { animation: 'tab-dot-spin 0.8s linear infinite' } : undefined}
                  aria-hidden
                />
              )}
            </button>
          )}

          {/* Open notes — peek-button. Three visibility rules:
                1. slideoutOpenHere — slideout is anchored to this tab (solid-indigo, always visible).
                2. showNotesPeek — Cmd is held, cursor in TabBar, tab has notes (Cmd-hover peek).
                3. Default-on-active — active tab in vertical mode, but ONLY when (a) no slideout
                   is open on another tab AND (b) we're NOT in peek-mode. Peek-mode means "buttons
                   only where there are notes" — keeping the default-on-active button on an empty
                   active tab during peek would break that rule.
              Empty vs filled: tab.notes пустой → тусклый dim-grey стиль (юзер видит «здесь нет
              заметок, но кнопка чтобы создать»), notes есть → indigo-tinted (заметка ждёт). При
              slideoutOpenHere — solid-indigo всегда (anchor-индикатор сильнее семантики empty).
              position:relative + zIndex:1 нужны чтобы AI-busy-фон вкладки (zIndex:0, absolute) не
              перекрасил кнопку — без явного stacking context positioned-sibling рисуется поверх
              static-кнопки в том же flex'е. См. fact-notes.md::Z-index над AI-pulse.
              Mutex: если этот же таб зелёный с активным процессом — место занимает Restart-кнопка
              выше, notes не рендерится. */}
          {isVerticalMode && tab.tabType !== 'file' && !(tab.color === 'green' && hasProcess) && (slideoutOpenHere || showNotesPeek || (isActive && !anySlideoutOpen && !cmdPeekMode)) && (() => {
            const hasNotes = !!(tab.notes && tab.notes.trim().length > 0);
            const dim = !slideoutOpenHere && !hasNotes;
            const baseBg = slideoutOpenHere ? '#6366f1' : '#1e1e2e';
            const baseColor = slideoutOpenHere
              ? '#fff'
              : (dim ? '#4f5167' : '#a5b4fc');
            const baseBorder = slideoutOpenHere
              ? '1px solid #6366f1'
              : (dim
                ? '1px solid rgba(99,102,241,0.10)'
                : '1px solid rgba(99,102,241,0.25)');
            return (
              <button
                data-tab-notes-open-trigger
                data-no-tab-drag
                data-tab-id={tab.id}
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  const cur = useUIStore.getState().notesPanelOpenTabs[tab.id] ?? false;
                  useUIStore.getState().setNotesPanelOpen(tab.id, !cur);
                }}
                onDoubleClick={(e) => e.stopPropagation()}
                title={hasNotes ? 'Open notes (Cmd+E)' : 'Create notes (Cmd+E)'}
                className="flex-shrink-0 inline-flex items-center justify-center cursor-pointer transition-colors"
                style={{
                  position: 'relative',
                  zIndex: 1,
                  width: 20,
                  height: 18,
                  marginLeft: 6,
                  padding: 0,
                  borderRadius: 4,
                  backgroundColor: baseBg,
                  color: baseColor,
                  border: baseBorder,
                }}
                onMouseEnter={(e) => {
                  const lock = isTabbarDragVisualLockActive();
                  if (slideoutOpenHere || isAnyDragging || lock) {
                    console.log(
                      `[TabDnd:bg] kind=tab-child phase=mouseenter child=notes tab=${shortDndId(tab.id)}` +
                      ` action=suppress slideoutOpen=${slideoutOpenHere ? 1 : 0}` +
                      ` lock=${lock ? 1 : 0}` +
                      ` anyDragging=${isAnyDragging ? 1 : 0}`
                    );
                    return;
                  } // solid state — no hover swap
                  console.log(
                    `[TabDnd:bg] kind=tab-child phase=mouseenter child=notes tab=${shortDndId(tab.id)}` +
                    ` action=accept lock=0 anyDragging=0`
                  );
                  const el = e.currentTarget as HTMLButtonElement;
                  el.style.backgroundColor = '#2a2a3e';
                  el.style.color = dim ? '#a5b4fc' : '#c7d2fe';
                }}
                onMouseLeave={(e) => {
                  if (slideoutOpenHere) return;
                  const el = e.currentTarget as HTMLButtonElement;
                  el.style.backgroundColor = baseBg;
                  el.style.color = baseColor;
                }}
              >
                <StickyNote size={11} strokeWidth={2} />
              </button>
            );
          })()}
        </>
      )}

      {/* Absolute overlay indicator - doesn't affect layout */}
      {!suppressDropIndicator && closestEdge && <DropIndicatorLine edge={closestEdge} />}
      {!suppressDropIndicator && forceRightIndicator && !closestEdge && <DropIndicatorLine edge="right" />}
    </div>
  );
});

// Zone Container (for dropping when empty)
const ZoneDropTarget = memo(({
  zone,
  children,
  isEmpty
}: {
  zone: 'main' | 'utility';
  children: React.ReactNode;
  isEmpty: boolean;
}) => {
  const ref = useRef<HTMLDivElement>(null);
  const [isOver, setIsOver] = useState(false);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;

    return dropTargetForElements({
      element,
      getData: () => ({ type: 'ZONE', zone }),
      canDrop: ({ source }) => source.data.type === 'TAB',
      onDragEnter: () => setIsOver(true),
      onDragLeave: () => setIsOver(false),
      onDrop: () => setIsOver(false),
    });
  }, [zone]);

  return (
    <div
      ref={ref}
      className={`${isOver && isEmpty ? 'bg-accent/20' : ''} transition-colors overflow-visible`}
    >
      {children}
    </div>
  );
});

const TabGroupHeader = memo(({ group, count, projectId, isEditing, editValue, onEditChange, onEditSubmit, onEditKeyDown, inputRef, onStartRename, onContextMenu, onAuxClick, onToggleCollapsed, onFocusGroup, isFocused, isAnyDragging }: {
  group: TabGroup;
  count: number;
  projectId: string;
  isEditing: boolean;
  editValue: string;
  onEditChange: (value: string) => void;
  onEditSubmit: () => void;
  onEditKeyDown: (e: React.KeyboardEvent) => void;
  inputRef: React.RefObject<HTMLInputElement>;
  onStartRename: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
  onAuxClick: (e: React.MouseEvent) => void;
  onToggleCollapsed: () => void;
  onFocusGroup: () => void;
  isFocused: boolean;
  isAnyDragging?: boolean;
}) => {
  const ref = useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [isPressing, setIsPressing] = useState(false);
  const [isHovered, setIsHovered] = useState(false);
  const [isIconHovered, setIsIconHovered] = useState(false);
  const clickTimerRef = useRef<number | null>(null);
  const suppressClickAfterDragRef = useRef(false);
  const bodyCursorRef = useRef<string | null>(null);
  const tabGeo = useUIStore((s) => s.tabGeometry);
  const tabsFontSize = useUIStore((s) => s.tabsFontSize);
  const sessionStatuses = useUIStore((s) => s.sessionStatuses);
  const statusMarkerShape = useUIStore((s) => s.statusMarker.shape);
  const statusMarkerSize = useUIStore((s) => s.statusMarker.sizePx);

  const setBodyGrabbing = useCallback(() => {
    if (bodyCursorRef.current === null) {
      bodyCursorRef.current = document.body.style.cursor;
      document.body.style.cursor = 'grabbing';
      acquireForcedDragCursor();
    }
  }, []);

  const clearBodyGrabbing = useCallback(() => {
    if (bodyCursorRef.current !== null) {
      document.body.style.cursor = bodyCursorRef.current;
      bodyCursorRef.current = null;
      releaseForcedDragCursor();
    }
  }, []);

  useEffect(() => () => clearBodyGrabbing(), [clearBodyGrabbing]);
  useEffect(() => () => {
    if (clickTimerRef.current !== null) window.clearTimeout(clickTimerRef.current);
  }, []);

  useEffect(() => {
    if (!isAnyDragging) return;
    if (isHovered) setIsHovered(false);
    if (isIconHovered) setIsIconHovered(false);
  }, [isAnyDragging, isHovered, isIconHovered]);

  useEffect(() => {
    if (!isPressing) return;
    const clearPress = () => {
      setIsPressing(false);
      clearBodyGrabbing();
    };
    window.addEventListener('mouseup', clearPress);
    window.addEventListener('blur', clearPress);
    window.addEventListener('dragend', clearPress);
    return () => {
      window.removeEventListener('mouseup', clearPress);
      window.removeEventListener('blur', clearPress);
      window.removeEventListener('dragend', clearPress);
    };
  }, [clearBodyGrabbing, isPressing]);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;

    return combine(
      draggable({
        element,
        canDrag: ({ input }) => {
          if (isEditing) return false;
          const hit = document.elementFromPoint(input.clientX, input.clientY);
          return !hit?.closest('[data-group-collapse-button]');
        },
        getInitialData: (): DragData => ({ type: 'TAB_GROUP', groupId: group.id, zone: 'main', projectId }),
        onGenerateDragPreview: ({ nativeSetDragImage }) => {
          setCustomNativeDragPreview({
            nativeSetDragImage,
            render({ container }) {
              Object.assign(container.style, {
                width: '1px',
                height: '1px',
                opacity: '0',
                pointerEvents: 'none',
              });
            },
          });
        },
        onDragStart: () => {
          suppressClickAfterDragRef.current = true;
          setIsDragging(true);
          setBodyGrabbing();
        },
        onDrop: () => {
          setIsDragging(false);
          setIsPressing(false);
          clearBodyGrabbing();
          window.setTimeout(() => {
            suppressClickAfterDragRef.current = false;
          }, 0);
        },
      }),
      dropTargetForElements({
        element,
        getData: ({ input, element }) => {
          const data = attachClosestEdge(
            { type: 'GROUP', groupId: group.id },
            { element, input, allowedEdges: ['top', 'bottom'] }
          );
          return attachListInstruction(data, {
            element,
            input,
            axis: 'vertical',
            operations: GROUP_CONTAINER_OPERATIONS,
          });
        },
        canDrop: ({ source }) => source.data.type === 'TAB' || source.data.type === 'TAB_GROUP',
      })
    );
  }, [group.id, isEditing, projectId]);

  const dragLiftActive = isPressing || isDragging;
  const isCollapsed = !!group.collapsed;
  const effectiveHovered = isHovered && !isAnyDragging;
  const iconAccentActive = effectiveHovered || isIconHovered || isCollapsed || isFocused;
  const headerCursor = dragLiftActive ? 'grabbing' : 'pointer';
  const shouldFlattenDragBackground = true;
  const groupColor = group.color && group.color !== 'default' ? group.color : undefined;
  const groupColorConfig = TAB_COLORS.find(c => c.color === groupColor);
  const folderColor = groupColorConfig?.borderColor || '#8b5cf6';
  const statusMeta = group.sessionStatus
    ? sessionStatuses.find((s) => s.id === group.sessionStatus)
    : null;
  const groupBackground = (() => {
    if (groupColorConfig) {
      return adjustRgbaAlpha(groupColorConfig.bgColor, effectiveHovered || isFocused ? 0.10 : (isCollapsed ? 0.04 : -0.06));
    }
    if (isCollapsed || isFocused) return effectiveHovered ? 'rgba(139,92,246,0.17)' : 'rgba(139,92,246,0.11)';
    return effectiveHovered ? 'rgba(255,255,255,0.07)' : 'rgba(255,255,255,0.035)';
  })();
  const groupDisplayBackground = shouldFlattenDragBackground
    ? flattenRgbaOnTabbarPanel(groupBackground)
    : groupBackground;
  const groupBorder = groupColorConfig?.borderColor || (isCollapsed || isFocused ? 'rgba(139,92,246,0.42)' : 'rgba(255,255,255,0.08)');
  const bgDiagRenderRef = useRef<string>('');
  const bgDiagComputedRef = useRef<string>('');
  const bgDiagFrameRef = useRef<number | null>(null);

  useLayoutEffect(() => {
    const lock = isTabbarDragVisualLockActive();
    const activeDiag = lock || isAnyDragging || isPressing || isDragging;

    if (!activeDiag) {
      bgDiagRenderRef.current = '';
      bgDiagComputedRef.current = '';
      if (bgDiagFrameRef.current !== null) {
        window.cancelAnimationFrame(bgDiagFrameRef.current);
        bgDiagFrameRef.current = null;
      }
      return;
    }

    const renderSig = [
      groupDisplayBackground,
      groupBackground,
      shouldFlattenDragBackground ? 1 : 0,
      groupBorder,
      isHovered ? 1 : 0,
      effectiveHovered ? 1 : 0,
      isIconHovered ? 1 : 0,
      isCollapsed ? 1 : 0,
      isFocused ? 1 : 0,
      isDragging ? 1 : 0,
      isPressing ? 1 : 0,
      dragLiftActive ? 1 : 0,
      lock ? 1 : 0,
      isAnyDragging ? 1 : 0,
    ].join('|');

    if (bgDiagRenderRef.current !== renderSig) {
      bgDiagRenderRef.current = renderSig;
      console.log(
        `[TabDnd:bg] kind=group phase=render group=${shortDndId(group.id)}` +
        ` name=${JSON.stringify(group.name || '')}` +
        ` inlineBg=${groupDisplayBackground}` +
        ` rawBg=${groupBackground}` +
        ` opaqueBg=${shouldFlattenDragBackground ? 1 : 0}` +
        ` border=${groupBorder}` +
        ` hovered=${isHovered ? 1 : 0}` +
        ` effectiveHovered=${effectiveHovered ? 1 : 0}` +
        ` iconHovered=${isIconHovered ? 1 : 0}` +
        ` collapsed=${isCollapsed ? 1 : 0}` +
        ` focused=${isFocused ? 1 : 0}` +
        ` dragging=${isDragging ? 1 : 0}` +
        ` pressing=${isPressing ? 1 : 0}` +
        ` lift=${dragLiftActive ? 1 : 0}` +
        ` lock=${lock ? 1 : 0}` +
        ` anyDragging=${isAnyDragging ? 1 : 0}`
      );
    }

    const element = ref.current;
    if (!element) return;
    if (bgDiagFrameRef.current !== null) {
      window.cancelAnimationFrame(bgDiagFrameRef.current);
    }
    bgDiagFrameRef.current = window.requestAnimationFrame(() => {
      bgDiagFrameRef.current = null;
      const styles = window.getComputedStyle(element);
      const computedSig = [
        styles.backgroundColor,
        styles.transitionProperty,
        styles.transitionDuration,
        styles.transitionTimingFunction,
      ].join('|');
      if (bgDiagComputedRef.current === computedSig) return;
      bgDiagComputedRef.current = computedSig;
      console.log(
        `[TabDnd:bg] kind=group phase=computed group=${shortDndId(group.id)}` +
        ` computedBg=${styles.backgroundColor}` +
        ` transitionProperty=${JSON.stringify(styles.transitionProperty)}` +
        ` transitionDuration=${JSON.stringify(styles.transitionDuration)}` +
        ` transitionTiming=${JSON.stringify(styles.transitionTimingFunction)}` +
        ` inlineBg=${groupDisplayBackground}` +
        ` rawBg=${groupBackground}` +
        ` opaqueBg=${shouldFlattenDragBackground ? 1 : 0}` +
        ` lock=${isTabbarDragVisualLockActive() ? 1 : 0}` +
        ` anyDragging=${isAnyDragging ? 1 : 0}`
      );
    });

    return () => {
      if (bgDiagFrameRef.current !== null) {
        window.cancelAnimationFrame(bgDiagFrameRef.current);
        bgDiagFrameRef.current = null;
      }
    };
  }, [
    dragLiftActive,
    effectiveHovered,
    group.id,
    group.name,
    groupBackground,
    groupDisplayBackground,
    groupBorder,
    isAnyDragging,
    isCollapsed,
    isDragging,
    isFocused,
    isHovered,
    isIconHovered,
    isPressing,
    shouldFlattenDragBackground,
  ]);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;

    const onBgTransition = (event: TransitionEvent) => {
      if (event.target !== element) return;
      if (!event.propertyName.includes('background')) return;
      const lock = isTabbarDragVisualLockActive();
      const activeDiag = lock || isAnyDragging || isPressing || isDragging;
      if (!activeDiag) return;
      const styles = window.getComputedStyle(element);
      console.log(
        `[TabDnd:bg] kind=group phase=${event.type} group=${shortDndId(group.id)}` +
        ` prop=${event.propertyName}` +
        ` elapsed=${event.elapsedTime}` +
        ` inlineBg=${groupDisplayBackground}` +
        ` rawBg=${groupBackground}` +
        ` opaqueBg=${shouldFlattenDragBackground ? 1 : 0}` +
        ` computedBg=${styles.backgroundColor}` +
        ` transitionProperty=${JSON.stringify(styles.transitionProperty)}` +
        ` transitionDuration=${JSON.stringify(styles.transitionDuration)}` +
        ` hovered=${isHovered ? 1 : 0}` +
        ` effectiveHovered=${effectiveHovered ? 1 : 0}` +
        ` iconHovered=${isIconHovered ? 1 : 0}` +
        ` dragging=${isDragging ? 1 : 0}` +
        ` pressing=${isPressing ? 1 : 0}` +
        ` lock=${lock ? 1 : 0}` +
        ` anyDragging=${isAnyDragging ? 1 : 0}`
      );
    };

    element.addEventListener('transitionrun', onBgTransition);
    element.addEventListener('transitionstart', onBgTransition);
    return () => {
      element.removeEventListener('transitionrun', onBgTransition);
      element.removeEventListener('transitionstart', onBgTransition);
    };
  }, [
    effectiveHovered,
    group.id,
    groupBackground,
    groupDisplayBackground,
    isAnyDragging,
    isDragging,
    isHovered,
    isIconHovered,
    isPressing,
    shouldFlattenDragBackground,
  ]);

  return (
    <div
      ref={ref}
      data-tab-group-header
      data-group-id={group.id}
      style={{
        display: 'flex',
        position: 'relative',
        alignItems: 'center',
        gap: 8,
        minHeight: 24,
        padding: `${tabGeo.paddingY}px ${tabGeo.paddingX}px ${tabGeo.paddingY}px ${tabGeo.paddingLeft}px`,
        borderRadius: tabGeo.borderRadius,
        boxSizing: 'border-box',
        fontSize: `${tabsFontSize}px`,
        cursor: headerCursor,
        userSelect: 'none',
        color: (effectiveHovered || isCollapsed || isFocused) ? '#e5e7eb' : '#a1a1aa',
        backgroundColor: groupDisplayBackground,
        border: `1px solid ${groupBorder}`,
        opacity: 1,
        transform: undefined,
        transformOrigin: 'center',
        outline: dragLiftActive ? '1px solid rgba(139,92,246,0.78)' : undefined,
        outlineOffset: dragLiftActive ? '-1px' : undefined,
        boxShadow: isCollapsed || isFocused ? 'inset 0 0 0 1px rgba(139,92,246,0.10)' : 'none',
        transition: isAnyDragging
          ? 'transform 90ms ease, box-shadow 90ms ease, border-color 90ms ease'
          : 'background-color 0.12s, color 0.12s, opacity 0.12s, transform 90ms ease, box-shadow 90ms ease, border-color 90ms ease',
      }}
      onMouseDown={(e) => {
        if (isEditing) return;
        if (e.button !== 0) return;
        if ((e.target as HTMLElement).closest('[data-group-collapse-button]')) return;
        setIsPressing(true);
        setBodyGrabbing();
      }}
      onClick={(e) => {
        if (isEditing) return;
        if (suppressClickAfterDragRef.current) return;
        e.preventDefault();
        e.stopPropagation();
        onFocusGroup();
        if ((e.target as HTMLElement).closest('[data-group-collapse-button]')) return;
        const titleTarget = !!(e.target as HTMLElement).closest('[data-group-title-text]');
        if (!titleTarget) {
          onToggleCollapsed();
          return;
        }
        if (clickTimerRef.current !== null) window.clearTimeout(clickTimerRef.current);
        clickTimerRef.current = window.setTimeout(() => {
          clickTimerRef.current = null;
          onToggleCollapsed();
        }, 170);
      }}
      onDoubleClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        if (clickTimerRef.current !== null) {
          window.clearTimeout(clickTimerRef.current);
          clickTimerRef.current = null;
        }
        if ((e.target as HTMLElement).closest('[data-group-collapse-button]')) return;
        if (!(e.target as HTMLElement).closest('[data-group-title-text]')) return;
        onFocusGroup();
        onStartRename();
      }}
      onContextMenu={onContextMenu}
      onAuxClick={onAuxClick}
      onMouseEnter={() => {
        const lock = isTabbarDragVisualLockActive();
        if (isAnyDragging || lock) {
          console.log(
            `[TabDnd:bg] kind=group phase=mouseenter group=${shortDndId(group.id)}` +
            ` action=suppress lock=${lock ? 1 : 0}` +
            ` anyDragging=${isAnyDragging ? 1 : 0}` +
            ` hoveredBefore=${isHovered ? 1 : 0}`
          );
          return;
        }
        console.log(
          `[TabDnd:bg] kind=group phase=mouseenter group=${shortDndId(group.id)}` +
          ` action=accept lock=0 anyDragging=0 hoveredBefore=${isHovered ? 1 : 0}`
        );
        setIsHovered(true);
      }}
      onMouseLeave={() => setIsHovered(false)}
      title={isEditing ? 'Rename group' : 'Click empty row area to collapse / expand. Double-click group name to rename.'}
    >
      {statusMeta && (
        <span
          title={statusMeta.label}
          style={{
            position: 'absolute',
            left: '5px',
            top: 'calc(50% + 1px)',
            transform: 'translateY(-50%)',
            width: `${statusMarkerSize}px`,
            height: `${statusMarkerSize}px`,
            borderRadius: statusMarkerShape === 'square' ? '2px' : '50%',
            backgroundColor: statusMeta.color,
            border: '1px solid rgba(0,0,0,0.4)',
            pointerEvents: 'none',
            zIndex: 2,
          }}
        />
      )}
      <button
        type="button"
        data-group-collapse-button
        aria-label={isCollapsed ? 'Expand group' : 'Collapse group'}
        aria-expanded={!isCollapsed}
        onMouseDown={(e) => {
          e.preventDefault();
          e.stopPropagation();
        }}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onFocusGroup();
          onToggleCollapsed();
        }}
        onDoubleClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onContextMenu(e);
        }}
        onMouseEnter={() => {
          const lock = isTabbarDragVisualLockActive();
          if (isAnyDragging || lock) {
            console.log(
              `[TabDnd:bg] kind=group-icon phase=mouseenter group=${shortDndId(group.id)}` +
              ` action=suppress lock=${lock ? 1 : 0}` +
              ` anyDragging=${isAnyDragging ? 1 : 0}` +
              ` iconHoveredBefore=${isIconHovered ? 1 : 0}`
            );
            return;
          }
          console.log(
            `[TabDnd:bg] kind=group-icon phase=mouseenter group=${shortDndId(group.id)}` +
            ` action=accept lock=0 anyDragging=0 iconHoveredBefore=${isIconHovered ? 1 : 0}`
          );
          setIsIconHovered(true);
        }}
        onMouseLeave={() => setIsIconHovered(false)}
        style={{
          position: 'relative',
          width: 20,
          height: 20,
          flexShrink: 0,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          border: 'none',
          borderRadius: 6,
          padding: 0,
          cursor: 'pointer',
          color: iconAccentActive ? '#c4b5fd' : folderColor,
          backgroundColor: iconAccentActive ? 'rgba(139,92,246,0.18)' : 'transparent',
          boxShadow: isIconHovered ? 'inset 0 0 0 1px rgba(196,181,253,0.22)' : 'inset 0 0 0 1px rgba(196,181,253,0)',
          transition: 'background-color 120ms ease, color 120ms ease, box-shadow 120ms ease',
        }}
        title={isCollapsed ? 'Expand group' : 'Collapse group'}
      >
        <Folder
          size={14}
          strokeWidth={2}
          style={{
            transition: 'color 120ms ease',
          }}
        />
        <ChevronDown
          size={9}
          strokeWidth={2.4}
          style={{
            position: 'absolute',
            right: 2,
            bottom: 1,
            color: '#ddd6fe',
            opacity: iconAccentActive ? 1 : 0.62,
            transform: `rotate(${isCollapsed ? -90 : 0}deg)`,
            transformOrigin: 'center',
            transition: 'transform 140ms ease, opacity 120ms ease',
          }}
        />
      </button>
      {isEditing ? (
        <input
          ref={inputRef}
          type="text"
          className="bg-[#333] border border-accent rounded px-2 py-0.5 text-white outline-none"
          style={{ flex: 1, minWidth: 0, fontSize: 'inherit' }}
          value={editValue}
          onChange={(e) => onEditChange(e.target.value)}
          onBlur={onEditSubmit}
          onKeyDown={onEditKeyDown}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
        />
      ) : (
        <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', whiteSpace: 'nowrap', fontSize: 'inherit' }}>
          <span
            data-group-title-text
            style={{
              display: 'inline-block',
              maxWidth: '100%',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              verticalAlign: 'bottom',
            }}
          >
            {group.name}
          </span>
        </span>
      )}
      <span style={{ color: '#71717a', fontSize: Math.max(10, tabsFontSize - 2), flexShrink: 0 }}>{count}</span>
    </div>
  );
});

// Empty area drop zone - for dropping at the end of tabs (works for both reorder and move from utility)
const EmptyDropZone = memo(({ onDropMain, onDropFromUtility, onDropGroup, onHoverChange, onDoubleClick, onContextMenu, orientation = 'horizontal' }: {
  onDropMain: (tabId: string) => void;
  onDropFromUtility: (tabId: string) => void;
  onDropGroup?: (groupId: string) => void;
  onHoverChange: (isOver: boolean) => void;
  onDoubleClick?: () => void;
  onContextMenu?: (e: React.MouseEvent) => void;
  orientation?: 'horizontal' | 'vertical';
}) => {
  const ref = useRef<HTMLDivElement>(null);
  const [isOver, setIsOver] = useState(false);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;

    return dropTargetForElements({
      element,
      getData: () => ({ type: 'EMPTY_ZONE' }),
      canDrop: ({ source }) => source.data.type === 'TAB' || source.data.type === 'TAB_GROUP',
      onDragEnter: () => {
        setIsOver(true);
        onHoverChange(true);
      },
      onDragLeave: () => {
        setIsOver(false);
        onHoverChange(false);
      },
      onDrop: ({ source }) => {
        const data = source.data as DragData;
        if (data.type === 'TAB_GROUP') {
          onDropGroup?.(data.groupId);
        } else if (data.zone === 'main') {
          onDropMain(data.id);
        } else if (data.zone === 'utility') {
          onDropFromUtility(data.id);
        }
        setIsOver(false);
        onHoverChange(false);
      },
    });
  }, [onDropMain, onDropFromUtility, onDropGroup, onHoverChange]);

  // Horizontal: fill remaining row (h-full flex-1 min-w-[30px]).
  // Vertical: fill remaining column space only. Creation moved to right-click menu
  // so the sidebar doesn't show a fake tab row.
  if (orientation === 'vertical') {
    return (
      <div
        ref={ref}
        className="flex-1 w-full min-h-[30px]"
        onContextMenu={onContextMenu}
        onDoubleClick={onDoubleClick}
      />
    );
  }

  return (
    <div
      ref={ref}
      className={`h-full flex-1 min-w-[30px] transition-colors ${isOver ? 'bg-white/10' : ''}`}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu}
    />
  );
});

// Empty main zone - when all tabs are in utility
const EmptyMainZone = memo(({ onDrop, onContextMenu, onDoubleClick }: {
  onDrop: (tabId: string) => void;
  onContextMenu?: (e: React.MouseEvent) => void;
  onDoubleClick?: () => void;
}) => {
  const ref = useRef<HTMLDivElement>(null);
  const [isOver, setIsOver] = useState(false);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;

    return dropTargetForElements({
      element,
      getData: () => ({ type: 'EMPTY_MAIN' }),
      canDrop: ({ source }) => {
        const data = source.data as DragData;
        return data.type === 'TAB' && data.zone === 'utility';
      },
      onDragEnter: () => setIsOver(true),
      onDragLeave: () => setIsOver(false),
      onDrop: ({ source }) => {
        const data = source.data as DragData;
        onDrop(data.id);
        setIsOver(false);
      },
    });
  }, [onDrop]);

  return (
    <div
      ref={ref}
      className={`flex-1 h-full flex items-center justify-center text-[#666] text-sm transition-colors ${isOver ? 'bg-white/10' : ''}`}
      onContextMenu={onContextMenu}
      onDoubleClick={onDoubleClick}
    >
      {isOver && <span>Drop here</span>}
    </div>
  );
});

// Utils Button Drop Target - drop here to add tab to utility zone
const UtilsButtonDropTarget = memo(({
  children,
  onDropToUtils,
  onHoverDrag
}: {
  children: React.ReactNode;
  onDropToUtils: (tabId: string) => void;
  onHoverDrag: (isOver: boolean) => void;
}) => {
  const ref = useRef<HTMLDivElement>(null);
  const [isOver, setIsOver] = useState(false);
  const hoverTimerRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;

    return dropTargetForElements({
      element,
      getData: () => ({ type: 'UTILS_BUTTON' }),
      canDrop: ({ source }) => {
        const data = source.data as DragData;
        // Only allow dropping main tabs (not already utility)
        return data.type === 'TAB' && data.zone === 'main';
      },
      onDragEnter: () => {
        setIsOver(true);
        // Open Utils dropdown after short delay
        hoverTimerRef.current = setTimeout(() => {
          onHoverDrag(true);
        }, 300);
      },
      onDragLeave: () => {
        setIsOver(false);
        if (hoverTimerRef.current) {
          clearTimeout(hoverTimerRef.current);
          hoverTimerRef.current = null;
        }
      },
      onDrop: ({ source }) => {
        const data = source.data as DragData;
        onDropToUtils(data.id);
        setIsOver(false);
        if (hoverTimerRef.current) {
          clearTimeout(hoverTimerRef.current);
          hoverTimerRef.current = null;
        }
      },
    });
  }, [onDropToUtils, onHoverDrag]);

  return (
    <div ref={ref} className={`h-full flex items-center ${isOver ? 'ring-2 ring-white ring-inset rounded' : ''} transition-all`}>
      {children}
    </div>
  );
});

function buildVerticalRows(mainTabs: TabData[], tabGroups: TabGroup[]): VerticalRow[] {
  const rows: VerticalRow[] = [];
  const groupById = new Map(tabGroups.map(group => [group.id, group]));
  const tabById = new Map(mainTabs.map(tab => [tab.id, tab]));
  const tabIds = new Set(mainTabs.map(tab => tab.id));
  const tabsByGroup = new Map<string, TabData[]>();
  for (const tab of mainTabs) {
    const groupId = tab.groupId && groupById.has(tab.groupId) ? tab.groupId : undefined;
    if (!groupId) continue;
    const tabs = tabsByGroup.get(groupId) || [];
    tabs.push(tab);
    tabsByGroup.set(groupId, tabs);
  }
  const emptyGroupsByAnchor = new Map<string, TabGroup[]>();
  const trailingEmptyGroups: TabGroup[] = [];
  for (const group of tabGroups) {
    if (tabsByGroup.has(group.id)) continue;
    const rawAnchorTabId = group.anchorTabId && tabIds.has(group.anchorTabId) ? group.anchorTabId : undefined;
    const anchorTab = rawAnchorTabId ? tabById.get(rawAnchorTabId) : undefined;
    const anchorGroupId = anchorTab?.groupId && tabsByGroup.has(anchorTab.groupId) ? anchorTab.groupId : undefined;
    const anchorTabId = anchorGroupId
      ? tabsByGroup.get(anchorGroupId)?.[0]?.id
      : rawAnchorTabId;
    if (!anchorTabId) {
      trailingEmptyGroups.push(group);
      continue;
    }
    const anchored = emptyGroupsByAnchor.get(anchorTabId) || [];
    anchored.push(group);
    emptyGroupsByAnchor.set(anchorTabId, anchored);
  }
  const renderedGroups = new Set<string>();
  const pushEmptyGroupsAnchoredTo = (tabId: string) => {
    const groups = emptyGroupsByAnchor.get(tabId);
    if (!groups) return;
    for (const group of groups) {
      renderedGroups.add(group.id);
      rows.push({ type: 'group', group, tabs: [], index: rows.length });
    }
  };

  for (const tab of mainTabs) {
    pushEmptyGroupsAnchoredTo(tab.id);
    const groupId = tab.groupId && groupById.has(tab.groupId) ? tab.groupId : undefined;
    if (!groupId) {
      rows.push({ type: 'tab', tab, index: rows.length });
      continue;
    }
    if (renderedGroups.has(groupId)) continue;
    const group = groupById.get(groupId)!;
    const tabs = tabsByGroup.get(groupId) || [];
    renderedGroups.add(groupId);
    rows.push({ type: 'group', group, tabs, index: rows.length });
  }

  for (const group of trailingEmptyGroups) {
    if (!renderedGroups.has(group.id)) {
      rows.push({ type: 'group', group, tabs: [], index: rows.length });
    }
  }

  return rows;
}

function orderTabsWithVisualChildren(mainTabs: TabData[]): TabData[] {
  const byId = new Map(mainTabs.map(tab => [tab.id, tab]));
  const childrenByParent = new Map<string, TabData[]>();
  const roots: TabData[] = [];

  for (const tab of mainTabs) {
    const parentId = tab.visualParentTabId;
    if (!parentId || !byId.has(parentId) || parentId === tab.id) {
      roots.push(tab);
      continue;
    }
    const children = childrenByParent.get(parentId) || [];
    children.push(tab);
    childrenByParent.set(parentId, children);
  }

  const ordered: TabData[] = [];
  const seen = new Set<string>();
  const visit = (tab: TabData) => {
    if (seen.has(tab.id)) return;
    seen.add(tab.id);
    ordered.push(tab);
    for (const child of childrenByParent.get(tab.id) || []) {
      visit(child);
    }
  };

  for (const tab of roots) visit(tab);
  for (const tab of mainTabs) visit(tab);
  return ordered;
}

function buildVisualDepthMap(mainTabs: TabData[]): Map<string, number> {
  const byId = new Map(mainTabs.map(tab => [tab.id, tab]));
  const cache = new Map<string, number>();
  const depthOf = (tab: TabData, trail = new Set<string>()): number => {
    const cached = cache.get(tab.id);
    if (cached !== undefined) return cached;
    const parentId = tab.visualParentTabId;
    if (!parentId || parentId === tab.id || trail.has(tab.id) || !byId.has(parentId)) {
      cache.set(tab.id, 0);
      return 0;
    }
    trail.add(tab.id);
    const parent = byId.get(parentId)!;
    const depth = Math.min(4, depthOf(parent, trail) + 1);
    cache.set(tab.id, depth);
    return depth;
  };
  for (const tab of mainTabs) depthOf(tab);
  return cache;
}

function TabBar({ projectId, layout = 'horizontal' }: TabBarProps) {
  const isVerticalLayout = layout === 'vertical';
  // Use individual selectors to minimize re-renders
  const openProjects = useWorkspaceStore((state) => state.openProjects);
  const pendingEditTabId = useWorkspaceStore((state) => state.pendingEditTabId);
  const createTab = useWorkspaceStore((state) => state.createTab);
  const createTabAfterCurrent = useWorkspaceStore((state) => state.createTabAfterCurrent);
  const closeTab = useWorkspaceStore((state) => state.closeTab);
  const switchTab = useWorkspaceStore((state) => state.switchTab);
  const setActiveTabGroup = useWorkspaceStore((state) => state.setActiveTabGroup);
  const renameTab = useWorkspaceStore((state) => state.renameTab);
  const renameTabGroup = useWorkspaceStore((state) => state.renameTabGroup);
  const toggleTabGroupCollapsed = useWorkspaceStore((state) => state.toggleTabGroupCollapsed);
  const setTabGroupColor = useWorkspaceStore((state) => state.setTabGroupColor);
  const setTabGroupSessionStatus = useWorkspaceStore((state) => state.setTabGroupSessionStatus);
  const deleteTabGroup = useWorkspaceStore((state) => state.deleteTabGroup);
  const setTabColor = useWorkspaceStore((state) => state.setTabColor);
  const setTabSessionStatus = useWorkspaceStore((state) => state.setTabSessionStatus);
  const setTabCompletionNotificationArmed = useWorkspaceStore((state) => state.setTabCompletionNotificationArmed);
  const setTabCompletionNotificationPersistent = useWorkspaceStore((state) => state.setTabCompletionNotificationPersistent);
  const setTabRestartAfterTarget = useWorkspaceStore((state) => state.setTabRestartAfterTarget);
  const setTabRestartAfterArmed = useWorkspaceStore((state) => state.setTabRestartAfterArmed);
  const setTabRestartAfterPersistent = useWorkspaceStore((state) => state.setTabRestartAfterPersistent);
  const toggleTabUtility = useWorkspaceStore((state) => state.toggleTabUtility);
  const reorderInZone = useWorkspaceStore((state) => state.reorderInZone);
  const moveTabToZone = useWorkspaceStore((state) => state.moveTabToZone);
  const createTabGroup = useWorkspaceStore((state) => state.createTabGroup);
  const applyTabLayout = useWorkspaceStore((state) => state.applyTabLayout);
  const setTabVisualParent = useWorkspaceStore((state) => state.setTabVisualParent);
  const toggleTabSelection = useWorkspaceStore((state) => state.toggleTabSelection);
  const selectTabRange = useWorkspaceStore((state) => state.selectTabRange);
  const clearSelection = useWorkspaceStore((state) => state.clearSelection);
  
  const { projects } = useProjectsStore();
  const setProjectView = useWorkspaceStore((state) => state.setProjectView);
  const setSidebarOpen = useWorkspaceStore((state) => state.setSidebarOpen);
  const getSidebarState = useWorkspaceStore((state) => state.getSidebarState);
  const tabsFontSize = useUIStore((state) => state.tabsFontSize);
  const showToast = useUIStore((state) => state.showToast);
  const reopenPulseActive = useUIStore((state) => state.reopenPulseActive);
  // Configurable session statuses (Settings → Системные). Используется в context menu
  // для рендера превью трёх точек + полного submenu со статусами.
  const ctxSessionStatuses = useUIStore((state) => state.sessionStatuses);
  // Settings → Размеры → ТАБЫ → Терминал. Зазор между табами в TabSidebar (вертикальный layout).
  // Также используется как padding контейнера, чтобы первая/последняя вкладка не липли к краю.
  const tabSidebarGap = useUIStore((state) => state.tabGeometry.gap);
  const tabGeometry = useUIStore((state) => state.tabGeometry);
  // tabNotes* font / padding теперь читаются внутри TabPreviewPopover.

  const [editingTabId, setEditingTabId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const [editOriginalValue, setEditOriginalValue] = useState('');
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; tabId: string } | null>(null);
  const [editingGroupId, setEditingGroupId] = useState<string | null>(null);
  const [groupEditValue, setGroupEditValue] = useState('');
  const [groupContextMenu, setGroupContextMenu] = useState<{ x: number; y: number; groupId: string } | null>(null);
  const [emptyContextMenu, setEmptyContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [contextScripts, setContextScripts] = useState<string[]>([]);
  const [contextShScripts, setContextShScripts] = useState<string[]>([]);
  const [contextFavoriteId, setContextFavoriteId] = useState<number | null>(null);
  const [utilityExpanded, setUtilityExpanded] = useState(false);
  const [utilityOpenedManually, setUtilityOpenedManually] = useState(false); // Track if opened by click vs hover
  const utilityHoverTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const utilityCloseTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const [emptyZoneHovered, setEmptyZoneHovered] = useState(false);
  const [dragPreview, setDragPreview] = useState<DragPreviewLayout | null>(null);
  const dragPreviewKeyRef = useRef<string>('');
  const verticalDragGeometryRef = useRef<VerticalDragGeometry | null>(null);
  const verticalDragAnchorRef = useRef<VerticalDragAnchor | null>(null);
  const verticalDragGeometrySeqRef = useRef(0);
  const verticalDragResolveTraceRef = useRef<string | null>(null);
  const verticalMainListRef = useRef<HTMLDivElement>(null);
  const verticalRowFlipRectsRef = useRef<Map<string, VerticalRowFlipRect>>(new Map());
  const verticalRowAnimationsRef = useRef<Map<string, Animation>>(new Map());
  const groupCollapseFlipSuppressUntilRef = useRef(0);
  const tabDndLogUntilRef = useRef(0);
  const [processStatus, setProcessStatus] = useState<Map<string, boolean>>(new Map());
  const [titleRefreshInFlight, setTitleRefreshInFlight] = useState<Set<string>>(new Set());
  const tabTitleNamingIds = useWorkspaceStore((state) => state.tabTitleNamingIds);
  const setTabTitleNaming = useWorkspaceStore((state) => state.setTabTitleNaming);
  // Tabs currently inside a deterministic stop/restart cycle. While in this set
  // the Restart / Stop buttons render disabled with a wait-cursor, so the user
  // can't fire a second stop while the first one is still polling for descendants
  // to die. Populated synchronously when handleRestart/handleStop is called,
  // cleared on `terminal:stop-progress { phase: 'done' }`.
  const [restartInFlight, setRestartInFlight] = useState<Set<string>>(new Set());
  const restartInFlightRef = useRef<Set<string>>(new Set());
  const [sessionStatus, setSessionStatus] = useState<Map<string, boolean>>(new Map());
  const [claudeBusyMap, setClaudeBusyMap] = useState<Map<string, boolean>>(new Map());
  const [geminiBusyMap, setGeminiBusyMap] = useState<Map<string, boolean>>(new Map());
  const [codexBusyMap, setCodexBusyMap] = useState<Map<string, boolean>>(new Map());
  const codexBusyRef = useRef<Map<string, boolean>>(new Map());
  const [pasteBusyMap, setPasteBusyMap] = useState<Map<string, boolean>>(new Map());
  const claudeSpinnerVisualIdleTimersRef = useRef<Map<string, number>>(new Map());
  // Awaiting-user-input: Claude called AskUserQuestion and is blocked waiting for
  // the human to answer. Deterministic, bracketed by PreToolUse/PostToolUse hooks
  // (main.js → claude:awaiting-input). Distinct from busy: a question is a special
  // sub-state of busy (awaiting ⊆ busy), rendered as a purple glow instead of the
  // plain "thinking" shimmer. See fact-claude-awaiting-input.md.
  const [awaitingMap, setAwaitingMap] = useState<Map<string, boolean>>(new Map());
  const hasVisibleProcessBar = (tab: TabData): boolean => {
    return processStatus.get(tab.id) || false;
  };
  const isTabTurnBusy = (tab: TabData): boolean => {
    const pasteBusy = pasteBusyMap.get(tab.id) || false;
    if (tab.commandType === 'gemini') return (geminiBusyMap.get(tab.id) || false) || pasteBusy;
    if (tab.commandType === 'codex') return (codexBusyMap.get(tab.id) || false) || pasteBusy;
    return (claudeBusyMap.get(tab.id) || false) || pasteBusy;
  };
  const inputRef = useRef<HTMLInputElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);
  const [contextMenuPos, setContextMenuPos] = useState<{ x: number; y: number }>({ x: 0, y: 0 });

  // CMD+hover notes preview (unified hook)
  const isCmdPressed = useCmdKey();
  const notesPopover = useCmdHoverPopover<string>(isCmdPressed);
  const [isMouseInTabBar, setIsMouseInTabBar] = useState(false);

  // Per-tab notes-slideout open state. `notesPanelOpenTabs` is a Record<tabId,bool>
  // but the one-at-a-time policy in useUIStore.setNotesPanelOpen means at most one
  // entry is true. We compute the open tab id once and pass derived flags to each TabItem.
  const notesPanelOpenTabs = useUIStore((s) => s.notesPanelOpenTabs);
  const openSlideoutTabId = useMemo(() => {
    for (const [tid, on] of Object.entries(notesPanelOpenTabs)) if (on) return tid;
    return null;
  }, [notesPanelOpenTabs]);
  const anySlideoutOpen = openSlideoutTabId !== null;

  const workspace = openProjects.get(projectId);
  const viewingSubAgentTabId = workspace?.viewingSubAgentTabId ?? null;
  const viewingSubAgentParentId = viewingSubAgentTabId ? workspace?.tabs.get(viewingSubAgentTabId)?.parentTabId ?? null : null;
  const project = projects[projectId];
  const currentView = workspace?.currentView || 'terminal';

  // Selection state
  const selectedTabIds = workspace?.selectedTabIds || [];
  const isMultiSelect = selectedTabIds.length > 1;

  const confirmCloseTabs = async (tabIds: string[]): Promise<boolean> => {
    if (!workspace) return false;
    const runningProcesses: { id: string; name: string }[] = [];
    const busyAiTabs: { id: string; name: string }[] = [];

    for (const id of tabIds) {
      const tab = workspace.tabs.get(id);
      if (!tab) continue;
      const aiTab = isAiRuntimeTab(tab);
      const aiBusy = isTabTurnBusy(tab);
      if (aiTab && aiBusy) {
        busyAiTabs.push({ id, name: tab.name || 'AI' });
        continue;
      }
      if (tab.tabType === 'claude-sdk' || tab.tabType === 'file') continue;

      const state = await ipcRenderer.invoke('terminal:getCommandState', id);
      if (!state?.isRunning) continue;

      const info = await ipcRenderer.invoke('terminal:hasRunningProcess', id).catch(() => null);
      if (aiTab && (!info?.hasProcess || isAiForegroundProcess(info))) continue;

      runningProcesses.push({ id, name: info?.processName || tab.name || 'unknown' });
    }

    if (runningProcesses.length === 0 && busyAiTabs.length === 0) return true;

    const parts: string[] = [];
    if (busyAiTabs.length) {
      parts.push(`${busyAiTabs.length} AI-вкладк(и) сейчас отвечают:\n${busyAiTabs.map(t => `• ${t.name}`).join('\n')}`);
    }
    if (runningProcesses.length) {
      parts.push(`${runningProcesses.length} вкладк(и) с обычными процессами:\n${runningProcesses.map(t => `• ${t.name}`).join('\n')}`);
    }
    return window.confirm(`${parts.join('\n\n')}\n\nОстановить и закрыть ${tabIds.length} вкладк(и)?`);
  };

  const handleTabClick = (e: React.MouseEvent, tabId: string) => {
    if (e.shiftKey) {
      selectTabRange(projectId, tabId);
    } else if (e.metaKey || e.ctrlKey) {
      toggleTabSelection(projectId, tabId, true);
    } else {
      const clickedTab = workspace?.tabs.get(tabId);
      if (clickedTab?.tabType === 'file' && tabId === workspace?.activeTabId) {
        const historyTargetId = [...(workspace.tabHistory || [])]
          .reverse()
          .find((id) => id !== tabId && workspace.tabs.get(id)?.tabType !== 'file');
        const fallbackParentId = clickedTab.visualParentTabId && workspace.tabs.has(clickedTab.visualParentTabId)
          ? clickedTab.visualParentTabId
          : null;
        const returnTargetId = historyTargetId || fallbackParentId;
        if (returnTargetId) {
          console.warn('[TabBar:click] file-tab-toggle-back tabId=' + tabId + ' target=' + returnTargetId + ' ts=' + Date.now());
          switchTab(projectId, returnTargetId);
          setProjectView(projectId, 'terminal');
          return;
        }
      }
      if (currentView === 'home' && tabId === workspace?.activeTabId) {
        console.warn('[TabBar:click] return-from-home active-tab project=' + projectId + ' tabId=' + tabId + ' ts=' + Date.now());
      }
      console.warn('[TabBar:click] switchTab tabId=' + tabId + ' ts=' + Date.now());
      // If clicking the already-active Gemini tab while viewing a sub-agent → return to Gemini
      if (tabId === workspace?.activeTabId && viewingSubAgentTabId) {
        useWorkspaceStore.getState().setViewingSubAgent(null);
      }
      switchTab(projectId, tabId);
      // Always switch to terminal view when clicking a tab
      // (fixes: clicking tab from Home view didn't switch currentView from 'home' to 'terminal')
      setProjectView(projectId, 'terminal');
    }
  };


  // CMD+hover: callback for tab hover changes (bridge via hook)
  const handleTabHoverChange = useCallback((tabId: string, hovering: boolean, rect?: DOMRect) => {
    if (hovering && rect) {
      notesPopover.setHovered(tabId, rect);
    } else {
      notesPopover.clearHovered(tabId);
    }
  }, [notesPopover.setHovered, notesPopover.clearHovered]);

  // OSC 133 Event-driven process status (replaces polling)
  // Stable listeners — subscribe once, never re-create
  useEffect(() => {
    const handleCommandStarted = (_: any, { tabId }: { tabId: string }) => {
      console.warn('[TabBar:ProcessStatus] tabId=' + tabId.slice(-8) + ' running=true source=command-started');
      setProcessStatus(prev => {
        const next = new Map(prev);
        next.set(tabId, true);
        return next;
      });
    };

    const handleCommandFinished = (_: any, { tabId }: { tabId: string }) => {
      console.warn('[TabBar:ProcessStatus] tabId=' + tabId.slice(-8) + ' running=false source=command-finished');
      setProcessStatus(prev => {
        const next = new Map(prev);
        next.set(tabId, false);
        return next;
      });
    };

    const handleSessionDetected = (_: any, data: { tabId: string; sessionId: string }) => {
      console.warn('[TabBar:SessionStatus] tabId=' + data.tabId.slice(-8) + ' session=' + String(data.sessionId || '').slice(0, 8) + ' detected=true');
      setSessionStatus(prev => {
        const next = new Map(prev);
        next.set(data.tabId, true);
        return next;
      });
    };

    const applyClaudeVisualBusy = (tabId: string, busy: boolean) => {
      setClaudeBusyMap(prev => {
        if (prev.get(tabId) === busy) return prev;
        const next = new Map(prev);
        next.set(tabId, busy);
        return next;
      });
    };

    const handleClaudeBusy = (_: any, { tabId, busy, reason }: { tabId: string; busy: boolean; reason?: string }) => {
      console.warn('[TabBar:BusyState] tabId=' + tabId.slice(-8) + ' busy=' + busy + (reason ? ' reason=' + reason : ''));
      const timers = claudeSpinnerVisualIdleTimersRef.current;
      const pendingTimer = timers.get(tabId);
      if (pendingTimer !== undefined) {
        window.clearTimeout(pendingTimer);
        timers.delete(tabId);
      }

      if (!busy && reason === 'spinner') {
        const timer = window.setTimeout(() => {
          timers.delete(tabId);
          applyClaudeVisualBusy(tabId, false);
        }, CLAUDE_SPINNER_VISUAL_IDLE_GRACE_MS);
        timers.set(tabId, timer);
        return;
      }

      applyClaudeVisualBusy(tabId, busy);
    };

    const handleGeminiBusy = (_: any, { tabId, busy }: { tabId: string; busy: boolean }) => {
      console.warn('[TabBar:GeminiBusyState] tabId=' + tabId.slice(-8) + ' busy=' + busy);
      setGeminiBusyMap(prev => {
        if (prev.get(tabId) === busy) return prev;
        const next = new Map(prev);
        next.set(tabId, busy);
        return next;
      });
    };

    const handleCodexBusy = (_: any, { tabId, busy, reason }: { tabId: string; busy: boolean; reason?: string }) => {
      console.warn('[TabBar:CodexBusyState] tabId=' + tabId.slice(-8) + ' busy=' + busy + (reason ? ' reason=' + reason : ''));
      const prevBusy = codexBusyRef.current.get(tabId) || false;
      codexBusyRef.current.set(tabId, busy);
      if (busy) {
        useWorkspaceStore.getState().markRestartAfterTriggerBusy(tabId);
      } else if (prevBusy) {
        const naturalEnd = isNaturalRestartAfterEnd(reason);
        const restartTargetIds = useWorkspaceStore.getState().consumeRestartAfterTriggerIdle(tabId, naturalEnd);
        for (const targetId of restartTargetIds) {
          if (targetId === tabId) continue;
          console.warn('[TabBar:RestartAfter] trigger=' + tabId.slice(-8) + ' target=' + targetId.slice(-8) + ' reason=' + (reason || 'natural'));
          void runDeterministicStop(targetId, true);
        }
      }
      setCodexBusyMap(prev => {
        if (prev.get(tabId) === busy) return prev;
        const next = new Map(prev);
        next.set(tabId, busy);
        return next;
      });
    };

    const handlePasteBusy = (_: any, { tabId, busy }: { tabId: string; busy: boolean }) => {
      console.warn('[TabBar:PasteBusyState] tabId=' + tabId.slice(-8) + ' busy=' + busy);
      setPasteBusyMap(prev => {
        if (prev.get(tabId) === busy) return prev;
        const next = new Map(prev);
        next.set(tabId, busy);
        return next;
      });
    };

    const handleAwaitingInput = (_: any, { tabId, awaiting }: { tabId: string; awaiting: boolean }) => {
      console.warn('[TabBar:Awaiting] tabId=' + tabId.slice(-8) + ' awaiting=' + awaiting);
      setAwaitingMap(prev => {
        if ((prev.get(tabId) || false) === awaiting) return prev;
        const next = new Map(prev);
        // Delete (not set-false) so the map never accumulates tombstones — mirrors
        // App.tsx awaitingTabs. "not awaiting" = key absent.
        if (awaiting) next.set(tabId, true); else next.delete(tabId);
        return next;
      });
    };

    // Safety net for invariant awaiting ⊆ busy: any turn-end (interrupt, watchdog,
    // manual-stop, Stop, StopFailure, process exit) emits claude:busy-state
    // busy:false. If a question was still marked awaiting (e.g. user pressed Esc to
    // cancel the whole turn instead of answering), clear it here — main may not get
    // a PostToolUse in that path. Cheap: only mutates when an awaiting flag is set.
    const handleClaudeBusyClearAwaiting = (_: any, { tabId, busy, reason }: { tabId: string; busy: boolean; reason?: string }) => {
      if (busy || reason === 'spinner') return;
      setAwaitingMap(prev => {
        if (!prev.get(tabId)) return prev;
        const next = new Map(prev);
        next.delete(tabId);
        return next;
      });
    };

    // Deterministic stop/restart: lock the ↻ / Stop buttons for the affected
    // tab until main reports phase='done'. Without this the user can fire a
    // second Stop while the first one is still polling lsof → races.
    const handleStopProgress = (_: any, { tabId, phase }: { tabId: string; phase: string }) => {
      if (phase === 'done') {
        const refNext = new Set(restartInFlightRef.current);
        refNext.delete(tabId);
        restartInFlightRef.current = refNext;
        setRestartInFlight(prev => {
          if (!prev.has(tabId)) return prev;
          const next = new Set(prev);
          next.delete(tabId);
          return next;
        });
      }
    };

    ipcRenderer.on('terminal:command-started', handleCommandStarted);
    ipcRenderer.on('terminal:command-finished', handleCommandFinished);
    ipcRenderer.on('claude:session-detected', handleSessionDetected);
    ipcRenderer.on('claude:busy-state', handleClaudeBusy);
    ipcRenderer.on('claude:busy-state', handleClaudeBusyClearAwaiting);
    ipcRenderer.on('gemini:busy-state', handleGeminiBusy);
    ipcRenderer.on('codex:busy-state', handleCodexBusy);
    ipcRenderer.on('claude:paste-busy', handlePasteBusy);
    ipcRenderer.on('claude:awaiting-input', handleAwaitingInput);
    ipcRenderer.on('terminal:stop-progress', handleStopProgress);

    return () => {
      ipcRenderer.removeListener('terminal:command-started', handleCommandStarted);
      ipcRenderer.removeListener('terminal:command-finished', handleCommandFinished);
      ipcRenderer.removeListener('claude:session-detected', handleSessionDetected);
      ipcRenderer.removeListener('claude:busy-state', handleClaudeBusy);
      ipcRenderer.removeListener('claude:busy-state', handleClaudeBusyClearAwaiting);
      ipcRenderer.removeListener('gemini:busy-state', handleGeminiBusy);
      ipcRenderer.removeListener('codex:busy-state', handleCodexBusy);
      ipcRenderer.removeListener('claude:paste-busy', handlePasteBusy);
      ipcRenderer.removeListener('claude:awaiting-input', handleAwaitingInput);
      ipcRenderer.removeListener('terminal:stop-progress', handleStopProgress);
      claudeSpinnerVisualIdleTimersRef.current.forEach((timer) => window.clearTimeout(timer));
      claudeSpinnerVisualIdleTimersRef.current.clear();
    };
  }, []); // Stable — no re-subscriptions

  // Initial load + sync when tabs are added/removed
  // Merges into existing Map instead of replacing it
  useEffect(() => {
    if (!workspace) return;

    const tabIds = Array.from(workspace.tabs.keys());
    const syncStartedAt = performance.now();
    const syncStartAbs = performance.timeOrigin + syncStartedAt;
    const tabSummary = tabIds.map((tabId) => {
      const tab = workspace.tabs.get(tabId);
      return tabId.slice(-8) + ':' + (tab?.commandType || tab?.tabType || 'unknown');
    }).join(',');
    console.warn(
      `[Perf:TabBarStatusSync] start project=${projectId.slice(-12)}` +
      ` startAbs=${syncStartAbs.toFixed(1)}` +
      ` count=${tabIds.length} tabs=${tabSummary}`
    );

    const syncStatus = async () => {
      await Promise.all(
        tabIds.map(async (tabId) => {
          try {
            const tab = workspace.tabs.get(tabId);
            const state = await ipcRenderer.invoke('terminal:getCommandState', {
              tabId,
              caller: 'TabBar.statusSync',
              expectedProcess: 'codex',
              allowProcessTreeLookup: tab?.commandType === 'codex',
            });
            setProcessStatus(prev => {
              if (prev.get(tabId) === state.isRunning) return prev;
              const next = new Map(prev);
              next.set(tabId, state.isRunning);
              return next;
            });
          } catch {
            // Only set false if not already tracked
            setProcessStatus(prev => {
              if (prev.has(tabId)) return prev;
              const next = new Map(prev);
              next.set(tabId, false);
              return next;
            });
          }
          const tab = workspace?.tabs.get(tabId);
          setSessionStatus(prev => {
            const val = !!tab?.claudeSessionId;
            if (prev.get(tabId) === val) return prev;
            const next = new Map(prev);
            next.set(tabId, val);
            return next;
          });
        })
      );
      console.warn(
        `[Perf:TabBarStatusSync] done project=${projectId.slice(-12)}` +
        ` startAbs=${syncStartAbs.toFixed(1)}` +
        ` endAbs=${(performance.timeOrigin + performance.now()).toFixed(1)}` +
        ` count=${tabIds.length}` +
        ` durMs=${(performance.now() - syncStartedAt).toFixed(1)}`
      );
    };
    syncStatus();
  }, [workspace?.tabs.size]); // Sync new tabs, but never clobber existing state

  const captureVerticalDragGeometry = useCallback((reason = 'manual'): VerticalDragGeometry | null => {
    if (!isVerticalLayout) return null;
    const scroller = scrollContainerRef.current;
    const list = scroller?.querySelector<HTMLElement>('[data-vertical-main-list]');
    if (!scroller || !list) return null;

    const currentWorkspace = useWorkspaceStore.getState().openProjects.get(projectId);
    const memberIdsByGroup = new Map<string, string[]>();
    if (currentWorkspace) {
      for (const tab of currentWorkspace.tabs.values()) {
        if (tab.parentTabId || tab.isUtility || !tab.groupId) continue;
        const members = memberIdsByGroup.get(tab.groupId) || [];
        members.push(tab.id);
        memberIdsByGroup.set(tab.groupId, members);
      }
    }

    const rows: VerticalDragGeometry['rows'] = [];
    for (const rowEl of Array.from(list.querySelectorAll<HTMLElement>(':scope > [data-vertical-row]'))) {
      const rowType = rowEl.dataset.rowType;
      if (rowType === 'tab') {
        const tabId = rowEl.dataset.tabId;
        const tabEl = rowEl.querySelector<HTMLElement>('[data-tab-item]');
        if (!tabId || !tabEl) continue;
        rows.push({ type: 'tab', tabId, rect: snapRect(tabEl) });
        continue;
      }

      if (rowType === 'group') {
        const groupId = rowEl.dataset.groupId;
        const header = rowEl.querySelector<HTMLElement>('[data-tab-group-header]');
        if (!groupId || !header) continue;
        const isCollapsed = rowEl.dataset.groupCollapsed === 'true';
        const memberIds = memberIdsByGroup.get(groupId) || [];
        const tabRows = isCollapsed
          ? []
          : Array.from(rowEl.querySelectorAll<HTMLElement>('[data-tab-group-body] [data-tab-item]'))
            .map(el => {
              const tabId = el.dataset.tabId;
              return tabId ? { tabId, rect: snapRect(el) } : null;
            })
            .filter((row): row is { tabId: string; rect: RectSnap } => !!row);
        rows.push({ type: 'group', groupId, rect: snapRect(rowEl), header: snapRect(header), collapsed: isCollapsed, memberIds, tabRows });
      }
    }

    const geometry = {
      id: ++verticalDragGeometrySeqRef.current,
      reason,
      capturedAtMs: performance.now(),
      list: snapRect(scroller),
      rows
    };
    console.log(`[TabDnd:capture] project=${shortDndId(projectId)} ${summarizeVerticalGeometry(geometry)}`);
    return geometry;
  }, [isVerticalLayout, projectId]);

  // Tab adoption (Gemini → Claude sub-agent) was removed; no drop is an adopt target.
  const isAdoptDropTarget = useCallback((_sourceData: DragData, _targetData: any): boolean => false, []);

  const resolveStaticVerticalPreview = useCallback((sourceData: DragData, clientX: number, clientY: number, targetData?: any): DragPreviewLayout | null => {
    const resolveStartedAt = performance.now();
    const rejectResolve = (reason: string) => {
      verticalDragResolveTraceRef.current =
        `resolve reject=${reason} durMs=${(performance.now() - resolveStartedAt).toFixed(1)}`;
      return null;
    };

    if (!isVerticalLayout) return rejectResolve('not-vertical');
    if (sourceData.projectId && sourceData.projectId !== projectId) return rejectResolve('foreign-project');
    if (sourceData.zone !== 'main') return rejectResolve('non-main-zone');
    if (isAdoptDropTarget(sourceData, targetData)) return rejectResolve('adopt-target');

    let geometry = verticalDragGeometryRef.current;
    let recapturedGeometry = false;
    if (!geometry) {
      recapturedGeometry = true;
      geometry = captureVerticalDragGeometry('resolve-fallback');
      verticalDragGeometryRef.current = geometry;
    }
    if (!geometry) return rejectResolve('no-geometry');

    const list = geometry.list;
    if (clientX < list.left - 28 || clientX > list.right + 28 || clientY < list.top - 80 || clientY > list.bottom + 80) {
      return rejectResolve('outside-list-bounds');
    }
    const lastGeometryRow = geometry.rows[geometry.rows.length - 1];
    const isEffectiveEmptyZone = targetData?.type === 'EMPTY_ZONE' && (!lastGeometryRow || clientY >= lastGeometryRow.rect.bottom);

    const currentWorkspace = useWorkspaceStore.getState().openProjects.get(projectId);
    if (!currentWorkspace) return rejectResolve('no-workspace');
    const baseTabs = orderTabsWithVisualChildren(
      Array.from(currentWorkspace.tabs.values()).filter(tab => !tab.parentTabId && !tab.isUtility)
    );
    const baseOrder = baseTabs.map(tab => tab.id);
    const tabById = new Map(baseTabs.map(tab => [tab.id, tab]));
    const currentGroups = currentWorkspace.tabGroups || [];
    const collectWithVisualChildren = (ids: string[]) => {
      const result: string[] = [];
      const add = (id: string) => {
        if (!tabById.has(id) || result.includes(id)) return;
        result.push(id);
        for (const child of baseTabs) {
          if (child.visualParentTabId === id) add(child.id);
        }
      };
      ids.forEach(add);
      return result;
    };

    const sourceIds = (() => {
      if (sourceData.type === 'TAB_GROUP') {
        return baseOrder.filter(id => tabById.get(id)?.groupId === sourceData.groupId);
      }
      const selected = sourceData.selectedTabIds && sourceData.selectedTabIds.includes(sourceData.id)
        ? sourceData.selectedTabIds
        : [sourceData.id];
      return collectWithVisualChildren(selected.filter(id => tabById.has(id)));
    })();
    const isEmptyGroupDrag = sourceData.type === 'TAB_GROUP' && sourceIds.length === 0
      && currentGroups.some(group => group.id === sourceData.groupId);
    if (sourceIds.length === 0 && !isEmptyGroupDrag) return rejectResolve('no-source-ids');

    const sourceSet = new Set(sourceIds);
    const withoutSource = baseOrder.filter(id => !sourceSet.has(id));
    const groupAssignments: Record<string, string | null | undefined> = {};
    const visualParentAssignments: Record<string, string | null | undefined> = {};
    const groupAnchorAssignments: Record<string, string | null | undefined> = {};
    const selectedTabRootCandidates = sourceData.type === 'TAB'
      ? Array.from(new Set((sourceData.selectedTabIds && sourceData.selectedTabIds.includes(sourceData.id)
        ? sourceData.selectedTabIds
        : [sourceData.id]).filter(id => tabById.has(id))))
      : [];
    const selectedRootSet = new Set(selectedTabRootCandidates);
    const selectedRootIds = selectedTabRootCandidates.filter(id => {
      const parentId = tabById.get(id)?.visualParentTabId;
      return !parentId || !selectedRootSet.has(parentId);
    });
    const hasVisibleVisualChildren = (parentId: string) =>
      baseTabs.some(tab => tab.visualParentTabId === parentId && !sourceSet.has(tab.id));
    const canAssignVisualParent = (parentId: string | undefined): parentId is string => {
      if (!parentId || sourceSet.has(parentId)) return false;
      const parent = tabById.get(parentId);
      return !!parent && !parent.parentTabId && !parent.isUtility;
    };
    const clearSelectedVisualParents = () => {
      for (const id of selectedRootIds) {
        if (tabById.get(id)?.visualParentTabId) visualParentAssignments[id] = null;
      }
    };
    const visualDropForTab = (tabId: string, before: boolean): { parentId: string; index: number } | null => {
      if (sourceSet.has(tabId)) return null;
      const tab = tabById.get(tabId);
      if (!tab) return null;

      if (canAssignVisualParent(tab.visualParentTabId)) {
        const targetIndex = withoutSource.indexOf(tabId);
        if (targetIndex < 0) return null;
        return {
          parentId: tab.visualParentTabId,
          index: before ? targetIndex : targetIndex + 1,
        };
      }

      if (!before && hasVisibleVisualChildren(tabId) && canAssignVisualParent(tabId)) {
        const targetIndex = withoutSource.indexOf(tabId);
        if (targetIndex < 0) return null;
        return { parentId: tabId, index: targetIndex + 1 };
      }
      return null;
    };
    const makePreview = (orderedIds: string[]) => ({
      orderedIds,
      groupAssignments,
      visualParentAssignments,
      groupAnchorAssignments,
    });
    const finish = (preview: DragPreviewLayout | null, branch: string, detail = '') => {
      verticalDragResolveTraceRef.current = [
        `resolve gid=${geometry!.id}`,
        `recaptured=${recapturedGeometry ? 1 : 0}`,
        `branch=${branch}`,
        detail,
        `source=${sourceIds.map(shortDndId).join('.') || '-'}`,
        `without=${withoutSource.map(shortDndId).join('.') || '-'}`,
        `durMs=${(performance.now() - resolveStartedAt).toFixed(1)}`
      ].filter(Boolean).join(' ');
      return preview;
    };
    const insertAt = (order: string[], ids: string[], index: number) => {
      const next = [...order];
      next.splice(Math.max(0, Math.min(index, next.length)), 0, ...ids);
      return next;
    };
    const indexAtFlatPosition = (flatIndex: number) => {
      let index = 0;
      for (let i = 0; i < Math.min(flatIndex, geometry!.rows.length); i += 1) {
        const row = geometry!.rows[i];
        if (row.type === 'tab') {
          if (withoutSource.includes(row.tabId)) index += 1;
        } else {
          index += row.memberIds.filter(tabId => withoutSource.includes(tabId)).length;
        }
      }
      return index;
    };
    const staticReorderInstructionForRow = (row: VerticalDragGeometry['rows'][number]) =>
      getStaticListInstruction(row.rect, clientX, clientY, REORDER_ONLY_OPERATIONS);
    const staticReorderInstructionForTab = (rect: RectSnap) =>
      getStaticListInstruction(rect, clientX, clientY, REORDER_ONLY_OPERATIONS);
    const staticGroupHeaderInstruction = (rect: RectSnap) =>
      getStaticListInstruction(rect, clientX, clientY, GROUP_CONTAINER_OPERATIONS);
    const isInstructionBefore = (instruction: ListInstruction | null) =>
      instruction?.operation !== 'reorder-after';
    const flatIndexFromY = () => {
      let flatIndex = geometry!.rows.length;
      for (let i = 0; i < geometry!.rows.length; i += 1) {
        const row = geometry!.rows[i];
        const instruction = staticReorderInstructionForRow(row);
        if (instruction?.operation === 'reorder-before') {
          flatIndex = i;
          break;
        }
      }
      return flatIndex;
    };
    const firstTabIdForRow = (row: VerticalDragGeometry['rows'][number]): string | undefined => {
      if (row.type === 'tab') return row.tabId;
      const visibleTab = row.tabRows.find(tabRow => tabById.has(tabRow.tabId));
      if (visibleTab) return visibleTab.tabId;
      return baseOrder.find(id => tabById.get(id)?.groupId === row.groupId);
    };
    const anchorBeforeRow = (rowIndex: number): string | null => {
      for (let i = Math.max(0, rowIndex); i < geometry!.rows.length; i += 1) {
        const row = geometry!.rows[i];
        if (sourceData.type === 'TAB_GROUP' && row.type === 'group' && row.groupId === sourceData.groupId) {
          continue;
        }
        const tabId = firstTabIdForRow(row);
        if (tabId && !sourceSet.has(tabId)) return tabId;
      }
      return null;
    };
    const indexInGroup = (groupId: string, memberIndex: number, rowIndex: number) => {
      const members = withoutSource.filter(id => tabById.get(id)?.groupId === groupId);
      if (members.length === 0) return indexAtFlatPosition(rowIndex);
      const beforeId = members[memberIndex];
      if (beforeId) return withoutSource.indexOf(beforeId);
      return withoutSource.indexOf(members[members.length - 1]) + 1;
    };
    const assignEmptyGroupAnchor = (anchorTabId: string | null, branch = 'empty-group-anchor', detail = '') => {
      if (sourceData.type !== 'TAB_GROUP') return null;
      groupAnchorAssignments[sourceData.groupId] = anchorTabId;
      return finish(
        makePreview(baseOrder),
        branch,
        `anchor=${shortDndId(anchorTabId)} ${detail}`.trim()
      );
    };

    if (isEmptyGroupDrag) {
      if (isEffectiveEmptyZone) {
        return assignEmptyGroupAnchor(null, 'empty-group:empty-zone');
      }
      for (let rowIndex = 0; rowIndex < geometry.rows.length; rowIndex += 1) {
        const row = geometry.rows[rowIndex];
        if (clientY < row.rect.top || clientY > row.rect.bottom) continue;
        const instruction = staticReorderInstructionForRow(row);
        const before = isInstructionBefore(instruction);
        const anchorTabId = anchorBeforeRow(before ? rowIndex : rowIndex + 1);
        return assignEmptyGroupAnchor(
          anchorTabId,
          'empty-group:row',
          `row=${rowIndex}:${verticalRowDebugKey(row)} before=${before ? 1 : 0} staticInstr=${summarizeListInstruction(instruction)}`
        );
      }
      const flatIndex = flatIndexFromY();
      return assignEmptyGroupAnchor(
        anchorBeforeRow(flatIndex),
        'empty-group:flat-index',
        `flatIndex=${flatIndex}`
      );
    }

    if (sourceData.type === 'TAB_GROUP') {
      if (isEffectiveEmptyZone) {
        return finish(
          makePreview(insertAt(withoutSource, sourceIds, withoutSource.length)),
          'group:empty-zone',
          `insert=${withoutSource.length}`
        );
      }
      const flatIndex = flatIndexFromY();
      const targetIndex = indexAtFlatPosition(flatIndex);
      return finish(
        makePreview(insertAt(withoutSource, sourceIds, targetIndex)),
        'group:flat',
        `flatIndex=${flatIndex} insert=${targetIndex}`
      );
    }

    const assignFlat = (flatIndex: number, branch = 'flat', detail = '') => {
      for (const id of sourceIds) groupAssignments[id] = null;
      clearSelectedVisualParents();
      const insertIndex = indexAtFlatPosition(flatIndex);
      return finish(
        makePreview(insertAt(withoutSource, sourceIds, insertIndex)),
        branch,
        `flatIndex=${flatIndex} insert=${insertIndex} ${detail}`.trim()
      );
    };
    const assignFlatEnd = (branch = 'flat-end', detail = '') => {
      for (const id of sourceIds) groupAssignments[id] = null;
      clearSelectedVisualParents();
      return finish(
        makePreview(insertAt(withoutSource, sourceIds, withoutSource.length)),
        branch,
        `insert=${withoutSource.length} ${detail}`.trim()
      );
    };
    const assignGroup = (groupId: string, memberIndex: number, rowIndex: number, branch = 'group-body', detail = '') => {
      for (const id of sourceIds) groupAssignments[id] = groupId;
      clearSelectedVisualParents();
      const insertIndex = indexInGroup(groupId, memberIndex, rowIndex);
      return finish(
        makePreview(insertAt(withoutSource, sourceIds, insertIndex)),
        branch,
        `group=${shortDndId(groupId)} memberIndex=${memberIndex} rowIndex=${rowIndex} insert=${insertIndex} ${detail}`.trim()
      );
    };
    const assignVisualParent = (parentId: string, targetIndex: number, branch = 'visual-parent', detail = '') => {
      const parent = tabById.get(parentId);
      for (const id of sourceIds) groupAssignments[id] = parent?.groupId || null;
      for (const id of selectedRootIds) visualParentAssignments[id] = parentId;
      return finish(
        makePreview(insertAt(withoutSource, sourceIds, targetIndex)),
        branch,
        `parent=${shortDndId(parentId)} insert=${targetIndex} ${detail}`.trim()
      );
    };
    const assignParentAfterOwnChild = (childId: string, detail = '') => {
      if (sourceData.type !== 'TAB') return null;
      const sourceId = sourceData.id;
      const child = tabById.get(childId);
      if (!child || child.visualParentTabId !== sourceId) return null;
      const selectedIds = sourceData.selectedTabIds && sourceData.selectedTabIds.includes(sourceId)
        ? sourceData.selectedTabIds
        : [sourceId];
      if (selectedIds.length !== 1) return null;
      const withoutParentOnly = baseOrder.filter(id => id !== sourceId);
      const childIndex = withoutParentOnly.indexOf(childId);
      if (childIndex < 0) return null;
      for (const id of withoutParentOnly.slice(0, childIndex + 1)) {
        if (tabById.get(id)?.visualParentTabId === sourceId) {
          visualParentAssignments[id] = null;
        }
      }
      return finish(
        makePreview(insertAt(withoutParentOnly, [sourceId], childIndex + 1)),
        'parent-after-own-child',
        `child=${shortDndId(childId)} insert=${childIndex + 1} ${detail}`.trim()
      );
    };

    if (isEffectiveEmptyZone) {
      const lastRow = geometry.rows[geometry.rows.length - 1];
      if (lastRow?.type === 'group' && lastRow.tabRows.length > 0 && lastRow.tabRows.every(tabRow => sourceSet.has(tabRow.tabId))) {
        return assignGroup(lastRow.groupId, 0, geometry.rows.length - 1, 'empty-zone:last-source-group');
      }
      return assignFlatEnd('empty-zone:flat-end');
    }

    for (let rowIndex = 0; rowIndex < geometry.rows.length; rowIndex += 1) {
      const row = geometry.rows[rowIndex];
      if (row.type !== 'group') continue;
      if (clientY >= row.header.top && clientY <= row.header.bottom) {
        const instruction = staticGroupHeaderInstruction(row.header);
        return instruction?.operation === 'reorder-before'
          ? assignFlat(rowIndex, 'group-header:before', `row=${rowIndex}:${verticalRowDebugKey(row)} staticInstr=${summarizeListInstruction(instruction)}`)
          : assignGroup(row.groupId, 0, rowIndex, 'group-header:inside-start', `row=${rowIndex}:${verticalRowDebugKey(row)} staticInstr=${summarizeListInstruction(instruction)}`);
      }
      if (row.tabRows.length === 0) {
        if (clientY > row.header.bottom && clientY <= row.rect.bottom) {
          return assignGroup(row.groupId, 0, rowIndex, 'empty-group-body', `row=${rowIndex}:${verticalRowDebugKey(row)}`);
        }
        continue;
      }
      const first = row.tabRows[0];
      const last = row.tabRows[row.tabRows.length - 1];
      if (clientY < row.header.bottom || clientY > row.rect.bottom) continue;
      if (clientY < first.rect.top - 8 || clientY > last.rect.bottom + 12) continue;
      let targetMemberIndex = 0;
      for (const tabRow of row.tabRows) {
        if (clientY >= tabRow.rect.top && clientY <= tabRow.rect.bottom) {
          const instruction = staticReorderInstructionForTab(tabRow.rect);
          const before = isInstructionBefore(instruction);
          if (sourceSet.has(tabRow.tabId)) {
            const parentAfterChildPreview = !before
              ? assignParentAfterOwnChild(tabRow.tabId, `groupRow=${rowIndex}:${shortDndId(row.groupId)} before=${before ? 1 : 0} staticInstr=${summarizeListInstruction(instruction)}`)
              : null;
            if (parentAfterChildPreview) return parentAfterChildPreview;
            continue;
          }
          const visualDrop = visualDropForTab(tabRow.tabId, before);
          if (visualDrop) {
            return assignVisualParent(
              visualDrop.parentId,
              visualDrop.index,
              'group-tab:visual-parent',
              `row=${rowIndex}:${shortDndId(row.groupId)} target=${shortDndId(tabRow.tabId)} before=${before ? 1 : 0} staticInstr=${summarizeListInstruction(instruction)}`
            );
          }
          if (before) break;
          targetMemberIndex += 1;
          break;
        }
        if (sourceSet.has(tabRow.tabId)) continue;
        const instruction = staticReorderInstructionForTab(tabRow.rect);
        if (instruction?.operation === 'reorder-before') break;
        targetMemberIndex += 1;
      }
      return assignGroup(row.groupId, targetMemberIndex, rowIndex, 'group-body', `row=${rowIndex}:${verticalRowDebugKey(row)}`);
    }

    for (let rowIndex = 0; rowIndex < geometry.rows.length; rowIndex += 1) {
      const row = geometry.rows[rowIndex];
      if (row.type !== 'tab') continue;
      if (clientY < row.rect.top || clientY > row.rect.bottom) continue;
      const instruction = staticReorderInstructionForRow(row);
      const before = isInstructionBefore(instruction);
      if (sourceSet.has(row.tabId)) {
        const parentAfterChildPreview = !before
          ? assignParentAfterOwnChild(row.tabId, `row=${rowIndex}:${verticalRowDebugKey(row)} before=${before ? 1 : 0} staticInstr=${summarizeListInstruction(instruction)}`)
          : null;
        if (parentAfterChildPreview) return parentAfterChildPreview;
        continue;
      }
      const visualDrop = visualDropForTab(row.tabId, before);
      if (visualDrop) {
        return assignVisualParent(
          visualDrop.parentId,
          visualDrop.index,
          'tab-row:visual-parent',
          `row=${rowIndex}:${verticalRowDebugKey(row)} before=${before ? 1 : 0} staticInstr=${summarizeListInstruction(instruction)}`
        );
      }
      return assignFlat(
        before ? rowIndex : rowIndex + 1,
        'tab-row:flat',
        `row=${rowIndex}:${verticalRowDebugKey(row)} before=${before ? 1 : 0} staticInstr=${summarizeListInstruction(instruction)}`
      );
    }

    const flatIndex = flatIndexFromY();
    return assignFlat(flatIndex, 'fallback:flat-index', `flatIndex=${flatIndex}`);
  }, [captureVerticalDragGeometry, isAdoptDropTarget, isVerticalLayout, projectId]);

  // Monitor for all drag events
  useEffect(() => {
    return monitorForElements({
      canMonitor: ({ source }) => source.data.type === 'TAB' || source.data.type === 'TAB_GROUP',
      onDragStart({ source, location }) {
        const sourceData = source.data as DragData;
        verticalDragResolveTraceRef.current = null;
        verticalDragGeometryRef.current = sourceData.projectId === projectId ? captureVerticalDragGeometry('start') : null;
        const sourceRect = findVerticalDragSourceRect(sourceData, verticalDragGeometryRef.current);
        verticalDragAnchorRef.current = sourceRect
          ? {
              startY: location.initial.input.clientY,
              sourceTop: sourceRect.top,
              sourceBottom: sourceRect.bottom,
              sourceMidY: sourceRect.midY,
              offsetY: sourceRect.midY - location.initial.input.clientY,
            }
          : null;
        tabDndLogUntilRef.current = performance.now() + 5000;
        console.log(
          `[TabDnd:start] project=${shortDndId(projectId)}` +
          ` sourceType=${sourceData.type}` +
          ` source=${shortDndId(sourceData.type === 'TAB' ? sourceData.id : sourceData.groupId)}` +
          ` sourceProject=${shortDndId(sourceData.projectId || null)}` +
          ` rawStartY=${Math.round(location.initial.input.clientY)}` +
          ` anchor=${summarizeVerticalAnchor(verticalDragAnchorRef.current)}` +
          ` geometry=${summarizeVerticalGeometry(verticalDragGeometryRef.current)}`
        );
      },
      onDrag({ source, location }) {
        const target = location.current.dropTargets[0];
        const input = location.current.input;
        const anchor = verticalDragAnchorRef.current;
        const effectiveY = anchor ? input.clientY + anchor.offsetY : input.clientY;
        const preview = resolveStaticVerticalPreview(source.data as DragData, input.clientX, effectiveY, target?.data);
        const key = preview ? JSON.stringify(preview) : '';
        if (key !== dragPreviewKeyRef.current) {
          dragPreviewKeyRef.current = key;
          tabDndLogUntilRef.current = performance.now() + 5000;
          const sourceData = source.data as DragData;
          console.log(
            `[TabDnd:preview] project=${shortDndId(projectId)}` +
            ` sourceType=${sourceData.type}` +
            ` source=${shortDndId(sourceData.type === 'TAB' ? sourceData.id : sourceData.groupId)}` +
            ` x=${Math.round(input.clientX)} y=${Math.round(input.clientY)}` +
            ` effectiveY=${Math.round(effectiveY)}` +
            ` anchorDy=${anchor ? Math.round(anchor.offsetY) : 0}` +
            ` target=${summarizeDropTargetData(target?.data)}` +
            ` ${summarizeResolveTrace(verticalDragResolveTraceRef.current)}` +
            ` ${summarizePreviewLayout(preview)}`
          );
          setDragPreview(preview);
        }
      },
      onDrop({ source, location }) {
        const sourceData = source.data as DragData;
        const target = location.current.dropTargets[0];
        const targetData = target?.data as any;
        const input = location.current.input;
        const anchor = verticalDragAnchorRef.current;
        const effectiveY = anchor ? input.clientY + anchor.offsetY : input.clientY;
        const geometryBeforeDrop = verticalDragGeometryRef.current;

        const preview = resolveStaticVerticalPreview(sourceData, input.clientX, effectiveY, targetData);
        tabDndLogUntilRef.current = performance.now() + 5000;
        console.log(
          `[TabDnd:drop] project=${shortDndId(projectId)}` +
          ` sourceType=${sourceData.type}` +
          ` source=${shortDndId(sourceData.type === 'TAB' ? sourceData.id : sourceData.groupId)}` +
          ` x=${Math.round(input.clientX)} y=${Math.round(input.clientY)}` +
          ` effectiveY=${Math.round(effectiveY)}` +
          ` anchorDy=${anchor ? Math.round(anchor.offsetY) : 0}` +
          ` target=${summarizeDropTargetData(targetData)}` +
          ` geometryBefore=${geometryBeforeDrop ? geometryBeforeDrop.id : 'none'}` +
          ` ${summarizeResolveTrace(verticalDragResolveTraceRef.current)}` +
          ` ${summarizePreviewLayout(preview)}`
        );
        if (preview) {
          applyTabLayout(
            projectId,
            preview.orderedIds,
            preview.groupAssignments,
            preview.visualParentAssignments,
            preview.groupAnchorAssignments
          );
          dragPreviewKeyRef.current = '';
          verticalDragGeometryRef.current = null;
          verticalDragAnchorRef.current = null;
          setDragPreview(null);
          return;
        }
        dragPreviewKeyRef.current = '';
        verticalDragGeometryRef.current = null;
        verticalDragAnchorRef.current = null;
        setDragPreview(null);
        if (!target) return;

        // Get fresh tabs from workspace (avoid stale closure)
        const currentWorkspace = useWorkspaceStore.getState().openProjects.get(projectId);
        if (!currentWorkspace) return;
        if (sourceData.type !== 'TAB') return;

        if (isVerticalLayout && sourceData.zone === 'main' && !isAdoptDropTarget(sourceData, targetData)) return;

        const allTabsNow = Array.from(currentWorkspace.tabs.values());
        const visibleTabsNow = allTabsNow.filter(t => !t.parentTabId);
        const mainTabsNow = visibleTabsNow.filter(t => !t.isUtility);
        const utilityTabsNow = visibleTabsNow.filter(t => t.isUtility);

        // Dropped on zone container (empty zone)
        if (targetData.type === 'ZONE') {
          const toUtility = targetData.zone === 'utility';
          if (sourceData.zone !== targetData.zone) {
            moveTabToZone(projectId, sourceData.id, toUtility, 0);
          }
          return;
        }

        // Dropped on another tab
        if (targetData.type === 'TAB') {
          const edge = extractClosestEdge(targetData);
          const targetZone = targetData.zone as 'main' | 'utility';
          const targetIndex = targetData.index as number;

          // Calculate insertion index based on edge
          let insertIndex = targetIndex;
          if (edge === 'right' || edge === 'bottom') {
            insertIndex = targetIndex + 1;
          }

          // Same zone - reorder
          if (sourceData.zone === targetZone) {
            const currentTabs = sourceData.zone === 'main'
              ? mainTabsNow.map(t => t.id)
              : utilityTabsNow.map(t => t.id);

            const sourceIndex = currentTabs.indexOf(sourceData.id);
            if (sourceIndex === -1) return;

            // Adjust index if moving forward
            if (sourceIndex < insertIndex) {
              insertIndex--;
            }

            const newOrder = [...currentTabs];
            newOrder.splice(sourceIndex, 1);
            newOrder.splice(insertIndex, 0, sourceData.id);

            reorderInZone(projectId, sourceData.zone, newOrder);
          } else {
            // Different zone - move
            moveTabToZone(projectId, sourceData.id, targetZone === 'utility', insertIndex);
          }
        }
      },
    });
  }, [projectId, moveTabToZone, reorderInZone, applyTabLayout, captureVerticalDragGeometry, resolveStaticVerticalPreview, isVerticalLayout, isAdoptDropTarget]);

  useEffect(() => {
    if ((editingTabId || editingGroupId) && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editingTabId, editingGroupId]);

  // Consume pendingEditTabId set by createTab/createTabAfterCurrent to auto-enter rename mode
  useEffect(() => {
    if (!pendingEditTabId) return;
    const ws = useWorkspaceStore.getState().openProjects.get(projectId);
    if (!ws?.tabs.has(pendingEditTabId)) return;
    const tabName = ws.tabs.get(pendingEditTabId)?.name ?? '';
    setEditingTabId(pendingEditTabId);
    setEditValue(tabName);
    setEditOriginalValue(tabName);
    // Clear so other TabBar instances (other projects) don't also enter edit
    useWorkspaceStore.setState({ pendingEditTabId: null });
  }, [pendingEditTabId, projectId]);

  useEffect(() => {
    if (!contextMenu && !emptyContextMenu && !groupContextMenu) return;
    const handleClose = (e: MouseEvent) => {
      // Don't close if clicking inside the context menu itself
      if ((e.target as HTMLElement).closest('[data-tab-context-menu]')) return;
      setContextMenu(null);
      setEmptyContextMenu(null);
      setGroupContextMenu(null);
    };
    // Use mousedown instead of click — xterm.js canvas swallows click events
    document.addEventListener('mousedown', handleClose);
    return () => document.removeEventListener('mousedown', handleClose);
  }, [contextMenu, emptyContextMenu, groupContextMenu]);

  // Clamp context menu position to viewport (same pattern as Timeline tooltip)
  useLayoutEffect(() => {
    const activeMenu = contextMenu || groupContextMenu || emptyContextMenu;
    if (!activeMenu || !contextMenuRef.current) return;
    const el = contextMenuRef.current;
    const rect = el.getBoundingClientRect();
    const pad = 8;
    let x = activeMenu.x;
    let y = activeMenu.y;

    // Clamp bottom
    if (y + rect.height > window.innerHeight - pad) {
      y = window.innerHeight - rect.height - pad;
    }
    // Clamp top
    if (y < pad) y = pad;
    // Clamp right
    if (x + rect.width > window.innerWidth - pad) {
      x = window.innerWidth - rect.width - pad;
    }
    // Clamp left
    if (x < pad) x = pad;

    if (x !== contextMenuPos.x || y !== contextMenuPos.y) {
      setContextMenuPos({ x, y });
    }
  }, [contextMenu, groupContextMenu, emptyContextMenu, contextScripts.length, contextShScripts.length, openProjects]);

  useLayoutEffect(() => {
    if (!isVerticalLayout) {
      verticalRowFlipRectsRef.current.clear();
      for (const animation of verticalRowAnimationsRef.current.values()) animation.cancel();
      verticalRowAnimationsRef.current.clear();
      return;
    }

    const list = verticalMainListRef.current;
    if (!list) {
      verticalRowFlipRectsRef.current.clear();
      return;
    }

    const nextRects = new Map<string, VerticalRowFlipRect>();
    const rows = Array.from(list.querySelectorAll<HTMLElement>('[data-vertical-row-key]'))
      .filter((child): child is HTMLElement => child instanceof HTMLElement && !!child.dataset.verticalRowKey);

    for (const row of rows) {
      const key = row.dataset.verticalRowKey;
      if (!key) continue;
      nextRects.set(key, measureVerticalRowFlipRect(row, list));
    }

    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const now = performance.now();
    const suppressFlipForGroupCollapse = !dragPreview && now < groupCollapseFlipSuppressUntilRef.current;
    if (suppressFlipForGroupCollapse) {
      let cancelledCount = 0;
      for (const row of rows) row.style.willChange = '';
      for (const animation of Array.from(verticalRowAnimationsRef.current.values())) {
        cancelledCount += 1;
        animation.cancel();
      }
      verticalRowAnimationsRef.current.clear();
      if (now < tabDndLogUntilRef.current) {
        console.log(
          `[TabDnd:flip] project=${shortDndId(projectId)}` +
          ` rows=${rows.length}` +
          ` measure=offset-chain` +
          ` prev=${verticalRowFlipRectsRef.current.size}` +
          ` next=${nextRects.size}` +
          ` suppress=group-collapse` +
          ` untilMs=${Math.round(groupCollapseFlipSuppressUntilRef.current - now)}` +
          ` cancelled=${cancelledCount}`
        );
      }
      verticalRowFlipRectsRef.current = nextRects;
      return;
    }

    let animatedCount = 0;
    let missingPrevCount = 0;
    let zeroDeltaCount = 0;
    let cancelledCount = 0;
    const animatedKeys: string[] = [];
    for (const row of rows) {
      const key = row.dataset.verticalRowKey;
      if (!key) continue;
      const prev = verticalRowFlipRectsRef.current.get(key);
      const next = nextRects.get(key);
      if (!prev || !next) {
        if (!prev) missingPrevCount += 1;
        continue;
      }

      const dx = prev.left - next.left;
      const dy = prev.top - next.top;
      if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) {
        zeroDeltaCount += 1;
        continue;
      }

      const previousAnimation = verticalRowAnimationsRef.current.get(key);
      if (previousAnimation) {
        cancelledCount += 1;
        previousAnimation.cancel();
      }

      row.style.willChange = 'transform';
      const card = row.querySelector<HTMLElement>('[data-tab-item], [data-tab-group-header]');
      const shouldLogPaint = performance.now() < tabDndLogUntilRef.current;
      const logPaintState = (phase: string) => {
        if (!shouldLogPaint) return;
        console.log(
          `[TabDnd:flip-paint] phase=${phase}` +
          ` project=${shortDndId(projectId)}` +
          ` key=${shortVerticalRowKey(key)}` +
          ` dx=${Math.round(dx)}` +
          ` dy=${Math.round(dy)}` +
          ` dragPreview=${dragPreview ? 1 : 0}` +
          ` row=${describePaintNode(row)}` +
          ` card=${describePaintNode(card)}`
        );
      };
      logPaintState('before');
      const animation = row.animate(
        [
          { transform: `translate3d(${dx}px, ${dy}px, 0)` },
          { transform: 'translate3d(0, 0, 0)' },
        ],
        {
          duration: reduceMotion ? 90 : (dragPreview ? 118 : 145),
          easing: 'cubic-bezier(0.16, 1, 0.3, 1)',
        }
      );
      verticalRowAnimationsRef.current.set(key, animation);
      animatedCount += 1;
      animatedKeys.push(`${key}:dx=${Math.round(dx)}:dy=${Math.round(dy)}`);
      window.requestAnimationFrame(() => logPaintState('raf1'));
      animation.onfinish = () => {
        if (verticalRowAnimationsRef.current.get(key) !== animation) return;
        logPaintState('finish');
        row.style.willChange = '';
        verticalRowAnimationsRef.current.delete(key);
      };
      animation.oncancel = () => {
        if (verticalRowAnimationsRef.current.get(key) !== animation) return;
        logPaintState('cancel');
        row.style.willChange = '';
        verticalRowAnimationsRef.current.delete(key);
      };
    }

    if (performance.now() < tabDndLogUntilRef.current) {
      console.log(
        `[TabDnd:flip] project=${shortDndId(projectId)}` +
        ` rows=${rows.length}` +
        ` measure=offset-chain` +
        ` prev=${verticalRowFlipRectsRef.current.size}` +
        ` next=${nextRects.size}` +
        ` reduceMotion=${!!reduceMotion}` +
        ` dragPreview=${!!dragPreview}` +
        ` animated=${animatedCount}` +
        ` zero=${zeroDeltaCount}` +
        ` missingPrev=${missingPrevCount}` +
        ` cancelled=${cancelledCount}` +
        ` keys=${animatedKeys.slice(0, 12).join('|') || '-'}`
      );
    }

    for (const key of Array.from(verticalRowAnimationsRef.current.keys())) {
      if (nextRects.has(key)) continue;
      verticalRowAnimationsRef.current.get(key)?.cancel();
      verticalRowAnimationsRef.current.delete(key);
    }

    verticalRowFlipRectsRef.current = nextRects;
  });

  useEffect(() => {
    return () => {
      for (const animation of verticalRowAnimationsRef.current.values()) animation.cancel();
      verticalRowAnimationsRef.current.clear();
      verticalRowFlipRectsRef.current.clear();
    };
  }, []);

  if (!workspace || !project) return null;

  const allTabs = Array.from(workspace.tabs.values());
  const visibleTabs = allTabs;
  const mainTabsBase = visibleTabs.filter(t => !t.isUtility);
  const utilityTabs = visibleTabs.filter(t => t.isUtility);
  const tabGroups = workspace.tabGroups || [];
  const tabGroupsForDisplay = (() => {
    if (!isVerticalLayout || !dragPreview?.groupAnchorAssignments) return tabGroups;
    return tabGroups.map(group => {
      if (!Object.prototype.hasOwnProperty.call(dragPreview.groupAnchorAssignments!, group.id)) return group;
      return {
        ...group,
        anchorTabId: dragPreview.groupAnchorAssignments![group.id] || undefined,
      };
    });
  })();
  const mainTabs = (() => {
    if (!isVerticalLayout || !dragPreview) return mainTabsBase;
    const byId = new Map(mainTabsBase.map(tab => [tab.id, tab]));
    const ordered: TabData[] = [];
    const used = new Set<string>();
    const applyPreviewTab = (tab: TabData): TabData => {
      let next = tab;
      if (Object.prototype.hasOwnProperty.call(dragPreview.groupAssignments, tab.id)) {
        next = { ...next, groupId: dragPreview.groupAssignments[tab.id] || undefined };
      }
      if (dragPreview.visualParentAssignments && Object.prototype.hasOwnProperty.call(dragPreview.visualParentAssignments, tab.id)) {
        next = { ...next, visualParentTabId: dragPreview.visualParentAssignments[tab.id] || undefined };
      }
      return next;
    };
    for (const id of dragPreview.orderedIds) {
      const tab = byId.get(id);
      if (!tab) continue;
      used.add(id);
      ordered.push(applyPreviewTab(tab));
    }
    for (const tab of mainTabsBase) {
      if (used.has(tab.id)) continue;
      ordered.push(applyPreviewTab(tab));
    }
    return ordered;
  })();
  const mainTabsForDisplay = isVerticalLayout ? orderTabsWithVisualChildren(mainTabs) : mainTabs;
  const visualDepthById = isVerticalLayout ? buildVisualDepthMap(mainTabsForDisplay) : new Map<string, number>();
  const verticalRows = isVerticalLayout ? buildVerticalRows(mainTabsForDisplay, tabGroupsForDisplay) : [];

  const describeGroupCollapseSnapshot = useCallback((groupId: string): string => {
    const list = verticalMainListRef.current;
    if (!list) return 'list=none';
    const groupRow = Array.from(list.querySelectorAll<HTMLElement>('[data-row-type="group"]'))
      .find((element) => element.dataset.groupId === groupId) || null;
    const collapse = Array.from(list.querySelectorAll<HTMLElement>('[data-tab-group-collapse]'))
      .find((element) => element.dataset.groupId === groupId) || null;
    const body = Array.from(list.querySelectorAll<HTMLElement>('[data-tab-group-body]'))
      .find((element) => element.dataset.groupId === groupId) || null;
    const childRows = body
      ? Array.from(body.querySelectorAll<HTMLElement>('[data-vertical-row-key]'))
      : [];
    const allRows = Array.from(list.querySelectorAll<HTMLElement>('[data-vertical-row-key]'))
      .slice(0, 40)
      .map((row) => {
        const rect = measureVerticalRowFlipRect(row, list);
        return `${shortVerticalRowKey(row.dataset.verticalRowKey)}:${row.dataset.rowType || '-'}:t${Math.round(rect.top)}:h${Math.round(rect.height)}`;
      })
      .join('|') || '-';
    const childSummary = childRows
      .slice(0, 20)
      .map((row) => {
        const rect = measureVerticalRowFlipRect(row, list);
        return `${shortVerticalRowKey(row.dataset.verticalRowKey)}:t${Math.round(rect.top)}:h${Math.round(rect.height)}`;
      })
      .join('|') || '-';

    return (
      `list=${describeCollapseNode(list)}` +
      ` groupRow=${describeCollapseNode(groupRow, list)}` +
      ` collapse=${describeCollapseNode(collapse, list)}` +
      ` body=${describeCollapseNode(body, list)}` +
      ` childRows=${childRows.length}:${childSummary}` +
      ` allRows=${allRows}`
    );
  }, []);

  const handleToggleGroupCollapsed = useCallback((group: TabGroup) => {
    const now = performance.now();
    tabDndLogUntilRef.current = Math.max(tabDndLogUntilRef.current, now + 1600);
    groupCollapseFlipSuppressUntilRef.current = Math.max(
      groupCollapseFlipSuppressUntilRef.current,
      now + GROUP_COLLAPSE_FLIP_SUPPRESS_MS
    );
    const memberIds = mainTabsForDisplay
      .filter((tab) => tab.groupId === group.id)
      .map((tab) => tab.id);
    const logPhase = (phase: string) => {
      console.warn(
        '[TabGroupCollapse:renderer]' +
        ` phase=${phase}` +
        ` project=${shortDndId(projectId)}` +
        ` group=${shortDndId(group.id)}` +
        ` collapsed=${group.collapsed ? 1 : 0}` +
        ` memberCount=${memberIds.length}` +
        ` members=${memberIds.map(shortDndId).join('>') || '-'}` +
        ` activeGroup=${shortDndId(workspace.activeGroupId)}` +
        ` dragPreview=${dragPreview ? 1 : 0}` +
        ` t=${Math.round(performance.now())}` +
        ` snapshot=${describeGroupCollapseSnapshot(group.id)}`
      );
    };

    logPhase('before-toggle');
    toggleTabGroupCollapsed(projectId, group.id);
    window.requestAnimationFrame(() => logPhase('raf1-after-toggle'));
    window.setTimeout(() => logPhase('after-170ms'), 170);
    window.setTimeout(() => logPhase('after-1000ms'), 1000);
  }, [
    describeGroupCollapseSnapshot,
    dragPreview,
    mainTabsForDisplay,
    projectId,
    toggleTabGroupCollapsed,
    workspace.activeGroupId,
  ]);

  const handleGroupCollapseTransition = useCallback((event: React.TransitionEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    if (performance.now() > tabDndLogUntilRef.current) return;
    const groupId = event.currentTarget.dataset.groupId || '';
    if (
      (event.type === 'transitionend' || event.type === 'transitioncancel') &&
      event.propertyName === 'grid-template-rows'
    ) {
      const list = verticalMainListRef.current;
      if (list) {
        const nextRects = new Map<string, VerticalRowFlipRect>();
        const rows = Array.from(list.querySelectorAll<HTMLElement>('[data-vertical-row-key]'))
          .filter((row): row is HTMLElement => row instanceof HTMLElement && !!row.dataset.verticalRowKey);
        for (const row of rows) {
          const key = row.dataset.verticalRowKey;
          if (!key) continue;
          nextRects.set(key, measureVerticalRowFlipRect(row, list));
        }
        verticalRowFlipRectsRef.current = nextRects;
        console.log(
          '[TabGroupCollapse:transition]' +
          ` type=${event.type}` +
          ` project=${shortDndId(projectId)}` +
          ` group=${shortDndId(groupId)}` +
          ` phase=flip-baseline-refresh` +
          ` rows=${nextRects.size}` +
          ` t=${Math.round(performance.now())}`
        );
      }
    }
    console.warn(
      '[TabGroupCollapse:transition]' +
      ` type=${event.type}` +
      ` project=${shortDndId(projectId)}` +
      ` group=${shortDndId(groupId)}` +
      ` prop=${event.propertyName}` +
      ` elapsed=${event.elapsedTime.toFixed(3)}` +
      ` t=${Math.round(performance.now())}` +
      ` snapshot=${describeGroupCollapseSnapshot(groupId)}`
    );
  }, [describeGroupCollapseSnapshot, projectId]);

  // CWD priority: project.path (if bound) → активный таб cwd → HOME.
  // Раньше было наоборот (активный таб → project.path) — при бранч-хоппинге
  // в активном табе следующий «New Tab» наследовал cwd текущей ветки/папки
  // вместо корня проекта. Юзер: «новая вкладка автоматически в той директории,
  // к которой привязан проект». `__unset__` — sentinel для проектов без
  // привязанной директории (Dashboard / freshly opened без папки).
  const resolveNewTabCwd = (): string => {
    const bound = project.path && !project.path.startsWith('__unset__') ? project.path : '';
    if (bound) return bound;
    const activeTab = workspace.activeTabId ? workspace.tabs.get(workspace.activeTabId) : null;
    return activeTab?.cwd || '';
  };

  const handleNewTab = () => {
    const cwd = resolveNewTabCwd();
    // Pass undefined for name to use smart naming (tab-1, tab-2, etc.)
    createTabAfterCurrent(projectId, undefined, cwd);
    setProjectView(projectId, 'terminal');
  };

  // Create new tab at the end of tabs list (for double-click on empty space)
  const handleNewTabAtEnd = () => {
    const cwd = resolveNewTabCwd();
    createTab(projectId, undefined, cwd);
    setProjectView(projectId, 'terminal');
  };

  const getVisualParentCandidateId = (tabId: string, direction: 'up' | 'down'): string | null => {
    const index = mainTabsForDisplay.findIndex(tab => tab.id === tabId);
    if (index === -1) return null;
    const step = direction === 'up' ? -1 : 1;
    for (let i = index + step; i >= 0 && i < mainTabsForDisplay.length; i += step) {
      const candidate = mainTabsForDisplay[i];
      if (!candidate || candidate.id === tabId) continue;
      if (candidate.visualParentTabId === tabId) continue;
      return candidate.id;
    }
    return null;
  };

  const contextMenuTabId = contextMenu?.tabId || null;
  const contextTabForMenu = contextMenuTabId ? workspace?.tabs.get(contextMenuTabId) : null;
  const isContextFileTab = contextTabForMenu?.tabType === 'file';
  const visualParentAboveId = contextMenuTabId ? getVisualParentCandidateId(contextMenuTabId, 'up') : null;
  const visualParentBelowId = contextMenuTabId ? getVisualParentCandidateId(contextMenuTabId, 'down') : null;

  const attachVisualParent = (direction: 'up' | 'down') => {
    if (!contextMenu) return;
    const parentId = direction === 'up' ? visualParentAboveId : visualParentBelowId;
    if (!parentId) return;
    setTabVisualParent(projectId, contextMenu.tabId, parentId);
    setContextMenu(null);
  };

  const handleCloseTab = async (e: React.MouseEvent, tabId: string) => {
    e.stopPropagation();
    // If multi-select and clicked tab is among selected — close all selected
    if (isMultiSelect && selectedTabIds.includes(tabId)) {
      const startedAt = performance.now();
      console.warn(
        '[Perf:CloseTabsBatch] start' +
        ' project=' + projectId.slice(-12) +
        ' count=' + selectedTabIds.length +
        ' trigger=' + tabId.slice(-12) +
        ' source=close-button' +
        ' startAbs=' + (performance.timeOrigin + startedAt).toFixed(1)
      );
      if (await confirmCloseTabs(selectedTabIds)) {
        for (const id of selectedTabIds) {
          const tab = workspace?.tabs.get(id);
          await closeTab(projectId, id, { skipProcessCheck: true, forceCleanup: true, aiBusyOverride: tab ? isTabTurnBusy(tab) : undefined });
        }
        console.warn(
          '[Perf:CloseTabsBatch] done' +
          ' project=' + projectId.slice(-12) +
          ' count=' + selectedTabIds.length +
          ' source=close-button' +
          ' durMs=' + (performance.now() - startedAt).toFixed(1)
        );
      } else {
        console.warn(
          '[Perf:CloseTabsBatch] cancelled' +
          ' project=' + projectId.slice(-12) +
          ' count=' + selectedTabIds.length +
          ' source=close-button' +
          ' durMs=' + (performance.now() - startedAt).toFixed(1)
        );
      }
    } else {
      const tab = workspace?.tabs.get(tabId);
      closeTab(projectId, tabId, { aiBusyOverride: tab ? isTabTurnBusy(tab) : undefined });
    }
  };

  const handleDoubleClick = (tabId: string, currentName: string) => {
    setEditingGroupId(null);
    setGroupEditValue('');
    setEditingTabId(tabId);
    setEditValue(currentName);
    setEditOriginalValue(currentName);
  };

  const handleGroupContextMenu = (e: React.MouseEvent, group: TabGroup) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu(null);
    setEmptyContextMenu(null);
    setContextMenuPos({ x: e.clientX, y: e.clientY });
    setGroupContextMenu({ x: e.clientX, y: e.clientY, groupId: group.id });
  };

  const handleContextMenu = (e: React.MouseEvent, tabId: string) => {
    e.preventDefault();
    e.stopPropagation();
    setGroupContextMenu(null);
    setEmptyContextMenu(null);
    setContextMenuPos({ x: e.clientX, y: e.clientY });
    setContextMenu({ x: e.clientX, y: e.clientY, tabId });

    const targetTab = workspace.tabs.get(tabId);
    if (targetTab?.tabType === 'file') {
      setContextScripts([]);
      setContextShScripts([]);
      setContextFavoriteId(null);
      return;
    }

    // Load scripts for this tab's CWD (npm + sh)
    (async () => {
      try {
        const cwd = await ipcRenderer.invoke('terminal:getCwd', tabId);
        const tabCwd = cwd || workspace.tabs.get(tabId)?.cwd || '';
        if (!tabCwd) { setContextScripts([]); setContextShScripts([]); return; }

        // npm scripts
        try {
          const result = await ipcRenderer.invoke('file:read', `${tabCwd}/package.json`);
          if (result?.success && result.content) {
            const pkg = JSON.parse(result.content);
            if (pkg.scripts) {
              setContextScripts(Object.keys(pkg.scripts).filter(name => !name.startsWith('_')));
            } else {
              setContextScripts([]);
            }
          } else {
            setContextScripts([]);
          }
        } catch {
          setContextScripts([]);
        }

        // .sh scripts
        try {
          const shResult = await ipcRenderer.invoke('file:list-sh-scripts', tabCwd);
          setContextShScripts(shResult?.success ? shResult.files : []);
        } catch {
          setContextShScripts([]);
        }
      } catch {
        setContextScripts([]);
        setContextShScripts([]);
      }
    })();

    // Check if tab is already in favorites
    setContextFavoriteId(null);
    (async () => {
      try {
        const favorites = await ipcRenderer.invoke('project:get-favorites', { projectId });
        const tab = workspace.tabs.get(tabId);
        if (tab && favorites) {
          const match = favorites.find((f: any) => f.name === tab.name && f.cwd === tab.cwd && f.tab_type === (tab.tabType || 'terminal'));
          setContextFavoriteId(match ? match.id : null);
        }
      } catch { /* ignore */ }
    })();
  };

  // Build a "kill leaked port holders" shell prefix for the SCRIPT LAUNCH path
  // (Scripts submenu → click `npm run X`). This is NOT the stop path — here the
  // process isn't running yet; we only want to free ports a previous crashed run
  // may still hold, in the SAME visible shell line: `lsof ... | kill -9; npm run X`.
  // The `;` makes it atomic-by-shell-semantics (kill finishes before npm starts),
  // it lands in scrollback + history, and now picks up env-only ports (7979) via
  // the extended detector. Returns '' when the toggle is off or no ports found.
  // (Stop/restart of a RUNNING process goes through runDeterministicStop instead.)
  const buildKillPortsPrefix = async (tabId: string): Promise<string> => {
    if (!useUIStore.getState().freePortsBeforeStart) return '';
    const tab = workspace.tabs.get(tabId);
    const cwd = tab?.cwd;
    if (!cwd) return '';
    try {
      const res = await ipcRenderer.invoke('system:detect-project-ports', cwd);
      const ports: number[] = res?.ports || [];
      if (ports.length === 0) return '';
      const lsofArg = ports.join(',');
      return `lsof -ti:${lsofArg} 2>/dev/null | xargs -r kill -9 2>/dev/null; `;
    } catch (e) {
      console.warn('[TabBar] detect-ports failed for', tabId, e);
      return '';
    }
  };

  // Restart / Stop — deterministic, event-driven, no setTimeout guesses.
  //
  // The legacy flow ("Ctrl+C → setTimeout(300) → kill+!!") was broken in two ways:
  //   1. PTY Ctrl+C only reaches the foreground process group of the shell
  //      (zsh + npm). Children that detached their controlling terminal —
  //      Electron BrowserWindow, vite preview fork, detached node spawn —
  //      survive and keep holding ports. Symptom: every ↻ on `npm run dev` for
  //      this project spawned a second Electron Dock icon, because the old one
  //      held port 7979 (NOTED_WEB_PORT) and never got the signal.
  //   2. setTimeout(300) is a guess. If the process needed >300ms to release
  //      the port, `!!` ran against an occupied port → "address in use" loop.
  //
  // New flow: one IPC call to terminal:deterministic-stop. Main does:
  //   BFS the shell PID's full descendant tree → SIGTERM all → poll kill(-0)
  //   AND lsof on declared ports every 50ms → resolve only when both lists are
  //   empty → optionally write `!!\r` to PTY. Watchdog: SIGKILL after 2000ms.
  //
  // While the call is in-flight, restartInFlight contains tabId; render layer
  // uses it to grey-out both buttons (no double-fire while polling).
  async function runDeterministicStop(tabId: string, restart: boolean) {
    if (restartInFlightRef.current.has(tabId)) return;
    const refNext = new Set(restartInFlightRef.current);
    refNext.add(tabId);
    restartInFlightRef.current = refNext;
    setRestartInFlight(new Set(refNext));
    try {
      const res = await ipcRenderer.invoke('terminal:deterministic-stop', { tabId, restart });
      if (!res?.success) {
        console.warn('[TabBar] deterministic-stop residual', res);
      }
    } catch (e) {
      console.error('[TabBar] deterministic-stop failed', e);
    } finally {
      // Listener on terminal:stop-progress { phase: 'done' } clears the flag,
      // but clear here too as a safety net for early errors that never emit.
      const doneNext = new Set(restartInFlightRef.current);
      doneNext.delete(tabId);
      restartInFlightRef.current = doneNext;
      setRestartInFlight(new Set(doneNext));
    }
  }

  const handleRestart = async (tabId: string) => {
    await runDeterministicStop(tabId, true);
  };

  const handleStop = async (tabId: string) => {
    // SDK tabs have no PTY — cancel the in-process query instead. Same guard
    // as multi-select Stop in the context menu: only dispatch was-stopped when
    // the query is actually running, otherwise idle SDK tabs would show a
    // bogus "Process stopped — history preserved" pill on middle-click.
    const tab = workspace.tabs.get(tabId);
    if (tab?.tabType === 'claude-sdk') {
      const isSDKBusy = claudeBusyMap.get(tabId);
      if (!isSDKBusy) return;
      try {
        await ipcRenderer.invoke('claude-sdk:stop', { tabId });
        window.dispatchEvent(new CustomEvent('claude-sdk:was-stopped', { detail: { tabId } }));
      } catch (e: any) { console.error('[TabBar:SDKStop] error', e); }
      return;
    }
    await runDeterministicStop(tabId, false);
  };

  // After rename closes via an EXPLICIT keyboard action (Enter/Escape), hand
  // focus back to the active terminal so the user can type immediately — the
  // terminal's own auto-focus was suppressed while the rename input was up
  // (isExternalEditableFocused). NOT called on blur: a blur means the user
  // clicked some other target (Timeline, notes, another tab) and we must not
  // yank focus away from wherever they intentionally went.
  const refocusActiveTerminal = () => {
    try { window.dispatchEvent(new CustomEvent('nt:window-refocus-active')); } catch {}
  };

  // Shared close path — also used as the input's onBlur. Commits a non-empty
  // name and exits edit mode. Does NOT refocus (see refocusActiveTerminal).
  const handleRenameSubmit = () => {
    const nextName = editValue.trim();
    const originalName = editOriginalValue.trim();
    if (editingTabId && nextName && nextName !== originalName) {
      renameTab(projectId, editingTabId, nextName);
    }
    setEditingTabId(null);
    setEditValue('');
    setEditOriginalValue('');
  };

  const handleRenameKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleRenameSubmit();
      refocusActiveTerminal();
    } else if (e.key === 'Escape') {
      setEditingTabId(null);
      setEditValue('');
      setEditOriginalValue('');
      refocusActiveTerminal();
    }
  };

  const handleGroupRenameSubmit = () => {
    if (editingGroupId && groupEditValue.trim()) {
      renameTabGroup(projectId, editingGroupId, groupEditValue.trim());
    }
    setEditingGroupId(null);
    setGroupEditValue('');
  };

  const handleGroupRenameKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleGroupRenameSubmit();
      refocusActiveTerminal();
    } else if (e.key === 'Escape') {
      setEditingGroupId(null);
      setGroupEditValue('');
      refocusActiveTerminal();
    }
  };

  const startGroupRename = (group: TabGroup) => {
    setEditingTabId(null);
    setEditValue('');
    setEditOriginalValue('');
    setEditingGroupId(group.id);
    setGroupEditValue(group.name);
  };

  const handleCreateGroupWithRename = () => {
    const groupId = createTabGroup(projectId);
    if (!groupId) return;
    const nextGroup = useWorkspaceStore.getState().openProjects
      .get(projectId)?.tabGroups.find(group => group.id === groupId);
    if (nextGroup) startGroupRename(nextGroup);
  };

  const tabTitleRefreshErrorText = (reason?: RefreshTabTitleReason, error?: string) => {
    switch (reason) {
      case 'unsupported-tab':
      case 'no-session':
        return 'Нет Claude/Codex session ID для названия';
      case 'no-user-prompt':
        return 'Не найдено пользовательское сообщение';
      case 'generation-failed':
        return 'Gemini не вернул название';
      case 'timeline-error':
        return error || 'Не удалось прочитать Timeline';
      case 'rename-skipped':
        return 'Название не изменилось';
      case 'tab-not-found':
        return 'Вкладка не найдена';
      case 'manual-name':
        return 'Название задано вручную';
      default:
        return 'Не удалось обновить название';
    }
  };

  const handleRefreshGeneratedTitle = async (tabId: string) => {
    if (titleRefreshInFlight.has(tabId) || tabTitleNamingIds.has(tabId)) {
      showToast('Название уже обновляется', 'info');
      return;
    }

    setTitleRefreshInFlight(prev => {
      const next = new Set(prev);
      next.add(tabId);
      return next;
    });
    setTabTitleNaming(tabId, true);
    setContextMenu(null);

    try {
      const result = await refreshGeneratedTabTitle(tabId, {
        overrideManualName: true,
        markNameSetManually: true,
      });
      if (result.ok) {
        showToast(`Название обновлено: ${result.title}`, 'success');
      } else {
        showToast(tabTitleRefreshErrorText(result.reason, result.error), result.reason === 'rename-skipped' ? 'info' : 'warning');
      }
    } catch (err: any) {
      console.warn('[TabBar:RefreshTabTitle] failed tab=' + tabId.slice(-8) + ': ' + (err?.message || String(err)));
      showToast('Не удалось обновить название', 'error');
    } finally {
      setTitleRefreshInFlight(prev => {
        const next = new Set(prev);
        next.delete(tabId);
        return next;
      });
      setTabTitleNaming(tabId, false);
    }
  };

  const handleContextRename = () => {
    if (contextMenu) {
      const tab = workspace.tabs.get(contextMenu.tabId);
      if (tab) {
        setEditingTabId(contextMenu.tabId);
        setEditValue(tab.name);
        setEditOriginalValue(tab.name);
      }
    }
    setContextMenu(null);
  };

  const handleGroupContextRename = () => {
    if (groupContextMenu) {
      const group = tabGroups.find(candidate => candidate.id === groupContextMenu.groupId);
      if (group) startGroupRename(group);
    }
    setGroupContextMenu(null);
  };

  const getGroupTabIds = (groupId: string) => {
    return Array.from(workspace.tabs.values())
      .filter(tab => !tab.parentTabId && !tab.isUtility && tab.groupId === groupId)
      .map(tab => tab.id);
  };

  const handleDeleteGroupOnly = () => {
    if (groupContextMenu) {
      deleteTabGroup(projectId, groupContextMenu.groupId);
    }
    setGroupContextMenu(null);
  };

  const closeGroupById = async (groupId: string) => {
    const groupTabIds = getGroupTabIds(groupId);
    setGroupContextMenu(null);
    if (groupTabIds.length > 0) {
      if (!(await confirmCloseTabs(groupTabIds))) return;
      for (const id of groupTabIds) {
        const tab = workspace.tabs.get(id);
        await closeTab(projectId, id, {
          skipProcessCheck: true,
          forceCleanup: true,
          aiBusyOverride: tab ? isTabTurnBusy(tab) : undefined,
        });
      }
    }
    deleteTabGroup(projectId, groupId);
  };

  const handleCloseGroup = async () => {
    if (!groupContextMenu) return;
    await closeGroupById(groupContextMenu.groupId);
  };

  const handleContextClose = () => {
    if (contextMenu) {
      const tab = workspace.tabs.get(contextMenu.tabId);
      closeTab(projectId, contextMenu.tabId, {
        skipProcessCheck: tab?.tabType === 'file',
        aiBusyOverride: tab ? isTabTurnBusy(tab) : undefined,
      });
    }
    setContextMenu(null);
  };

  const handleSetColor = (color: TabColor) => {
    if (contextMenu) {
      setTabColor(projectId, contextMenu.tabId, color);
    }
    setContextMenu(null);
  };

  const handleMoveToUtility = () => {
    if (contextMenu) toggleTabUtility(projectId, contextMenu.tabId);
    setContextMenu(null);
  };

  // Track if dragging is in progress
  const [isDraggingTab, setIsDraggingTab] = useState(false);
  const [draggingGroupIds, setDraggingGroupIds] = useState<string[]>([]);
  const tabbarVisualLockActive = isDraggingTab;
  const dropCooldownRef = useRef(false);

  // Monitor drag start/end for utils dropdown behavior
  useEffect(() => {
    return monitorForElements({
      canMonitor: ({ source }) => source.data.type === 'TAB' || source.data.type === 'TAB_GROUP',
      onDragStart: ({ source }) => {
        setIsDraggingTab(true);
        const data = source.data as DragData;
        if (data.type === 'TAB') {
          setDraggingGroupIds(data.selectedTabIds?.length ? data.selectedTabIds : [data.id]);
        }
      },
      onDrop: () => {
        setIsDraggingTab(false);
        setDraggingGroupIds([]);
        if (performance.now() < tabDndLogUntilRef.current) {
          console.log(
            `[TabDnd:secondary-drop] project=${shortDndId(projectId)}` +
            ` keptGeometry=${verticalDragGeometryRef.current ? verticalDragGeometryRef.current.id : 'none'}` +
            ` keptAnchor=${verticalDragAnchorRef.current ? 1 : 0}` +
            ` keptPreview=${dragPreviewKeyRef.current ? 1 : 0}`
          );
        }
        dropCooldownRef.current = true;
        setTimeout(() => { dropCooldownRef.current = false; }, 100);
        // Close Utils if it was opened by hover (not manually)
        if (utilityExpanded && !utilityOpenedManually) {
          setUtilityExpanded(false);
        }
      },
    });
  }, [projectId, utilityExpanded, utilityOpenedManually]);

  // Close utils dropdown on click outside (but not during drag)
  useEffect(() => {
    if (!utilityExpanded) return;

    const handleClickOutside = (e: MouseEvent) => {
      // Don't close during drag
      if (isDraggingTab) return;

      const target = e.target as HTMLElement;
      // Don't close if clicking inside utils dropdown or button
      if (target.closest('[data-utils-dropdown]') || target.closest('[data-utils-button]')) {
        return;
      }
      setUtilityExpanded(false);
    };

    // Use click instead of mousedown to avoid closing on drag start
    const timer = setTimeout(() => {
      document.addEventListener('click', handleClickOutside);
    }, 10);

    return () => {
      clearTimeout(timer);
      document.removeEventListener('click', handleClickOutside);
    };
  }, [utilityExpanded, isDraggingTab]);

  // Clear tab selection on click outside TabBar
  useEffect(() => {
    if (selectedTabIds.length <= 1) return;

    const handleMouseDown = (e: MouseEvent) => {
      if (isDraggingTab) return;
      if (dropCooldownRef.current) return;
      const tabBarEl = scrollContainerRef.current?.parentElement;
      if (tabBarEl && tabBarEl.contains(e.target as Node)) return;
      if ((e.target as HTMLElement).closest('[data-tab-context-menu]')) return;
      if ((e.target as HTMLElement).closest('[data-utils-dropdown]')) return;
      if ((e.target as HTMLElement).closest('[data-utils-button]')) return;
      if ((e.target as HTMLElement).closest('[data-keep-selection]')) return;
      console.log('[TabBar] clearSelection triggered by mousedown outside TabBar', {
        target: (e.target as HTMLElement).tagName,
        className: String((e.target as HTMLElement).className || '').slice(0, 80),
        selectedCount: selectedTabIds.length
      });
      clearSelection(projectId);
    };

    document.addEventListener('mousedown', handleMouseDown);
    return () => document.removeEventListener('mousedown', handleMouseDown);
  }, [selectedTabIds.length, isDraggingTab, projectId, clearSelection]);

  // Check if active tab is in utility zone
  const activeTabInUtils = currentView === 'terminal' && utilityTabs.some(t => t.id === workspace.activeTabId);

  // Check if any utility tab has a running process
  const hasProcessInUtils = utilityTabs.some(t => processStatus.get(t.id));

  // Utils hover handlers - instant open/close
  const handleUtilsMouseEnter = useCallback(() => {
    if (utilityCloseTimeoutRef.current) {
      clearTimeout(utilityCloseTimeoutRef.current);
      utilityCloseTimeoutRef.current = null;
    }
    if (!utilityExpanded) {
      setUtilityExpanded(true);
      setUtilityOpenedManually(false);
    }
  }, [utilityExpanded]);

  const handleUtilsMouseLeave = useCallback(() => {
    if (utilityHoverTimeoutRef.current) {
      clearTimeout(utilityHoverTimeoutRef.current);
      utilityHoverTimeoutRef.current = null;
    }
    // Small delay to allow moving to dropdown
    if (!utilityOpenedManually && utilityExpanded) {
      utilityCloseTimeoutRef.current = setTimeout(() => {
        setUtilityExpanded(false);
      }, 100);
    }
  }, [utilityOpenedManually, utilityExpanded]);

  const handleDropdownMouseEnter = useCallback(() => {
    // Clear close timeout when entering dropdown
    if (utilityCloseTimeoutRef.current) {
      clearTimeout(utilityCloseTimeoutRef.current);
      utilityCloseTimeoutRef.current = null;
    }
  }, []);

  const handleDropdownMouseLeave = useCallback(() => {
    // Close when leaving dropdown (if not opened manually)
    if (!utilityOpenedManually) {
      utilityCloseTimeoutRef.current = setTimeout(() => {
        setUtilityExpanded(false);
      }, 200);
    }
  }, [utilityOpenedManually]);

  // Cleanup timeouts on unmount
  useEffect(() => {
    return () => {
      if (utilityHoverTimeoutRef.current) clearTimeout(utilityHoverTimeoutRef.current);
      if (utilityCloseTimeoutRef.current) clearTimeout(utilityCloseTimeoutRef.current);
    };
  }, []);

  // Auto-scroll when dragging near edges
  useEffect(() => {
    const scrollContainer = scrollContainerRef.current;
    if (!scrollContainer) return;

    return autoScrollForElements({
      element: scrollContainer,
      canScroll: ({ source }) => source.data.type === 'TAB' || source.data.type === 'TAB_GROUP',
      getConfiguration: () => ({
        maxScrollSpeed: 'fast',
      }),
    });
  }, []);

  // Auto-scroll to active tab when it changes (e.g. new tab created off-screen)
  useEffect(() => {
    const scrollContainer = scrollContainerRef.current;
    if (!scrollContainer || !workspace.activeTabId) return;

    // Small delay to let DOM update with the new tab
    const timer = setTimeout(() => {
      const activeIndex = mainTabs.findIndex(t => t.id === workspace.activeTabId);
      if (activeIndex === -1) return;

      const tabElements = scrollContainer.querySelectorAll('[data-tab-item]');
      const activeEl = tabElements[activeIndex] as HTMLElement | undefined;
      if (activeEl) {
        activeEl.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
      }
    }, 50);

    return () => clearTimeout(timer);
  }, [workspace.activeTabId, mainTabs.length]);

  // Wheel handler. Horizontal layout — конвертирует deltaY в горизонтальный scroll
  // чтобы юзер мог листать табы колесом без зажатия Shift. Vertical layout —
  // NO-op (нативный вертикальный scroll работает сам, форсить scrollLeft на
  // overflowX:hidden контейнере = блокировка прокрутки).
  useEffect(() => {
    if (isVerticalLayout) return;
    const scrollContainer = scrollContainerRef.current;
    if (!scrollContainer) return;

    const handleWheel = (e: WheelEvent) => {
      if (e.deltaY !== 0) {
        e.preventDefault();
        scrollContainer.scrollLeft += e.deltaY;
      }
    };

    scrollContainer.addEventListener('wheel', handleWheel, { passive: false });
    return () => scrollContainer.removeEventListener('wheel', handleWheel);
  }, [isVerticalLayout]);

  // Vertical sidebar layout — left column, list runs top→bottom, main scrolls
  // vertically, utility is inline below with a divider. Reuses ALL the state &
  // handlers from above (drag-drop, context menu, multi-select, busy maps,
  // hover preview). The only difference from horizontal mode is the chrome.
  const verticalBody = (
    <div
      data-tabbar-vertical
      className="h-full w-full bg-panel flex flex-col overflow-hidden relative"
      onMouseEnter={() => setIsMouseInTabBar(true)}
      onMouseLeave={() => setIsMouseInTabBar(false)}
    >
      {reopenPulseActive && (
        <div className="absolute inset-0 pointer-events-none animate-reopen-pulse" aria-hidden />
      )}

      {/* Main zone — scrolls vertically */}
      <div
        ref={scrollContainerRef}
        className="flex-1 flex flex-col scrollbar-hide"
        style={{ overflowX: 'hidden', overflowY: 'auto', minHeight: 0 }}
      >
        {mainTabs.length === 0 && tabGroups.length === 0 ? (
          <EmptyMainZone
            onDrop={(tabId) => moveTabToZone(projectId, tabId, false, 0)}
            onDoubleClick={handleNewTabAtEnd}
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setContextMenu(null);
              setGroupContextMenu(null);
              setContextMenuPos({ x: e.clientX, y: e.clientY });
              setEmptyContextMenu({ x: e.clientX, y: e.clientY });
            }}
          />
        ) : (
          <div
            ref={verticalMainListRef}
            data-vertical-main-list
            className="flex flex-col"
            style={{ position: 'relative', gap: `${tabSidebarGap}px`, padding: `${tabSidebarGap}px` }}
          >
            {verticalRows.map((row) => {
              const renderTab = (tab: TabData, groupId?: string, groupIndex?: number) => {
                const index = mainTabsForDisplay.findIndex(t => t.id === tab.id);
                const visualDepth = Math.max(0, visualDepthById.get(tab.id) || 0);
                const tabNode = (
                  <TabItem
                    key={tab.id}
                    tab={tab}
                    index={index}
                    groupId={groupId}
                    groupIndex={groupIndex}
                    zone="main"
                    projectId={projectId}
                    orientation="vertical"
                    suppressDropIndicator
                    sessionStatus={tab.sessionStatus as SessionStatus | undefined}
                    isActive={currentView === 'terminal' && workspace.activeTabId === tab.id}
                    isSelected={selectedTabIds.includes(tab.id)}
                    isEditing={editingTabId === tab.id}
                    editValue={editValue}
                    onSwitch={(e) => {
                      handleTabClick(e, tab.id);
                      if (!e.defaultPrevented) setProjectView(projectId, 'terminal');
                    }}
                    onClose={(e) => handleCloseTab(e, tab.id)}
                    onDoubleClick={() => {
                      if (!isMultiSelect && tab.tabType !== 'file') handleDoubleClick(tab.id, tab.name);
                    }}
                    onContextMenu={(e) => handleContextMenu(e, tab.id)}
                    onEditChange={setEditValue}
                    onEditSubmit={handleRenameSubmit}
                    onEditKeyDown={handleRenameKeyDown}
                    inputRef={inputRef as React.RefObject<HTMLInputElement>}
                    fontSize={tabsFontSize}
                    hasProcess={hasVisibleProcessBar(tab)}
                    commandType={tab.commandType}
                    hasSession={sessionStatus.get(tab.id) || !!tab.claudeSessionId || !!tab.geminiSessionId || !!tab.codexSessionId}
                    isBusy={isTabTurnBusy(tab)}
                    isTitleNaming={tabTitleNamingIds.has(tab.id) || titleRefreshInFlight.has(tab.id)}
                    isAwaitingInput={awaitingMap.get(tab.id) || false}
                    sdkProcessAlive={!!tab.sdkProcessAlive}
                    onRestart={handleRestart}
                    onStop={handleStop}
                    isStopping={restartInFlight.has(tab.id)}
                    isInterrupted={isTabInterrupted(tab)}
                    draggingGroupIds={draggingGroupIds}
                    isAnyDragging={tabbarVisualLockActive}
                    onHoverChange={(hovering, rect) => handleTabHoverChange(tab.id, hovering, rect)}
                    showNotesPeek={isCmdPressed && isMouseInTabBar && !!workspace.tabs.get(tab.id)?.notes}
                    slideoutOpenHere={openSlideoutTabId === tab.id}
                    anySlideoutOpen={anySlideoutOpen}
                    cmdPeekMode={isCmdPressed && isMouseInTabBar}
                    isCollapsed={!!tab.isCollapsed}
                    isViewingSubAgent={viewingSubAgentParentId === tab.id}
                    completionNotificationArmed={!!tab.completionNotificationArmed}
                    completionNotificationFired={!!tab.completionNotificationFired}
                  />
                );
                if (!visualDepth) return tabNode;
                const parentTab = tab.visualParentTabId
                  ? mainTabsForDisplay.find(candidate => candidate.id === tab.visualParentTabId)
                  : null;
                const parentIsActive = !!parentTab && currentView === 'terminal' && workspace.activeTabId === parentTab.id;
                const connectorColor = parentTab
                  ? getVisualConnectorColor(parentTab, parentIsActive)
                  : 'rgba(255,255,255,0.14)';
                const indent = Math.min(18, 3 + (visualDepth - 1) * 6);
                const connectorLeft = 3;
                const currentDisplayIndex = mainTabsForDisplay.findIndex(candidate => candidate.id === tab.id);
                const nextDisplayTab = currentDisplayIndex >= 0
                  ? mainTabsForDisplay[currentDisplayIndex + 1]
                  : undefined;
                const hasNextVisualSibling = !!tab.visualParentTabId
                  && nextDisplayTab?.visualParentTabId === tab.visualParentTabId;
                return (
                  <div
                    key={tab.id}
                    data-visual-child-row
                    data-visual-depth={visualDepth}
                    style={{
                      position: 'relative',
                      marginLeft: indent,
                      width: `calc(100% - ${indent}px)`,
                      boxSizing: 'border-box',
                      paddingLeft: 9,
                    }}
                  >
                    <span
                      aria-hidden
                      style={{
                        position: 'absolute',
                        left: connectorLeft,
                        top: `-${tabSidebarGap}px`,
                        bottom: '50%',
                        width: 1,
                        background: connectorColor,
                        pointerEvents: 'none',
                      }}
                    />
                    {hasNextVisualSibling && (
                      <span
                        aria-hidden
                        style={{
                          position: 'absolute',
                          left: connectorLeft,
                          top: '50%',
                          bottom: `-${tabSidebarGap}px`,
                          width: 1,
                          background: connectorColor,
                          pointerEvents: 'none',
                        }}
                      />
                    )}
                    <span
                      aria-hidden
                      style={{
                        position: 'absolute',
                        left: connectorLeft,
                        top: '50%',
                        width: 9,
                        height: 1,
                        background: connectorColor,
                        pointerEvents: 'none',
                      }}
                    />
                    {tabNode}
                  </div>
                );
              };

              if (row.type === 'tab') {
                return (
                  <div
                    key={row.tab.id}
                    data-vertical-row
                    data-vertical-row-key={`tab:${row.tab.id}`}
                    data-row-type="tab"
                    data-tab-id={row.tab.id}
                  >
                    {renderTab(row.tab)}
                  </div>
                );
              }
              return (
                <div
                  key={row.group.id}
                  data-vertical-row
                  data-vertical-row-key={`group:${row.group.id}`}
                  data-row-type="group"
                  data-group-id={row.group.id}
                  data-group-collapsed={row.group.collapsed ? 'true' : 'false'}
                  className="flex flex-col"
                  style={{
                    gap: row.group.collapsed ? 0 : `${tabSidebarGap}px`,
                    transition: 'gap 150ms ease',
                  }}
                >
                  <TabGroupHeader
                    group={row.group}
                    count={row.tabs.length}
                    projectId={projectId}
                    isEditing={editingGroupId === row.group.id}
                    editValue={groupEditValue}
                    onEditChange={setGroupEditValue}
                    onEditSubmit={handleGroupRenameSubmit}
                    onEditKeyDown={handleGroupRenameKeyDown}
                    inputRef={inputRef as React.RefObject<HTMLInputElement>}
                    onStartRename={() => startGroupRename(row.group)}
                    onContextMenu={(e) => handleGroupContextMenu(e, row.group)}
                    onAuxClick={(e) => {
                      if (e.button !== 1) return;
                      e.preventDefault();
                      e.stopPropagation();
                      void closeGroupById(row.group.id);
                    }}
                    onToggleCollapsed={() => handleToggleGroupCollapsed(row.group)}
                    onFocusGroup={() => setActiveTabGroup(projectId, row.group.id)}
                    isFocused={workspace.activeGroupId === row.group.id}
                    isAnyDragging={tabbarVisualLockActive}
                  />
                  {(row.tabs.length > 0 || !row.group.collapsed) && (
                    <div
                      data-tab-group-collapse
                      data-group-id={row.group.id}
                      style={{
                        display: 'grid',
                        gridTemplateRows: row.group.collapsed ? '0fr' : '1fr',
                        opacity: 1,
                        transform: row.group.collapsed ? 'translateY(-2px)' : 'translateY(0)',
                        transition: 'grid-template-rows 150ms ease, transform 150ms ease',
                        pointerEvents: row.group.collapsed ? 'none' : 'auto',
                      }}
                      onTransitionRun={handleGroupCollapseTransition}
                      onTransitionStart={handleGroupCollapseTransition}
                      onTransitionEnd={handleGroupCollapseTransition}
                      onTransitionCancel={handleGroupCollapseTransition}
                      aria-hidden={row.group.collapsed ? true : undefined}
                    >
                      <div
                        data-tab-group-body
                        data-group-id={row.group.id}
                        className="flex flex-col"
                        style={{
                          overflow: 'hidden',
                          minHeight: 0,
                          gap: `${tabSidebarGap}px`,
                          marginLeft: 9,
                          paddingLeft: 7,
                          borderLeft: '1px solid rgba(139,92,246,0.22)',
                        }}
                      >
                        {row.tabs.length > 0 ? (
                          row.tabs.map((tab, groupIndex) => (
                            <div
                              key={tab.id}
                              data-vertical-row-key={`tab:${tab.id}`}
                              data-group-tab-row
                              data-tab-id={tab.id}
                            >
                              {renderTab(tab, row.group.id, groupIndex)}
                            </div>
                          ))
                        ) : (
                          <div
                            data-empty-group-placeholder
                            data-group-id={row.group.id}
                            style={{
                              minHeight: 24,
                              padding: `${tabGeometry.paddingY}px ${tabGeometry.paddingX}px ${tabGeometry.paddingY}px ${tabGeometry.paddingLeft}px`,
                              borderRadius: tabGeometry.borderRadius,
                              boxSizing: 'border-box',
                              fontSize: `${tabsFontSize}px`,
                              color: '#71717a',
                              backgroundColor: flattenRgbaOnTabbarPanel('rgba(139,92,246,0.055)'),
                              border: `1px dashed ${flattenRgbaOnTabbarPanel('rgba(139,92,246,0.24)')}`,
                              display: 'flex',
                              alignItems: 'center',
                              userSelect: 'none',
                            }}
                          >
                            Пусто
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
        {/* Empty drop zone at end — captures drops after last tab + double-click = new tab */}
        {(mainTabsForDisplay.length > 0 || tabGroups.length > 0) && (
          <EmptyDropZone
            orientation="vertical"
            onDropMain={(tabId) => {
              const lastRow = verticalRows[verticalRows.length - 1];
              const currentWorkspace = useWorkspaceStore.getState().openProjects.get(projectId);
              const currentTabs = currentWorkspace
                ? orderTabsWithVisualChildren(
                    Array.from(currentWorkspace.tabs.values()).filter(tab => !tab.parentTabId && !tab.isUtility)
                  ).map(tab => tab.id)
                : mainTabsForDisplay.map(t => t.id);
              if (!currentTabs.includes(tabId)) return;
              const newOrder = currentTabs.filter(id => id !== tabId);
              newOrder.push(tabId);
              if (lastRow?.type === 'group' && lastRow.tabs.length > 0 && lastRow.tabs.every(tab => tab.id === tabId)) {
                applyTabLayout(projectId, newOrder, { [tabId]: lastRow.group.id });
                return;
              }
              reorderInZone(projectId, 'main', newOrder);
            }}
            onDropFromUtility={(tabId) => {
              moveTabToZone(projectId, tabId, false, mainTabsForDisplay.length);
            }}
            onDropGroup={(groupId) => {
              const currentWorkspace = useWorkspaceStore.getState().openProjects.get(projectId);
              if (!currentWorkspace) return;
              const groupIds = Array.from(currentWorkspace.tabs.values())
                .filter(tab => !tab.parentTabId && !tab.isUtility && tab.groupId === groupId)
                .map(tab => tab.id);
              const currentTabs = orderTabsWithVisualChildren(
                Array.from(currentWorkspace.tabs.values()).filter(tab => !tab.parentTabId && !tab.isUtility)
              ).map(tab => tab.id);
              if (groupIds.length === 0) {
                applyTabLayout(projectId, currentTabs, {}, {}, { [groupId]: null });
                return;
              }
              const newOrder = currentTabs.filter(id => !groupIds.includes(id));
              newOrder.push(...groupIds);
              applyTabLayout(projectId, newOrder, {});
            }}
            onHoverChange={setEmptyZoneHovered}
            onDoubleClick={handleNewTabAtEnd}
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setContextMenu(null);
              setGroupContextMenu(null);
              setContextMenuPos({ x: e.clientX, y: e.clientY });
              setEmptyContextMenu({ x: e.clientX, y: e.clientY });
            }}
          />
        )}
      </div>

      {/* Utility zone — inline section below main, separated by a divider */}
      {utilityTabs.length > 0 && (
        <>
          <div className="border-t border-border-main" />
          <div className="px-2 py-1 text-[10px] uppercase tracking-wider text-[#666] flex items-center gap-1">
            <span>Utils</span>
            <span className="bg-[#444] px-1.5 rounded text-[10px]">{utilityTabs.length}</span>
            {hasProcessInUtils && (
              <span
                style={{
                  width: '5px', height: '5px', borderRadius: '50%',
                  backgroundColor: '#fff', opacity: 0.6, marginLeft: 'auto',
                }}
              />
            )}
          </div>
          <ZoneDropTarget zone="utility" isEmpty={false}>
            <div className="flex flex-col max-h-[40%] overflow-y-auto scrollbar-hide" style={{ gap: `${tabSidebarGap}px`, padding: `${tabSidebarGap}px` }}>
              {utilityTabs.map((tab, index) => (
                <TabItem
                  key={tab.id}
                  tab={tab}
                  index={index}
                  zone="utility"
                  projectId={projectId}
                  orientation="vertical"
                  sessionStatus={tab.sessionStatus as SessionStatus | undefined}
                  isActive={currentView === 'terminal' && workspace.activeTabId === tab.id}
                  isSelected={selectedTabIds.includes(tab.id)}
                  isEditing={editingTabId === tab.id}
                  editValue={editValue}
                  onSwitch={(e) => {
                    handleTabClick(e, tab.id);
                    if (!e.defaultPrevented) setProjectView(projectId, 'terminal');
                  }}
                  onClose={(e) => handleCloseTab(e, tab.id)}
                  onDoubleClick={() => {
                    if (!isMultiSelect && tab.tabType !== 'file') handleDoubleClick(tab.id, tab.name);
                  }}
                  onContextMenu={(e) => handleContextMenu(e, tab.id)}
                  onEditChange={setEditValue}
                  onEditSubmit={handleRenameSubmit}
                  onEditKeyDown={handleRenameKeyDown}
                  inputRef={inputRef as React.RefObject<HTMLInputElement>}
                  fontSize={tabsFontSize}
                  hasProcess={hasVisibleProcessBar(tab)}
                  commandType={tab.commandType}
                  hasSession={sessionStatus.get(tab.id) || !!tab.claudeSessionId || !!tab.geminiSessionId || !!tab.codexSessionId}
                  isBusy={isTabTurnBusy(tab)}
                  isTitleNaming={tabTitleNamingIds.has(tab.id) || titleRefreshInFlight.has(tab.id)}
                  isAwaitingInput={awaitingMap.get(tab.id) || false}
                  sdkProcessAlive={!!tab.sdkProcessAlive}
                  onRestart={handleRestart}
                  onStop={handleStop}
                  isStopping={restartInFlight.has(tab.id)}
                  isInterrupted={isTabInterrupted(tab)}
                  draggingGroupIds={draggingGroupIds}
                  isAnyDragging={isDraggingTab}
                  onHoverChange={(hovering, rect) => handleTabHoverChange(tab.id, hovering, rect)}
                  showNotesPeek={isCmdPressed && isMouseInTabBar && !!workspace.tabs.get(tab.id)?.notes}
                slideoutOpenHere={openSlideoutTabId === tab.id}
                anySlideoutOpen={anySlideoutOpen}
                cmdPeekMode={isCmdPressed && isMouseInTabBar}
                  isCollapsed={!!tab.isCollapsed}
                  isViewingSubAgent={viewingSubAgentParentId === tab.id}
                  completionNotificationArmed={!!tab.completionNotificationArmed}
                  completionNotificationFired={!!tab.completionNotificationFired}
                />
              ))}
            </div>
          </ZoneDropTarget>
        </>
      )}
    </div>
  );

  return (
    <>
      {isVerticalLayout ? verticalBody : (
      /* Single row TabBar */
      <div
        className="h-[30px] bg-panel flex items-stretch relative"
        onMouseEnter={() => setIsMouseInTabBar(true)}
        onMouseLeave={() => setIsMouseInTabBar(false)}
      >
        {/* Shift+Cmd+T pulse — fires synchronously on keydown before the
            createTab + claude-c handshake resolves, so the user gets a
            same-frame visual ack. pointer-events-none so it never blocks tab
            clicks. animate-reopen-pulse is 2 cycles × 300ms = 600ms, matching
            the auto-clear in useUIStore::triggerReopenPulse. */}
        {reopenPulseActive && (
          <div
            className="absolute inset-0 pointer-events-none animate-reopen-pulse"
            aria-hidden
          />
        )}
        {/* Sidebar toggle */}
        <Tooltip content="Toggle sidebar">
        <button
          onClick={() => {
            const { sidebarOpen } = getSidebarState(projectId);
            setSidebarOpen(projectId, !sidebarOpen);
          }}
          className="h-full flex items-center px-2 text-[#666] hover:text-white hover:bg-[rgba(255,255,255,0.05)] transition-all duration-150"
        >
          <PanelLeft size={16} />
        </button>
        </Tooltip>

        {/* Utility Zone - Left side */}
        <div
          className="relative flex items-center h-full"
          data-utils-button
          onMouseEnter={handleUtilsMouseEnter}
          onMouseLeave={handleUtilsMouseLeave}
        >
          <UtilsButtonDropTarget
            onDropToUtils={(tabId) => toggleTabUtility(projectId, tabId)}
            onHoverDrag={(isOver) => {
              if (isOver && !utilityExpanded) {
                setUtilityExpanded(true);
                setUtilityOpenedManually(false); // Opened by hover, not click
              } else if (!isOver && !utilityOpenedManually) {
                setUtilityExpanded(false);
              }
            }}
          >
            <button
              onClick={() => {
                setUtilityExpanded(!utilityExpanded);
                setUtilityOpenedManually(!utilityExpanded); // Track manual toggle
              }}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
                padding: '0 12px',
                height: '100%',
                fontSize: `${tabsFontSize}px`,
                color: activeTabInUtils ? '#fff' : '#888',
                backgroundColor: activeTabInUtils ? 'rgba(255,255,255,0.05)' : 'transparent',
                borderTop: activeTabInUtils ? '2px solid rgba(255,255,255,0.7)' : '2px solid transparent',
                cursor: 'pointer',
                transition: 'all 0.15s ease'
              }}
              onMouseEnter={(e) => {
                if (!activeTabInUtils) {
                  e.currentTarget.style.color = '#fff';
                  e.currentTarget.style.backgroundColor = 'rgba(255,255,255,0.05)';
                }
              }}
              onMouseLeave={(e) => {
                if (!activeTabInUtils) {
                  e.currentTarget.style.color = '#888';
                  e.currentTarget.style.backgroundColor = 'transparent';
                }
              }}
            >
              <ChevronDown
                size={16}
                className={`transition-transform duration-200 ${utilityExpanded ? 'rotate-180' : ''}`}
              />
              {hasProcessInUtils && (
                <span
                  style={{
                    width: '5px',
                    height: '5px',
                    borderRadius: '50%',
                    backgroundColor: '#fff',
                    opacity: 0.6,
                    flexShrink: 0,
                  }}
                />
              )}
              <span>Utils</span>
              {utilityTabs.length > 0 && (
                <span className="bg-[#444] px-1.5 rounded text-[10px]">{utilityTabs.length}</span>
              )}
            </button>
          </UtilsButtonDropTarget>

          {utilityExpanded && (
            <div
              data-utils-dropdown
              className="absolute top-full left-0 bg-panel border border-border-main shadow-xl min-w-[160px] z-50 overflow-hidden"
              onMouseEnter={handleDropdownMouseEnter}
              onMouseLeave={handleDropdownMouseLeave}
            >
              <ZoneDropTarget zone="utility" isEmpty={utilityTabs.length === 0}>
                {utilityTabs.length === 0 ? (
                  <div className="p-3 text-[11px] text-[#666] italic">
                    Drag tabs here
                  </div>
                ) : (
                  <div className="flex flex-col gap-[1px]">
                    {utilityTabs.map((tab, index) => (
                      <TabItem
                        key={tab.id}
                        tab={tab}
                        index={index}
                        zone="utility"
                        projectId={projectId}
                        isActive={currentView === 'terminal' && workspace.activeTabId === tab.id}
                        isSelected={selectedTabIds.includes(tab.id)}
                        isEditing={editingTabId === tab.id}
                        editValue={editValue}
                        onSwitch={(e) => {
                          handleTabClick(e, tab.id);
                          if (!e.defaultPrevented && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
                            setUtilityExpanded(false); // Close dropdown only on direct switch
                          }
                          if (!e.defaultPrevented) setProjectView(projectId, 'terminal');
                        }}
                        onClose={(e) => handleCloseTab(e, tab.id)} // Close tab, not move to main
                        onDoubleClick={() => {
                      if (!isMultiSelect && tab.tabType !== 'file') {
                        handleDoubleClick(tab.id, tab.name);
                      }
                    }}
                        onContextMenu={(e) => handleContextMenu(e, tab.id)}
                        onEditChange={setEditValue}
                        onEditSubmit={handleRenameSubmit}
                        onEditKeyDown={handleRenameKeyDown}
                        inputRef={inputRef as React.RefObject<HTMLInputElement>}
                        fontSize={tabsFontSize}
                        hasProcess={hasVisibleProcessBar(tab)}
                        commandType={tab.commandType}
                        hasSession={sessionStatus.get(tab.id) || !!tab.claudeSessionId || !!tab.geminiSessionId || !!tab.codexSessionId}
                        isBusy={isTabTurnBusy(tab)}
                        isTitleNaming={tabTitleNamingIds.has(tab.id) || titleRefreshInFlight.has(tab.id)}
                        isAwaitingInput={awaitingMap.get(tab.id) || false}
                        sdkProcessAlive={!!tab.sdkProcessAlive}
                        onRestart={handleRestart}
                        onStop={handleStop}
                        isStopping={restartInFlight.has(tab.id)}
                        isInterrupted={isTabInterrupted(tab)}
                        draggingGroupIds={draggingGroupIds}
                        isAnyDragging={isDraggingTab}
                        onHoverChange={(hovering, rect) => handleTabHoverChange(tab.id, hovering, rect)}
                        showNotesPeek={isCmdPressed && isMouseInTabBar && !!workspace.tabs.get(tab.id)?.notes}
                slideoutOpenHere={openSlideoutTabId === tab.id}
                anySlideoutOpen={anySlideoutOpen}
                cmdPeekMode={isCmdPressed && isMouseInTabBar}
                        isCollapsed={!!tab.isCollapsed}
                        isViewingSubAgent={viewingSubAgentParentId === tab.id}
                        completionNotificationArmed={!!tab.completionNotificationArmed}
                        completionNotificationFired={!!tab.completionNotificationFired}
                      />
                    ))}
                  </div>
                )}
              </ZoneDropTarget>
            </div>
          )}
        </div>

        {/* Main Tabs Zone - wrapper for scroll + empty zone */}
        <div className="flex-1 flex items-stretch h-full min-w-0">
          {/* Scrollable tabs container */}
          <div
            ref={scrollContainerRef}
            className="flex items-stretch h-full scrollbar-hide"
            style={{
              overflowX: 'auto',
              overflowY: 'hidden',
              minWidth: 0,
              flexShrink: 1,
            }}
          >
            {mainTabs.length === 0 ? (
              /* Empty main zone - show drop target */
              <EmptyMainZone
                onDrop={(tabId) => moveTabToZone(projectId, tabId, false, 0)}
                onDoubleClick={handleNewTabAtEnd}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setContextMenu(null);
                  setGroupContextMenu(null);
                  setContextMenuPos({ x: e.clientX, y: e.clientY });
                  setEmptyContextMenu({ x: e.clientX, y: e.clientY });
                }}
              />
            ) : (
              /* Tabs */
              <div className="flex items-stretch h-full flex-shrink-0 gap-[1px]">
                {mainTabs.map((tab, index) => (
                  <TabItem
                    key={tab.id}
                    tab={tab}
                    index={index}
                    zone="main"
                    projectId={projectId}
                    isActive={currentView === 'terminal' && workspace.activeTabId === tab.id}
                    isSelected={selectedTabIds.includes(tab.id)}
                    isEditing={editingTabId === tab.id}
                    editValue={editValue}
                    onSwitch={(e) => {
                      handleTabClick(e, tab.id);
                      if (!e.defaultPrevented) setProjectView(projectId, 'terminal');
                    }}
                    onClose={(e) => handleCloseTab(e, tab.id)}
                    onDoubleClick={() => {
                      if (!isMultiSelect && tab.tabType !== 'file') {
                        handleDoubleClick(tab.id, tab.name);
                      }
                    }}
                    onContextMenu={(e) => handleContextMenu(e, tab.id)}
                    onEditChange={setEditValue}
                    onEditSubmit={handleRenameSubmit}
                    onEditKeyDown={handleRenameKeyDown}
                    inputRef={inputRef as React.RefObject<HTMLInputElement>}
                    forceRightIndicator={emptyZoneHovered && index === mainTabs.length - 1}
                    fontSize={tabsFontSize}
                    hasProcess={hasVisibleProcessBar(tab)}
                    commandType={tab.commandType}
                    hasSession={sessionStatus.get(tab.id) || !!tab.claudeSessionId || !!tab.geminiSessionId || !!tab.codexSessionId}
                    isBusy={isTabTurnBusy(tab)}
                    isTitleNaming={tabTitleNamingIds.has(tab.id) || titleRefreshInFlight.has(tab.id)}
                    isAwaitingInput={awaitingMap.get(tab.id) || false}
                    sdkProcessAlive={!!tab.sdkProcessAlive}
                    onRestart={handleRestart}
                    onStop={handleStop}
                    isStopping={restartInFlight.has(tab.id)}
                    isInterrupted={isTabInterrupted(tab)}
                    draggingGroupIds={draggingGroupIds}
                    isAnyDragging={isDraggingTab}
                    onHoverChange={(hovering, rect) => handleTabHoverChange(tab.id, hovering, rect)}
                    showNotesPeek={isCmdPressed && isMouseInTabBar && !!workspace.tabs.get(tab.id)?.notes}
                slideoutOpenHere={openSlideoutTabId === tab.id}
                anySlideoutOpen={anySlideoutOpen}
                cmdPeekMode={isCmdPressed && isMouseInTabBar}
                    isCollapsed={!!tab.isCollapsed}
                    isViewingSubAgent={viewingSubAgentParentId === tab.id}
                    completionNotificationArmed={!!tab.completionNotificationArmed}
                    completionNotificationFired={!!tab.completionNotificationFired}
                  />
                ))}
              </div>
            )}
          </div>

          {/* Empty drop zone - OUTSIDE scroll container, captures drops after last tab */}
          {mainTabs.length > 0 && (
            <EmptyDropZone
              onDropMain={(tabId) => {
                // Reorder within main - move to end
                const currentTabs = mainTabs.map(t => t.id);
                if (!currentTabs.includes(tabId)) return;
                const newOrder = currentTabs.filter(id => id !== tabId);
                newOrder.push(tabId);
                reorderInZone(projectId, 'main', newOrder);
              }}
              onDropFromUtility={(tabId) => {
                // Move from utility to main (at end)
                moveTabToZone(projectId, tabId, false, mainTabs.length);
              }}
              onHoverChange={setEmptyZoneHovered}
              onDoubleClick={handleNewTab}
              onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setContextMenu(null);
                setGroupContextMenu(null);
                setContextMenuPos({ x: e.clientX, y: e.clientY });
                setEmptyContextMenu({ x: e.clientX, y: e.clientY });
              }}
            />
          )}
        </div>
      </div>
      )}

      {/* Context Menu - styled like terminal context menu */}
      {contextMenu && (
        <div
          ref={contextMenuRef}
          data-tab-context-menu
          className="fixed bg-[#2a2a2a] border border-[#444] shadow-2xl w-[240px] max-w-[calc(100vw-16px)]"
          style={{ left: contextMenuPos.x, top: contextMenuPos.y, zIndex: 100030 }}
          onClick={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
        >
          {/* Close Tab(s) + optional Stop split. Stop visible when at least one
              selected tab has a running AI process or script process. */}
          {(() => {
            // Canonical AI tints used elsewhere in the app:
            // Claude #DA7756 = Provider row primary (InfoPanel)
            // Gemini  #4E86F8 = TAB_COLORS.gemini, ApiSettingsModal, ActionsPanel copy accent
            // Codex   #10A37F = TAB_COLORS.codex
            const CLAUDE_TINT = '#DA7756';
            const GEMINI_TINT = '#4E86F8';

            // Tabs targeted by Stop = either the single right-clicked tab, or
            // all selected tabs when right-click happened on a selected one
            // (isMultiSelect already gates this). We count AI engines separately
            // so the badge can show majority+minority split.
            const targetTabIds = isMultiSelect ? selectedTabIds : (contextMenu ? [contextMenu.tabId] : []);
            const targetFileTab = !isMultiSelect && targetTabIds.length === 1 ? workspace.tabs.get(targetTabIds[0]) : null;
            const isFileTab = targetFileTab?.tabType === 'file';
            let claudeCount = 0;
            let geminiCount = 0;
            let codexCount = 0;
            let scriptCount = 0; // devServer / shell-command tabs with a live PID
            for (const id of targetTabIds) {
              const tab = workspace.tabs.get(id);
              // SDK tabs have NO PTY (so processStatus is always false), but they
              // do have an in-process query that can be cancelled. Treat an SDK tab
              // as a Stop-target whenever its busy flag is true (claude:busy-state
              // mirrors claude-sdk:busy-state).
              const isSDKBusy = tab?.tabType === 'claude-sdk' && claudeBusyMap.get(id);
              if (!processStatus.get(id) && !isSDKBusy) continue;
              const cmd = tab?.commandType;
              if (tab?.tabType === 'claude-sdk') claudeCount++;
              else if (cmd === 'claude') claudeCount++;
              else if (cmd === 'gemini') geminiCount++;
              else if (cmd === 'codex') codexCount++;
              else scriptCount++; // bash, devServer, shell-script — everything else with live process
            }
            const totalAI = claudeCount + geminiCount + codexCount;
            const showStopAI = totalAI > 0;
            // Script-stop branch — same split-button layout but green tint (process indicator color),
            // and Ctrl+C path instead of SIGTERM (zsh/bash handles SIGINT, no danger zone like Claude TUI).
            const showStopScript = !showStopAI && scriptCount > 0;
            const SCRIPT_TINT = '#dc2626'; // cherry-red — distinguish from green "running" dot; AI buttons keep their own tints

            // Majority decides base color. Minority is rendered as a small "+N"
            // badge, so mixed Claude/Gemini/Codex selections stay readable.
            const aiCounts = [
              { label: 'Claude', count: claudeCount, tint: CLAUDE_TINT },
              { label: 'Gemini', count: geminiCount, tint: GEMINI_TINT },
              { label: 'Codex', count: codexCount, tint: '#10A37F' },
            ].filter(x => x.count > 0).sort((a, b) => b.count - a.count);
            const majorAi = aiCounts[0] || { label: 'AI', count: 0, tint: CLAUDE_TINT };
            const baseTint = majorAi.tint;
            const minorityTint = aiCounts[1]?.tint || baseTint;
            const majorCount = majorAi.count;
            const minorCount = Math.max(0, totalAI - majorCount);

            // Label: single tab keeps full name, multi just shows count under the icon
            const singleTab = totalAI === 1 && targetTabIds.length === 1;
            const stopLabel = singleTab
              ? `Stop ${majorAi.label}`
              : `Stop ${majorCount}`;

            const handleClose = async () => {
              if (isMultiSelect) {
                const startedAt = performance.now();
                console.warn(
                  '[Perf:CloseTabsBatch] start' +
                  ' project=' + projectId.slice(-12) +
                  ' count=' + selectedTabIds.length +
                  ' trigger=' + String(contextMenu?.tabId || '').slice(-12) +
                  ' source=context-menu' +
                  ' startAbs=' + (performance.timeOrigin + startedAt).toFixed(1)
                );
                if (await confirmCloseTabs(selectedTabIds)) {
                  for (const id of selectedTabIds) {
                    const tab = workspace.tabs.get(id);
                    await closeTab(projectId, id, { skipProcessCheck: true, forceCleanup: true, aiBusyOverride: tab ? isTabTurnBusy(tab) : undefined });
                  }
                  console.warn(
                    '[Perf:CloseTabsBatch] done' +
                    ' project=' + projectId.slice(-12) +
                    ' count=' + selectedTabIds.length +
                    ' source=context-menu' +
                    ' durMs=' + (performance.now() - startedAt).toFixed(1)
                  );
                } else {
                  console.warn(
                    '[Perf:CloseTabsBatch] cancelled' +
                    ' project=' + projectId.slice(-12) +
                    ' count=' + selectedTabIds.length +
                    ' source=context-menu' +
                    ' durMs=' + (performance.now() - startedAt).toFixed(1)
                  );
                }
              } else {
                handleContextClose();
              }
              setContextMenu(null);
            };

            if (isFileTab) {
              return (
                <div
                  className="px-3 py-1.5 text-[13px] text-[#d8b4fe] flex items-center gap-2 border-b border-[#3a3a3a] min-w-0"
                  title={targetFileTab?.name || 'Linked File'}
                >
                  <FileText size={13} className="text-[#a78bfa] flex-shrink-0" />
                  <span className="min-w-0 flex-1 truncate">{targetFileTab?.name || 'Linked File'}</span>
                </div>
              );
            }

            const handleStopAI = async (e: React.MouseEvent) => {
              e.stopPropagation();
              setContextMenu(null);
              // Fire all SIGTERMs in parallel \u2014 main handles its own grace + escalation per PID
              await Promise.all(targetTabIds.map(id => {
                const tab = workspace.tabs.get(id);
                const cmd = tab?.commandType;
                // SDK route: cancel the in-process query (claude-sdk:stop). No PTY.
                if (tab?.tabType === 'claude-sdk') {
                  if (!claudeBusyMap.get(id)) return null;
                  // Same Resume-affordance signal as the chip + tab dot use.
                  window.dispatchEvent(new CustomEvent('claude-sdk:was-stopped', { detail: { tabId: id } }));
                  return ipcRenderer.invoke('claude-sdk:stop', { tabId: id });
                }
                if (cmd !== 'claude' && cmd !== 'gemini' && cmd !== 'codex') return null;
                if (!processStatus.get(id)) return null;
                return ipcRenderer.invoke('terminal:stop-ai-process', id);
              }).filter(Boolean));
            };

            // Script stop \u2014 send Ctrl+C via terminal:input. zsh/bash forwards SIGINT to foreground
            // process group, which is the running npm/script. Tab stays alive (only the foreground
            // process dies), so user can re-run from history or close manually.
            // If "free ports" toggle is on \u2014 also SIGKILL anything still holding the project's
            // declared ports, in case Ctrl+C only killed the visible wrapper and left a leaked child.
            const handleStopScript = async (e: React.MouseEvent) => {
              e.stopPropagation();
              setContextMenu(null);
              // Deterministic stop on every selected script tab in parallel.
              // Main BFSes each shell's descendant tree, SIGTERMs all, polls for
              // death + port release, escalates to SIGKILL at 2s.
              await Promise.all(targetTabIds.map(async (id) => {
                if (!processStatus.get(id)) return;
                const cmd = workspace.tabs.get(id)?.commandType;
                if (cmd === 'claude' || cmd === 'gemini' || cmd === 'codex') return;
                await runDeterministicStop(id, false);
              }));
            };

            const scriptLabel = (() => {
              if (scriptCount === 1 && targetTabIds.length === 1) {
                return 'Stop Proc';
              }
              return `Stop ${scriptCount}`;
            })();

            const tooltipParts = [];
            if (claudeCount > 0) tooltipParts.push(`${claudeCount} Claude`);
            if (geminiCount > 0) tooltipParts.push(`${geminiCount} Gemini`);
            if (codexCount > 0) tooltipParts.push(`${codexCount} Codex`);
            const tooltipText = `SIGTERM to ${tooltipParts.join(' + ')} (SIGKILL after 800ms if any hangs)`;

            // Stop pill — extracted so we can place it in two-row grid (single) OR
            // legacy one-row layout (multi-select). Reserves the right slot even when
            // nothing's running, so the 2×2 grid stays symmetric. In idle state shows
            // a muted disabled pill — `add new` row stops looking like a single full-width
            // button (was visually inconsistent with the Rename/Close row below).
            const stopPill = showStopAI ? (
              <Tooltip content={tooltipText}>
              <button
                className="flex-1 basis-0 min-w-0 px-2 py-1.5 text-[12px] cursor-pointer flex items-center justify-center gap-1.5 border-l border-[#444] whitespace-nowrap"
                style={{ color: baseTint, backgroundColor: baseTint + '14' }}
                onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = baseTint + '33'; }}
                onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = baseTint + '14'; }}
                onClick={handleStopAI}
              >
                <span style={{ width: 8, height: 8, borderRadius: 2, backgroundColor: baseTint, display: 'inline-block' }} />
                {stopLabel}
                {minorCount > 0 && (
                  <span style={{ color: minorityTint, fontWeight: 600 }}>+{minorCount}</span>
                )}
              </button>
              </Tooltip>
            ) : showStopScript ? (
              <Tooltip content="Stop process (Ctrl+C) - tab stays open">
              <button
                className="flex-1 basis-0 min-w-0 px-2 py-1.5 text-[12px] cursor-pointer flex items-center justify-center gap-1.5 border-l border-[#444] whitespace-nowrap"
                style={{ color: '#f87171', backgroundColor: 'transparent' }}
                onMouseEnter={(e) => {
                  const btn = e.currentTarget as HTMLButtonElement;
                  btn.style.backgroundColor = SCRIPT_TINT + '1f';
                  const marker = btn.querySelector('[data-stop-script-marker]') as HTMLSpanElement | null;
                  if (marker) {
                    marker.style.borderRadius = '2px';
                    marker.style.backgroundColor = '#f87171';
                    marker.style.boxShadow = 'none';
                  }
                }}
                onMouseLeave={(e) => {
                  const btn = e.currentTarget as HTMLButtonElement;
                  btn.style.backgroundColor = 'transparent';
                  const marker = btn.querySelector('[data-stop-script-marker]') as HTMLSpanElement | null;
                  if (marker) {
                    marker.style.borderRadius = '50%';
                    marker.style.backgroundColor = '#4ade80';
                    marker.style.boxShadow = '0 0 6px rgba(74,222,128,0.6)';
                  }
                }}
                onClick={handleStopScript}
              >
                <span
                  data-stop-script-marker
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: '50%',
                    backgroundColor: '#4ade80',
                    display: 'inline-block',
                    boxShadow: '0 0 6px rgba(74,222,128,0.6)',
                    transition: 'border-radius 100ms ease, background-color 100ms ease, box-shadow 100ms ease',
                  }}
                />
                {scriptLabel}
              </button>
              </Tooltip>
            ) : (
              <Tooltip content="No active process to stop">
              <button
                disabled
                className="flex-1 basis-0 min-w-0 px-2 py-1.5 text-[12px] flex items-center justify-center gap-1.5 border-l border-[#444] cursor-not-allowed whitespace-nowrap"
                style={{ color: '#555', backgroundColor: 'transparent' }}
              >
                <span style={{ width: 8, height: 8, borderRadius: '50%', backgroundColor: '#444', display: 'inline-block' }} />
                Stop
              </button>
              </Tooltip>
            );

            // Multi-select keeps the legacy single-row "[Close N] [Stop N]" layout —
            // Rename / + add new make no sense for a multi-select target set.
            if (isMultiSelect) {
              return (
                <div className="flex items-stretch w-full">
                  <button
                    className="flex-1 text-left px-4 py-1.5 text-[13px] text-[#ccc] hover:bg-white/10 cursor-pointer flex items-center gap-2"
                    onClick={handleClose}
                  >
                    {`Close ${selectedTabIds.length} Tabs`}
                  </button>
                  {stopPill}
                </div>
              );
            }

            // Single-tab mode: 2×2 grid.
            //   Row 1: [+ add new] [Close Tab]
            //   Row 2: [Rename]    [Stop ...]
            // + add new mirrors Cmd+T (handleNewTab → createTabAfterCurrent).
            // Close Tab uses destructive #f87171 TEXT only (no bg tint) — bg-tint
            // would conflict semantically with #dc2626 Stop Script pill.
            return (
              <>
                <div className="flex items-stretch w-full">
                  <button
                    className="flex-1 basis-0 min-w-0 text-left px-3 py-1.5 text-[13px] text-[#ccc] hover:bg-white/10 cursor-pointer flex items-center gap-2 whitespace-nowrap"
                    onClick={(e) => { e.stopPropagation(); handleNewTab(); setContextMenu(null); }}
                  >
                    <Plus size={12} className="text-[#888] flex-shrink-0" />
                    add new
                  </button>
                  <button
                    className="flex-1 basis-0 min-w-0 px-2 py-1.5 text-[12px] text-[#f87171] hover:bg-white/10 cursor-pointer flex items-center justify-center border-l border-[#444] whitespace-nowrap"
                    onClick={handleClose}
                  >
                    Close Tab
                  </button>
                </div>
                <div className="flex items-stretch w-full border-t border-[#3a3a3a]">
                  <button
                    className="flex-1 basis-0 min-w-0 text-left px-3 py-1.5 text-[13px] text-[#ccc] hover:bg-white/10 cursor-pointer flex items-center gap-2 whitespace-nowrap"
                    onClick={handleContextRename}
                  >
                    Rename
                  </button>
                  {stopPill}
                </div>
              </>
            );
          })()}

          {!isMultiSelect && (
            <>
              {(() => {
                const ctxTab = contextMenu ? workspace.tabs.get(contextMenu.tabId) : null;
                if (!ctxTab || !contextMenu || ctxTab.tabType === 'file') return null;
                const isArmed = !!ctxTab.completionNotificationArmed;
                const isFired = !!ctxTab.completionNotificationFired;
                const isPersistent = !!ctxTab.completionNotificationPersistent;
                const oneShotActive = isArmed || isFired;
                const tint = isFired ? '#ef4444' : (oneShotActive ? '#f87171' : '#888');
                const notificationTitle = isFired
                  ? 'Уведомление готово'
                  : (oneShotActive ? 'Уведомление включено' : 'Активировать уведомления');
                return (
                  <div className="flex items-stretch w-full border-t border-[#3a3a3a]">
                    <button
                      className="flex-1 basis-0 min-w-0 px-2 py-1.5 text-[13px] hover:bg-white/10 cursor-pointer flex items-center justify-center whitespace-nowrap"
                      title={notificationTitle}
                      style={{
                        color: oneShotActive ? '#fecaca' : '#ccc',
                        backgroundColor: oneShotActive ? 'rgba(239, 68, 68, 0.10)' : 'transparent',
                      }}
                      onClick={(e) => {
                        e.stopPropagation();
                        setTabCompletionNotificationArmed(projectId, contextMenu.tabId, !oneShotActive);
                        setContextMenu(null);
                      }}
                    >
                      <Bell size={13} style={{ color: tint, flexShrink: 0 }} />
                    </button>
                    <Tooltip content={isPersistent ? 'Постоянные уведомления включены' : 'Включать уведомление для каждого нового запроса'}>
                      <button
                        className="flex-1 basis-0 min-w-0 px-2 py-1.5 text-[12px] hover:bg-white/10 cursor-pointer flex items-center justify-center border-l border-[#444]"
                        style={{
                          color: isPersistent ? '#fecaca' : '#777',
                          backgroundColor: isPersistent ? 'rgba(239, 68, 68, 0.16)' : 'transparent',
                        }}
                        onClick={(e) => {
                          e.stopPropagation();
                          setTabCompletionNotificationPersistent(projectId, contextMenu.tabId, !isPersistent);
                          setContextMenu(null);
                        }}
                      >
                        <BellRing size={13} fill={isPersistent ? 'rgba(239, 68, 68, 0.35)' : 'none'} />
                      </button>
                    </Tooltip>
                  </div>
                );
              })()}

              {(() => {
                const ctxTab = contextMenu ? workspace.tabs.get(contextMenu.tabId) : null;
                if (!ctxTab || !contextMenu || ctxTab.tabType === 'file') return null;
                const ctxTabId = contextMenu.tabId;
                if (ctxTab.tabType && ctxTab.tabType !== 'terminal') return null;
                if (ctxTab.commandType === 'claude' || ctxTab.commandType === 'gemini' || ctxTab.commandType === 'codex') return null;
                const codexTargets = Array.from(workspace.tabs.values())
                  .filter((tab) => tab.id !== ctxTabId && !tab.isUtility && tab.tabType !== 'file' && tab.commandType === 'codex')
                  .map((tab) => ({ id: tab.id, name: tab.name || 'Untitled', kind: 'Codex' }));
                const selectedTriggerId = ctxTab.restartAfterTabId || null;
                const selectedTrigger = selectedTriggerId ? workspace.tabs.get(selectedTriggerId) : null;
                const hasSelection = !!selectedTriggerId;
                const oneShotActive = !!ctxTab.restartAfterArmed;
                const persistentActive = !!ctxTab.restartAfterPersistent;
                const oneShotTint = oneShotActive ? '#f87171' : '#888';
                const persistentTint = persistentActive ? '#f87171' : '#777';
                return (
                  <div className="border-t border-[#3a3a3a]">
                    <div className="relative group/restart-after">
                      <div className="w-full px-3 py-1.5 text-[13px] text-[#ccc] hover:bg-white/10 flex items-center gap-2">
                        <button
                          className="flex-1 min-w-0 text-left cursor-pointer flex items-center justify-between gap-2"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <span className="flex items-center gap-2 min-w-0">
                            <RotateCw size={12} className={hasSelection ? 'text-[#10A37F]' : 'text-[#666]'} />
                            <span className="truncate">Restart after</span>
                          </span>
                          <span className="flex items-center gap-1.5 min-w-0 text-[12px]">
                            <span className={hasSelection ? 'text-[#a7f3d0] truncate max-w-[92px]' : 'text-[#666]'}>
                              {selectedTrigger?.name || (hasSelection ? 'Missing tab' : 'Codex')}
                            </span>
                            <span className="text-[#666]">{'\u203A'}</span>
                          </span>
                        </button>
                        {hasSelection && (
                          <button
                            className="w-5 h-5 flex items-center justify-center rounded text-[#777] hover:text-[#ddd] hover:bg-white/10 cursor-pointer flex-shrink-0"
                            title="Clear"
                            onClick={(e) => {
                              e.stopPropagation();
                              setTabRestartAfterTarget(projectId, ctxTabId, null);
                            }}
                          >
                            <X size={12} />
                          </button>
                        )}
                      </div>
                      <div className="absolute left-full top-0 -ml-2 pl-2 hidden group-hover/restart-after:block">
                        <div className="bg-[#2a2a2a] border border-[#444] rounded-md shadow-2xl py-1 min-w-[220px] max-h-[300px] overflow-y-auto">
                          {codexTargets.length === 0 && (
                            <div className="context-menu-submenu-empty">No Codex tabs</div>
                          )}
                          {codexTargets.map((target) => {
                            const isSelected = target.id === selectedTriggerId;
                            return (
                              <button
                                key={target.id}
                                className="context-menu-submenu-item w-full"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setTabRestartAfterTarget(projectId, ctxTabId, target.id);
                                }}
                              >
                                <span className="context-menu-submenu-kind">{target.kind}</span>
                                <span className="context-menu-submenu-title">{target.name}</span>
                                {isSelected && <span className="ml-auto text-white">✓</span>}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    </div>

                    {hasSelection && (
                      <div className="px-3 pb-2">
                        <div className="flex items-stretch w-full border border-[#333] rounded overflow-hidden">
                          <Tooltip content={oneShotActive ? 'Разовый автоперезапуск включен' : 'Разовый автоперезапуск'}>
                            <button
                              className="flex-1 basis-0 min-w-0 px-2 py-1.5 text-[13px] hover:bg-white/10 cursor-pointer flex items-center justify-center"
                              style={{
                                color: oneShotActive ? '#fecaca' : '#ccc',
                                backgroundColor: oneShotActive ? 'rgba(239, 68, 68, 0.10)' : 'transparent',
                              }}
                              onClick={(e) => {
                                e.stopPropagation();
                                setTabRestartAfterArmed(projectId, ctxTabId, !oneShotActive);
                                setContextMenu(null);
                              }}
                            >
                              <Bell size={13} style={{ color: oneShotTint, flexShrink: 0 }} />
                            </button>
                          </Tooltip>
                          <Tooltip content={persistentActive ? 'Постоянный автоперезапуск включен' : 'Постоянный автоперезапуск'}>
                            <button
                              className="flex-1 basis-0 min-w-0 px-2 py-1.5 text-[13px] hover:bg-white/10 cursor-pointer flex items-center justify-center border-l border-[#333]"
                              style={{
                                color: persistentActive ? '#fecaca' : '#777',
                                backgroundColor: persistentActive ? 'rgba(239, 68, 68, 0.16)' : 'transparent',
                              }}
                              onClick={(e) => {
                                e.stopPropagation();
                                setTabRestartAfterPersistent(projectId, ctxTabId, !persistentActive);
                                setContextMenu(null);
                              }}
                            >
                              <BellRing size={13} style={{ color: persistentTint }} fill={persistentActive ? 'rgba(239, 68, 68, 0.35)' : 'none'} />
                            </button>
                          </Tooltip>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })()}

              {/* Status - submenu (independent of runtime type). Toggle-семантика:
                  повторный клик на активный статус снимает его. Отдельной «Без статуса»
                  кнопки нет — юзер просто кликает второй раз на выделенную галочкой строку. */}
              <div className="relative group/status">
                <button
                  className="w-full text-left px-4 py-1.5 text-[13px] text-[#ccc] hover:bg-white/10 cursor-pointer flex items-center justify-between gap-3"
                >
                  <span>Status</span>
                  <span className="flex items-center gap-1 ml-auto">
                    {ctxSessionStatuses.slice(0, 6).map((s) => (
                      <span
                        key={s.id}
                        style={{
                          width: 8,
                          height: 8,
                          borderRadius: '50%',
                          backgroundColor: s.color,
                          border: '1px solid rgba(0,0,0,0.4)',
                          display: 'inline-block',
                        }}
                      />
                    ))}
                    <span className="text-[#666] ml-1">›</span>
                  </span>
                </button>
                <div className="absolute left-full top-0 -ml-2 pl-2 hidden group-hover/status:block">
                  <div className="bg-[#2a2a2a] border border-[#444] rounded-xl shadow-2xl py-2 min-w-[220px]">
                    {ctxSessionStatuses.length === 0 && (
                      <div className="px-4 py-2 text-[12px] text-[#666] italic">
                        Нет статусов. Добавь в Settings → Системные.
                      </div>
                    )}
                    {ctxSessionStatuses.map((s) => {
                      const current = workspace.tabs.get(contextMenu.tabId)?.sessionStatus;
                      const isSelected = current === s.id;
                      return (
                        <button
                          key={s.id}
                          className="w-full text-left px-4 py-1.5 text-[13px] text-[#ccc] hover:bg-white/10 cursor-pointer flex items-center gap-3 whitespace-nowrap"
                          onClick={(e) => {
                            e.stopPropagation();
                            // Toggle: повторный клик на активный → снимаем (null).
                            setTabSessionStatus(projectId, contextMenu.tabId, isSelected ? null : s.id);
                            setContextMenu(null);
                          }}
                        >
                          <span style={{ width: 12, height: 12, borderRadius: '50%', backgroundColor: s.color, border: '1px solid rgba(0,0,0,0.4)', flexShrink: 0 }} />
                          <span>{s.label}</span>
                          {isSelected && <span className="ml-auto text-white">✓</span>}
                        </button>
                      );
                    })}
                    {!isContextFileTab && (
                      <>
                        <div className="my-1 border-t border-[#3a3a3a]" />
                        <div className="relative group/background">
                          <button
                            className="w-full text-left px-4 py-1 text-[11px] text-[#888] hover:bg-white/10 hover:text-[#bbb] cursor-pointer flex items-center justify-between gap-3 whitespace-nowrap"
                          >
                            <span>Background</span>
                            <span className="flex items-center gap-1.5 ml-auto">
                              {(() => {
                                const currentColor = workspace.tabs.get(contextMenu.tabId)?.color || 'default';
                                const meta = TAB_COLORS.find((c) => c.color === currentColor) || TAB_COLORS[0];
                                return (
                                  <span
                                    style={{
                                      width: 9,
                                      height: 9,
                                      borderRadius: 3,
                                      backgroundColor: meta.bgColor === 'transparent' ? 'transparent' : meta.borderColor,
                                      border: `1px solid ${meta.borderColor}`,
                                      display: 'inline-block',
                                    }}
                                  />
                                );
                              })()}
                              <span className="text-[#555]">›</span>
                            </span>
                          </button>
                          <div className="absolute left-full bottom-0 -ml-2 pl-2 hidden group-hover/background:block">
                            <div className="bg-[#2a2a2a] border border-[#444] rounded-xl shadow-2xl py-1 min-w-[165px]">
                              {TAB_COLORS.map((c) => {
                                const currentColor = workspace.tabs.get(contextMenu.tabId)?.color || 'default';
                                const isSelected = currentColor === c.color;
                                return (
                                  <button
                                    key={c.color}
                                    className="w-full text-left px-3 py-1 text-[12px] text-[#ccc] hover:bg-white/10 cursor-pointer flex items-center gap-2 whitespace-nowrap"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      handleSetColor(c.color);
                                    }}
                                  >
                                    <span
                                      style={{
                                        width: 11,
                                        height: 11,
                                        borderRadius: 3,
                                        backgroundColor: c.bgColor === 'transparent' ? 'transparent' : c.borderColor,
                                        border: `1px solid ${c.borderColor}`,
                                        flexShrink: 0,
                                      }}
                                    />
                                    <span>{c.label.replace(/^[^\wА-Яа-я]+\\s*/, '')}</span>
                                    {isSelected && <span className="ml-auto text-white">✓</span>}
                                  </button>
                                );
                              })}
                            </div>
                          </div>
                        </div>
                      </>
                    )}
                  </div>
                </div>
              </div>
            </>
          )}

          {/* Visual parent split control */}
          {!isMultiSelect && (
            <div className="grid grid-cols-2 border-t border-[#333] border-b border-[#333]">
              <button
                className={`px-4 py-1.5 text-[13px] flex items-center justify-center gap-2 ${
                  visualParentAboveId
                    ? 'text-[#ccc] hover:bg-white/10 cursor-pointer'
                    : 'text-[#555] cursor-not-allowed'
                }`}
                disabled={!visualParentAboveId}
                title="Make this tab child of the nearest visible tab above"
                onClick={() => attachVisualParent('up')}
              >
                <ArrowUp size={13} className={visualParentAboveId ? 'text-[#8b5cf6]' : 'text-[#555]'} />
              </button>
              <button
                className={`px-4 py-1.5 text-[13px] flex items-center justify-center gap-2 border-l border-[#333] ${
                  visualParentBelowId
                    ? 'text-[#ccc] hover:bg-white/10 cursor-pointer'
                    : 'text-[#555] cursor-not-allowed'
                }`}
                disabled={!visualParentBelowId}
                title="Make this tab child of the nearest visible tab below"
                onClick={() => attachVisualParent('down')}
              >
                <ArrowDown size={13} className={visualParentBelowId ? 'text-[#8b5cf6]' : 'text-[#555]'} />
              </button>
            </div>
          )}

          {/* Scripts - submenu */}
          {!isMultiSelect && !isContextFileTab && (contextScripts.length > 0 || contextShScripts.length > 0 || (contextMenu && processStatus.get(contextMenu.tabId) && workspace.tabs.get(contextMenu.tabId)?.commandType === 'devServer')) && (
            <div className="relative group/scripts">
              <button
                className="w-full text-left px-4 py-1.5 text-[13px] text-[#ccc] hover:bg-white/10 cursor-pointer flex items-center justify-between"
              >
                <span className="flex items-center gap-2">
                  <Play size={12} className="text-[#666]" />
                  Scripts
                  {(contextScripts.length + contextShScripts.length) > 0 && <span className="text-[10px] text-[#555]">{contextScripts.length + contextShScripts.length}</span>}
                </span>
                <span className="text-[#666]">{'\u203A'}</span>
              </button>
              <div className="absolute left-full top-0 -ml-2 pl-2 hidden group-hover/scripts:block">
                <div className="bg-[#2a2a2a] border border-[#444] rounded-xl shadow-2xl py-1 min-w-[160px] max-h-[300px] overflow-y-auto">
                  {/* Stop: <name> moved to the top-level Close+Stop split-pill (mirrors Stop Claude UX).
                      Kept here only as a fallback dropdown action if for some reason the split isn't
                      visible (e.g. process is detected late after menu opened) — but currently the
                      split handles all cases, so no entry is rendered. */}
                  {contextScripts.map((script) => (
                    <button
                      key={script}
                      className="w-full text-left px-4 py-1.5 text-[13px] text-[#ccc] hover:bg-white/10 cursor-pointer flex items-center gap-2"
                      onClick={async (e) => {
                        e.stopPropagation();
                        if (contextMenu) {
                          const tabId = contextMenu.tabId;
                          // Composite into a single shell line: `kill ports; npm run X`
                          // Visible in scrollback, atomic via `;` semantic — no race.
                          const killPrefix = await buildKillPortsPrefix(tabId);
                          ipcRenderer.send('terminal:input', tabId, `${killPrefix}npm run ${script}\r`);
                          // Detect dev-like scripts for auto-rename and green color
                          const isDevScript = /^(dev|start|serve|watch)/i.test(script);
                          if (isDevScript) {
                            useWorkspaceStore.getState().setTabCommandType(tabId, 'devServer');
                          }
                        }
                        setContextMenu(null);
                      }}
                    >
                      <div className="w-1 h-1 rounded-full bg-[#555]" />
                      <span className="truncate">{script}</span>
                    </button>
                  ))}
                  {/* Separator between npm and sh scripts */}
                  {contextScripts.length > 0 && contextShScripts.length > 0 && (
                    <div className="my-1 border-t border-[#444]" />
                  )}
                  {contextShScripts.map((file) => (
                    <button
                      key={file}
                      className="w-full text-left px-4 py-1.5 text-[13px] text-[#ccc] hover:bg-white/10 cursor-pointer flex items-center gap-2"
                      onClick={(e) => {
                        e.stopPropagation();
                        if (contextMenu) {
                          ipcRenderer.send('terminal:input', contextMenu.tabId, `./${file}\r`);
                          const isDevScript = /^(dev|start|serve|watch)/i.test(file);
                          if (isDevScript) {
                            useWorkspaceStore.getState().setTabCommandType(contextMenu.tabId, 'devServer');
                          }
                        }
                        setContextMenu(null);
                      }}
                    >
                      <div className="w-1 h-1 rounded-full bg-[#555]" />
                      <span className="truncate">./{file}</span>
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* Separator */}
          <div className="my-1 border-t border-[#444]" />

          {!isMultiSelect && isContextFileTab ? (
            <>
              <button
                className="w-full text-left px-4 py-1.5 text-[13px] text-[#ccc] hover:bg-white/10 cursor-pointer flex items-center gap-2"
                onClick={() => {
                  const tab = contextMenu ? workspace.tabs.get(contextMenu.tabId) : null;
                  const filePath = tab?.filePath || tab?.cwd || '';
                  if (filePath) {
                    window.require('electron').clipboard.writeText(filePath);
                    showToast('File path copied', 'success');
                  }
                  setContextMenu(null);
                }}
              >
                Copy Path
              </button>
              <button
                className="w-full text-left px-4 py-1.5 text-[13px] text-[#ccc] hover:bg-white/10 cursor-pointer flex items-center gap-2"
                onClick={async () => {
                  const tab = contextMenu ? workspace.tabs.get(contextMenu.tabId) : null;
                  const filePath = tab?.filePath;
                  if (!filePath) {
                    setContextMenu(null);
                    return;
                  }
                  const result = await ipcRenderer.invoke('file:read', filePath).catch(() => null);
                  if (result?.success) {
                    window.require('electron').clipboard.writeText(result.content || '');
                    showToast('File content copied', 'success');
                  } else {
                    showToast('Could not read file', 'error');
                  }
                  setContextMenu(null);
                }}
              >
                Copy Content
              </button>
              <div className="my-1 border-t border-[#444]" />
              <button
                className="w-full text-left px-4 py-1.5 text-[13px] text-[#f87171] hover:bg-white/10 cursor-pointer flex items-center gap-2"
                onClick={() => {
                  handleContextClose();
                }}
              >
                Unlink File
              </button>
            </>
          ) : (
            <button
              className="w-full text-left px-4 py-1.5 text-[13px] text-[#ccc] hover:bg-white/10 cursor-pointer flex items-center gap-2"
              onClick={() => {
                if (isMultiSelect) {
                  // Copy all selected tabs' session IDs + cwds
                  const lines: string[] = [];
                  selectedTabIds.forEach(tabId => {
                    const tab = workspace.tabs.get(tabId);
                    if (tab) {
                      const sessionId = tab.claudeSessionId || tab.geminiSessionId || tab.codexSessionId || 'no-session';
                      const path = tab.cwd || project?.path || '/';
                      lines.push(`${sessionId}\ncwd: ${path}`);
                    }
                  });
                  navigator.clipboard.writeText(lines.join('\n\n'));
                  showToast(`Copied ${selectedTabIds.length} sessions`, 'success');
                } else {
                  const tab = workspace.tabs.get(contextMenu.tabId);
                  if (tab) {
                    const sessionId = tab.claudeSessionId || tab.geminiSessionId || tab.codexSessionId || 'no-session';
                    const path = tab.cwd || project?.path || '/';
                    const text = `${sessionId}\ncwd: ${path}`;
                    navigator.clipboard.writeText(text);
                    showToast('Session ID copied', 'success');
                  }
                }
                setContextMenu(null);
              }}
            >
              {isMultiSelect ? `Copy ${selectedTabIds.length} Sessions` : 'Copy ID/Path'}
            </button>
          )}

          {/* Revert Session — submenu shown only for claude tabs with rotation history.
              Safety-net for accidental overwrites by bridge watcher / AutoResume / Timeline
              chain resolver — user can return to the previous value with one click.
              See docs/knowledge/fix-bridge-stale-takeover.md. */}
          {!isMultiSelect && contextMenu && (() => {
            const ctxTab = workspace.tabs.get(contextMenu.tabId);
            const hist = ctxTab?.claudeSessionHistory;
            if (!ctxTab || ctxTab.commandType !== 'claude' || !hist || hist.length === 0) return null;
            const fmtAgo = (ms: number) => {
              const sec = Math.floor((Date.now() - ms) / 1000);
              if (sec < 60) return sec + 's ago';
              if (sec < 3600) return Math.floor(sec / 60) + 'm ago';
              if (sec < 86400) return Math.floor(sec / 3600) + 'h ago';
              return Math.floor(sec / 86400) + 'd ago';
            };
            return (
              <div className="relative group/revert">
                <button
                  className="w-full text-left px-4 py-1.5 text-[13px] text-[#ccc] hover:bg-white/10 cursor-pointer flex items-center justify-between"
                >
                  <span className="flex items-center gap-2">
                    <span className="text-[#888]">↶</span>
                    Revert Session
                    <span className="text-[10px] text-[#555]">{hist.length}</span>
                  </span>
                  <span className="text-[#666]">{'›'}</span>
                </button>
                <div className="absolute left-full top-0 -ml-2 pl-2 hidden group-hover/revert:block">
                  <div className="bg-[#2a2a2a] border border-[#444] rounded-xl shadow-2xl py-1 min-w-[260px]">
                    {hist.map((entry, idx) => (
                      <button
                        key={entry.sessionId + idx}
                        className="w-full text-left px-3 py-1.5 text-[12px] text-[#ccc] hover:bg-white/10 cursor-pointer"
                        onClick={(e) => {
                          e.stopPropagation();
                          if (contextMenu) {
                            useWorkspaceStore.getState().setClaudeSessionId(contextMenu.tabId, entry.sessionId, 'userRevert');
                            showToast('Reverted to ' + entry.sessionId.substring(0, 8), 'success');
                          }
                          setContextMenu(null);
                        }}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-mono text-[12px]">{entry.sessionId.substring(0, 8)}</span>
                          <span className="text-[10px] text-[#777]">{fmtAgo(entry.at)}</span>
                        </div>
                        <div className="text-[10px] text-[#666] mt-0.5">{entry.reason}</div>
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            );
          })()}

          {/* Explicit AI title refresh. Unlike automatic first-launch naming,
              this is a user command, so it may override a manually named tab.
              The resulting name is still marked manual to block future auto
              launch naming from replacing it. */}
          {!isMultiSelect && contextMenu && !isContextFileTab && (() => {
            const refreshing = titleRefreshInFlight.has(contextMenu.tabId) || tabTitleNamingIds.has(contextMenu.tabId);
            return (
              <button
                className={`w-full text-left px-4 py-1.5 text-[13px] flex items-center gap-2 ${
                  refreshing
                    ? 'text-[#777] cursor-default'
                    : 'text-[#ccc] hover:bg-white/10 cursor-pointer'
                }`}
                disabled={refreshing}
                onClick={(e) => {
                  e.stopPropagation();
                  if (!contextMenu || refreshing) return;
                  void handleRefreshGeneratedTitle(contextMenu.tabId);
                }}
              >
                <RotateCw size={12} className={refreshing ? 'text-[#777] animate-spin' : 'text-[#888]'} />
                {refreshing ? 'Название обновляется...' : 'Обновить название'}
              </button>
            );
          })()}

          {/* Add / Remove Favorites */}
          {!isMultiSelect && !isContextFileTab && (
            <button
              className="w-full text-left px-4 py-1.5 text-[13px] text-[#ccc] hover:bg-white/10 cursor-pointer flex items-center gap-2"
              onClick={async (e) => {
                e.stopPropagation();
                if (contextMenu) {
                  if (contextFavoriteId) {
                    // Remove from favorites
                    await ipcRenderer.invoke('project:delete-favorite', { id: contextFavoriteId });
                    const tab = workspace.tabs.get(contextMenu.tabId);
                    showToast(`"${tab?.name || 'Tab'}" removed from favorites`, 'success');
                  } else {
                    // Add to favorites
                    const tab = workspace.tabs.get(contextMenu.tabId);
                    if (tab) {
                      await ipcRenderer.invoke('project:add-favorite', {
                        projectId,
                        tab: {
                          name: tab.name,
                          cwd: tab.cwd,
                          color: tab.color || null,
                          notes: tab.notes || null,
                          commandType: tab.commandType || null,
                          tabType: tab.tabType || 'terminal',
                          url: tab.url || null,
                          claudeSessionId: tab.claudeSessionId || null,
                          geminiSessionId: tab.geminiSessionId || null,
                          codexSessionId: tab.codexSessionId || null,
                        }
                      });
                      showToast(`"${tab.name}" added to favorites`, 'success');
                    }
                  }
                }
                setContextMenu(null);
              }}
            >
              {contextFavoriteId ? 'Remove from Favorites' : 'Add to Favorites'}
            </button>
          )}
        </div>
      )}

      {/* Group context menu */}
      {groupContextMenu && (() => {
        const group = tabGroups.find(candidate => candidate.id === groupContextMenu.groupId);
        const groupTabCount = group ? getGroupTabIds(group.id).length : 0;
        if (!group) return null;
        return (
          <div
            ref={contextMenuRef}
            data-tab-context-menu
            className="fixed bg-[#2a2a2a] border border-[#444] shadow-2xl min-w-[180px] rounded-md overflow-visible"
            style={{ left: contextMenuPos.x, top: contextMenuPos.y, zIndex: 100030 }}
            onClick={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="px-4 py-2 text-[11px] text-[#777] border-b border-[#333] flex items-center gap-2">
              <Folder size={12} className="text-[#8b5cf6]" />
              <span className="truncate">{group.name}</span>
              <span className="ml-auto">{groupTabCount}</span>
            </div>
            <button
              className="w-full text-left px-4 py-1.5 text-[13px] text-[#ccc] hover:bg-white/10 cursor-pointer"
              onClick={(e) => {
                e.stopPropagation();
                handleGroupContextRename();
              }}
            >
              Rename
            </button>
            <div className="relative group/group-status">
              <button
                className="w-full text-left px-4 py-1.5 text-[13px] text-[#ccc] hover:bg-white/10 cursor-pointer flex items-center justify-between gap-3"
              >
                <span>Status</span>
                <span className="flex items-center gap-1 ml-auto">
                  {ctxSessionStatuses.slice(0, 6).map((s) => (
                    <span
                      key={s.id}
                      style={{
                        width: 8,
                        height: 8,
                        borderRadius: '50%',
                        backgroundColor: s.color,
                        border: '1px solid rgba(0,0,0,0.4)',
                        display: 'inline-block',
                      }}
                    />
                  ))}
                  <span className="text-[#666] ml-1">›</span>
                </span>
              </button>
              <div className="absolute left-full top-0 -ml-2 pl-2 hidden group-hover/group-status:block">
                <div className="bg-[#2a2a2a] border border-[#444] rounded-xl shadow-2xl py-2 min-w-[220px]">
                  {ctxSessionStatuses.length === 0 && (
                    <div className="px-4 py-2 text-[12px] text-[#666] italic">
                      Нет статусов. Добавь в Settings → Системные.
                    </div>
                  )}
                  {ctxSessionStatuses.map((s) => {
                    const isSelected = group.sessionStatus === s.id;
                    return (
                      <button
                        key={s.id}
                        className="w-full text-left px-4 py-1.5 text-[13px] text-[#ccc] hover:bg-white/10 cursor-pointer flex items-center gap-3 whitespace-nowrap"
                        onClick={(e) => {
                          e.stopPropagation();
                          setTabGroupSessionStatus(projectId, group.id, isSelected ? null : s.id);
                          setGroupContextMenu(null);
                        }}
                      >
                        <span style={{ width: 12, height: 12, borderRadius: '50%', backgroundColor: s.color, border: '1px solid rgba(0,0,0,0.4)', flexShrink: 0 }} />
                        <span>{s.label}</span>
                        {isSelected && <span className="ml-auto text-white">✓</span>}
                      </button>
                    );
                  })}
                  <div className="my-1 border-t border-[#3a3a3a]" />
                  <div className="relative group/group-background">
                    <button
                      className="w-full text-left px-4 py-1 text-[11px] text-[#888] hover:bg-white/10 hover:text-[#bbb] cursor-pointer flex items-center justify-between gap-3 whitespace-nowrap"
                    >
                      <span>Background</span>
                      <span className="flex items-center gap-1.5 ml-auto">
                        {(() => {
                          const currentColor = group.color || 'default';
                          const meta = TAB_COLORS.find((c) => c.color === currentColor) || TAB_COLORS[0];
                          return (
                            <span
                              style={{
                                width: 9,
                                height: 9,
                                borderRadius: 3,
                                backgroundColor: meta.bgColor === 'transparent' ? 'transparent' : meta.borderColor,
                                border: `1px solid ${meta.borderColor}`,
                                display: 'inline-block',
                              }}
                            />
                          );
                        })()}
                        <span className="text-[#555]">›</span>
                      </span>
                    </button>
                    <div className="absolute left-full bottom-0 -ml-2 pl-2 hidden group-hover/group-background:block">
                      <div className="bg-[#2a2a2a] border border-[#444] rounded-xl shadow-2xl py-1 min-w-[165px]">
                        {TAB_COLORS.map((c) => {
                          const currentColor = group.color || 'default';
                          const isSelected = currentColor === c.color;
                          return (
                            <button
                              key={c.color}
                              className="w-full text-left px-3 py-1 text-[12px] text-[#ccc] hover:bg-white/10 cursor-pointer flex items-center gap-2 whitespace-nowrap"
                              onClick={(e) => {
                                e.stopPropagation();
                                setTabGroupColor(projectId, group.id, c.color);
                                setGroupContextMenu(null);
                              }}
                            >
                              <span
                                style={{
                                  width: 11,
                                  height: 11,
                                  borderRadius: 3,
                                  backgroundColor: c.bgColor === 'transparent' ? 'transparent' : c.borderColor,
                                  border: `1px solid ${c.borderColor}`,
                                  flexShrink: 0,
                                }}
                              />
                              <span>{c.label.replace(/^[^\wА-Яа-я]+\s*/, '')}</span>
                              {isSelected && <span className="ml-auto text-white">✓</span>}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
            <button
              className="w-full text-left px-4 py-1.5 text-[13px] text-[#f87171] hover:bg-white/10 cursor-pointer"
              onClick={(e) => {
                e.stopPropagation();
                void handleCloseGroup();
              }}
            >
              Close Group
            </button>
            <div className="my-1 border-t border-[#444]" />
            <button
              className="w-full text-left px-4 py-1.5 text-[13px] text-[#ccc] hover:bg-white/10 cursor-pointer"
              onClick={(e) => {
                e.stopPropagation();
                handleDeleteGroupOnly();
              }}
            >
              Delete Group
            </button>
          </div>
        );
      })()}

      {/* Empty space context menu */}
      {emptyContextMenu && (
        <div
          ref={contextMenuRef}
          data-tab-context-menu
          className="fixed bg-[#2a2a2a] border border-[#444] shadow-2xl min-w-[180px] rounded-md overflow-hidden"
          style={{ left: contextMenuPos.x, top: contextMenuPos.y, zIndex: 100030 }}
          onClick={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <button
            className="w-full text-left px-4 py-1.5 text-[13px] text-[#ccc] hover:bg-white/10 cursor-pointer flex items-center gap-2"
            onClick={() => {
              handleNewTabAtEnd();
              setEmptyContextMenu(null);
            }}
          >
            <span style={{ color: '#888' }}>+</span>
            New Terminal tab
          </button>
          <button
            className="w-full text-left px-4 py-1.5 text-[13px] text-[#ccc] hover:bg-white/10 cursor-pointer flex items-center gap-2"
            onClick={() => {
              handleCreateGroupWithRename();
              setEmptyContextMenu(null);
            }}
          >
            <Folder size={12} className="text-[#8b5cf6]" />
            New Group
          </button>
        </div>
      )}

      {/* CMD+Hover Notes Preview — unified TabPreviewPopover (name → metadata →
          notes). Same widget used in ProjectHome cards: единый визуальный язык
          для preview-вкладки в любом месте приложения. Resize handles живут
          внутри компоненты. */}
      {notesPopover.isVisible && notesPopover.hoveredItem && (() => {
        const tab = workspace.tabs.get(notesPopover.hoveredItem.id);
        const notes = tab?.notes;
        const isTabCollapsed = tab?.isCollapsed;
        if (!notes && !isTabCollapsed) return null;
        return (
          <TabPreviewPopover
            rect={notesPopover.hoveredItem.rect}
            popoverProps={notesPopover.popoverProps}
            notes={notes || null}
            isLocked={notesPopover.isLocked}
            placement={isVerticalLayout ? 'right' : 'below'}
            source="tabbar"
          />
        );
      })()}
    </>
  );
}

export default memo(TabBar);
