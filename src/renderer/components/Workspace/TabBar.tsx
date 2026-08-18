import React, { useState, useRef, useEffect, useLayoutEffect, memo, useCallback, useMemo } from 'react';
import { flushSync } from 'react-dom';
import { useWorkspaceStore, TabColor, TabGroup, isTabInterrupted } from '../../store/useWorkspaceStore';
import { useProjectsStore } from '../../store/useProjectsStore';
import ControlHint from '../UI/ControlHint';
import Tooltip from '../UI/Tooltip';
import { useUIStore } from '../../store/useUIStore';
import {
  isOrchestrationCompletionBlocked,
  subscribeOrchestrationRunChanges,
  useOrchestrationStore,
} from '../../store/useOrchestrationStore';
import { useCmdKey } from '../../hooks/useCmdHoverPopover';
import { RunAfterTabPicker } from './RunAfterTabPicker';
import { refreshGeneratedTabTitle, type RefreshTabTitleReason } from '../../utils/generateTabTitle';
import { terminalRegistry } from '../../utils/terminalRegistry';
import { isNaturalAgentTurnEndReason } from '../../utils/agentCompletionOutcome.mjs';
import { isAiForegroundProcess } from '../../utils/aiForegroundProcess.mjs';
import { requireCodexSurfaceSessionId } from '../../utils/codexWriterIdentity';
import { requestTaskPlanNavigation } from '../../utils/taskPlanNavigation';
import { PaneMapCells, usePaneMapColumns } from './PaneMap';
import { splitAvailability, paneIndexHoldingTab } from '../../utils/splitPanesModel.mjs';
import MoveToWindowMenu from './MoveToWindowMenu';
import { tabListRevealScrollTop } from '../../utils/tabListRevealScroll.mjs';
import { TabProcessBar, TabStatusMarker, TabFastBadge, TabContextUsageBadge, useTabContextUsage } from './TabSignals';
import { resolveCodexFastModeState } from '../../utils/codexFastMode.mjs';
import { resolvePtyAgentOwner } from '../../utils/ptyAgentOwner.mjs';
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
import { ChevronDown, Globe, Bot, Play, Pause, PanelLeft, Plus, RotateCw, Folder, FolderInput, ArrowLeft, ArrowRight, CircleX, Square, Bell, BellRing, FileText, X, Copy, Info, Loader2, Pencil, Columns2 } from 'lucide-react';
import {
  normalizeSelectedVisualRootIds,
  orderVisualHierarchyItems,
  resolveVisualBlockMove,
  resolveVisualHierarchyStep,
  snapRect as snapStructuredRect,
  visualHierarchyAncestorIds,
  visualHierarchySubtreeItems,
} from '@noted/structured-dnd';
import { useOutlineDnd } from '@noted/structured-dnd/react';
import {
  buildTabOutline,
  tabOutlineGroupId,
  tabOutlineHorizontalPolicy,
  tabOutlineSubtreeTabIds,
  tabOutlineToLayout,
  tabOutlineVerticalSlotPolicy,
} from './tabOutlineModel.mjs';
import {
  canReuseVerticalResolution,
  horizontalIntentFrameDeltaY,
  horizontalPointerIntentOwnsFrame,
  isMainVerticalDropTarget,
  resolveAtomicVerticalTarget,
  sameVerticalSemanticBoundary,
  unionVerticalRects,
  type AtomicVerticalTarget,
  type VerticalResolutionCache,
  type VerticalSemanticBoundary,
} from './tabVerticalDnd';
import {
  TAB_COLORS as SHARED_TAB_COLORS,
  adjustRgbaAlpha,
  flattenRgbaOnTabbarPanel,
  getTabChromeColorConfig,
} from './tabChrome';
import { isFileMissing, probeFiles, subscribeMissingFiles } from '../../utils/missingFileTracker';
import { markRendererActivity } from '../../utils/rendererActivityTrail';
import { clampMenuToViewport } from '../../utils/menuViewportClamp.mjs';
import { acceptTabBackgroundWorkRecord } from '../../utils/tabBackgroundWorkState.mjs';

const { ipcRenderer } = window.require('electron');

const COMPLETION_NOTIFICATION_DISMISS_MS = 420;
const TABBAR_DRAG_VISUAL_LOCK_ATTR = 'data-tabbar-drag-visual-lock';
const GROUP_COLLAPSE_FLIP_SUPPRESS_MS = 320;
const TAB_POST_DROP_REVEAL_DURATION_MS = 110;
const TAB_POST_DROP_REVEAL_MARGIN_PX = 24;
const TAB_POST_DROP_REVEAL_PEEK_ROWS = 3;
const TAB_POST_DROP_REVEAL_MAX_WAIT_FRAMES = 45;
const TAB_DND_NAVIGATION_DWELL_MS = 500;
const STRUCTURED_PROJECT_DROP_EVENT = 'structured-tab-project-target';

// Open the sidebar's tab context menu from ANOTHER surface (the split-pane
// header). A window event rather than a lifted store field: the menu is
// transient view state of the list that owns it, and there must stay exactly
// ONE menu implementation — a second copy in the pane header would drift from
// this one action by action.
export const TAB_CONTEXT_MENU_EVENT = 'tab-context-menu:open';

/**
 * "Rename this tab" asked for by a menu that was opened from ANOTHER surface.
 *
 * The menu itself is the sidebar's — one implementation, opened for a tab the
 * pane header names (see openTabContextMenuAt). Its Rename item, however, used
 * to start editing where the MENU lives, not where the GESTURE came from: the
 * user right-clicked the tab in the pane header and the input appeared in the
 * sidebar list, often scrolled out of view. Enter still committed the right
 * name, so the rename "worked" while looking like it had happened to the wrong
 * tab.
 *
 * So the request travels back: the surface that opened the menu says "I can
 * host the input", and Rename hands editing to it instead of opening its own.
 * The sidebar keeps its inline rename for its own right-clicks — nothing is
 * asked, so nothing answers, and the item behaves exactly as before.
 */
export const TAB_RENAME_REQUEST_EVENT = 'tab-context-menu:rename';

/**
 * Ask the sidebar list of `projectId` to open its context menu for `tabId`.
 *
 * Only ONE list is mounted — the sidebar's, for the project the sidebar shows —
 * and every item in this menu is built from that list's own project (scripts and
 * favourites of its cwd, "Move to project", the workspace toggle). So the
 * request can only be served by the list of the tab's own project.
 *
 * Panes are cross-project, so the pane header regularly names a tab whose
 * project is NOT in the sidebar. That request used to be dropped silently: the
 * user right-clicked the other pane's tab and nothing happened at all, and only
 * a preceding left click (which moved the sidebar as a side effect) made the
 * menu work. Pointing the sidebar at the tab's project first is what makes the
 * gesture land, and it is also the honest thing to show: the menu is about a tab
 * of that project.
 *
 * Deliberately NOT changing the CENTER: a right click asks about a tab, it does
 * not switch to it.
 */
export function openTabContextMenuAt(
  projectId: string,
  tabId: string,
  x: number,
  y: number,
  options?: { renameHost?: string },
): void {
  window.dispatchEvent(new CustomEvent(TAB_CONTEXT_MENU_EVENT, {
    detail: { projectId, tabId, x, y, renameHost: options?.renameHost },
  }));
}

// Маркеры реальных задач под названием вертикальной вкладки. Для ручной
// визуальной настройки геометрии меняй только эти значения.
const TASK_MARKER_PRIMARY_SIZE_PX = 9;
const TASK_MARKER_SECONDARY_SIZE_PX = 8;
const TASK_MARKER_SECONDARY_GAP_PX = 3;
const TASK_MARKER_NEXT_TAB_CLEARANCE_PX = 1;
const TASK_MARKER_HOVER_SCALE = 1.32;
const TASK_MARKER_LANE_HEIGHT_PX = Math.ceil(TASK_MARKER_SECONDARY_SIZE_PX * TASK_MARKER_HOVER_SCALE);
const TASK_MARKER_DEFAULT_COLOR = '#73737a';
const TASK_ARCHIVE_COUNTER_SIZE_PX = 10;
const TASK_ARCHIVE_RIGHT_INSET_PX = 5;

function TaskLaneMarker({
  color,
  shape,
  title,
  onClick,
}: {
  color: string;
  shape: 'dot' | 'square';
  title: string;
  onClick: (event: React.MouseEvent<HTMLButtonElement>) => void;
}) {
  const [hovered, setHovered] = useState(false);
  return (
    <button
      type="button"
      data-task-plan-tab-marker
      title={title}
      onPointerDown={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: 'block',
        width: TASK_MARKER_SECONDARY_SIZE_PX,
        height: TASK_MARKER_SECONDARY_SIZE_PX,
        flex: `0 0 ${TASK_MARKER_SECONDARY_SIZE_PX}px`,
        padding: 0,
        borderRadius: shape === 'square' ? 1 : '50%',
        backgroundColor: color,
        border: '1px solid rgba(0,0,0,0.38)',
        boxSizing: 'border-box',
        pointerEvents: 'auto',
        cursor: 'pointer',
        outline: 'none',
        transform: `scale(${hovered ? TASK_MARKER_HOVER_SCALE : 1})`,
        transformOrigin: 'center bottom',
        transition: 'transform 90ms ease, filter 90ms ease',
        filter: hovered ? 'brightness(1.18)' : 'none',
      }}
    />
  );
}

const isAiLaunchCommand = (command: string): boolean => {
  const text = command.trim();
  if (!text) return false;
  if (/(^|[;&|]\s*)(?:command\s+)?(?:codex|claude|gemini)(?=\s|$)/i.test(text)) return true;
  if (/(^|[;&|]\s*)(?:npx|pnpm\s+dlx|bunx)\s+@openai\/codex(?=\s|$)/i.test(text)) return true;
  return false;
};
const formatRestartAfterCommandLabel = (command?: string | null) => {
  const clean = String(command || '').trim();
  const npmRunMatch = clean.match(/^npm\s+run(?:-script)?\s+(.+)$/);
  return (npmRunMatch ? npmRunMatch[1] : clean).trim();
};
const COMMAND_HISTORY_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
type CommandRunHistoryEntry = {
  id?: string;
  command: string;
  at: number;
  source?: string;
  cwd?: string | null;
};
const formatCommandRunHistoryLabel = (command?: string | null) => formatRestartAfterCommandLabel(command);
const formatCommandRunHistoryTime = (at?: number | null) => {
  const date = new Date(Number(at || 0));
  if (!Number.isFinite(date.getTime())) return '';
  const dd = String(date.getDate()).padStart(2, '0');
  const mon = COMMAND_HISTORY_MONTHS[date.getMonth()] || '---';
  const yy = String(date.getFullYear() % 100).padStart(2, '0');
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  return `${dd}-${mon}-${yy} ${hh}:${mm}`;
};
const getRestartAfterTriggerIds = (tab: { id?: string; restartAfterTabId?: string; restartAfterTabIds?: string[] } | null | undefined): string[] => {
  if (!tab) return [];
  const out: string[] = [];
  const push = (value: unknown) => {
    const id = typeof value === 'string' ? value.trim() : '';
    if (!id || id === tab.id || out.includes(id)) return;
    out.push(id);
  };
  if (Array.isArray(tab.restartAfterTabIds)) {
    for (const id of tab.restartAfterTabIds) push(id);
  }
  push(tab.restartAfterTabId);
  return out;
};

type RestartAfterScriptRunState = {
  command: string;
  running: boolean;
  pendingCommand: string | null;
};

let forcedDragCursorDepth = 0;
let forcedDragCursorStyleEl: HTMLStyleElement | null = null;

// Last tab-list reveal request (seq) already handled — see the reveal effect
// inside TabBar for why this must survive the component unmounting.
let consumedTabListRevealSeq = 0;
const TABBAR_FORCE_RELEASE_EVENT = 'noted:tabbar-force-release';

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
   * 'horizontal' — legacy single-row bar above terminal.
   * 'vertical' — left sidebar mode. Tab rows span full width.
   */
  layout?: 'horizontal' | 'vertical';
  /**
   * Render NO tab list — only serve context-menu requests for this project.
   *
   * Every item of the tab menu is built from its own project (scripts and
   * favourites of the tab's cwd, "Move to project", the workspace toggle), so
   * only the list of the tab's own project can open it. The sidebar shows one
   * project, but panes are cross-project — a right click on the other pane's tab
   * therefore had no listener at all and did nothing.
   *
   * A second visible list is not the answer (two lists, two selections). This
   * mode mounts the same component with its list hidden, purely as the owner of
   * that project's menu. A right click asks ABOUT a tab; it must not navigate
   * anywhere, which is why the menu comes to the project instead of the project
   * moving to the menu.
   */
  menuOnlyForProject?: boolean;
}

interface TabData {
  id: string;
  name: string;
  color?: TabColor;
  commandType?: string;
  cwd?: string;
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
  restartAfterTabIds?: string[];
  restartAfterCommand?: string;
  restartAfterPaused?: boolean;
  restartAfterPersistent?: boolean;
  restartAfterArmed?: boolean;
}

type TabOutlineNode = {
  [key: string]: unknown;
  id: string;
  kind: 'tab' | 'group';
  entityType: 'tab' | 'group';
  label?: string;
  tabId?: string;
  groupId?: string;
  rawTab?: TabData;
  rawGroup?: TabGroup;
  collapsible?: boolean;
  expanded?: boolean;
  hasChildren?: boolean;
  children?: TabOutlineNode[];
};

type TabProjectExternalTarget = {
  id: string;
  zone: 'project';
  projectId: string;
  blocked: boolean;
};

const indexTabOutlineNodes = (nodes: TabOutlineNode[], result = new Map<string, TabOutlineNode>()) => {
  for (const node of nodes) {
    result.set(node.id, node);
    indexTabOutlineNodes(node.children || [], result);
  }
  return result;
};

const countOutlineTabs = (node: TabOutlineNode | undefined): number => {
  if (!node) return 0;
  return (node.entityType === 'tab' ? 1 : 0)
    + (node.children || []).reduce((total, child) => total + countOutlineTabs(child), 0);
};

type TabDragData = {
  type: 'TAB';
  id: string;
  zone: 'main';
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
  status: 'allowed' | 'blocked' | 'noop';
  reason?: string;
  interactionAxis?: 'vertical' | 'horizontal';
  projectionRevision?: number;
  sourceIds: string[];
  orderedIds: string[];
  groupAssignments: Record<string, string | null | undefined>;
  visualParentAssignments?: Record<string, string | null | undefined>;
  groupAnchorAssignments?: Record<string, string | null | undefined>;
  targetTabIds?: string[];
  targetGroupId?: string | null;
  targetPlacement?: 'before' | 'after' | 'inside';
  targetKind?: 'tab-block' | 'group-block' | 'group-inside';
  verticalBoundary?: VerticalSemanticBoundary;
};

type VerticalRow =
  | { type: 'tab'; tab: TabData; index: number }
  | { type: 'group'; group: TabGroup; tabs: TabData[]; index: number };

// The vertical list deliberately keeps tab rows as siblings of group headers.
// A group is presentation metadata, not a React parent for draggable rows: a
// live hierarchy projection must never remount the source while it is held.
type VerticalDisplayRow =
  | { kind: 'group-header'; group: TabGroup; count: number }
  | {
      kind: 'tab';
      tab: TabData;
      group?: TabGroup;
      groupIndex?: number;
      groupConnector?: { trunk: 'through' | 'end'; elbow: boolean };
    };

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
  scrollTop: number;
  list: RectSnap;
  rows: Array<VerticalDragTabRow | VerticalDragGroupRow>;
};
type VerticalDragAnchor = {
  offsetY: number;
  startX: number;
  horizontalBaseX: number;
  startY: number;
  sourceTop: number;
  sourceBottom: number;
  sourceMidY: number;
};
type TabHorizontalIntent = {
  sourceId: string;
  direction: 'left' | 'right';
  progress: number;
  disabled: boolean;
  reason?: string;
};

type TabDndNavigationSpringState = {
  groupId: string;
  phase: 'waiting' | 'loading';
  entryEpoch: number;
};

type TabDndNavigationSession = {
  sourceKey: string;
  active: boolean;
  suspended: boolean;
  frozenPreview: DragPreviewLayout | null;
  frozenPreviewKey: string;
  hoveredGroupId: string | null;
  entryEpoch: number;
  latched: boolean;
  collapsedBeforeDrag: Map<string, boolean>;
  temporaryToggledGroupIds: Set<string>;
};

const TAB_HORIZONTAL_INTENT_DEADZONE_PX = 6;
const TAB_VERTICAL_RESUME_AFTER_HORIZONTAL_PX = 6;
const TAB_HORIZONTAL_STEP_PX = 28;
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
  const rect = snapStructuredRect(el, { compensateTransform: true });
  return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, height: rect.height, midY: rect.midY };
};

const shortDndId = (id?: string | null) => {
  if (!id) return '-';
  return id.length > 12 ? id.slice(-12) : id;
};

const getTabSessionUuid = (tab?: { claudeSessionId?: string; geminiSessionId?: string; codexSessionId?: string } | null) =>
  tab?.claudeSessionId || tab?.geminiSessionId || tab?.codexSessionId || null;

const isCodexSessionTab = (tab?: {
  commandType?: string | null;
  claudeSessionId?: string;
  geminiSessionId?: string;
  codexSessionId?: string;
} | null) => resolvePtyAgentOwner(tab || {}) === 'codex';

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
    `status=${preview.status}`,
    `reason=${preview.reason || '-'}`,
    `source=${preview.sourceIds.map(shortDndId).join('.') || '-'}`,
    `order=${preview.orderedIds.map(shortDndId).join('>')}`,
    `groups=${groups || '-'}`,
    `visual=${visual || '-'}`,
    `anchors=${anchors || '-'}`,
    `target=${preview.targetTabIds?.map(shortDndId).join('.') || shortDndId(preview.targetGroupId || null)}`,
    `targetKind=${preview.targetKind || '-'}`,
    `placement=${preview.targetPlacement || '-'}`,
    `boundary=${preview.verticalBoundary ? `${preview.verticalBoundary.blockKey}:${preview.verticalBoundary.side}` : '-'}`,
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

// Chrome (colors + blend helpers) is shared with TabSwitcherOverlay and the
// split-pane attach row — see tabChrome.ts. Local alias narrows `color` back
// to TabColor for the context-menu palette pickers.
const TAB_COLORS = SHARED_TAB_COLORS as { color: TabColor; bgColor: string; borderColor: string; label: string }[];

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

// Shared predicate — see utils/aiForegroundProcess.mjs.


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
  // ignored, and the ↻ icon rotates to signal that the
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
        cursor: isStopping ? 'default' : undefined,
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
          // Deterministic-stop in flight: spinning ↻ icon. The
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
  zone: 'main';
  projectId: string; // For cross-project drag
  isActive: boolean;
  isSelected: boolean; // Added for multi-select
  isEditing: boolean;
  editValue: string;
  onSwitch: (e: React.MouseEvent) => void; // Pass event for modifier checks
  onRenameRequest: () => void;
  onClose: (e: React.MouseEvent) => void;
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
  onRunLastProjectCommand?: (tabId: string) => void; // Persistent Play action → run latest shell command for this tab's cwd
  isStopping?: boolean; // Deterministic-stop is mid-cycle; lock the click + spin icon
  isInterrupted?: boolean; // Tab has an interrupted AI session
  draggingGroupIds?: string[]; // IDs of tabs being dragged as a group
  draggingRootIds?: string[]; // Visible roots of the dragged source blocks
  isDragTarget?: boolean; // Part of the atomic block currently used as the drop target
  isDragBlockedTarget?: boolean;
  isAnyDragging?: boolean;
  cmdPeekMode?: boolean; // CMD held AND cursor in TabBar; enables alternate Restart actions (Stop/Clear).
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
  orientation?: 'horizontal' | 'vertical'; // Layout direction. The horizontal bar is the default;
                                            // TabSidebar overrides it to vertical.
  sessionStatus?: SessionStatus; // Status marker color (vertical mode only).
  completionNotificationArmed?: boolean;
  completionNotificationFired?: boolean;
  completionNotificationPersistent?: boolean;
  restartAfterFallbackCommand?: string | null;
  onCommandHistoryOpen?: (e: React.MouseEvent, tabId: string) => void;
  disableLegacyDnd?: boolean;
  outlineFeedback?: {
    direction: 'left' | 'right';
    progress: number;
    blocked: boolean;
    reason?: string | null;
  } | null;
  outlineNavigationPaused?: boolean;
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
  onRenameRequest,
  onClose,
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
  onRunLastProjectCommand,
  isStopping = false,
  isInterrupted = false,
  draggingGroupIds = [],
  draggingRootIds = [],
  isDragTarget = false,
  isDragBlockedTarget = false,
  isAnyDragging = false,
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
  restartAfterFallbackCommand = null,
  onCommandHistoryOpen,
  disableLegacyDnd = false,
  outlineFeedback = null,
  outlineNavigationPaused = false,
}: TabItemProps) => {
  const ref = useRef<HTMLDivElement>(null);
  const [closestEdge, setClosestEdge] = useState<Edge | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [isPressing, setIsPressing] = useState(false);
  const [isAdoptTarget, setIsAdoptTarget] = useState(false);
  const [isHovered, setIsHovered] = useState(false);
  const [isRestartButtonHovered, setIsRestartButtonHovered] = useState(false);
  const [taskArchivePreviewOpen, setTaskArchivePreviewOpen] = useState(false);
  const isOrchestrationInheritedBusy = useOrchestrationStore((s) => s.inheritedBusyTabIds.has(tab.id));
  const bodyCursorRef = useRef<string | null>(null);
  const doubleClickRenameRef = useRef(false);

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
    const forceRelease = () => {
      setIsDragging(false);
      setIsPressing(false);
      setClosestEdge(null);
      setIsAdoptTarget(false);
      clearBodyGrabbing();
    };
    window.addEventListener(TABBAR_FORCE_RELEASE_EVENT, forceRelease);
    return () => window.removeEventListener(TABBAR_FORCE_RELEASE_EVENT, forceRelease);
  }, [clearBodyGrabbing]);

  useEffect(() => {
    if (!isAnyDragging) return;
    if (isHovered) {
      setIsHovered(false);
    }
    if (isRestartButtonHovered) setIsRestartButtonHovered(false);
  }, [isAnyDragging, isHovered, isRestartButtonHovered]);

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

  const effectiveOrientation: 'horizontal' | 'vertical' = orientation ?? 'horizontal';
  const isHorizontal = effectiveOrientation === 'horizontal';
  const dragRuntimeRef = useRef({ tab, zone, index, projectId, groupId, groupIndex, isHorizontal });
  dragRuntimeRef.current = { tab, zone, index, projectId, groupId, groupIndex, isHorizontal };

  useEffect(() => {
    if (disableLegacyDnd) return;
    const element = ref.current;
    if (!element) return;

    const registrations: Array<() => void> = [];
    if (!disableLegacyDnd) {
      registrations.push(draggable({
        element,
        getInitialData: (): DragData => {
          const current = dragRuntimeRef.current;
          const ws = useWorkspaceStore.getState().openProjects.get(current.projectId);
          const sel = ws?.selectedTabIds || [];
          const tabIds = sel.includes(current.tab.id) ? sel : [current.tab.id];
          return {
            type: 'TAB',
            id: current.tab.id,
            zone: current.zone,
            index: current.index,
            projectId: current.projectId,
            selectedTabIds: tabIds,
            groupId: current.groupId,
            groupIndex: current.groupIndex,
          };
        },
        onGenerateDragPreview: ({ nativeSetDragImage }) => {
          const current = dragRuntimeRef.current;
          if (!current.isHorizontal) {
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

          const ws = useWorkspaceStore.getState().openProjects.get(current.projectId);
          const sel = ws?.selectedTabIds || [];
          const count = sel.includes(current.tab.id) ? sel.length : 1;
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
              name.textContent = current.tab.name;
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
      }));
    }
    registrations.push(dropTargetForElements({
        element,
        getData: ({ input, element }) => {
          const current = dragRuntimeRef.current;
          const allowedEdges: Edge[] = current.isHorizontal ? ['left', 'right'] : ['top', 'bottom'];
          const data = attachClosestEdge(
            {
              type: 'TAB',
              id: current.tab.id,
              zone: current.zone,
              index: current.index,
              groupId: current.groupId,
              groupIndex: current.groupIndex,
            },
            { element, input, allowedEdges }
          );
          return attachListInstruction(data, {
            element,
            input,
            axis: current.isHorizontal ? 'horizontal' : 'vertical',
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
      }));
    return combine(...registrations);
  }, [disableLegacyDnd, tab.id, zone, projectId, isAdoptDrop, isHorizontal, setDropIndicatorEdge]);

  // Settings → Размеры → ТАБЫ → Терминал. Геометрия каждой карточки таба.
  // Поднято в начало TabItem чтобы быть до объявления tabStyle ниже.
  const tabGeo = useUIStore((s) => s.tabGeometry);

  // Shared with the switcher and the recent-tabs list — one mark, one meaning.
  const paneMapColumns = usePaneMapColumns(projectId, tab.id);

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
  const taskStatusMarkerShape = useUIStore((s) => s.taskStatusMarker.shape);
  const taskStatuses = useUIStore((s) => s.taskStatuses);
  const taskStatusById = useMemo(
    () => new Map(taskStatuses.map((status) => [status.id, status])),
    [taskStatuses],
  );
  const liveTaskPlan = useWorkspaceStore((state) => state.openProjects.get(projectId)?.tabs.get(tab.id)?.taskPlan);
  const taskPlan = liveTaskPlan || tab.taskPlan;
  const activeTaskPlanItems = taskPlan?.items || [];
  const archivedTaskPlanItems = taskPlan?.archivedItems || [];
  const showTaskMarkerLane = isVerticalMode
    && zone === 'main'
    && !isCollapsed
    && (activeTaskPlanItems.length > 0 || archivedTaskPlanItems.length > 0);
  const verticalPaddingTop = showTaskMarkerLane ? Math.max(0, tabGeo.paddingY - 2) : tabGeo.paddingY;
  const verticalPaddingBottom = showTaskMarkerLane ? tabGeo.paddingY + 2 : tabGeo.paddingY;
  const taskMarkerLaneLeft = tabGeo.paddingLeft;
  const taskMarkerLaneRight = archivedTaskPlanItems.length > 0
    ? TASK_ARCHIVE_RIGHT_INSET_PX + TASK_ARCHIVE_COUNTER_SIZE_PX + TASK_MARKER_SECONDARY_GAP_PX
    : tabGeo.paddingX;
  const navigateFromTaskMarker = useCallback((
    event: React.MouseEvent<HTMLButtonElement>,
    view: 'active' | 'archive',
    taskId?: string,
  ) => {
    event.stopPropagation();
    onSwitch(event);
    requestTaskPlanNavigation({ tabId: tab.id, taskId, view });
  }, [onSwitch, tab.id]);
  const isVertActive = !isHorizontal && isActive;
  const isDraggedByMonitor = draggingGroupIds.includes(tab.id);
  const isDraggedRoot = draggingRootIds.includes(tab.id);
  const isDraggedDescendant = isDraggedByMonitor && !isDraggedRoot;
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
  const rawEffectiveTabBackgroundColor = isAdoptTarget
    ? 'rgba(99, 102, 241, 0.15)'
    : (isDragBlockedTarget
      ? 'rgba(239, 68, 68, 0.13)'
      : (isDragTarget
      ? 'rgba(59, 130, 246, 0.20)'
      : (isDraggedDescendant ? 'rgba(139, 92, 246, 0.13)' : rawTabBackgroundColor)));
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
  const dragLiftActive = isVerticalMode && (isPressing || isDragging || isDraggedRoot);
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
    isDragBlockedTarget ? 'inset 0 0 0 1.5px rgba(248, 113, 113, 0.86)' : null,
    isDragTarget ? 'inset 0 0 0 1.5px rgba(96, 165, 250, 0.82)' : null,
    isDraggedDescendant ? 'inset 0 0 0 1px rgba(167, 139, 250, 0.55)' : null,
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
        : ((isVerticalMode
          ? `${verticalPaddingTop}px ${tabGeo.paddingX}px ${verticalPaddingBottom}px ${tabGeo.paddingLeft}px`
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
    opacity: outlineNavigationPaused
      ? 0.62
      : (isVerticalMode && isAnyDragging ? 1 : (isDragging ? (isVerticalMode ? 1 : 0.5) : (isDraggedByMonitor && !dragLiftActive ? 0.5 : (isCollapsed && !isActive ? 0.6 : 1)))),
    transform: undefined,
    transformOrigin: 'center',
    outline: isDragBlockedTarget
      ? '1px dashed rgba(248, 113, 113, 0.86)'
      : (dragLiftActive ? '1px solid rgba(139, 92, 246, 0.78)' : undefined),
    outlineOffset: isDragBlockedTarget ? '-2px' : (dragLiftActive ? '-1px' : undefined),
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
  const verticalIsInheritedBusy = isOrchestrationInheritedBusy && !verticalIsAiBusy;
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
  // Linked file gone from disk → red FileText icon. Shared verdict cache with
  // the Ctrl+Tab switcher; probe fires on hover/render throttled by TTL.
  const [missingTick, setMissingTick] = useState(0);
  useEffect(() => {
    if (tab.tabType !== 'file' || !tab.filePath) return;
    probeFiles([tab.filePath]);
    return subscribeMissingFiles(() => setMissingTick((v) => v + 1));
  }, [tab.tabType, tab.filePath]);
  void missingTick;
  const linkedFileMissing = tab.tabType === 'file' && isFileMissing(tab.filePath);
  // position — left|right (юзер выбирает в Settings). Цвет полоски и shimmer
  // читаются через CSS-переменные на :root (App.tsx синхронизирует).
  const processBarPosition = useUIStore((s) => s.processBar.position);
  const restartAfterTriggerIds = getRestartAfterTriggerIds(tab);
  const restartAfterConfigured = restartAfterTriggerIds.length > 0 || !!tab.restartAfterCommand;
  const restartAfterCommandLabel = formatRestartAfterCommandLabel(tab.restartAfterCommand)
    || (restartAfterTriggerIds.length > 0 ? formatRestartAfterCommandLabel(restartAfterFallbackCommand) : '');
  const restartAfterCommandDisplayLabel = restartAfterCommandLabel
    ? `${restartAfterCommandLabel}${restartAfterTriggerIds.length > 0 ? ` [${restartAfterTriggerIds.length}]` : ''}`
    : '';
  const restartAfterPaused = !!tab.restartAfterPaused;
  const canShowVerticalRestartButton = isVerticalMode && (
    (tab.color === 'green' && hasProcess) || restartAfterConfigured
  );
  const verticalRestartStopMode = canShowVerticalRestartButton
    && hasProcess
    && isRestartButtonHovered
    && cmdPeekMode
    && !restartAfterConfigured
    && commandType === 'devServer'
    && !!onStop
    && !isStopping;
  const verticalRestartClearMode = canShowVerticalRestartButton
    && restartAfterConfigured
    && isRestartButtonHovered
    && cmdPeekMode
    && !isStopping;
  const verticalRestartHoverActive = canShowVerticalRestartButton && isRestartButtonHovered && !isStopping;
  const verticalRestartButtonBackground = verticalRestartStopMode
    ? 'rgba(248, 113, 113, 0.16)'
    : verticalRestartClearMode
      ? 'rgba(248, 113, 113, 0.16)'
    : restartAfterConfigured
      ? (restartAfterPaused
        ? (verticalRestartHoverActive ? 'rgba(113, 113, 122, 0.26)' : 'rgba(113, 113, 122, 0.14)')
        : (verticalRestartHoverActive ? 'rgba(139, 92, 246, 0.24)' : 'rgba(139, 92, 246, 0.13)'))
      : (verticalRestartHoverActive ? 'rgba(34,197,94,0.18)' : '#1e1e2e');
  const verticalRestartButtonColor = isStopping
    ? '#666'
    : verticalRestartStopMode
      ? '#f87171'
      : verticalRestartClearMode
        ? '#fca5a5'
      : restartAfterConfigured
        ? (restartAfterPaused
          ? (verticalRestartHoverActive ? '#e4e4e7' : '#a1a1aa')
          : (verticalRestartHoverActive ? '#ede9fe' : '#c4b5fd'))
        : (verticalRestartHoverActive ? '#bbf7d0' : '#86efac');
  const verticalRestartButtonBorder = verticalRestartStopMode
    ? '1px solid rgba(248, 113, 113, 0.35)'
    : verticalRestartClearMode
      ? '1px solid rgba(248, 113, 113, 0.35)'
    : restartAfterConfigured
      ? (restartAfterPaused ? '1px solid rgba(113, 113, 122, 0.42)' : '1px solid rgba(139, 92, 246, 0.45)')
      : '1px solid rgba(34,197,94,0.25)';
  const verticalRestartPauseButtonBackground = restartAfterPaused
    ? 'rgba(113, 113, 122, 0.24)'
    : 'rgba(113, 113, 122, 0.10)';
  const verticalRestartPauseButtonColor = restartAfterPaused ? '#e4e4e7' : '#a1a1aa';
  const verticalRestartPauseButtonBorder = restartAfterPaused
    ? '1px solid rgba(161, 161, 170, 0.45)'
    : '1px solid rgba(161, 161, 170, 0.24)';
  const verticalActionIsAiRuntimeTab = tab.tabType === 'claude-sdk'
    || commandType === 'claude'
    || commandType === 'codex'
    || commandType === 'gemini'
    || !!tab.claudeSessionId
    || !!tab.geminiSessionId
    || !!tab.codexSessionId;
  const verticalActionIsPlainTerminalTab = !tab.tabType || tab.tabType === 'terminal';
  const canShowVerticalActionSlot = isVerticalMode && tab.tabType !== 'file' && !(tab.color === 'green' && hasProcess);
  const canRunLastCommandHere = verticalActionIsPlainTerminalTab && !verticalActionIsAiRuntimeTab && !hasProcess && !sdkProcessAlive && !isBusy;
  const showVerticalLastCommandPlay = canShowVerticalActionSlot
    && !!onRunLastProjectCommand
    && canRunLastCommandHere;
  const hasVerticalRightActionCluster = showVerticalLastCommandPlay || restartAfterConfigured || canShowVerticalRestartButton;
  // Settings → форма маркера статуса (круг или квадрат) + размер в px.
  const statusMarkerShape = useUIStore((s) => s.statusMarker.shape);
  const statusMarkerSize = useUIStore((s) => s.statusMarker.sizePx);
  // Codex Fast для карточки. Читается ТЕМ ЖЕ резолвером, что и кнопка Fast в
  // панели управления: два независимых вычисления «включён ли Fast» разошлись бы
  // на первом же граничном случае, а граничный случай здесь основной — тариф
  // принадлежит КОНКРЕТНОМУ writer'у, и после смены сессии старое доказательство
  // силы не имеет. Поэтому на unknown значка нет вовсе: соврать «Fast выключен»
  // так же плохо, как соврать «включён».
  //
  // Селекторы гранулярные (Fingerprint): подписка на Map перерисовывала бы всё
  // приложение на любое изменение любой вкладки.
  const codexLiveServiceTier = useWorkspaceStore(
    (s) => s.openProjects.get(projectId)?.tabs.get(tab.id)?.codexLiveServiceTier,
  );
  const codexLiveServiceTierSessionId = useWorkspaceStore(
    (s) => s.openProjects.get(projectId)?.tabs.get(tab.id)?.codexLiveServiceTierSessionId,
  );
  const codexLiveSettingsSessionId = useWorkspaceStore(
    (s) => s.openProjects.get(projectId)?.tabs.get(tab.id)?.codexLiveSettingsSessionId,
  );
  // Заполнение контекста этой вкладки. Хук сам читает durable-значение и
  // слушает все три канала обновления (Claude/Codex/SDK).
  const tabContextPct = useTabContextUsage(tab.id);
  const codexFastActive = resolveCodexFastModeState({
    currentSessionId: codexLiveSettingsSessionId
      || codexLiveServiceTierSessionId
      || tab.codexSessionId,
    serviceTierSessionId: codexLiveServiceTierSessionId,
    serviceTier: codexLiveServiceTier,
  }).active;
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
    const rendersProcessBar = isVerticalMode && !isCollapsed && (verticalHasProcess || verticalIsAiBusy || verticalIsInheritedBusy);
    const rendersShimmer = rendersProcessBar && (verticalIsAiBusy || verticalIsInheritedBusy);
    const signature = [
      isVerticalMode ? 1 : 0,
      isCollapsed ? 1 : 0,
      verticalHasProcess ? 1 : 0,
      verticalIsAiBusy ? 1 : 0,
      verticalIsInheritedBusy ? 1 : 0,
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
      ' inheritedBusy=' + verticalIsInheritedBusy +
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
    verticalIsInheritedBusy,
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
        if (disableLegacyDnd) return;
        if (e.button !== 0) return;
        const target = e.target as HTMLElement | null;
        if (target?.closest('[data-no-tab-drag],button,input,textarea,select,a')) return;
        setIsPressing(true);
        setBodyGrabbing();
      }}
      onClick={(e) => {
        if (e.detail === 1) {
          doubleClickRenameRef.current = tab.tabType !== 'file'
            && !e.metaKey
            && !e.ctrlKey
            && !e.shiftKey;
        }
        onSwitch(e);
      }}
      onDoubleClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        const shouldRename = doubleClickRenameRef.current;
        doubleClickRenameRef.current = false;
        if (shouldRename && !isEditing && !isAnyDragging) onRenameRequest();
      }}
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
          return;
        }
        console.log(
          `[TabDnd:bg] kind=tab phase=mouseenter tab=${shortDndId(tab.id)}` +
          ` action=accept lock=0 anyDragging=0 hoveredBefore=${isHovered ? 1 : 0}`
        );
        setIsHovered(true);
      }}
      onMouseLeave={() => {
        setIsHovered(false);
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
              {/* Shared with the pane header / switcher / Run after picker via
                  TabSignals — one implementation, so the same signal cannot end
                  up with different geometry on different surfaces.
                  `outset` compensates the 2px transparent border this card
                  reserves for dashed drag states, but only on the left: there is
                  no such border on the right, where right:0 already lands on the
                  visible edge. */}
              <TabProcessBar
                hasProcess={verticalHasProcess}
                busy={verticalIsAiBusy}
                inheritedBusy={verticalIsInheritedBusy}
                radius={tabGeo.borderRadius}
                outset={processBarPosition === 'right' ? 0 : 2}
              />
              {/* Codex Fast — жёлтая молния на ВЕРХНЕМ конце полоски процесса.
                  Живёт рядом с полоской и держится за тот же край, потому что
                  описывает свойство этой вкладки, а не добавляет значок в общую
                  строку названия. Наружу выходит лишь частью высоты: серединой
                  на шве было бы не понять, чья она — верхней вкладки или
                  нижней. Рисуется независимо от полоски: Fast может быть
                  доказан и когда процесс уже не идёт. */}
              <TabFastBadge active={codexFastActive} />
              {/* Заполнение контекста — число в правом НИЖНЕМ углу, той же
                  механикой, что молния: абсолютная позиция, часть высоты
                  снаружи, выступ ограничен зазором. Цвет и формат наследуются
                  из общего модуля вместе с панелью управления. Работает и для
                  Claude, и для Codex: значение приходит по трём каналам, хук
                  слушает все. */}
              <TabContextUsageBadge pct={tabContextPct} />
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
              {/* Status marker — shared with the other tab surfaces (TabSignals).
                  Левый отступ 5px: после 3px полоски процесса (z:5) + 2px зазор → 5px.
                  Вертикальный сдвиг компенсирует оптический baseline-шифт строчных
                  букв ('claude-03' без descender'ов выглядит чуть ниже
                  геометрического центра карточки); при видимой полосе задач маркер
                  поднимается, чтобы освободить нижний шов.
                  Если полоска процесса справа — маркер всё равно слева (так лучше
                  читается рядом с текстом названия таба). */}
              <TabStatusMarker
                color={statusMeta?.color}
                title={statusMeta?.label}
                sizePx={showTaskMarkerLane ? TASK_MARKER_PRIMARY_SIZE_PX : undefined}
                topOffsetPx={showTaskMarkerLane ? -1 : 1}
              />
              {showTaskMarkerLane && activeTaskPlanItems.length > 0 && (
                <span
                  data-task-plan-tab-markers
                  style={{
                    position: 'absolute',
                    left: `${taskMarkerLaneLeft}px`,
                    right: `${taskMarkerLaneRight}px`,
                    bottom: `${-Math.max(0, tabGeo.gap - TASK_MARKER_NEXT_TAB_CLEARANCE_PX)}px`,
                    height: `${TASK_MARKER_LANE_HEIGHT_PX}px`,
                    display: 'flex',
                    alignItems: 'flex-end',
                    gap: `${TASK_MARKER_SECONDARY_GAP_PX}px`,
                    overflow: 'hidden',
                    pointerEvents: 'none',
                    zIndex: 7,
                  }}
                >
                  {activeTaskPlanItems.map((task) => {
                    const status = task.statusId ? taskStatusById.get(task.statusId) : undefined;
                    return (
                      <TaskLaneMarker
                        key={task.id}
                        color={status?.color || TASK_MARKER_DEFAULT_COLOR}
                        shape={taskStatusMarkerShape}
                        title={task.title}
                        onClick={(event) => navigateFromTaskMarker(event, 'active', task.id)}
                      />
                    );
                  })}
                </span>
              )}
              {showTaskMarkerLane && archivedTaskPlanItems.length > 0 && (
                <span
                  data-task-plan-tab-archive
                  onMouseEnter={() => setTaskArchivePreviewOpen(true)}
                  onMouseLeave={() => setTaskArchivePreviewOpen(false)}
                  style={{
                    position: 'absolute',
                    right: TASK_ARCHIVE_RIGHT_INSET_PX,
                    bottom: `${-Math.max(0, tabGeo.gap - TASK_MARKER_NEXT_TAB_CLEARANCE_PX)}px`,
                    width: TASK_ARCHIVE_COUNTER_SIZE_PX,
                    height: TASK_ARCHIVE_COUNTER_SIZE_PX,
                    pointerEvents: 'auto',
                    zIndex: 10,
                  }}
                >
                  {taskArchivePreviewOpen && (
                    <span
                      data-task-plan-tab-archive-preview
                      style={{
                        position: 'absolute',
                        right: '100%',
                        bottom: 0,
                        display: 'flex',
                        alignItems: 'center',
                        gap: TASK_MARKER_SECONDARY_GAP_PX,
                        maxWidth: 176,
                        minHeight: TASK_ARCHIVE_COUNTER_SIZE_PX,
                        padding: '1px 4px',
                        overflow: 'hidden',
                        borderRadius: '4px 0 0 4px',
                        background: 'rgba(20,20,23,0.97)',
                        border: '1px solid rgba(255,255,255,0.12)',
                        borderRight: 0,
                        boxShadow: '-6px 4px 14px rgba(0,0,0,0.34)',
                        boxSizing: 'border-box',
                        pointerEvents: 'auto',
                      }}
                    >
                      {archivedTaskPlanItems.map((task) => {
                        const status = task.statusId ? taskStatusById.get(task.statusId) : undefined;
                        return (
                          <TaskLaneMarker
                            key={task.id}
                            color={status?.color || TASK_MARKER_DEFAULT_COLOR}
                            shape={taskStatusMarkerShape}
                            title={task.title}
                            onClick={(event) => navigateFromTaskMarker(event, 'archive', task.id)}
                          />
                        );
                      })}
                    </span>
                  )}
                  <button
                    type="button"
                    data-task-plan-tab-archive-count
                    aria-label={`Архив задач: ${archivedTaskPlanItems.length}`}
                    title={`Архив задач: ${archivedTaskPlanItems.length}`}
                    onPointerDown={(event) => event.stopPropagation()}
                    onDoubleClick={(event) => event.stopPropagation()}
                    onClick={(event) => navigateFromTaskMarker(event, 'archive')}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      width: TASK_ARCHIVE_COUNTER_SIZE_PX,
                      height: TASK_ARCHIVE_COUNTER_SIZE_PX,
                      padding: 0,
                      color: '#d4d4d8',
                      background: '#3f3f46',
                      border: '1px solid rgba(0,0,0,0.5)',
                      borderRadius: 2,
                      boxSizing: 'border-box',
                      cursor: 'pointer',
                      outline: 'none',
                      fontSize: archivedTaskPlanItems.length < 10 ? 7 : archivedTaskPlanItems.length < 100 ? 6 : 5,
                      fontWeight: 700,
                      lineHeight: 1,
                      transform: `scale(${taskArchivePreviewOpen ? TASK_MARKER_HOVER_SCALE : 1})`,
                      transformOrigin: 'center bottom',
                      transition: 'transform 90ms ease, background 90ms ease',
                    }}
                  >
                    {archivedTaskPlanItems.length}
                  </button>
                </span>
              )}
              {/* В вертикальном режиме middle-click по всей вкладке = close tab (стандартное
                  поведение TabItem root). Stop devServer живёт в правой restart-кнопке:
                  Cmd+hover показывает красный square, click отправляет stop без restart. */}
            </>
          )}

          {/* Restart zone - left part of tab (horizontal only; not for SDK) */}
          {!isVerticalMode && tab.tabType !== 'claude-sdk' && (
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
              className="bg-[#333] rounded text-white outline-none"
              style={{
                // Vertical mode (TabSidebar): растягиваем input на остаток ширины, чтобы
                // кнопка заметок справа осталась прижата к правому краю TabItem (а не
                // прилипла к short input'у с пустой зоной за ней).
                // Horizontal mode: legacy fixed 100px — там кнопки заметок нет.
                width: isHorizontal ? 100 : undefined,
                flex: isHorizontal ? 'none' : 1,
                minWidth: 0,
                // ПЕРЕИМЕНОВАНИЕ НЕ МЕНЯЕТ РАЗМЕР КАРТОЧКИ (2026-08-17).
                //
                // Поле ввода занимало БОЛЬШЕ места, чем подпись, которую оно
                // заменяет: свой размер шрифта (13px вместо размера карточки),
                // свои отступы сверху и снизу и рамка в потоке. Высота карточки
                // считается по содержимому, поэтому она подпрыгивала на время
                // переименования, а соседние карточки сдвигались.
                //
                // Теперь поле повторяет коробку подписи: тот же шрифт (`font`
                // наследуется целиком, вместе с межстрочным), нулевые
                // вертикальные отступы, а рамка нарисована тенью — тень не
                // занимает места в раскладке. Осталось только то, что и должно
                // меняться: фон и курсор.
                font: 'inherit',
                padding: '0 4px',
                border: 'none',
                boxShadow: 'inset 0 0 0 1px var(--color-accent)',
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
              className="select-none whitespace-nowrap overflow-hidden text-ellipsis flex items-center gap-1 min-w-0"
              style={{
                flex: isHorizontal ? 'none' : 1,
                minWidth: 0,
                color: tab.aiClosing ? '#8a8a8a' : undefined,
                fontStyle: tab.aiClosing ? 'italic' : undefined,
              }}
            >
              {tab.tabType === 'file' && (
                // Red = the linked file vanished from disk (moved/renamed/
                // deleted). The tab stays; only the icon reports the state.
                <FileText
                  size={12}
                  className={`flex-shrink-0 opacity-90 ${linkedFileMissing ? 'text-[#f87171]' : 'text-[#a78bfa]'}`}
                  {...(linkedFileMissing ? { 'data-linked-file-missing': 'true' } : {})}
                />
              )}
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
              ) : (
                <>
                  <span className="truncate min-w-0">{tab.name}</span>
                  {(outlineFeedback || outlineNavigationPaused) && (
                    <span
                      aria-hidden
                      data-outline-tab-feedback={outlineNavigationPaused ? 'paused' : outlineFeedback?.direction}
                      data-outline-tab-feedback-blocked={outlineFeedback?.blocked ? 'true' : undefined}
                      title={outlineFeedback?.reason || undefined}
                      style={{ position: 'relative', width: 0, height: 18, flexShrink: 0, pointerEvents: 'none' }}
                    >
                      <span
                        style={{
                          position: 'absolute',
                          left: 2,
                          top: '50%',
                          transform: 'translateY(-50%)',
                          width: 18,
                          height: 18,
                          display: 'inline-flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          overflow: 'hidden',
                          borderRadius: 4,
                          border: `1px solid ${outlineFeedback?.blocked ? 'rgba(161,161,170,0.62)' : 'rgba(96,165,250,0.72)'}`,
                          background: outlineFeedback?.blocked ? 'rgba(39,39,42,0.94)' : 'rgba(23,42,67,0.94)',
                          color: outlineFeedback?.blocked ? '#a1a1aa' : '#93c5fd',
                          opacity: outlineNavigationPaused ? 0.82 : Math.max(0.18, Number(outlineFeedback?.progress || 0)),
                          zIndex: 8,
                        }}
                      >
                        {outlineNavigationPaused
                          ? <Pause size={10} fill="currentColor" />
                          : outlineFeedback?.blocked
                            ? <CircleX size={11} />
                            : outlineFeedback?.direction === 'left'
                              ? <ArrowLeft size={11} />
                              : <ArrowRight size={11} />}
                        {outlineFeedback && !outlineFeedback.blocked && (
                          <span
                            style={{
                              position: 'absolute',
                              left: 0,
                              right: `${Math.max(0, 1 - outlineFeedback.progress) * 100}%`,
                              bottom: 0,
                              height: 2,
                              background: '#60a5fa',
                            }}
                          />
                        )}
                      </span>
                    </span>
                  )}
                  {restartAfterCommandDisplayLabel && (
                    <ControlHint label="Открыть историю запусков" shortcut={restartAfterCommandDisplayLabel} side="right">
                    <button
                      className="ml-auto flex-shrink-0 truncate max-w-[132px]"
                      title={restartAfterCommandDisplayLabel}
                      style={{
                        appearance: 'none',
                        background: 'transparent',
                        border: 0,
                        padding: 0,
                        cursor: 'pointer',
                        color: restartAfterPaused ? '#8a8a8a' : '#c4b5fd',
                        fontSize: '0.92em',
                        fontStyle: restartAfterPaused ? 'italic' : undefined,
                      }}
                      onMouseDown={(e) => e.stopPropagation()}
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        onCommandHistoryOpen?.(e, tab.id);
                      }}
                    >
                      {restartAfterCommandDisplayLabel}
                    </button>
                    </ControlHint>
                  )}
                </>
              )}
            </span>
          )}

          {/* Layout map — the ONLY answer to "where is this tab open". Sits
              right of the name and left of the action cluster; the slot keeps
              its width even when the tab is in no pane, so the name never
              shifts as the tab enters or leaves the workspace. */}
          {isVerticalMode && !isCollapsed && <PaneMapCells columns={paneMapColumns} />}

          {hasVerticalRightActionCluster && (
            <div
              className="flex-shrink-0 inline-flex items-center"
              style={{ gap: 1 }}
            >
              {showVerticalLastCommandPlay && (
                <ControlHint label="Запустить последнюю shell-команду в этой папке" side="right">
                <button
                  data-no-tab-drag
                  data-tab-id={tab.id}
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation();
                    onRunLastProjectCommand?.(tab.id);
                  }}
                  onDoubleClick={(e) => e.stopPropagation()}
                  title="Run last command in this directory"
                  className="flex-shrink-0 inline-flex items-center justify-center cursor-pointer transition-colors"
                  style={{
                    position: 'relative',
                    zIndex: 1,
                    width: 20,
                    height: 18,
                    marginLeft: 0,
                    padding: 0,
                    borderRadius: 4,
                    backgroundColor: '#1e1e2e',
                    color: '#86efac',
                    border: '1px solid rgba(34,197,94,0.25)',
                  }}
                  onMouseEnter={(e) => {
                    const lock = isTabbarDragVisualLockActive();
                    if (isAnyDragging || lock) return;
                    const el = e.currentTarget as HTMLButtonElement;
                    el.style.backgroundColor = 'rgba(34,197,94,0.18)';
                    el.style.color = '#bbf7d0';
                  }}
                  onMouseLeave={(e) => {
                    const el = e.currentTarget as HTMLButtonElement;
                    el.style.backgroundColor = '#1e1e2e';
                    el.style.color = '#86efac';
                  }}
                >
                  <Play size={11} strokeWidth={2.2} />
                </button>
                </ControlHint>
              )}

          {restartAfterConfigured && !showVerticalLastCommandPlay && (
            <span
              aria-hidden
              className="flex-shrink-0"
              style={{
                width: 20,
                height: 18,
                visibility: 'hidden',
                pointerEvents: 'none',
              }}
            />
          )}

          {restartAfterConfigured && (
            <ControlHint label={restartAfterPaused ? 'Возобновить Run after' : 'Поставить Run after на паузу'} side="right">
            <button
              type="button"
              data-no-tab-drag
              onClick={(e) => {
                e.stopPropagation();
                useWorkspaceStore.getState().setTabRestartAfterPaused(projectId, tab.id, !restartAfterPaused);
              }}
              onMouseDown={(e) => e.stopPropagation()}
              onDoubleClick={(e) => e.stopPropagation()}
              title={restartAfterPaused ? 'Resume restart after' : 'Pause restart after'}
              aria-label={restartAfterPaused ? 'Resume restart after' : 'Pause restart after'}
              className="flex-shrink-0 inline-flex items-center justify-center transition-colors"
              style={{
                width: 20,
                height: 18,
                marginLeft: 0,
                padding: 0,
                borderRadius: 4,
                backgroundColor: verticalRestartPauseButtonBackground,
                color: verticalRestartPauseButtonColor,
                border: verticalRestartPauseButtonBorder,
                cursor: 'pointer',
                position: 'relative',
              }}
            >
              <Pause size={10} strokeWidth={2.2} aria-hidden />
              {restartAfterPaused && (
                <span
                  aria-hidden
                  style={{
                    position: 'absolute',
                    left: '50%',
                    top: '50%',
                    width: 11,
                    height: 1.5,
                    borderRadius: 999,
                    backgroundColor: 'currentColor',
                    transform: 'translate(-50%, -50%) rotate(-38deg)',
                    opacity: 0.95,
                  }}
                />
              )}
            </button>
            </ControlHint>
          )}

          {/* Restart button — right-anchored in vertical mode. For restart-after tabs
                it stays in the rightmost slot; eligible Play and Pause actions render
                to its left so modifier modes do not shove it sideways. Cmd-hover on
                restart-after shows Clear; Cmd-hover on plain devServer shows Stop. */}
          {canShowVerticalRestartButton && (
            <ControlHint
              label={isStopping
                ? 'Останавливаю процесс…'
                : verticalRestartClearMode
                  ? 'Убрать Run after'
                  : verticalRestartStopMode
                    ? 'Остановить процесс без перезапуска'
                    : restartAfterConfigured
                      ? 'Запустить Run after сейчас'
                      : 'Перезапустить процесс'}
              modifiedAction={!isStopping && !cmdPeekMode
                ? (restartAfterConfigured ? '⌘ клик — убрать Run after' : '⌘ клик — остановить без перезапуска')
                : undefined}
              side="right"
              disabled={isAnyDragging}
            >
            <button
              type="button"
              data-no-tab-drag
              onClick={(e) => {
                e.stopPropagation();
                if (isStopping) return;
                if (restartAfterConfigured && (cmdPeekMode || e.metaKey)) {
                  useWorkspaceStore.getState().setTabRestartAfterTarget(projectId, tab.id, null);
                  return;
                }
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
                : (verticalRestartClearMode
                  ? 'Clear restart after'
                  : verticalRestartStopMode
                    ? 'Stop process (Cmd+click)'
                    : restartAfterConfigured
                      ? (tab.restartAfterCommand
                        ? `Restart-after script: ${formatRestartAfterCommandLabel(tab.restartAfterCommand)}. Cmd+click clears it`
                        : (restartAfterPaused ? 'Restart after paused. Cmd+click clears it' : 'Restart after configured. Cmd+click clears it'))
                      : 'Restart process (kill descendants + ports, then re-run)')}
              aria-label={verticalRestartClearMode ? 'Clear restart after' : (verticalRestartStopMode ? 'Stop running dev process' : (restartAfterConfigured ? 'Restart after configured' : 'Restart process'))}
              className="flex-shrink-0 inline-flex items-center justify-center transition-colors"
              style={{
                width: 20,
                height: 18,
                marginLeft: 0,
                padding: 0,
                borderRadius: 4,
                backgroundColor: verticalRestartButtonBackground,
                color: verticalRestartButtonColor,
                border: verticalRestartButtonBorder,
                cursor: isStopping ? 'default' : 'pointer',
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
              {verticalRestartClearMode ? (
                <X size={12} strokeWidth={2.4} aria-hidden />
              ) : verticalRestartStopMode ? (
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
            </ControlHint>
          )}
            </div>
          )}
        </>
      )}

      {/* Absolute overlay indicator - doesn't affect layout */}
      {!suppressDropIndicator && closestEdge && <DropIndicatorLine edge={closestEdge} />}
      {!suppressDropIndicator && forceRightIndicator && !closestEdge && <DropIndicatorLine edge="right" />}
    </div>
  );
});

const TabGroupHeader = memo(({ group, count, projectId, isEditing, editValue, onEditChange, onEditSubmit, onEditKeyDown, inputRef, onContextMenu, onAuxClick, onToggleCollapsed, onFocusGroup, isFocused, isAnyDragging, dragTargetStatus, dragTargetKind, dragTargetPlacement, dragTargetReason, navigationSpringState, outlineNavigationDwell, disableLegacyDnd, isOutlineSource, outlineNavigationPaused }: {
  group: TabGroup;
  count: number;
  projectId: string;
  isEditing: boolean;
  editValue: string;
  onEditChange: (value: string) => void;
  onEditSubmit: () => void;
  onEditKeyDown: (e: React.KeyboardEvent) => void;
  inputRef: React.RefObject<HTMLInputElement>;
  onContextMenu: (e: React.MouseEvent) => void;
  onAuxClick: (e: React.MouseEvent) => void;
  onToggleCollapsed: () => void;
  onFocusGroup: () => void;
  isFocused: boolean;
  isAnyDragging?: boolean;
  dragTargetStatus?: DragPreviewLayout['status'];
  dragTargetKind?: DragPreviewLayout['targetKind'];
  dragTargetPlacement?: DragPreviewLayout['targetPlacement'];
  dragTargetReason?: string;
  navigationSpringState?: TabDndNavigationSpringState | null;
  outlineNavigationDwell?: { blocked: boolean; pending: boolean; progress: number; cycle: number } | null;
  disableLegacyDnd?: boolean;
  isOutlineSource?: boolean;
  outlineNavigationPaused?: boolean;
}) => {
  const ref = useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [isPressing, setIsPressing] = useState(false);
  const [isHovered, setIsHovered] = useState(false);
  const [isIconHovered, setIsIconHovered] = useState(false);
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
  useEffect(() => {
    const forceRelease = () => {
      setIsDragging(false);
      setIsPressing(false);
      clearBodyGrabbing();
    };
    window.addEventListener(TABBAR_FORCE_RELEASE_EVENT, forceRelease);
    return () => window.removeEventListener(TABBAR_FORCE_RELEASE_EVENT, forceRelease);
  }, [clearBodyGrabbing]);
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
    if (disableLegacyDnd) return;
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
  }, [disableLegacyDnd, group.id, isEditing, projectId]);

  const dragLiftActive = isPressing || isDragging || !!isOutlineSource;
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
  const isAllowedDropTarget = dragTargetStatus === 'allowed';
  const isBlockedDropTarget = dragTargetStatus === 'blocked';
  const targetBackground = isBlockedDropTarget
    ? flattenRgbaOnTabbarPanel('rgba(239, 68, 68, 0.12)')
    : isAllowedDropTarget
      ? flattenRgbaOnTabbarPanel('rgba(59, 130, 246, 0.12)')
      : groupDisplayBackground;
  const targetShadow = (() => {
    if (isBlockedDropTarget) return 'inset 0 0 0 1.5px rgba(248, 113, 113, 0.86)';
    if (!isAllowedDropTarget) return undefined;
    if (dragTargetKind === 'group-inside') return 'inset 0 0 0 1.5px rgba(96, 165, 250, 0.82)';
    if (dragTargetPlacement === 'before') return 'inset 0 2px 0 rgba(96, 165, 250, 0.95)';
    return 'inset 0 -2px 0 rgba(96, 165, 250, 0.95)';
  })();
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
      data-drag-target-status={dragTargetStatus}
      data-drag-target-kind={dragTargetKind}
      data-drag-target-placement={dragTargetPlacement}
      data-drag-target-reason={isBlockedDropTarget ? dragTargetReason : undefined}
      data-dnd-navigation-target={(navigationSpringState || outlineNavigationDwell) ? 'true' : undefined}
      data-dnd-navigation-phase={navigationSpringState?.phase || (outlineNavigationDwell?.pending ? 'loading' : undefined)}
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
        backgroundColor: targetBackground,
        border: `1px solid ${isBlockedDropTarget ? 'rgba(248, 113, 113, 0.86)' : groupBorder}`,
        opacity: outlineNavigationPaused ? 0.62 : 1,
        transform: undefined,
        transformOrigin: 'center',
        outline: dragLiftActive ? '1px solid rgba(139,92,246,0.78)' : undefined,
        outlineOffset: dragLiftActive ? '-1px' : undefined,
        boxShadow: targetShadow || (isCollapsed || isFocused ? 'inset 0 0 0 1px rgba(139,92,246,0.10)' : 'none'),
        transition: isAnyDragging
          ? 'transform 90ms ease, box-shadow 90ms ease, border-color 90ms ease'
          : 'background-color 0.12s, color 0.12s, opacity 0.12s, transform 90ms ease, box-shadow 90ms ease, border-color 90ms ease',
      }}
      onMouseDown={(e) => {
        if (disableLegacyDnd) return;
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
        if (disableLegacyDnd) return;
        if ((e.target as HTMLElement).closest('[data-group-collapse-button]')) return;
        onToggleCollapsed();
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
      title={isEditing ? 'Rename group' : 'Click to collapse or expand. Right-click to rename.'}
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
        {outlineNavigationDwell?.blocked ? (
          <CircleX
            data-outline-dnd-navigation-blocked="true"
            size={14}
            strokeWidth={2.1}
            style={{ color: '#a1a1aa' }}
          />
        ) : (navigationSpringState || outlineNavigationDwell) ? (
          <Loader2
            data-dnd-navigation-loader
            data-dnd-navigation-phase={navigationSpringState?.phase || (outlineNavigationDwell?.pending ? 'loading' : 'waiting')}
            size={14}
            strokeWidth={2.2}
            className="animate-spin"
            style={{ color: '#c4b5fd' }}
          />
        ) : (
          <>
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
          </>
        )}
      </button>
      {isEditing ? (
        <input
          ref={inputRef}
          type="text"
          className="bg-[#333] rounded text-white outline-none"
          // Та же коробка, что у подписи группы: наследованный шрифт, нулевые
          // вертикальные отступы, рамка тенью. Иначе строка группы на время
          // переименования становится выше и толкает весь список вниз — ровно
          // тот же эффект, что был у карточки вкладки.
          style={{
            flex: 1,
            minWidth: 0,
            font: 'inherit',
            padding: '0 4px',
            border: 'none',
            boxShadow: 'inset 0 0 0 1px var(--color-accent)',
          }}
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

// Empty area drop zone for dropping at the end of the main tab list.
const EmptyDropZone = memo(({ onDropMain, onDropGroup, onHoverChange, onDoubleClick, onContextMenu, orientation = 'horizontal' }: {
  onDropMain: (tabId: string) => void;
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
        // The vertical main list has one canonical monitor that resolves preview
        // and commit from the pickup geometry. Calling these legacy callbacks as
        // well would persist the same physical drop twice with different rules.
        if (orientation === 'vertical' && (data.type === 'TAB_GROUP' || data.zone === 'main')) {
          // Commit is owned by the TabBar monitor.
        } else if (data.type === 'TAB_GROUP') {
          onDropGroup?.(data.groupId);
        } else if (data.zone === 'main') {
          onDropMain(data.id);
        }
        setIsOver(false);
        onHoverChange(false);
      },
    });
  }, [onDropMain, onDropGroup, onHoverChange, orientation]);

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

const EmptyMainZone = memo(({ onContextMenu, onDoubleClick }: {
  onContextMenu?: (e: React.MouseEvent) => void;
  onDoubleClick?: () => void;
}) => {
  return (
    <div
      className="flex-1 h-full flex items-center justify-center text-[#666] text-sm"
      onContextMenu={onContextMenu}
      onDoubleClick={onDoubleClick}
    />
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

function buildVerticalDisplayRows(mainTabs: TabData[], tabGroups: TabGroup[]): VerticalDisplayRow[] {
  const groupsById = new Map(tabGroups.map(group => [group.id, group]));
  const tabsById = new Map(mainTabs.map(tab => [tab.id, tab]));
  const membersByGroup = new Map<string, TabData[]>();
  for (const tab of mainTabs) {
    if (!tab.groupId || !groupsById.has(tab.groupId)) continue;
    const members = membersByGroup.get(tab.groupId) || [];
    members.push(tab);
    membersByGroup.set(tab.groupId, members);
  }
  const groupConnectorByTabId = new Map<string, { trunk: 'through' | 'end'; elbow: boolean }>();
  for (const [groupId, members] of membersByGroup) {
    const directRootIndexes = members.flatMap((tab, index) => {
      const parent = tab.visualParentTabId ? tabsById.get(tab.visualParentTabId) : null;
      return !parent || parent.groupId !== groupId ? [index] : [];
    });
    const lastDirectRootIndex = directRootIndexes.at(-1);
    if (lastDirectRootIndex === undefined) continue;
    const directRoots = new Set(directRootIndexes);
    members.forEach((tab, index) => {
      if (index > lastDirectRootIndex) return;
      groupConnectorByTabId.set(tab.id, {
        trunk: index === lastDirectRootIndex ? 'end' : 'through',
        elbow: directRoots.has(index),
      });
    });
  }

  const rows: VerticalDisplayRow[] = [];
  const renderedGroups = new Set<string>();
  const emptyGroupsByAnchor = new Map<string, TabGroup[]>();
  const trailingEmptyGroups: TabGroup[] = [];
  const tabIds = new Set(mainTabs.map(tab => tab.id));
  for (const group of tabGroups) {
    if (membersByGroup.has(group.id)) continue;
    const anchorId = group.anchorTabId && tabIds.has(group.anchorTabId) ? group.anchorTabId : null;
    if (!anchorId) {
      trailingEmptyGroups.push(group);
      continue;
    }
    const anchored = emptyGroupsByAnchor.get(anchorId) || [];
    anchored.push(group);
    emptyGroupsByAnchor.set(anchorId, anchored);
  }
  const pushEmptyGroups = (anchorId: string) => {
    for (const group of emptyGroupsByAnchor.get(anchorId) || []) {
      if (renderedGroups.has(group.id)) continue;
      renderedGroups.add(group.id);
      rows.push({ kind: 'group-header', group, count: 0 });
    }
  };

  for (const tab of mainTabs) {
    pushEmptyGroups(tab.id);
    const group = tab.groupId ? groupsById.get(tab.groupId) : undefined;
    if (group && !renderedGroups.has(group.id)) {
      renderedGroups.add(group.id);
      rows.push({ kind: 'group-header', group, count: membersByGroup.get(group.id)?.length || 0 });
    }
    rows.push({
      kind: 'tab',
      tab,
      group,
      groupIndex: group ? (membersByGroup.get(group.id)?.findIndex(member => member.id === tab.id) ?? undefined) : undefined,
      groupConnector: group ? groupConnectorByTabId.get(tab.id) : undefined,
    });
  }
  for (const group of trailingEmptyGroups) {
    if (!renderedGroups.has(group.id)) rows.push({ kind: 'group-header', group, count: 0 });
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

function TabBar({ projectId, layout = 'horizontal', menuOnlyForProject = false }: TabBarProps) {
  const isVerticalLayout = layout === 'vertical';
  // Use individual selectors to minimize re-renders
  const openProjects = useWorkspaceStore((state) => state.openProjects);
  const activeProjectId = useWorkspaceStore((state) => state.activeProjectId);
  const centerInThisProject = useWorkspaceStore((state) => state.activeProjectId === projectId);
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
  const setTabRestartAfterCommand = useWorkspaceStore((state) => state.setTabRestartAfterCommand);
  const setTabRestartAfterPaused = useWorkspaceStore((state) => state.setTabRestartAfterPaused);
  const reorderInZone = useWorkspaceStore((state) => state.reorderInZone);
  const moveTabsToProject = useWorkspaceStore((state) => state.moveTabsToProject);
  const moveTabGroupToProject = useWorkspaceStore((state) => state.moveTabGroupToProject);
  const createTabGroup = useWorkspaceStore((state) => state.createTabGroup);
  const applyTabLayout = useWorkspaceStore((state) => state.applyTabLayout);
  const toggleTabSelection = useWorkspaceStore((state) => state.toggleTabSelection);
  const selectTabRange = useWorkspaceStore((state) => state.selectTabRange);
  const clearSelection = useWorkspaceStore((state) => state.clearSelection);
  const showWorkspace = useWorkspaceStore((state) => state.showWorkspace);
  // Following a moved tab/group is TAB navigation, not project navigation:
  // the center lands on the moved tab in its new project, the sidebar stays.
  const followMovedTabs = useCallback((targetProjectId: string) => {
    const st = useWorkspaceStore.getState();
    const movedActive = st.openProjects.get(targetProjectId)?.activeTabId;
    if (movedActive) st.activateCenterTab(targetProjectId, movedActive);
  }, []);

  const { projects } = useProjectsStore();
  const projectMoveTargetIds = useMemo(
    () => Array.from(openProjects.keys()).filter(
      (targetProjectId) => targetProjectId !== projectId && !!projects[targetProjectId]
    ),
    [openProjects, projectId, projects]
  );
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
  const [editingTabId, setEditingTabId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const [editOriginalValue, setEditOriginalValue] = useState('');
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; tabId: string } | null>(null);
  // Where the OPEN menu's Rename should put its input. Null = here, in this
  // list. A string names another surface (the pane header), which asked for the
  // menu and can host the input on the tab the user actually right-clicked.
  // A ref, not state: nothing re-renders because of it — it is read once, at
  // the moment Rename is clicked.
  const renameHostRef = useRef<string | null>(null);
  const [editingGroupId, setEditingGroupId] = useState<string | null>(null);
  const [groupEditValue, setGroupEditValue] = useState('');
  const [groupContextMenu, setGroupContextMenu] = useState<{ x: number; y: number; groupId: string } | null>(null);
  const [emptyContextMenu, setEmptyContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [contextScripts, setContextScripts] = useState<string[]>([]);
  const [contextShScripts, setContextShScripts] = useState<string[]>([]);
  const [contextLastCommand, setContextLastCommand] = useState<{ tabId: string; command: string } | null>(null);
  const [commandHistoryByTab, setCommandHistoryByTab] = useState<Map<string, CommandRunHistoryEntry[]>>(new Map());
  const [commandHistoryPopover, setCommandHistoryPopover] = useState<{ tabId: string; x: number; y: number } | null>(null);
  const [restartAfterFallbackCommands, setRestartAfterFallbackCommands] = useState<Map<string, string>>(new Map());
  const [contextFavoriteId, setContextFavoriteId] = useState<number | null>(null);
  const [emptyZoneHovered, setEmptyZoneHovered] = useState(false);
  const [dragPreview, setDragPreview] = useState<DragPreviewLayout | null>(null);
  const [tabHorizontalIntent, setTabHorizontalIntent] = useState<TabHorizontalIntent | null>(null);
  const [tabDndNavigationSpringState, setTabDndNavigationSpringState] = useState<TabDndNavigationSpringState | null>(null);
  const dragPreviewRef = useRef<DragPreviewLayout | null>(null);
  const tabHorizontalParentAssignmentsRef = useRef<Record<string, string | null | undefined>>({});
  const tabHorizontalGroupAssignmentsRef = useRef<Record<string, string | null | undefined>>({});
  const tabHorizontalGroupAnchorAssignmentsRef = useRef<Record<string, string | null | undefined>>({});
  const dragPreviewKeyRef = useRef<string>('');
  const paintedDragPreviewKeyRef = useRef<string>('');
  const lastDragPreviewInputRef = useRef<{ clientX: number; clientY: number; key: string } | null>(null);
  const verticalDragGeometryRef = useRef<VerticalDragGeometry | null>(null);
  const verticalDragAnchorRef = useRef<VerticalDragAnchor | null>(null);
  const verticalResolutionCacheRef = useRef<VerticalResolutionCache<DragPreviewLayout | null> | null>(null);
  const tabHierarchyProjectionRevisionRef = useRef(0);
  const tabHorizontalSuspendYRef = useRef<number | null>(null);
  const tabNativeDropCancelledRef = useRef(false);
  const tabDndNavigationRef = useRef<TabDndNavigationSession | null>(null);
  const tabDndNavigationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tabDndNavigationResumeSeqRef = useRef(0);
  const tabDndMetaKeyPressedRef = useRef(false);
  const tabDndLastPointerRef = useRef<{ clientX: number; clientY: number } | null>(null);
  const tabDndSourceDataRef = useRef<DragData | null>(null);
  const verticalDragGeometrySeqRef = useRef(0);
  const verticalDragResolveTraceRef = useRef<string | null>(null);
  const pendingDragEndCleanupRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const postDropRevealTokenRef = useRef(0);
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
  const restartAfterBusyRef = useRef<Map<string, boolean>>(new Map());
  const restartAfterDeferredNaturalRef = useRef<Set<string>>(new Set());
  const restartAfterScriptRunsRef = useRef<Map<string, RestartAfterScriptRunState>>(new Map());
  const [pasteBusyMap, setPasteBusyMap] = useState<Map<string, boolean>>(new Map());
  // Live background work (in-process subagents / background Bash chips)
  // published by the main-process transcript observers. Display-only.
  const [backgroundWorkMap, setBackgroundWorkMap] = useState<Map<string, boolean>>(new Map());
  const backgroundWorkRevisionRef = useRef<Map<string, number>>(new Map());
  useEffect(() => {
    // One authoritative producer: main tails provider transcripts whether or
    // not History is mounted. A monotonically increasing revision prevents a
    // slower startup snapshot from overwriting a newer live transition.
    const onMainBackgroundWork = (_event: unknown, detail: {
      tabId?: string;
      count?: number;
      revision?: number;
    }) => {
      const accepted = acceptTabBackgroundWorkRecord(
        backgroundWorkRevisionRef.current,
        detail,
      );
      if (!accepted) return;
      const { tabId, active } = accepted;
      setBackgroundWorkMap((prev) => {
        if ((prev.get(tabId) || false) === active) return prev;
        const next = new Map(prev);
        if (active) next.set(tabId, true);
        else next.delete(tabId);
        return next;
      });
    };
    ipcRenderer.on('tab:background-work', onMainBackgroundWork);
    return () => {
      ipcRenderer.removeListener('tab:background-work', onMainBackgroundWork);
    };
  }, []);
  // Awaiting-user-input: Claude called AskUserQuestion and is blocked waiting for
  // the human to answer. Deterministic, bracketed by PreToolUse/PostToolUse hooks
  // (main.js → claude:awaiting-input). Distinct from busy: a question is a special
  // sub-state of busy (awaiting ⊆ busy), rendered as a purple glow instead of the
  // plain "thinking" shimmer. See fact-claude-awaiting-input.md.
  const [awaitingMap, setAwaitingMap] = useState<Map<string, boolean>>(new Map());
  const hasVisibleProcessBar = (tab: TabData): boolean => {
    return processStatus.get(tab.id) || false;
  };
  // A live subagent keeps the tab's ordinary loader on — that is intended, not
  // a bug: work IS attributable to this session, so the tab looks busy exactly
  // like it does during its own turn. (The purple orchestration loader is a
  // different signal and stays separate.) The real defects around this are
  // elsewhere: the count is only computed while History is mounted, and a
  // finished agent keeps counting until the parent notices.
  const isTabTurnBusy = (tab: TabData): boolean => {
    const pasteBusy = pasteBusyMap.get(tab.id) || false;
    const backgroundWork = backgroundWorkMap.get(tab.id) || false;
    // The three maps below hold only what arrived as a TRANSITION since this
    // list mounted. The startup sync re-asks the main process for the process
    // state and for the Codex turn state — but not for Claude or Gemini, so
    // after a reload (or a restart) in the middle of a Claude turn those tabs
    // showed no loader here until the turn ended, minutes later, while every
    // other surface showed one.
    //
    // `tab.aiBusy` is the app-wide per-tab flag maintained for every tab
    // regardless of what is on screen; taking it as the floor closes that gap
    // without touching how the edges behave afterwards.
    const known = tab.aiBusy === true;
    if (tab.commandType === 'gemini') return (geminiBusyMap.get(tab.id) || false) || known || pasteBusy;
    if (tab.commandType === 'codex') return (codexBusyMap.get(tab.id) || false) || known || pasteBusy || backgroundWork;
    return (claudeBusyMap.get(tab.id) || false) || known || pasteBusy || backgroundWork;
  };
  const inputRef = useRef<HTMLInputElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);
  const [contextMenuPos, setContextMenuPos] = useState<{ x: number; y: number }>({ x: 0, y: 0 });

  const isCmdPressed = useCmdKey();
  const [isMouseInTabBar, setIsMouseInTabBar] = useState(false);

  const workspace = openProjects.get(projectId);
  const viewingSubAgentTabId = workspace?.viewingSubAgentTabId ?? null;
  const viewingSubAgentParentId = viewingSubAgentTabId ? workspace?.tabs.get(viewingSubAgentTabId)?.parentTabId ?? null : null;
  const project = projects[projectId] || (workspace ? {
    id: workspace.projectId,
    name: workspace.projectPath?.split('/').filter(Boolean).pop() || 'Project',
    path: workspace.projectPath,
    icon: null,
  } : null);
  const currentView = workspace?.currentView || 'terminal';
  const activeTabId = workspace?.activeTabId || null;
  const activeTabCompletionNotificationFired = !!(
    activeProjectId === projectId &&
    currentView === 'terminal' &&
    activeTabId &&
    workspace?.tabs.get(activeTabId)?.completionNotificationFired
  );
  const resolveTabProjectContext = useCallback((tabId: string): { projectId: string; tab?: TabData } => {
    const state = useWorkspaceStore.getState();
    for (const [candidateProjectId, candidateWorkspace] of state.openProjects) {
      const tab = candidateWorkspace.tabs.get(tabId) as TabData | undefined;
      if (tab) {
        return { projectId: candidateWorkspace.projectId || candidateProjectId, tab };
      }
    }
    return {
      projectId,
      tab: state.openProjects.get(projectId)?.tabs.get(tabId) as TabData | undefined,
    };
  }, [projectId]);

  const loadCommandRunHistory = useCallback(async (tabId: string) => {
    const owner = resolveTabProjectContext(tabId);
    const liveCwd = await ipcRenderer.invoke('terminal:getCwd', tabId).catch(() => null);
    const cwd = liveCwd || owner.tab?.cwd || null;
    const result = await ipcRenderer.invoke('terminal:get-command-run-history', {
      tabId,
      projectId: owner.projectId,
      cwd,
      limit: 20,
    }).catch(() => null);
    const rows = Array.isArray(result?.history) ? result.history : [];
    setCommandHistoryByTab((previous) => {
      const next = new Map(previous);
      next.set(tabId, rows);
      return next;
    });
  }, [resolveTabProjectContext]);

  useEffect(() => {
    if (!workspace) {
      setRestartAfterFallbackCommands((previous) => previous.size > 0 ? new Map() : previous);
      return;
    }

    const candidates = Array.from(workspace.tabs.values()).filter((tab) =>
      tab.tabType !== 'file'
      && getRestartAfterTriggerIds(tab).length > 0
      && !tab.restartAfterCommand
    );
    const candidateIds = new Set(candidates.map((tab) => tab.id));

    if (candidates.length === 0) {
      setRestartAfterFallbackCommands((previous) => {
        if (previous.size === 0) return previous;
        const next = new Map(previous);
        let changed = false;
        for (const key of Array.from(next.keys())) {
          next.delete(key);
          changed = true;
        }
        return changed ? next : previous;
      });
      return;
    }

    let cancelled = false;
    (async () => {
      const loaded: Array<[string, string]> = await Promise.all(candidates.map(async (tab): Promise<[string, string]> => {
        try {
          const liveCwd = await ipcRenderer.invoke('terminal:getCwd', tab.id).catch(() => null);
          const cwd = liveCwd || tab.cwd || null;
          if (!cwd) return [tab.id, ''];
          const owner = resolveTabProjectContext(tab.id);
          const result = await ipcRenderer.invoke('terminal:get-last-project-command', { projectId: owner.projectId, tabId: tab.id, cwd });
          const command = String(result?.command || '').trim();
          return [tab.id, result?.success && command && !isAiLaunchCommand(command) ? command : ''];
        } catch {
          return [tab.id, ''];
        }
      }));
      if (cancelled) return;

      setRestartAfterFallbackCommands((previous) => {
        const next = new Map(previous);
        let changed = false;
        for (const key of Array.from(next.keys())) {
          if (candidateIds.has(key)) continue;
          next.delete(key);
          changed = true;
        }
        for (const [tabId, command] of loaded) {
          if (command) {
            if (next.get(tabId) !== command) {
              next.set(tabId, command);
              changed = true;
            }
          } else if (next.has(tabId)) {
            next.delete(tabId);
            changed = true;
          }
        }
        return changed ? next : previous;
      });
    })();

    return () => {
      cancelled = true;
    };
  }, [projectId, resolveTabProjectContext, workspace?.tabs]);

  useEffect(() => {
    if (!activeTabId || !activeTabCompletionNotificationFired) return;

    const clearActiveTabNotificationOnPointerMove = () => {
      const state = useWorkspaceStore.getState();
      const liveWorkspace = state.openProjects.get(projectId);
      if (
        state.activeProjectId !== projectId ||
        liveWorkspace?.currentView !== 'terminal' ||
        liveWorkspace?.activeTabId !== activeTabId
      ) {
        return;
      }
      const liveTab = liveWorkspace.tabs.get(activeTabId);
      if (!liveTab?.completionNotificationFired) return;
      state.setTabCompletionNotificationArmed(projectId, activeTabId, false);
    };

    window.addEventListener('pointermove', clearActiveTabNotificationOnPointerMove, { capture: true, passive: true });
    return () => {
      window.removeEventListener('pointermove', clearActiveTabNotificationOnPointerMove, { capture: true });
    };
  }, [activeTabCompletionNotificationFired, activeTabId, projectId]);

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
    const result = await ipcRenderer.invoke('ui:confirm-destructive', {
      message: tabIds.length > 1
        ? 'Хотите закрыть ' + tabIds.length + ' вкладк(и)? Активный процесс'
        : 'Хотите закрыть вкладку? Активный процесс',
      detail: parts.join('\n\n'),
      confirmLabel: tabIds.length > 1 ? 'Закрыть вкладки' : 'Закрыть вкладку',
      cancelLabel: 'Отмена',
    }).catch(() => ({ confirmed: false }));
    return result?.confirmed === true;
  };

  const handleTabClick = (e: React.MouseEvent, tabId: string) => {
    if (e.shiftKey) {
      selectTabRange(projectId, tabId);
    } else if (e.metaKey || e.ctrlKey) {
      toggleTabSelection(projectId, tabId, true);
    } else {
      const clickedTab = workspace?.tabs.get(tabId);
      if (clickedTab?.tabType === 'file' && centerInThisProject && tabId === workspace?.activeTabId) {
        const historyTargetId = [...(workspace.tabHistory || [])]
          .reverse()
          .find((id) => id !== tabId && workspace.tabs.get(id)?.tabType !== 'file');
        const fallbackParentId = clickedTab.visualParentTabId && workspace.tabs.has(clickedTab.visualParentTabId)
          ? clickedTab.visualParentTabId
          : null;
        const returnTargetId = historyTargetId || fallbackParentId;
        if (returnTargetId) {
          console.warn('[TabBar:click] file-tab-toggle-back tabId=' + tabId + ' target=' + returnTargetId + ' ts=' + Date.now());
          useWorkspaceStore.getState().activateCenterTab(projectId, returnTargetId);
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
      // Click-cost split (16.08: tab-click handlerMs grew 75→300ms between
      // builds with `during=none-marked` — this names the two halves).
      // syncMs inside switchTab covers the store move; activateMs here covers
      // everything the click does synchronously, so activateMs - syncMs is
      // the cost living OUTSIDE switchTab (view flips, reveal, subscribers).
      const activateStartedAt = performance.now();
      const endClickMark = markRendererActivity('tab-click:' + tabId.slice(-8));
      try {
        useWorkspaceStore.getState().activateCenterTab(projectId, tabId);
      } finally {
        endClickMark();
        const activateMs = performance.now() - activateStartedAt;
        if (activateMs >= 50) {
          console.warn('[Perf:TabClick] tab=' + tabId.slice(-12)
            + ' activateMs=' + activateMs.toFixed(1));
        }
      }
    }
  };
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
      const restartAfterRun = restartAfterScriptRunsRef.current.get(tabId);
      if (restartAfterRun?.running) {
        const pendingCommand = restartAfterRun.pendingCommand;
        restartAfterScriptRunsRef.current.delete(tabId);
        if (pendingCommand) {
          let paused = false;
          for (const ws of useWorkspaceStore.getState().openProjects.values()) {
            const targetTab = ws.tabs.get(tabId);
            if (targetTab) {
              paused = !!targetTab.restartAfterPaused;
              break;
            }
          }
          if (paused) {
            console.warn('[TabBar:RestartAfter] skip-pending-paused target=' + tabId.slice(-8) + ' command=' + JSON.stringify(pendingCommand));
            return;
          }
          console.warn('[TabBar:RestartAfter] draining-pending target=' + tabId.slice(-8) + ' command=' + JSON.stringify(pendingCommand));
          void runRestartAfterAction(tabId, pendingCommand, { coalesceFiniteScript: true });
        } else {
          console.warn('[TabBar:RestartAfter] script-finished target=' + tabId.slice(-8) + ' command=' + JSON.stringify(restartAfterRun.command));
        }
      }
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

    const executeRestartAfterTrigger = (triggerTabId: string, reason?: string) => {
      const restartTargets = useWorkspaceStore.getState().consumeRestartAfterTriggerIdle(triggerTabId, true);
      for (const target of restartTargets) {
        if (target.tabId === triggerTabId) continue;
        console.warn('[TabBar:RestartAfter] trigger=' + triggerTabId.slice(-8) + ' target=' + target.tabId.slice(-8) + ' command=' + JSON.stringify(target.command || '') + ' reason=' + (reason || 'natural'));
        void runRestartAfterAction(target.tabId, target.command, { coalesceFiniteScript: true });
      }
    };

    const applyRestartAfterBusyEdge = (triggerTabId: string, busy: boolean, reason?: string) => {
      // Claude PTY spinner edges are visual heuristics, not authoritative turn boundaries.
      if (reason === 'spinner') return;
      const prevBusy = restartAfterBusyRef.current.get(triggerTabId) || false;
      restartAfterBusyRef.current.set(triggerTabId, busy);
      if (busy) {
        restartAfterDeferredNaturalRef.current.delete(triggerTabId);
        return;
      }
      if (!prevBusy) return;
      const naturalEnd = isNaturalAgentTurnEndReason(reason);
      if (!naturalEnd) return;
      if (isOrchestrationCompletionBlocked(triggerTabId)) {
        restartAfterDeferredNaturalRef.current.add(triggerTabId);
        console.warn('[TabBar:RestartAfter] deferred trigger=' + triggerTabId.slice(-8) + ' while descendants/handoff remain active');
        return;
      }
      executeRestartAfterTrigger(triggerTabId, reason);
    };

    const unsubscribeRestartAfterOrchestration = subscribeOrchestrationRunChanges((change) => {
      if (!change.releaseKind) return;
      const triggerTabId = change.sourceTabId;
      if (change.releaseKind === 'handoff-started') {
        restartAfterDeferredNaturalRef.current.delete(triggerTabId);
        return;
      }
      if (change.releaseKind === 'abnormal') {
        restartAfterDeferredNaturalRef.current.delete(triggerTabId);
        return;
      }
      if (restartAfterBusyRef.current.get(triggerTabId) === true) return;
      restartAfterDeferredNaturalRef.current.delete(triggerTabId);
      executeRestartAfterTrigger(triggerTabId, 'orchestration-complete');
    });

    const handleClaudeBusy = (_: any, { tabId, busy, reason }: { tabId: string; busy: boolean; reason?: string }) => {
      console.warn('[TabBar:BusyState] tabId=' + tabId.slice(-8) + ' busy=' + busy + (reason ? ' reason=' + reason : ''));
      applyRestartAfterBusyEdge(tabId, busy, reason);
      if (reason === 'spinner') return;

      applyClaudeVisualBusy(tabId, busy);
    };

    const handleGeminiBusy = (_: any, { tabId, busy, reason }: { tabId: string; busy: boolean; reason?: string }) => {
      console.warn('[TabBar:GeminiBusyState] tabId=' + tabId.slice(-8) + ' busy=' + busy + (reason ? ' reason=' + reason : ''));
      applyRestartAfterBusyEdge(tabId, busy, reason);
      setGeminiBusyMap(prev => {
        if (prev.get(tabId) === busy) return prev;
        const next = new Map(prev);
        next.set(tabId, busy);
        return next;
      });
    };

    const handleCodexBusy = (_: any, { tabId, busy, reason }: { tabId: string; busy: boolean; reason?: string }) => {
      console.warn('[TabBar:CodexBusyState] tabId=' + tabId.slice(-8) + ' busy=' + busy + (reason ? ' reason=' + reason : ''));
      applyRestartAfterBusyEdge(tabId, busy, reason);
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
      unsubscribeRestartAfterOrchestration();
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
      // ONE request for the whole strip. Asking per tab meant 44 command-state
      // calls + a turn-state call per Codex tab on every project switch — the
      // measured 0.76-1.8s main-loop stall behind the "frozen interface" report.
      // Main resolves each tab through the same code path as the single call,
      // so liveness semantics (including three-state process lookup) are
      // unchanged; only the transport is batched.
      const endSyncMark = markRendererActivity('tab-status-sync:' + tabIds.length);
      let states: Record<string, any> = {};
      try {
        const result = await ipcRenderer.invoke('terminal:getCommandStates', {
          caller: 'TabBar.statusSync',
          tabs: tabIds.map((tabId) => {
            const tab = workspace.tabs.get(tabId);
            return {
              tabId,
              commandType: tab?.commandType || null,
              hasCodexSession: !!tab?.codexSessionId,
            };
          }),
        });
        states = result?.states || {};
      } catch (e) {
        console.warn('[TabBar:StatusSync] batch failed error='
          + String((e as any)?.message || e));
      }

      try {
        const background = await ipcRenderer.invoke('agent:list-background-work', { tabIds });
        if (background?.success === true
          && Array.isArray(background.records)) {
          const activeByTab = new Map<string, boolean>();
          for (const record of background.records as Array<{
            tabId?: string;
            count?: number;
            revision?: number;
          }>) {
            const accepted = acceptTabBackgroundWorkRecord(
              backgroundWorkRevisionRef.current,
              record,
            );
            if (accepted) activeByTab.set(accepted.tabId, accepted.active);
          }
          setBackgroundWorkMap((prev) => {
            const next = new Map(prev);
            let changed = false;
            for (const tabId of tabIds) {
              if (!activeByTab.has(tabId)) continue;
              const active = activeByTab.get(tabId) === true;
              if ((next.get(tabId) || false) === active) continue;
              changed = true;
              if (active) next.set(tabId, true);
              else next.delete(tabId);
            }
            return changed ? next : prev;
          });
        }
      } catch (e) {
        console.warn('[TabBar:BackgroundWorkSync] failed error='
          + String((e as any)?.message || e));
      }

      for (const tabId of tabIds) {
        const tab = workspace.tabs.get(tabId);
        const state = states[tabId];
        if (state) {
          setProcessStatus(prev => {
            if (prev.get(tabId) === state.isRunning) return prev;
            const next = new Map(prev);
            next.set(tabId, state.isRunning);
            return next;
          });
        } else {
          // No answer for this tab (batch failed, or the tab vanished
          // mid-flight). Only seed false when nothing is tracked yet — never
          // clobber a state we already know.
          setProcessStatus(prev => {
            if (prev.has(tabId)) return prev;
            const next = new Map(prev);
            next.set(tabId, false);
            return next;
          });
        }
        const turnState = state?.codexTurn;
        if (turnState?.hasWatcher && !turnState.catchUpPending) {
          const busy = turnState.busy === true;
          setCodexBusyMap(prev => {
            if (prev.get(tabId) === busy) return prev;
            const next = new Map(prev);
            next.set(tabId, busy);
            return next;
          });
        }
        setSessionStatus(prev => {
          const val = !!tab?.claudeSessionId;
          if (prev.get(tabId) === val) return prev;
          const next = new Map(prev);
          next.set(tabId, val);
          return next;
        });
      }
      endSyncMark();
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
        if (tab.parentTabId || !tab.groupId) continue;
        const members = memberIdsByGroup.get(tab.groupId) || [];
        members.push(tab.id);
        memberIdsByGroup.set(tab.groupId, members);
      }
    }

    const rows: VerticalDragGeometry['rows'] = [];
    for (const rowEl of Array.from(list.querySelectorAll<HTMLElement>(':scope > [data-vertical-row]'))) {
      const rowType = rowEl.dataset.rowType;
      if (rowType === 'tab') {
        // Group members are represented by their owning group block below.
        // Keeping the same DOM row here as a second target makes one pointer
        // position alternate between "whole group" and "single child".
        if (rowEl.dataset.groupMemberOf) continue;
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
        const headerRect = snapRect(header);
        const tabRows = isCollapsed
          ? []
          : memberIds.map(tabId => {
              const tabRow = list.querySelector<HTMLElement>(
                `:scope > [data-row-type="tab"][data-tab-id="${CSS.escape(tabId)}"] [data-tab-item]`
              );
              return tabRow ? { tabId, rect: snapRect(tabRow) } : null;
            }).filter((row): row is { tabId: string; rect: RectSnap } => !!row);
        const blockRects = [headerRect, ...tabRows.map(row => row.rect)];
        const blockTop = Math.min(...blockRects.map(rect => rect.top));
        const blockBottom = Math.max(...blockRects.map(rect => rect.bottom));
        const blockLeft = Math.min(...blockRects.map(rect => rect.left));
        const blockRight = Math.max(...blockRects.map(rect => rect.right));
        rows.push({
          type: 'group',
          groupId,
          rect: {
            left: blockLeft,
            right: blockRight,
            top: blockTop,
            bottom: blockBottom,
            height: blockBottom - blockTop,
            midY: (blockTop + blockBottom) / 2,
          },
          header: headerRect,
          collapsed: isCollapsed,
          memberIds,
          tabRows,
        });
      }
    }

    const geometry = {
      id: ++verticalDragGeometrySeqRef.current,
      reason,
      capturedAtMs: performance.now(),
      scrollTop: scroller.scrollTop,
      list: snapRect(scroller),
      rows
    };
    console.log(`[TabDnd:capture] project=${shortDndId(projectId)} ${summarizeVerticalGeometry(geometry)}`);
    return geometry;
  }, [isVerticalLayout, projectId]);

  const setVerticalDragPreview = useCallback((preview: DragPreviewLayout | null) => {
    dragPreviewRef.current = preview;
    setDragPreview(preview);
  }, []);

  useLayoutEffect(() => {
    const renderedKey = dragPreview ? JSON.stringify(dragPreview) : '';
    if (!renderedKey) {
      paintedDragPreviewKeyRef.current = '';
    } else if (renderedKey === dragPreviewKeyRef.current) {
      paintedDragPreviewKeyRef.current = renderedKey;
    }
  }, [dragPreview]);

  const scheduleVerticalPostDropReveal = useCallback((sourceData: DragData) => {
    if (!isVerticalLayout || (sourceData.projectId && sourceData.projectId !== projectId)) return;
    const token = ++postDropRevealTokenRef.current;

    const revealCommittedLayout = (waitFrame = 0) => {
      if (token !== postDropRevealTokenRef.current) return;
      const scroller = scrollContainerRef.current;
      const list = verticalMainListRef.current;
      const currentWorkspace = useWorkspaceStore.getState().openProjects.get(projectId);
      if (!scroller || !list || !currentWorkspace) return;
      const expectedIds = orderTabsWithVisualChildren(
        Array.from(currentWorkspace.tabs.values()).filter(tab => !tab.parentTabId)
      ).map(tab => tab.id);
      const renderedIds = Array.from(list.querySelectorAll<HTMLElement>('[data-tab-item]'))
        .map(element => element.dataset.tabId)
        .filter((id): id is string => !!id);
      const domMatchesCommit = expectedIds.length === renderedIds.length
        && expectedIds.every((id, index) => renderedIds[index] === id);
      const hasActiveFlip = Array.from(verticalRowAnimationsRef.current.values())
        .some(animation => animation.playState === 'running' || animation.playState === 'pending');
      if ((!domMatchesCommit || hasActiveFlip) && waitFrame < TAB_POST_DROP_REVEAL_MAX_WAIT_FRAMES) {
        requestAnimationFrame(() => revealCommittedLayout(waitFrame + 1));
        return;
      }
      if (!domMatchesCommit || hasActiveFlip) {
        console.warn(
          `[TabDnd:post-drop-reveal] project=${shortDndId(projectId)}` +
          ` source=${shortDndId(sourceData.type === 'TAB' ? sourceData.id : sourceData.groupId)}` +
          ` result=layout-timeout frames=${waitFrame}` +
          ` dom=${domMatchesCommit ? 1 : 0} flip=${hasActiveFlip ? 1 : 0}`
        );
      }

        let revealId = sourceData.type === 'TAB' ? sourceData.id : sourceData.groupId;
        let rootElement: HTMLElement | null = null;
        let peekElements: HTMLElement[] = [];

        if (sourceData.type === 'TAB_GROUP') {
          const row = list.querySelector<HTMLElement>(
            `[data-vertical-row][data-row-type="group"][data-group-id="${CSS.escape(sourceData.groupId)}"]`
          );
          rootElement = row?.querySelector<HTMLElement>('[data-tab-group-header]') || null;
          if (row?.dataset.groupCollapsed !== 'true') {
            peekElements = Array.from(
              list.querySelectorAll<HTMLElement>(
                `:scope > [data-group-member-of="${CSS.escape(sourceData.groupId)}"] [data-tab-item]`
              )
            ).slice(0, TAB_POST_DROP_REVEAL_PEEK_ROWS);
          }
        } else {
          const orderedTabs = orderTabsWithVisualChildren(
            Array.from(currentWorkspace.tabs.values()).filter(tab => !tab.parentTabId)
          );
          const hierarchyItems = orderedTabs.map((tab, position) => ({
            id: tab.id,
            parentId: tab.visualParentTabId || null,
            containerId: tab.groupId || null,
            position,
          }));
          const selectedIds = sourceData.selectedTabIds?.includes(sourceData.id)
            ? sourceData.selectedTabIds
            : [sourceData.id];
          const selectedRoots = normalizeSelectedVisualRootIds(
            hierarchyItems,
            selectedIds.filter(id => currentWorkspace.tabs.has(id)),
            { parentKey: 'parentId' }
          );
          const rootId = selectedRoots.find(id =>
            visualHierarchySubtreeItems(hierarchyItems, id, { parentKey: 'parentId' })
              .some(item => item.id === sourceData.id)
          ) || selectedRoots[0] || sourceData.id;
          revealId = rootId;
          const rootTab = currentWorkspace.tabs.get(rootId);
          const rootGroup = rootTab?.groupId
            ? currentWorkspace.tabGroups.find(group => group.id === rootTab.groupId)
            : null;

          if (rootGroup?.collapsed) {
            const groupRow = list.querySelector<HTMLElement>(
              `[data-vertical-row][data-row-type="group"][data-group-id="${CSS.escape(rootGroup.id)}"]`
            );
            rootElement = groupRow?.querySelector<HTMLElement>('[data-tab-group-header]') || null;
            revealId = rootGroup.id;
          } else {
            rootElement = list.querySelector<HTMLElement>(
              `[data-tab-item][data-tab-id="${CSS.escape(rootId)}"]`
            );
            const subtree = visualHierarchySubtreeItems(hierarchyItems, rootId, { parentKey: 'parentId' });
            peekElements = subtree.slice(1)
              .map(item => list.querySelector<HTMLElement>(
                `[data-tab-item][data-tab-id="${CSS.escape(item.id)}"]`
              ))
              .filter((element): element is HTMLElement => !!element)
              .slice(0, TAB_POST_DROP_REVEAL_PEEK_ROWS);
          }
        }

        if (!rootElement?.isConnected) {
          console.log(
            `[TabDnd:post-drop-reveal] project=${shortDndId(projectId)}` +
            ` source=${shortDndId(revealId)} result=miss`
          );
          return;
        }

        const scrollerRect = scroller.getBoundingClientRect();
        const rootRect = rootElement.getBoundingClientRect();
        const availableHeight = Math.max(0, scrollerRect.height - (TAB_POST_DROP_REVEAL_MARGIN_PX * 2));
        const fittingPeekElements: HTMLElement[] = [];
        for (const element of peekElements) {
          const candidateRect = element.getBoundingClientRect();
          if (candidateRect.bottom - rootRect.top > availableHeight) break;
          fittingPeekElements.push(element);
        }
        const lastPeekElement = fittingPeekElements[fittingPeekElements.length - 1];
        const revealBottom = lastPeekElement?.getBoundingClientRect().bottom ?? rootRect.bottom;
        const margin = TAB_POST_DROP_REVEAL_MARGIN_PX;
        const maxScrollTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
        let targetTop = scroller.scrollTop;
        let edge = 'inside';

        if (rootRect.top < scrollerRect.top + margin) {
          targetTop -= (scrollerRect.top + margin) - rootRect.top;
          edge = 'above';
        } else if (revealBottom > scrollerRect.bottom - margin) {
          targetTop += revealBottom - (scrollerRect.bottom - margin);
          edge = 'below';
        }
        targetTop = Math.max(0, Math.min(maxScrollTop, targetTop));

        const before = scroller.scrollTop;
        if (Math.abs(targetTop - before) < 1) {
          console.log(
            `[TabDnd:post-drop-reveal] project=${shortDndId(projectId)}` +
            ` source=${shortDndId(revealId)} result=skip edge=${edge}` +
            ` peek=${fittingPeekElements.length} top=${Math.round(before)}`
          );
          return;
        }

        const startedAt = performance.now();
        console.log(
          `[TabDnd:post-drop-reveal] project=${shortDndId(projectId)}` +
          ` source=${shortDndId(revealId)} result=start edge=${edge}` +
          ` peek=${fittingPeekElements.length} before=${Math.round(before)} target=${Math.round(targetTop)}`
        );
        const step = (now: number) => {
          if (token !== postDropRevealTokenRef.current || !rootElement?.isConnected) return;
          const progress = Math.min(1, (now - startedAt) / TAB_POST_DROP_REVEAL_DURATION_MS);
          const eased = 1 - Math.pow(1 - progress, 3);
          scroller.scrollTop = before + ((targetTop - before) * eased);
          if (progress < 1) {
            requestAnimationFrame(step);
            return;
          }
          scroller.scrollTop = targetTop;
          console.log(
            `[TabDnd:post-drop-reveal] project=${shortDndId(projectId)}` +
            ` source=${shortDndId(revealId)} result=done edge=${edge}` +
            ` peek=${fittingPeekElements.length} after=${Math.round(scroller.scrollTop)}`
          );
        };
        requestAnimationFrame(step);
    };
    requestAnimationFrame(() => revealCommittedLayout());
  }, [isVerticalLayout, projectId]);

  // Tab adoption (Gemini → Claude sub-agent) was removed; no drop is an adopt target.
  const isAdoptDropTarget = useCallback((_sourceData: DragData, _targetData: any): boolean => false, []);

  const resolveStaticVerticalPreview = useCallback((sourceData: DragData, clientX: number, clientY: number): DragPreviewLayout | null => {
    const resolveStartedAt = performance.now();
    const rejectResolve = (reason: string) => {
      verticalDragResolveTraceRef.current =
        `resolve reject=${reason} durMs=${(performance.now() - resolveStartedAt).toFixed(1)}`;
      return null;
    };

    if (!isVerticalLayout) return rejectResolve('not-vertical');
    if (sourceData.projectId && sourceData.projectId !== projectId) return rejectResolve('foreign-project');
    if (sourceData.zone !== 'main') return rejectResolve('non-main-zone');
    const geometry = verticalDragGeometryRef.current;
    if (!geometry) return rejectResolve('no-geometry');

    const list = geometry.list;
    if (clientX < list.left || clientX > list.right || clientY < list.top || clientY > list.bottom) {
      return rejectResolve('outside-list-bounds');
    }
    // Preview rows move in the DOM. Resolving against their new rects feeds the
    // preview back into hit-testing and makes one stationary pointer alternate
    // between two layouts. Keep pickup geometry canonical; only compensate for
    // real scrolling, which moves every content-space slot by the same amount.
    const currentScrollTop = scrollContainerRef.current?.scrollTop ?? geometry.scrollTop;
    const geometryY = clientY + (currentScrollTop - geometry.scrollTop);
    const sourceKey = sourceData.type === 'TAB'
      ? `tab:${sourceData.id}`
      : `group:${sourceData.groupId}`;
    const cachedResolution = verticalResolutionCacheRef.current;
    const projectionRevision = tabHierarchyProjectionRevisionRef.current;
    if (canReuseVerticalResolution(cachedResolution, geometry.id, sourceKey, projectionRevision, geometryY)) {
      verticalDragResolveTraceRef.current =
        `resolve gid=${geometry.id} cache=scroll-y source=${shortDndId(sourceKey)} geometryY=${geometryY.toFixed(2)}`;
      return cachedResolution.value;
    }
    const lastGeometryRow = geometry.rows[geometry.rows.length - 1];
    const isEffectiveEmptyZone = !lastGeometryRow || geometryY >= lastGeometryRow.rect.bottom;

    const currentWorkspace = useWorkspaceStore.getState().openProjects.get(projectId);
    if (!currentWorkspace) return rejectResolve('no-workspace');
    const rawBaseTabs = orderTabsWithVisualChildren(
      Array.from(currentWorkspace.tabs.values()).filter(tab => !tab.parentTabId)
    );
    const currentGroups = currentWorkspace.tabGroups || [];
    const validGroupIds = new Set(currentGroups.map(group => group.id));
    const projectedParentAssignments = tabHorizontalParentAssignmentsRef.current;
    const projectedGroupAssignments = tabHorizontalGroupAssignmentsRef.current;
    const tabById = new Map(rawBaseTabs.map(tab => {
      const projectedGroupId = Object.prototype.hasOwnProperty.call(projectedGroupAssignments, tab.id)
        ? projectedGroupAssignments[tab.id] || undefined
        : tab.groupId;
      return [tab.id, {
        ...tab,
        visualParentTabId: Object.prototype.hasOwnProperty.call(projectedParentAssignments, tab.id)
          ? projectedParentAssignments[tab.id] || undefined
          : tab.visualParentTabId,
        groupId: projectedGroupId && validGroupIds.has(projectedGroupId) ? projectedGroupId : undefined,
      }];
    }));
    const hierarchyItems = rawBaseTabs.map((tab, position) => {
      const projected = tabById.get(tab.id)!;
      return {
        id: tab.id,
        parentId: projected.visualParentTabId || null,
        containerId: projected.groupId || null,
        position,
      };
    });
    const baseOrder = orderVisualHierarchyItems(hierarchyItems, { parentKey: 'parentId' }).map(item => item.id);
    const selectedTabIds = sourceData.type === 'TAB'
      ? (sourceData.selectedTabIds && sourceData.selectedTabIds.includes(sourceData.id)
        ? sourceData.selectedTabIds
        : [sourceData.id]).filter(id => tabById.has(id))
      : [];
    const selectedRootIds = (() => {
      if (sourceData.type !== 'TAB') return [];
      // A selected child owns only its own subtree. Promoting it to the
      // top-most ancestor makes dragging one child move the whole foreign root.
      return normalizeSelectedVisualRootIds(hierarchyItems, selectedTabIds, { parentKey: 'parentId' });
    })();
    const sourceIds = (() => {
      if (sourceData.type === 'TAB_GROUP') {
        return baseOrder.filter(id => tabById.get(id)?.groupId === sourceData.groupId);
      }
      const result: string[] = [];
      const seen = new Set<string>();
      for (const rootId of selectedRootIds) {
        for (const item of visualHierarchySubtreeItems(hierarchyItems, rootId, { parentKey: 'parentId' })) {
          if (seen.has(item.id)) continue;
          seen.add(item.id);
          result.push(item.id);
        }
      }
      return result;
    })();
    const isEmptyGroupDrag = sourceData.type === 'TAB_GROUP' && sourceIds.length === 0
      && currentGroups.some(group => group.id === sourceData.groupId);
    if (sourceIds.length === 0 && !isEmptyGroupDrag) return rejectResolve('no-source-ids');

    const sourceSet = new Set(sourceIds);
    const withoutSource = baseOrder.filter(id => !sourceSet.has(id));
    const groupAssignments: Record<string, string | null | undefined> = {};
    for (const tab of rawBaseTabs) {
      if (tab.groupId && !validGroupIds.has(tab.groupId)) groupAssignments[tab.id] = null;
    }
    const visualParentAssignments: Record<string, string | null | undefined> = {};
    const groupAnchorAssignments: Record<string, string | null | undefined> = {};
    const canonicalizeOrder = (candidateOrder: string[]) => {
      const positionById = new Map(candidateOrder.map((id, index) => [id, index]));
      const projectedItems = hierarchyItems.map(item => ({
        ...item,
        parentId: Object.prototype.hasOwnProperty.call(visualParentAssignments, item.id)
          ? visualParentAssignments[item.id] || null
          : item.parentId,
        containerId: Object.prototype.hasOwnProperty.call(groupAssignments, item.id)
          ? groupAssignments[item.id] || null
          : item.containerId,
        position: positionById.get(item.id) ?? candidateOrder.length,
      }));
      return orderVisualHierarchyItems(projectedItems, { parentKey: 'parentId' }).map(item => item.id);
    };
    const makePreview = (
      orderedIds: string[],
      target: Pick<DragPreviewLayout, 'targetTabIds' | 'targetGroupId' | 'targetPlacement' | 'targetKind'> = {},
      status: DragPreviewLayout['status'] = 'allowed',
      reason?: string,
    ) => ({
      status,
      reason,
      interactionAxis: 'vertical' as const,
      projectionRevision,
      sourceIds,
      orderedIds: canonicalizeOrder(orderedIds),
      groupAssignments,
      visualParentAssignments,
      groupAnchorAssignments,
      ...target,
    });
    const makeBlockedPreview = (
      reason: string,
      target: Pick<DragPreviewLayout, 'targetTabIds' | 'targetGroupId' | 'targetPlacement' | 'targetKind'> = {},
    ) => makePreview(baseOrder, target, 'blocked', reason);
    const makeNoopPreview = (reason: string) => makePreview(baseOrder, {}, 'noop', reason);
    const finish = (
      preview: DragPreviewLayout | null,
      branch: string,
      detail = '',
      boundary?: VerticalSemanticBoundary | null,
    ) => {
      const resolvedPreview = preview && boundary
        ? { ...preview, verticalBoundary: boundary }
        : preview;
      verticalResolutionCacheRef.current = {
        geometryId: geometry!.id,
        sourceKey,
        projectionRevision,
        scrollAdjustedY: geometryY,
        value: resolvedPreview,
      };
      verticalDragResolveTraceRef.current = [
        `resolve gid=${geometry!.id}`,
        'recaptured=0',
        `branch=${branch}`,
        detail,
        `source=${sourceIds.map(shortDndId).join('.') || '-'}`,
        `without=${withoutSource.map(shortDndId).join('.') || '-'}`,
        `durMs=${(performance.now() - resolveStartedAt).toFixed(1)}`
      ].filter(Boolean).join(' ');
      return resolvedPreview;
    };
    const insertAt = (order: string[], ids: string[], index: number) => {
      const next = [...order];
      next.splice(Math.max(0, Math.min(index, next.length)), 0, ...ids);
      return next;
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
    const rectByTabId = new Map<string, RectSnap>();
    for (const row of geometry.rows) {
      if (row.type === 'tab') rectByTabId.set(row.tabId, row.rect);
      else for (const tabRow of row.tabRows) rectByTabId.set(tabRow.tabId, tabRow.rect);
    }
    const rootIdForTab = (tabId: string) => {
      let rootId = tabId;
      const visited = new Set<string>();
      while (!visited.has(rootId)) {
        visited.add(rootId);
        const parentId = tabById.get(rootId)?.visualParentTabId;
        if (!parentId || !tabById.has(parentId)) break;
        rootId = parentId;
      }
      return rootId;
    };
    type TopLevelAtomicTarget = {
      row: VerticalDragGeometry['rows'][number];
      firstRowIndex: number;
      lastRowIndex: number;
    };
    const topLevelAtomicTargets: AtomicVerticalTarget<TopLevelAtomicTarget>[] = [];
    const seenTopLevelBlocks = new Set<string>();
    for (let rowIndex = 0; rowIndex < geometry.rows.length; rowIndex += 1) {
      const row = geometry.rows[rowIndex];
      if (row.type === 'group') {
        const key = `group:${row.groupId}`;
        if (seenTopLevelBlocks.has(key)) continue;
        seenTopLevelBlocks.add(key);
        topLevelAtomicTargets.push({
          key,
          rect: row.rect,
          value: { row, firstRowIndex: rowIndex, lastRowIndex: rowIndex },
        });
        continue;
      }

      const rootId = rootIdForTab(row.tabId);
      const key = `tab-block:${rootId}`;
      if (seenTopLevelBlocks.has(key)) continue;
      const targetIds = visualHierarchySubtreeItems(hierarchyItems, rootId, { parentKey: 'parentId' })
        .map(item => item.id);
      const targetRects = targetIds
        .map(id => rectByTabId.get(id))
        .filter((rect): rect is RectSnap => !!rect);
      const rect = unionVerticalRects(targetRects);
      if (!rect) continue;
      const rowIndices = geometry.rows
        .map((candidate, index) => candidate.type === 'tab' && targetIds.includes(candidate.tabId) ? index : -1)
        .filter(index => index >= 0);
      seenTopLevelBlocks.add(key);
      topLevelAtomicTargets.push({
        key,
        rect,
        value: {
          row,
          firstRowIndex: rowIndices.length ? Math.min(...rowIndices) : rowIndex,
          lastRowIndex: rowIndices.length ? Math.max(...rowIndices) : rowIndex,
        },
      });
    }
    const previousBoundary = cachedResolution?.geometryId === geometry.id
      && cachedResolution.sourceKey === sourceKey
      && cachedResolution.projectionRevision === projectionRevision
      ? cachedResolution.value?.verticalBoundary
      : null;
    const resolveTopLevelAtomicTarget = () =>
      resolveAtomicVerticalTarget(topLevelAtomicTargets, geometryY, previousBoundary);
    const assignEmptyGroupAnchor = (
      anchorTabId: string | null,
      branch = 'empty-group-anchor',
      detail = '',
      boundary?: VerticalSemanticBoundary | null,
    ) => {
      if (sourceData.type !== 'TAB_GROUP') return null;
      groupAnchorAssignments[sourceData.groupId] = anchorTabId;
      return finish(
        makePreview(baseOrder),
        branch,
        `anchor=${shortDndId(anchorTabId)} ${detail}`.trim(),
        boundary,
      );
    };

    if (isEmptyGroupDrag) {
      if (isEffectiveEmptyZone) {
        return assignEmptyGroupAnchor(
          null,
          'empty-group:empty-zone',
          '',
          { blockKey: 'list:end', side: 'after' },
        );
      }
      const resolvedTarget = resolveTopLevelAtomicTarget();
      if (!resolvedTarget) return finish(null, 'empty-group:no-target');
      const { firstRowIndex, lastRowIndex, row } = resolvedTarget.target.value;
      const boundary = resolvedTarget.boundary;
      const anchorRowIndex = boundary.side === 'before' ? firstRowIndex : lastRowIndex + 1;
      return assignEmptyGroupAnchor(
        anchorBeforeRow(anchorRowIndex),
        'empty-group:atomic-block',
        `rows=${firstRowIndex}..${lastRowIndex}:${verticalRowDebugKey(row)}`,
        boundary,
      );
    }

    if (sourceData.type === 'TAB_GROUP') {
      if (isEffectiveEmptyZone) {
        return finish(
          makePreview(insertAt(withoutSource, sourceIds, withoutSource.length)),
          'group:empty-zone',
          `insert=${withoutSource.length}`,
          { blockKey: 'list:end', side: 'after' },
        );
      }
      const targetIdsForRow = (row: VerticalDragGeometry['rows'][number]) => {
        if (row.type === 'group') {
          return row.memberIds.filter(id => !sourceSet.has(id));
        }
        const rootId = rootIdForTab(row.tabId);
        return visualHierarchySubtreeItems(hierarchyItems, rootId, { parentKey: 'parentId' })
          .map(item => item.id)
          .filter(id => !sourceSet.has(id));
      };
      const moveAroundRow = (
        row: VerticalDragGeometry['rows'][number],
        placement: 'before' | 'after',
        branch: string,
        boundary: VerticalSemanticBoundary,
      ) => {
        if (row.type === 'group' && row.groupId === sourceData.groupId) {
          return finish(
            makeNoopPreview('target-inside-source'),
            `${branch}:noop`,
            `target=${shortDndId(row.groupId)} placement=${placement}`,
            boundary,
          );
        }

        const targetIds = targetIdsForRow(row);
        const targetGroupId = row.type === 'group' ? row.groupId : null;
        const target = {
          targetTabIds: targetIds,
          targetGroupId,
          targetPlacement: placement,
          targetKind: (row.type === 'group' ? 'group-block' : 'tab-block') as 'group-block' | 'tab-block',
        };
        const targetIndices = targetIds
          .map(id => withoutSource.indexOf(id))
          .filter(index => index >= 0);

        if (targetIndices.length > 0) {
          const insertIndex = placement === 'before'
            ? Math.min(...targetIndices)
            : Math.max(...targetIndices) + 1;
          return finish(
            makePreview(insertAt(withoutSource, sourceIds, insertIndex), target),
            branch,
            `target=${targetIds.map(shortDndId).join('.')} placement=${placement} insert=${insertIndex}`,
            boundary,
          );
        }

        // Empty groups have no tab in the flat order. Their anchor controls
        // whether they render before the source group at the same slot.
        if (row.type === 'group') {
          const targetGroup = currentGroups.find(group => group.id === row.groupId);
          const anchorIndex = targetGroup?.anchorTabId
            ? withoutSource.indexOf(targetGroup.anchorTabId)
            : -1;
          const insertIndex = anchorIndex >= 0 ? anchorIndex : withoutSource.length;
          if (placement === 'after' && sourceIds[0]) {
            groupAnchorAssignments[row.groupId] = sourceIds[0];
          }
          return finish(
            makePreview(insertAt(withoutSource, sourceIds, insertIndex), target),
            `${branch}:empty-target`,
            `target=${shortDndId(row.groupId)} placement=${placement} insert=${insertIndex}`,
            boundary,
          );
        }

        return finish(makeNoopPreview('target-inside-source'), `${branch}:no-target`, '', boundary);
      };
      const resolvedTarget = resolveTopLevelAtomicTarget();
      if (!resolvedTarget) return finish(makeNoopPreview('empty-list'), 'group:empty-list');
      const { row, firstRowIndex, lastRowIndex } = resolvedTarget.target.value;
      return moveAroundRow(
        row,
        resolvedTarget.boundary.side,
        `group:atomic-block rows=${firstRowIndex}..${lastRowIndex}:${verticalRowDebugKey(row)}`,
        resolvedTarget.boundary,
      );
    }

    const assignFlatEnd = (
      branch = 'flat-end',
      detail = '',
      boundary: VerticalSemanticBoundary = { blockKey: 'list:end', side: 'after' },
    ) => {
      return finish(
        makePreview(insertAt(withoutSource, sourceIds, withoutSource.length)),
        branch,
        `insert=${withoutSource.length} ${detail}`.trim(),
        boundary,
      );
    };
    const sourceIsTopLevel = sourceData.type === 'TAB'
      && selectedRootIds.length > 0
      && selectedRootIds.every(rootId => {
        const item = hierarchyItems.find(candidate => candidate.id === rootId);
        return !!item && !item.parentId && !item.containerId;
      });
    const moveTopLevelSourceAroundGroup = (
      row: VerticalDragGroupRow,
      placement: 'before' | 'after',
      branch: string,
      detail = '',
      boundary: VerticalSemanticBoundary = { blockKey: `group:${row.groupId}`, side: placement },
    ) => {
      const targetTabIds = baseOrder.filter(id => !sourceSet.has(id) && tabById.get(id)?.groupId === row.groupId);
      const target = {
        targetTabIds,
        targetGroupId: row.groupId,
        targetPlacement: placement,
        targetKind: 'group-block' as const,
      };
      if (!sourceIsTopLevel) {
        return finish(
          makeBlockedPreview('vertical-hierarchy-boundary', target),
          `${branch}:blocked`,
          `group=${shortDndId(row.groupId)} placement=${placement} ${detail}`.trim(),
          boundary,
        );
      }

      type TopLevelEntity = { type: 'item'; id: string } | { type: 'group'; id: string };
      const entities: TopLevelEntity[] = [];
      const seenGroups = new Set<string>();
      for (const displayRow of buildVerticalDisplayRows(rawBaseTabs, currentGroups)) {
        if (displayRow.kind === 'group-header') {
          if (!seenGroups.has(displayRow.group.id)) {
            seenGroups.add(displayRow.group.id);
            entities.push({ type: 'group', id: displayRow.group.id });
          }
          continue;
        }
        const item = hierarchyItems.find(candidate => candidate.id === displayRow.tab.id);
        if (!item || item.parentId || item.containerId) continue;
        entities.push({ type: 'item', id: item.id });
      }

      const selectedEntityIds = new Set(selectedRootIds);
      const sourceEntities = entities.filter(entity => entity.type === 'item' && selectedEntityIds.has(entity.id));
      const withoutSourceEntities = entities.filter(entity => !(entity.type === 'item' && selectedEntityIds.has(entity.id)));
      const targetIndex = withoutSourceEntities.findIndex(entity => entity.type === 'group' && entity.id === row.groupId);
      if (sourceEntities.length === 0 || targetIndex < 0) {
        return finish(makeNoopPreview('invalid-top-level-target'), `${branch}:no-target`, detail, boundary);
      }
      withoutSourceEntities.splice(targetIndex + (placement === 'after' ? 1 : 0), 0, ...sourceEntities);

      const orderedIds: string[] = [];
      const entityIds = (entity: TopLevelEntity) => entity.type === 'group'
        ? baseOrder.filter(id => tabById.get(id)?.groupId === entity.id)
        : visualHierarchySubtreeItems(hierarchyItems, entity.id, { parentKey: 'parentId' }).map(item => item.id);
      for (const entity of withoutSourceEntities) orderedIds.push(...entityIds(entity));

      for (let index = 0; index < withoutSourceEntities.length; index += 1) {
        const entity = withoutSourceEntities[index];
        if (entity.type !== 'group' || baseOrder.some(id => tabById.get(id)?.groupId === entity.id)) continue;
        let anchorId: string | null = null;
        for (let nextIndex = index + 1; nextIndex < withoutSourceEntities.length; nextIndex += 1) {
          const ids = entityIds(withoutSourceEntities[nextIndex]);
          if (ids.length > 0) {
            anchorId = ids[0];
            break;
          }
        }
        groupAnchorAssignments[entity.id] = anchorId;
      }

      return finish(
        makePreview(orderedIds, target),
        branch,
        `group=${shortDndId(row.groupId)} placement=${placement} targetBlock=${targetTabIds.map(shortDndId).join('.')} ${detail}`.trim(),
        boundary,
      );
    };
    const assignSiblingBlock = (
      targetId: string,
      branch: string,
      detail = '',
      providedBoundary?: VerticalSemanticBoundary | null,
    ) => {
      if (sourceData.type !== 'TAB') return null;
      const resolve = (placement: 'before' | 'after') => resolveVisualBlockMove({
        items: hierarchyItems,
        sourceId: selectedRootIds[0] || sourceData.id,
        selectedIds: selectedRootIds,
        targetId,
        placement,
        parentKey: 'parentId',
        containerKey: 'containerId',
      });
      let result = resolve('before');
      const boundaryForResult = () => {
        if (providedBoundary) return providedBoundary;
        const targetRootId = result.targetRootId || rootIdForTab(targetId);
        const targetIds: string[] = result.targetIds?.length
          ? result.targetIds
          : visualHierarchySubtreeItems(hierarchyItems, targetRootId, { parentKey: 'parentId' }).map(item => item.id);
        const rect = unionVerticalRects(
          targetIds
            .map(id => rectByTabId.get(id))
            .filter((candidate): candidate is RectSnap => !!candidate)
        ) || rectByTabId.get(targetId);
        if (!rect) return null;
        return resolveAtomicVerticalTarget(
          [{ key: `tab-block:${targetRootId}`, rect, value: targetRootId }],
          geometryY,
          previousBoundary,
        )?.boundary || null;
      };
      let boundary = boundaryForResult();
      if (!result.ok) {
        if (result.reason === 'target-inside-source') {
          return finish(
            makeNoopPreview(result.reason),
            `${branch}:noop`,
            `target=${shortDndId(targetId)} reason=${result.reason} ${detail}`.trim(),
            boundary,
          );
        }
        return finish(
          makeBlockedPreview(result.reason || 'blocked', {
            targetTabIds: [targetId],
            targetGroupId: tabById.get(targetId)?.groupId || null,
            targetKind: 'tab-block',
          }),
          `${branch}:blocked`,
          `target=${shortDndId(targetId)} reason=${result.reason} ${detail}`.trim(),
          boundary,
        );
      }
      const placement = boundary?.side || 'after';
      if (placement === 'after') result = resolve('after');
      boundary = boundary || boundaryForResult();
      if (!result.ok) {
        if (result.reason === 'target-inside-source') {
          return finish(
            makeNoopPreview(result.reason),
            `${branch}:noop`,
            `target=${shortDndId(targetId)} reason=${result.reason} ${detail}`.trim(),
            boundary,
          );
        }
        return finish(
          makeBlockedPreview(result.reason || 'blocked', {
            targetTabIds: [targetId],
            targetGroupId: tabById.get(targetId)?.groupId || null,
            targetPlacement: placement,
            targetKind: 'tab-block',
          }),
          `${branch}:blocked`,
          `target=${shortDndId(targetId)} reason=${result.reason} ${detail}`.trim(),
          boundary,
        );
      }
      return finish(
        makePreview(result.orderedIds, {
          targetTabIds: result.targetIds,
          targetGroupId: result.containerId || null,
          targetPlacement: placement,
          targetKind: 'tab-block',
        }),
        branch,
        `target=${shortDndId(result.targetRootId)} placement=${placement} targetBlock=${(result.targetIds || []).map(shortDndId).join('.')} ${detail}`.trim(),
        boundary,
      );
    };

    if (isEffectiveEmptyZone) {
      const lastRow = geometry.rows[geometry.rows.length - 1];
      if (lastRow?.type === 'group' && lastRow.tabRows.length > 0 && lastRow.tabRows.every(tabRow => sourceSet.has(tabRow.tabId))) {
        return finish(
          makeNoopPreview('source-already-last'),
          'empty-zone:last-source-group',
          '',
          { blockKey: 'list:end', side: 'after' },
        );
      }
      return assignFlatEnd('empty-zone:flat-end');
    }

    if (sourceIsTopLevel) {
      const resolvedTarget = resolveTopLevelAtomicTarget();
      if (!resolvedTarget) return finish(null, 'top-level:no-target');
      const { row, firstRowIndex, lastRowIndex } = resolvedTarget.target.value;
      if (row.type === 'group') {
        return moveTopLevelSourceAroundGroup(
          row,
          resolvedTarget.boundary.side,
          'top-level:group-block',
          `rows=${firstRowIndex}..${lastRowIndex}:${verticalRowDebugKey(row)}`,
          resolvedTarget.boundary,
        );
      }
      return assignSiblingBlock(
        row.tabId,
        'top-level:tab-block',
        `rows=${firstRowIndex}..${lastRowIndex}:${verticalRowDebugKey(row)}`,
        resolvedTarget.boundary,
      );
    }

    for (let rowIndex = 0; rowIndex < geometry.rows.length; rowIndex += 1) {
      const row = geometry.rows[rowIndex];
      if (row.type !== 'group') continue;
      if (geometryY < row.rect.top || geometryY > row.rect.bottom) continue;
      const groupBoundary = resolveAtomicVerticalTarget(
        [{ key: `group:${row.groupId}`, rect: row.rect, value: row.groupId }],
        geometryY,
        previousBoundary,
      )?.boundary;
      if (!groupBoundary) return finish(null, 'group:no-boundary', `row=${rowIndex}`);
      const sourceBelongsToTargetGroup = selectedRootIds.every(rootId => (
        hierarchyItems.find(item => item.id === rootId)?.containerId === row.groupId
      ));
      const canResolveInsideGroup = sourceBelongsToTargetGroup && !row.collapsed;
      if (!canResolveInsideGroup) {
        return moveTopLevelSourceAroundGroup(
          row,
          groupBoundary.side,
          sourceBelongsToTargetGroup ? 'group-collapsed:block' : 'group:hierarchy-boundary',
          `row=${rowIndex}:${verticalRowDebugKey(row)}`,
          groupBoundary,
        );
      }
      const targetRows = row.tabRows.filter(tabRow => !sourceSet.has(tabRow.tabId));
      if (targetRows.length === 0) {
        return finish(
          makePreview(baseOrder, {
            targetTabIds: [],
            targetGroupId: row.groupId,
            targetPlacement: 'inside',
            targetKind: 'group-inside',
          }),
          'group-inside:only-slot',
          `row=${rowIndex}:${shortDndId(row.groupId)}`,
          { blockKey: `group:${row.groupId}:inside`, side: 'after' },
        );
      }
      // Once X has explicitly entered an expanded group, the same pointer Y
      // owns the child slot. Header Y means the first slot; body and footer Y
      // resolve against the nearest visible child without waiting for another
      // vertical mouse event.
      const targetRow = targetRows.find(tabRow => geometryY >= tabRow.rect.top && geometryY <= tabRow.rect.bottom)
        || targetRows.reduce((nearest, tabRow) => {
          const distance = geometryY < tabRow.rect.top
            ? tabRow.rect.top - geometryY
            : Math.max(0, geometryY - tabRow.rect.bottom);
          return !nearest || distance < nearest.distance ? { tabRow, distance } : nearest;
        }, null as { tabRow: { tabId: string; rect: RectSnap }; distance: number } | null)?.tabRow;
      if (targetRow) {
        return assignSiblingBlock(
          targetRow.tabId,
          'group-tab:block',
          `row=${rowIndex}:${shortDndId(row.groupId)}`
        );
      }
      return finish(null, 'group-body:no-target', `row=${rowIndex}:${verticalRowDebugKey(row)}`);
    }

    const nearestRemainingTarget = resolveAtomicVerticalTarget(
      geometry.rows.map((row, rowIndex) => ({
        key: row.type === 'group' ? `group:${row.groupId}` : `tab-row:${row.tabId}`,
        rect: row.rect,
        value: { row, rowIndex },
      })),
      geometryY,
      previousBoundary,
    );
    if (!nearestRemainingTarget) return finish(null, 'fallback:no-target');
    const { row, rowIndex } = nearestRemainingTarget.target.value;
    if (row.type === 'group') {
      return moveTopLevelSourceAroundGroup(
        row,
        nearestRemainingTarget.boundary.side,
        'fallback:group-block',
        `row=${rowIndex}:${verticalRowDebugKey(row)}`,
        nearestRemainingTarget.boundary,
      );
    }
    return assignSiblingBlock(
      row.tabId,
      'fallback:tab-block',
      `row=${rowIndex}:${verticalRowDebugKey(row)}`,
    );
  }, [isVerticalLayout, projectId]);

  // Monitor for all drag events
  useEffect(() => {
    const mergeHorizontalAssignments = (preview: DragPreviewLayout | null): DragPreviewLayout | null => {
      if (!preview) return null;
      const parentAssignments = tabHorizontalParentAssignmentsRef.current;
      const groupAssignments = tabHorizontalGroupAssignmentsRef.current;
      const groupAnchorAssignments = tabHorizontalGroupAnchorAssignmentsRef.current;
      if (Object.keys(parentAssignments).length === 0
        && Object.keys(groupAssignments).length === 0
        && Object.keys(groupAnchorAssignments).length === 0) return preview;
      const currentWorkspace = useWorkspaceStore.getState().openProjects.get(projectId);
      if (!currentWorkspace) return preview;
      return {
        ...preview,
        groupAssignments: {
          ...preview.groupAssignments,
          ...groupAssignments,
        },
        visualParentAssignments: {
          ...(preview.visualParentAssignments || {}),
          ...parentAssignments,
        },
        groupAnchorAssignments: {
          ...(preview.groupAnchorAssignments || {}),
          ...groupAnchorAssignments,
        },
      };
    };
    const hasAcceptedHorizontalProjection = () => Object.keys(tabHorizontalParentAssignmentsRef.current).length > 0
      || Object.keys(tabHorizontalGroupAssignmentsRef.current).length > 0
      || Object.keys(tabHorizontalGroupAnchorAssignmentsRef.current).length > 0;
    const sourceNavigationKey = (sourceData: DragData) => sourceData.type === 'TAB'
      ? `TAB:${sourceData.id}`
      : `TAB_GROUP:${sourceData.groupId}`;
    const cancelTabDndNavigationDwell = (reason: string) => {
      if (tabDndNavigationTimerRef.current !== null) {
        clearTimeout(tabDndNavigationTimerRef.current);
        tabDndNavigationTimerRef.current = null;
      }
      setTabDndNavigationSpringState((previous) => previous ? null : previous);
      if (tabDndNavigationRef.current?.active && performance.now() < tabDndLogUntilRef.current) {
        console.log(
          `[TabDnd:navigation-dwell] project=${shortDndId(projectId)}` +
          ` action=cancel reason=${reason}`
        );
      }
    };
    const initializeTabDndNavigation = (sourceData: DragData) => {
      const currentWorkspace = useWorkspaceStore.getState().openProjects.get(projectId);
      tabDndNavigationRef.current = {
        sourceKey: sourceNavigationKey(sourceData),
        active: false,
        suspended: false,
        frozenPreview: null,
        frozenPreviewKey: '',
        hoveredGroupId: null,
        entryEpoch: 0,
        latched: false,
        collapsedBeforeDrag: new Map(
          (currentWorkspace?.tabGroups || []).map(group => [group.id, !!group.collapsed])
        ),
        temporaryToggledGroupIds: new Set(),
      };
    };
    const restoreTemporaryGroupToggles = (session: TabDndNavigationSession, reason: string) => {
      if (session.temporaryToggledGroupIds.size === 0) return;
      const restored: string[] = [];
      for (const groupId of session.temporaryToggledGroupIds) {
        const currentWorkspace = useWorkspaceStore.getState().openProjects.get(projectId);
        const group = currentWorkspace?.tabGroups?.find(candidate => candidate.id === groupId);
        const baseline = session.collapsedBeforeDrag.get(groupId);
        if (!group || baseline === undefined || !!group.collapsed === baseline) continue;
        groupCollapseFlipSuppressUntilRef.current = Math.max(
          groupCollapseFlipSuppressUntilRef.current,
          performance.now() + GROUP_COLLAPSE_FLIP_SUPPRESS_MS
        );
        toggleTabGroupCollapsed(projectId, groupId);
        restored.push(groupId);
      }
      console.log(
        `[TabDnd:navigation-restore] project=${shortDndId(projectId)}` +
        ` reason=${reason}` +
        ` groups=${restored.map(shortDndId).join('.') || '-'}`
      );
    };
    const finalizeTabDndNavigation = (commitExpansion: boolean, reason: string) => {
      tabDndNavigationResumeSeqRef.current += 1;
      cancelTabDndNavigationDwell(reason);
      const session = tabDndNavigationRef.current;
      if (session && !commitExpansion) restoreTemporaryGroupToggles(session, reason);
      tabDndNavigationRef.current = null;
      tabDndMetaKeyPressedRef.current = false;
      tabDndLastPointerRef.current = null;
    };
    const enterTabDndNavigation = (sourceData: DragData, reason: string) => {
      const sourceKey = sourceNavigationKey(sourceData);
      let session = tabDndNavigationRef.current;
      if (!session || session.sourceKey !== sourceKey) {
        initializeTabDndNavigation(sourceData);
        session = tabDndNavigationRef.current;
      }
      if (!session || session.active) return;
      const currentPreviewKey = dragPreviewKeyRef.current;
      const hasPaintedPreview = !!currentPreviewKey
        && paintedDragPreviewKeyRef.current === currentPreviewKey
        && !!dragPreviewRef.current;
      session.active = true;
      session.suspended = false;
      session.frozenPreview = hasPaintedPreview ? dragPreviewRef.current : null;
      session.frozenPreviewKey = hasPaintedPreview ? currentPreviewKey : '';
      session.hoveredGroupId = null;
      session.entryEpoch += 1;
      session.latched = false;
      setTabHorizontalIntent(null);
      if (!hasPaintedPreview) {
        dragPreviewKeyRef.current = '';
        paintedDragPreviewKeyRef.current = '';
        setVerticalDragPreview(null);
      }
      console.log(
        `[TabDnd:navigation] project=${shortDndId(projectId)}` +
        ` action=enter reason=${reason}` +
        ` source=${shortDndId(sourceData.type === 'TAB' ? sourceData.id : sourceData.groupId)}` +
        ` frozen=${session.frozenPreview?.status || 'none'}` +
        ` key=${session.frozenPreviewKey ? 1 : 0}`
      );
    };
    const scheduleTabDndNavigationToggle = (sourceData: DragData, groupId: string) => {
      const session = tabDndNavigationRef.current;
      if (!session?.active || session.hoveredGroupId !== groupId || session.latched) return;
      cancelTabDndNavigationDwell('schedule-replace');
      const entryEpoch = session.entryEpoch;
      setTabDndNavigationSpringState({ groupId, phase: 'waiting', entryEpoch });
      console.log(
        `[TabDnd:navigation-dwell] project=${shortDndId(projectId)}` +
        ` action=schedule group=${shortDndId(groupId)}` +
        ` epoch=${entryEpoch} delay=${TAB_DND_NAVIGATION_DWELL_MS}`
      );
      tabDndNavigationTimerRef.current = setTimeout(() => {
        tabDndNavigationTimerRef.current = null;
        const currentSession = tabDndNavigationRef.current;
        if (
          !currentSession?.active
          || currentSession.sourceKey !== sourceNavigationKey(sourceData)
          || currentSession.hoveredGroupId !== groupId
          || currentSession.entryEpoch !== entryEpoch
          || currentSession.latched
        ) return;
        const currentWorkspace = useWorkspaceStore.getState().openProjects.get(projectId);
        const group = currentWorkspace?.tabGroups?.find(candidate => candidate.id === groupId);
        if (!group) return;
        setTabDndNavigationSpringState({ groupId, phase: 'loading', entryEpoch });
        const wasCollapsed = !!group.collapsed;
        groupCollapseFlipSuppressUntilRef.current = Math.max(
          groupCollapseFlipSuppressUntilRef.current,
          performance.now() + GROUP_COLLAPSE_FLIP_SUPPRESS_MS
        );
        tabDndLogUntilRef.current = Math.max(tabDndLogUntilRef.current, performance.now() + 1600);
        toggleTabGroupCollapsed(projectId, groupId);
        currentSession.temporaryToggledGroupIds.add(groupId);
        currentSession.latched = true;
        setTabDndNavigationSpringState(null);
        console.log(
          `[TabDnd:navigation-toggle] project=${shortDndId(projectId)}` +
          ` group=${shortDndId(groupId)}` +
          ` from=${wasCollapsed ? 'closed' : 'open'}` +
          ` to=${wasCollapsed ? 'open' : 'closed'}` +
          ` epoch=${entryEpoch}`
        );
      }, TAB_DND_NAVIGATION_DWELL_MS);
    };
    const updateTabDndNavigationHover = (
      sourceData: DragData,
      clientX: number,
      clientY: number,
      reason: string,
    ) => {
      const session = tabDndNavigationRef.current;
      if (!session?.active) return;
      const list = verticalMainListRef.current;
      const header = document.elementsFromPoint(clientX, clientY)
        .map(element => element.closest<HTMLElement>('[data-tab-group-header="true"]'))
        .find((candidate): candidate is HTMLElement => !!candidate && !!list?.contains(candidate));
      let groupId = header?.dataset.groupId || null;
      if (sourceData.type === 'TAB_GROUP' && sourceData.groupId === groupId) groupId = null;
      if (session.hoveredGroupId === groupId) return;
      cancelTabDndNavigationDwell('target-change');
      session.hoveredGroupId = groupId;
      session.entryEpoch += 1;
      session.latched = false;
      console.log(
        `[TabDnd:navigation] project=${shortDndId(projectId)}` +
        ` action=target reason=${reason}` +
        ` group=${shortDndId(groupId)}` +
        ` epoch=${session.entryEpoch}`
      );
      if (groupId) scheduleTabDndNavigationToggle(sourceData, groupId);
    };
    const exitTabDndNavigation = (sourceData: DragData, reason: string) => {
      const session = tabDndNavigationRef.current;
      if (!session?.active) return;
      cancelTabDndNavigationDwell('navigation-exit');
      session.active = false;
      session.suspended = false;
      session.hoveredGroupId = null;
      session.latched = false;
      const resumeSeq = ++tabDndNavigationResumeSeqRef.current;
      console.log(
        `[TabDnd:navigation] project=${shortDndId(projectId)}` +
        ` action=exit reason=${reason}` +
        ` frozen=${session.frozenPreview?.status || 'none'}`
      );
      requestAnimationFrame(() => requestAnimationFrame(() => {
        const currentSession = tabDndNavigationRef.current;
        const pointer = tabDndLastPointerRef.current;
        if (
          resumeSeq !== tabDndNavigationResumeSeqRef.current
          || currentSession !== session
          || currentSession?.active
          || !pointer
        ) return;
        const geometry = captureVerticalDragGeometry('navigation-resume');
        verticalDragGeometryRef.current = geometry;
        const sourceRect = findVerticalDragSourceRect(sourceData, geometry);
        verticalDragAnchorRef.current = sourceRect
          ? {
              startY: pointer.clientY,
              startX: pointer.clientX,
              horizontalBaseX: pointer.clientX,
              sourceTop: sourceRect.top,
              sourceBottom: sourceRect.bottom,
              sourceMidY: sourceRect.midY,
              offsetY: 0,
            }
          : null;
        tabHorizontalSuspendYRef.current = null;
        verticalResolutionCacheRef.current = null;
        const resumedPreview = mergeHorizontalAssignments(
          resolveStaticVerticalPreview(sourceData, pointer.clientX, pointer.clientY)
        );
        const key = resumedPreview ? JSON.stringify(resumedPreview) : '';
        dragPreviewKeyRef.current = key;
        lastDragPreviewInputRef.current = {
          clientX: pointer.clientX,
          clientY: pointer.clientY,
          key,
        };
        setVerticalDragPreview(resumedPreview);
        console.log(
          `[TabDnd:navigation-resume] project=${shortDndId(projectId)}` +
          ` reason=${reason}` +
          ` x=${Math.round(pointer.clientX)} y=${Math.round(pointer.clientY)}` +
          ` geometry=${geometry?.id || 'none'}` +
          ` ${summarizePreviewLayout(resumedPreview)}`
        );
      }));
    };
    const suspendTabDndNavigation = (reason: string) => {
      const session = tabDndNavigationRef.current;
      if (!session || (session.suspended && !session.active)) return;
      cancelTabDndNavigationDwell(reason);
      session.active = false;
      session.suspended = true;
      session.hoveredGroupId = null;
      session.latched = false;
      tabDndNavigationResumeSeqRef.current += 1;
      console.log(
        `[TabDnd:navigation] project=${shortDndId(projectId)}` +
        ` action=suspend reason=${reason}`
      );
    };
    const previewChangesWorkspace = (preview: DragPreviewLayout) => {
      const currentWorkspace = useWorkspaceStore.getState().openProjects.get(projectId);
      if (!currentWorkspace) return false;
      const currentMainTabs = Array.from(currentWorkspace.tabs.values())
        .filter(tab => !tab.parentTabId);
      const currentOrder = currentMainTabs.map(tab => tab.id);
      if (
        currentOrder.length !== preview.orderedIds.length
        || currentOrder.some((id, index) => id !== preview.orderedIds[index])
      ) return true;
      for (const [tabId, groupId] of Object.entries(preview.groupAssignments)) {
        if ((currentWorkspace.tabs.get(tabId)?.groupId || null) !== (groupId || null)) return true;
      }
      for (const [tabId, parentId] of Object.entries(preview.visualParentAssignments || {})) {
        if ((currentWorkspace.tabs.get(tabId)?.visualParentTabId || null) !== (parentId || null)) return true;
      }
      for (const [groupId, anchorId] of Object.entries(preview.groupAnchorAssignments || {})) {
        const group = currentWorkspace.tabGroups.find(candidate => candidate.id === groupId);
        if ((group?.anchorTabId || null) !== (anchorId || null)) return true;
      }
      return false;
    };
    const makeHorizontalOnlyPreview = (
      preview: DragPreviewLayout | null,
      blockedReason?: string,
      preserveVerticalTarget = false,
    ): DragPreviewLayout | null => {
      const combined = mergeHorizontalAssignments(preview);
      if (!combined) return null;
      const hasCommittedProjection = Object.keys(tabHorizontalParentAssignmentsRef.current).length > 0
        || Object.keys(tabHorizontalGroupAssignmentsRef.current).length > 0
        || Object.keys(tabHorizontalGroupAnchorAssignmentsRef.current).length > 0;
      return {
        ...combined,
        status: hasCommittedProjection ? 'allowed' : (blockedReason ? 'blocked' : 'noop'),
        reason: hasCommittedProjection
          ? (blockedReason
            ? 'horizontal-projection-blocked-next-step'
            : (preserveVerticalTarget ? 'horizontal-entry-slot' : 'horizontal-only'))
          : (blockedReason || 'horizontal-intent'),
        interactionAxis: 'horizontal',
        projectionRevision: tabHierarchyProjectionRevisionRef.current,
        ...(preserveVerticalTarget ? {} : {
          targetTabIds: [],
          targetGroupId: null,
          targetPlacement: undefined,
          targetKind: undefined,
          verticalBoundary: undefined,
        }),
      };
    };

    const resolveHorizontalStep = (
      sourceData: DragData,
      direction: 'left' | 'right',
      verticalPreview: DragPreviewLayout | null,
    ) => {
      if (sourceData.type !== 'TAB') return { ok: false, disabled: true, reason: 'not-tab', preview: verticalPreview };
      const selectedIds = sourceData.selectedTabIds?.includes(sourceData.id)
        ? sourceData.selectedTabIds
        : [sourceData.id];
      if (selectedIds.length !== 1) {
        return { ok: false, disabled: true, reason: 'multi-selection', preview: mergeHorizontalAssignments(verticalPreview) };
      }
      const currentWorkspace = useWorkspaceStore.getState().openProjects.get(projectId);
      if (!currentWorkspace) return { ok: false, disabled: true, reason: 'no-workspace', preview: verticalPreview };
      const workspaceGroups = currentWorkspace.tabGroups || [];
      const validGroupIds = new Set(workspaceGroups.map(group => group.id));
      const combined = mergeHorizontalAssignments(verticalPreview);
      if (!combined) return { ok: false, disabled: true, reason: 'outside-list', preview: null };
      const allMainTabs = Array.from(currentWorkspace.tabs.values()).filter(tab => !tab.parentTabId);
      const byId = new Map(allMainTabs.map(tab => [tab.id, tab]));
      const orderedIds = combined?.orderedIds?.length
        ? combined.orderedIds
        : orderTabsWithVisualChildren(allMainTabs).map(tab => tab.id);
      const orderedTabs = [
        ...orderedIds.map(id => byId.get(id)).filter((tab): tab is TabData => !!tab),
        ...allMainTabs.filter(tab => !orderedIds.includes(tab.id)),
      ];
      const items = orderedTabs.map(tab => ({
        id: tab.id,
        parentId: combined?.visualParentAssignments
          && Object.prototype.hasOwnProperty.call(combined.visualParentAssignments, tab.id)
          ? combined.visualParentAssignments[tab.id] || null
          : tab.visualParentTabId || null,
        containerId: (() => {
          const candidate = Object.prototype.hasOwnProperty.call(combined?.groupAssignments || {}, tab.id)
            ? combined!.groupAssignments[tab.id] || null
            : tab.groupId || null;
          return candidate && validGroupIds.has(candidate) ? candidate : null;
        })(),
        position: orderedIds.indexOf(tab.id),
      }));
      const sourceItem = items.find(item => item.id === sourceData.id);
      const projectedTabs = orderTabsWithVisualChildren(orderedTabs.map(tab => {
        const item = items.find(candidate => candidate.id === tab.id);
        return item ? {
          ...tab,
          groupId: item.containerId || undefined,
          visualParentTabId: item.parentId || undefined,
        } : tab;
      }));
      const displayRows = buildVerticalDisplayRows(projectedTabs, workspaceGroups);
      const sourceRowIndex = displayRows.findIndex(row => row.kind === 'tab' && row.tab.id === sourceData.id);
      const previousRow = sourceRowIndex > 0 ? displayRows[sourceRowIndex - 1] : null;
      const precedingGroupId = previousRow?.kind === 'group-header'
        ? previousRow.group.id
        : previousRow?.kind === 'tab' ? previousRow.group?.id : undefined;
      const targetedGroupId = combined.targetKind === 'group-block'
        ? combined.targetGroupId || undefined
        : undefined;
      const entryGroupId = targetedGroupId || precedingGroupId;
      const entryGroup = entryGroupId
        ? workspaceGroups.find(group => group.id === entryGroupId)
        : undefined;
      let result;
      if (
        direction === 'right'
        && sourceItem
        && !sourceItem.parentId
        && !sourceItem.containerId
        && targetedGroupId
        && entryGroup?.collapsed
      ) {
        return {
          ok: false,
          disabled: true,
          reason: 'closed-group-needs-navigation',
          preview: combined,
        };
      }
      if (
        direction === 'right'
        && sourceItem
        && !sourceItem.parentId
        && !sourceItem.containerId
        && entryGroupId
        && !entryGroup?.collapsed
      ) {
        const subtree = visualHierarchySubtreeItems(items, sourceData.id, { parentKey: 'parentId' });
        const subtreeIds = new Set(subtree.map(item => item.id));
        const nextItems = items.map(item => subtreeIds.has(item.id)
          ? {
              ...item,
              parentId: item.id === sourceData.id ? null : item.parentId,
              containerId: entryGroupId,
            }
          : item);
        result = {
          ok: true,
          disabled: false,
          direction,
          reason: 'enter-preceding-group',
          parentId: null,
          containerId: entryGroupId,
          parentAssignments: { [sourceData.id]: null },
          containerAssignments: Object.fromEntries(subtree.map(item => [item.id, entryGroupId])),
          items: nextItems,
        };
      } else {
        result = resolveVisualHierarchyStep({
          items,
          sourceId: sourceData.id,
          direction,
          parentKey: 'parentId',
          containerKey: 'containerId',
          maxDepth: 4,
        });
      }
      if (!result.ok) return { ...result, preview: combined };
      const parentAssignments = {
        ...tabHorizontalParentAssignmentsRef.current,
        ...(result.parentAssignments || { [sourceData.id]: result.parentId || null }),
      };
      const groupAssignments = {
        ...tabHorizontalGroupAssignmentsRef.current,
        ...(result.containerAssignments || {}),
      };
      const groupAnchorAssignments = {
        ...tabHorizontalGroupAnchorAssignmentsRef.current,
      };
      const basePreview = combined;
      let nextOrderedIds = [...basePreview.orderedIds];
      if (result.reason === 'detach-from-container') {
        const oldContainerId = items.find(item => item.id === sourceData.id)?.containerId || null;
        const sourceSubtreeIds = new Set(
          visualHierarchySubtreeItems(result.items, sourceData.id, { parentKey: 'parentId' }).map(item => item.id)
        );
        const sourceBlock = nextOrderedIds.filter(id => sourceSubtreeIds.has(id));
        const withoutSource = nextOrderedIds.filter(id => !sourceSubtreeIds.has(id));
        const remainingContainerIds = oldContainerId
          ? withoutSource.filter(id => {
              const item = result.items.find((candidate: any) => candidate.id === id);
              return item?.containerId === oldContainerId;
            })
          : [];
        const insertionIndex = remainingContainerIds.length > 0
          ? withoutSource.lastIndexOf(remainingContainerIds[remainingContainerIds.length - 1]) + 1
          : Math.max(0, nextOrderedIds.findIndex(id => sourceSubtreeIds.has(id)));
        nextOrderedIds = [...withoutSource];
        nextOrderedIds.splice(insertionIndex, 0, ...sourceBlock);
        if (oldContainerId && remainingContainerIds.length === 0) {
          groupAnchorAssignments[oldContainerId] = sourceData.id;
        }
      }
      return {
        ...result,
        parentAssignments,
        groupAssignments,
        groupAnchorAssignments,
        preview: {
          ...basePreview,
          orderedIds: nextOrderedIds,
          groupAssignments: {
            ...basePreview.groupAssignments,
            ...groupAssignments,
          },
          visualParentAssignments: {
            ...(basePreview.visualParentAssignments || {}),
            ...parentAssignments,
          },
          groupAnchorAssignments: {
            ...(basePreview.groupAnchorAssignments || {}),
            ...groupAnchorAssignments,
          },
        },
      };
    };

    const resetDragPreviewState = ({
      commitNavigationExpansion = false,
      reason = 'reset',
    }: {
      commitNavigationExpansion?: boolean;
      reason?: string;
    } = {}) => {
      finalizeTabDndNavigation(commitNavigationExpansion, reason);
      dragPreviewKeyRef.current = '';
      paintedDragPreviewKeyRef.current = '';
      lastDragPreviewInputRef.current = null;
      verticalDragGeometryRef.current = null;
      verticalDragAnchorRef.current = null;
      verticalResolutionCacheRef.current = null;
      tabHierarchyProjectionRevisionRef.current = 0;
      tabHorizontalSuspendYRef.current = null;
      tabHorizontalParentAssignmentsRef.current = {};
      tabHorizontalGroupAssignmentsRef.current = {};
      tabHorizontalGroupAnchorAssignmentsRef.current = {};
      tabDndSourceDataRef.current = null;
      setTabHorizontalIntent(null);
      flushSync(() => setVerticalDragPreview(null));
    };

    const cancelPendingDragEndCleanup = () => {
      if (pendingDragEndCleanupRef.current === null) return;
      clearTimeout(pendingDragEndCleanupRef.current);
      pendingDragEndCleanupRef.current = null;
    };

    const cleanupMonitor = monitorForElements({
      canMonitor: ({ source }) => source.data.type === 'TAB' || source.data.type === 'TAB_GROUP',
      onDragStart({ source, location }) {
        cancelPendingDragEndCleanup();
        tabNativeDropCancelledRef.current = false;
        const sourceData = source.data as DragData;
        if (tabDndNavigationRef.current) finalizeTabDndNavigation(false, 'drag-start-replace');
        initializeTabDndNavigation(sourceData);
        tabDndSourceDataRef.current = sourceData;
        tabDndMetaKeyPressedRef.current = !!location.initial.input.metaKey;
        tabDndLastPointerRef.current = {
          clientX: location.initial.input.clientX,
          clientY: location.initial.input.clientY,
        };
        postDropRevealTokenRef.current += 1;
        verticalDragResolveTraceRef.current = null;
        dragPreviewRef.current = null;
        dragPreviewKeyRef.current = '';
        paintedDragPreviewKeyRef.current = '';
        lastDragPreviewInputRef.current = null;
        verticalResolutionCacheRef.current = null;
        tabHierarchyProjectionRevisionRef.current = 0;
        tabHorizontalSuspendYRef.current = null;
        tabHorizontalParentAssignmentsRef.current = {};
        tabHorizontalGroupAssignmentsRef.current = {};
        tabHorizontalGroupAnchorAssignmentsRef.current = {};
        setTabHorizontalIntent(null);
        verticalDragGeometryRef.current = sourceData.projectId === projectId ? captureVerticalDragGeometry('start') : null;
        const sourceRect = findVerticalDragSourceRect(sourceData, verticalDragGeometryRef.current);
        verticalDragAnchorRef.current = sourceRect
          ? {
              startY: location.initial.input.clientY,
              startX: location.initial.input.clientX,
              horizontalBaseX: location.initial.input.clientX,
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
        if (tabDndMetaKeyPressedRef.current) {
          enterTabDndNavigation(sourceData, 'drag-start');
          updateTabDndNavigationHover(
            sourceData,
            location.initial.input.clientX,
            location.initial.input.clientY,
            'drag-start'
          );
        }
      },
      onDrag({ source, location }) {
        const target = location.current.dropTargets[0];
        const input = location.current.input;
        const anchor = verticalDragAnchorRef.current;
        const effectiveY = anchor ? input.clientY + anchor.offsetY : input.clientY;
        const sourceData = source.data as DragData;
        tabDndLastPointerRef.current = { clientX: input.clientX, clientY: input.clientY };
        if (input.metaKey === false) tabDndMetaKeyPressedRef.current = false;
        const metaKey = !!(input.metaKey || tabDndMetaKeyPressedRef.current);
        let preview: DragPreviewLayout | null = null;
        const capturedList = verticalDragGeometryRef.current?.list;
        const pointerInsideCapturedList = !!capturedList
          && input.clientX >= capturedList.left
          && input.clientX <= capturedList.right
          && effectiveY >= capturedList.top
          && effectiveY <= capturedList.bottom;
        if (
          isVerticalLayout
          && sourceData.zone === 'main'
          && metaKey
          && pointerInsideCapturedList
        ) {
          enterTabDndNavigation(sourceData, 'drag-meta');
          updateTabDndNavigationHover(sourceData, input.clientX, input.clientY, 'drag-meta');
          return;
        }
        if (tabDndNavigationRef.current?.active && !metaKey) {
          exitTabDndNavigation(sourceData, 'drag-meta-release');
          return;
        }
        if (!pointerInsideCapturedList && tabDndNavigationRef.current) {
          suspendTabDndNavigation('surface-leave');
        }
        if (
          sourceData.type === 'TAB'
          && isVerticalLayout
          && sourceData.zone === 'main'
          && !pointerInsideCapturedList
        ) {
          setTabHorizontalIntent(null);
          tabHorizontalSuspendYRef.current = null;
          preview = null;
        } else if (sourceData.type === 'TAB' && isVerticalLayout && sourceData.zone === 'main' && anchor) {
          const deltaX = input.clientX - anchor.horizontalBaseX;
          const suspendedAtY = tabHorizontalSuspendYRef.current;
          const previousEffectiveY = lastDragPreviewInputRef.current
            ? lastDragPreviewInputRef.current.clientY + anchor.offsetY
            : anchor.sourceMidY;
          const deltaYFromHorizontalAnchor = horizontalIntentFrameDeltaY(
            effectiveY,
            suspendedAtY,
            previousEffectiveY,
          );
          if (horizontalPointerIntentOwnsFrame(
            deltaX,
            deltaYFromHorizontalAnchor,
            TAB_HORIZONTAL_INTENT_DEADZONE_PX,
          )) {
            const isFirstHorizontalFrame = tabHorizontalSuspendYRef.current === null;
            if (isFirstHorizontalFrame) tabHorizontalSuspendYRef.current = effectiveY;
            const frozenPreview = isFirstHorizontalFrame
              ? mergeHorizontalAssignments(resolveStaticVerticalPreview(sourceData, input.clientX, effectiveY))
              : (dragPreviewRef.current
                || resolveStaticVerticalPreview(sourceData, input.clientX, tabHorizontalSuspendYRef.current));
            const direction: 'left' | 'right' = deltaX < 0 ? 'left' : 'right';
            const probe = resolveHorizontalStep(sourceData, direction, frozenPreview);
            const preservesGroupEntryTarget = direction === 'right'
              && frozenPreview?.targetKind === 'group-block'
              && !!frozenPreview.targetGroupId;
            const hasAcceptedHorizontalStep = hasAcceptedHorizontalProjection();
            const crossedStepThreshold = Math.abs(deltaX) >= TAB_HORIZONTAL_STEP_PX;
            setTabHorizontalIntent({
              sourceId: sourceData.id,
              direction,
              progress: Math.min(1, Math.abs(deltaX) / TAB_HORIZONTAL_STEP_PX),
              disabled: !probe.ok && (!hasAcceptedHorizontalStep || crossedStepThreshold),
              reason: probe.ok ? undefined : probe.reason,
            });
            if (crossedStepThreshold) {
              if (probe.ok) {
                tabHorizontalParentAssignmentsRef.current = probe.parentAssignments;
                tabHorizontalGroupAssignmentsRef.current = probe.groupAssignments;
                tabHorizontalGroupAnchorAssignmentsRef.current = probe.groupAnchorAssignments;
                tabHierarchyProjectionRevisionRef.current += 1;
                verticalResolutionCacheRef.current = null;
                anchor.horizontalBaseX = input.clientX;
                tabHorizontalSuspendYRef.current = effectiveY;
                const enteredGroup = probe.reason === 'enter-preceding-group';
                const projectedSlotPreview = enteredGroup
                  ? resolveStaticVerticalPreview(sourceData, input.clientX, effectiveY)
                  : probe.preview;
                const hasExactEntrySlot = enteredGroup
                  && !!projectedSlotPreview
                  && (projectedSlotPreview.targetKind === 'tab-block'
                    || projectedSlotPreview.targetKind === 'group-inside');
                preview = makeHorizontalOnlyPreview(
                  projectedSlotPreview || probe.preview,
                  undefined,
                  hasExactEntrySlot,
                );
                console.log(
                  `[TabDnd:hierarchy] project=${shortDndId(projectId)}` +
                  ` source=${shortDndId(sourceData.id)} direction=${direction}` +
                  ` parent=${shortDndId(probe.parentId || null)} reason=${probe.reason}`
                );
              } else {
                preview = makeHorizontalOnlyPreview(
                  frozenPreview,
                  probe.reason || 'horizontal-step-blocked',
                  preservesGroupEntryTarget || probe.reason === 'closed-group-needs-navigation',
                );
              }
            } else {
              preview = makeHorizontalOnlyPreview(
                frozenPreview,
                probe.ok ? undefined : (probe.reason || 'horizontal-step-blocked'),
                preservesGroupEntryTarget || probe.reason === 'closed-group-needs-navigation',
              );
            }
          } else {
            if (suspendedAtY !== null
              && Math.abs(effectiveY - suspendedAtY) < TAB_VERTICAL_RESUME_AFTER_HORIZONTAL_PX) {
              if (!hasAcceptedHorizontalProjection()) setTabHorizontalIntent(null);
              const frozenPreview = dragPreviewRef.current
                || resolveStaticVerticalPreview(sourceData, input.clientX, suspendedAtY);
              preview = makeHorizontalOnlyPreview(frozenPreview);
            } else {
              setTabHorizontalIntent(null);
              if (suspendedAtY !== null) anchor.horizontalBaseX = input.clientX;
              tabHorizontalSuspendYRef.current = null;
              preview = mergeHorizontalAssignments(resolveStaticVerticalPreview(sourceData, input.clientX, effectiveY));
            }
          }
        } else {
          setTabHorizontalIntent(null);
          tabHorizontalSuspendYRef.current = null;
          preview = mergeHorizontalAssignments(resolveStaticVerticalPreview(sourceData, input.clientX, effectiveY));
        }
        const key = preview ? JSON.stringify(preview) : '';
        lastDragPreviewInputRef.current = { clientX: input.clientX, clientY: input.clientY, key };
        if (key !== dragPreviewKeyRef.current) {
          dragPreviewKeyRef.current = key;
          tabDndLogUntilRef.current = performance.now() + 5000;
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
          setVerticalDragPreview(preview);
        }
      },
      onDrop({ source, location }) {
        cancelPendingDragEndCleanup();
        const sourceData = source.data as DragData;
        const target = location.current.dropTargets[0];
        const targetData = target?.data as any;
        const input = location.current.input;
        const anchor = verticalDragAnchorRef.current;
        const effectiveY = anchor ? input.clientY + anchor.offsetY : input.clientY;
        const geometryBeforeDrop = verticalDragGeometryRef.current;
        const wasNativeCancel = tabNativeDropCancelledRef.current;
        tabNativeDropCancelledRef.current = false;
        const navigationSession = tabDndNavigationRef.current;
        const dropUsesFrozenNavigation = !!navigationSession?.active;
        const frozenNavigationPreview = dropUsesFrozenNavigation
          ? navigationSession?.frozenPreview || null
          : null;

        if (wasNativeCancel) {
          tabDndLogUntilRef.current = performance.now() + 5000;
          console.log(
            `[TabDnd:drop] project=${shortDndId(projectId)}` +
            ` sourceType=${sourceData.type}` +
            ` source=${shortDndId(sourceData.type === 'TAB' ? sourceData.id : sourceData.groupId)}` +
            ` cancelled=native`
          );
          resetDragPreviewState({ reason: 'native-cancel' });
          window.dispatchEvent(new Event(TABBAR_FORCE_RELEASE_EVENT));
          return;
        }

        const lastInput = lastDragPreviewInputRef.current;
        const list = geometryBeforeDrop?.list;
        const pointerInsideMainList = !!list
          && input.clientX >= list.left
          && input.clientX <= list.right
          && effectiveY >= list.top
          && effectiveY <= list.bottom;
        const rawPointerInsideMainList = !!list
          && input.clientX >= list.left
          && input.clientX <= list.right
          && input.clientY >= list.top
          && input.clientY <= list.bottom;
        const ownsStaticVerticalDrag = !!geometryBeforeDrop
          && isVerticalLayout
          && sourceData.zone === 'main'
          && sourceData.projectId === projectId;
        const paintedPreview = dragPreviewRef.current;
        const isHorizontalPreview = paintedPreview?.interactionAxis === 'horizontal';
        const releasePreview = ownsStaticVerticalDrag && !isHorizontalPreview
          ? resolveStaticVerticalPreview(sourceData, input.clientX, effectiveY)
          : null;
        const targetIsMain = isMainVerticalDropTarget(targetData);
        const hasSemanticDropParity = isHorizontalPreview
          ? paintedPreview?.projectionRevision === tabHierarchyProjectionRevisionRef.current
          : sameVerticalSemanticBoundary(
              paintedPreview?.verticalBoundary,
              releasePreview?.verticalBoundary,
            );
        const preview = dropUsesFrozenNavigation
          ? (ownsStaticVerticalDrag && rawPointerInsideMainList ? frozenNavigationPreview : null)
          : ownsStaticVerticalDrag
            && !!target
            && targetIsMain
            && pointerInsideMainList
            && !!lastInput?.key
            && lastInput.key === dragPreviewKeyRef.current
            && paintedDragPreviewKeyRef.current === dragPreviewKeyRef.current
            && hasSemanticDropParity
            ? dragPreviewRef.current
            : null;
        const paintedDropGates = {
          owns: ownsStaticVerticalDrag,
          target: !!target && targetIsMain && pointerInsideMainList,
          lastKey: !!lastInput?.key,
          currentKey: !!lastInput?.key && lastInput.key === dragPreviewKeyRef.current,
          paintedKey: paintedDragPreviewKeyRef.current === dragPreviewKeyRef.current,
          parity: hasSemanticDropParity,
        };
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
          ` actionSource=${dropUsesFrozenNavigation ? 'frozen-navigation' : 'painted-preview'}` +
          ` axis=${paintedPreview?.interactionAxis || 'none'}` +
          ` targetMain=${targetIsMain ? 1 : 0}` +
          ` inside=${pointerInsideMainList ? 1 : 0}` +
          ` rawInside=${rawPointerInsideMainList ? 1 : 0}` +
          ` list=${list ? `${Math.round(list.left)},${Math.round(list.right)},${Math.round(list.top)},${Math.round(list.bottom)}` : '-'}` +
          ` parity=${hasSemanticDropParity ? 1 : 0}` +
          ` gates=${Object.entries(paintedDropGates).map(([name, value]) => `${name}:${value ? 1 : 0}`).join(',')}` +
          ` releaseBoundary=${releasePreview?.verticalBoundary ? `${releasePreview.verticalBoundary.blockKey}:${releasePreview.verticalBoundary.side}` : '-'}` +
          ` ${summarizeResolveTrace(verticalDragResolveTraceRef.current)}` +
          ` ${summarizePreviewLayout(preview)}`
        );
        if (preview?.status === 'allowed') {
          const changesWorkspace = previewChangesWorkspace(preview);
          if (!changesWorkspace) {
            console.log(
              `[TabDnd:apply-skip] project=${shortDndId(projectId)}` +
              ` source=${shortDndId(sourceData.type === 'TAB' ? sourceData.id : sourceData.groupId)}` +
              ` reason=layout-noop actionSource=${dropUsesFrozenNavigation ? 'frozen-navigation' : 'painted-preview'}`
            );
            resetDragPreviewState({ reason: 'layout-noop' });
            return;
          }
          applyTabLayout(
            projectId,
            preview.orderedIds,
            preview.groupAssignments,
            preview.visualParentAssignments,
            preview.groupAnchorAssignments
          );
          resetDragPreviewState({ commitNavigationExpansion: true, reason: 'drop-applied' });
          scheduleVerticalPostDropReveal(sourceData);
          return;
        }
        resetDragPreviewState({ reason: 'drop-no-allowed-preview' });
        if (!target) return;

        // Get fresh tabs from workspace (avoid stale closure)
        const currentWorkspace = useWorkspaceStore.getState().openProjects.get(projectId);
        if (!currentWorkspace) return;
        if (sourceData.type !== 'TAB') return;

        if (ownsStaticVerticalDrag && !isAdoptDropTarget(sourceData, targetData)) return;

        const allTabsNow = Array.from(currentWorkspace.tabs.values());
        const visibleTabsNow = allTabsNow.filter(t => !t.parentTabId);
        const mainTabsNow = visibleTabsNow;

        // Dropped on zone container (empty zone)
        if (targetData.type === 'ZONE') {
          return;
        }

        // Dropped on another tab
        if (targetData.type === 'TAB') {
          const edge = extractClosestEdge(targetData);
          const targetZone = targetData.zone as 'main';
          const targetIndex = targetData.index as number;

          // Calculate insertion index based on edge
          let insertIndex = targetIndex;
          if (edge === 'right' || edge === 'bottom') {
            insertIndex = targetIndex + 1;
          }

          if (sourceData.zone === targetZone) {
            const currentTabs = mainTabsNow.map(t => t.id);

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
          }
        }
      },
    });
    const clearCancelledDragPreview = (reason: 'escape' | 'dragend' | 'buttons-released') => {
      if (reason === 'escape') tabNativeDropCancelledRef.current = true;
      if (!verticalDragGeometryRef.current && !dragPreviewRef.current) return;
      console.log(
        `[TabDnd:cancel] project=${shortDndId(projectId)}` +
        ` reason=${reason}`
      );
      resetDragPreviewState({ reason: `cancel-${reason}` });
      window.dispatchEvent(new Event(TABBAR_FORCE_RELEASE_EVENT));
    };
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (!verticalDragGeometryRef.current && !dragPreviewRef.current) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      cancelPendingDragEndCleanup();
      clearCancelledDragPreview('escape');
    };
    const syncTabDndModifierMode = (event: KeyboardEvent) => {
      const sourceData = tabDndSourceDataRef.current;
      if (!sourceData || !verticalDragGeometryRef.current) return;
      const isMetaEvent = event.key === 'Meta'
        || event.code === 'MetaLeft'
        || event.code === 'MetaRight';
      if (isMetaEvent) {
        tabDndMetaKeyPressedRef.current = event.type !== 'keyup';
      } else if (!event.metaKey) {
        tabDndMetaKeyPressedRef.current = false;
      }
      const metaKey = !!(event.metaKey || tabDndMetaKeyPressedRef.current);
      const pointer = tabDndLastPointerRef.current;
      if (metaKey) {
        enterTabDndNavigation(sourceData, `modifier-${event.type}`);
        if (pointer) {
          updateTabDndNavigationHover(
            sourceData,
            pointer.clientX,
            pointer.clientY,
            `modifier-${event.type}`
          );
        }
      } else {
        exitTabDndNavigation(sourceData, `modifier-${event.type}`);
      }
    };
    const suspendTabDndOnFocusLoss = (reason: string) => {
      if (!tabDndSourceDataRef.current || !verticalDragGeometryRef.current) return;
      tabDndMetaKeyPressedRef.current = false;
      suspendTabDndNavigation(reason);
    };
    const resumeTabDndAfterFocus = (reason: string) => {
      const sourceData = tabDndSourceDataRef.current;
      const session = tabDndNavigationRef.current;
      if (!sourceData || !session?.suspended || !verticalDragGeometryRef.current) return;
      session.suspended = false;
      session.active = true;
      exitTabDndNavigation(sourceData, reason);
    };
    const handleWindowBlur = () => suspendTabDndOnFocusLoss('window-blur');
    const handleWindowFocus = () => resumeTabDndAfterFocus('window-focus');
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        resumeTabDndAfterFocus('visibility-visible');
      } else {
        suspendTabDndOnFocusLoss('visibility-hidden');
      }
    };
    const handleNativeDragEnd = (event: DragEvent) => {
      cancelPendingDragEndCleanup();
      const navigation = tabDndNavigationRef.current;
      const pointer = tabDndLastPointerRef.current;
      const list = verticalDragGeometryRef.current?.list;
      const canUseFrozenNavigation = !!navigation?.active
        && !!navigation.frozenPreview
        && !!pointer
        && !!list
        && pointer.clientX >= list.left
        && pointer.clientX <= list.right
        && pointer.clientY >= list.top
        && pointer.clientY <= list.bottom;
      console.log(
        `[TabDnd:native-dragend] project=${shortDndId(projectId)}` +
        ` dropEffect=${event.dataTransfer?.dropEffect || 'none'}` +
        ` frozenEligible=${canUseFrozenNavigation ? 1 : 0}`
      );
      if (event.dataTransfer?.dropEffect === 'none' && !canUseFrozenNavigation) {
        tabNativeDropCancelledRef.current = true;
      }
      // Native dragend can precede pragmatic-dnd monitor.onDrop. Keep the
      // painted preview alive long enough for onDrop to verify and commit it;
      // this timer remains only as the fallback cleanup for a cancelled drag.
      pendingDragEndCleanupRef.current = setTimeout(() => {
        pendingDragEndCleanupRef.current = null;
        clearCancelledDragPreview('dragend');
      }, 100);
    };
    const handleReleasedButtons = (event: MouseEvent) => {
      if ((event.buttons & 1) !== 0) return;
      if (!verticalDragGeometryRef.current && !dragPreviewRef.current) return;
      cancelPendingDragEndCleanup();
      // Chromium can omit both monitor.onDrop and native dragend when a tab is
      // released over the terminal beside the list. The first post-release
      // mouse event still carries buttons=0, which is the reliable cancel cue.
      pendingDragEndCleanupRef.current = setTimeout(() => {
        pendingDragEndCleanupRef.current = null;
        clearCancelledDragPreview('buttons-released');
      }, 100);
    };
    window.addEventListener('keydown', handleEscape, true);
    window.addEventListener('keydown', syncTabDndModifierMode, true);
    window.addEventListener('keyup', syncTabDndModifierMode, true);
    window.addEventListener('blur', handleWindowBlur, true);
    window.addEventListener('focus', handleWindowFocus, true);
    document.addEventListener('visibilitychange', handleVisibilityChange, true);
    window.addEventListener('dragend', handleNativeDragEnd, true);
    window.addEventListener('mouseup', handleReleasedButtons, true);
    window.addEventListener('mouseover', handleReleasedButtons, true);
    return () => {
      cancelPendingDragEndCleanup();
      window.removeEventListener('keydown', handleEscape, true);
      window.removeEventListener('keydown', syncTabDndModifierMode, true);
      window.removeEventListener('keyup', syncTabDndModifierMode, true);
      window.removeEventListener('blur', handleWindowBlur, true);
      window.removeEventListener('focus', handleWindowFocus, true);
      document.removeEventListener('visibilitychange', handleVisibilityChange, true);
      window.removeEventListener('dragend', handleNativeDragEnd, true);
      window.removeEventListener('mouseup', handleReleasedButtons, true);
      window.removeEventListener('mouseover', handleReleasedButtons, true);
      finalizeTabDndNavigation(false, 'monitor-unmount');
      cleanupMonitor();
    };
  }, [projectId, reorderInZone, applyTabLayout, captureVerticalDragGeometry, resolveStaticVerticalPreview, isVerticalLayout, isAdoptDropTarget, setVerticalDragPreview, scheduleVerticalPostDropReveal, toggleTabGroupCollapsed]);

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
    if (!contextMenu && !emptyContextMenu && !groupContextMenu && !commandHistoryPopover) return;
    const handleClose = (e: MouseEvent) => {
      // Don't close if clicking inside the context menu itself
      if ((e.target as HTMLElement).closest('[data-tab-context-menu]')) return;
      if ((e.target as HTMLElement).closest('[data-run-after-picker-menu]')) return;
      if ((e.target as HTMLElement).closest('[data-command-history-popover]')) return;
      setContextMenu(null);
      setEmptyContextMenu(null);
      setGroupContextMenu(null);
      setCommandHistoryPopover(null);
    };
    // Use mousedown instead of click — xterm.js canvas swallows click events
    document.addEventListener('mousedown', handleClose);
    return () => document.removeEventListener('mousedown', handleClose);
  }, [contextMenu, emptyContextMenu, groupContextMenu, commandHistoryPopover]);

  // Clamp context menu position to viewport. The rule itself lives in
  // menuViewportClamp.mjs — it used to be inlined here, and every menu written
  // afterwards (the pane's split-direction menu) was written without it and
  // opened outside the window.
  useLayoutEffect(() => {
    const activeMenu = contextMenu || groupContextMenu || emptyContextMenu;
    if (!activeMenu || !contextMenuRef.current) return;
    const rect = contextMenuRef.current.getBoundingClientRect();
    const { x, y } = clampMenuToViewport({
      x: activeMenu.x,
      y: activeMenu.y,
      width: rect.width,
      height: rect.height,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
    });
    if (x !== contextMenuPos.x || y !== contextMenuPos.y) {
      setContextMenuPos({ x, y });
    }
  }, [contextMenu, groupContextMenu, emptyContextMenu, contextScripts.length, contextShScripts.length, openProjects]);

  useLayoutEffect(() => {
    // The shared outline controller owns vertical FLIP. Keeping the legacy
    // measurements alive in parallel makes both animation systems retarget the
    // same rows and is the source of the old long-subtree jitter.
    if (isVerticalLayout) {
      verticalRowFlipRectsRef.current.clear();
      for (const animation of verticalRowAnimationsRef.current.values()) animation.cancel();
      verticalRowAnimationsRef.current.clear();
      return;
    }
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
    const suppressFlipForGroupCollapse = (!dragPreview || !!tabDndNavigationRef.current?.active)
      && now < groupCollapseFlipSuppressUntilRef.current;
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
  const mainTabsBase = visibleTabs;
  const tabGroups = workspace.tabGroups || [];
  // A drag preview is the live layout. Drop only persists this already-visible
  // projection; it does not introduce a second, line-only destination.
  const tabGroupsForDisplay = !isVerticalLayout || !dragPreview?.groupAnchorAssignments
    ? tabGroups
    : tabGroups.map(group => Object.prototype.hasOwnProperty.call(dragPreview.groupAnchorAssignments, group.id)
      ? { ...group, anchorTabId: dragPreview.groupAnchorAssignments?.[group.id] || undefined }
      : group);
  const buildPreviewTabs = (): TabData[] => {
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
  };
  const mainTabs = buildPreviewTabs();
  const projectedTabs = mainTabs;
  const mainTabsForDisplay = isVerticalLayout ? orderTabsWithVisualChildren(mainTabs) : mainTabs;
  const projectedTabsForDisplay = isVerticalLayout ? orderTabsWithVisualChildren(projectedTabs) : projectedTabs;
  const projectedTabById = new Map(projectedTabsForDisplay.map(tab => [tab.id, tab]));
  const visualDepthById = isVerticalLayout ? buildVisualDepthMap(mainTabsForDisplay) : new Map<string, number>();
  const projectedDepthById = isVerticalLayout ? buildVisualDepthMap(projectedTabsForDisplay) : visualDepthById;
  const visualTreeMetaById = (() => {
    const meta = new Map<string, { hasLaterSibling: boolean; continuationDepths: number[] }>();
    if (!isVerticalLayout) return meta;
    const rootFirstAncestors = new Map(mainTabsForDisplay.map(tab => [
      tab.id,
      visualHierarchyAncestorIds(mainTabsForDisplay, tab.id, { parentKey: 'visualParentTabId' }).reverse(),
    ]));
    const hasLaterSibling = (tab: TabData, index: number) => {
      if (!tab.visualParentTabId) return false;
      const depth = visualDepthById.get(tab.id) || 0;
      for (let cursor = index + 1; cursor < mainTabsForDisplay.length; cursor += 1) {
        const next = mainTabsForDisplay[cursor];
        const nextDepth = visualDepthById.get(next.id) || 0;
        if (nextDepth < depth) return false;
        if (nextDepth === depth) return next.visualParentTabId === tab.visualParentTabId;
      }
      return false;
    };
    const hasLaterSiblingForAncestor = (tab: TabData, index: number, lineDepth: number) => {
      const ancestors = rootFirstAncestors.get(tab.id) || [];
      const parentAtLine = ancestors[lineDepth - 1];
      const childAtLine = ancestors[lineDepth];
      if (!parentAtLine || !childAtLine) return false;
      for (let cursor = index + 1; cursor < mainTabsForDisplay.length; cursor += 1) {
        const next = mainTabsForDisplay[cursor];
        const nextDepth = visualDepthById.get(next.id) || 0;
        if (nextDepth < lineDepth) return false;
        if (nextDepth === lineDepth && next.visualParentTabId === parentAtLine && next.id !== childAtLine) return true;
      }
      return false;
    };
    mainTabsForDisplay.forEach((tab, index) => {
      const depth = visualDepthById.get(tab.id) || 0;
      const continuationDepths: number[] = [];
      for (let lineDepth = 1; lineDepth < depth; lineDepth += 1) {
        if (hasLaterSiblingForAncestor(tab, index, lineDepth)) continuationDepths.push(lineDepth);
      }
      meta.set(tab.id, { hasLaterSibling: hasLaterSibling(tab, index), continuationDepths });
    });
    return meta;
  })();
  const verticalRows = isVerticalLayout ? buildVerticalRows(mainTabsForDisplay, tabGroupsForDisplay) : [];
  const verticalDisplayRows = isVerticalLayout
    ? buildVerticalDisplayRows(mainTabsForDisplay, tabGroupsForDisplay)
    : [];
  useEffect(() => {
    if (!isVerticalLayout) return;
    const element = verticalMainListRef.current;
    if (!element) return;
    return dropTargetForElements({
      element,
      getData: () => ({ type: 'ZONE', zone: 'main' }),
      canDrop: ({ source }) => (
        (source.data.type === 'TAB' || source.data.type === 'TAB_GROUP')
        && source.data.projectId === projectId
        && source.data.zone === 'main'
      ),
    });
  }, [isVerticalLayout, mainTabsBase.length, projectId, tabGroups.length]);
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

  // Empty-space menu shortcut: create a tab that boots straight into the agent.
  // Same contract as every other fresh-launch entrypoint — the tab carries a
  // pendingAction and Terminal.tsx spawns the CLI once the shell prompt is
  // ready. We deliberately do NOT run the CLI from here: a second launch path
  // would race Terminal.tsx and start two processes in one PTY.
  //
  // `commandType` is intentionally NOT pre-set. setTabCommandType only renames
  // on the first run (`isFirstRun = !tab.commandType`), so pre-setting it would
  // leave the tab as `tab-N` instead of `claude-N`/`codex-N`. The launch path
  // sets type, name, AI-launch snapshot and auto-title eligibility in one place.
  // `color` is passed only for instant visual feedback — it does not set
  // colorSetManually, so the user can still recolor the tab as usual.
  // skipInitialRename keeps the tab out of inline-rename: an unchanged name
  // submitted on blur would count as manual ownership and block AI auto-title.
  const handleNewAgentTabAtEnd = (agent: 'claude' | 'codex') => {
    const cwd = resolveNewTabCwd();
    void createTab(projectId, undefined, cwd, {
      color: agent,
      pendingAction: { type: agent === 'codex' ? 'codex-new' : 'claude-new' },
      skipInitialRename: true,
    });
    setProjectView(projectId, 'terminal');
  };

  const contextMenuTabId = contextMenu?.tabId || null;
  const contextTabForMenu = contextMenuTabId ? workspace?.tabs.get(contextMenuTabId) : null;
  const isContextFileTab = contextTabForMenu?.tabType === 'file';
  const contextForkProvider = resolvePtyAgentOwner(contextTabForMenu || {});
  const contextForkSessionAvailable = contextForkProvider === 'claude'
    ? !!contextTabForMenu?.claudeSessionId
    : contextForkProvider === 'codex'
      ? !!contextTabForMenu?.codexSessionId
      : false;

  const resolveContextForkSessionId = async (
    tab: TabData,
    provider: 'claude' | 'codex',
    operation: string,
  ): Promise<string | null> => {
    if (provider === 'codex') {
      try {
        return await requireCodexSurfaceSessionId({
          tabId: tab.id,
          operation,
          requireMutationSafe: true,
        });
      } catch (error: any) {
        showToast(error?.message || 'Не удалось подтвердить Codex-сессию', 'warning');
        return null;
      }
    }
    if (!tab.claudeSessionId) return null;
    try {
      const materialization = await ipcRenderer.invoke('claude:session-materialization', {
        sessionId: tab.claudeSessionId,
        cwd: tab.cwd || workspace.projectPath || '',
      });
      if (materialization?.materialized !== true && materialization?.conversationMaterialized !== true) {
        showToast('У этой вкладки ещё нет сохранённой беседы Claude', 'warning');
        return null;
      }
    } catch (error: any) {
      showToast('Не удалось проверить историю Claude: ' + (error?.message || String(error)), 'warning');
      return null;
    }
    return tab.claudeSessionId;
  };

  const handleContextFork = async (fromLatestCompact: boolean) => {
    const menu = contextMenu;
    const tab = menu ? workspace.tabs.get(menu.tabId) : null;
    const provider = contextForkProvider;
    if (!menu || !tab || !provider || !contextForkSessionAvailable) return;
    setContextMenu(null);

    const sourceSessionId = await resolveContextForkSessionId(
      tab,
      provider,
      fromLatestCompact ? 'создать fork от последнего compact' : 'создать fork сессии',
    );
    if (!sourceSessionId) return;

    const cwd = tab.cwd || workspace.projectPath || '';
    let launchSessionId = sourceSessionId;
    if (fromLatestCompact) {
      const result = provider === 'claude'
        ? await ipcRenderer.invoke('claude:fork-session-file', {
          sourceSessionId,
          cwd,
          skipChainResolve: true,
          fromLatestCompact: true,
        })
        : await ipcRenderer.invoke('codex:fork-from-latest-compact', {
          sessionId: sourceSessionId,
          cwd,
        });
      if (!result?.success || !result?.newSessionId) {
        const noCompact = result?.reason === 'no-compact';
        const message = noCompact
          ? (result?.error || `В этой ${provider === 'claude' ? 'Claude' : 'Codex'}-сессии ещё нет сжатия контекста`)
          : 'Compact fork не создан: ' + (result?.error || 'неизвестная ошибка');
        console.warn(
          '[CompactFork] rejected' +
          ' tab=' + String(tab.id).slice(-12) +
          ' provider=' + provider +
          ' reason=' + String(result?.reason || 'error')
        );
        showToast(
          message,
          noCompact ? 'info' : 'error',
          noCompact ? 6000 : 4500,
        );
        return;
      }
      launchSessionId = result.newSessionId;
    }

    const suffix = fromLatestCompact ? '_compact' : '_fork';
    const forkName = tab.name ? `${tab.name}${suffix}` : undefined;
    try {
      const newTabId = await useWorkspaceStore.getState().createTabAfterCurrent(projectId, forkName, cwd, {
        pendingAction: fromLatestCompact
          ? {
            type: provider === 'claude' ? 'claude-compact-fork' : 'codex-compact-fork',
            sessionId: launchSessionId,
            sourceSessionId,
          }
          : {
            type: provider === 'claude' ? 'claude-fork' : 'codex-fork',
            sessionId: launchSessionId,
          },
        // Compact fork is materialized by the app before this tab exists, so
        // its exact history identity is already proven for reads. Keep the
        // runtime writer proof separate: the pending resume still has to earn
        // live ownership before new output is attributed to this tab.
        claudeSessionId: fromLatestCompact && provider === 'claude' ? launchSessionId : undefined,
        codexSessionId: fromLatestCompact && provider === 'codex' ? launchSessionId : undefined,
        nameSetManually: false,
        afterTabId: tab.id,
        visualParentTabId: tab.id,
        // Creation only inserts the tab. Visibility/focus must go through the
        // same activation choke point as an ordinary click; otherwise a split
        // keeps showing the old slot even though workspace.activeTabId already
        // points at the fork.
        background: true,
      });
      if (!newTabId) throw new Error('fork tab was not created');
      const state = useWorkspaceStore.getState();
      const sourcePaneIndex = paneIndexHoldingTab(state.splitPanes, tab.id);
      if (sourcePaneIndex >= 0 && sourcePaneIndex !== state.splitFocusedIndex) {
        state.focusSplitPane(sourcePaneIndex);
      }
      state.activateCenterTab(projectId, newTabId);
      showToast(
        fromLatestCompact
          ? `Fork ${provider === 'claude' ? 'Claude' : 'Codex'} от последнего compact создан`
          : `Fork ${provider === 'claude' ? 'Claude' : 'Codex'} создан`,
        'success',
      );
    } catch (error: any) {
      showToast('Не удалось открыть вкладку fork: ' + (error?.message || String(error)), 'error');
    }
  };

  // Fork the current Claude session into an SDK tab. Unlike the PTY forks
  // above, the copy of the conversation file must exist BEFORE the tab does:
  // an SDK tab has no launch command to hand a session id to, so the new id is
  // written straight onto the created tab. Claude only — SDK does not run
  // Codex. Moved verbatim from the bottom control bar, which no longer carries
  // session actions.
  const handleContextForkToSDK = async () => {
    const menu = contextMenu;
    const tab = menu ? workspace.tabs.get(menu.tabId) : null;
    if (!menu || !tab || contextForkProvider !== 'claude' || !contextForkSessionAvailable) return;
    setContextMenu(null);

    const sourceSessionId = await resolveContextForkSessionId(
      tab,
      'claude',
      'создать fork сессии в SDK-вкладке',
    );
    if (!sourceSessionId) return;

    const cwd = tab.cwd || workspace.projectPath || '';
    try {
      const forkResult = await ipcRenderer.invoke('claude:fork-session-file', {
        sourceSessionId,
        cwd,
        skipChainResolve: true,
      });
      if (!forkResult?.success || !forkResult?.newSessionId) {
        showToast('SDK fork не создан: ' + (forkResult?.error || 'неизвестная ошибка'), 'error');
        return;
      }
      const forkName = tab.name ? `${tab.name}_fork` : undefined;
      const sdkTabId = await useWorkspaceStore.getState().createSDKTab(projectId, forkName, {
        afterTabId: tab.id,
        visualParentTabId: tab.id,
      });
      useWorkspaceStore.getState().updateSDKState(sdkTabId, {
        claudeSessionId: forkResult.newSessionId,
      });
      showToast(`SDK fork → ${forkName || 'новая вкладка'}`, 'success');
    } catch (error: any) {
      showToast('Не удалось открыть SDK-вкладку fork: ' + (error?.message || String(error)), 'error');
    }
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
    // A real right click in THIS list: the list hosts its own rename input.
    // (The external opener sets this again right after calling us — see the
    // TAB_CONTEXT_MENU_EVENT listener.)
    renameHostRef.current = null;
    setGroupContextMenu(null);
    setEmptyContextMenu(null);
    setCommandHistoryPopover(null);
    setContextMenuPos({ x: e.clientX, y: e.clientY });
    setContextMenu({ x: e.clientX, y: e.clientY, tabId });
    setContextLastCommand(null);
    void loadCommandRunHistory(tabId);

    const targetTab = workspace.tabs.get(tabId);
    if (targetTab?.tabType === 'file') {
      setContextScripts([]);
      setContextShScripts([]);
      setContextLastCommand(null);
      setContextFavoriteId(null);
      return;
    }

    // Load scripts for this tab's CWD (npm + sh)
    (async () => {
      try {
        const cwd = await ipcRenderer.invoke('terminal:getCwd', tabId);
        const tabCwd = cwd || workspace.tabs.get(tabId)?.cwd || '';
        if (!tabCwd) { setContextScripts([]); setContextShScripts([]); return; }

        const owner = resolveTabProjectContext(tabId);
        ipcRenderer.invoke('terminal:get-last-project-command', { projectId: owner.projectId, tabId, cwd: tabCwd })
          .then((result: any) => {
            const command = String(result?.command || '').trim();
            const hasCommand = !!(result?.success && command);
            setContextLastCommand(hasCommand ? { tabId, command } : null);
            setRestartAfterFallbackCommands((previous) => {
              const next = new Map(previous);
              if (hasCommand) {
                if (next.get(tabId) === command) return previous;
                next.set(tabId, command);
                return next;
              }
              if (!next.has(tabId)) return previous;
              next.delete(tabId);
              return next;
            });
          })
          .catch(() => {
            setContextLastCommand(null);
            setRestartAfterFallbackCommands((previous) => {
              if (!previous.has(tabId)) return previous;
              const next = new Map(previous);
              next.delete(tabId);
              return next;
            });
          });

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

  // External opener (split-pane header). Reuses handleContextMenu so the menu
  // that appears is byte-for-byte the sidebar's menu: same items, same async
  // enrichment (scripts, favourites, run history), same close rules. The
  // synthetic event only carries what the handler reads — coordinates and the
  // two no-ops it calls on a real event.
  useEffect(() => {
    const onOpenRequest = (event: Event) => {
      const detail = (event as CustomEvent).detail as
        { projectId?: string; tabId?: string; x?: number; y?: number; renameHost?: string } | undefined;
      if (!detail?.tabId || detail.projectId !== projectId) return;
      if (!workspace.tabs.has(detail.tabId)) return;
      handleContextMenu(
        {
          preventDefault: () => {},
          stopPropagation: () => {},
          clientX: Number(detail.x) || 0,
          clientY: Number(detail.y) || 0,
        } as unknown as React.MouseEvent,
        detail.tabId,
      );
      // AFTER the handler, which clears this for its own right clicks: who
      // opened the menu, and can they host the rename input themselves.
      // Remembered for exactly as long as the menu lives.
      renameHostRef.current = detail.renameHost || null;
    };
    window.addEventListener(TAB_CONTEXT_MENU_EVENT, onOpenRequest);
    return () => window.removeEventListener(TAB_CONTEXT_MENU_EVENT, onOpenRequest);
  });

  const handleCommandHistoryOpen = useCallback((e: React.MouseEvent, tabId: string) => {
    e.preventDefault();
    e.stopPropagation();
    void loadCommandRunHistory(tabId);
    const width = 280;
    const height = 260;
    const x = Math.min(Math.max(8, e.clientX + 8), Math.max(8, window.innerWidth - width - 8));
    const y = Math.min(Math.max(8, e.clientY + 8), Math.max(8, window.innerHeight - height - 8));
    setCommandHistoryPopover({ tabId, x, y });
  }, [loadCommandRunHistory]);

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

  const isDevRestartCommand = (command: string): boolean => {
    const text = command.trim();
    const npmMatch = text.match(/\bnpm\s+run\s+([^\s;&|]+)/i);
    if (npmMatch) return /^(dev|start|serve|watch)/i.test(npmMatch[1]);
    const shMatch = text.match(/(?:^|\s)\.\/([^/\s;&|]+)$/);
    if (shMatch) return /^(dev|start|serve|watch)/i.test(shMatch[1]);
    return false;
  };

  const normalizeShellPromptCommand = (line: string): string => {
    let text = String(line || '').replace(/^\x15+/, '').trim();
    const promptMatch = text.match(/^[^"'`]*@[^"'`]*(?:\s[%$#]|[❯➜])\s+(.+)$/);
    if (promptMatch) text = promptMatch[1].trim();
    text = text.replace(/^lsof\s+-ti:[^;]+;\s*/i, '').trim();
    if (!text || text === '!!') return '';
    if (/^\[[0-?]*[ -/]*[@-~]$/.test(text)) return '';
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text)) return '';
    if (text.includes('\x1b[200~') || text.includes('\x1b[201~')) return '';
    return text;
  };

  const getLogicalTerminalLine = (buf: any, row: number): string => {
    if (!buf || row < 0 || row >= buf.length) return '';
    let start = row;
    while (start > 0 && buf.getLine(start)?.isWrapped) start -= 1;
    const parts: string[] = [];
    for (let i = start; i < buf.length; i++) {
      const line = buf.getLine(i);
      if (!line) break;
      parts.push(String(line.translateToString?.(true) || ''));
      const next = i + 1 < buf.length ? buf.getLine(i + 1) : null;
      if (!next?.isWrapped) break;
    }
    return parts.join('').replace(/\u00a0/g, ' ').trimEnd();
  };

  const findLastShellPromptCommandInBuffer = (tabId: string): string => {
    const term = terminalRegistry.get(tabId);
    const buf = term?.buffer?.active;
    if (!buf) return '';
    const seenStarts = new Set<number>();
    const start = Math.max(0, buf.length - 1500);
    for (let row = buf.length - 1; row >= start; row -= 1) {
      let logicalStart = row;
      while (logicalStart > 0 && buf.getLine(logicalStart)?.isWrapped) logicalStart -= 1;
      if (seenStarts.has(logicalStart)) continue;
      seenStarts.add(logicalStart);
      const line = getLogicalTerminalLine(buf, logicalStart);
      if (!line) continue;
      if (!/^[^"'`]*@[^"'`]*(?:\s[%$#]|[❯➜])\s+/.test(line.trim())) continue;
      const command = normalizeShellPromptCommand(line);
      if (command) return command;
    }
    return '';
  };

  const resolveRestartAfterFallbackCommand = async (tabId: string): Promise<{ command: string; reason: string; cwd?: string | null; projectId?: string | null; sourceTabId?: string | null; rejectedCommand?: string }> => {
    const owner = resolveTabProjectContext(tabId);
    const tab = owner.tab;
    const liveCwd = await ipcRenderer.invoke('terminal:getCwd', tabId).catch(() => null);
    const cwd = liveCwd || tab?.cwd || null;
    if (!cwd) return { command: '', reason: 'no-cwd', cwd: null, projectId: owner.projectId };

    const result = await ipcRenderer.invoke('terminal:get-last-project-command', { projectId: owner.projectId, tabId, cwd });
    const command = String(result?.command || '').trim();
    if (!result?.success || !command) return { command: '', reason: 'no-last-command', cwd, projectId: owner.projectId };
    if (isAiLaunchCommand(command)) {
      return { command: '', reason: 'last-command-ai', cwd, projectId: result?.projectId || owner.projectId, sourceTabId: result?.tabId || null, rejectedCommand: command };
    }
    return { command, reason: 'last-cwd-command', cwd: result?.cwd || cwd, projectId: result?.projectId || owner.projectId, sourceTabId: result?.tabId || null };
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
  async function runDeterministicStop(
    tabId: string,
    restart: boolean,
    commandMeta?: { source: 'restart-after'; command?: string }
  ): Promise<boolean> {
    if (restartInFlightRef.current.has(tabId)) return false;
    const refNext = new Set(restartInFlightRef.current);
    refNext.add(tabId);
    restartInFlightRef.current = refNext;
    setRestartInFlight(new Set(refNext));
    try {
      const res = await ipcRenderer.invoke('terminal:deterministic-stop', { tabId, restart, commandMeta });
      if (!res?.success) {
        console.warn('[TabBar] deterministic-stop residual', res);
      }
      return true;
    } catch (e) {
      console.error('[TabBar] deterministic-stop failed', e);
      return false;
    } finally {
      // Listener on terminal:stop-progress { phase: 'done' } clears the flag,
      // but clear here too as a safety net for early errors that never emit.
      const doneNext = new Set(restartInFlightRef.current);
      doneNext.delete(tabId);
      restartInFlightRef.current = doneNext;
      setRestartInFlight(new Set(doneNext));
    }
  }

  const runRestartAfterAction = async (
    tabId: string,
    command?: string,
    options?: { coalesceFiniteScript?: boolean }
  ) => {
    let cleanCommand = command?.trim() || '';
    if (!cleanCommand) {
      const resolved = await resolveRestartAfterFallbackCommand(tabId);
      if (!resolved.command) {
        console.warn(
          '[TabBar:RestartAfter] skip-empty-command target=' + tabId.slice(-8)
          + ' reason=' + resolved.reason
          + ' project=' + (resolved.projectId || projectId || '-')
          + ' cwd=' + JSON.stringify(resolved.cwd || '')
          + (resolved.sourceTabId ? ' sourceTab=' + resolved.sourceTabId.slice(-8) : '')
          + (resolved.rejectedCommand ? ' rejected=' + JSON.stringify(resolved.rejectedCommand) : '')
        );
        return;
      }
      cleanCommand = resolved.command;
      setRestartAfterFallbackCommands((previous) => {
        if (previous.get(tabId) === cleanCommand) return previous;
        const next = new Map(previous);
        next.set(tabId, cleanCommand);
        return next;
      });
      console.warn(
        '[TabBar:RestartAfter] resolved-last-command target=' + tabId.slice(-8)
        + ' project=' + (resolved.projectId || projectId || '-')
        + ' cwd=' + JSON.stringify(resolved.cwd || '')
        + (resolved.sourceTabId ? ' sourceTab=' + resolved.sourceTabId.slice(-8) : '')
        + ' command=' + JSON.stringify(cleanCommand)
      );
    }
    const coalesceFiniteScript = !!options?.coalesceFiniteScript && !isDevRestartCommand(cleanCommand);
    if (coalesceFiniteScript) {
      const existing = restartAfterScriptRunsRef.current.get(tabId);
      if (existing) {
        existing.pendingCommand = cleanCommand;
        console.warn('[TabBar:RestartAfter] queued-pending target=' + tabId.slice(-8) + ' command=' + JSON.stringify(cleanCommand) + ' running=' + existing.running);
        return;
      }
      restartAfterScriptRunsRef.current.set(tabId, {
        command: cleanCommand,
        running: false,
        pendingCommand: null,
      });
    } else {
      restartAfterScriptRunsRef.current.delete(tabId);
    }
    const stopAccepted = await runDeterministicStop(tabId, false);
    if (!stopAccepted) {
      if (coalesceFiniteScript) {
        const existing = restartAfterScriptRunsRef.current.get(tabId);
        if (existing?.command === cleanCommand && !existing.running) {
          restartAfterScriptRunsRef.current.delete(tabId);
        }
      }
      return;
    }
    const killPrefix = await buildKillPortsPrefix(tabId);
    ipcRenderer.send('terminal:input', tabId, `${killPrefix}${cleanCommand}\r`, {
      source: 'restart-after',
      command: cleanCommand,
    });
    if (coalesceFiniteScript) {
      const existing = restartAfterScriptRunsRef.current.get(tabId);
      if (existing?.command === cleanCommand) {
        existing.running = true;
      }
    }
    if (isDevRestartCommand(cleanCommand)) {
      useWorkspaceStore.getState().setTabCommandType(tabId, 'devServer');
    }
  };

  const handleRestart = async (tabId: string) => {
    const tab = resolveTabProjectContext(tabId).tab;
    if (tab?.restartAfterCommand || getRestartAfterTriggerIds(tab).length > 0) {
      await runRestartAfterAction(tabId, tab.restartAfterCommand);
      return;
    }
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

  const handleRunLastProjectCommand = async (tabId: string) => {
    try {
      const owner = resolveTabProjectContext(tabId);
      const tab = owner.tab;
      const liveCwd = await ipcRenderer.invoke('terminal:getCwd', tabId).catch(() => null);
      const result = await ipcRenderer.invoke('terminal:get-last-project-command', {
        projectId: owner.projectId,
        tabId,
        cwd: liveCwd || tab?.cwd || null,
      });
      let command = String(result?.command || '').trim();
      if (!result?.success || !command) {
        command = findLastShellPromptCommandInBuffer(tabId);
        if (command) {
          ipcRenderer.send('terminal:remember-detected-command', { tabId, command });
        } else {
          useUIStore.getState().showToast?.('No previous command in this directory', 'info');
          return;
        }
      }
      setRestartAfterFallbackCommands((previous) => {
        if (previous.get(tabId) === command) return previous;
        const next = new Map(previous);
        next.set(tabId, command);
        return next;
      });
      const killPrefix = await buildKillPortsPrefix(tabId);
      ipcRenderer.send('terminal:input', tabId, `${killPrefix}${command}\r`);
      if (isDevRestartCommand(command)) {
        useWorkspaceStore.getState().setTabCommandType(tabId, 'devServer');
      }
    } catch (e: any) {
      console.error('[TabBar] run-last-project-command failed', e);
      useUIStore.getState().showToast?.(`Run last command failed: ${e?.message || e}`, 'error');
    }
  };

  // After rename closes via an EXPLICIT keyboard action (Enter/Escape), hand
  // focus back to the active terminal so the user can type immediately — the
  // terminal's own auto-focus was suppressed while the rename input was up
  // (isExternalEditableFocused). NOT called on blur: a blur means the user
  // clicked some other target (Timeline, plan, another tab) and we must not
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

  const startTabRename = (tab: TabData) => {
    setEditingGroupId(null);
    setGroupEditValue('');
    setEditingTabId(tab.id);
    setEditValue(tab.name);
    setEditOriginalValue(tab.name);
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
      const host = renameHostRef.current;
      const tab = workspace.tabs.get(contextMenu.tabId);
      if (host) {
        // The menu was opened from another surface — rename THERE, where the
        // user's cursor and attention already are. This list must not open its
        // own input: two inputs for one tab, and the visible one would be the
        // wrong one (that was the bug).
        window.dispatchEvent(new CustomEvent(TAB_RENAME_REQUEST_EVENT, {
          detail: { host, projectId, tabId: contextMenu.tabId },
        }));
      } else if (tab) {
        startTabRename(tab);
      }
    }
    renameHostRef.current = null;
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
      .filter(tab => !tab.parentTabId && tab.groupId === groupId)
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

  // Track if dragging is in progress
  const [isDraggingTab, setIsDraggingTab] = useState(false);
  const [draggingGroupIds, setDraggingGroupIds] = useState<string[]>([]);
  const [draggingRootIds, setDraggingRootIds] = useState<string[]>([]);
  const [draggingSourceGroupId, setDraggingSourceGroupId] = useState<string | null>(null);
  const tabbarVisualLockActive = isDraggingTab;
  const dropCooldownRef = useRef(false);

  useEffect(() => {
    const forceRelease = () => {
      setIsDraggingTab(false);
      setDraggingGroupIds([]);
      setDraggingRootIds([]);
      setDraggingSourceGroupId(null);
    };
    window.addEventListener(TABBAR_FORCE_RELEASE_EVENT, forceRelease);
    return () => window.removeEventListener(TABBAR_FORCE_RELEASE_EVENT, forceRelease);
  }, []);

  // Mirror drag lifecycle into the row visuals and selection preview.
  useEffect(() => {
    return monitorForElements({
      canMonitor: ({ source }) => source.data.type === 'TAB' || source.data.type === 'TAB_GROUP',
      onDragStart: ({ source }) => {
        setIsDraggingTab(true);
        const data = source.data as DragData;
        if (data.type === 'TAB') {
          const currentWorkspace = useWorkspaceStore.getState().openProjects.get(projectId);
          const tabs = currentWorkspace
            ? orderTabsWithVisualChildren(
                Array.from(currentWorkspace.tabs.values()).filter(tab => !tab.parentTabId)
              )
            : [];
          const items = tabs.map((tab, position) => ({
            id: tab.id,
            parentId: tab.visualParentTabId || null,
            containerId: tab.groupId || null,
            position,
          }));
          const selectedIds = data.selectedTabIds?.includes(data.id) ? data.selectedTabIds : [data.id];
          const selectedRoots = normalizeSelectedVisualRootIds(items, selectedIds, { parentKey: 'parentId' });
          const byId = new Map(items.map(item => [item.id, item]));
          const roots = Array.from(new Set(selectedRoots.map(rootId => {
            let topLevelId = rootId;
            const trail = new Set<string>();
            while (!trail.has(topLevelId)) {
              trail.add(topLevelId);
              const parentId = byId.get(topLevelId)?.parentId;
              if (!parentId || !byId.has(parentId)) break;
              topLevelId = parentId;
            }
            return topLevelId;
          })));
          const sourceIds = roots.flatMap(rootId => (
            visualHierarchySubtreeItems(items, rootId, { parentKey: 'parentId' }).map(item => item.id)
          ));
          setDraggingRootIds(roots);
          setDraggingGroupIds(Array.from(new Set(sourceIds)));
          setDraggingSourceGroupId(null);
        } else {
          const currentWorkspace = useWorkspaceStore.getState().openProjects.get(projectId);
          const groupIds = currentWorkspace
            ? orderTabsWithVisualChildren(
                Array.from(currentWorkspace.tabs.values()).filter(tab => !tab.parentTabId)
              ).filter(tab => tab.groupId === data.groupId).map(tab => tab.id)
            : [];
          setDraggingRootIds([]);
          setDraggingGroupIds(groupIds);
          setDraggingSourceGroupId(data.groupId);
        }
      },
      onDrop: () => {
        setIsDraggingTab(false);
        setDraggingGroupIds([]);
        setDraggingRootIds([]);
        setDraggingSourceGroupId(null);
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
      },
    });
  }, [projectId]);

  // Clear tab selection on click outside TabBar
  useEffect(() => {
    if (selectedTabIds.length <= 1) return;

    const handleMouseDown = (e: MouseEvent) => {
      if (isDraggingTab) return;
      if (dropCooldownRef.current) return;
      const tabBarEl = scrollContainerRef.current?.parentElement;
      if (tabBarEl && tabBarEl.contains(e.target as Node)) return;
      if ((e.target as HTMLElement).closest('[data-tab-context-menu]')) return;
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

  // The host model contains more data than DnD needs (process state, title,
  // active status). Only structural fields participate in the controlled
  // outline identity, otherwise an unrelated status update looks like an
  // external tree replacement in the middle of a gesture.
  // Multi-select keeps the existing atomic host resolver for now. Its preview
  // is still rendered through the same outline rows, so switching modes does
  // not reintroduce the old nested group DOM or duplicate connector model.
  const tabOutlineHostTabs = isMultiSelect ? mainTabsForDisplay : mainTabsBase;
  const tabOutlineHostGroups = isMultiSelect ? tabGroupsForDisplay : tabGroups;
  const tabOutlineSignature = JSON.stringify({
    tabs: tabOutlineHostTabs
      .filter((tab) => !tab.parentTabId)
      .map((tab) => [tab.id, tab.groupId || null, tab.visualParentTabId || null]),
    groups: tabOutlineHostGroups.map((group) => [group.id, !!group.collapsed, group.anchorTabId || null]),
  });
  const controlledTabOutline = useMemo<TabOutlineNode[]>(
    () => buildTabOutline(tabOutlineHostTabs, tabOutlineHostGroups) as TabOutlineNode[],
    [tabOutlineSignature]
  );
  const expectedTabOutlineIds = useMemo(
    () => new Set(
      mainTabsBase
        .filter((tab) => !tab.parentTabId)
        .map((tab) => tab.id)
    ),
    [tabOutlineSignature]
  );

  const handleTabOutlineExpansion = useCallback(({ nodeId, expanded }: { nodeId: string | number; expanded: boolean }) => {
    const currentWorkspace = useWorkspaceStore.getState().openProjects.get(projectId);
    const group = currentWorkspace?.tabGroups?.find(
      (candidate) => tabOutlineGroupId(candidate.id) === String(nodeId)
    );
    if (!group) return false;
    const shouldBeCollapsed = !expanded;
    if (!!group.collapsed === shouldBeCollapsed) return true;
    toggleTabGroupCollapsed(projectId, group.id);
    return true;
  }, [projectId, toggleTabGroupCollapsed]);

  const handleTabOutlineCommit = useCallback(({ previewOutline }: { previewOutline: TabOutlineNode[] }) => {
    const layoutResult = tabOutlineToLayout(previewOutline);
    if (!layoutResult.ok) {
      console.warn(`[StructuredTabDnd:commit-rejected] project=${shortDndId(projectId)} reason=${layoutResult.reason}`);
      return false;
    }
    if (
      layoutResult.orderedIds.length !== expectedTabOutlineIds.size
      || layoutResult.orderedIds.some((id: string) => !expectedTabOutlineIds.has(id))
    ) {
      console.warn(
        `[StructuredTabDnd:commit-rejected] project=${shortDndId(projectId)}` +
        ` reason=tab-set-mismatch expected=${expectedTabOutlineIds.size}` +
        ` actual=${layoutResult.orderedIds.length}`
      );
      return false;
    }
    applyTabLayout(
      projectId,
      layoutResult.orderedIds,
      layoutResult.groupAssignments,
      layoutResult.visualParentAssignments,
      layoutResult.groupAnchorAssignments
    );
    return true;
  }, [applyTabLayout, expectedTabOutlineIds, projectId]);

  const resolveTabOutlineExternalTarget = useCallback(({
    clientX,
    clientY,
  }: {
    clientX: number;
    clientY: number;
  }) => {
    if (typeof document === 'undefined') return null;
    const pointed = document.elementFromPoint(clientX, clientY) as HTMLElement | null;
    const projectTarget = pointed?.closest<HTMLElement>('[data-structured-project-drop-target]');
    const targetProjectId = projectTarget?.dataset.projectId;
    if (targetProjectId && openProjects.has(targetProjectId)) {
      return {
        id: `project:${targetProjectId}`,
        zone: 'project',
        projectId: targetProjectId,
        blocked: targetProjectId === projectId,
      } satisfies TabProjectExternalTarget;
    }

    return null;
  }, [openProjects, projectId]);

  const handleTabOutlineExternalCommit = useCallback(async ({
    sourceNode,
    externalTarget,
  }: {
    sourceNode: TabOutlineNode;
    externalTarget: {
      zone?: string;
      insertIndex?: number;
      projectId?: string;
      blocked?: boolean;
    } | null;
  }) => {
    if (externalTarget?.zone !== 'project') return false;
    const targetProjectId = externalTarget.projectId;
    if (!targetProjectId || externalTarget.blocked || targetProjectId === projectId) return false;

    let moved = false;
    if (sourceNode?.entityType === 'group' && sourceNode.groupId) {
      moved = await moveTabGroupToProject(projectId, sourceNode.groupId, targetProjectId);
    } else if (sourceNode?.entityType === 'tab' && sourceNode.tabId) {
      const sourceTabIds: string[] = [];
      const collect = (node: TabOutlineNode) => {
        if (node.entityType === 'tab' && node.tabId) sourceTabIds.push(node.tabId);
        (node.children || []).forEach((child) => collect(child as TabOutlineNode));
      };
      collect(sourceNode);
      moved = await moveTabsToProject(projectId, sourceTabIds, targetProjectId);
    }

    if (moved) {
      window.setTimeout(() => followMovedTabs(targetProjectId), 0);
    }
    return moved;
  }, [moveTabGroupToProject, moveTabsToProject, projectId]);

  const handleContextTabProjectMove = useCallback(async (tabId: string, targetProjectId: string) => {
    setContextMenu(null);
    if (!targetProjectId || targetProjectId === projectId) return;

    const currentWorkspace = useWorkspaceStore.getState().openProjects.get(projectId);
    if (!currentWorkspace || !currentWorkspace.tabs.has(tabId)) {
      showToast('Tab is no longer available', 'error');
      return;
    }
    const currentOutline = buildTabOutline(
      Array.from(currentWorkspace.tabs.values()),
      currentWorkspace.tabGroups || [],
    );
    const sourceTabIds = tabOutlineSubtreeTabIds(currentOutline, tabId);
    if (sourceTabIds.length === 0) {
      showToast('Could not resolve tab hierarchy', 'error');
      return;
    }

    const moved = await moveTabsToProject(projectId, sourceTabIds, targetProjectId);
    if (!moved) {
      showToast('Could not move tab to project', 'error');
      return;
    }
    window.setTimeout(() => followMovedTabs(targetProjectId), 0);
  }, [moveTabsToProject, projectId, showToast]);

  const tabOutlineDnd = useOutlineDnd<TabOutlineNode>({
    outline: controlledTabOutline,
    disabled: !isVerticalLayout || isMultiSelect || editingTabId !== null || editingGroupId !== null,
    onCommit: handleTabOutlineCommit,
    onExternalCommit: handleTabOutlineExternalCommit,
    onExpansionRequest: handleTabOutlineExpansion,
    onToggle: handleTabOutlineExpansion,
    canHorizontalMove: tabOutlineHorizontalPolicy,
    canUseVerticalSlot: tabOutlineVerticalSlotPolicy,
    resolveExternalTarget: resolveTabOutlineExternalTarget,
    outsidePointerPolicy: 'horizontal-corridor',
    folderDwellInterval: TAB_DND_NAVIGATION_DWELL_MS,
    layoutAnimation: {
      duration: 120,
      easing: 'cubic-bezier(0.2, 0, 0, 1)',
      respectReducedMotion: false,
      maxAnimatedRows: 14,
      minRetargetInterval: 72,
      animateDuringScroll: false,
    },
    onLog: (event) => {
      if (event.type === 'pending' || event.type === 'click-release') return;
      let detail = '{}';
      try {
        detail = JSON.stringify(event.detail);
      } catch {
        detail = '{"serialization":"failed"}';
      }
      console.log(
        `[StructuredTabDnd:${event.type}] project=${shortDndId(projectId)}` +
        ` source=${shortDndId(String(event.sourceId || ''))}` +
        ` detail=${detail}`
      );
    },
  });

  const structuredProjectTarget = tabOutlineDnd.dragState?.externalTarget as TabProjectExternalTarget | null | undefined;
  const structuredProjectTargetId = structuredProjectTarget?.zone === 'project'
    ? structuredProjectTarget.projectId
    : null;
  const structuredProjectTargetBlocked = structuredProjectTarget?.zone === 'project'
    ? structuredProjectTarget.blocked
    : false;

  useEffect(() => {
    window.dispatchEvent(new CustomEvent(STRUCTURED_PROJECT_DROP_EVENT, {
      detail: structuredProjectTargetId
        ? {
          sourceProjectId: projectId,
          projectId: structuredProjectTargetId,
          state: structuredProjectTargetBlocked ? 'blocked' : 'allowed',
        }
        : null,
    }));
  }, [projectId, structuredProjectTargetBlocked, structuredProjectTargetId]);

  useEffect(() => () => {
    window.dispatchEvent(new CustomEvent(STRUCTURED_PROJECT_DROP_EVENT, { detail: null }));
  }, []);

  const tabOutlineNodeById = useMemo(
    () => indexTabOutlineNodes(tabOutlineDnd.previewOutline),
    [tabOutlineDnd.previewOutline]
  );
  const liveMainTabById = new Map(mainTabsBase.map((tab) => [tab.id, tab]));
  const liveTabGroupById = new Map(tabGroups.map((group) => [group.id, group]));
  const sharedOutlineDragActive = tabOutlineDnd.dragState?.phase === 'dragging'
    || tabOutlineDnd.dragState?.phase === 'committing';
  const sharedOutlineSourceNode = tabOutlineDnd.dragState
    ? tabOutlineNodeById.get(String(tabOutlineDnd.dragState.sourceId))
    : undefined;
  const sharedOutlineSourceIdSet = new Set(
    (tabOutlineDnd.dragState?.sourceIds || []).map((id) => String(id))
  );
  const sharedOutlineSourceTabIds = (tabOutlineDnd.dragState?.sourceIds || [])
    .map((id) => tabOutlineNodeById.get(String(id)))
    .filter((node): node is TabOutlineNode => node?.entityType === 'tab' && !!node.tabId)
    .map((node) => node.tabId as string);
  const sharedOutlineRootTabIds = sharedOutlineSourceNode?.entityType === 'tab' && sharedOutlineSourceNode.tabId
    ? [sharedOutlineSourceNode.tabId]
    : [];
  const sharedOutlineSourceGroupId = sharedOutlineSourceNode?.entityType === 'group'
    ? sharedOutlineSourceNode.groupId || null
    : null;
  const sharedTabbarVisualLockActive = tabbarVisualLockActive || sharedOutlineDragActive;

  useEffect(() => {
    if (!sharedOutlineDragActive) return;
    acquireForcedDragCursor();
    return () => releaseForcedDragCursor();
  }, [sharedOutlineDragActive]);

  const setVerticalScrollContainerRef = useCallback((element: HTMLDivElement | null) => {
    scrollContainerRef.current = element;
    tabOutlineDnd.scrollerRef.current = element;
  }, [tabOutlineDnd.scrollerRef]);

  // Tab list scroll persistence (same contract as the file sidebar: per-project
  // value in SQLite, throttled writes, restored on mount and on project switch).
  // The sidebar column is NOT remounted when the user switches projects — the
  // same DOM scroller is reused — so restore is keyed on projectId, not on mount.
  const tabListScrollProjectRef = useRef<string | null>(null);
  // Offset still waiting to be applied for the current project. null = nothing
  // pending.
  const tabListPendingRestoreRef = useRef<number | null>(null);
  // Only a scroll the user performed themselves is worth persisting. Mounting a
  // project emits its own scroll events (rows render, content grows, the browser
  // nudges scrollTop by a pixel or two); persisting those made the saved offset
  // creep a little further on every project switch.
  const tabListUserScrolledRef = useRef(false);
  const setTabListScrollTop = useWorkspaceStore((state) => state.setTabListScrollTop);
  const getTabListScrollTop = useWorkspaceStore((state) => state.getTabListScrollTop);
  const tabListHasRows = mainTabs.length > 0 || tabGroups.length > 0;

  // Arm restore whenever the visible project changes. The sidebar column is not
  // remounted on project switch — the same scroller is reused — so this cannot
  // rely on mount. Declared before the apply effect so it runs first.
  useLayoutEffect(() => {
    if (tabListScrollProjectRef.current === projectId) return;
    tabListScrollProjectRef.current = projectId;
    tabListUserScrolledRef.current = false;
    const saved = getTabListScrollTop(projectId);
    tabListPendingRestoreRef.current = saved > 0 ? saved : null;
  }, [projectId, getTabListScrollTop]);

  // Applying the offset is not a single-shot operation: when a project opens,
  // React has the rows but the list has no height yet (scrollHeight ===
  // clientHeight), so any assignment is clamped straight back to 0. Retry on
  // every render AND on content resize — ResizeObserver is the event-driven
  // signal for "layout actually changed", so no polling or timeout is involved.
  useLayoutEffect(() => {
    if (!isVerticalLayout) return;
    const element = scrollContainerRef.current;
    if (!element) return;

    const applyPendingRestore = () => {
      const target = tabListPendingRestoreRef.current;
      if (target === null) return;
      const maxScroll = element.scrollHeight - element.clientHeight;
      if (maxScroll <= 0) return; // Rows not laid out yet — try again on resize.
      element.scrollTop = Math.min(target, maxScroll);
      // Only consider the restore finished once the list is tall enough to hold
      // the saved offset. While it is still growing, keep the arm so the final
      // layout lands on the exact position the user left.
      if (maxScroll >= target - 1) tabListPendingRestoreRef.current = null;
    };

    applyPendingRestore();
    if (tabListPendingRestoreRef.current === null) return;

    const observer = new ResizeObserver(() => {
      applyPendingRestore();
      if (tabListPendingRestoreRef.current === null) observer.disconnect();
    });
    observer.observe(element);
    const content = element.firstElementChild;
    if (content) observer.observe(content);
    return () => observer.disconnect();
  }, [isVerticalLayout, projectId, tabListHasRows, mainTabs.length, tabGroups.length]);

  // The user always wins over a pending restore: the moment they touch the list,
  // ownership passes to them and their position is what gets persisted. Fires on
  // capture, so it lands before the scroll event it causes.
  const releaseTabListRestore = useCallback(() => {
    tabListPendingRestoreRef.current = null;
    tabListUserScrolledRef.current = true;
  }, []);

  const handleTabListScroll = useCallback((event: React.UIEvent<HTMLDivElement>) => {
    if (!isVerticalLayout) return;
    // Persist only what the user scrolled. Layout-driven scroll events during
    // project mount are ignored: the browser clamps scrollTop to 0 while rows
    // are still arriving, and it drifts by a pixel or two as they settle.
    if (!tabListUserScrolledRef.current) return;
    if (tabListPendingRestoreRef.current !== null) return;
    if (tabListScrollProjectRef.current !== projectId) return;
    setTabListScrollTop(projectId, event.currentTarget.scrollTop);
  }, [isVerticalLayout, projectId, setTabListScrollTop]);

  // Auto-scroll when dragging near edges
  useEffect(() => {
    if (isVerticalLayout) return;
    const scrollContainer = scrollContainerRef.current;
    if (!scrollContainer) return;

    return autoScrollForElements({
      element: scrollContainer,
      canScroll: ({ source }) => source.data.type === 'TAB' || source.data.type === 'TAB_GROUP',
      getConfiguration: () => ({
        maxScrollSpeed: 'fast',
      }),
    });
  }, [isVerticalLayout]);

  // Auto-scroll to the active tab when it changes (e.g. a new tab was created
  // off-screen). Scroll position is a restored value, never an animation: a
  // smooth scroll here rode on top of the per-project restore, so returning to
  // a project visibly crawled from the saved offset to the active row. Jump.
  //
  // It also must not fire on a project switch: the sidebar column is reused,
  // so switching projects re-runs this effect with the NEW project's active
  // tab and would drag the list away from the offset the user left. Only a
  // real change of the active tab INSIDE the visible project counts.
  //
  // And it must stay a no-op whenever the row is ALREADY on screen: clicking a
  // visible tab must never move the list under the cursor. A row that is NOT
  // visible is brought toward the middle (tabListRevealScroll.mjs) — the same
  // rule as the explicit reveal below, so the two paths cannot disagree about
  // where the active row ends up. Geometry is measured against THIS scroller,
  // never scrollIntoView: that one means "make it visible", so it re-aligns a
  // row merely near an edge and walks every scrollable ancestor, moving the
  // list on clicks that should have changed nothing.
  const lastAutoScrolledTabRef = useRef<string | null>(null);
  useEffect(() => {
    const scrollContainer = scrollContainerRef.current;
    if (!scrollContainer || !workspace.activeTabId) return;
    // Project changed → adopt its active tab silently; the saved-scroll
    // restore owns the position.
    if (tabListScrollProjectRef.current !== projectId) {
      lastAutoScrolledTabRef.current = workspace.activeTabId;
      return;
    }
    if (lastAutoScrolledTabRef.current === workspace.activeTabId) return;
    lastAutoScrolledTabRef.current = workspace.activeTabId;

    // One frame to let the row commit; no animation.
    const raf = requestAnimationFrame(() => {
      const activeEl = scrollContainer.querySelector(
        `[data-tab-item][data-tab-id="${CSS.escape(workspace.activeTabId!)}"]`
      ) as HTMLElement | null;
      if (!activeEl) return;
      // Position must be measured against the SCROLLER, never via bare
      // offsetTop: every row card sits inside its own position:relative
      // wrapper, so offsetTop ≈ 0 for ALL rows — a naive check then reads
      // any row as "above the viewport" and slams the list to the top.
      const rect = measureVerticalRowFlipRect(activeEl, scrollContainer);
      // Vertical sidebar axis — toward the middle, clamped at the ends.
      const nextTop = tabListRevealScrollTop({
        rowTop: rect.top,
        rowHeight: rect.height,
        viewTop: scrollContainer.scrollTop,
        viewHeight: scrollContainer.clientHeight,
        contentHeight: scrollContainer.scrollHeight,
      });
      if (nextTop !== null) scrollContainer.scrollTop = nextTop;
      // Horizontal top-bar axis (the old scrollIntoView covered it too).
      const rowRight = rect.left + rect.width;
      const viewLeft = scrollContainer.scrollLeft;
      const viewRight = viewLeft + scrollContainer.clientWidth;
      if (rect.left < viewLeft) scrollContainer.scrollLeft = rect.left;
      else if (rowRight > viewRight) {
        scrollContainer.scrollLeft = rowRight - scrollContainer.clientWidth;
      }
    });

    return () => cancelAnimationFrame(raf);
  }, [workspace.activeTabId, mainTabs.length, projectId]);

  // Explicit reveal request (Ctrl+Tab / Cmd+P commit, split focus): INSTANT
  // scroll that brings the row toward the MIDDLE of the list — see
  // tabListRevealScroll.mjs for the rule (middle when reachable, otherwise the
  // list simply hits its end; a fully visible row is left alone). Unlike the
  // effect above this one also fires right after a cross-project switch and
  // takes priority over that project's saved-scroll restore — the user asked
  // for this tab, not for where the list stood last time.
  const tabListRevealRequest = useWorkspaceStore((s) => s.tabListRevealRequest);
  useLayoutEffect(() => {
    if (!isVerticalLayout) return;
    if (!tabListRevealRequest || tabListRevealRequest.projectId !== projectId) return;
    // ONE-SHOT, consumed by seq. The store field lives on after handling, so
    // without this a RETURN to the same project re-ran the effect against the
    // stale request: it cancelled the per-project saved-scroll restore and
    // dragged the list to a tab from the previous visit — reported live as
    // "позиция скролла не сохраняется при переключении проектов". The counter
    // is module-level, not a ref: TabBar unmounts on the dashboard trip, and a
    // ref reset to 0 would let the same stale request fire once more on every
    // return from the dashboard. Exactly one TabBar handles a given request
    // (vertical layout + matching project), so a shared counter is safe.
    if (tabListRevealRequest.seq === consumedTabListRevealSeq) return;
    const scroller = scrollContainerRef.current;
    // No scroller — this instance cannot handle the request (menu-owner
    // TabBars render no list); leave it unconsumed for the one that can.
    if (!scroller) return;
    consumedTabListRevealSeq = tabListRevealRequest.seq;

    // The reveal owns the scroll from here: cancel a pending per-project
    // restore so it can't clamp us back after rows finish laying out.
    tabListPendingRestoreRef.current = null;

    let cancelled = false;
    let attempts = 0;
    const tryReveal = () => {
      if (cancelled) return;
      const row = scroller.querySelector(`[data-tab-item][data-tab-id="${CSS.escape(tabListRevealRequest.tabId)}"]`) as HTMLElement | null;
      if (!row) {
        // Row not committed yet (project just switched) — retry next frame,
        // bounded so a closed tab can't spin forever.
        if (++attempts < 20) requestAnimationFrame(tryReveal);
        return;
      }
      // NOT row.offsetTop: the card's offsetParent is its own
      // position:relative row wrapper, so offsetTop ≈ 0 for every row. That
      // read any row as "above the viewport", slammed the list to the top on
      // every click, and then persisted 0 as the saved offset ("scroll
      // resets"). Measure against the scroller itself.
      const rect = measureVerticalRowFlipRect(row, scroller);
      const next = tabListRevealScrollTop({
        rowTop: rect.top,
        rowHeight: rect.height,
        viewTop: scroller.scrollTop,
        viewHeight: scroller.clientHeight,
        contentHeight: scroller.scrollHeight,
      });
      if (next !== null) {
        scroller.scrollTop = next;
        // Persist the revealed position (the reveal, not the stale saved
        // offset, is where the user now is). handleTabListScroll ignores this
        // event because tabListUserScrolledRef is false.
        setTabListScrollTop(projectId, scroller.scrollTop);
      }
    };
    tryReveal();
    return () => { cancelled = true; };
  }, [isVerticalLayout, projectId, tabListRevealRequest, setTabListScrollTop]);

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

  const renderCommandHistoryRows = (tabId: string) => {
    const rows = commandHistoryByTab.get(tabId) || [];
    if (rows.length === 0) {
      return (
        <div className="px-3 py-2 text-[12px] text-[#777] whitespace-nowrap">
          No command history
        </div>
      );
    }
    return rows.map((row, index) => {
      const label = formatCommandRunHistoryLabel(row.command) || row.command;
      const time = formatCommandRunHistoryTime(row.at);
      return (
        <div
          key={row.id || `${row.at}-${index}`}
          className="px-3 py-1.5 text-[12px] text-[#ccc] flex items-center gap-3 min-w-0"
          title={`${label}${time ? ` · ${time}` : ''}`}
        >
          <span className="min-w-0 flex-1 truncate text-[#ddd]">{label}</span>
          <span className="flex-shrink-0 tabular-nums text-[#8a8a8a]">{time}</span>
        </div>
      );
    });
  };

  // Vertical sidebar layout — left column, list runs top→bottom and scrolls
  // vertically. Reuses all state and
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
        ref={setVerticalScrollContainerRef}
        data-structured-tab-outline-phase={tabOutlineDnd.dragState?.phase || 'idle'}
        data-structured-tab-outline-navigation={tabOutlineDnd.dragState?.navigationMode ? 'true' : undefined}
        className="flex-1 flex flex-col scrollbar-hide"
        style={{ overflowX: 'hidden', overflowY: 'auto', minHeight: 0 }}
        onScroll={handleTabListScroll}
        onWheelCapture={releaseTabListRestore}
        onPointerDownCapture={releaseTabListRestore}
        onTouchStartCapture={releaseTabListRestore}
        onKeyDownCapture={releaseTabListRestore}
      >
        {mainTabs.length === 0 && tabGroups.length === 0 ? (
          <EmptyMainZone
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
            {!isMultiSelect && tabOutlineDnd.rows.map((row) => {
              const node = tabOutlineNodeById.get(String(row.id));
              if (!node) return null;
              const rowProps = tabOutlineDnd.getRowProps(row);
              const ancestorNodes = row.path
                .slice(0, -1)
                .map((id) => tabOutlineNodeById.get(String(id)))
                .filter((candidate): candidate is TabOutlineNode => !!candidate);
              const containingGroup = ancestorNodes.find((candidate) => candidate.entityType === 'group');
              const tabAncestors = ancestorNodes.filter((candidate) => candidate.entityType === 'tab');
              const visualDepth = tabAncestors.length;
              const isOutlineSource = sharedOutlineSourceIdSet.has(String(row.id));
              const outlineNavigationPaused = !!tabOutlineDnd.dragState?.navigationMode && isOutlineSource;

              if (node.entityType === 'tab' && node.tabId) {
                const tab = liveMainTabById.get(node.tabId) || node.rawTab;
                if (!tab) return null;
                const groupId = containingGroup?.groupId;
                const index = mainTabsForDisplay.findIndex((candidate) => candidate.id === tab.id);
                const parentNode = tabAncestors.at(-1);
                const parentTab = parentNode?.tabId
                  ? liveMainTabById.get(parentNode.tabId) || parentNode.rawTab
                  : undefined;
                const parentIsActive = !!parentTab
                  && centerInThisProject
                  && currentView === 'terminal'
                  && workspace.activeTabId === parentTab.id;
                const connectorColor = parentTab
                  ? getVisualConnectorColor(parentTab, parentIsActive)
                  : 'rgba(255,255,255,0.14)';
                const hierarchyStep = 12;
                const groupIndent = groupId ? 16 : 0;
                const indent = groupIndent + (visualDepth * hierarchyStep);
                const connectorLeft = -7;
                const continuationVisualDepths = row.ancestorContinuationDepths.flatMap((pathIndex) => {
                  const continuationNode = tabOutlineNodeById.get(String(row.path[pathIndex]));
                  if (continuationNode?.entityType !== 'tab') return [];
                  const lineDepth = row.path
                    .slice(0, pathIndex + 1)
                    .filter((id) => tabOutlineNodeById.get(String(id))?.entityType === 'tab')
                    .length;
                  return lineDepth > 0 ? [lineDepth] : [];
                });
                const feedback = String(tabOutlineDnd.dragState?.sourceId) === String(row.id)
                  ? tabOutlineDnd.dragState?.feedback || null
                  : null;

                return (
                  <div
                    {...rowProps}
                    key={String(row.id)}
                    data-vertical-row
                    data-vertical-row-key={String(row.id)}
                    data-row-type="tab"
                    data-tab-id={tab.id}
                    data-group-member-of={groupId}
                    data-visual-child-row={visualDepth > 0 ? 'true' : undefined}
                    data-visual-parent-id={parentNode?.tabId}
                    data-visual-depth={visualDepth || undefined}
                    style={{
                      position: 'relative',
                      marginLeft: indent || undefined,
                      width: indent ? `calc(100% - ${indent}px)` : undefined,
                      boxSizing: 'border-box',
                    }}
                  >
                    {visualDepth > 0 && (
                      <>
                        {continuationVisualDepths.map((lineDepth) => (
                          <span
                            key={`ancestor-${lineDepth}`}
                            aria-hidden
                            data-visual-connector-continuation={lineDepth}
                            style={{
                              position: 'absolute',
                              left: connectorLeft - ((visualDepth - lineDepth) * hierarchyStep),
                              top: `-${tabSidebarGap}px`,
                              bottom: `-${tabSidebarGap}px`,
                              width: 1,
                              background: connectorColor,
                              opacity: 0.88,
                              pointerEvents: 'none',
                            }}
                          />
                        ))}
                        <span
                          aria-hidden
                          data-visual-connector-top
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
                        {row.hasNextSibling && (
                          <span
                            aria-hidden
                            data-visual-connector-bottom
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
                          data-visual-connector-elbow
                          style={{
                            position: 'absolute',
                            left: connectorLeft,
                            top: '50%',
                            width: 8,
                            height: 1,
                            background: connectorColor,
                            pointerEvents: 'none',
                          }}
                        />
                      </>
                    )}
                    <TabItem
                      tab={tab}
                      restartAfterFallbackCommand={restartAfterFallbackCommands.get(tab.id) || null}
                      onCommandHistoryOpen={handleCommandHistoryOpen}
                      index={index}
                      groupId={groupId}
                      zone="main"
                      projectId={projectId}
                      orientation="vertical"
                      suppressDropIndicator={!isDraggingTab}
                      disableLegacyDnd={!isMultiSelect}
                      outlineFeedback={isMultiSelect ? null : feedback}
                      outlineNavigationPaused={outlineNavigationPaused}
                      sessionStatus={tab.sessionStatus as SessionStatus | undefined}
                      isActive={centerInThisProject && currentView === 'terminal' && workspace.activeTabId === tab.id}
                      isSelected={isMultiSelect && selectedTabIds.includes(tab.id)}
                      isEditing={editingTabId === tab.id}
                      editValue={editValue}
                      onSwitch={(event) => {
                        handleTabClick(event, tab.id);
                      }}
                      onRenameRequest={() => startTabRename(tab)}
                      onClose={(event) => handleCloseTab(event, tab.id)}
                      onContextMenu={(event) => handleContextMenu(event, tab.id)}
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
                      onRunLastProjectCommand={handleRunLastProjectCommand}
                      isStopping={restartInFlight.has(tab.id)}
                      isInterrupted={isTabInterrupted(tab)}
                      draggingGroupIds={isMultiSelect ? draggingGroupIds : sharedOutlineSourceTabIds}
                      draggingRootIds={isMultiSelect ? draggingRootIds : sharedOutlineRootTabIds}
                      isDragTarget={false}
                      isDragBlockedTarget={false}
                      isAnyDragging={isMultiSelect ? tabbarVisualLockActive : sharedTabbarVisualLockActive}
                      cmdPeekMode={!sharedOutlineDragActive && isCmdPressed && isMouseInTabBar}
                      isCollapsed={!!tab.isCollapsed}
                      isViewingSubAgent={viewingSubAgentParentId === tab.id}
                      completionNotificationArmed={!!tab.completionNotificationArmed}
                      completionNotificationFired={!!tab.completionNotificationFired}
                    />
                  </div>
                );
              }

              if (node.entityType !== 'group' || !node.groupId) return null;
              const group = liveTabGroupById.get(node.groupId) || node.rawGroup;
              if (!group) return null;
              const dwell = tabOutlineDnd.dragState?.navigationDwell?.targetId === row.id
                ? tabOutlineDnd.dragState.navigationDwell
                : null;
              return (
                <div
                  {...rowProps}
                  key={String(row.id)}
                  data-vertical-row
                  data-vertical-row-key={String(row.id)}
                  data-row-type="group"
                  data-group-id={group.id}
                  data-group-collapsed={row.expanded ? 'false' : 'true'}
                  data-drag-source-group={sharedOutlineSourceGroupId === group.id ? 'true' : undefined}
                  style={{ position: 'relative' }}
                >
                  <TabGroupHeader
                    group={group}
                    count={countOutlineTabs(node)}
                    projectId={projectId}
                    isEditing={editingGroupId === group.id}
                    editValue={groupEditValue}
                    onEditChange={setGroupEditValue}
                    onEditSubmit={handleGroupRenameSubmit}
                    onEditKeyDown={handleGroupRenameKeyDown}
                    inputRef={inputRef as React.RefObject<HTMLInputElement>}
                    onContextMenu={(event) => handleGroupContextMenu(event, group)}
                    onAuxClick={(event) => {
                      if (event.button !== 1) return;
                      event.preventDefault();
                      event.stopPropagation();
                      void closeGroupById(group.id);
                    }}
                    onToggleCollapsed={() => {
                      void tabOutlineDnd.requestExpansion(row.id, !row.expanded, 'pointer-toggle');
                    }}
                    onFocusGroup={() => setActiveTabGroup(projectId, group.id)}
                    isFocused={workspace.activeGroupId === group.id}
                    isAnyDragging={isMultiSelect ? tabbarVisualLockActive : sharedTabbarVisualLockActive}
                    navigationSpringState={null}
                    outlineNavigationDwell={dwell}
                    disableLegacyDnd={!isMultiSelect}
                    isOutlineSource={sharedOutlineSourceGroupId === group.id}
                    outlineNavigationPaused={outlineNavigationPaused}
                  />
                </div>
              );
            })}
            {isMultiSelect && verticalDisplayRows.map((row) => {
              const renderTab = (tab: TabData, groupId?: string, groupIndex?: number) => {
                const index = mainTabsForDisplay.findIndex(t => t.id === tab.id);
                const isProjectedSource = !!dragPreview?.sourceIds.includes(tab.id);
                const projectedTab = isProjectedSource ? projectedTabById.get(tab.id) : undefined;
                const displayParentId = projectedTab?.visualParentTabId || tab.visualParentTabId;
                const visualDepth = Math.max(0, (isProjectedSource ? projectedDepthById : visualDepthById).get(tab.id) || 0);
                const horizontalIntent = tabHorizontalIntent?.sourceId === tab.id ? tabHorizontalIntent : null;
                const tabNode = (
	                  <TabItem
	                    key={tab.id}
	                    tab={tab}
	                    restartAfterFallbackCommand={restartAfterFallbackCommands.get(tab.id) || null}
	                    onCommandHistoryOpen={handleCommandHistoryOpen}
	                    index={index}
                    groupId={groupId}
                    groupIndex={groupIndex}
                    zone="main"
                    projectId={projectId}
                    orientation="vertical"
                    sessionStatus={tab.sessionStatus as SessionStatus | undefined}
                    isActive={centerInThisProject && currentView === 'terminal' && workspace.activeTabId === tab.id}
                    isSelected={isMultiSelect && selectedTabIds.includes(tab.id)}
                    isEditing={editingTabId === tab.id}
                    editValue={editValue}
                    onSwitch={(e) => {
                      handleTabClick(e, tab.id);
                    }}
                    onRenameRequest={() => startTabRename(tab)}
                    onClose={(e) => handleCloseTab(e, tab.id)}
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
                    onRunLastProjectCommand={handleRunLastProjectCommand}
                    isStopping={restartInFlight.has(tab.id)}
                    isInterrupted={isTabInterrupted(tab)}
                    draggingGroupIds={draggingGroupIds}
                    draggingRootIds={draggingRootIds}
                    isDragTarget={dragPreview?.status === 'allowed' && !!dragPreview.targetTabIds?.includes(tab.id)}
                    isDragBlockedTarget={dragPreview?.status === 'blocked' && !!dragPreview.targetTabIds?.includes(tab.id)}
                    isAnyDragging={tabbarVisualLockActive}
                    cmdPeekMode={isCmdPressed && isMouseInTabBar}
                    isCollapsed={!!tab.isCollapsed}
                    isViewingSubAgent={viewingSubAgentParentId === tab.id}
                    completionNotificationArmed={!!tab.completionNotificationArmed}
                    completionNotificationFired={!!tab.completionNotificationFired}
                  />
                );
                if (!visualDepth && !horizontalIntent) return tabNode;
                const parentTab = displayParentId
                  ? projectedTabsForDisplay.find(candidate => candidate.id === displayParentId)
                  : null;
                const parentIsActive = !!parentTab && centerInThisProject && currentView === 'terminal' && workspace.activeTabId === parentTab.id;
                const connectorColor = parentTab
                  ? getVisualConnectorColor(parentTab, parentIsActive)
                  : 'rgba(255,255,255,0.14)';
                const hierarchyStep = 12;
                const indent = visualDepth * hierarchyStep;
                const connectorLeft = -7;
                const treeMeta = visualTreeMetaById.get(tab.id);
                const intentOpacity = horizontalIntent ? 0.22 + horizontalIntent.progress * 0.72 : 0;
                const intentColor = horizontalIntent?.disabled ? 'rgba(166,173,200,0.82)' : 'rgba(137,180,250,0.96)';
                return (
                  <div
                    key={tab.id}
                    data-visual-child-row={visualDepth ? 'true' : undefined}
                    data-visual-parent-id={displayParentId || undefined}
                    data-visual-depth={visualDepth || undefined}
                    data-projected-hierarchy={isProjectedSource ? 'true' : undefined}
                    data-tab-horizontal-intent={horizontalIntent?.direction || undefined}
                    data-tab-horizontal-intent-disabled={horizontalIntent?.disabled ? 'true' : undefined}
                    data-tab-horizontal-intent-reason={horizontalIntent?.reason || undefined}
                    style={{
                      position: 'relative',
                      marginLeft: indent,
                      width: `calc(100% - ${indent}px)`,
                      boxSizing: 'border-box',
                    }}
                  >
                    {visualDepth > 0 && (
                      <>
                        {(treeMeta?.continuationDepths || []).map(lineDepth => (
                          <span
                            key={`ancestor-${lineDepth}`}
                            aria-hidden
                            data-visual-connector-continuation={lineDepth}
                            style={{
                              position: 'absolute',
                              left: connectorLeft - ((visualDepth - lineDepth) * hierarchyStep),
                              top: `-${tabSidebarGap}px`,
                              bottom: `-${tabSidebarGap}px`,
                              width: 1,
                              background: connectorColor,
                              opacity: 0.88,
                              pointerEvents: 'none',
                            }}
                          />
                        ))}
                        <span
                          aria-hidden
                          data-visual-connector-top
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
                        {treeMeta?.hasLaterSibling && (
                          <span
                            aria-hidden
                            data-visual-connector-bottom
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
                          data-visual-connector-elbow
                          style={{
                            position: 'absolute',
                            left: connectorLeft,
                            top: '50%',
                            width: 8,
                            height: 1,
                            background: connectorColor,
                            pointerEvents: 'none',
                          }}
                        />
                      </>
                    )}
                    {horizontalIntent && (
                      <span
                        aria-hidden
                        data-horizontal-intent-direction={horizontalIntent.direction}
                        style={{
                          position: 'absolute',
                          zIndex: 8,
                          top: '50%',
                          transform: 'translateY(-50%)',
                          left: horizontalIntent.direction === 'left' ? 7 : undefined,
                          right: horizontalIntent.direction === 'right' ? 7 : undefined,
                          width: 34,
                          height: 20,
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          borderRadius: 5,
                          border: `1px ${horizontalIntent.disabled ? 'dashed' : 'solid'} ${intentColor}`,
                          background: horizontalIntent.disabled ? 'rgba(45,48,56,0.92)' : 'rgba(32,55,86,0.9)',
                          color: intentColor,
                          fontSize: 13,
                          fontWeight: 750,
                          opacity: intentOpacity,
                          pointerEvents: 'none',
                        }}
                      >
                        {horizontalIntent.disabled ? '⊘' : (horizontalIntent.direction === 'left' ? '←' : '→')}
                      </span>
                    )}
                    {tabNode}
                  </div>
                );
              };

              if (row.kind === 'tab') {
                const groupCollapsed = !!row.group?.collapsed;
                const isGroupTargetMember = !!dragPreview?.targetTabIds?.includes(row.tab.id);
                const isAllowedGroupTargetMember = isGroupTargetMember && dragPreview?.status === 'allowed';
                const isBlockedGroupTargetMember = isGroupTargetMember && dragPreview?.status === 'blocked';
                const groupConnectorColor = 'rgba(139, 92, 246, 0.68)';
                return (
                  <div
                    key={row.tab.id}
                    data-vertical-row
                    data-vertical-row-key={`tab:${row.tab.id}`}
                    data-row-type="tab"
                    data-tab-id={row.tab.id}
                    data-drag-target-status={dragPreview?.targetTabIds?.includes(row.tab.id) ? dragPreview.status : undefined}
                    data-drag-target-placement={dragPreview?.targetTabIds?.includes(row.tab.id) ? dragPreview.targetPlacement : undefined}
                    data-drag-target-reason={dragPreview?.status === 'blocked' && dragPreview.targetTabIds?.includes(row.tab.id) ? dragPreview.reason : undefined}
                    data-group-member-of={row.group?.id}
                    data-group-collapsed={groupCollapsed ? 'true' : undefined}
                    style={{
                      position: 'relative',
                      marginLeft: row.group ? 16 : undefined,
                      width: row.group ? 'calc(100% - 16px)' : undefined,
                      maxHeight: groupCollapsed ? 0 : 120,
                      opacity: groupCollapsed ? 0 : 1,
                      overflow: groupCollapsed ? 'hidden' : 'visible',
                      pointerEvents: groupCollapsed ? 'none' : undefined,
                      transition: 'max-height 150ms ease, opacity 120ms ease',
                      borderRadius: 6,
                      background: isBlockedGroupTargetMember
                        ? 'rgba(239, 68, 68, 0.08)'
                        : (isAllowedGroupTargetMember ? 'rgba(59, 130, 246, 0.08)' : undefined),
                      outline: isBlockedGroupTargetMember ? '1px dashed rgba(248, 113, 113, 0.72)' : undefined,
                      outlineOffset: isBlockedGroupTargetMember ? '-2px' : undefined,
                    }}
                  >
                    {row.group && !groupCollapsed && row.groupConnector && (
                      <>
                        <span
                          aria-hidden
                          data-group-connector-trunk
                          style={{
                            position: 'absolute',
                            zIndex: 1,
                            left: -8,
                            top: `-${tabSidebarGap}px`,
                            bottom: row.groupConnector.trunk === 'end' ? '50%' : `-${tabSidebarGap}px`,
                            width: 1,
                            background: groupConnectorColor,
                            pointerEvents: 'none',
                          }}
                        />
                        {row.groupConnector.elbow && (
                          <span
                            aria-hidden
                            data-group-connector-elbow
                            style={{
                              position: 'absolute',
                              zIndex: 1,
                              left: -8,
                              top: '50%',
                              width: 8,
                              height: 1,
                              background: groupConnectorColor,
                              pointerEvents: 'none',
                            }}
                          />
                        )}
                      </>
                    )}
                    {renderTab(row.tab, row.group?.id, row.groupIndex)}
                  </div>
                );
              }
              const isSourceGroup = draggingSourceGroupId === row.group.id;
              const isTargetGroup = (dragPreview?.targetKind === 'group-block' || dragPreview?.targetKind === 'group-inside')
                && dragPreview.targetGroupId === row.group.id
                && !isSourceGroup;
              const isAllowedTargetGroup = isTargetGroup && dragPreview?.status === 'allowed';
              const isBlockedTargetGroup = isTargetGroup && dragPreview?.status === 'blocked';
              const groupTargetShadow = (() => {
                if (isBlockedTargetGroup) return 'inset 0 0 0 1.5px rgba(248, 113, 113, 0.86)';
                if (!isAllowedTargetGroup) return undefined;
                if (dragPreview?.targetKind === 'group-inside') return 'inset 0 0 0 1.5px rgba(96, 165, 250, 0.82)';
                if (dragPreview?.targetPlacement === 'before') return 'inset 0 2px 0 rgba(96, 165, 250, 0.95)';
                return 'inset 0 -2px 0 rgba(96, 165, 250, 0.95)';
              })();
              return (
                <div
                  key={row.group.id}
                  data-vertical-row
                  data-vertical-row-key={`group:${row.group.id}`}
                  data-row-type="group"
                  data-group-id={row.group.id}
                  data-group-collapsed={row.group.collapsed ? 'true' : 'false'}
                  data-drag-source-group={isSourceGroup ? 'true' : undefined}
                  data-drag-target-group={isTargetGroup ? 'true' : undefined}
                  data-drag-target-status={isTargetGroup ? dragPreview?.status : undefined}
                  data-drag-target-kind={isTargetGroup ? dragPreview?.targetKind : undefined}
                  data-drag-target-placement={isTargetGroup ? dragPreview?.targetPlacement : undefined}
                  data-drag-target-reason={isBlockedTargetGroup ? dragPreview?.reason : undefined}
                  className="flex flex-col"
                  style={{
                    gap: row.group.collapsed ? 0 : `${tabSidebarGap}px`,
                    transition: 'gap 150ms ease',
                    borderRadius: 6,
                    background: isBlockedTargetGroup
                      ? 'rgba(239, 68, 68, 0.08)'
                      : (isAllowedTargetGroup ? 'rgba(59, 130, 246, 0.08)' : undefined),
                    boxShadow: isSourceGroup
                      ? 'inset 0 0 0 1.5px rgba(167, 139, 250, 0.78)'
                      : groupTargetShadow,
                    outline: isBlockedTargetGroup ? '1px dashed rgba(248, 113, 113, 0.86)' : undefined,
                    outlineOffset: isBlockedTargetGroup ? '-2px' : undefined,
                  }}
                >
                  <TabGroupHeader
                    group={row.group}
                    count={row.count}
                    projectId={projectId}
                    isEditing={editingGroupId === row.group.id}
                    editValue={groupEditValue}
                    onEditChange={setGroupEditValue}
                    onEditSubmit={handleGroupRenameSubmit}
                    onEditKeyDown={handleGroupRenameKeyDown}
                    inputRef={inputRef as React.RefObject<HTMLInputElement>}
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
                    dragTargetStatus={isTargetGroup ? dragPreview?.status : undefined}
                    dragTargetKind={isTargetGroup ? dragPreview?.targetKind : undefined}
                    dragTargetPlacement={isTargetGroup ? dragPreview?.targetPlacement : undefined}
                    dragTargetReason={isBlockedTargetGroup ? dragPreview?.reason : undefined}
                    navigationSpringState={tabDndNavigationSpringState?.groupId === row.group.id
                      ? tabDndNavigationSpringState
                      : null}
                  />
                  {row.count === 0 && !row.group.collapsed && (
                    <div
                      data-tab-group-body
                      data-group-id={row.group.id}
                      style={{
                        minHeight: 24,
                        marginLeft: 16,
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
                    Array.from(currentWorkspace.tabs.values()).filter(tab => !tab.parentTabId)
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
            onDropGroup={(groupId) => {
              const currentWorkspace = useWorkspaceStore.getState().openProjects.get(projectId);
              if (!currentWorkspace) return;
              const groupIds = Array.from(currentWorkspace.tabs.values())
                .filter(tab => !tab.parentTabId && tab.groupId === groupId)
                .map(tab => tab.id);
              const currentTabs = orderTabsWithVisualChildren(
                Array.from(currentWorkspace.tabs.values()).filter(tab => !tab.parentTabId)
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
        <div {...tabOutlineDnd.scrollSpacerProps} data-outline-scroll-reserve />
      </div>

    </div>
  );

  return (
    <>
      {/* menuOnlyForProject: the LIST is not rendered, the menu below still is.
          This instance exists only so a right click on a pane header chip whose
          project the sidebar is not showing has an owner to open — see
          menuOnlyForProject in TabBarProps. */}
      {menuOnlyForProject ? null : isVerticalLayout ? verticalBody : (
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
        <ControlHint label="Показать или скрыть sidebar">
        <button
          onClick={() => {
            const { sidebarOpen } = getSidebarState(projectId);
            setSidebarOpen(projectId, !sidebarOpen);
          }}
          className="h-full flex items-center px-2 text-[#666] hover:text-white hover:bg-[rgba(255,255,255,0.05)] transition-all duration-150"
        >
          <PanelLeft size={16} />
        </button>
        </ControlHint>

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
	                    restartAfterFallbackCommand={restartAfterFallbackCommands.get(tab.id) || null}
	                    onCommandHistoryOpen={handleCommandHistoryOpen}
	                    index={index}
                    zone="main"
                    projectId={projectId}
                    isActive={centerInThisProject && currentView === 'terminal' && workspace.activeTabId === tab.id}
                    isSelected={isMultiSelect && selectedTabIds.includes(tab.id)}
                    isEditing={editingTabId === tab.id}
                    editValue={editValue}
                    onSwitch={(e) => {
                      handleTabClick(e, tab.id);
                    }}
                    onRenameRequest={() => startTabRename(tab)}
                    onClose={(e) => handleCloseTab(e, tab.id)}
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
                    onRunLastProjectCommand={handleRunLastProjectCommand}
                    isStopping={restartInFlight.has(tab.id)}
                    isInterrupted={isTabInterrupted(tab)}
                    draggingGroupIds={draggingGroupIds}
                    draggingRootIds={draggingRootIds}
                    isDragTarget={!!dragPreview?.targetTabIds?.includes(tab.id)}
                    isAnyDragging={isDraggingTab}
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
              const ptyOwner = resolvePtyAgentOwner(tab || {});
              if (tab?.tabType === 'claude-sdk') claudeCount++;
              else if (ptyOwner === 'claude') claudeCount++;
              else if (cmd === 'gemini') geminiCount++;
              else if (ptyOwner === 'codex') codexCount++;
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
                const ptyOwner = resolvePtyAgentOwner(tab || {});
                // SDK route: cancel the in-process query (claude-sdk:stop). No PTY.
                if (tab?.tabType === 'claude-sdk') {
                  if (!claudeBusyMap.get(id)) return null;
                  // Same Resume-affordance signal as the chip + tab dot use.
                  window.dispatchEvent(new CustomEvent('claude-sdk:was-stopped', { detail: { tabId: id } }));
                  return ipcRenderer.invoke('claude-sdk:stop', { tabId: id });
                }
                if (!ptyOwner && cmd !== 'gemini') return null;
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
                    <Pencil size={12} className="text-[#888] flex-shrink-0" />
                    Rename
                  </button>
                  {stopPill}
                </div>
              </>
            );
          })()}

          {!isMultiSelect && contextMenu && (
            <div className="relative group/tab-project-move border-t border-[#3a3a3a]">
              <button
                data-tab-context-action="move-to-project"
                className="w-full text-left px-4 py-1.5 text-[13px] text-[#ccc] hover:bg-white/10 cursor-pointer flex items-center gap-2"
              >
                <FolderInput size={12} className="text-[#888] flex-shrink-0" />
                <span>Move to Project</span>
                <span className="text-[#666] ml-auto">›</span>
              </button>
              <div className="absolute left-full top-0 -ml-2 pl-2 hidden group-hover/tab-project-move:block">
                <div className="bg-[#2a2a2a] border border-[#444] rounded-md shadow-2xl py-1 min-w-[190px]">
                  {projectMoveTargetIds.map((targetProjectId) => (
                      <button
                        key={targetProjectId}
                        data-tab-move-project-id={targetProjectId}
                        className="w-full text-left px-3 py-1.5 text-[12px] text-[#ccc] hover:bg-white/10 cursor-pointer flex items-center gap-2 whitespace-nowrap"
                        onClick={(event) => {
                          event.stopPropagation();
                          void handleContextTabProjectMove(contextMenu.tabId, targetProjectId);
                        }}
                      >
                        <Folder size={12} className="text-[#777] flex-shrink-0" />
                        <span className="truncate max-w-[180px]">
                          {projects[targetProjectId]?.name || targetProjectId}
                        </span>
                      </button>
                    ))}
                  {projectMoveTargetIds.length === 0 && (
                    <div className="px-3 py-1.5 text-[12px] text-[#666]">No open projects</div>
                  )}
                </div>
              </div>
            </div>
          )}

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
                const selectedTriggerIds = getRestartAfterTriggerIds(ctxTab);
                const selectedTriggerId = selectedTriggerIds[0] || null;
                const hasSelection = selectedTriggerIds.length > 0;
                const restartAfterPaused = !!ctxTab.restartAfterPaused;
                const selectedCommand = ctxTab.restartAfterCommand || null;
                const selectedCommandLabel = formatRestartAfterCommandLabel(selectedCommand);
                const fallbackCommand = contextLastCommand?.tabId === ctxTabId && !isAiLaunchCommand(contextLastCommand.command)
                  ? contextLastCommand.command
                  : null;
                const fallbackCommandLabel = selectedCommand ? '' : formatRestartAfterCommandLabel(fallbackCommand);
                const displayedCommandLabel = selectedCommandLabel || fallbackCommandLabel || 'Choose';
                const displayedCommandIsFallback = !selectedCommand && !!fallbackCommandLabel;
                const scriptTargets = [
                  ...contextScripts.map((script) => ({ key: `npm:${script}`, kind: 'npm', label: script, command: `npm run ${script}` })),
                  ...contextShScripts.map((file) => ({ key: `sh:${file}`, kind: 'sh', label: `./${file}`, command: `./${file}` })),
                ];
                return (
                  <div className="border-t border-[#3a3a3a]">
                    <div className="flex items-stretch w-full">
                      <div className="flex-1 min-w-0" style={{ opacity: restartAfterPaused ? 0.58 : 1 }}>
                        <RunAfterTabPicker
	                          tabId={ctxTabId}
	                          autoRun={hasSelection && !restartAfterPaused}
	                          runAfterTabId={selectedTriggerId}
	                          runAfterTabIds={selectedTriggerIds}
	                          setRunAfterTab={(ownerTabId, targetTabId) => {
	                            setTabRestartAfterTarget(projectId, ownerTabId, targetTabId);
	                          }}
                          onTriggerClick={() => {
                            if (!hasSelection) return false;
                            setTabRestartAfterPaused(projectId, ctxTabId, !restartAfterPaused);
                            return true;
                          }}
                          panelRef={contextMenuRef}
                          title="Restart after - pick a tab"
                          emptyLabel="Choose"
                          showAllTabsOnOpen
                          triggerVariant="context-row"
                          triggerLabel="Restart after"
                          triggerIcon={<RotateCw size={12} />}
                          menuWidth={252}
                          zIndex={100040}
                          side="right"
                          accentColor={restartAfterPaused ? '#71717a' : '#8b5cf6'}
                          accentTextColor={restartAfterPaused ? '#a1a1aa' : '#ddd6fe'}
	                          showRuntimeDot={false}
	                          multiSelect
	                          closeOnSelect={false}
	                          openOnHover
	                        />
                      </div>
                      {hasSelection && (
                        <button
                          className="w-8 flex items-center justify-center border-l border-[#444] text-[#777] hover:text-[#ddd] hover:bg-white/10 cursor-pointer flex-shrink-0"
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

                    {hasSelection && (
                      <div className="px-3 pb-2">
                        <div className="relative group/restart-script -mx-3 mb-1">
                          <div className={`w-full px-3 py-1.5 text-[13px] hover:bg-white/10 flex items-center gap-2 ${restartAfterPaused ? 'text-[#777]' : 'text-[#ccc]'}`}>
                            <button
                              className="flex-1 min-w-0 text-left cursor-pointer flex items-center justify-between gap-2"
                              onClick={(e) => e.stopPropagation()}
                            >
                              <span className="flex items-center gap-2 min-w-0">
                                <Play size={12} className={selectedCommand && !restartAfterPaused ? 'text-[#8b5cf6]' : 'text-[#666]'} />
                                <span className="truncate">Script</span>
                              </span>
                              <span className="flex items-center gap-1.5 min-w-0 text-[12px]">
                                <span className={selectedCommand
                                  ? (restartAfterPaused ? 'text-[#888] truncate max-w-[118px]' : 'text-[#ddd6fe] truncate max-w-[118px]')
                                  : (displayedCommandIsFallback ? 'text-[#777] truncate max-w-[118px]' : 'text-[#666]')}
                                >
                                  {displayedCommandLabel}
                                </span>
                                <span className="text-[#666]">{'\u203A'}</span>
                              </span>
                            </button>
                            {selectedCommand && (
                              <button
                                className="w-5 h-5 flex items-center justify-center rounded text-[#777] hover:text-[#ddd] hover:bg-white/10 cursor-pointer flex-shrink-0"
                                title="Clear script"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setTabRestartAfterCommand(projectId, ctxTabId, null);
                                }}
                              >
                                <X size={12} />
                              </button>
                            )}
                          </div>
                          <div className="absolute left-full top-0 -ml-2 pl-2 hidden group-hover/restart-script:block">
                            <div className="bg-[#2a2a2a] border border-[#444] rounded-md shadow-2xl py-1 min-w-[220px] max-h-[300px] overflow-y-auto">
                              {scriptTargets.length === 0 && (
                                <div className="context-menu-submenu-empty">No scripts</div>
                              )}
                              {scriptTargets.map((target) => {
                                const isSelected = target.command === selectedCommand;
                                return (
                                  <button
                                    key={target.key}
                                    className="context-menu-submenu-item w-full"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      setTabRestartAfterCommand(projectId, ctxTabId, isSelected ? null : target.command);
                                    }}
                                  >
                                    <span className="context-menu-submenu-kind">{target.kind}</span>
                                    <span className="context-menu-submenu-title">{target.label}</span>
                                    {isSelected && <span className="ml-auto text-white">✓</span>}
                                  </button>
                                );
                              })}
                            </div>
                          </div>
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

          {/* Session fork: compact-tail fork + ordinary full-history fork, plus
              an SDK variant for Claude. The third slot appears only for Claude
              because SDK does not run Codex; the row keeps two columns for
              Codex rather than showing a dead third one. */}
          {!isMultiSelect && contextForkProvider && contextForkSessionAvailable && (
            <div
              data-tab-fork-split
              className={
                'grid border-t border-[#333] border-b border-[#333] '
                + (contextForkProvider === 'claude'
                  ? 'grid-cols-[6fr_2fr_2fr]'
                  : 'grid-cols-[7fr_3fr]')
              }
            >
              <button
                data-tab-fork-compact
                className="px-4 py-1.5 text-[13px] text-[#ccc] hover:bg-white/10 cursor-pointer flex items-center justify-center gap-2"
                title="Fork from latest compact"
                aria-label="Fork from latest compact"
                onClick={() => void handleContextFork(true)}
              >
                <span className="text-[#8b5cf6] text-[14px] leading-none">⑂→▭</span>
                <span>Compact Fork</span>
              </button>
              <button
                data-tab-fork
                className="px-2 py-1.5 text-[12px] text-[#c4b5fd] hover:bg-white/10 cursor-pointer flex items-center justify-center border-l border-[#333]"
                title="Fork the complete session"
                aria-label="Fork complete session"
                onClick={() => void handleContextFork(false)}
              >
                <span>Fork</span>
              </button>
              {contextForkProvider === 'claude' && (
                <button
                  data-tab-fork-sdk
                  className="px-2 py-1.5 text-[12px] text-[#DA7756] hover:bg-white/10 cursor-pointer flex items-center justify-center border-l border-[#333]"
                  title="Fork the complete session into an SDK tab"
                  aria-label="Fork complete session into SDK tab"
                  onClick={() => void handleContextForkToSDK()}
                >
                  <span>SDK</span>
                </button>
              )}
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

          {!isMultiSelect && !isContextFileTab && contextMenu && (
            <div className="relative group/command-info">
              <button
                className="w-full text-left px-4 py-1.5 text-[13px] text-[#ccc] hover:bg-white/10 cursor-pointer flex items-center justify-between"
                onMouseEnter={() => {
                  if (contextMenu) void loadCommandRunHistory(contextMenu.tabId);
                }}
              >
                <span className="flex items-center gap-2 min-w-0">
                  <Info size={12} className="text-[#888] flex-shrink-0" />
                  <span className="truncate">Info</span>
                  <span className="text-[10px] text-[#555]">{commandHistoryByTab.get(contextMenu.tabId)?.length || 0}</span>
                </span>
                <span className="text-[#666]">{'\u203A'}</span>
              </button>
              <div className="absolute left-full top-0 -ml-2 pl-2 hidden group-hover/command-info:block">
                <div className="bg-[#2a2a2a] border border-[#444] rounded-xl shadow-2xl py-1 w-[280px] max-h-[300px] overflow-y-auto">
                  <div className="px-3 py-1.5 text-[11px] text-[#888] border-b border-[#333]">
                    Command history
                  </div>
                  {renderCommandHistoryRows(contextMenu.tabId)}
                </div>
              </div>
            </div>
          )}

          {/* «Move to window» — перенос вкладки в другое окно рабочей области.
              Не перетаскиванием: это был бы третий drag в приложении, через всю
              область, мимо чужих окон, с промахами. Юзер: *«перетаскивание пока
              слишком сложно»*. Вместо жеста — названная цель, нарисованная как
              текущая раскладка. Подменю по наведению, как у Info выше. */}
          {!isMultiSelect && contextMenu && (
            <div className="relative group/move-window">
              <button
                className="w-full text-left px-4 py-1.5 text-[13px] text-[#ccc] hover:bg-white/10 cursor-pointer flex items-center justify-between"
              >
                <span className="flex items-center gap-2 min-w-0">
                  <Columns2 size={12} className="text-[#888] flex-shrink-0" />
                  <span className="truncate">Move to window</span>
                </span>
                <span className="text-[#666]">{'\u203A'}</span>
              </button>
              <div className="absolute left-full top-0 -ml-2 pl-2 hidden group-hover/move-window:block">
                <div className="bg-[#2a2a2a] border border-[#444] rounded-xl shadow-2xl w-[260px]">
                  <MoveToWindowMenu
                    projectId={projectId}
                    tabId={contextMenu.tabId}
                    onDone={() => setContextMenu(null)}
                  />
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
                onClick={() => {
                  const tab = contextMenu ? workspace.tabs.get(contextMenu.tabId) : null;
                  const filePath = tab?.filePath || tab?.cwd || '';
                  if (filePath) {
                    window.require('electron').shell.showItemInFolder(filePath);
                  }
                  setContextMenu(null);
                }}
              >
                Open in Finder
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
          ) : (() => {
            const targetTabs = (isMultiSelect ? selectedTabIds : [contextMenu.tabId])
              .map(tabId => workspace.tabs.get(tabId))
              .filter((tab): tab is NonNullable<typeof tab> => !!tab);
            const uuidCandidateTabs = targetTabs.filter(tab => getTabSessionUuid(tab) || isCodexSessionTab(tab));
            const hasTabIds = targetTabs.length > 0;
            const hasUuid = uuidCandidateTabs.length > 0;
            const missingCount = targetTabs.length - uuidCandidateTabs.length;
            const tabIdTitle = isMultiSelect
              ? `ID-Tab: ${targetTabs.length}`
              : 'ID-Tab';
            const disabledTitle = 'У вкладки нет UUID сессии';
            const uuidPathTitle = isMultiSelect
              ? `UUID + пути: ${uuidCandidateTabs.length}${missingCount > 0 ? `, без UUID: ${missingCount}` : ''}`
              : 'UUID сессии + путь';
            const copyButtonClass = (enabled: boolean, withDivider = false) =>
              [
                'flex-1 basis-0 min-w-0 px-2 py-1.5 text-[12px] flex items-center justify-center gap-1.5 whitespace-nowrap',
                withDivider ? 'border-l border-[#444]' : '',
                enabled ? 'text-[#ccc] hover:bg-white/10 cursor-pointer' : 'text-[#555] cursor-not-allowed',
              ].filter(Boolean).join(' ');
            const copyTabId = (e: React.MouseEvent) => {
              e.stopPropagation();
              if (!hasTabIds) return;
              window.require('electron').clipboard.writeText(targetTabs.map(tab => tab.id).join('\n'));
              showToast(isMultiSelect ? `Скопировано ID-Tab: ${targetTabs.length}` : 'ID-Tab скопирован', 'success');
              setContextMenu(null);
            };
            const copyUuidWithPath = async (e: React.MouseEvent) => {
              e.stopPropagation();
              if (!hasUuid) return;
              try {
                const resolvedRows: Array<{ tab: (typeof targetTabs)[number]; uuid: string }> = [];
                for (const tab of targetTabs) {
                  const uuid = isCodexSessionTab(tab)
                    ? await requireCodexSurfaceSessionId({
                        tabId: tab.id,
                        operation: 'скопировать UUID сессии',
                      })
                    : getTabSessionUuid(tab);
                  if (uuid) resolvedRows.push({ tab, uuid });
                }
                const lines = resolvedRows.map(({ tab, uuid }) => {
                  const path = tab.cwd || project?.path || '/';
                  return `${uuid}\ncwd: ${path}`;
                });
                window.require('electron').clipboard.writeText(lines.join('\n\n'));
                showToast(isMultiSelect ? `Скопировано UUID + путей: ${resolvedRows.length}` : 'UUID + путь скопированы', 'success');
                setContextMenu(null);
              } catch (error: any) {
                showToast(error?.message || 'Не удалось проверить Codex-сессию перед копированием UUID', 'warning');
              }
            };
            return (
              <div className="flex items-stretch w-full">
                <button
                  className={copyButtonClass(hasTabIds)}
                  title={tabIdTitle}
                  disabled={!hasTabIds}
                  onClick={copyTabId}
                >
                  <Copy size={12} className="flex-shrink-0" />
                  <span>ID-Tab</span>
                </button>
                <button
                  className={copyButtonClass(hasUuid, true)}
                  title={hasUuid ? uuidPathTitle : disabledTitle}
                  disabled={!hasUuid}
                  onClick={copyUuidWithPath}
                >
                  <Copy size={12} className="flex-shrink-0" />
                  <span>UUID + Path</span>
                </button>
              </div>
            );
          })()}

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
                      let codexSessionId = tab.codexSessionId || null;
                      if (isCodexSessionTab(tab)) {
                        try {
                          codexSessionId = await requireCodexSurfaceSessionId({
                            tabId: tab.id,
                            operation: 'добавить Codex-сессию в избранное',
                            requireMutationSafe: true,
                          });
                        } catch (error: any) {
                          showToast(error?.message || 'Не удалось проверить Codex-сессию перед добавлением в избранное', 'warning');
                          return;
                        }
                      }
                      await ipcRenderer.invoke('project:add-favorite', {
                        projectId,
                        tab: {
                          name: tab.name,
                          cwd: tab.cwd,
                          color: tab.color || null,
                          commandType: tab.commandType || null,
                          tabType: tab.tabType || 'terminal',
                          url: tab.url || null,
                          claudeSessionId: tab.claudeSessionId || null,
                          geminiSessionId: tab.geminiSessionId || null,
                          codexSessionId,
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

          {/* Split workspace: add/remove this tab as a side-by-side pane.
              Reverse-button semantics — the same slot toggles between
              «Добавить в рабочую область (N)» and «Убрать из рабочей области». */}
          {!isMultiSelect && contextMenu && (() => {
            const splitPanes = useWorkspaceStore.getState().splitPanes;
            // Held ANYWHERE — a parked chip is in the workspace just as much as
            // a shown one, and offering "add" for a tab that already has a chip
            // would promise a second copy of a single live terminal.
            const inSplit = paneIndexHoldingTab(splitPanes, contextMenu.tabId) >= 0;
            // In single mode the pair is (active tab, clicked tab) — clicking
            // the active tab itself would pair it with itself: no-op.
            const centerWorkspace = useWorkspaceStore.getState().openProjects.get(activeProjectId || '');
            const isActiveSingleTab = splitPanes.length === 0
              && activeProjectId === projectId
              && centerWorkspace?.activeTabId === contextMenu.tabId;
            // "Add to the workspace" appends a COLUMN, so the column cap
            // decides — not the total pane count, which refused while the
            // screen still had a free column (a stacked pair counts as two
            // panes but occupies one column).
            const splitFull = !splitAvailability(splitPanes, null).horizontal
              && !splitPanes.some((p) => !p.tabId);
            const disabled = !inSplit && (splitFull || isActiveSingleTab);
            return (
              <button
                className={`w-full text-left px-4 py-1.5 text-[13px] flex items-center gap-2 ${
                  disabled ? 'text-[#555] cursor-not-allowed' : 'text-[#ccc] hover:bg-white/10 cursor-pointer'
                }`}
                title={inSplit
                  ? 'Убрать это окно из рабочей области'
                  : splitFull
                    ? 'Сначала выберите вкладку для пустого окна'
                    : 'Показать вкладку вторым окном рядом с текущим'}
                onClick={(e) => {
                  e.stopPropagation();
                  if (disabled) return;
                  const st = useWorkspaceStore.getState();
                  if (inSplit) st.removeTabFromSplit(contextMenu.tabId);
                  else st.addTabToSplit(projectId, contextMenu.tabId);
                  setContextMenu(null);
                }}
              >
                <Columns2 size={12} className={disabled ? 'text-[#555]' : 'text-[#888] flex-shrink-0'} />
                {/* Short labels on purpose: «в рабочую область» wrapped onto a
                    second line and made the row twice as tall. */}
                {inSplit
                  ? 'Убрать из области'
                  : `Добавить в область${splitPanes.length > 0 ? ` (${splitPanes.length})` : ''}`}
              </button>
            );
          })()}

          {/* «Открыть в этом окне» — второй чип в полосе окна, где человек уже
              стоит. Обычный клик по вкладке ЗАМЕНЯЕТ показанный чип (иначе полоса
              росла бы от любой навигации), а добавляет только осознанный жест: в
              шапке это двойной клик по пустому месту, здесь — этот пункт.
              Перетащить вкладку из бокового списка в шапку нельзя: список
              использует свою систему перетаскивания, не браузерную. */}
          {!isMultiSelect && contextMenu && (() => {
            const st = useWorkspaceStore.getState();
            const heldAt = paneIndexHoldingTab(st.splitPanes, contextMenu.tabId);
            if (heldAt >= 0) return null; // уже лежит в каком-то окне
            const target = st.splitPanes.length > 0
              ? st.splitPanes[st.splitFocusedIndex]
              : null;
            // В сплите цель — окно в фокусе; без сплита — сам центр. Пустое окно
            // не годится: там нечему становиться соседом, туда вкладка просто
            // кладётся обычной активацией.
            if (st.splitPanes.length > 0 && (!target || !target.tabId)) return null;
            const centerTabId = st.activeProjectId
              ? st.openProjects.get(st.activeProjectId)?.activeTabId
              : null;
            if (st.splitPanes.length === 0 && (!centerTabId || centerTabId === contextMenu.tabId)) return null;
            return (
              <button
                className="w-full text-left px-4 py-1.5 text-[13px] flex items-center gap-2 text-[#ccc] hover:bg-white/10 cursor-pointer"
                title="Добавить вкладку в полосу окна, в котором вы сейчас"
                onClick={(e) => {
                  e.stopPropagation();
                  const store = useWorkspaceStore.getState();
                  if (store.splitPanes.length > 0) {
                    store.addTabToSplitPaneStrip(store.splitFocusedIndex, projectId, contextMenu.tabId);
                  } else {
                    store.addTabToCenterStrip(projectId, contextMenu.tabId);
                  }
                  setContextMenu(null);
                }}
              >
                <Columns2 size={12} className="text-[#888] flex-shrink-0" />
                Открыть в этом окне
              </button>
            );
          })()}
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
              className="w-full text-left px-4 py-1.5 text-[13px] text-[#ccc] hover:bg-white/10 cursor-pointer flex items-center gap-2"
              onClick={(e) => {
                e.stopPropagation();
                handleGroupContextRename();
              }}
            >
              <Pencil size={12} className="text-[#888] flex-shrink-0" />
              Rename
            </button>
            <div className="relative group/group-project-move">
              <button
                className="w-full text-left px-4 py-1.5 text-[13px] text-[#ccc] hover:bg-white/10 cursor-pointer flex items-center gap-2"
              >
                <FolderInput size={12} className="text-[#888] flex-shrink-0" />
                <span>Move to Project</span>
                <span className="text-[#666] ml-auto">›</span>
              </button>
              <div className="absolute left-full top-0 -ml-2 pl-2 hidden group-hover/group-project-move:block">
                <div className="bg-[#2a2a2a] border border-[#444] rounded-md shadow-2xl py-1 min-w-[190px]">
                  {projectMoveTargetIds.map((targetProjectId) => (
                      <button
                        key={targetProjectId}
                        className="w-full text-left px-3 py-1.5 text-[12px] text-[#ccc] hover:bg-white/10 cursor-pointer flex items-center gap-2 whitespace-nowrap"
                        onClick={async (event) => {
                          event.stopPropagation();
                          setGroupContextMenu(null);
                          const moved = await moveTabGroupToProject(projectId, group.id, targetProjectId);
                          if (moved) window.setTimeout(() => followMovedTabs(targetProjectId), 0);
                        }}
                      >
                        <Folder size={12} className="text-[#777] flex-shrink-0" />
                        <span className="truncate max-w-[180px]">
                          {projects[targetProjectId]?.name || targetProjectId}
                        </span>
                      </button>
                    ))}
                  {projectMoveTargetIds.length === 0 && (
                    <div className="px-3 py-1.5 text-[12px] text-[#666]">No open projects</div>
                  )}
                </div>
              </div>
            </div>
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

      {commandHistoryPopover && (
        <div
          data-command-history-popover
          className="fixed bg-[#202020] border border-[#444] rounded-md shadow-2xl py-1 w-[280px] max-h-[260px] overflow-y-auto"
          style={{ left: commandHistoryPopover.x, top: commandHistoryPopover.y, zIndex: 100060 }}
          onClick={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <div className="px-3 py-1.5 text-[11px] text-[#888] border-b border-[#333]">
            Command history
          </div>
          {renderCommandHistoryRows(commandHistoryPopover.tabId)}
        </div>
      )}

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
          {/* Agent shortcuts: same "new tab at end", but the CLI is already
              armed, so the user does not have to press Claude/Codex after. */}
          <button
            className="w-full text-left px-4 py-1.5 text-[13px] text-[#ccc] hover:bg-white/10 cursor-pointer flex items-center gap-2"
            onClick={() => {
              handleNewAgentTabAtEnd('claude');
              setEmptyContextMenu(null);
            }}
          >
            <span
              style={{
                width: 11,
                height: 11,
                borderRadius: 3,
                backgroundColor: '#DA7756',
                border: '1px solid #DA7756',
                flexShrink: 0,
              }}
            />
            New Claude tab
          </button>
          <button
            className="w-full text-left px-4 py-1.5 text-[13px] text-[#ccc] hover:bg-white/10 cursor-pointer flex items-center gap-2"
            onClick={() => {
              handleNewAgentTabAtEnd('codex');
              setEmptyContextMenu(null);
            }}
          >
            <span
              style={{
                width: 11,
                height: 11,
                borderRadius: 3,
                backgroundColor: '#10A37F',
                border: '1px solid #10A37F',
                flexShrink: 0,
              }}
            />
            New Codex tab
          </button>
          <div className="my-1 border-t border-[#3a3a3a]" />
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

    </>
  );
}

export default memo(TabBar);
