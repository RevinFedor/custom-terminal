import React, { useState, useRef, useEffect, useLayoutEffect, memo, useCallback, useMemo } from 'react';
import { useWorkspaceStore, TabColor, TabGroup, isTabInterrupted } from '../../store/useWorkspaceStore';
import { useProjectsStore } from '../../store/useProjectsStore';
import Tooltip from '../UI/Tooltip';
import { useUIStore } from '../../store/useUIStore';
import { useCmdKey, useCmdHoverPopover } from '../../hooks/useCmdHoverPopover';
import TabPreviewPopover from './TabPreviewPopover';
import '@gt-editor/markdown-editor/styles.css';
// Removed: framer-motion import - was causing lag on project switch
import { draggable, dropTargetForElements, monitorForElements } from '@atlaskit/pragmatic-drag-and-drop/element/adapter';
import { attachClosestEdge, extractClosestEdge, type Edge } from '@atlaskit/pragmatic-drag-and-drop-hitbox/closest-edge';
import { combine } from '@atlaskit/pragmatic-drag-and-drop/combine';
import { autoScrollForElements } from '@atlaskit/pragmatic-drag-and-drop-auto-scroll/element';
import { setCustomNativeDragPreview } from '@atlaskit/pragmatic-drag-and-drop/element/set-custom-native-drag-preview';
import { ChevronDown, Globe, Bot, Play, PanelLeft, Plus, StickyNote, RotateCw, Folder, ArrowUp, ArrowDown } from 'lucide-react';

const { ipcRenderer } = window.require('electron');

let forcedDragCursorDepth = 0;
let forcedDragCursorStyleEl: HTMLStyleElement | null = null;

const acquireForcedDragCursor = () => {
  if (typeof document === 'undefined') return;
  forcedDragCursorDepth += 1;
  if (forcedDragCursorStyleEl) return;
  forcedDragCursorStyleEl = document.createElement('style');
  forcedDragCursorStyleEl.setAttribute('data-tabbar-forced-drag-cursor', 'true');
  forcedDragCursorStyleEl.textContent = `
    html, body, body * {
      cursor: grabbing !important;
    }
  `;
  document.head.appendChild(forcedDragCursorStyleEl);
};

const releaseForcedDragCursor = () => {
  if (typeof document === 'undefined') return;
  forcedDragCursorDepth = Math.max(0, forcedDragCursorDepth - 1);
  if (forcedDragCursorDepth > 0) return;
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
  aiClosing?: boolean;
  isCollapsed?: boolean;
  groupId?: string;
  visualParentTabId?: string;
  parentTabId?: string;
  sessionStatus?: 'knowledge' | 'bugfix' | 'dev';
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
  tabRows: { tabId: string; rect: RectSnap }[];
};
type VerticalDragGeometry = {
  list: RectSnap;
  rows: Array<VerticalDragTabRow | VerticalDragGroupRow>;
};

const snapRect = (el: Element): RectSnap => {
  const r = el.getBoundingClientRect();
  return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, height: r.height, midY: r.top + r.height / 2 };
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

const getTabChromeColorConfig = (tab: Pick<TabData, 'color' | 'tabType'>) => {
  const base = TAB_COLORS.find(c => c.color === tab.color) || TAB_COLORS[0];
  return tab.tabType === 'claude-sdk' && tab.color === 'claude'
    ? { ...base, bgColor: 'rgba(210, 140, 90, 0.30)', borderColor: '#D28C5A' }
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
  onHoverChange,
  showNotesPeek = false,
  slideoutOpenHere = false,
  anySlideoutOpen = false,
  cmdPeekMode = false,
  isCollapsed = false,
  hasSession = false,
  isBusy = false,
  isAwaitingInput = false,
  sdkProcessAlive = false,
  isViewingSubAgent = false,
  orientation,
  sessionStatus,
}: TabItemProps) => {
  const ref = useRef<HTMLDivElement>(null);
  const [closestEdge, setClosestEdge] = useState<Edge | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [isPressing, setIsPressing] = useState(false);
  const [isAdoptTarget, setIsAdoptTarget] = useState(false);
  const bodyCursorRef = useRef<string | null>(null);

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

  // Check if a drag source is a Claude tab eligible for adoption onto this Gemini tab
  const isAdoptDrop = useCallback((sourceData: DragData) => {
    if (sourceData.type !== 'TAB') return false;
    if (commandType !== 'gemini') return false;
    const sourceTabId = sourceData.id;
    const state = useWorkspaceStore.getState();
    for (const [, ws] of state.openProjects) {
      const sourceTab = ws.tabs.get(sourceTabId);
      if (sourceTab) {
        return sourceTab.commandType === 'claude' && !sourceTab.parentTabId;
      }
    }
    return false;
  }, [commandType]);

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
          return attachClosestEdge(
            { type: 'TAB', id: tab.id, zone, index, groupId, groupIndex },
            { element, input, allowedEdges }
          );
        },
        canDrop: ({ source }) => source.data.type === 'TAB' || source.data.type === 'TAB_GROUP',
        onDragEnter: ({ source, self }) => {
          const sourceData = source.data as DragData;
          if (sourceData.type === 'TAB' && sourceData.id === tab.id) return;
          if (sourceData.type === 'TAB' && isAdoptDrop(sourceData)) {
            setIsAdoptTarget(true);
            setClosestEdge(null);
          } else {
            setClosestEdge(extractClosestEdge(self.data));
          }
        },
        onDrag: ({ source, self }) => {
          const sourceData = source.data as DragData;
          if (sourceData.type === 'TAB' && sourceData.id === tab.id) {
            setClosestEdge(null);
            setIsAdoptTarget(false);
            return;
          }
          if (sourceData.type === 'TAB' && isAdoptDrop(sourceData)) {
            setIsAdoptTarget(true);
            setClosestEdge(null);
          } else {
            setIsAdoptTarget(false);
            setClosestEdge(extractClosestEdge(self.data));
          }
        },
        onDragLeave: () => { setClosestEdge(null); setIsAdoptTarget(false); },
        onDrop: () => { setClosestEdge(null); setIsAdoptTarget(false); },
      })
    );
  }, [tab.id, zone, index, projectId, isAdoptDrop, isHorizontal, groupId, groupIndex]);

  const [isHovered, setIsHovered] = useState(false);

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
  const isVertActive = !isHorizontal && isActive;
  const getBgColor = () => {
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
    if (isHovered) {
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
  const isVerticalMode = !isHorizontal;
  const dragLiftActive = isVerticalMode && (isPressing || isDragging);

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
    color: (isActive || isHovered || isSelected) ? '#fff' : '#888',
    backgroundColor: getBgColor(),
    // Vertical mode: NO activity border — насыщенность фона сама показывает активную вкладку.
    // Interrupted (dashed blue) и selected (dashed white) сохраняем как маркеры состояния.
    borderTop: isHorizontal ? getTopBorder() : 'none',
    borderLeft: isVerticalMode
      ? (isInterrupted
        ? '2px dashed #3b82f6'
        : (isSelected && !isActive ? '2px dashed rgba(255,255,255,0.3)' : '2px solid transparent'))
      : 'none',
    opacity: isDragging ? (isVerticalMode ? 0.96 : 0.5) : (draggingGroupIds.includes(tab.id) && !isDragging ? 0.5 : (isCollapsed && !isActive ? 0.6 : 1)),
    transform: dragLiftActive ? 'scale(1.015)' : undefined,
    transformOrigin: 'center',
    transition: 'color 0.15s ease, background-color 0.15s ease, transform 90ms ease, box-shadow 90ms ease, opacity 0.12s ease',
    borderRight: isViewingSubAgent ? '2px solid rgba(168, 85, 247, 0.6)' : 'none',
    ...(dragLiftActive ? {
      boxShadow: '0 0 0 1px rgba(139, 92, 246, 0.55), 0 6px 18px rgba(0, 0, 0, 0.28)',
      backgroundColor: hasColor ? adjustAlpha(colorConfig.bgColor, 0.10) : 'rgba(139, 92, 246, 0.16)',
    } : {}),
    ...(isAdoptTarget ? {
      boxShadow: 'inset 0 0 0 1.5px rgba(99, 102, 241, 0.7)',
      backgroundColor: 'rgba(99, 102, 241, 0.15)',
    } : {}),
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
  // Settings → форма маркера статуса (круг или квадрат) + размер в px.
  const statusMarkerShape = useUIStore((s) => s.statusMarker.shape);
  const statusMarkerSize = useUIStore((s) => s.statusMarker.sizePx);

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
        <Bot size={14} style={{ color: getCollapsedIconColor(), flexShrink: 0 }} />
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
                    // -2px компенсирует 2px transparent border (резерв под dashed-states).
                    // Без этого полоска отрисовывается ВНУТРИ border-area → виден gap у края.
                    [processBarPosition === 'right' ? 'right' : 'left']: '-2px',
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
                  поведение TabItem root). Stop через middle-click недоступен — для остановки
                  процесса юзер открывает ПКМ → Stop, либо использует кнопки InfoPanel. */}
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
              {tab.aiClosing ? 'остановка сессии...' : tab.name}
            </span>
          )}

          {/* Restart button — для зелёных (devServer) вкладок с активным процессом
                занимает место notes-кнопки. Логика: зелёный таб обычно = npm run dev,
                заметок там почти не пишут, зато перезапуск из меню вкладки нужен часто.
                Mutex с notes: если рендерится restart — notes не рендерится. Кнопка
                делегирует в onRestart (детерминистический stop+!! в одном IPC).
                Пока stop в полёте — иконка крутится, click заблокирован. */}
          {isVerticalMode && tab.color === 'green' && hasProcess && (
            <button
              data-no-tab-drag
              onClick={(e) => {
                e.stopPropagation();
                if (isStopping) return;
                onRestart?.(tab.id);
              }}
              onMouseDown={(e) => e.stopPropagation()}
              onDoubleClick={(e) => e.stopPropagation()}
              title={isStopping ? 'Stopping…' : 'Restart process (kill descendants + ports, then re-run)'}
              className="flex-shrink-0 inline-flex items-center justify-center transition-colors"
              style={{
                width: 20,
                height: 18,
                marginLeft: 6,
                padding: 0,
                borderRadius: 4,
                backgroundColor: '#1e1e2e',
                color: isStopping ? '#666' : '#86efac',
                border: '1px solid rgba(34,197,94,0.25)',
                cursor: isStopping ? 'wait' : 'pointer',
              }}
              onMouseEnter={(e) => {
                if (isStopping) return;
                const el = e.currentTarget as HTMLButtonElement;
                el.style.backgroundColor = 'rgba(34,197,94,0.18)';
                el.style.color = '#bbf7d0';
              }}
              onMouseLeave={(e) => {
                if (isStopping) return;
                const el = e.currentTarget as HTMLButtonElement;
                el.style.backgroundColor = '#1e1e2e';
                el.style.color = '#86efac';
              }}
            >
              <RotateCw
                size={11}
                strokeWidth={2.2}
                style={isStopping ? { animation: 'tab-dot-spin 0.8s linear infinite' } : undefined}
              />
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
          {isVerticalMode && !(tab.color === 'green' && hasProcess) && (slideoutOpenHere || showNotesPeek || (isActive && !anySlideoutOpen && !cmdPeekMode)) && (() => {
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
                  if (slideoutOpenHere) return; // solid state — no hover swap
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

const TabGroupHeader = memo(({ group, count, projectId }: {
  group: TabGroup;
  count: number;
  projectId: string;
}) => {
  const ref = useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [isPressing, setIsPressing] = useState(false);
  const [isHovered, setIsHovered] = useState(false);
  const bodyCursorRef = useRef<string | null>(null);

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
        getData: ({ input, element }) => attachClosestEdge(
          { type: 'GROUP', groupId: group.id },
          { element, input, allowedEdges: ['top', 'bottom'] }
        ),
        canDrop: ({ source }) => source.data.type === 'TAB' || source.data.type === 'TAB_GROUP',
      })
    );
  }, [group.id, projectId]);

  const dragLiftActive = isPressing || isDragging;

  return (
    <div
      ref={ref}
      data-tab-group-header
      data-group-id={group.id}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 7,
        minHeight: 28,
        padding: '5px 8px',
        borderRadius: 7,
        cursor: dragLiftActive ? 'grabbing' : 'grab',
        userSelect: 'none',
        color: (isHovered || dragLiftActive) ? '#e5e7eb' : '#a1a1aa',
        backgroundColor: dragLiftActive ? 'rgba(139,92,246,0.16)' : (isHovered ? 'rgba(255,255,255,0.07)' : 'rgba(255,255,255,0.035)'),
        border: `1px solid ${dragLiftActive ? 'rgba(139,92,246,0.58)' : 'rgba(255,255,255,0.08)'}`,
        opacity: isDragging ? 0.96 : 1,
        transform: dragLiftActive ? 'scale(1.015)' : undefined,
        transformOrigin: 'center',
        boxShadow: dragLiftActive ? '0 0 0 1px rgba(139,92,246,0.32), 0 6px 18px rgba(0,0,0,0.28)' : 'none',
        transition: 'background-color 0.12s, color 0.12s, opacity 0.12s, transform 90ms ease, box-shadow 90ms ease, border-color 90ms ease',
      }}
      onMouseDown={(e) => {
        if (e.button !== 0) return;
        setIsPressing(true);
        setBodyGrabbing();
      }}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      title="Drag group"
    >
      <Folder size={13} strokeWidth={2} style={{ color: '#8b5cf6', flexShrink: 0 }} />
      <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12 }}>
        {group.name}
      </span>
      <span style={{ color: '#71717a', fontSize: 11, flexShrink: 0 }}>{count}</span>
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
  const renderedGroups = new Set<string>();

  for (const tab of mainTabs) {
    const groupId = tab.groupId && groupById.has(tab.groupId) ? tab.groupId : undefined;
    if (!groupId) {
      rows.push({ type: 'tab', tab, index: rows.length });
      continue;
    }
    if (renderedGroups.has(groupId)) continue;
    const group = groupById.get(groupId)!;
    const tabs = mainTabs.filter(candidate => candidate.groupId === groupId);
    renderedGroups.add(groupId);
    rows.push({ type: 'group', group, tabs, index: rows.length });
  }

  for (const group of tabGroups) {
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
  const renameTab = useWorkspaceStore((state) => state.renameTab);
  const setTabColor = useWorkspaceStore((state) => state.setTabColor);
  const setTabSessionStatus = useWorkspaceStore((state) => state.setTabSessionStatus);
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
  // tabNotes* font / padding теперь читаются внутри TabPreviewPopover.

  const [editingTabId, setEditingTabId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; tabId: string } | null>(null);
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
  const [processStatus, setProcessStatus] = useState<Map<string, boolean>>(new Map());
  // Tabs currently inside a deterministic stop/restart cycle. While in this set
  // the Restart / Stop buttons render disabled with a wait-cursor, so the user
  // can't fire a second stop while the first one is still polling for descendants
  // to die. Populated synchronously when handleRestart/handleStop is called,
  // cleared on `terminal:stop-progress { phase: 'done' }`.
  const [restartInFlight, setRestartInFlight] = useState<Set<string>>(new Set());
  const [sessionStatus, setSessionStatus] = useState<Map<string, boolean>>(new Map());
  const [claudeBusyMap, setClaudeBusyMap] = useState<Map<string, boolean>>(new Map());
  const [geminiBusyMap, setGeminiBusyMap] = useState<Map<string, boolean>>(new Map());
  const [codexBusyMap, setCodexBusyMap] = useState<Map<string, boolean>>(new Map());
  const [pasteBusyMap, setPasteBusyMap] = useState<Map<string, boolean>>(new Map());
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
      if (tab.tabType === 'claude-sdk') continue;

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
      setProcessStatus(prev => {
        const next = new Map(prev);
        next.set(tabId, true);
        return next;
      });
    };

    const handleCommandFinished = (_: any, { tabId }: { tabId: string }) => {
      setProcessStatus(prev => {
        const next = new Map(prev);
        next.set(tabId, false);
        return next;
      });
    };

    const handleSessionDetected = (_: any, data: { tabId: string; sessionId: string }) => {
      setSessionStatus(prev => {
        const next = new Map(prev);
        next.set(data.tabId, true);
        return next;
      });
    };

    const handleClaudeBusy = (_: any, { tabId, busy }: { tabId: string; busy: boolean }) => {
      console.warn('[TabBar:BusyState] tabId=' + tabId.slice(-8) + ' busy=' + busy);
      setClaudeBusyMap(prev => {
        if (prev.get(tabId) === busy) return prev;
        const next = new Map(prev);
        next.set(tabId, busy);
        return next;
      });
    };

    const handleGeminiBusy = (_: any, { tabId, busy }: { tabId: string; busy: boolean }) => {
      setGeminiBusyMap(prev => {
        if (prev.get(tabId) === busy) return prev;
        const next = new Map(prev);
        next.set(tabId, busy);
        return next;
      });
    };

    const handleCodexBusy = (_: any, { tabId, busy, reason }: { tabId: string; busy: boolean; reason?: string }) => {
      console.warn('[TabBar:CodexBusyState] tabId=' + tabId.slice(-8) + ' busy=' + busy + (reason ? ' reason=' + reason : ''));
      setCodexBusyMap(prev => {
        if (prev.get(tabId) === busy) return prev;
        const next = new Map(prev);
        next.set(tabId, busy);
        return next;
      });
    };

    const handlePasteBusy = (_: any, { tabId, busy }: { tabId: string; busy: boolean }) => {
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
    const handleClaudeBusyClearAwaiting = (_: any, { tabId, busy }: { tabId: string; busy: boolean }) => {
      if (busy) return;
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
    };
  }, []); // Stable — no re-subscriptions

  // Initial load + sync when tabs are added/removed
  // Merges into existing Map instead of replacing it
  useEffect(() => {
    if (!workspace) return;

    const tabIds = Array.from(workspace.tabs.keys());

    const syncStatus = async () => {
      await Promise.all(
        tabIds.map(async (tabId) => {
          try {
            const state = await ipcRenderer.invoke('terminal:getCommandState', tabId);
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
    };
    syncStatus();
  }, [workspace?.tabs.size]); // Sync new tabs, but never clobber existing state

  const captureVerticalDragGeometry = useCallback((): VerticalDragGeometry | null => {
    if (!isVerticalLayout) return null;
    const scroller = scrollContainerRef.current;
    const list = scroller?.querySelector<HTMLElement>('[data-vertical-main-list]');
    if (!scroller || !list) return null;

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
        const tabRows = Array.from(rowEl.querySelectorAll<HTMLElement>('[data-tab-group-body] [data-tab-item]'))
          .map(el => {
            const tabId = el.dataset.tabId;
            return tabId ? { tabId, rect: snapRect(el) } : null;
          })
          .filter((row): row is { tabId: string; rect: RectSnap } => !!row);
        rows.push({ type: 'group', groupId, rect: snapRect(rowEl), header: snapRect(header), tabRows });
      }
    }

    return { list: snapRect(scroller), rows };
  }, [isVerticalLayout]);

  const isAdoptDropTarget = useCallback((sourceData: DragData, targetData: any): boolean => {
    if (sourceData.type !== 'TAB' || targetData?.type !== 'TAB') return false;
    const currentWorkspace = useWorkspaceStore.getState().openProjects.get(projectId);
    if (!currentWorkspace) return false;
    const sourceTab = currentWorkspace.tabs.get(sourceData.id);
    const targetTab = currentWorkspace.tabs.get(targetData.id);
    return !!(sourceTab?.commandType === 'claude' && !sourceTab.parentTabId && targetTab?.commandType === 'gemini');
  }, [projectId]);

  const resolveStaticVerticalPreview = useCallback((sourceData: DragData, clientX: number, clientY: number, targetData?: any): DragPreviewLayout | null => {
    if (!isVerticalLayout) return null;
    if (sourceData.projectId && sourceData.projectId !== projectId) return null;
    if (sourceData.zone !== 'main') return null;
    if (isAdoptDropTarget(sourceData, targetData)) return null;

    let geometry = verticalDragGeometryRef.current;
    if (!geometry) {
      geometry = captureVerticalDragGeometry();
      verticalDragGeometryRef.current = geometry;
    }
    if (!geometry) return null;

    const list = geometry.list;
    if (clientX < list.left - 28 || clientX > list.right + 28 || clientY < list.top - 80 || clientY > list.bottom + 80) {
      return null;
    }

    const currentWorkspace = useWorkspaceStore.getState().openProjects.get(projectId);
    if (!currentWorkspace) return null;
    const baseTabs = orderTabsWithVisualChildren(
      Array.from(currentWorkspace.tabs.values()).filter(tab => !tab.parentTabId && !tab.isUtility)
    );
    const baseOrder = baseTabs.map(tab => tab.id);
    const tabById = new Map(baseTabs.map(tab => [tab.id, tab]));
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
    if (sourceIds.length === 0) return null;

    const sourceSet = new Set(sourceIds);
    const withoutSource = baseOrder.filter(id => !sourceSet.has(id));
    const groupAssignments: Record<string, string | null | undefined> = {};
    const visualParentAssignments: Record<string, string | null | undefined> = {};
    if (sourceData.type === 'TAB') {
      const selectedRoots = sourceData.selectedTabIds && sourceData.selectedTabIds.includes(sourceData.id)
        ? sourceData.selectedTabIds
        : [sourceData.id];
      for (const id of selectedRoots) {
        if (tabById.get(id)?.visualParentTabId) visualParentAssignments[id] = null;
      }
    }
    const makePreview = (orderedIds: string[]) => ({
      orderedIds,
      groupAssignments,
      visualParentAssignments,
    });
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
          index += row.tabRows.filter(tabRow => withoutSource.includes(tabRow.tabId)).length;
        }
      }
      return index;
    };
    const flatIndexFromY = () => {
      let flatIndex = geometry!.rows.length;
      for (let i = 0; i < geometry!.rows.length; i += 1) {
        const row = geometry!.rows[i];
        if (clientY < row.rect.midY) {
          flatIndex = i;
          break;
        }
      }
      return flatIndex;
    };
    const indexInGroup = (groupId: string, memberIndex: number, rowIndex: number) => {
      const members = withoutSource.filter(id => tabById.get(id)?.groupId === groupId);
      if (members.length === 0) return indexAtFlatPosition(rowIndex);
      const beforeId = members[memberIndex];
      if (beforeId) return withoutSource.indexOf(beforeId);
      return withoutSource.indexOf(members[members.length - 1]) + 1;
    };

    if (sourceData.type === 'TAB_GROUP') {
      const targetIndex = indexAtFlatPosition(flatIndexFromY());
      return makePreview(insertAt(withoutSource, sourceIds, targetIndex));
    }

    const assignFlat = (flatIndex: number) => {
      for (const id of sourceIds) groupAssignments[id] = null;
      return makePreview(insertAt(withoutSource, sourceIds, indexAtFlatPosition(flatIndex)));
    };
    const assignGroup = (groupId: string, memberIndex: number, rowIndex: number) => {
      for (const id of sourceIds) groupAssignments[id] = groupId;
      return makePreview(insertAt(withoutSource, sourceIds, indexInGroup(groupId, memberIndex, rowIndex)));
    };

    for (let rowIndex = 0; rowIndex < geometry.rows.length; rowIndex += 1) {
      const row = geometry.rows[rowIndex];
      if (row.type !== 'group') continue;
      if (clientY >= row.header.top && clientY <= row.header.bottom) {
        return clientY < row.header.midY
          ? assignFlat(rowIndex)
          : assignGroup(row.groupId, 0, rowIndex);
      }
      if (row.tabRows.length === 0) continue;
      const first = row.tabRows[0];
      const last = row.tabRows[row.tabRows.length - 1];
      if (clientY < row.header.bottom || clientY > row.rect.bottom) continue;
      if (clientY < first.rect.top - 8 || clientY > last.rect.bottom + 12) continue;
      let targetMemberIndex = 0;
      for (const tabRow of row.tabRows) {
        if (sourceSet.has(tabRow.tabId)) continue;
        if (clientY < tabRow.rect.midY) break;
        targetMemberIndex += 1;
      }
      return assignGroup(row.groupId, targetMemberIndex, rowIndex);
    }

    return assignFlat(flatIndexFromY());
  }, [captureVerticalDragGeometry, isAdoptDropTarget, isVerticalLayout, projectId]);

  // Monitor for all drag events
  useEffect(() => {
    return monitorForElements({
      canMonitor: ({ source }) => source.data.type === 'TAB' || source.data.type === 'TAB_GROUP',
      onDragStart({ source }) {
        const sourceData = source.data as DragData;
        verticalDragGeometryRef.current = sourceData.projectId === projectId ? captureVerticalDragGeometry() : null;
      },
      onDrag({ source, location }) {
        const target = location.current.dropTargets[0];
        const input = location.current.input;
        const preview = resolveStaticVerticalPreview(source.data as DragData, input.clientX, input.clientY, target?.data);
        const key = preview ? JSON.stringify(preview) : '';
        if (key !== dragPreviewKeyRef.current) {
          dragPreviewKeyRef.current = key;
          setDragPreview(preview);
        }
      },
      onDrop({ source, location }) {
        const sourceData = source.data as DragData;
        const target = location.current.dropTargets[0];
        const targetData = target?.data as any;
        const input = location.current.input;

        const preview = resolveStaticVerticalPreview(sourceData, input.clientX, input.clientY, targetData);
        if (preview) {
          applyTabLayout(projectId, preview.orderedIds, preview.groupAssignments, preview.visualParentAssignments);
          dragPreviewKeyRef.current = '';
          verticalDragGeometryRef.current = null;
          setDragPreview(null);
          return;
        }
        dragPreviewKeyRef.current = '';
        verticalDragGeometryRef.current = null;
        setDragPreview(null);
        if (!target) return;

        // Get fresh tabs from workspace (avoid stale closure)
        const currentWorkspace = useWorkspaceStore.getState().openProjects.get(projectId);
        if (!currentWorkspace) return;
        if (sourceData.type !== 'TAB') return;

        // ===== DETACH: sub-agent chip dropped back to TabBar → detach from parent =====
        const sourceTab = currentWorkspace.tabs.get(sourceData.id);
        if (sourceTab?.parentTabId) {
          const store = useWorkspaceStore.getState();
          store.setTabParent(sourceData.id, undefined as any);
          store.setViewingSubAgent(null);
          // Switch to detached tab — user dragged it to TabBar, they want to see it
          store.switchTab(projectId, sourceData.id);
          return;
        }
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
          // ===== ADOPT: Claude tab dropped on Gemini tab → adopt as sub-agent =====
          const targetTabId = targetData.id as string;
          const sourceTabId = sourceData.id;
          const currentWs = useWorkspaceStore.getState().openProjects.get(projectId);
          if (currentWs) {
            const sourceTab = currentWs.tabs.get(sourceTabId);
            const targetTab = currentWs.tabs.get(targetTabId);
            if (sourceTab?.commandType === 'claude' && !sourceTab.parentTabId &&
                targetTab?.commandType === 'gemini') {
              const { ipcRenderer } = window.require('electron');
              ipcRenderer.invoke('mcp:adopt-agent', { claudeTabId: sourceTabId, geminiTabId: targetTabId });
              // Switch to Gemini tab (adopted tab will vanish from TabBar)
              if (currentWs.activeTabId === sourceTabId) {
                useWorkspaceStore.getState().switchTab(projectId, targetTabId);
              }
              return; // Don't reorder
            }
          }

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
    if (editingTabId && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editingTabId]);

  // Consume pendingEditTabId set by createTab/createTabAfterCurrent to auto-enter rename mode
  useEffect(() => {
    if (!pendingEditTabId) return;
    const ws = useWorkspaceStore.getState().openProjects.get(projectId);
    if (!ws?.tabs.has(pendingEditTabId)) return;
    const tabName = ws.tabs.get(pendingEditTabId)?.name ?? '';
    setEditingTabId(pendingEditTabId);
    setEditValue(tabName);
    // Clear so other TabBar instances (other projects) don't also enter edit
    useWorkspaceStore.setState({ pendingEditTabId: null });
  }, [pendingEditTabId, projectId]);

  useEffect(() => {
    if (!contextMenu && !emptyContextMenu) return;
    const handleClose = (e: MouseEvent) => {
      // Don't close if clicking inside the context menu itself
      if ((e.target as HTMLElement).closest('[data-tab-context-menu]')) return;
      setContextMenu(null);
      setEmptyContextMenu(null);
    };
    // Use mousedown instead of click — xterm.js canvas swallows click events
    document.addEventListener('mousedown', handleClose);
    return () => document.removeEventListener('mousedown', handleClose);
  }, [contextMenu, emptyContextMenu]);

  // Clamp context menu position to viewport (same pattern as Timeline tooltip)
  useLayoutEffect(() => {
    if (!contextMenu || !contextMenuRef.current) return;
    const el = contextMenuRef.current;
    const rect = el.getBoundingClientRect();
    const pad = 8;
    let x = contextMenu.x;
    let y = contextMenu.y;

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
  }, [contextMenu, contextScripts.length]);

  if (!workspace || !project) return null;

  const allTabs = Array.from(workspace.tabs.values());
  // Hide sub-agent tabs (parentTabId set) — they are only shown in SubAgentBar
  const visibleTabs = allTabs.filter(t => !t.parentTabId);
  const mainTabsBase = visibleTabs.filter(t => !t.isUtility);
  const utilityTabs = visibleTabs.filter(t => t.isUtility);
  const tabGroups = workspace.tabGroups || [];
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
  const verticalRows = isVerticalLayout ? buildVerticalRows(mainTabsForDisplay, tabGroups) : [];

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
      if (await confirmCloseTabs(selectedTabIds)) {
        for (const id of selectedTabIds) {
          const tab = workspace?.tabs.get(id);
          await closeTab(projectId, id, { skipProcessCheck: true, forceCleanup: true, aiBusyOverride: tab ? isTabTurnBusy(tab) : undefined });
        }
      }
    } else {
      const tab = workspace?.tabs.get(tabId);
      closeTab(projectId, tabId, { aiBusyOverride: tab ? isTabTurnBusy(tab) : undefined });
    }
  };

  const handleDoubleClick = (tabId: string, currentName: string) => {
    setEditingTabId(tabId);
    setEditValue(currentName);
  };

  const handleContextMenu = (e: React.MouseEvent, tabId: string) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenuPos({ x: e.clientX, y: e.clientY });
    setContextMenu({ x: e.clientX, y: e.clientY, tabId });

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
  const runDeterministicStop = async (tabId: string, restart: boolean) => {
    setRestartInFlight(prev => {
      if (prev.has(tabId)) return prev;
      const next = new Set(prev);
      next.add(tabId);
      return next;
    });
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
      setRestartInFlight(prev => {
        if (!prev.has(tabId)) return prev;
        const next = new Set(prev);
        next.delete(tabId);
        return next;
      });
    }
  };

  const handleRestart = async (tabId: string) => {
    if (restartInFlight.has(tabId)) return;
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
    if (restartInFlight.has(tabId)) return;
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
    if (editingTabId && editValue.trim()) {
      renameTab(projectId, editingTabId, editValue.trim());
    }
    setEditingTabId(null);
    setEditValue('');
  };

  const handleRenameKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleRenameSubmit();
      refocusActiveTerminal();
    } else if (e.key === 'Escape') {
      setEditingTabId(null);
      setEditValue('');
      refocusActiveTerminal();
    }
  };

  const handleContextRename = () => {
    if (contextMenu) {
      const tab = workspace.tabs.get(contextMenu.tabId);
      if (tab) {
        setEditingTabId(contextMenu.tabId);
        setEditValue(tab.name);
      }
    }
    setContextMenu(null);
  };

  const handleContextClose = () => {
    if (contextMenu) {
      const tab = workspace.tabs.get(contextMenu.tabId);
      closeTab(projectId, contextMenu.tabId, { aiBusyOverride: tab ? isTabTurnBusy(tab) : undefined });
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
  const dropCooldownRef = useRef(false);

  // Monitor drag start/end for utils dropdown behavior
  useEffect(() => {
    return monitorForElements({
      canMonitor: ({ source }) => source.data.type === 'TAB' || source.data.type === 'TAB_GROUP',
      onDragStart: ({ source }) => {
        setIsDraggingTab(true);
        const data = source.data as DragData;
        if (data.type === 'TAB' && data.selectedTabIds && data.selectedTabIds.length > 1) {
          setDraggingGroupIds(data.selectedTabIds);
        }
      },
      onDrop: () => {
        setIsDraggingTab(false);
        setDraggingGroupIds([]);
        dragPreviewKeyRef.current = '';
        verticalDragGeometryRef.current = null;
        setDragPreview(null);
        dropCooldownRef.current = true;
        setTimeout(() => { dropCooldownRef.current = false; }, 100);
        // Close Utils if it was opened by hover (not manually)
        if (utilityExpanded && !utilityOpenedManually) {
          setUtilityExpanded(false);
        }
      },
    });
  }, [utilityExpanded, utilityOpenedManually]);

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
      canScroll: ({ source }) => source.data.type === 'TAB',
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
              setEmptyContextMenu({ x: e.clientX, y: e.clientY });
            }}
          />
        ) : (
          <div data-vertical-main-list className="flex flex-col" style={{ gap: `${tabSidebarGap}px`, padding: `${tabSidebarGap}px` }}>
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
                      if (!isMultiSelect) handleDoubleClick(tab.id, tab.name);
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
                    isAwaitingInput={awaitingMap.get(tab.id) || false}
                    sdkProcessAlive={!!tab.sdkProcessAlive}
                    onRestart={handleRestart}
                    onStop={handleStop}
                    isStopping={restartInFlight.has(tab.id)}
                    isInterrupted={isTabInterrupted(tab)}
                    draggingGroupIds={draggingGroupIds}
                    onHoverChange={(hovering, rect) => handleTabHoverChange(tab.id, hovering, rect)}
                    showNotesPeek={isCmdPressed && isMouseInTabBar && !!workspace.tabs.get(tab.id)?.notes}
                    slideoutOpenHere={openSlideoutTabId === tab.id}
                    anySlideoutOpen={anySlideoutOpen}
                    cmdPeekMode={isCmdPressed && isMouseInTabBar}
                    isCollapsed={!!tab.isCollapsed}
                    isViewingSubAgent={viewingSubAgentParentId === tab.id}
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
                return (
                  <div
                    key={tab.id}
                    data-visual-child-row
                    data-visual-depth={visualDepth}
                    style={{
                      position: 'relative',
                      marginLeft: indent,
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
                  <div key={row.tab.id} data-vertical-row data-row-type="tab" data-tab-id={row.tab.id}>
                    {renderTab(row.tab)}
                  </div>
                );
              }
              return (
                <div
                  key={row.group.id}
                  data-vertical-row
                  data-row-type="group"
                  data-group-id={row.group.id}
                  className="flex flex-col"
                  style={{ gap: `${tabSidebarGap}px` }}
                >
                  <TabGroupHeader group={row.group} count={row.tabs.length} projectId={projectId} />
                  {row.tabs.length > 0 && (
                    <div
                      data-tab-group-body
                      data-group-id={row.group.id}
                      className="flex flex-col"
                      style={{
                        gap: `${tabSidebarGap}px`,
                        marginLeft: 9,
                        paddingLeft: 7,
                        borderLeft: '1px solid rgba(139,92,246,0.22)',
                      }}
                    >
                      {row.tabs.map((tab, groupIndex) => renderTab(tab, row.group.id, groupIndex))}
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
              const currentTabs = mainTabsForDisplay.map(t => t.id);
              if (!currentTabs.includes(tabId)) return;
              const newOrder = currentTabs.filter(id => id !== tabId);
              newOrder.push(tabId);
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
              if (groupIds.length === 0) return;
              const currentTabs = orderTabsWithVisualChildren(
                Array.from(currentWorkspace.tabs.values()).filter(tab => !tab.parentTabId && !tab.isUtility)
              ).map(tab => tab.id);
              const newOrder = currentTabs.filter(id => !groupIds.includes(id));
              newOrder.push(...groupIds);
              applyTabLayout(projectId, newOrder, {});
            }}
            onHoverChange={setEmptyZoneHovered}
            onDoubleClick={handleNewTabAtEnd}
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
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
                    if (!isMultiSelect) handleDoubleClick(tab.id, tab.name);
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
                  isAwaitingInput={awaitingMap.get(tab.id) || false}
                  sdkProcessAlive={!!tab.sdkProcessAlive}
                  onRestart={handleRestart}
                  onStop={handleStop}
                  isStopping={restartInFlight.has(tab.id)}
                  isInterrupted={isTabInterrupted(tab)}
                  draggingGroupIds={draggingGroupIds}
                  onHoverChange={(hovering, rect) => handleTabHoverChange(tab.id, hovering, rect)}
                  showNotesPeek={isCmdPressed && isMouseInTabBar && !!workspace.tabs.get(tab.id)?.notes}
                slideoutOpenHere={openSlideoutTabId === tab.id}
                anySlideoutOpen={anySlideoutOpen}
                cmdPeekMode={isCmdPressed && isMouseInTabBar}
                  isCollapsed={!!tab.isCollapsed}
                  isViewingSubAgent={viewingSubAgentParentId === tab.id}
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
                      if (!isMultiSelect) {
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
                        isAwaitingInput={awaitingMap.get(tab.id) || false}
                        sdkProcessAlive={!!tab.sdkProcessAlive}
                        onRestart={handleRestart}
                        onStop={handleStop}
                        isStopping={restartInFlight.has(tab.id)}
                        isInterrupted={isTabInterrupted(tab)}
                        draggingGroupIds={draggingGroupIds}
                        onHoverChange={(hovering, rect) => handleTabHoverChange(tab.id, hovering, rect)}
                        showNotesPeek={isCmdPressed && isMouseInTabBar && !!workspace.tabs.get(tab.id)?.notes}
                slideoutOpenHere={openSlideoutTabId === tab.id}
                anySlideoutOpen={anySlideoutOpen}
                cmdPeekMode={isCmdPressed && isMouseInTabBar}
                        isCollapsed={!!tab.isCollapsed}
                        isViewingSubAgent={viewingSubAgentParentId === tab.id}
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
                      if (!isMultiSelect) {
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
                    isAwaitingInput={awaitingMap.get(tab.id) || false}
                    sdkProcessAlive={!!tab.sdkProcessAlive}
                    onRestart={handleRestart}
                    onStop={handleStop}
                    isStopping={restartInFlight.has(tab.id)}
                    isInterrupted={isTabInterrupted(tab)}
                    draggingGroupIds={draggingGroupIds}
                    onHoverChange={(hovering, rect) => handleTabHoverChange(tab.id, hovering, rect)}
                    showNotesPeek={isCmdPressed && isMouseInTabBar && !!workspace.tabs.get(tab.id)?.notes}
                slideoutOpenHere={openSlideoutTabId === tab.id}
                anySlideoutOpen={anySlideoutOpen}
                cmdPeekMode={isCmdPressed && isMouseInTabBar}
                    isCollapsed={!!tab.isCollapsed}
                    isViewingSubAgent={viewingSubAgentParentId === tab.id}
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
          className="fixed bg-[#2a2a2a] border border-[#444] shadow-2xl min-w-[180px] z-[100]"
          style={{ left: contextMenuPos.x, top: contextMenuPos.y }}
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
                if (await confirmCloseTabs(selectedTabIds)) {
                  for (const id of selectedTabIds) {
                    const tab = workspace.tabs.get(id);
                    await closeTab(projectId, id, { skipProcessCheck: true, forceCleanup: true, aiBusyOverride: tab ? isTabTurnBusy(tab) : undefined });
                  }
                }
              } else {
                handleContextClose();
              }
              setContextMenu(null);
            };

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
          {!isMultiSelect && (contextScripts.length > 0 || contextShScripts.length > 0 || (contextMenu && processStatus.get(contextMenu.tabId) && workspace.tabs.get(contextMenu.tabId)?.commandType === 'devServer')) && (
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

          {/* Copy Session(s) */}
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

          {/* Add / Remove Favorites */}
          {!isMultiSelect && (
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

      {/* Empty space context menu */}
      {emptyContextMenu && (
        <div
          className="fixed bg-[#2a2a2a] border border-[#444] shadow-2xl min-w-[180px] z-[100] rounded-md overflow-hidden"
          style={{ left: emptyContextMenu.x, top: emptyContextMenu.y }}
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
              createTabGroup(projectId);
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
