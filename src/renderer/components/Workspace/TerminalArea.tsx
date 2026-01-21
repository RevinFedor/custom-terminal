import React, { memo, useMemo, useEffect } from 'react';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';
import { useProjectsStore } from '../../store/useProjectsStore';
import Terminal from './Terminal';
import EmptyTerminalPlaceholder from './EmptyTerminalPlaceholder';

const { ipcRenderer } = window.require('electron');

interface TerminalAreaProps {
  projectId: string;
}

function TerminalArea({ projectId }: TerminalAreaProps) {
  // Use selectors to minimize re-renders
  const openProjects = useWorkspaceStore((state) => state.openProjects);
  const createTab = useWorkspaceStore((state) => state.createTab);
  const projects = useProjectsStore((state) => state.projects);

  const currentWorkspace = openProjects.get(projectId);
  const currentProject = projects[projectId];

  // Check if active project has no active Main tab
  const hasActiveMainTab = currentWorkspace?.activeTabId != null;

  const handleCreateTab = () => {
    if (currentProject) {
      createTab(projectId, undefined, currentProject.path);
    }
  };

  // Memoize terminal list to prevent unnecessary re-renders
  const terminals = useMemo(() => {
    const result: React.ReactNode[] = [];

    openProjects.forEach((workspace, projId) => {
      const isActiveProject = projId === projectId;

      workspace.tabs.forEach((tab) => {
        result.push(
          <Terminal
            key={tab.id}
            tabId={tab.id}
            cwd={tab.cwd}
            active={isActiveProject && workspace.activeTabId === tab.id}
            isActiveProject={isActiveProject}
          />
        );
      });
    });

    return result;
  }, [openProjects, projectId]);

  // Listen for Claude fork completion to create new tab with command
  useEffect(() => {
    const handleForkComplete = async (_: any, data: { success: boolean; newSessionId?: string; cwd?: string; error?: string }) => {
      console.log('[TerminalArea] Fork complete received:', data);
      if (!data.success || !data.newSessionId || !data.cwd) {
        console.error('[TerminalArea] Fork failed:', data.error);
        return;
      }

      // Create new tab with pending command
      const pendingCommand = `claude --resume ${data.newSessionId}`;
      console.log('[TerminalArea] Creating new tab with command:', pendingCommand);

      // Find project that contains this cwd
      let targetProjectId: string | null = null;
      openProjects.forEach((workspace, projId) => {
        if (workspace.projectPath === data.cwd || data.cwd?.startsWith(workspace.projectPath)) {
          targetProjectId = projId;
        }
      });

      if (!targetProjectId) {
        // Default to current project
        targetProjectId = projectId;
      }

      // Create new tab
      await createTab(targetProjectId, 'Claude Fork', data.cwd, {
        pendingCommand,
        claudeSessionId: data.newSessionId
      });
    };

    ipcRenderer.on('claude:fork-complete', handleForkComplete);
    return () => {
      ipcRenderer.removeListener('claude:fork-complete', handleForkComplete);
    };
  }, [createTab, openProjects, projectId]);

  // Handle double-click on empty space to create new tab
  const handleDoubleClick = (e: React.MouseEvent) => {
    console.log('[TerminalArea] Double click detected');
    console.log('[TerminalArea] target:', e.target);
    console.log('[TerminalArea] currentTarget:', e.currentTarget);
    console.log('[TerminalArea] target === currentTarget:', e.target === e.currentTarget);

    // Only trigger if clicking directly on the container (not on terminal)
    if (e.target === e.currentTarget) {
      console.log('[TerminalArea] Creating new tab...');
      handleCreateTab();
    }
  };

  // Render terminals for ALL open projects to prevent unmount/remount on project switch
  // This keeps terminal instances alive and prevents jitter
  return (
    <div
      className="absolute inset-0 bg-bg-main"
      onDoubleClick={handleDoubleClick}
    >
      {/* Show placeholder when no active tab */}
      {!hasActiveMainTab && currentProject && (
        <EmptyTerminalPlaceholder
          projectName={currentProject.name}
          onCreateTab={handleCreateTab}
        />
      )}

      {/* Render all terminals from all projects */}
      {terminals}
    </div>
  );
}

export default memo(TerminalArea);
