import React, { useState, useRef, useEffect, useLayoutEffect, memo, useCallback, useMemo } from 'react';
import { useWorkspaceStore, TabColor, isTabInterrupted } from '../../store/useWorkspaceStore';
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
import { ChevronDown, Globe, Bot, Play, Minimize2, Maximize2, PanelLeft, Plus, StickyNote } from 'lucide-react';

const { ipcRenderer } = window.require('electron');

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
  tabType?: string;
  isCollapsed?: boolean;
  parentTabId?: string;
  sessionStatus?: 'knowledge' | 'bugfix' | 'dev';
}

type DragData = {
  type: 'TAB';
  id: string;
  zone: 'main' | 'utility';
  index: number;
  projectId?: string; // For cross-project drag
  selectedTabIds?: string[]; // For multi-tab drag
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
];


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
const RestartZone = memo(({ hasProcess, hasColor, commandType, hasSession, isBusy, onRestart, onStop }: {
  hasProcess: boolean;
  hasColor: boolean;
  commandType?: string;
  hasSession?: boolean;
  isBusy?: boolean;
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
      }}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      onClick={(e) => {
        if (showRestart) {
          e.stopPropagation();
          onRestart();
        }
      }}
      onAuxClick={(e) => {
        if (e.button === 1 && showRestart) {
          e.preventDefault();
          e.stopPropagation();
          onStop();
        }
      }}
    >
      {hasProcess ? (
        isHovered && showRestart ? (
          // Restart button when hovered (only for devServer)
          <Tooltip content="Restart (Ctrl+C → !! → Enter)">
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
          ((commandType === 'claude' || commandType === 'gemini') && isBusy) ? (
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
                backgroundColor: (commandType === 'claude' && !hasSession) ? '#f87171' : '#4ade80',
                opacity: hasColor ? 0.9 : 0.8,
                boxShadow: (commandType === 'claude' && !hasSession)
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
  fontSize: number;
  hasProcess?: boolean; // Whether tab has a running process
  commandType?: string; // Type of command running (devServer, claude, gemini, generic)
  onRestart?: (tabId: string) => void; // Restart process (Ctrl+C, Up, Enter)
  onStop?: (tabId: string) => void; // Stop process (Ctrl+C only, no restart)
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
  isViewingSubAgent?: boolean; // User is viewing a sub-agent of this tab
  orientation?: 'horizontal' | 'vertical'; // Layout direction. Main-zone defaults to horizontal,
                                            // utility-zone (dropdown) defaults to vertical. TabSidebar
                                            // overrides main-zone to vertical.
  sessionStatus?: SessionStatus; // Status marker color (vertical mode only).
}

const TabItem = memo(({
  tab,
  index,
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
  fontSize,
  hasProcess = false,
  commandType,
  onRestart,
  onStop,
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
  isViewingSubAgent = false,
  orientation,
  sessionStatus,
}: TabItemProps) => {
  const ref = useRef<HTMLDivElement>(null);
  const [closestEdge, setClosestEdge] = useState<Edge | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [isAdoptTarget, setIsAdoptTarget] = useState(false);

  // Check if a drag source is a Claude tab eligible for adoption onto this Gemini tab
  const isAdoptDrop = useCallback((sourceData: DragData) => {
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
          return { type: 'TAB', id: tab.id, zone, index, projectId, selectedTabIds: tabIds };
        },
        onGenerateDragPreview: ({ nativeSetDragImage }) => {
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
        onDragStart: () => setIsDragging(true),
        onDrop: () => setIsDragging(false),
      }),
      dropTargetForElements({
        element,
        getData: ({ input, element }) => {
          return attachClosestEdge(
            { type: 'TAB', id: tab.id, zone, index },
            { element, input, allowedEdges }
          );
        },
        canDrop: ({ source }) => source.data.type === 'TAB',
        onDragEnter: ({ source, self }) => {
          const sourceData = source.data as DragData;
          if (sourceData.id === tab.id) return;
          if (isAdoptDrop(sourceData)) {
            setIsAdoptTarget(true);
            setClosestEdge(null);
          } else {
            setClosestEdge(extractClosestEdge(self.data));
          }
        },
        onDrag: ({ source, self }) => {
          const sourceData = source.data as DragData;
          if (sourceData.id === tab.id) {
            setClosestEdge(null);
            setIsAdoptTarget(false);
            return;
          }
          if (isAdoptDrop(sourceData)) {
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
  }, [tab.id, zone, index, projectId, isAdoptDrop, isHorizontal]);

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

  // Build inline styles - full control to avoid Tailwind conflicts
  const tabStyle: React.CSSProperties = {
    position: 'relative',
    display: 'flex',
    alignItems: 'center',
    justifyContent: isVerticalMode ? 'flex-start' : 'center',
    gap: isCollapsed ? '0' : '8px',
    cursor: 'pointer',
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
    opacity: isDragging ? 0.5 : (draggingGroupIds.includes(tab.id) && !isDragging ? 0.5 : (isCollapsed && !isActive ? 0.6 : 1)),
    transition: 'color 0.15s ease, background-color 0.15s ease',
    borderRight: isViewingSubAgent ? '2px solid rgba(168, 85, 247, 0.6)' : 'none',
    ...(isAdoptTarget ? {
      boxShadow: 'inset 0 0 0 1.5px rgba(99, 102, 241, 0.7)',
      backgroundColor: 'rgba(99, 102, 241, 0.15)',
    } : {}),
  };

  // Vertical mode разделяет два сигнала:
  //   hasProcess (PTY жив) → узкая 2px полоса слева мигает.
  //     PTY-источники: terminal:command-started/finished (claude CLI, npm run dev, bash, gemini CLI).
  //   isBusy (AI «думает»/стримит)   → горизонтальный shimmer по ВСЕЙ ширине вкладки.
  //     AI-источники: claude:busy-state, gemini:busy-state, claude-sdk:busy-state.
  //   SDK claude — нет PTY → hasProcess=false. Sole сигнал — isBusy → только shimmer.
  //   Если оба true (PTY claude думает) — рендерятся оба: полоса слева + shimmer.
  const verticalHasProcess = hasProcess;
  const verticalIsAiBusy = isBusy;
  // Lookup status definition by id из глобального стора.
  // useUIStore делает гранулярный subscribe — TabItem ре-рендерится только когда
  // массив sessionStatuses изменится (юзер отредактировал палитру в SettingsModal).
  const sessionStatuses = useUIStore((s) => s.sessionStatuses);
  const statusMeta = sessionStatus
    ? sessionStatuses.find((s) => s.id === sessionStatus)
    : null;
  // processBar.enabled управляет тем, мигает ли полоска или статичная.
  // position — left|right (юзер выбирает в Settings).
  // Цвета/duration читаются через CSS-переменные на :root (App.tsx синхронизирует).
  const processBarEnabled = useUIStore((s) => s.processBar.enabled);
  const processBarPosition = useUIStore((s) => s.processBar.position);
  // Settings → форма маркера статуса (круг или квадрат) + размер в px.
  const statusMarkerShape = useUIStore((s) => s.statusMarker.shape);
  const statusMarkerSize = useUIStore((s) => s.statusMarker.sizePx);

  return (
    <div
      ref={ref}
      className="group"
      data-tab-item
      style={tabStyle}
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
              {/* Process bar — runs along the full tab height, 3px wide. Pulse animation
                  via globals.css class `tab-process-bar-busy`. Triggers ONLY by PTY-process
                  presence (hasProcess) — НЕ AI-busy.
                  Если processBarEnabled=false (Settings → отключил мигание) — статичный
                  класс tab-process-bar-static красит фон без анимации. */}
              {verticalHasProcess && (
                <div
                  className={processBarEnabled ? 'tab-process-bar-busy' : 'tab-process-bar-static'}
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
                    // Закруглённые углы только на «своей» стороне вкладки.
                    ...(processBarPosition === 'right'
                      ? { borderTopRightRadius: tabGeo.borderRadius, borderBottomRightRadius: tabGeo.borderRadius }
                      : { borderTopLeftRadius: tabGeo.borderRadius, borderBottomLeftRadius: tabGeo.borderRadius }),
                  }}
                />
              )}
              {/* AI-busy shimmer — full-tab horizontal sweep. Triggers when AI session
                  is thinking/streaming (claude:busy-state / gemini:busy-state /
                  claude-sdk:busy-state). Works for SDK tabs which have no PTY at all. */}
              {verticalIsAiBusy && (
                <div
                  className="tab-ai-busy-shimmer"
                  style={{
                    position: 'absolute',
                    // Растягиваемся НА border-area (включая 2px transparent border-left/right
                    // вкладки), чтобы скругления shimmer'а совпали со скруглениями карточки.
                    // Без этого слева видна 2px-полоска без shimmer + curved-corners рассинхрон.
                    top: 0,
                    bottom: 0,
                    left: '-2px',
                    right: '-2px',
                    pointerEvents: 'none',
                    zIndex: 3,
                    overflow: 'hidden',
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
              onClick={(e) => e.stopPropagation()}
            />
          ) : (
            <span className="select-none whitespace-nowrap overflow-hidden text-ellipsis flex items-center gap-1" style={{ flex: isHorizontal ? 'none' : 1 }}>
              {tab.tabType === 'browser' && <Globe size={12} className="flex-shrink-0 opacity-60" />}
              {tab.name}
            </span>
          )}

          {/* Open notes — peek-button. Three visibility rules:
                1. slideoutOpenHere — slideout is anchored to this tab (solid-indigo, always visible).
                2. showNotesPeek — Cmd is held, cursor in TabBar, tab has notes (Cmd-hover peek).
                3. Default-on-active — active tab in vertical mode, but ONLY when (a) no slideout
                   is open on another tab AND (b) we're NOT in peek-mode. Peek-mode means "buttons
                   only where there are notes" — keeping the default-on-active button on an empty
                   active tab during peek would break that rule.
              The data-tab-id attribute lets TabNotesSlideout query the EXACT trigger for its
              anchor (multiple peek buttons can be on screen at once when Cmd is held). */}
          {isVerticalMode && (slideoutOpenHere || showNotesPeek || (isActive && !anySlideoutOpen && !cmdPeekMode)) && (
            <button
              data-tab-notes-open-trigger
              data-tab-id={tab.id}
              onClick={(e) => {
                e.stopPropagation();
                const cur = useUIStore.getState().notesPanelOpenTabs[tab.id] ?? false;
                useUIStore.getState().setNotesPanelOpen(tab.id, !cur);
              }}
              title="Open notes (Cmd+E)"
              className="flex-shrink-0 inline-flex items-center justify-center cursor-pointer transition-colors"
              style={{
                width: 20,
                height: 18,
                marginLeft: 6,
                padding: 0,
                borderRadius: 4,
                backgroundColor: slideoutOpenHere ? '#6366f1' : '#1e1e2e',
                color: slideoutOpenHere ? '#fff' : '#a5b4fc',
                border: slideoutOpenHere
                  ? '1px solid #6366f1'
                  : '1px solid rgba(99,102,241,0.25)',
              }}
              onMouseEnter={(e) => {
                if (slideoutOpenHere) return; // solid state — no hover swap
                const el = e.currentTarget as HTMLButtonElement;
                el.style.backgroundColor = '#2a2a3e';
                el.style.color = '#c7d2fe';
              }}
              onMouseLeave={(e) => {
                if (slideoutOpenHere) return;
                const el = e.currentTarget as HTMLButtonElement;
                el.style.backgroundColor = '#1e1e2e';
                el.style.color = '#a5b4fc';
              }}
            >
              <StickyNote size={11} strokeWidth={2} />
            </button>
          )}
        </>
      )}

      {/* Absolute overlay indicator - doesn't affect layout */}
      {closestEdge && <DropIndicatorLine edge={closestEdge} />}
      {forceRightIndicator && !closestEdge && <DropIndicatorLine edge="right" />}
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

// Empty area drop zone - for dropping at the end of tabs (works for both reorder and move from utility)
const EmptyDropZone = memo(({ onDropMain, onDropFromUtility, onHoverChange, onDoubleClick, onContextMenu, orientation = 'horizontal' }: {
  onDropMain: (tabId: string) => void;
  onDropFromUtility: (tabId: string) => void;
  onHoverChange: (isOver: boolean) => void;
  onDoubleClick?: () => void;
  onContextMenu?: (e: React.MouseEvent) => void;
  orientation?: 'horizontal' | 'vertical';
}) => {
  const ref = useRef<HTMLDivElement>(null);
  const [isOver, setIsOver] = useState(false);
  const [isHovered, setIsHovered] = useState(false);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;

    return dropTargetForElements({
      element,
      getData: () => ({ type: 'EMPTY_ZONE' }),
      canDrop: ({ source }) => source.data.type === 'TAB',
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
        if (data.zone === 'main') {
          onDropMain(data.id);
        } else if (data.zone === 'utility') {
          onDropFromUtility(data.id);
        }
        setIsOver(false);
        onHoverChange(false);
      },
    });
  }, [onDropMain, onDropFromUtility, onHoverChange]);

  // Horizontal: fill remaining row (h-full flex-1 min-w-[30px]).
  // Vertical: fill remaining column space + show discoverable «+ New tab» row at the
  // top (вкладка-плейсхолдер с dashed border). В horizontal mode «add new» доступен
  // через ПКМ → Add new; в vertical он не очевиден, поэтому показываем кликабельную
  // строку всегда. Click = создать вкладку, drop-target по всей высоте остаётся.
  if (orientation === 'vertical') {
    return (
      <div
        ref={ref}
        className={`flex-1 w-full min-h-[30px] transition-colors ${isOver ? 'bg-white/10' : ''}`}
        onContextMenu={onContextMenu}
      >
        <div
          onClick={onDoubleClick}
          onMouseEnter={() => setIsHovered(true)}
          onMouseLeave={() => setIsHovered(false)}
          title="New tab (Cmd+T)"
          style={{
            margin: '4px 0',
            padding: '4px 8px 4px 12px',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            fontSize: 13,
            color: isHovered ? '#fff' : '#777',
            backgroundColor: isHovered ? 'rgba(255,255,255,0.06)' : 'transparent',
            border: '1px dashed rgba(255,255,255,0.18)',
            borderRadius: 6,
            cursor: 'pointer',
            userSelect: 'none',
            transition: 'background-color 0.12s, color 0.12s',
          }}
        >
          <span style={{ fontSize: 16, lineHeight: 1 }}>+</span>
          <span>New tab</span>
        </div>
      </div>
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
const EmptyMainZone = memo(({ onDrop }: { onDrop: (tabId: string) => void }) => {
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

function TabBar({ projectId, layout = 'horizontal' }: TabBarProps) {
  const isVerticalLayout = layout === 'vertical';
  // Use individual selectors to minimize re-renders
  const openProjects = useWorkspaceStore((state) => state.openProjects);
  const createTab = useWorkspaceStore((state) => state.createTab);
  const createTabAfterCurrent = useWorkspaceStore((state) => state.createTabAfterCurrent);
  const closeTab = useWorkspaceStore((state) => state.closeTab);
  const switchTab = useWorkspaceStore((state) => state.switchTab);
  const renameTab = useWorkspaceStore((state) => state.renameTab);
  const setTabColor = useWorkspaceStore((state) => state.setTabColor);
  const setTabSessionStatus = useWorkspaceStore((state) => state.setTabSessionStatus);
  const toggleTabUtility = useWorkspaceStore((state) => state.toggleTabUtility);
  const toggleTabCollapsed = useWorkspaceStore((state) => state.toggleTabCollapsed);
  const reorderInZone = useWorkspaceStore((state) => state.reorderInZone);
  const moveTabToZone = useWorkspaceStore((state) => state.moveTabToZone);
  const toggleTabSelection = useWorkspaceStore((state) => state.toggleTabSelection);
  const selectTabRange = useWorkspaceStore((state) => state.selectTabRange);
  const clearSelection = useWorkspaceStore((state) => state.clearSelection);
  
  const { projects } = useProjectsStore();
  const setProjectView = useWorkspaceStore((state) => state.setProjectView);
  const setSidebarOpen = useWorkspaceStore((state) => state.setSidebarOpen);
  const getSidebarState = useWorkspaceStore((state) => state.getSidebarState);
  const createSDKTab = useWorkspaceStore((state) => state.createSDKTab);
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
  const [processStatus, setProcessStatus] = useState<Map<string, boolean>>(new Map());
  const [sessionStatus, setSessionStatus] = useState<Map<string, boolean>>(new Map());
  const [claudeBusyMap, setClaudeBusyMap] = useState<Map<string, boolean>>(new Map());
  const [geminiBusyMap, setGeminiBusyMap] = useState<Map<string, boolean>>(new Map());
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

  const handleTabClick = (e: React.MouseEvent, tabId: string) => {
    if (e.shiftKey) {
      selectTabRange(projectId, tabId);
    } else if (e.metaKey || e.ctrlKey) {
      toggleTabSelection(projectId, tabId, true);
    } else {
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

    ipcRenderer.on('terminal:command-started', handleCommandStarted);
    ipcRenderer.on('terminal:command-finished', handleCommandFinished);
    ipcRenderer.on('claude:session-detected', handleSessionDetected);
    ipcRenderer.on('claude:busy-state', handleClaudeBusy);
    ipcRenderer.on('gemini:busy-state', handleGeminiBusy);

    return () => {
      ipcRenderer.removeListener('terminal:command-started', handleCommandStarted);
      ipcRenderer.removeListener('terminal:command-finished', handleCommandFinished);
      ipcRenderer.removeListener('claude:session-detected', handleSessionDetected);
      ipcRenderer.removeListener('claude:busy-state', handleClaudeBusy);
      ipcRenderer.removeListener('gemini:busy-state', handleGeminiBusy);
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

  // Monitor for all drag events
  useEffect(() => {
    return monitorForElements({
      canMonitor: ({ source }) => source.data.type === 'TAB',
      onDrop({ source, location }) {
        const target = location.current.dropTargets[0];
        if (!target) return;

        const sourceData = source.data as DragData;
        const targetData = target.data as any;

        // Get fresh tabs from workspace (avoid stale closure)
        const currentWorkspace = useWorkspaceStore.getState().openProjects.get(projectId);
        if (!currentWorkspace) return;

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
  }, [projectId, moveTabToZone, reorderInZone]);

  useEffect(() => {
    if (editingTabId && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editingTabId]);

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
  const mainTabs = visibleTabs.filter(t => !t.isUtility);
  const utilityTabs = visibleTabs.filter(t => t.isUtility);

  const handleNewTab = () => {
    // Get current tab's cwd
    const activeTab = workspace.activeTabId ? workspace.tabs.get(workspace.activeTabId) : null;
    const cwd = activeTab?.cwd || project.path;
    // Pass undefined for name to use smart naming (tab-1, tab-2, etc.)
    createTabAfterCurrent(projectId, undefined, cwd);
    setProjectView(projectId, 'terminal');
  };

  // Create new tab at the end of tabs list (for double-click on empty space)
  const handleNewTabAtEnd = () => {
    const activeTab = workspace.activeTabId ? workspace.tabs.get(workspace.activeTabId) : null;
    const cwd = activeTab?.cwd || project.path;
    createTab(projectId, undefined, cwd);
    setProjectView(projectId, 'terminal');
  };

  const handleCloseTab = async (e: React.MouseEvent, tabId: string) => {
    e.stopPropagation();
    // If multi-select and clicked tab is among selected — close all selected
    if (isMultiSelect && selectedTabIds.includes(tabId)) {
      const running: { id: string; name: string }[] = [];
      for (const id of selectedTabIds) {
        const state = await ipcRenderer.invoke('terminal:getCommandState', id);
        if (state.isRunning) {
          const { processName } = await ipcRenderer.invoke('terminal:hasRunningProcess', id);
          running.push({ id, name: processName || 'unknown' });
        }
      }

      let confirmed = true;
      if (running.length > 0) {
        confirmed = window.confirm(
          `${running.length} tab(s) have running processes:\n${running.map(r => `\u2022 ${r.name}`).join('\n')}\n\nClose all ${selectedTabIds.length} tabs?`
        );
      } else {
        confirmed = window.confirm(`Close ${selectedTabIds.length} tabs?`);
      }

      if (confirmed) {
        for (const id of selectedTabIds) {
          await closeTab(projectId, id, { skipProcessCheck: true, forceCleanup: true });
        }
      }
    } else {
      closeTab(projectId, tabId);
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

  // Restart process: Ctrl+C → delay → !! (repeat last command)
  // When "kill dev-ports" toggle is on, prepend `lsof | kill -9` command in the SAME
  // shell session before the actual npm-script line. Wrapping into one composite line:
  //   `lsof -ti:5181 -ti:3000 2>/dev/null | xargs kill -9 2>/dev/null; npm run dev`
  // ...is the right pattern because:
  //   1. Visible in scrollback — user sees what got freed
  //   2. Sequential by shell semantics, not by setTimeout race — `;` guarantees kill
  //      finishes before `npm run dev` starts (kernel TIME_WAIT freed in same tick)
  //   3. Lands in shell history, so re-up arrow gives same kill+run combo
  // Returns the prefix string to prepend (`...; ` ready to concat), or '' if disabled / no ports.
  const buildKillPortsPrefix = async (tabId: string): Promise<string> => {
    if (!useUIStore.getState().freePortsBeforeStart) return '';
    const tab = workspace.tabs.get(tabId);
    const cwd = tab?.cwd;
    if (!cwd) return '';
    try {
      const res = await ipcRenderer.invoke('system:detect-project-ports', cwd);
      const ports: number[] = res?.ports || [];
      if (ports.length === 0) return '';
      // -ti collapses multiple -ti flags? No — must be `lsof -ti:port` per port separated by space-style.
      // Cleanest portable form: `lsof -ti:5181,3000` (comma list — supported by lsof on macOS/Linux).
      const lsofArg = ports.join(',');
      return `lsof -ti:${lsofArg} 2>/dev/null | xargs -r kill -9 2>/dev/null; `;
    } catch (e) {
      console.warn('[TabBar] detect-ports failed for', tabId, e);
      return '';
    }
  };

  const handleRestart = async (tabId: string) => {
    // Ctrl+C first — shell prompt returns, then we can type the composite kill+!! line.
    // Compositing kill into a single visible shell line (instead of fire-and-forget IPC)
    // lets the user see what ports were freed and removes setTimeout race vs port release.
    ipcRenderer.send('terminal:input', tabId, '\x03');
    const killPrefix = await buildKillPortsPrefix(tabId);
    setTimeout(() => {
      // `lsof -ti:... | xargs kill -9; !!` — shell semicolon guarantees kill finishes
      // before `!!` re-runs the previous command. No timing assumption.
      ipcRenderer.send('terminal:input', tabId, `${killPrefix}!!\r`);
    }, 300);
  };

  // Stop process: Ctrl+C, then optionally kill leaked ports as a separate visible line.
  // User often hits Stop because the process is stuck holding the port; the explicit
  // kill line confirms what was freed in the scrollback.
  const handleStop = async (tabId: string) => {
    // SDK tabs have no PTY — cancel the in-process query instead of writing Ctrl+C
    // into a non-existent terminal. claude-sdk:stop closes the AbortController which
    // makes the streaming for-await loop bail; ClaudeSDKTab's :done handler then
    // flips isRunning=false so the loader pill clears.
    const tab = workspace.tabs.get(tabId);
    if (tab?.tabType === 'claude-sdk') {
      try {
        await ipcRenderer.invoke('claude-sdk:stop', { tabId });
        // Surface the Resume affordance in the composer (history kept intact).
        window.dispatchEvent(new CustomEvent('claude-sdk:was-stopped', { detail: { tabId } }));
      } catch (e: any) { console.error('[TabBar:SDKStop] error', e); }
      return;
    }
    ipcRenderer.send('terminal:input', tabId, '\x03');
    const killPrefix = await buildKillPortsPrefix(tabId);
    if (killPrefix) {
      // Strip the trailing `; ` to make it a standalone line (without a pending `!!`).
      const standalone = killPrefix.replace(/;\s*$/, '');
      setTimeout(() => {
        ipcRenderer.send('terminal:input', tabId, `${standalone}\r`);
      }, 300);
    }
  };

  const handleRenameSubmit = () => {
    if (editingTabId && editValue.trim()) {
      renameTab(projectId, editingTabId, editValue.trim());
    }
    setEditingTabId(null);
    setEditValue('');
  };

  const handleRenameKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') handleRenameSubmit();
    else if (e.key === 'Escape') {
      setEditingTabId(null);
      setEditValue('');
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
    if (contextMenu) closeTab(projectId, contextMenu.tabId);
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
      canMonitor: ({ source }) => source.data.type === 'TAB',
      onDragStart: ({ source }) => {
        setIsDraggingTab(true);
        const data = source.data as DragData;
        if (data.selectedTabIds && data.selectedTabIds.length > 1) {
          setDraggingGroupIds(data.selectedTabIds);
        }
      },
      onDrop: () => {
        setIsDraggingTab(false);
        setDraggingGroupIds([]);
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
        {mainTabs.length === 0 ? (
          <EmptyMainZone onDrop={(tabId) => moveTabToZone(projectId, tabId, false, 0)} />
        ) : (
          <div className="flex flex-col" style={{ gap: `${tabSidebarGap}px`, padding: `${tabSidebarGap}px` }}>
            {mainTabs.map((tab, index) => (
              <TabItem
                key={tab.id}
                tab={tab}
                index={index}
                zone="main"
                projectId={projectId}
                orientation="vertical"
                sessionStatus={tab.sessionStatus as SessionStatus | undefined}
                isActive={currentView === 'terminal' && workspace.activeTabId === tab.id}
                isSelected={selectedTabIds.includes(tab.id)}
                isEditing={editingTabId === tab.id}
                editValue={editValue}
                onSwitch={(e) => {
                  handleTabClick(e, tab.id);
                  setProjectView(projectId, 'terminal');
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
                hasProcess={processStatus.get(tab.id) || false}
                commandType={tab.commandType}
                hasSession={sessionStatus.get(tab.id) || !!tab.claudeSessionId}
                isBusy={(tab.commandType === 'gemini' ? geminiBusyMap.get(tab.id) : claudeBusyMap.get(tab.id)) || false}
                onRestart={handleRestart}
                onStop={handleStop}
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
        {/* Empty drop zone at end — captures drops after last tab + double-click = new tab */}
        {mainTabs.length > 0 && (
          <EmptyDropZone
            orientation="vertical"
            onDropMain={(tabId) => {
              const currentTabs = mainTabs.map(t => t.id);
              if (!currentTabs.includes(tabId)) return;
              const newOrder = currentTabs.filter(id => id !== tabId);
              newOrder.push(tabId);
              reorderInZone(projectId, 'main', newOrder);
            }}
            onDropFromUtility={(tabId) => {
              moveTabToZone(projectId, tabId, false, mainTabs.length);
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
                    setProjectView(projectId, 'terminal');
                  }}
                  onClose={() => closeTab(projectId, tab.id)}
                  onDoubleClick={() => {
                    if (!isMultiSelect) handleDoubleClick(tab.id, tab.name);
                  }}
                  onContextMenu={(e) => handleContextMenu(e, tab.id)}
                  onEditChange={setEditValue}
                  onEditSubmit={handleRenameSubmit}
                  onEditKeyDown={handleRenameKeyDown}
                  inputRef={inputRef as React.RefObject<HTMLInputElement>}
                  fontSize={tabsFontSize}
                  hasProcess={processStatus.get(tab.id) || false}
                  commandType={tab.commandType}
                  hasSession={sessionStatus.get(tab.id) || !!tab.claudeSessionId}
                  isBusy={(tab.commandType === 'gemini' ? geminiBusyMap.get(tab.id) : claudeBusyMap.get(tab.id)) || false}
                  onRestart={handleRestart}
                  onStop={handleStop}
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
                          if (!e.shiftKey && !e.metaKey && !e.ctrlKey) {
                            setUtilityExpanded(false); // Close dropdown only on direct switch
                          }
                          setProjectView(projectId, 'terminal');
                        }}
                        onClose={() => closeTab(projectId, tab.id)} // Close tab, not move to main
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
                        hasProcess={processStatus.get(tab.id) || false}
                        commandType={tab.commandType}
                        hasSession={sessionStatus.get(tab.id) || !!tab.claudeSessionId}
                        isBusy={(tab.commandType === 'gemini' ? geminiBusyMap.get(tab.id) : claudeBusyMap.get(tab.id)) || false}
                        onRestart={handleRestart}
                        onStop={handleStop}
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
                      setProjectView(projectId, 'terminal');
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
                    hasProcess={processStatus.get(tab.id) || false}
                    commandType={tab.commandType}
                    hasSession={sessionStatus.get(tab.id) || !!tab.claudeSessionId}
                    isBusy={(tab.commandType === 'gemini' ? geminiBusyMap.get(tab.id) : claudeBusyMap.get(tab.id)) || false}
                    onRestart={handleRestart}
                    onStop={handleStop}
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
              onDoubleClick={handleNewTabAtEnd}
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
          {/* Close Tab(s) + optional Stop split. Stop visible only when at
              least one tab in selection has a running Claude or Gemini
              process. shell/dev-server are out of scope \u2014 dev-server uses
              middle-click Stop in RestartZone, bash has no graceful stop hook. */}
          {(() => {
            // Canonical AI tints used elsewhere in the app:
            // Claude #DA7756 = Provider row primary (InfoPanel)
            // Gemini  #4E86F8 = TAB_COLORS.gemini, ApiSettingsModal, ActionsPanel copy accent
            const CLAUDE_TINT = '#DA7756';
            const GEMINI_TINT = '#4E86F8';

            // Tabs targeted by Stop = either the single right-clicked tab, or
            // all selected tabs when right-click happened on a selected one
            // (isMultiSelect already gates this). We count Claude/Gemini
            // separately so the badge can show majority+minority split.
            const targetTabIds = isMultiSelect ? selectedTabIds : (contextMenu ? [contextMenu.tabId] : []);
            let claudeCount = 0;
            let geminiCount = 0;
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
              if (cmd === 'claude') claudeCount++;
              else if (cmd === 'gemini') geminiCount++;
              else scriptCount++; // bash, devServer, shell-script — everything else with live process
            }
            const totalAI = claudeCount + geminiCount;
            const showStopAI = totalAI > 0;
            // Script-stop branch — same split-button layout but green tint (process indicator color),
            // and Ctrl+C path instead of SIGTERM (zsh/bash handles SIGINT, no danger zone like Claude TUI).
            const showStopScript = !showStopAI && scriptCount > 0;
            const SCRIPT_TINT = '#dc2626'; // cherry-red — distinguish from green "running" dot; AI buttons keep their own tints

            // Majority decides base color. Ties go to Claude (project default).
            // Minority is rendered as small "+N" badge in the OTHER tint, so the
            // user can see at a glance "mostly Claude, also 1 Gemini in there".
            const claudeIsMajor = claudeCount >= geminiCount;
            const baseTint = claudeIsMajor ? CLAUDE_TINT : GEMINI_TINT;
            const minorityTint = claudeIsMajor ? GEMINI_TINT : CLAUDE_TINT;
            const majorCount = claudeIsMajor ? claudeCount : geminiCount;
            const minorCount = claudeIsMajor ? geminiCount : claudeCount;

            // Label: single tab keeps full name, multi just shows count under the icon
            const singleTab = totalAI === 1 && targetTabIds.length === 1;
            const stopLabel = singleTab
              ? (claudeIsMajor ? 'Stop Claude' : 'Stop Gemini')
              : `Stop ${majorCount}`;

            const handleClose = async () => {
              if (isMultiSelect) {
                const running: { id: string; name: string }[] = [];
                for (const id of selectedTabIds) {
                  const state = await ipcRenderer.invoke('terminal:getCommandState', id);
                  if (state.isRunning) {
                    const { processName } = await ipcRenderer.invoke('terminal:hasRunningProcess', id);
                    running.push({ id, name: processName || 'unknown' });
                  }
                }
                let confirmed = true;
                if (running.length > 0) {
                  confirmed = window.confirm(
                    `${running.length} tab(s) have running processes:\n${running.map(r => `\u2022 ${r.name}`).join('\n')}\n\nClose all ${selectedTabIds.length} tabs?`
                  );
                } else {
                  confirmed = window.confirm(`Close ${selectedTabIds.length} tabs?`);
                }
                if (confirmed) {
                  for (const id of selectedTabIds) {
                    await closeTab(projectId, id, { skipProcessCheck: true, forceCleanup: true });
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
                if (cmd !== 'claude' && cmd !== 'gemini') return null;
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
              for (const id of targetTabIds) {
                if (!processStatus.get(id)) continue;
                const cmd = workspace.tabs.get(id)?.commandType;
                if (cmd === 'claude' || cmd === 'gemini') continue;
                // Ctrl+C first, then visible kill-ports line if toggle is on.
                // Same pattern as handleStop — single source of behavior.
                ipcRenderer.send('terminal:input', id, '\x03');
                const killPrefix = await buildKillPortsPrefix(id);
                if (killPrefix) {
                  const standalone = killPrefix.replace(/;\s*$/, '');
                  setTimeout(() => {
                    ipcRenderer.send('terminal:input', id, `${standalone}\r`);
                  }, 300);
                }
              }
            };

            const scriptLabel = (() => {
              if (scriptCount === 1 && targetTabIds.length === 1) {
                const t = workspace.tabs.get(targetTabIds[0]);
                const name = t?.name || 'script';
                // Truncate long names so the pill doesn't push Close Tab off the menu.
                return name.length > 18 ? 'Stop ' + name.slice(0, 18) + '\u2026' : 'Stop ' + name;
              }
              return `Stop ${scriptCount}`;
            })();

            const tooltipParts = [];
            if (claudeCount > 0) tooltipParts.push(`${claudeCount} Claude`);
            if (geminiCount > 0) tooltipParts.push(`${geminiCount} Gemini`);
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
              <Tooltip content={`Send Ctrl+C to ${scriptCount} running script(s) — tab stays open`}>
              <button
                className="flex-1 basis-0 min-w-0 px-2 py-1.5 text-[12px] cursor-pointer flex items-center justify-center gap-1.5 border-l border-[#444] whitespace-nowrap"
                style={{ color: SCRIPT_TINT, backgroundColor: SCRIPT_TINT + '14' }}
                onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = SCRIPT_TINT + '33'; }}
                onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = SCRIPT_TINT + '14'; }}
                onClick={handleStopScript}
              >
                <span style={{ width: 8, height: 8, borderRadius: '50%', backgroundColor: SCRIPT_TINT, display: 'inline-block', boxShadow: `0 0 6px ${SCRIPT_TINT}80` }} />
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
            //   Row 1: [+ add new] [Stop ...]
            //   Row 2: [Rename]    [Close Tab]
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
                  {stopPill}
                </div>
                <div className="flex items-stretch w-full border-t border-[#3a3a3a]">
                  <button
                    className="flex-1 basis-0 min-w-0 text-left px-3 py-1.5 text-[13px] text-[#ccc] hover:bg-white/10 cursor-pointer flex items-center gap-2 whitespace-nowrap"
                    onClick={handleContextRename}
                  >
                    Rename
                  </button>
                  <button
                    className="flex-1 basis-0 min-w-0 px-2 py-1.5 text-[12px] text-[#f87171] hover:bg-white/10 cursor-pointer flex items-center justify-center border-l border-[#444] whitespace-nowrap"
                    onClick={handleClose}
                  >
                    Close Tab
                  </button>
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
                  </div>
                </div>
              </div>
            </>
          )}

          {/* Collapse / Expand */}
          {!isMultiSelect && (
            <button
              className="w-full text-left px-4 py-1.5 text-[13px] text-[#ccc] hover:bg-white/10 cursor-pointer flex items-center gap-2"
              onClick={() => {
                if (contextMenu) {
                  toggleTabCollapsed(projectId, contextMenu.tabId);
                }
                setContextMenu(null);
              }}
            >
              {workspace.tabs.get(contextMenu!.tabId)?.isCollapsed
                ? <><Maximize2 size={12} className="text-[#666]" /> Expand</>
                : <><Minimize2 size={12} className="text-[#666]" /> Collapse</>
              }
            </button>
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
                    const sessionId = tab.claudeSessionId || tab.geminiSessionId || 'no-session';
                    const path = tab.cwd || project?.path || '/';
                    lines.push(`${sessionId}\ncwd: ${path}`);
                  }
                });
                navigator.clipboard.writeText(lines.join('\n\n'));
                showToast(`Copied ${selectedTabIds.length} sessions`, 'success');
              } else {
                const tab = workspace.tabs.get(contextMenu.tabId);
                if (tab) {
                  const sessionId = tab.claudeSessionId || tab.geminiSessionId || 'no-session';
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

      {/* Empty space context menu — Create SDK tab */}
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
              createSDKTab(projectId);
              setProjectView(projectId, 'terminal');
              setEmptyContextMenu(null);
            }}
          >
            <span style={{ color: '#DA7756' }}>◆</span>
            Create Claude SDK tab
          </button>
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
