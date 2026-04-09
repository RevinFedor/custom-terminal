import React, { useEffect, useState, useRef, useCallback, memo } from 'react';
import { useWorkspaceStore, isTabInterrupted } from './store/useWorkspaceStore';
import { useProjectsStore } from './store/useProjectsStore';
import { useUIStore } from './store/useUIStore';
import { useResearchStore } from './store/useResearchStore';
import { usePromptsStore } from './store/usePromptsStore';
import Dashboard from './components/Dashboard/Dashboard';
import Workspace from './components/Workspace/Workspace';
import ToastContainer from './components/UI/Toast';
import EditProjectModal from './components/UI/EditProjectModal';
import SessionInputModal from './components/UI/SessionInputModal';
import SettingsModal from './components/UI/SettingsModal';
// Drag and drop
import { draggable, dropTargetForElements, monitorForElements } from '@atlaskit/pragmatic-drag-and-drop/element/adapter';
import { attachClosestEdge, extractClosestEdge, type Edge } from '@atlaskit/pragmatic-drag-and-drop-hitbox/closest-edge';
import { combine } from '@atlaskit/pragmatic-drag-and-drop/combine';

// Initialize debug logger (exposes `debug` helper in console)
import './utils/logger';

const { ipcRenderer } = window.require('electron');

// Drop Indicator Line for project tabs
const ProjectDropIndicator = memo(({ edge }: { edge: 'left' | 'right' }) => {
  const positionClass = edge === 'left'
    ? 'left-0 -translate-x-1/2'
    : 'right-0 translate-x-1/2';

  return (
    <div
      className={`absolute top-0 bottom-0 bg-white pointer-events-none ${positionClass}`}
      style={{ zIndex: 99999, width: '2px' }}
    />
  );
});

// Draggable Project Tab
interface ProjectTabItemProps {
  projectId: string;
  projectName: string;
  index: number;
  isActive: boolean;
  fontSize: number;
  forceRightIndicator?: boolean;
  activeProcessCount?: number; // Count of running processes in project
  interruptedCount?: number; // Count of interrupted (paused) sessions in project
  isProjectBusy?: boolean; // Any tab in project has Claude/Gemini thinking
  isEditing: boolean;
  editValue: string;
  onEditChange: (val: string) => void;
  onEditSubmit: () => void;
  onEditCancel: () => void;
  onClick: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
  onMiddleClick: () => void;
  onDoubleClick: () => void;
  onTabDrop?: (tabId: string, sourceProjectId: string, selectedTabIds?: string[]) => void; // For dropping terminal tabs
  isAreaActive?: boolean;
  isProjectLoading?: boolean; // API request in progress (Update API, Research, etc.)
}

const ProjectTabItem = memo(({
  projectId,
  projectName,
  index,
  isActive,
  fontSize,
  forceRightIndicator = false,
  activeProcessCount = 0,
  interruptedCount = 0,
  isEditing,
  editValue,
  onEditChange,
  onEditSubmit,
  onEditCancel,
  onClick,
  onContextMenu,
  onMiddleClick,
  onDoubleClick,
  onTabDrop,
  isAreaActive,
  isProjectBusy = false,
  isProjectLoading = false
}: ProjectTabItemProps) => {
  const ref = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [closestEdge, setClosestEdge] = useState<Edge | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [isTabDropTarget, setIsTabDropTarget] = useState(false); // Highlight when terminal tab is over

  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isEditing]);

  useEffect(() => {
    const element = ref.current;
    if (!element || isEditing) return;

    return combine(
      draggable({
        element,
        getInitialData: () => ({ type: 'PROJECT_TAB', id: projectId, index }),
        onDragStart: () => setIsDragging(true),
        onDrop: () => setIsDragging(false),
      }),
// ... existing dropTargetForElements code ...
      dropTargetForElements({
        element,
        getData: ({ input, element }) => {
          return attachClosestEdge(
            { type: 'PROJECT_TAB', id: projectId, index },
            { element, input, allowedEdges: ['left', 'right'] }
          );
        },
        canDrop: ({ source }) => {
          // Accept both PROJECT_TAB (for reordering) and TAB (terminal tabs)
          return source.data.type === 'PROJECT_TAB' || source.data.type === 'TAB';
        },
        onDragEnter: ({ source, self }) => {
          if (source.data.type === 'TAB') {
            setIsTabDropTarget(true);
            return;
          }
          if (source.data.id === projectId) return;
          setClosestEdge(extractClosestEdge(self.data) as Edge | null);
        },
        onDrag: ({ source, self }) => {
          if (source.data.type === 'TAB') {
            setIsTabDropTarget(true);
            return;
          }
          if (source.data.id === projectId) {
            setClosestEdge(null);
            return;
          }
          setClosestEdge(extractClosestEdge(self.data) as Edge | null);
        },
        onDragLeave: () => {
          setClosestEdge(null);
          setIsTabDropTarget(false);
        },
        onDrop: ({ source }) => {
          setClosestEdge(null);
          setIsTabDropTarget(false);
          // Handle terminal tab drop
          if (source.data.type === 'TAB' && onTabDrop) {
            const tabData = source.data as { id: string; projectId?: string; selectedTabIds?: string[] };
            if (tabData.projectId && tabData.projectId !== projectId) {
              onTabDrop(tabData.id, tabData.projectId, tabData.selectedTabIds);
            }
          }
        },
      })
    );
  }, [projectId, index, onTabDrop, isEditing]);

  // Text color: active (selected) = black, has processes = white, idle = gray
  const textColor = isActive
    ? 'text-black'
    : activeProcessCount > 0
      ? 'text-white'
      : 'text-gray-400 hover:text-white';

  return (
    <button
      ref={ref}
      className={`relative px-3 py-1.5 text-sm font-medium cursor-pointer transition-all rounded-sm ${
        isActive && isAreaActive ? 'ring-1 ring-white/50 shadow-[0_0_10px_rgba(255,255,255,0.1)]' : ''
      } ${textColor}`}
      style={{
        fontSize: `${fontSize}px`,
        opacity: isDragging ? 0.5 : 1,
        outline: isTabDropTarget ? '2px solid #4ade80' : 'none',
        outlineOffset: '-2px',
        borderRadius: isTabDropTarget ? '4px' : '2px', // Consistency with rounded-sm
      }}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu}
      onAuxClick={(e) => {
        if (e.button === 1) {
          e.preventDefault();
          onMiddleClick();
        }
      }}
    >
      {isActive && (
        <div className="absolute inset-0 bg-white rounded-sm" />
      )}
      <span className="relative z-10 flex items-center gap-1.5">
        {isEditing ? (
          <input
            ref={inputRef}
            className="bg-[#333] border border-accent rounded px-1.5 py-0 text-white outline-none w-[100px] text-xs font-normal"
            value={editValue}
            onChange={(e) => {
              const val = e.target.value;
              onEditChange(val);
              // Real-time sync with ProjectHome
              if (val.trim()) {
                window.dispatchEvent(new CustomEvent('project:name-sync', {
                  detail: { projectId, name: val.trim(), source: 'titlebar' }
                }));
              }
            }}
            onBlur={onEditSubmit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') onEditSubmit();
              if (e.key === 'Escape') onEditCancel();
            }}
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <span className="max-w-[120px] truncate">{projectName}</span>
        )}
        {activeProcessCount > 0 && !isEditing && (
          <span
            className="relative flex items-center justify-center text-[10px] font-medium rounded-full"
            style={{
              minWidth: '16px',
              height: '16px',
              padding: '0 4px',
              backgroundColor: isActive ? 'rgba(74, 222, 128, 0.3)' : 'rgba(74, 222, 128, 0.2)',
              color: isActive ? '#166534' : '#4ade80',
              boxSizing: 'border-box',
            }}
          >
            {(isProjectBusy || isProjectLoading) && (
              <span
                className="absolute inset-0 rounded-full animate-glow-green"
                style={{
                  border: '2px solid #22c55e',
                  boxShadow: '0 0 6px #22c55e',
                }}
              />
            )}
            {activeProcessCount}
          </span>
        )}
        {interruptedCount > 0 && !isEditing && (
          <span
            className="flex items-center justify-center text-[10px] font-medium rounded-full"
            style={{
              minWidth: '16px',
              height: '16px',
              padding: '0 4px',
              backgroundColor: isActive ? 'rgba(59, 130, 246, 0.3)' : 'rgba(59, 130, 246, 0.2)',
              color: isActive ? '#1e40af' : '#3b82f6',
            }}
            title="Interrupted sessions - click tab to resume"
          >
            {interruptedCount}
          </span>
        )}
      </span>
      {closestEdge && <ProjectDropIndicator edge={closestEdge as 'left' | 'right'} />}
      {forceRightIndicator && !closestEdge && <ProjectDropIndicator edge="right" />}
    </button>
  );
});

// Empty area drop zone for projects - for dropping at the end
// This area allows window dragging when not in a drag-drop operation
const ProjectEmptyDropZone = memo(({ onDrop, onHoverChange, onDoubleClick, onMouseDown }: {
  onDrop: (projectId: string) => void;
  onHoverChange: (isOver: boolean) => void;
  onDoubleClick: () => void;
  onMouseDown: () => void;
}) => {
  const ref = useRef<HTMLDivElement>(null);
  const [isDragActive, setIsDragActive] = useState(false);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;

    return dropTargetForElements({
      element,
      getData: () => ({ type: 'PROJECT_EMPTY_ZONE' }),
      canDrop: ({ source }) => source.data.type === 'PROJECT_TAB',
      onDragEnter: () => {
        setIsDragActive(true);
        onHoverChange(true);
      },
      onDragLeave: () => {
        setIsDragActive(false);
        onHoverChange(false);
      },
      onDrop: ({ source }) => {
        const data = source.data as { id: string };
        onDrop(data.id);
        setIsDragActive(false);
        onHoverChange(false);
      },
    });
  }, [onDrop, onHoverChange]);

  return (
    <div
      ref={ref}
      className="flex-1 h-full min-w-[30px] transition-colors"
      onDoubleClick={(e) => {
        e.stopPropagation();
        onDoubleClick();
      }}
      onMouseDown={(e) => {
        e.stopPropagation();
        onMouseDown();
      }}
      style={{
        // Crucial: no-drag allows JS to catch events, but we keep it transparent
        WebkitAppRegion: 'no-drag'
      } as any}
    />
  );
});

// Global loading screen during session restore
const RestoreLoader = memo(() => (
  <div className="h-screen w-screen flex flex-col items-center justify-center bg-bg-main text-white">
    <div className="flex flex-col items-center gap-4">
      <div className="w-8 h-8 border-2 border-white/20 border-t-white rounded-full animate-spin" />
      <span className="text-sm text-[#888]">Restoring session...</span>
    </div>
  </div>
));

function App() {
  // Individual selectors — only re-render when specific values change (not on every store mutation)
  const view = useWorkspaceStore((s) => s.view);
  const activeProjectId = useWorkspaceStore((s) => s.activeProjectId);
  const openProjects = useWorkspaceStore((s) => s.openProjects);
  const isRestoring = useWorkspaceStore((s) => s.isRestoring);
  // Functions are stable references in Zustand — selecting them individually avoids re-renders
  const showDashboard = useWorkspaceStore((s) => s.showDashboard);
  const showWorkspace = useWorkspaceStore((s) => s.showWorkspace);
  const openProject = useWorkspaceStore((s) => s.openProject);
  const closeProject = useWorkspaceStore((s) => s.closeProject);
  const createTab = useWorkspaceStore((s) => s.createTab);
  const createTabAfterCurrent = useWorkspaceStore((s) => s.createTabAfterCurrent);
  const closeTab = useWorkspaceStore((s) => s.closeTab);
  const getActiveProject = useWorkspaceStore((s) => s.getActiveProject);
  const getEffectiveTabId = useWorkspaceStore((s) => s.getEffectiveTabId);
  const restoreSession = useWorkspaceStore((s) => s.restoreSession);
  const reorderProjects = useWorkspaceStore((s) => s.reorderProjects);
  const moveTabToProject = useWorkspaceStore((s) => s.moveTabToProject);
  const moveTabsToProject = useWorkspaceStore((s) => s.moveTabsToProject);
  const getSidebarState = useWorkspaceStore((s) => s.getSidebarState);
  const setSidebarOpen = useWorkspaceStore((s) => s.setSidebarOpen);
  const setOpenFilePath = useWorkspaceStore((s) => s.setOpenFilePath);
  const { projects, loadProjects, updateProject } = useProjectsStore();
  const { closeFilePreview, filePreview, showToast, incrementAllFontSizes, decrementAllFontSizes, activeArea, setActiveArea, dragAreaWidth, setDragAreaWidth } = useUIStore();
  const { toggleResearch } = useResearchStore();
  const projectTabsFontSize = useUIStore((s) => s.projectTabsFontSize);

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [projectContextMenu, setProjectContextMenu] = useState<{ projectId: string; x: number; y: number } | null>(null);
  const [projectEmptyZoneHovered, setProjectEmptyZoneHovered] = useState(false);
  const [processStatus, setProcessStatus] = useState<Map<string, boolean>>(new Map()); // tabId -> isRunning
  const [busyTabs, setBusyTabs] = useState<Map<string, boolean>>(new Map()); // tabId -> isBusy (Claude/Gemini thinking)
  const [apiLoadingProjects, setApiLoadingProjects] = useState<Set<string>>(new Set()); // projectIds with active API requests

  // Listen for project API loading events from ActionsPanel
  useEffect(() => {
    const handler = (e: Event) => {
      const { projectId, loading } = (e as CustomEvent).detail;
      setApiLoadingProjects(prev => {
        const next = new Set(prev);
        if (loading) next.add(projectId);
        else next.delete(projectId);
        return next;
      });
    };
    window.addEventListener('project:api-loading', handler);
    return () => window.removeEventListener('project:api-loading', handler);
  }, []);

  // Drag area resize
  const isResizingDragArea = useRef(false);

  const handleDragAreaResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isResizingDragArea.current = true;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    const handleMouseMove = (ev: MouseEvent) => {
      if (!isResizingDragArea.current) return;
      const newWidth = window.innerWidth - ev.clientX;
      setDragAreaWidth(newWidth);
    };

    const handleMouseUp = () => {
      isResizingDragArea.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
  }, [setDragAreaWidth]);

  // Renaming projects in tabs
  const [editingProjectId, setEditingProjectId] = useState<string | null>(null);
  const [projectEditValue, setProjectEditValue] = useState('');
  const [lastCreatedProjectId, setLastCreatedProjectId] = useState<string | null>(null);
  const [previousProjectId, setPreviousProjectId] = useState<string | null>(null);

  const handleStartEditingProject = (projectId: string, currentName: string) => {
    setEditingProjectId(projectId);
    setProjectEditValue(currentName);
  };

  const handleSubmitProjectRename = async () => {
    const isNewAndUnchanged = editingProjectId === lastCreatedProjectId && projectEditValue.trim() === 'Новый проект';
    const isDraft = editingProjectId === lastCreatedProjectId;

    if (editingProjectId && projectEditValue.trim() && !isNewAndUnchanged) {
      await updateProject(editingProjectId, { name: projectEditValue.trim() });

      if (isDraft) {
        // Draft mode: also create Terminal 1 now that project is confirmed
        const { openProjects: op, createTab: ct, setProjectView: spv } = useWorkspaceStore.getState();
        const ws = op.get(editingProjectId);
        if (ws && ws.tabs.size === 0) {
          const cwd = ws.projectPath?.startsWith('__unset__') ? undefined : ws.projectPath;
          await ct(editingProjectId, 'Terminal 1', cwd);
          spv(editingProjectId, 'terminal');
        }
      }

      setEditingProjectId(null);
      setLastCreatedProjectId(null);
      setPreviousProjectId(null);
    } else if (editingProjectId) {
      handleCancelProjectRename();
    }
  };

  const handleCancelProjectRename = async (draftProjectId?: string) => {
    const idToCancel = draftProjectId || editingProjectId;
    const isDraftCancel = idToCancel === lastCreatedProjectId;

    if (isDraftCancel && idToCancel) {
      const idToRestore = previousProjectId;

      // VSCode behavior: if we cancel creating a new project, delete it
      setEditingProjectId(null);
      setLastCreatedProjectId(null);
      setPreviousProjectId(null);

      await closeProject(idToCancel);
      await ipcRenderer.invoke('project:delete', idToCancel);
      await loadProjects(); // Refresh global projects list

      // Return to previous project if it exists
      if (idToRestore && openProjects.has(idToRestore)) {
        const prevProj = openProjects.get(idToRestore);
        if (prevProj) {
          openProject(idToRestore, prevProj.projectPath);
        }
      }

      showToast('Project creation cancelled', 'info');
    } else {
      setEditingProjectId(null);
      setLastCreatedProjectId(null);
      setPreviousProjectId(null);
    }
  };

  const handleCreateNewProject = async () => {
    try {
      // Remember where we are before switching
      setPreviousProjectId(activeProjectId);

      const newProject = await ipcRenderer.invoke('project:create-empty', { name: 'Новый проект' });
      if (newProject) {
        // 1. Reload projects in store to include the new one
        await loadProjects();

        // 2. Calculate new order: insert after current or at start
        const currentOrder = Array.from(openProjects.keys());
        let insertIndex = 0;

        if (view === 'workspace' && activeProjectId) {
          const currentIndex = currentOrder.indexOf(activeProjectId);
          if (currentIndex !== -1) {
            insertIndex = currentIndex + 1;
          }
        }

        const newOrder = [...currentOrder];
        newOrder.splice(insertIndex, 0, newProject.id);

        // 3. Apply new order and open in draft mode (Home view, no terminal)
        reorderProjects(newOrder);
        openProject(newProject.id, newProject.path, { draft: true });

        // 4. Set area focus
        setActiveArea('projects');
        // 5. Mark as draft — ProjectHome owns the input, title bar shows synced text
        setLastCreatedProjectId(newProject.id);
        setEditingProjectId(null);
        setProjectEditValue(newProject.name);

        // 6. Signal ProjectHome to enter draft mode (deferred so component is mounted)
        setTimeout(() => {
          window.dispatchEvent(new CustomEvent('project:draft-init', {
            detail: { projectId: newProject.id, name: newProject.name }
          }));
        }, 50);
      }
    } catch (err) {
      console.error('Failed to create project:', err);
      showToast('Failed to create project', 'error');
    }
  };

  // Load projects, AI prompts, and restore session ONCE on mount
  useEffect(() => {
    loadProjects();
    restoreSession();
    usePromptsStore.getState().loadPrompts();
  }, []); // Empty deps = only on mount

  // Sync apiSettings + docPrompt to main process (for MCP update_docs tool)
  useEffect(() => {
    const syncToMain = () => {
      const { apiSettings, docPrompt } = useUIStore.getState();
      ipcRenderer.invoke('docs:sync-settings', { apiSettings, docPrompt });
    };

    // Sync on mount
    syncToMain();

    // Sync on changes
    let prev = JSON.stringify({ a: useUIStore.getState().apiSettings, d: useUIStore.getState().docPrompt });
    const unsub = useUIStore.subscribe((state) => {
      const curr = JSON.stringify({ a: state.apiSettings, d: state.docPrompt });
      if (curr !== prev) {
        prev = curr;
        ipcRenderer.invoke('docs:sync-settings', { apiSettings: state.apiSettings, docPrompt: state.docPrompt });
      }
    });
    return unsub;
  }, []);

  // Listen for draft project events from ProjectHome
  useEffect(() => {
    const handleDraftSubmit = async (e: any) => {
      const { projectId, name, path } = e.detail;
      if (projectId !== lastCreatedProjectId) return;

      // Update project in DB
      const updates: any = {};
      if (name) updates.name = name;
      if (path) updates.path = path;
      await updateProject(projectId, updates);

      setLastCreatedProjectId(null);
      setPreviousProjectId(null);
      setEditingProjectId(null);

      // Create Terminal 1 now that project is confirmed
      const { openProjects: op, createTab: ct, setProjectView: spv } = useWorkspaceStore.getState();
      const ws = op.get(projectId);
      if (ws && ws.tabs.size === 0) {
        // Don't pass __unset__ paths — createTab will fallback to HOME
        const cwd = path || (ws.projectPath?.startsWith('__unset__') ? undefined : ws.projectPath);
        await ct(projectId, 'Terminal 1', cwd);
        spv(projectId, 'terminal');
      }
    };

    const handleDraftCancel = (e: any) => {
      const { projectId } = e.detail;
      if (projectId !== lastCreatedProjectId) return;
      handleCancelProjectRename(projectId);
    };

    // Bidirectional name sync: when ProjectHome changes name, update title bar display/edit value
    const handleNameSync = (e: any) => {
      const id = e.detail.projectId;
      if (e.detail.source === 'titlebar') return;
      // Update title bar edit value if editing this project
      if (id === editingProjectId) {
        setProjectEditValue(e.detail.name);
      }
      // Update title bar display name if this is a draft project
      if (id === lastCreatedProjectId) {
        setProjectEditValue(e.detail.name);
      }
    };

    // Start editing from ProjectHome pencil → also enable title bar input
    const handleEditStart = (e: any) => {
      const { projectId, name } = e.detail;
      setEditingProjectId(projectId);
      setProjectEditValue(name);
    };

    // End editing from ProjectHome → also disable title bar input
    const handleEditEnd = (e: any) => {
      const { projectId } = e.detail;
      if (editingProjectId === projectId) {
        setEditingProjectId(null);
      }
    };

    window.addEventListener('project:draft-submit', handleDraftSubmit);
    window.addEventListener('project:draft-cancel', handleDraftCancel);
    window.addEventListener('project:name-sync', handleNameSync);
    window.addEventListener('project:edit-start', handleEditStart);
    window.addEventListener('project:edit-end', handleEditEnd);
    return () => {
      window.removeEventListener('project:draft-submit', handleDraftSubmit);
      window.removeEventListener('project:draft-cancel', handleDraftCancel);
      window.removeEventListener('project:name-sync', handleNameSync);
      window.removeEventListener('project:edit-start', handleEditStart);
      window.removeEventListener('project:edit-end', handleEditEnd);
    };
  }, [lastCreatedProjectId, editingProjectId]);

  // Track process status via OSC 133 events
  useEffect(() => {
    // Initial load: get state for all tabs
    const initProcessStatus = async () => {
      const allTabIds: string[] = [];
      openProjects.forEach((workspace) => {
        workspace.tabs.forEach((_, tabId) => {
          allTabIds.push(tabId);
        });
      });

      const newStatus = new Map<string, boolean>();
      await Promise.all(
        allTabIds.map(async (tabId) => {
          try {
            const state = await ipcRenderer.invoke('terminal:getCommandState', tabId);
            newStatus.set(tabId, state?.isRunning || false);
          } catch {
            newStatus.set(tabId, false);
          }
        })
      );
      setProcessStatus(newStatus);
    };
    initProcessStatus();

    // Listen for command start/finish
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

    // MCP sub-agent tab creation (main process → renderer)
    const handleMcpCreateSubAgent = async (_: any, data: { taskId: string; geminiTabId: string; cwd?: string }) => {
      const state = useWorkspaceStore.getState();
      const { openProjects } = state;

      // Find the project that actually contains the Gemini tab (NOT activeProjectId —
      // user may be viewing a different project when delegation happens)
      let targetProjectId: string | null = null;
      let workspace: any = null;
      for (const [projId, ws] of openProjects) {
        if (ws.tabs.has(data.geminiTabId)) {
          targetProjectId = projId;
          workspace = ws;
          break;
        }
      }
      if (!targetProjectId || !workspace) {
        console.warn('[MCP:SubAgent] Gemini tab not found in any project:', data.geminiTabId);
        ipcRenderer.send('mcp:sub-agent-tab-created', { error: 'Gemini tab not found in any open project' });
        return;
      }

      // Use CWD from main process (reliable), fallback to Gemini tab or project path
      const geminiTab = workspace.tabs.get(data.geminiTabId);
      const cwd = data.cwd || geminiTab?.cwd || workspace.projectPath || '';

      try {
        const tabId = await state.createTab(targetProjectId, 'claude-sub', cwd, {
          commandType: 'claude',
          color: 'claude',
          background: true,
          parentTabId: data.geminiTabId,
          mcpTaskId: data.taskId,
          claudeSessionId: data.claudeSessionId || undefined,
        } as any);

        // Note: claudeActive will be set by mcp:claude-cli-active when Claude CLI actually launches
        const createdTab = useWorkspaceStore.getState().openProjects.get(targetProjectId)?.tabs.get(tabId);
        ipcRenderer.send('mcp:sub-agent-tab-created', { tabId, taskId: data.taskId, tabName: createdTab?.name || 'claude-sub' });
      } catch (err: any) {
        ipcRenderer.send('mcp:sub-agent-tab-created', { error: err.message });
      }
    };

    // MCP rename sub-agent tab (main process → renderer)
    const handleMcpRenameSubAgent = (_: any, data: { claudeTabId: string; name: string }) => {
      const state = useWorkspaceStore.getState();
      for (const [projId, ws] of state.openProjects) {
        if (ws.tabs.has(data.claudeTabId)) {
          state.renameTab(projId, data.claudeTabId, data.name);
          break;
        }
      }
    };

    // MCP task status updates (main process → renderer): set claudeAgentStatus on sub-agent tabs
    const handleMcpTaskStatus = (_: any, data: { taskId: string; claudeTabId: string; status: string }) => {
      const state = useWorkspaceStore.getState();
      const statusMap: Record<string, 'running' | 'done' | 'error' | 'idle'> = {
        running: 'running',
        completed: 'done',
        error: 'error',
        timeout: 'error',
      };
      const mapped = statusMap[data.status];
      if (mapped && data.claudeTabId) {
        state.setClaudeAgentStatus(data.claudeTabId, mapped);
      }
    };

    // PTY exit → Claude CLI is dead
    const handleTerminalExit = (_: any, tabId: string) => {
      const state = useWorkspaceStore.getState();
      state.setClaudeActive(tabId, false);
    };

    // Claude CLI launched/resumed in PTY (from main.js delegate/continue)
    const handleClaudeCliActive = (_: any, data: { tabId: string; active: boolean }) => {
      const state = useWorkspaceStore.getState();
      state.setClaudeActive(data.tabId, data.active);
    };

    // Claude CLI spinner busy/idle → track on sub-agent tab + project badge
    const handleClaudeBusyState = (_: any, data: { tabId: string; busy: boolean }) => {
      console.warn('[App:BusyState] tabId=' + data.tabId.slice(-8) + ' busy=' + data.busy);
      const state = useWorkspaceStore.getState();
      state.setClaudeBusy(data.tabId, data.busy);
      setBusyTabs(prev => { const n = new Map(prev); if (data.busy) n.set(data.tabId, true); else n.delete(data.tabId); return n; });
    };

    // Interceptor state (armed/disarmed) for sub-agent response delivery
    const handleInterceptorState = (_: any, data: { claudeTabId: string; state: 'armed' | 'disarmed' | null }) => {
      const state = useWorkspaceStore.getState();
      state.setInterceptorState(data.claudeTabId, data.state);
    };

    // MCP close sub-agent tab (main process → renderer, triggered by Gemini via close_sub_agent tool)
    const handleMcpCloseSubAgent = (_: any, data: { claudeTabId: string }) => {
      const state = useWorkspaceStore.getState();
      for (const [projId, ws] of state.openProjects) {
        if (ws.tabs.has(data.claudeTabId)) {
          state.closeTab(projId, data.claudeTabId, { skipProcessCheck: true });
          break;
        }
      }
    };

    // MCP respawn PTY for dead sub-agent (continue_claude needs a live PTY)
    const handleRespawnSubAgentPty = (_: any, data: { tabId: string; cwd: string }) => {
      console.warn('[MCP:Respawn] Creating PTY for dead sub-agent tab:', data.tabId);
      ipcRenderer.invoke('terminal:create', { tabId: data.tabId, cwd: data.cwd, rows: 32, cols: 96 });
    };

    // Gemini auto-spawn: main process requests Gemini launch (adopt flow)
    const handleGeminiAutoSpawn = (_: any, data: { tabId: string; cwd: string; yesMode: boolean }) => {
      console.warn('[Adopt:AutoSpawn] Launching Gemini for tab:', data.tabId);
      const store = useWorkspaceStore.getState();
      store.setTabCommandType(data.tabId, 'gemini');
      ipcRenderer.send('gemini:spawn-with-watcher', {
        tabId: data.tabId,
        cwd: data.cwd,
        yesMode: data.yesMode,
      });
    };

    ipcRenderer.on('terminal:command-started', handleCommandStarted);
    ipcRenderer.on('terminal:command-finished', handleCommandFinished);
    ipcRenderer.on('mcp:create-sub-agent-tab', handleMcpCreateSubAgent);
    ipcRenderer.on('mcp:rename-sub-agent-tab', handleMcpRenameSubAgent);
    ipcRenderer.on('mcp:task-status', handleMcpTaskStatus);
    ipcRenderer.on('terminal:exit', handleTerminalExit);
    ipcRenderer.on('mcp:claude-cli-active', handleClaudeCliActive);
    ipcRenderer.on('claude:busy-state', handleClaudeBusyState);
    ipcRenderer.on('mcp:interceptor-state', handleInterceptorState);
    ipcRenderer.on('mcp:close-sub-agent-tab', handleMcpCloseSubAgent);
    ipcRenderer.on('mcp:respawn-sub-agent-pty', handleRespawnSubAgentPty);
    ipcRenderer.on('gemini:auto-spawn', handleGeminiAutoSpawn);

    // Gemini busy state → project badge spinner
    const handleGeminiBusy = (_: any, { tabId, busy }: { tabId: string; busy: boolean }) => {
      setBusyTabs(prev => { const n = new Map(prev); if (busy) n.set(tabId, true); else n.delete(tabId); return n; });
    };
    ipcRenderer.on('gemini:busy-state', handleGeminiBusy);

    return () => {
      ipcRenderer.removeListener('terminal:command-started', handleCommandStarted);
      ipcRenderer.removeListener('terminal:command-finished', handleCommandFinished);
      ipcRenderer.removeListener('mcp:create-sub-agent-tab', handleMcpCreateSubAgent);
      ipcRenderer.removeListener('mcp:rename-sub-agent-tab', handleMcpRenameSubAgent);
      ipcRenderer.removeListener('mcp:task-status', handleMcpTaskStatus);
      ipcRenderer.removeListener('terminal:exit', handleTerminalExit);
      ipcRenderer.removeListener('mcp:claude-cli-active', handleClaudeCliActive);
      ipcRenderer.removeListener('claude:busy-state', handleClaudeBusyState);
      ipcRenderer.removeListener('mcp:interceptor-state', handleInterceptorState);
      ipcRenderer.removeListener('mcp:close-sub-agent-tab', handleMcpCloseSubAgent);
      ipcRenderer.removeListener('mcp:respawn-sub-agent-pty', handleRespawnSubAgentPty);
      ipcRenderer.removeListener('gemini:auto-spawn', handleGeminiAutoSpawn);
      ipcRenderer.removeListener('gemini:busy-state', handleGeminiBusy);
    };
  }, [openProjects.size]); // Re-init when projects change

  // Save session and mark Claude sessions as interrupted when app closes
  useEffect(() => {
    const handleBeforeUnload = () => {
      const state = useWorkspaceStore.getState();
      // Save session immediately (without debounce)
      // NOTE: interrupted state is NOT managed here — main process will-quit handler
      // sets wasInterrupted AFTER this save completes, avoiding race conditions.
      state.saveSessionImmediate();
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, []);

  // Auto-resume interrupted sessions — Zustand subscribe instead of useEffect.
  // Problem: React batches set({isRestoring:true}) + set({isRestoring:false}) from
  // restoreSession() into one update — useEffect never sees isRestoring=true.
  // subscribe() fires synchronously on each set(), catching both transitions.
  useEffect(() => {
    let sawTrue = false;
    let triggered = false;
    const unsub = useWorkspaceStore.subscribe((state, prev) => {
      if (state.isRestoring && !prev.isRestoring) {
        sawTrue = true;
        console.warn('[AutoResume] isRestoring → true');
      }
      if (sawTrue && !state.isRestoring && prev.isRestoring && !triggered) {
        triggered = true;
        console.warn('[AutoResume] isRestoring → false, triggering');
        (async () => {
          try {
            const autoResume = await ipcRenderer.invoke('app:getState', 'auto_resume_sessions');
            if (autoResume !== true && autoResume !== 'true') {
              console.warn('[AutoResume] Disabled in settings');
              return;
            }
            const s = useWorkspaceStore.getState();
            const tabs: { tabId: string; sessionId: string }[] = [];
            for (const [, ws] of s.openProjects) {
              for (const [tabId, tab] of ws.tabs) {
                if (tab.wasInterrupted && tab.claudeSessionId && !tab.overlayDismissed &&
                    (tab.commandType === 'claude' || tab.color === 'claude')) {
                  tabs.push({ tabId, sessionId: tab.claudeSessionId });
                }
              }
            }
            if (tabs.length === 0) { console.warn('[AutoResume] No interrupted tabs'); return; }
            console.warn('[AutoResume] Resuming', tabs.length, 'sessions');
            for (const { tabId, sessionId } of tabs) {
              s.clearInterruptedState(tabId);
              s.setTabCommandType(tabId, 'claude');
              ipcRenderer.send('terminal:input', tabId, 'claude --dangerously-skip-permissions --resume ' + sessionId + '\r');
              ipcRenderer.send('terminal:force-command-started', { tabId });
              console.warn('[AutoResume] Resumed', tabId, sessionId.substring(0, 8));
            }
          } catch (e: any) {
            console.warn('[AutoResume] Error:', e?.message || String(e));
          }
        })();
      }
    });
    return () => unsub();
  }, []);

  // Monitor drag-and-drop for project tabs reordering
  useEffect(() => {
    return monitorForElements({
      canMonitor: ({ source }) => source.data.type === 'PROJECT_TAB',
      onDrop({ source, location }) {
        const target = location.current.dropTargets[0];
        if (!target) return;

        const sourceData = source.data as { type: string; id: string; index: number };
        const targetData = target.data as { type: string; id: string; index: number };

        if (targetData.type !== 'PROJECT_TAB') return;
        if (sourceData.id === targetData.id) return;

        // Get current project order
        const currentOrder = Array.from(useWorkspaceStore.getState().openProjects.keys());
        const sourceIndex = currentOrder.indexOf(sourceData.id);
        const targetIndex = currentOrder.indexOf(targetData.id);

        if (sourceIndex === -1 || targetIndex === -1) return;

        // Calculate insertion index based on edge
        const edge = extractClosestEdge(targetData);
        let insertIndex = targetIndex;
        if (edge === 'right') {
          insertIndex = targetIndex + 1;
        }

        // Adjust if moving forward
        if (sourceIndex < insertIndex) {
          insertIndex--;
        }

        // Create new order
        const newOrder = [...currentOrder];
        newOrder.splice(sourceIndex, 1);
        newOrder.splice(insertIndex, 0, sourceData.id);

        reorderProjects(newOrder);
      },
    });
  }, [reorderProjects]);

  useEffect(() => {

    // Listen for openProject events
    const handleOpenProject = (e: any) => {
      const project = e.detail;
      openProject(project.id, project.path);
    };

    window.addEventListener('openProject', handleOpenProject);

    // Global Hotkeys
    const handleKeyDown = (e: KeyboardEvent) => {
      // Debug: log all Cmd+key combinations
      if (e.metaKey) {
        console.log('[Hotkey] Cmd +', e.code, e.key, 'view:', view);
      }

      // Cmd+. - Open VS Code in current terminal's CWD
      if (e.metaKey && e.key === '.') {
        e.preventDefault();
        const activeProject = getActiveProject();
        const currentProject = projects[activeProjectId!];
        const effectiveId = getEffectiveTabId();
        const currentTab = effectiveId && activeProject ? activeProject.tabs.get(effectiveId) : null;
        const cwd = currentTab?.cwd || currentProject?.path || process.env.HOME;
        console.log('[Hotkey] Opening VS Code in:', cwd);
        const { exec } = window.require('child_process');
        exec('code .', { cwd });
        return;
      }

      // Cmd+B - Toggle file explorer (legacy, also available via Cmd+E in Workspace)
      const isCmdB = e.code === 'KeyB';
      if (e.metaKey && isCmdB) {
        e.preventDefault();
        if (view === 'workspace' && activeProjectId) {
          if (filePreview) {
            closeFilePreview();
            setOpenFilePath(activeProjectId, null);
          }
          const { sidebarOpen } = getSidebarState(activeProjectId);
          setSidebarOpen(activeProjectId, !sidebarOpen);
        }
        return;
      }

      // Escape - Close file preview or clear area focus
      if (e.code === 'Escape') {
        if (filePreview) {
          e.preventDefault();
          closeFilePreview();
          if (activeProjectId) {
            setOpenFilePath(activeProjectId, null);
          }
          return;
        }
        if (activeArea === 'projects') {
          setActiveArea('workspace');
          return;
        }
      }

      // Cmd+T - New Tab or New Project
      if (e.metaKey && e.code === 'KeyT') {
        e.preventDefault();
        if (activeArea === 'projects') {
          handleCreateNewProject();
          return;
        }

        if (view === 'workspace' && activeProjectId) {
          useWorkspaceStore.getState().clearSelection(activeProjectId);
          const activeProject = getActiveProject();
          const currentProject = projects[activeProjectId];
          const effectiveId = getEffectiveTabId();
          if (currentProject && effectiveId) {
            // Get current tab's cwd (sub-agent aware)
            const currentTab = activeProject?.tabs.get(effectiveId);
            const cwd = currentTab?.cwd || currentProject.path;
            createTabAfterCurrent(activeProjectId, undefined, cwd);
          } else if (currentProject) {
            createTab(activeProjectId, undefined, currentProject.path);
          }
          // Switch to terminal view if on Home (per-project)
          const ws = useWorkspaceStore.getState().openProjects.get(activeProjectId);
          if (ws && ws.currentView !== 'terminal') {
            useWorkspaceStore.getState().setProjectView(activeProjectId, 'terminal');
          }
        }
        return;
      }

      // Arrow keys for project navigation (only when projects area is focused)
      if (activeArea === 'projects') {
        if (e.code === 'ArrowRight' || e.code === 'ArrowLeft') {
          // Skip navigation if currently editing a project name (Bug #307)
          if (editingProjectId) return;

          e.preventDefault();
          const projectIds = Array.from(openProjects.keys());
          if (projectIds.length === 0) return;

          const currentIndex = activeProjectId ? projectIds.indexOf(activeProjectId) : -1;
          let nextIndex = 0;

          if (e.code === 'ArrowRight') {
            nextIndex = (currentIndex + 1) % projectIds.length;
          } else {
            nextIndex = (currentIndex - 1 + projectIds.length) % projectIds.length;
          }

          const nextProjectId = projectIds[nextIndex];
          const nextProject = openProjects.get(nextProjectId);
          if (nextProject) {
            openProject(nextProjectId, nextProject.projectPath);
          }
        }
      }

      // Cmd+W - Close Tab/Project (context-aware)
      if (e.metaKey && e.code === 'KeyW') {
        e.preventDefault();
        if (view === 'workspace') {
          const activeProject = getActiveProject();
          // If viewing a sub-agent, close that sub-agent tab (same as regular tab)
          if (activeProject?.viewingSubAgentTabId) {
            const subTabId = activeProject.viewingSubAgentTabId;
            useWorkspaceStore.getState().setViewingSubAgent(null);
            closeTab(activeProjectId!, subTabId);
          } else if (activeProject && activeProject.activeTabId) {
            const selected = activeProject.selectedTabIds;
            if (selected.length > 1) {
              // Multi-select: close all selected tabs with batch confirmation
              (async () => {
                const running: { id: string; name: string }[] = [];
                for (const id of selected) {
                  const state = await ipcRenderer.invoke('terminal:getCommandState', id);
                  if (state.isRunning) {
                    const { processName } = await ipcRenderer.invoke('terminal:hasRunningProcess', id);
                    running.push({ id, name: processName || 'unknown' });
                  }
                }

                let confirmed = true;
                if (running.length > 0) {
                  confirmed = window.confirm(
                    `${running.length} tab(s) have running processes:\n${running.map(r => `\u2022 ${r.name}`).join('\n')}\n\nClose all ${selected.length} tabs?`
                  );
                } else {
                  confirmed = window.confirm(`Close ${selected.length} tabs?`);
                }

                if (confirmed) {
                  for (const id of selected) {
                    await closeTab(activeProjectId!, id, { skipProcessCheck: true, forceCleanup: true });
                  }
                }
              })();
            } else {
              closeTab(activeProjectId!, activeProject.activeTabId);
            }
          }
        } else {
          // On dashboard - close active project chip
          if (activeProjectId) {
            closeProject(activeProjectId);
          }
        }
        return;
      }

      // Cmd+, - Toggle Settings Modal
      if (e.metaKey && e.code === 'Comma') {
        e.preventDefault();
        setSettingsOpen(prev => !prev);
        return;
      }

      // Cmd+= (plus) - Increase ALL font sizes (gt-editor style)
      if (e.metaKey && (e.code === 'Equal' || e.code === 'NumpadAdd')) {
        e.preventDefault();
        incrementAllFontSizes();
        return;
      }

      // Cmd+- (minus) - Decrease ALL font sizes (gt-editor style)
      if (e.metaKey && (e.code === 'Minus' || e.code === 'NumpadSubtract')) {
        e.preventDefault();
        decrementAllFontSizes();
        return;
      }

      // Cmd+Shift+E - Toggle Research panel
      if (e.metaKey && e.shiftKey && e.code === 'KeyE') {
        e.preventDefault();
        if (view === 'workspace') {
          toggleResearch();
        }
        return;
      }
    };

    window.addEventListener('keydown', handleKeyDown);

    // Handle Context Menu commands from main process
    const handleContextMenuCommand = (_: any, cmd: string, data?: any) => {
      console.log('[ContextMenu] Command received:', cmd);
      if (cmd === 'ai-prompt') {
        // Dynamic AI prompt — data is the promptId
        const promptId = data as string;
        const terminalSelection = useUIStore.getState().terminalSelection;
        console.log('[ContextMenu] AI prompt:', promptId, 'Selection:', terminalSelection ? terminalSelection.slice(0, 50) : 'EMPTY');
        if (terminalSelection) {
          useResearchStore.getState().triggerResearch(promptId);
          console.log('[ContextMenu] Triggered', promptId, 'via store');
        } else {
          showToast('Select text in terminal first', 'error');
        }
      } else if (cmd === 'gemini-research') {
        // Legacy fallback
        const terminalSelection = useUIStore.getState().terminalSelection;
        if (terminalSelection) {
          useResearchStore.getState().triggerResearch('research');
        } else {
          showToast('Select text in terminal first', 'error');
        }
      } else if (cmd === 'gemini-compact') {
        // Legacy fallback
        const terminalSelection = useUIStore.getState().terminalSelection;
        if (terminalSelection) {
          useResearchStore.getState().triggerResearch('compact');
        } else {
          showToast('Select text in terminal first', 'error');
        }
      } else if (cmd === 'insert-prompt') {
        // Insert prompt text into effective terminal (sub-agent aware)
        const effectiveId = getEffectiveTabId();
        console.warn('[ContextMenu] insert-prompt: tabId=' + effectiveId + ' len=' + (data?.length || 0) + ' endsR=' + data?.endsWith('\r') + ' first30=' + JSON.stringify(data?.slice(0, 30)));
        if (effectiveId) {
          ipcRenderer.send('terminal:input', effectiveId, data);
        }
      } else if (cmd === 'add-to-favorites-from-terminal') {
        const { tabId: favTabId, projectId: favProjectId } = data || {};
        if (favTabId && favProjectId) {
          const ws = useWorkspaceStore.getState().openProjects.get(favProjectId);
          const tab = ws?.tabs.get(favTabId);
          if (tab) {
            ipcRenderer.invoke('project:add-favorite', {
              projectId: favProjectId,
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
      } else if (cmd === 'run-script') {
        // Run npm script or .sh file from terminal context menu
        const { tabId, command } = data || {};
        if (tabId && command) {
          ipcRenderer.send('terminal:input', tabId, command);
        }
      }
    };

    ipcRenderer.on('context-menu-command', handleContextMenuCommand);

    return () => {
      window.removeEventListener('openProject', handleOpenProject);
      window.removeEventListener('keydown', handleKeyDown);
      ipcRenderer.removeListener('context-menu-command', handleContextMenuCommand);
    };
  }, [view, activeProjectId, filePreview, incrementAllFontSizes, decrementAllFontSizes, toggleResearch, activeArea, openProjects, setActiveArea]);

  const openProjectsList = Array.from(openProjects.entries());

  // Show loading screen while restoring session
  if (isRestoring) {
    return <RestoreLoader />;
  }

  return (
    <div className="h-screen w-screen flex flex-col overflow-hidden bg-bg-main text-white">
      {/* Title Bar */}
      <div
        className={`title-bar h-[40px] transition-all duration-300 flex items-center select-none border-b ${
          activeArea === 'projects' 
            ? 'bg-white/[0.05] border-white/20 ring-1 ring-white/10 shadow-[inset_0_0_20px_rgba(255,255,255,0.02)]' 
            : 'bg-tab border-border-main'
        }`}
        style={{
          WebkitAppRegion: 'drag', // Window can be dragged by clicking any empty space
          paddingLeft: 'env(titlebar-area-x, 85px)'
        } as any}
      >
        {/* Project Tabs - portfolio style */}
        <div 
          className="flex items-center gap-1 px-2 h-full" 
          style={{ WebkitAppRegion: 'no-drag' } as any}
          onMouseDown={() => setActiveArea('projects')} // Focus projects when clicking this container
          onDoubleClick={(e) => {
            if (e.target === e.currentTarget) {
              handleCreateNewProject();
            }
          }}
          onClick={(e) => {
            if (e.target === e.currentTarget) {
              setActiveArea('projects');
            }
          }}
        >
          {/* Home / DEV indicator */}
          {window.location.hostname === 'localhost' ? (
            <button
              className="relative px-4 py-1.5 text-sm font-bold cursor-pointer transition-colors"
              style={{
                fontSize: `${projectTabsFontSize}px`,
                color: view === 'dashboard' ? '#fff' : '#9b59b6'
              }}
              onMouseEnter={(e) => { if (view !== 'dashboard') e.currentTarget.style.color = '#c084fc'; }}
              onMouseLeave={(e) => { if (view !== 'dashboard') e.currentTarget.style.color = '#9b59b6'; }}
              onClick={() => view === 'dashboard' && activeProjectId ? showWorkspace(activeProjectId) : showDashboard()}
              title="Development Mode - Dashboard"
            >
              {view === 'dashboard' && (
                <div className="absolute inset-0 rounded" style={{ backgroundColor: '#9b59b6' }} />
              )}
              <span className="relative z-10">[DEV]</span>
            </button>
          ) : (
            <button
              className={`relative px-3 py-1.5 text-sm font-medium cursor-pointer transition-colors ${
                view === 'dashboard'
                  ? 'text-black'
                  : 'text-gray-400 hover:text-white'
              }`}
              style={{ fontSize: `${projectTabsFontSize}px` }}
              onClick={() => view === 'dashboard' && activeProjectId ? showWorkspace(activeProjectId) : showDashboard()}
              title="Dashboard"
            >
              {view === 'dashboard' && (
                <div className="absolute inset-0 bg-white rounded" />
              )}
              <span className="relative z-10">🏠</span>
            </button>
          )}

          {/* Separator */}
          {openProjectsList.length > 0 && (
            <div className="h-5 w-px bg-[#444] mx-1" />
          )}

          {/* Open Projects (draggable) */}
          {openProjectsList.map(([projectId, workspace], index) => {
            const project = projects[projectId];
            if (!project) return null;
            
            // Project is active only if:
            // 1. We are in workspace view (not dashboard)
            // 2. It matches activeProjectId
            const isActive = view === 'workspace' && activeProjectId === projectId;
            const isLast = index === openProjectsList.length - 1;

            // Count active processes and busy tabs in this project
            let activeCount = 0;
            let hasBusyTab = false;
            workspace.tabs.forEach((_, tabId) => {
              if (processStatus.get(tabId)) activeCount++;
              if (busyTabs.get(tabId)) hasBusyTab = true;
            });

            // Count interrupted (paused) sessions
            // Count interrupted (paused) sessions using helper
            let interruptedCount = 0;
            workspace.tabs.forEach((tab) => {
              if (isTabInterrupted(tab)) interruptedCount++;
            });

            return (
              <ProjectTabItem
                key={projectId}
                projectId={projectId}
                projectName={lastCreatedProjectId === projectId ? projectEditValue : project.name}
                index={index}
                isActive={isActive}
                fontSize={projectTabsFontSize}
                forceRightIndicator={isLast && projectEmptyZoneHovered}
                activeProcessCount={activeCount}
                interruptedCount={interruptedCount}
                isProjectBusy={hasBusyTab || apiLoadingProjects.has(projectId)}
                isEditing={editingProjectId === projectId}
                editValue={projectEditValue}
                onEditChange={setProjectEditValue}
                onEditSubmit={handleSubmitProjectRename}
                onEditCancel={handleCancelProjectRename}
                isAreaActive={activeArea === 'projects'}
                isProjectLoading={apiLoadingProjects.has(projectId)}
                onClick={() => {
                  openProject(projectId, project.path);
                }}
                onDoubleClick={() => handleStartEditingProject(projectId, project.name)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setProjectContextMenu({ projectId, x: e.clientX, y: e.clientY });
                }}
                onMiddleClick={() => {
                  // Only warn if there are running processes (not just open terminals)
                  if (activeCount > 0) {
                    if (confirm(`Close "${project.name}"?\n\n${activeCount} running process(es) will be terminated.`)) {
                      closeProject(projectId);
                    }
                  } else {
                    closeProject(projectId);
                  }
                }}
                onTabDrop={(tabId, sourceProjectId, selectedTabIds) => {
                  const ids = selectedTabIds && selectedTabIds.length > 1 ? selectedTabIds : [tabId];
                  moveTabsToProject(sourceProjectId, ids, projectId);
                  openProject(projectId, project.path);
                }}
              />
            );
          })}
        </div>

        {/* Drag area + Empty drop zone for reordering */}
        <div className="flex flex-1 h-full items-center">
          <ProjectEmptyDropZone
            onMouseDown={() => setActiveArea('projects')}
            onDrop={(id) => {
              const currentOrder = openProjectsList.map(([id]) => id);
              const sourceIndex = currentOrder.indexOf(id);
              if (sourceIndex !== -1) {
                const newOrder = [...currentOrder];
                newOrder.splice(sourceIndex, 1);
                newOrder.push(id);
                reorderProjects(newOrder);
              }
            }}
            onHoverChange={setProjectEmptyZoneHovered}
            onDoubleClick={handleCreateNewProject}
          />
          
          {/* Resizable Window Drag Area */}
          <div className="relative h-full flex-shrink-0 flex" style={{ width: dragAreaWidth }}>
            {/* Resize handle */}
            <div
              className="w-[4px] h-full cursor-col-resize hover:bg-white/20 transition-colors flex-shrink-0"
              style={{ WebkitAppRegion: 'no-drag' } as any}
              onMouseDown={handleDragAreaResizeStart}
            />
            {/* Drag area */}
            <div
              className="flex-1 h-full cursor-default bg-white/[0.01] hover:bg-white/[0.03] transition-colors border-l border-white/5"
              style={{ WebkitAppRegion: 'drag' } as any}
              onMouseDown={() => setActiveArea('projects')}
              title="Drag window"
            />
          </div>
        </div>
      </div>

      {/* Content Area — Both rendered, CSS toggle preserves terminal instances */}
      <div
        className="flex-1 relative overflow-hidden flex flex-col"
        onMouseDown={() => setActiveArea(view === 'dashboard' ? 'projects' : 'workspace')}
      >
        {/* Dashboard — conditional render (no heavy state to preserve) */}
        {view === 'dashboard' && <Dashboard />}

        {/* Workspace — ALWAYS mounted, hidden via CSS to preserve xterm.js instances */}
        {/* visibility:hidden keeps container dimensions (prevents xterm 0x0 collapse) */}
        <div
          className="flex-1 flex flex-col"
          style={{
            visibility: view === 'workspace' ? 'visible' : 'hidden',
            position: view === 'workspace' ? 'relative' : 'absolute',
            ...(view !== 'workspace' ? { inset: 0, pointerEvents: 'none' as const } : {}),
          }}
        >
          <Workspace />
        </div>
      </div>

      {/* Global UI Components */}
      <ToastContainer />
      <EditProjectModal />
      <SessionInputModal />
      <SettingsModal isOpen={settingsOpen} onClose={() => setSettingsOpen(false)} />

      {/* Project Context Menu */}
      {projectContextMenu && (
        <>
          {/* Backdrop */}
          <div
            className="fixed inset-0 z-[99]"
            onClick={() => setProjectContextMenu(null)}
          />
          {/* Menu */}
          <div
            className="fixed bg-[#252526] border border-[#444] rounded-lg shadow-xl py-1 min-w-[140px] z-[100]"
            style={{ left: projectContextMenu.x, top: projectContextMenu.y }}
          >
            <button
              className="w-full text-left px-4 py-2 text-sm text-red-400 hover:bg-white/10 cursor-pointer"
              onClick={() => {
                const workspace = openProjects.get(projectContextMenu.projectId);
                const project = projects[projectContextMenu.projectId];
                // Count running processes in this project
                let runningCount = 0;
                workspace?.tabs.forEach((_, tabId) => {
                  if (processStatus.get(tabId)) runningCount++;
                });
                // Only warn if there are running processes
                if (runningCount > 0) {
                  if (confirm(`Close "${project?.name}"?\n\n${runningCount} running process(es) will be terminated.`)) {
                    closeProject(projectContextMenu.projectId);
                  }
                } else {
                  closeProject(projectContextMenu.projectId);
                }
                setProjectContextMenu(null);
              }}
            >
              Close Project
            </button>
          </div>
        </>
      )}
    </div>
  );
}

export default App;
