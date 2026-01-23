import React, { useEffect, useState } from 'react';
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

// Initialize debug logger (exposes `debug` helper in console)
import './utils/logger';

const { ipcRenderer } = window.require('electron');

function App() {
  const { view, showDashboard, openProject, openProjects, activeProjectId, closeProject, createTab, createTabAfterCurrent, closeTab, getActiveProject, restoreSession } = useWorkspaceStore();
  const { projects, loadProjects } = useProjectsStore();
  const { toggleFileExplorer, closeFilePreview, filePreview, showToast, incrementAllFontSizes, decrementAllFontSizes } = useUIStore();
  const { toggleResearch } = useResearchStore();
  const projectTabsFontSize = useUIStore((s) => s.projectTabsFontSize);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [projectContextMenu, setProjectContextMenu] = useState<{ projectId: string; x: number; y: number } | null>(null);

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
          {/* Home */}
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

          {/* Separator */}
          {openProjectsList.length > 0 && (
            <div className="h-5 w-px bg-[#444] mx-1" />
          )}

          {/* Open Projects */}
          {openProjectsList.map(([projectId, workspace]) => {
            const project = projects[projectId];
            if (!project) return null;
            const isActive = activeProjectId === projectId;

            return (
              <button
                key={projectId}
                className={`relative px-3 py-1.5 text-sm font-medium cursor-pointer transition-colors ${
                  isActive ? 'text-black' : 'text-gray-400 hover:text-white'
                }`}
                style={{ fontSize: `${projectTabsFontSize}px` }}
                onClick={() => {
                  console.log('[ProjectTab] Click START:', projectId);
                  console.time('[ProjectTab] openProject');
                  openProject(projectId, project.path);
                  console.timeEnd('[ProjectTab] openProject');
                  console.log('[ProjectTab] Click END');
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setProjectContextMenu({ projectId, x: e.clientX, y: e.clientY });
                }}
                onAuxClick={(e) => {
                  // Middle mouse button (wheel click)
                  if (e.button === 1) {
                    e.preventDefault();
                    const tabCount = workspace.tabs.size;
                    if (tabCount > 0) {
                      if (confirm(`Close "${project.name}"?\n${tabCount} terminal(s) will be closed.`)) {
                        closeProject(projectId);
                      }
                    } else {
                      closeProject(projectId);
                    }
                  }
                }}
              >
                {isActive && (
                  <div className="absolute inset-0 bg-white rounded" />
                )}
                <span className="relative z-10 max-w-[120px] truncate block">{project.name}</span>
              </button>
            );
          })}
        </div>

        {/* Drag area */}
        <div className="flex-1" />
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
