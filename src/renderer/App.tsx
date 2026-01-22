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

const { ipcRenderer } = window.require('electron');

function App() {
  const { view, showDashboard, openProject, openProjects, activeProjectId, closeProject, createTab, createTabAfterCurrent, closeTab, getActiveProject, restoreSession } = useWorkspaceStore();
  const { projects, loadProjects } = useProjectsStore();
  const { toggleFileExplorer, closeFilePreview, filePreview, showToast, incrementTerminalFontSize, decrementTerminalFontSize } = useUIStore();
  const { toggleResearch } = useResearchStore();
  const projectTabsFontSize = useUIStore((s) => s.projectTabsFontSize);
  const [settingsOpen, setSettingsOpen] = useState(false);

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

      // Cmd+= (plus) - Increase terminal font size
      if (e.metaKey && (e.code === 'Equal' || e.code === 'NumpadAdd')) {
        e.preventDefault();
        incrementTerminalFontSize();
        return;
      }

      // Cmd+- (minus) - Decrease terminal font size
      if (e.metaKey && (e.code === 'Minus' || e.code === 'NumpadSubtract')) {
        e.preventDefault();
        decrementTerminalFontSize();
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
  }, [view, activeProjectId, filePreview, incrementTerminalFontSize, decrementTerminalFontSize, toggleResearch]);

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
        {/* Project Chips */}
        <div className="flex items-center gap-2 px-2" style={{ WebkitAppRegion: 'no-drag' } as any}>
          {/* Home */}
          <button
            className={`project-chip flex items-center gap-1 px-3 py-0.5 rounded-xl border transition-all duration-150 h-[22px] cursor-pointer ${
              view === 'dashboard'
                ? 'bg-accent border-accent text-white'
                : 'bg-transparent border-border-main hover:bg-[#3a3a3c] hover:border-accent text-text-main'
            }`}
            style={{ fontSize: `${projectTabsFontSize}px` }}
            onClick={() => {
              showDashboard();
            }}
            title="Dashboard"
          >
            🏠
          </button>

          {/* Open Projects */}
          {openProjectsList.map(([projectId, workspace]) => {
            const project = projects[projectId];
            if (!project) return null;

            return (
              <div
                key={projectId}
                className={`project-chip group flex items-center gap-1 px-3 py-0.5 rounded-xl border transition-all duration-150 h-[22px] cursor-pointer ${
                  activeProjectId === projectId
                    ? 'bg-accent border-accent text-white'
                    : 'bg-transparent border-border-main hover:bg-[#3a3a3c] hover:border-accent text-text-main'
                }`}
                style={{ fontSize: `${projectTabsFontSize}px` }}
                onClick={() => openProject(projectId, project.path)}
              >
                <span className="max-w-[100px] truncate">{project.name}</span>
                <button
                  className="text-[10px] opacity-0 group-hover:opacity-100 hover:text-red-400 ml-1"
                  onClick={(e) => {
                    e.stopPropagation();
                    closeProject(projectId);
                  }}
                >
                  ×
                </button>
              </div>
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
    </div>
  );
}

export default App;
