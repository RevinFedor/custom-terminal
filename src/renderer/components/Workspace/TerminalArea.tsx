import React from 'react';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';
import { useProjectsStore } from '../../store/useProjectsStore';
import Terminal from './Terminal';
import EmptyTerminalPlaceholder from './EmptyTerminalPlaceholder';

interface TerminalAreaProps {
  projectId: string;
}

export default function TerminalArea({ projectId }: TerminalAreaProps) {
  const { openProjects, createTab } = useWorkspaceStore();
  const { projects } = useProjectsStore();

  const currentWorkspace = openProjects.get(projectId);
  const currentProject = projects[projectId];

  // Check if active project has no active Main tab
  const hasActiveMainTab = currentWorkspace?.activeTabId != null;

  const handleCreateTab = () => {
    if (currentProject) {
      createTab(projectId, undefined, currentProject.path);
    }
  };

  // Render terminals for ALL open projects to prevent unmount/remount on project switch
  // This keeps terminal instances alive and prevents jitter
  return (
    <div className="absolute inset-0 bg-bg-main">
      {/* Show placeholder when no active tab */}
      {!hasActiveMainTab && currentProject && (
        <EmptyTerminalPlaceholder
          projectName={currentProject.name}
          onCreateTab={handleCreateTab}
        />
      )}

      {/* Render all terminals from all projects */}
      {Array.from(openProjects.entries()).map(([projId, workspace]) => {
        const isActiveProject = projId === projectId;
        const tabs = Array.from(workspace.tabs.values());

        return tabs.map((tab) => (
          <Terminal
            key={tab.id}
            tabId={tab.id}
            cwd={tab.cwd}
            active={isActiveProject && workspace.activeTabId === tab.id}
          />
        ));
      })}
    </div>
  );
}
