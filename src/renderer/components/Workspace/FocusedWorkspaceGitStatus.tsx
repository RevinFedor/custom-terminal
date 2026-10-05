import React, { useMemo } from 'react';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';
import { useProjectsStore } from '../../store/useProjectsStore';
import GitStatusButton from './GitStatusButton';

type GitTarget = {
  projectId: string;
  tabId: string;
  projectPath: string;
  tabCwd: string;
};

// Return a primitive fingerprint: unrelated tab activity must not redraw Git.
export function focusedWorkspaceGitTargetKey(state: ReturnType<typeof useWorkspaceStore.getState>): string {
  if (state.view !== 'workspace') return '';
  const pane = state.splitPanes.length > 0 ? state.splitPanes[state.splitFocusedIndex] : null;
  // A vacant/chooser window owns focus even if another project has a live tab.
  if (state.splitPanes.length > 0 && (!pane?.tabId || pane.selectedSlotId || pane.displayHidden)) return '';
  const projectId = pane ? pane.projectId : state.activeProjectId;
  if (!projectId) return '';
  const workspace = state.openProjects.get(projectId);
  if (!workspace || (!pane && workspace.currentView !== 'terminal')) return '';
  const viewedTab = workspace.viewingSubAgentTabId
    ? workspace.tabs.get(workspace.viewingSubAgentTabId)
    : null;
  const tabId = pane ? pane.tabId : (
    viewedTab && viewedTab.parentTabId === workspace.activeTabId
      ? viewedTab.id
      : workspace.activeTabId
  );
  const tab = tabId ? workspace.tabs.get(tabId) : null;
  if (!tab?.cwd) return '';
  return JSON.stringify({ projectId, tabId: tab.id, projectPath: workspace.projectPath, tabCwd: tab.cwd });
}

function FocusedWorkspaceGitStatus() {
  const targetKey = useWorkspaceStore(focusedWorkspaceGitTargetKey);
  const target = useMemo<GitTarget | null>(() => targetKey ? JSON.parse(targetKey) : null, [targetKey]);
  const projectName = useProjectsStore((state) => target ? state.projects[target.projectId]?.name || '' : '');
  if (!target) return null;
  return (
    <div
      data-focused-workspace-git
      style={{ display: 'flex', alignItems: 'stretch', height: 22, borderRadius: 6, overflow: 'hidden', flexShrink: 0 }}
    >
      {/* Changing the shown tab or its path removes every old popup/action.
          GitStatusButton keeps status and unfinished drafts across remounts. */}
      <GitStatusButton
        key={targetKey}
        targetTabId={target.tabId}
        projectId={target.projectId}
        projectName={projectName}
        projectPath={target.projectPath}
        tabCwd={target.tabCwd}
        foreground
      />
    </div>
  );
}

export default React.memo(FocusedWorkspaceGitStatus);
