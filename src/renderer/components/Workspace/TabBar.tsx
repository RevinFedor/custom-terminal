import React, { useState, useRef, useEffect, useLayoutEffect, memo, useCallback } from 'react';
import { useWorkspaceStore, TabColor, isTabInterrupted } from '../../store/useWorkspaceStore';
import { useProjectsStore } from '../../store/useProjectsStore';
import { useUIStore } from '../../store/useUIStore';
import { useCmdKey, useCmdHoverPopover, CmdHoverPopover } from '../../hooks/useCmdHoverPopover';
import { MarkdownEditor } from '@anthropic/markdown-editor';
import '@anthropic/markdown-editor/styles.css';
// Removed: framer-motion import - was causing lag on project switch
import { draggable, dropTargetForElements, monitorForElements } from '@atlaskit/pragmatic-drag-and-drop/element/adapter';
import { attachClosestEdge, extractClosestEdge, type Edge } from '@atlaskit/pragmatic-drag-and-drop-hitbox/closest-edge';
import { combine } from '@atlaskit/pragmatic-drag-and-drop/combine';
import { autoScrollForElements } from '@atlaskit/pragmatic-drag-and-drop-auto-scroll/element';
import { setCustomNativeDragPreview } from '@atlaskit/pragmatic-drag-and-drop/element/set-custom-native-drag-preview';
import { ChevronDown, Globe, Bot, Play, Minimize2, Maximize2 } from 'lucide-react';

const { ipcRenderer } = window.require('electron');

// OSC 133 event-driven process status (no more polling!)

interface TabBarProps {
  projectId: string;
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
}

type DragData = {
  type: 'TAB';
  id: string;
  zone: 'main' | 'utility';
  index: number;
  projectId?: string; // For cross-project drag
  selectedTabIds?: string[]; // For multi-tab drag
};

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
            title="Restart (Ctrl+C → !! → Enter)"
          >
            ↻
          </div>
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
  showNotesIndicator?: boolean; // CMD held + cursor in TabBar = highlight tabs with notes
  isCollapsed?: boolean; // Collapsed tab — icon-only
  hasSession?: boolean; // Whether tab has an active AI session
  isBusy?: boolean; // AI agent is actively thinking/streaming
  isViewingSubAgent?: boolean; // User is viewing a sub-agent of this tab
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
  showNotesIndicator = false,
  isCollapsed = false,
  hasSession = false,
  isBusy = false,
  isViewingSubAgent = false,
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

  useEffect(() => {
    const element = ref.current;
    if (!element) return;

    const allowedEdges: Edge[] = zone === 'main' ? ['left', 'right'] : ['top', 'bottom'];

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
  }, [tab.id, zone, index, projectId, isAdoptDrop]);

  const isHorizontal = zone === 'main';
  const [isHovered, setIsHovered] = useState(false);

  // Get color config
  const colorConfig = TAB_COLORS.find(c => c.color === tab.color) || TAB_COLORS[0];


  // Determine background color
  const hasColor = tab.color && tab.color !== 'default';

  const getBgColor = () => {
    // Active tab always gets its proper background
    if (isActive) {
      if (hasColor) {
        return colorConfig.bgColor;
      }
      return 'rgba(255,255,255,0.08)';
    }
    // Selected but NOT active tabs
    if (isSelected) {
      if (hasColor) {
        // Slightly brighter version of the tab color
        const match = colorConfig.bgColor.match(/rgba?\((\d+),\s*(\d+),\s*(\d+),?\s*([\d.]+)?\)/);
        if (match) {
          const [, r, g, b, a = '0.2'] = match;
          const newAlpha = Math.min(parseFloat(a) + 0.1, 0.4);
          return `rgba(${r}, ${g}, ${b}, ${newAlpha})`;
        }
        return colorConfig.bgColor;
      }
      return 'rgba(255,255,255,0.06)';
    }
    // Hovered tabs
    if (isHovered) {
      if (hasColor) {
        return colorConfig.bgColor;
      }
      return 'rgba(255,255,255,0.05)';
    }
    // Colored tabs always show subtle background
    if (hasColor) {
      return colorConfig.bgColor;
    }
    return 'transparent';
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

  // Build inline styles - full control to avoid Tailwind conflicts
  const tabStyle: React.CSSProperties = {
    position: 'relative',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: isCollapsed ? '0' : '8px',
    cursor: 'pointer',
    overflow: 'visible',
    padding: isCollapsed
      ? '0'
      : (tab.tabType === 'browser'
        ? (isHorizontal ? '0 16px' : '0 12px')
        : (isHorizontal ? '0 16px 0 32px' : '0 12px 0 32px')),
    fontSize: `${fontSize}px`,
    height: '30px',
    width: isCollapsed ? '28px' : undefined,
    minWidth: isCollapsed ? '28px' : (isHorizontal ? 'auto' : '160px'),
    maxWidth: isCollapsed ? '28px' : undefined,
    color: (isActive || isHovered || isSelected) ? '#fff' : '#888',
    backgroundColor: getBgColor(),
    borderTop: isHorizontal ? getTopBorder() : 'none',
    borderLeft: !isHorizontal ? getLeftBorder() : 'none',
    opacity: isDragging ? 0.5 : (draggingGroupIds.includes(tab.id) && !isDragging ? 0.5 : (isCollapsed && !isActive ? 0.6 : 1)),
    transition: 'color 0.15s ease, background-color 0.15s ease',
    borderRight: isViewingSubAgent ? '2px solid rgba(168, 85, 247, 0.6)' : 'none',
    ...(isAdoptTarget ? {
      boxShadow: 'inset 0 0 0 1.5px rgba(99, 102, 241, 0.7)',
      backgroundColor: 'rgba(99, 102, 241, 0.15)',
    } : {}),
  };

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
          {/* Restart zone - left part of tab (not for browser tabs) */}
          {tab.tabType !== 'browser' && (
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

          {isEditing ? (
            <input
              ref={inputRef}
              type="text"
              className="bg-[#333] border border-accent rounded px-2 py-0.5 text-[13px] text-white outline-none w-[100px]"
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

          {/* Notes indicator dot — absolute, doesn't affect layout */}
          {showNotesIndicator && (
            <span
              style={{
                position: 'absolute',
                top: '4px',
                right: '4px',
                width: '5px',
                height: '5px',
                borderRadius: '50%',
                backgroundColor: '#DA7756',
                pointerEvents: 'none',
              }}
            />
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
const EmptyDropZone = memo(({ onDropMain, onDropFromUtility, onHoverChange, onDoubleClick }: {
  onDropMain: (tabId: string) => void;
  onDropFromUtility: (tabId: string) => void;
  onHoverChange: (isOver: boolean) => void;
  onDoubleClick?: () => void;
}) => {
  const ref = useRef<HTMLDivElement>(null);
  const [isOver, setIsOver] = useState(false);

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

  return (
    <div
      ref={ref}
      className={`h-full flex-1 min-w-[30px] transition-colors ${isOver ? 'bg-white/10' : ''}`}
      onDoubleClick={onDoubleClick}
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

function TabBar({ projectId }: TabBarProps) {
  // Use individual selectors to minimize re-renders
  const openProjects = useWorkspaceStore((state) => state.openProjects);
  const createTab = useWorkspaceStore((state) => state.createTab);
  const createTabAfterCurrent = useWorkspaceStore((state) => state.createTabAfterCurrent);
  const closeTab = useWorkspaceStore((state) => state.closeTab);
  const switchTab = useWorkspaceStore((state) => state.switchTab);
  const renameTab = useWorkspaceStore((state) => state.renameTab);
  const setTabColor = useWorkspaceStore((state) => state.setTabColor);
  const toggleTabUtility = useWorkspaceStore((state) => state.toggleTabUtility);
  const toggleTabCollapsed = useWorkspaceStore((state) => state.toggleTabCollapsed);
  const reorderInZone = useWorkspaceStore((state) => state.reorderInZone);
  const moveTabToZone = useWorkspaceStore((state) => state.moveTabToZone);
  const toggleTabSelection = useWorkspaceStore((state) => state.toggleTabSelection);
  const selectTabRange = useWorkspaceStore((state) => state.selectTabRange);
  const clearSelection = useWorkspaceStore((state) => state.clearSelection);
  
  const { projects } = useProjectsStore();
  const setProjectView = useWorkspaceStore((state) => state.setProjectView);
  const tabsFontSize = useUIStore((state) => state.tabsFontSize);
  const showToast = useUIStore((state) => state.showToast);
  const tabNotesFontSize = useUIStore((state) => state.tabNotesFontSize);
  const tabNotesPaddingX = useUIStore((state) => state.tabNotesPaddingX);
  const tabNotesPaddingY = useUIStore((state) => state.tabNotesPaddingY);

  const [editingTabId, setEditingTabId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; tabId: string } | null>(null);
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
    if (!contextMenu) return;
    const handleClose = (e: MouseEvent) => {
      // Don't close if clicking inside the context menu itself
      if ((e.target as HTMLElement).closest('[data-tab-context-menu]')) return;
      setContextMenu(null);
    };
    // Use mousedown instead of click — xterm.js canvas swallows click events
    document.addEventListener('mousedown', handleClose);
    return () => document.removeEventListener('mousedown', handleClose);
  }, [contextMenu]);

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
  const handleRestart = (tabId: string) => {
    // Ctrl+C to stop current process
    ipcRenderer.send('terminal:input', tabId, '\x03');
    // Wait for process to stop, then use !! to repeat last command
    setTimeout(() => {
      ipcRenderer.send('terminal:input', tabId, '!!\r');
    }, 300);
  };

  // Stop process: Ctrl+C only (no restart)
  const handleStop = (tabId: string) => {
    ipcRenderer.send('terminal:input', tabId, '\x03');
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
        className: (e.target as HTMLElement).className?.slice(0, 80),
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

  // Convert vertical scroll to horizontal (non-passive to allow preventDefault)
  useEffect(() => {
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
  }, []);

  return (
    <>
      {/* Single row TabBar */}
      <div
        className="h-[30px] bg-panel flex items-stretch"
        onMouseEnter={() => setIsMouseInTabBar(true)}
        onMouseLeave={() => setIsMouseInTabBar(false)}
      >
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
                        showNotesIndicator={isCmdPressed && isMouseInTabBar && !!workspace.tabs.get(tab.id)?.notes}
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
                    showNotesIndicator={isCmdPressed && isMouseInTabBar && !!workspace.tabs.get(tab.id)?.notes}
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
            />
          )}
        </div>
      </div>

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
          {/* Close Tab(s) */}
          <button
            className="w-full text-left px-4 py-1.5 text-[13px] text-[#ccc] hover:bg-white/10 cursor-pointer flex items-center gap-2"
            onClick={async () => {
              if (isMultiSelect) {
                // Collect running processes for batch confirmation
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
            }}
          >
            {isMultiSelect ? `Close ${selectedTabIds.length} Tabs` : 'Close Tab'}
          </button>

          {!isMultiSelect && (
            <>
              {/* Rename */}
              <button
                className="w-full text-left px-4 py-1.5 text-[13px] text-[#ccc] hover:bg-white/10 cursor-pointer flex items-center gap-2"
                onClick={handleContextRename}
              >
                Rename
              </button>

              {/* Color - submenu */}
              <div className="relative group/color">
                <button
                  className="w-full text-left px-4 py-1.5 text-[13px] text-[#ccc] hover:bg-white/10 cursor-pointer flex items-center justify-between"
                >
                  <span>Color</span>
                  <span className="text-[#666]">›</span>
                </button>
                {/* Color submenu */}
                <div className="absolute left-full top-0 -ml-2 pl-2 hidden group-hover/color:block">
                  <div className="bg-[#2a2a2a] border border-[#444] rounded-xl shadow-2xl py-2 min-w-[140px]">
                    {TAB_COLORS.map((c) => {
                      const isSelected = workspace.tabs.get(contextMenu.tabId)?.color === c.color ||
                        (!workspace.tabs.get(contextMenu.tabId)?.color && c.color === 'default');
                      return (
                        <button
                          key={c.color}
                          className="w-full text-left px-4 py-1.5 text-[13px] text-[#ccc] hover:bg-white/10 cursor-pointer flex items-center gap-3"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleSetColor(c.color);
                          }}
                        >
                          <span
                            style={{
                              width: '12px',
                              height: '12px',
                              borderRadius: '50%',
                              border: `2px solid ${c.borderColor}`,
                              backgroundColor: c.bgColor,
                            }}
                          />
                          <span>{c.label.replace(/^. /, '')}</span>
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
                  {/* Active process — stop button */}
                  {contextMenu && processStatus.get(contextMenu.tabId) && workspace.tabs.get(contextMenu.tabId)?.commandType === 'devServer' && (
                    <>
                      <button
                        className="w-full text-left px-4 py-1.5 text-[13px] text-[#f87171] hover:bg-white/10 cursor-pointer flex items-center gap-2"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleStop(contextMenu.tabId);
                          setContextMenu(null);
                        }}
                      >
                        <div className="w-1.5 h-1.5 rounded-full bg-[#4ade80] animate-pulse" />
                        <span className="truncate">Stop: {workspace.tabs.get(contextMenu.tabId)?.name}</span>
                      </button>
                      {(contextScripts.length > 0 || contextShScripts.length > 0) && <div className="my-1 border-t border-[#444]" />}
                    </>
                  )}
                  {contextScripts.map((script) => (
                    <button
                      key={script}
                      className="w-full text-left px-4 py-1.5 text-[13px] text-[#ccc] hover:bg-white/10 cursor-pointer flex items-center gap-2"
                      onClick={(e) => {
                        e.stopPropagation();
                        if (contextMenu) {
                          ipcRenderer.send('terminal:input', contextMenu.tabId, `npm run ${script}\r`);
                          // Detect dev-like scripts for auto-rename and green color
                          const isDevScript = /^(dev|start|serve|watch)/i.test(script);
                          if (isDevScript) {
                            useWorkspaceStore.getState().setTabCommandType(contextMenu.tabId, 'devServer');
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

      {/* CMD+Hover Notes Preview — unified hook + CmdHoverPopover */}
      {notesPopover.isVisible && notesPopover.hoveredItem && (() => {
        const tab = workspace.tabs.get(notesPopover.hoveredItem.id);
        const notes = tab?.notes;
        const isTabCollapsed = tab?.isCollapsed;
        if (!notes && !isTabCollapsed) return null;
        return (
          <CmdHoverPopover
            rect={notesPopover.hoveredItem.rect}
            popoverProps={notesPopover.popoverProps}
            width={380}
            maxHeight={300}
          >
            {isTabCollapsed && (
              <div style={{
                padding: '6px 10px',
                fontSize: '12px',
                fontWeight: 600,
                color: '#fff',
                borderBottom: notes ? '1px solid #333' : 'none',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}>
                {tab?.name}
              </div>
            )}
            {notes && (
              <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
                <MarkdownEditor
                  content={notes}
                  onChange={() => {}}
                  readOnly
                  compact
                  showLineNumbers={false}
                  fontSize={tabNotesFontSize}
                  contentPaddingX={tabNotesPaddingX}
                  contentPaddingY={tabNotesPaddingY}
                  wordWrap
                />
              </div>
            )}
          </CmdHoverPopover>
        );
      })()}
    </>
  );
}

export default memo(TabBar);
