import React, { useCallback, useEffect } from 'react';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';
import { useProjectsStore } from '../../store/useProjectsStore';
import { useUIStore } from '../../store/useUIStore';
import TabBar from './TabBar';
import TerminalArea from './TerminalArea';
import NotesPanel from './NotesPanel';
import FileExplorer from './FileExplorer';
import FilePreview from './FilePreview';
import Resizer from './Resizer';
import ResearchSheet from '../Research/ResearchSheet';
import NotesEditorModal from './NotesEditorModal';

export default function Workspace() {
  const { activeProjectId, getActiveProject } = useWorkspaceStore();
  const { projects } = useProjectsStore();
  const { filePreview, openNotesEditor, notesEditorOpen } = useUIStore();

  const activeProject = getActiveProject();
  const currentProject = activeProjectId ? projects[activeProjectId] : null;

  // Handle resize callback for terminal refit
  const handleResize = useCallback(() => {
    // Terminal will auto-refit via ResizeObserver
  }, []);

  // CMD+E hotkey to open notes editor
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.metaKey && e.key === 'e' && !notesEditorOpen && activeProjectId) {
        e.preventDefault();
        openNotesEditor(activeProjectId);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [activeProjectId, notesEditorOpen, openNotesEditor]);

  // Tab creation is now handled in useWorkspaceStore.openProject()

  if (!activeProject || !activeProjectId || !currentProject) {
    return <div className="flex-1 bg-bg-main" />;
  }

  // Get current tab's cwd for FileExplorer (fallback to project path)
  const activeTab = activeProject.activeTabId
    ? activeProject.tabs.get(activeProject.activeTabId)
    : null;
  const explorerPath = activeTab?.cwd || currentProject.path;

  return (
    <div className="flex-1 flex flex-col h-full overflow-hidden">
      <TabBar projectId={activeProjectId} />

      <div className="flex-1 flex overflow-hidden min-h-0">
        {/* Main Terminal Area with FilePreview overlay */}
        <div className="flex-1 relative min-w-0">
          <TerminalArea projectId={activeProjectId} />

          {/* File Preview Overlay */}
          {filePreview && <FilePreview />}

          {/* Research Sheet */}
          <ResearchSheet projectId={activeProjectId} projectPath={currentProject.path} />
        </div>

        {/* Resizer */}
        {!filePreview && <Resizer onResize={handleResize} />}

        {/* Notes Panel */}
        {!filePreview && (
          <NotesPanel projectId={activeProjectId} project={currentProject} />
        )}
      </div>

      {/* File Explorer - opens in current terminal's directory */}
      <FileExplorer projectPath={explorerPath} />

      {/* Notes Editor Modal */}
      <NotesEditorModal />
    </div>
  );
}
