import React, { useState, useRef, useEffect, memo, useCallback } from 'react';
import { useWorkspaceStore, TabColor } from '../../store/useWorkspaceStore';
import { useProjectsStore } from '../../store/useProjectsStore';
import { useUIStore } from '../../store/useUIStore';
// Removed: framer-motion import - was causing lag on project switch
import { draggable, dropTargetForElements, monitorForElements } from '@atlaskit/pragmatic-drag-and-drop/element/adapter';
import { attachClosestEdge, extractClosestEdge, type Edge } from '@atlaskit/pragmatic-drag-and-drop-hitbox/closest-edge';
import { combine } from '@atlaskit/pragmatic-drag-and-drop/combine';
import { autoScrollForElements } from '@atlaskit/pragmatic-drag-and-drop-auto-scroll/element';
import { ChevronDown } from 'lucide-react';

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
}

type DragData = {
  type: 'TAB';
  id: string;
  zone: 'main' | 'utility';
  index: number;
  projectId?: string; // For cross-project drag
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
const RestartZone = memo(({ hasProcess, hasColor, commandType, onRestart }: {
  hasProcess: boolean;
  hasColor: boolean;
  commandType?: string;
  onRestart: () => void;
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
          // Green dot when not hovered (process running)
          <span
            style={{
              display: 'block',
              width: '6px',
              height: '6px',
              borderRadius: '50%',
              backgroundColor: '#4ade80',
              opacity: hasColor ? 0.9 : 0.8,
              boxShadow: '0 0 4px rgba(74, 222, 128, 0.5)',
            }}
          />
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
  isInterrupted?: boolean; // Tab has an interrupted AI session
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
  isInterrupted = false,
}: TabItemProps) => {
  const ref = useRef<HTMLDivElement>(null);
  const [closestEdge, setClosestEdge] = useState<Edge | null>(null);
  const [isDragging, setIsDragging] = useState(false);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;

    const allowedEdges: Edge[] = zone === 'main' ? ['left', 'right'] : ['top', 'bottom'];

    return combine(
      draggable({
        element,
        getInitialData: (): DragData => ({ type: 'TAB', id: tab.id, zone, index, projectId }),
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
          setClosestEdge(extractClosestEdge(self.data));
        },
        onDrag: ({ source, self }) => {
          const sourceData = source.data as DragData;
          if (sourceData.id === tab.id) {
            setClosestEdge(null);
            return;
          }
          setClosestEdge(extractClosestEdge(self.data));
        },
        onDragLeave: () => setClosestEdge(null),
        onDrop: () => setClosestEdge(null),
      })
    );
  }, [tab.id, zone, index, projectId]);

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

  // Build inline styles - full control to avoid Tailwind conflicts
  const tabStyle: React.CSSProperties = {
    position: 'relative',
    display: 'flex',
    alignItems: 'center',
    justifyContent: isHorizontal ? 'center' : 'space-between', // Space-between for utility (close btn right)
    gap: '8px',
    cursor: 'pointer',
    overflow: 'visible',
    padding: isHorizontal ? '0 16px 0 32px' : '0 12px 0 32px', // Left padding for restart zone
    fontSize: `${fontSize}px`,
    height: '30px', // Same height for all tabs
    minWidth: isHorizontal ? 'auto' : '160px',
    color: (isActive || isHovered || isSelected) ? '#fff' : '#888',
    backgroundColor: getBgColor(),
    // Horizontal tabs: border on top. Vertical tabs: border on left
    borderTop: isHorizontal ? getTopBorder() : 'none',
    borderLeft: !isHorizontal ? getLeftBorder() : 'none',
    // Gap between tabs to separate borders visually (especially for dashed lines)
    marginRight: isHorizontal ? '1px' : '0',
    marginBottom: !isHorizontal ? '1px' : '0',
    opacity: isDragging ? 0.5 : 1,
    transition: 'color 0.15s ease, background-color 0.15s ease',
  };

  return (
    <div
      ref={ref}
      className="group"
      style={tabStyle}
      onClick={(e) => onSwitch(e)}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      onAuxClick={(e) => {
        // Middle mouse button (button === 1) closes tab
        if (e.button === 1) {
          e.preventDefault();
          e.stopPropagation();
          onClose(e as any);
        }
      }}
    >
      {/* Restart zone - left part of tab */}
      <RestartZone
        hasProcess={hasProcess}
        hasColor={!!hasColor}
        commandType={commandType}
        onRestart={() => onRestart && onRestart(tab.id)}
      />

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
        <span className="select-none whitespace-nowrap overflow-hidden text-ellipsis" style={{ flex: isHorizontal ? 'none' : 1 }}>
          {tab.name}
        </span>
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
  const reorderInZone = useWorkspaceStore((state) => state.reorderInZone);
  const moveTabToZone = useWorkspaceStore((state) => state.moveTabToZone);
  const toggleTabSelection = useWorkspaceStore((state) => state.toggleTabSelection);
  const selectTabRange = useWorkspaceStore((state) => state.selectTabRange);
  const clearSelection = useWorkspaceStore((state) => state.clearSelection);
  
  const { projects } = useProjectsStore();
  const tabsFontSize = useUIStore((state) => state.tabsFontSize);
  const currentView = useUIStore((state) => state.currentView);
  const setCurrentView = useUIStore((state) => state.setCurrentView);
  const showToast = useUIStore((state) => state.showToast);

  const [editingTabId, setEditingTabId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; tabId: string } | null>(null);
  const [utilityExpanded, setUtilityExpanded] = useState(false);
  const [utilityOpenedManually, setUtilityOpenedManually] = useState(false); // Track if opened by click vs hover
  const utilityHoverTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const utilityCloseTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const [emptyZoneHovered, setEmptyZoneHovered] = useState(false);
  const [processStatus, setProcessStatus] = useState<Map<string, boolean>>(new Map());
  const inputRef = useRef<HTMLInputElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  const workspace = openProjects.get(projectId);
  const project = projects[projectId];

  // Selection state
  const selectedTabIds = workspace?.selectedTabIds || [];
  const isMultiSelect = selectedTabIds.length > 1;

  const handleTabClick = (e: React.MouseEvent, tabId: string) => {
    if (e.shiftKey) {
      selectTabRange(projectId, tabId);
    } else if (e.metaKey || e.ctrlKey) {
      toggleTabSelection(projectId, tabId, true);
    } else {
      switchTab(projectId, tabId);
    }
  };

  // OSC 133 Event-driven process status (replaces polling)
  // Initial load + listen for command start/finish events
  useEffect(() => {
    if (!workspace) return;

    const tabIds = Array.from(workspace.tabs.keys());

    // Initial load: get current state from memory (no syscalls)
    const initStatus = async () => {
      const newStatus = new Map<string, boolean>();
      await Promise.all(
        tabIds.map(async (tabId) => {
          try {
            const state = await ipcRenderer.invoke('terminal:getCommandState', tabId);
            newStatus.set(tabId, state.isRunning);
          } catch {
            newStatus.set(tabId, false);
          }
        })
      );
      setProcessStatus(newStatus);
    };
    initStatus();

    // Listen for OSC 133 events (instant, no polling)
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

    ipcRenderer.on('terminal:command-started', handleCommandStarted);
    ipcRenderer.on('terminal:command-finished', handleCommandFinished);

    return () => {
      ipcRenderer.removeListener('terminal:command-started', handleCommandStarted);
      ipcRenderer.removeListener('terminal:command-finished', handleCommandFinished);
    };
  }, [workspace?.tabs.size]); // Re-init when tabs change

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

        const allTabsNow = Array.from(currentWorkspace.tabs.values());
        const mainTabsNow = allTabsNow.filter(t => !t.isUtility);
        const utilityTabsNow = allTabsNow.filter(t => t.isUtility);

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
  }, [projectId, moveTabToZone, reorderInZone]);

  useEffect(() => {
    if (editingTabId && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editingTabId]);

  useEffect(() => {
    const handleClick = () => setContextMenu(null);
    if (contextMenu) {
      document.addEventListener('click', handleClick);
      return () => document.removeEventListener('click', handleClick);
    }
  }, [contextMenu]);

  if (!workspace || !project) return null;

  const allTabs = Array.from(workspace.tabs.values());
  const mainTabs = allTabs.filter(t => !t.isUtility);
  const utilityTabs = allTabs.filter(t => t.isUtility);

  const handleNewTab = () => {
    // Get current tab's cwd
    const activeTab = workspace.activeTabId ? workspace.tabs.get(workspace.activeTabId) : null;
    const cwd = activeTab?.cwd || project.path;
    // Pass undefined for name to use smart naming (tab-1, tab-2, etc.)
    createTabAfterCurrent(projectId, undefined, cwd);
    setCurrentView('terminal');
  };

  // Create new tab at the end of tabs list (for double-click on empty space)
  const handleNewTabAtEnd = () => {
    const activeTab = workspace.activeTabId ? workspace.tabs.get(workspace.activeTabId) : null;
    const cwd = activeTab?.cwd || project.path;
    createTab(projectId, undefined, cwd);
    setCurrentView('terminal');
  };

  const handleCloseTab = (e: React.MouseEvent, tabId: string) => {
    e.stopPropagation();
    closeTab(projectId, tabId);
  };

  const handleDoubleClick = (tabId: string, currentName: string) => {
    setEditingTabId(tabId);
    setEditValue(currentName);
  };

  const handleContextMenu = (e: React.MouseEvent, tabId: string) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ x: e.clientX, y: e.clientY, tabId });
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

  // Monitor drag start/end for utils dropdown behavior
  useEffect(() => {
    return monitorForElements({
      canMonitor: ({ source }) => source.data.type === 'TAB',
      onDragStart: () => setIsDraggingTab(true),
      onDrop: () => {
        setIsDraggingTab(false);
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
      <div className="h-[30px] bg-panel flex items-stretch">
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
                  <div className="flex flex-col">
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
                          setCurrentView('terminal');
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
                        onRestart={handleRestart}
                        isInterrupted={tab.wasInterrupted && !!(tab.claudeSessionId || tab.geminiSessionId)}
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
              <div className="flex items-stretch h-full flex-shrink-0">
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
                      setCurrentView('terminal');
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
                    onRestart={handleRestart}
                    isInterrupted={tab.wasInterrupted && !!(tab.claudeSessionId || tab.geminiSessionId)}
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
          className="fixed bg-[#2a2a2a] border border-[#444] shadow-2xl min-w-[180px] z-[100]"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onClick={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
        >
          {/* Close Tab(s) */}
          <button
            className="w-full text-left px-4 py-1.5 text-[13px] text-[#ccc] hover:bg-white/10 cursor-pointer flex items-center gap-2"
            onClick={() => {
              if (isMultiSelect) {
                // Confirm closing multiple tabs
                if (window.confirm(`Close ${selectedTabIds.length} tabs?`)) {
                  selectedTabIds.forEach(id => closeTab(projectId, id));
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
        </div>
      )}
    </>
  );
}

export default memo(TabBar);
