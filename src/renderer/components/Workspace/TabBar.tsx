import React, { useState, useRef, useEffect, memo } from 'react';
import { useWorkspaceStore, TabColor } from '../../store/useWorkspaceStore';
import { useProjectsStore } from '../../store/useProjectsStore';
import { motion, AnimatePresence } from 'framer-motion';
import { draggable, dropTargetForElements, monitorForElements } from '@atlaskit/pragmatic-drag-and-drop/element/adapter';
import { attachClosestEdge, extractClosestEdge, type Edge } from '@atlaskit/pragmatic-drag-and-drop-hitbox/closest-edge';
import { combine } from '@atlaskit/pragmatic-drag-and-drop/combine';
import { ChevronDown } from 'lucide-react';

interface TabBarProps {
  projectId: string;
}

interface TabData {
  id: string;
  name: string;
  color?: TabColor;
  isUtility?: boolean;
}

type DragData = {
  type: 'TAB';
  id: string;
  zone: 'main' | 'utility';
  index: number;
};

const TAB_COLORS: { color: TabColor; bg: string; border: string; label: string }[] = [
  { color: 'default', bg: 'bg-transparent', border: 'border-accent', label: '⚪ Default' },
  { color: 'red', bg: 'bg-red-500/20', border: 'border-red-500', label: '🔴 Red' },
  { color: 'yellow', bg: 'bg-yellow-500/20', border: 'border-yellow-500', label: '🟡 Yellow' },
  { color: 'green', bg: 'bg-green-500/20', border: 'border-green-500', label: '🟢 Green' },
  { color: 'blue', bg: 'bg-blue-500/20', border: 'border-blue-500', label: '🔵 Blue' },
  { color: 'purple', bg: 'bg-purple-500/20', border: 'border-purple-500', label: '🟣 Purple' },
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

// Draggable Tab Item
interface TabItemProps {
  tab: TabData;
  index: number;
  zone: 'main' | 'utility';
  isActive: boolean;
  isEditing: boolean;
  editValue: string;
  onSwitch: () => void;
  onClose: (e: React.MouseEvent) => void;
  onDoubleClick: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
  onEditChange: (value: string) => void;
  onEditSubmit: () => void;
  onEditKeyDown: (e: React.KeyboardEvent) => void;
  inputRef: React.RefObject<HTMLInputElement>;
  forceRightIndicator?: boolean; // Show right indicator when empty zone is hovered
}

const TabItem = memo(({
  tab,
  index,
  zone,
  isActive,
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
        getInitialData: (): DragData => ({ type: 'TAB', id: tab.id, zone, index }),
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
  }, [tab.id, zone, index]);

  const isHorizontal = zone === 'main';

  // Unified tab styles for both main and utility zones
  const colorConfig = TAB_COLORS.find(c => c.color === tab.color) || TAB_COLORS[0];
  const baseClasses = `relative group flex items-center justify-center gap-2 cursor-pointer transition-colors overflow-visible px-4 text-[14px]`;
  const activeClasses = isActive
    ? `text-white ${colorConfig.bg !== 'bg-transparent' ? colorConfig.bg : 'bg-white/5'}`
    : 'text-[#888] hover:text-white hover:bg-white/5';
  const borderClass = isHorizontal && isActive ? `border-t-2 ${colorConfig.border}` : '';

  return (
    <div
      ref={ref}
      className={`${baseClasses} ${activeClasses} ${borderClass} ${isDragging ? 'opacity-50' : ''}`}
      onClick={onSwitch}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu}
    >
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
        <span className="select-none whitespace-nowrap">
          {tab.name}
        </span>
      )}

      <button
        className="text-[#666] hover:text-white text-lg leading-none opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer"
        onClick={(e) => {
          e.stopPropagation();
          onClose(e);
        }}
      >
        ×
      </button>

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
const EmptyDropZone = memo(({ onDropMain, onDropFromUtility, onHoverChange }: {
  onDropMain: (tabId: string) => void;
  onDropFromUtility: (tabId: string) => void;
  onHoverChange: (isOver: boolean) => void;
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
      className={`flex-1 h-full min-w-[40px] transition-colors ${isOver ? 'bg-white/5' : ''}`}
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

export default function TabBar({ projectId }: TabBarProps) {
  const {
    openProjects,
    createTab,
    closeTab,
    switchTab,
    renameTab,
    setTabColor,
    toggleTabUtility,
    reorderInZone,
    moveTabToZone
  } = useWorkspaceStore();
  const { projects } = useProjectsStore();

  const [editingTabId, setEditingTabId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; tabId: string } | null>(null);
  const [utilityExpanded, setUtilityExpanded] = useState(false);
  const [utilityOpenedManually, setUtilityOpenedManually] = useState(false); // Track if opened by click vs hover
  const [emptyZoneHovered, setEmptyZoneHovered] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const workspace = openProjects.get(projectId);
  const project = projects[projectId];

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
    createTab(projectId, `Tab ${workspace.tabCounter + 1}`, project.path);
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
    if (contextMenu) setTabColor(projectId, contextMenu.tabId, color);
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

  return (
    <>
      {/* Single row TabBar like VSCode */}
      <div className="h-[44px] bg-panel flex items-stretch">
        {/* Utility Zone - Left side */}
        <div className="relative flex items-center h-full" data-utils-button>
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
              className="flex items-center gap-1.5 px-3 h-full text-[14px] text-[#888] hover:text-white hover:bg-white/5 transition-colors cursor-pointer"
            >
              <ChevronDown
                size={16}
                className={`transition-transform duration-200 ${utilityExpanded ? 'rotate-180' : ''}`}
              />
              <span>Utils</span>
              {utilityTabs.length > 0 && (
                <span className="bg-[#444] px-1.5 rounded text-[10px]">{utilityTabs.length}</span>
              )}
            </button>
          </UtilsButtonDropTarget>

          <AnimatePresence>
            {utilityExpanded && (
              <motion.div
                data-utils-dropdown
                initial={{ opacity: 0, y: -10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                className="absolute top-full left-0 bg-panel border border-border-main rounded-lg shadow-xl min-w-[150px] z-50 overflow-hidden"
              >
                <ZoneDropTarget zone="utility" isEmpty={utilityTabs.length === 0}>
                  {utilityTabs.length === 0 ? (
                    <div className="p-3 text-[11px] text-[#666] italic">
                      Drag tabs here
                    </div>
                  ) : (
                    <div className="py-1 flex flex-col">
                      {utilityTabs.map((tab, index) => (
                        <TabItem
                          key={tab.id}
                          tab={tab}
                          index={index}
                          zone="utility"
                          isActive={workspace.activeTabId === tab.id}
                          isEditing={editingTabId === tab.id}
                          editValue={editValue}
                          onSwitch={() => switchTab(projectId, tab.id)}
                          onClose={() => toggleTabUtility(projectId, tab.id)}
                          onDoubleClick={() => handleDoubleClick(tab.id, tab.name)}
                          onContextMenu={(e) => handleContextMenu(e, tab.id)}
                          onEditChange={setEditValue}
                          onEditSubmit={handleRenameSubmit}
                          onEditKeyDown={handleRenameKeyDown}
                          inputRef={inputRef as React.RefObject<HTMLInputElement>}
                        />
                      ))}
                    </div>
                  )}
                </ZoneDropTarget>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* Main Tabs Zone - fills remaining width */}
        <div className="flex-1 flex items-stretch h-full min-w-0">
          {mainTabs.length === 0 ? (
            /* Empty main zone - show drop target */
            <EmptyMainZone
              onDrop={(tabId) => moveTabToZone(projectId, tabId, false, 0)}
            />
          ) : (
            <>
              {/* Tabs */}
              <div className="flex items-stretch h-full">
                {mainTabs.map((tab, index) => (
                  <TabItem
                    key={tab.id}
                    tab={tab}
                    index={index}
                    zone="main"
                    isActive={workspace.activeTabId === tab.id}
                    isEditing={editingTabId === tab.id}
                    editValue={editValue}
                    onSwitch={() => switchTab(projectId, tab.id)}
                    onClose={(e) => handleCloseTab(e, tab.id)}
                    onDoubleClick={() => handleDoubleClick(tab.id, tab.name)}
                    onContextMenu={(e) => handleContextMenu(e, tab.id)}
                    onEditChange={setEditValue}
                    onEditSubmit={handleRenameSubmit}
                    onEditKeyDown={handleRenameKeyDown}
                    inputRef={inputRef as React.RefObject<HTMLInputElement>}
                    forceRightIndicator={emptyZoneHovered && index === mainTabs.length - 1}
                  />
                ))}
              </div>

              {/* Empty drop zone - captures drops after last tab */}
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
          />
            </>
          )}

          {/* New tab button */}
          <button
            className="px-3 h-full text-[#666] text-lg hover:text-white hover:bg-white/5 transition-colors cursor-pointer flex items-center"
            onClick={handleNewTab}
          >
            +
          </button>
        </div>
      </div>

      {/* Context Menu */}
      {contextMenu && (
        <div
          className="fixed bg-panel border border-border-main rounded-lg shadow-xl py-1 min-w-[150px] z-[100]"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onClick={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <div className="px-2 py-1 text-[10px] text-[#666] uppercase">Color</div>
          <div className="flex gap-1 px-3 py-1">
            {TAB_COLORS.map((c) => (
              <button
                key={c.color}
                className={`w-5 h-5 rounded-full border-2 ${c.border} ${c.bg} hover:scale-110 transition-transform cursor-pointer`}
                onClick={(e) => {
                  e.stopPropagation();
                  handleSetColor(c.color);
                }}
                title={c.label}
              />
            ))}
          </div>

          <div className="border-t border-border-main my-1" />

          <button
            className="w-full text-left px-4 py-2 text-sm text-[#ccc] hover:bg-white/10 cursor-pointer"
            onClick={handleContextRename}
          >
            Rename
          </button>
          <button
            className="w-full text-left px-4 py-2 text-sm text-[#ccc] hover:bg-white/10 cursor-pointer"
            onClick={handleMoveToUtility}
          >
            {workspace.tabs.get(contextMenu.tabId)?.isUtility ? '↑ Move to Main' : '↓ Move to Utils'}
          </button>
          <button
            className="w-full text-left px-4 py-2 text-sm text-[#cc3333] hover:bg-white/10 cursor-pointer"
            onClick={handleContextClose}
          >
            Close Tab
          </button>
        </div>
      )}
    </>
  );
}
