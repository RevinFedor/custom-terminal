import React, { useState, useRef, useEffect } from 'react';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';
import { useProjectsStore } from '../../store/useProjectsStore';
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  DragEndEvent,
} from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  horizontalListSortingStrategy,
  useSortable,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

interface TabBarProps {
  projectId: string;
}

interface SortableTabProps {
  tab: { id: string; name: string };
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
}

function SortableTab({
  tab,
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
}: SortableTabProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: tab.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
    zIndex: isDragging ? 100 : 'auto',
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`tab group flex items-center gap-2 px-4 h-full cursor-pointer border-t-2 transition-colors ${
        isActive
          ? 'bg-bg-main border-accent text-white'
          : 'bg-transparent border-transparent text-[#888] hover:text-white hover:bg-white/5'
      }`}
      onClick={onSwitch}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu}
      {...attributes}
      {...listeners}
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
        <span className="text-[13px] select-none">{tab.name}</span>
      )}
      <button
        className="text-[#666] hover:text-white text-lg leading-none opacity-0 group-hover:opacity-100 transition-opacity"
        onClick={onClose}
      >
        ×
      </button>
    </div>
  );
}

export default function TabBar({ projectId }: TabBarProps) {
  const { openProjects, createTab, closeTab, switchTab, renameTab, reorderTabs } = useWorkspaceStore();
  const { projects } = useProjectsStore();

  const [editingTabId, setEditingTabId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; tabId: string } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const workspace = openProjects.get(projectId);
  const project = projects[projectId];

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 8, // Start drag after 8px movement
      },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

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

  const tabs = Array.from(workspace.tabs.values());
  const tabIds = tabs.map((t) => t.id);

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
    if (e.key === 'Enter') {
      handleRenameSubmit();
    } else if (e.key === 'Escape') {
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
    if (contextMenu) {
      closeTab(projectId, contextMenu.tabId);
    }
    setContextMenu(null);
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;

    if (over && active.id !== over.id) {
      const oldIndex = tabIds.indexOf(active.id as string);
      const newIndex = tabIds.indexOf(over.id as string);
      reorderTabs(projectId, oldIndex, newIndex);
    }
  };

  return (
    <>
      <div className="h-[40px] bg-panel flex items-end pl-2.5">
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={handleDragEnd}
        >
          <SortableContext items={tabIds} strategy={horizontalListSortingStrategy}>
            <div className="flex h-full overflow-x-auto">
              {tabs.map((tab) => (
                <SortableTab
                  key={tab.id}
                  tab={tab}
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
                />
              ))}

              <button
                className="bg-transparent border-none text-[#999] text-lg cursor-pointer px-[15px] h-full hover:text-white hover:bg-white/5"
                onClick={handleNewTab}
              >
                +
              </button>
            </div>
          </SortableContext>
        </DndContext>
      </div>

      {/* Context Menu */}
      {contextMenu && (
        <div
          className="fixed bg-panel border border-border-main rounded-lg shadow-xl py-1 min-w-[150px] z-[100]"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          <button
            className="w-full text-left px-4 py-2 text-sm text-[#ccc] hover:bg-white/10"
            onClick={handleContextRename}
          >
            Rename
          </button>
          <button
            className="w-full text-left px-4 py-2 text-sm text-[#cc3333] hover:bg-white/10"
            onClick={handleContextClose}
          >
            Close Tab
          </button>
        </div>
      )}
    </>
  );
}
