import React, { useEffect } from 'react';
import { useWorkspaceStore } from './store/useWorkspaceStore';
import { useProjectsStore } from './store/useProjectsStore';
import { useUIStore } from './store/useUIStore';
import Dashboard from './components/Dashboard/Dashboard';
import Workspace from './components/Workspace/Workspace';
import ToastContainer from './components/UI/Toast';
import EditProjectModal from './components/UI/EditProjectModal';
import SessionInputModal from './components/UI/SessionInputModal';

const { ipcRenderer } = window.require('electron');

function App() {
  const { view, showDashboard, openProject, openProjects, activeProjectId, closeProject, createTab, closeTab, getActiveProject, restoreSession } = useWorkspaceStore();
  const { projects, loadProjects } = useProjectsStore();
  const { toggleFileExplorer, closeFilePreview, filePreview, showToast } = useUIStore();

  // Load projects and restore session ONCE on mount
  useEffect(() => {
    loadProjects();
    restoreSession();
  }, []); // Empty deps = only on mount

  useEffect(() => {

    // Listen for openProject events
    const handleOpenProject = (e: any) => {
      const project = e.detail;
      openProject(project.id, project.path);
    };

    window.addEventListener('openProject', handleOpenProject);

    // Global Hotkeys
    const handleKeyDown = (e: KeyboardEvent) => {
      // Cmd+\ - Toggle file explorer
      if (e.metaKey && e.code === 'Backslash') {
        e.preventDefault();
        if (view === 'workspace') {
          toggleFileExplorer();
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

      // Cmd+T - New Tab (only in workspace)
      if (e.metaKey && e.code === 'KeyT') {
        e.preventDefault();
        if (view === 'workspace' && activeProjectId) {
          const currentProject = projects[activeProjectId];
          if (currentProject) {
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
    };

    window.addEventListener('keydown', handleKeyDown);

    // Handle Context Menu commands from main process
    const handleContextMenuCommand = (_: any, cmd: string, data?: any) => {
      if (cmd === 'gemini-research') {
        // Trigger Gemini research - switch to AI tab
        showToast('Select text and use AI tab', 'info');
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
  }, [view, activeProjectId, filePreview]);

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
            className={`project-chip flex items-center gap-1 px-3 py-0.5 rounded-xl text-xs border transition-all duration-150 h-[22px] cursor-pointer ${
              view === 'dashboard'
                ? 'bg-accent border-accent text-white'
                : 'bg-transparent border-border-main hover:bg-[#3a3a3c] hover:border-accent text-text-main'
            }`}
            onClick={() => {
              console.log('[App] Home button clicked');
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
                className={`project-chip group flex items-center gap-1 px-3 py-0.5 rounded-xl text-xs border transition-all duration-150 h-[22px] cursor-pointer ${
                  activeProjectId === projectId
                    ? 'bg-accent border-accent text-white'
                    : 'bg-transparent border-border-main hover:bg-[#3a3a3c] hover:border-accent text-text-main'
                }`}
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
    </div>
  );
}

export default App;
