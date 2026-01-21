import React, { useCallback } from 'react';
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

export default function Workspace() {
  const { activeProjectId, getActiveProject } = useWorkspaceStore();
  const { projects } = useProjectsStore();
  const { filePreview, closeFilePreview } = useUIStore();

  const activeProject = getActiveProject();
  const currentProject = activeProjectId ? projects[activeProjectId] : null;

  // Handle resize callback for terminal refit
  const handleResize = useCallback(() => {
    // Terminal will auto-refit via ResizeObserver
  }, []);

  // Tab creation is now handled in useWorkspaceStore.openProject()

  if (!activeProject || !activeProjectId || !currentProject) {
    return <div className="flex-1 bg-bg-main" />;
  }

  return (
    <div className="flex-1 flex flex-col h-full overflow-hidden">
      <TabBar projectId={activeProjectId} />

      <div className="flex-1 flex overflow-hidden min-h-0">
        {/* File Explorer */}
        <FileExplorer projectPath={currentProject.path} />

        {/* Main Terminal Area with FilePreview overlay */}
        <div className="flex-1 relative min-w-0">
          <TerminalArea projectId={activeProjectId} />

          {/* File Preview Overlay */}
          {filePreview && <FilePreview />}

          {/* Research Sheet */}
          <ResearchSheet projectId={activeProjectId} />
        </div>

        {/* Resizer */}
        {!filePreview && <Resizer onResize={handleResize} />}

        {/* Notes Panel */}
        {!filePreview && (
          <NotesPanel projectId={activeProjectId} project={currentProject} />
        )}
      </div>
    </div>
  );
}
