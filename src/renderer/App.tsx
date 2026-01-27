import React, { useEffect, useState, useRef, memo } from 'react';
import { useWorkspaceStore } from './store/useWorkspaceStore';
import { useProjectsStore } from './store/useProjectsStore';
import { useUIStore } from './store/useUIStore';
import { useResearchStore } from './store/useResearchStore';
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
  onClick: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
  onMiddleClick: () => void;
}

const ProjectTabItem = memo(({
  projectId,
  projectName,
  index,
  isActive,
  fontSize,
  forceRightIndicator = false,
  onClick,
  onContextMenu,
  onMiddleClick
}: ProjectTabItemProps) => {
  const ref = useRef<HTMLButtonElement>(null);
  const [closestEdge, setClosestEdge] = useState<Edge | null>(null);
  const [isDragging, setIsDragging] = useState(false);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;

    return combine(
      draggable({
        element,
        getInitialData: () => ({ type: 'PROJECT_TAB', id: projectId, index }),
        onDragStart: () => setIsDragging(true),
        onDrop: () => setIsDragging(false),
      }),
      dropTargetForElements({
        element,
        getData: ({ input, element }) => {
          return attachClosestEdge(
            { type: 'PROJECT_TAB', id: projectId, index },
            { element, input, allowedEdges: ['left', 'right'] }
          );
        },
        canDrop: ({ source }) => source.data.type === 'PROJECT_TAB',
        onDragEnter: ({ source, self }) => {
          if (source.data.id === projectId) return;
          setClosestEdge(extractClosestEdge(self.data) as Edge | null);
        },
        onDrag: ({ source, self }) => {
          if (source.data.id === projectId) {
            setClosestEdge(null);
            return;
          }
          setClosestEdge(extractClosestEdge(self.data) as Edge | null);
        },
        onDragLeave: () => setClosestEdge(null),
        onDrop: () => setClosestEdge(null),
      })
    );
  }, [projectId, index]);

  return (
    <button
      ref={ref}
      className={`relative px-3 py-1.5 text-sm font-medium cursor-pointer transition-colors ${
        isActive ? 'text-black' : 'text-gray-400 hover:text-white'
      }`}
      style={{
        fontSize: `${fontSize}px`,
        opacity: isDragging ? 0.5 : 1
      }}
      onClick={onClick}
      onContextMenu={onContextMenu}
      onAuxClick={(e) => {
        if (e.button === 1) {
          e.preventDefault();
          onMiddleClick();
        }
      }}
    >
      {isActive && (
        <div className="absolute inset-0 bg-white rounded" />
      )}
      <span className="relative z-10 max-w-[120px] truncate block">{projectName}</span>
      {closestEdge && <ProjectDropIndicator edge={closestEdge as 'left' | 'right'} />}
      {forceRightIndicator && !closestEdge && <ProjectDropIndicator edge="right" />}
    </button>
  );
});

// Empty area drop zone for projects - for dropping at the end
// This area allows window dragging when not in a drag-drop operation
const ProjectEmptyDropZone = memo(({ onDrop, onHoverChange }: {
  onDrop: (projectId: string) => void;
  onHoverChange: (isOver: boolean) => void;
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
      className="flex-1 h-full min-w-[40px]"
      style={{
        // Allow window dragging when not in drag-drop operation
        WebkitAppRegion: isDragActive ? 'no-drag' : 'drag'
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
  const { view, showDashboard, openProject, openProjects, activeProjectId, closeProject, createTab, createTabAfterCurrent, closeTab, getActiveProject, restoreSession, reorderProjects, isRestoring } = useWorkspaceStore();
  const { projects, loadProjects } = useProjectsStore();
  const { toggleFileExplorer, closeFilePreview, filePreview, showToast, incrementAllFontSizes, decrementAllFontSizes } = useUIStore();
  const { toggleResearch } = useResearchStore();
  const projectTabsFontSize = useUIStore((s) => s.projectTabsFontSize);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [projectContextMenu, setProjectContextMenu] = useState<{ projectId: string; x: number; y: number } | null>(null);
  const [projectEmptyZoneHovered, setProjectEmptyZoneHovered] = useState(false);

  // Load projects and restore session ONCE on mount
  useEffect(() => {
    loadProjects();
    restoreSession();
  }, []); // Empty deps = only on mount

  // Save session and mark Claude sessions as interrupted when app closes
  useEffect(() => {
    const handleBeforeUnload = () => {
      const state = useWorkspaceStore.getState();
      // Save session immediately (without debounce)
      state.saveSessionImmediate();
      // Mark active Claude sessions as interrupted
      state.markAllSessionsInterrupted();
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
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

      // Cmd+\ or Cmd+B - Toggle file explorer (also close file preview if open)
      // Check both code and key for compatibility with different keyboards
      const isBackslash = e.code === 'Backslash' || e.key === '\\' || e.code === 'IntlBackslash';
      const isCmdB = e.code === 'KeyB';
      if (e.metaKey && (isBackslash || isCmdB)) {
        console.log('[Hotkey] FileExplorer toggle triggered, view:', view);
        e.preventDefault();
        if (view === 'workspace') {
          // Close file preview if open
          if (filePreview) {
            closeFilePreview();
          }
          console.log('[Hotkey] Calling toggleFileExplorer');
          toggleFileExplorer();
        } else {
          console.log('[Hotkey] Not in workspace view, skipping');
        }
        return;
      }

      // Escape - Close file preview
      if (e.code === 'Escape') {
        if (filePreview) {
          e.preventDefault();
          closeFilePreview();
          return;
        }
      }

      // Cmd+T - New Tab after current (only in workspace)
      if (e.metaKey && e.code === 'KeyT') {
        e.preventDefault();
        if (view === 'workspace' && activeProjectId) {
          const activeProject = getActiveProject();
          const currentProject = projects[activeProjectId];
          if (currentProject && activeProject?.activeTabId) {
            // Get current tab's cwd
            const currentTab = activeProject.tabs.get(activeProject.activeTabId);
            const cwd = currentTab?.cwd || currentProject.path;
            createTabAfterCurrent(activeProjectId, undefined, cwd);
          } else if (currentProject) {
            createTab(activeProjectId, undefined, currentProject.path);
          }
        }
        return;
      }

      // Cmd+W - Close Tab/Project (context-aware)
      if (e.metaKey && e.code === 'KeyW') {
        e.preventDefault();
        if (view === 'workspace') {
          // In workspace - close active tab
          const activeProject = getActiveProject();
          if (activeProject && activeProject.activeTabId) {
            closeTab(activeProjectId!, activeProject.activeTabId);
          }
        } else {
          // On dashboard - close active project chip
          if (activeProjectId) {
            closeProject(activeProjectId);
          }
        }
        return;
      }

      // Cmd+, - Open Settings Modal
      if (e.metaKey && e.code === 'Comma') {
        e.preventDefault();
        setSettingsOpen(true);
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

      // Cmd+Shift+R - Toggle Research panel
      if (e.metaKey && e.shiftKey && e.code === 'KeyR') {
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
      if (cmd === 'gemini-research') {
        // Trigger Research - same as clicking "Research Selection" button
        const terminalSelection = useUIStore.getState().terminalSelection;
        console.log('[ContextMenu] Selection:', terminalSelection ? terminalSelection.slice(0, 50) : 'EMPTY');
        if (terminalSelection) {
          // Use store to trigger research (survives panel mount)
          useResearchStore.getState().triggerResearch('research');
          console.log('[ContextMenu] Triggered research via store');
        } else {
          showToast('Select text in terminal first', 'error');
        }
      } else if (cmd === 'gemini-compact') {
        // Trigger Compact - summarize session
        const terminalSelection = useUIStore.getState().terminalSelection;
        console.log('[ContextMenu] Compact selection:', terminalSelection ? terminalSelection.slice(0, 50) : 'EMPTY');
        if (terminalSelection) {
          useResearchStore.getState().triggerResearch('compact');
          console.log('[ContextMenu] Triggered compact via store');
        } else {
          showToast('Select text in terminal first', 'error');
        }
      } else if (cmd === 'insert-prompt') {
        // Insert prompt text into active terminal
        const activeProject = getActiveProject();
        if (activeProject?.activeTabId) {
          ipcRenderer.send('terminal:input', activeProject.activeTabId, data);
        }
      }
    };

    ipcRenderer.on('context-menu-command', handleContextMenuCommand);

    return () => {
      window.removeEventListener('openProject', handleOpenProject);
      window.removeEventListener('keydown', handleKeyDown);
      ipcRenderer.removeListener('context-menu-command', handleContextMenuCommand);
    };
  }, [view, activeProjectId, filePreview, incrementAllFontSizes, decrementAllFontSizes, toggleResearch]);

  const openProjectsList = Array.from(openProjects.entries());

  // Show loading screen while restoring session
  if (isRestoring) {
    return <RestoreLoader />;
  }

  return (
    <div className="h-screen w-screen flex flex-col overflow-hidden bg-bg-main text-white">
      {/* Title Bar */}
      <div
        className="title-bar h-[40px] bg-tab border-b border-border-main flex items-center select-none"
        style={{
          WebkitAppRegion: 'drag',
          paddingLeft: 'env(titlebar-area-x, 85px)'
        } as any}
      >
        {/* Project Tabs - portfolio style */}
        <div className="flex items-center gap-1 px-2" style={{ WebkitAppRegion: 'no-drag' } as any}>
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
              onClick={() => showDashboard()}
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
              onClick={() => showDashboard()}
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
            const isActive = activeProjectId === projectId;
            const isLast = index === openProjectsList.length - 1;

            return (
              <ProjectTabItem
                key={projectId}
                projectId={projectId}
                projectName={project.name}
                index={index}
                isActive={isActive}
                fontSize={projectTabsFontSize}
                forceRightIndicator={isLast && projectEmptyZoneHovered}
                onClick={() => {
                  openProject(projectId, project.path);
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setProjectContextMenu({ projectId, x: e.clientX, y: e.clientY });
                }}
                onMiddleClick={() => {
                  const tabCount = workspace.tabs.size;
                  if (tabCount > 0) {
                    if (confirm(`Close "${project.name}"?\n${tabCount} terminal(s) will be closed.`)) {
                      closeProject(projectId);
                    }
                  } else {
                    closeProject(projectId);
                  }
                }}
              />
            );
          })}
        </div>

        {/* Drag area + Empty drop zone for reordering */}
        <ProjectEmptyDropZone
          onDrop={(projectId) => {
            // Move to end
            const currentOrder = Array.from(openProjects.keys());
            if (!currentOrder.includes(projectId)) return;
            const newOrder = currentOrder.filter(id => id !== projectId);
            newOrder.push(projectId);
            reorderProjects(newOrder);
          }}
          onHoverChange={setProjectEmptyZoneHovered}
        />
      </div>

      {/* Content */}
      {view === 'dashboard' ? <Dashboard /> : <Workspace />}

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
                const tabCount = workspace?.tabs.size || 0;
                if (tabCount > 0) {
                  if (confirm(`Close "${project?.name}"?\n${tabCount} terminal(s) will be closed.`)) {
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
