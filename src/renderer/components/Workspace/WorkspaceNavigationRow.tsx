import React from 'react';
import { selectFocusedProjectId, useWorkspaceStore } from '../../store/useWorkspaceStore';
import { useUIStore } from '../../store/useUIStore';
import { INBOX_PROJECT_ID } from '../../constants/systemProjects';
import SidebarToolsRow from './SidebarToolsRow';
import SpaceStrip from './SpaceStrip';
import { GlobalRunAfterControl } from './GlobalRunAfterControl';

interface WorkspaceNavigationRowProps {
  dashboard: boolean;
  processStatus: ReadonlyMap<string, boolean>;
  busyTabs: ReadonlyMap<string, boolean>;
  pasteBusyTabs: ReadonlyMap<string, boolean>;
  inheritedBusyTabIds: ReadonlySet<string>;
  awaitingTabs: ReadonlyMap<string, boolean>;
}

/**
 * The project tools and workflow strip form one navigation row. It is owned by
 * App rather than Workspace so Dashboard navigation does not unmount or clone
 * either side: the same workflow chips remain visible on Home, while the
 * directory-owned side contracts to its History entry point.
 */
export default function WorkspaceNavigationRow({
  dashboard,
  processStatus,
  busyTabs,
  pasteBusyTabs,
  inheritedBusyTabIds,
  awaitingTabs,
}: WorkspaceNavigationRowProps) {
  const projectId = useWorkspaceStore((state) => (
    selectFocusedProjectId(state)
    || (state.openProjects.has(INBOX_PROJECT_ID) ? INBOX_PROJECT_ID : state.openProjects.keys().next().value || null)
  ));
  const sidebarWidth = useUIStore((state) => state.tabSidebarWidth);

  return (
    <div
      data-workspace-navigation-row
      data-workspace-navigation
      data-project-navigation
      className="flex shrink-0 min-w-0"
    >
      <div
        data-workspace-navigation-project-tools
        className="shrink-0 min-w-0"
        style={{ width: sidebarWidth }}
      >
        {projectId && (
          <SidebarToolsRow
            projectId={projectId}
            presentation={dashboard ? 'dashboard' : 'workspace'}
            trailingControls={<GlobalRunAfterControl />}
          />
        )}
      </div>
      <div data-workspace-navigation-workflows className="flex-1 min-w-0">
        <SpaceStrip
          processStatus={processStatus}
          busyTabs={busyTabs}
          pasteBusyTabs={pasteBusyTabs}
          inheritedBusyTabIds={inheritedBusyTabIds}
          awaitingTabs={awaitingTabs}
        />
      </div>
    </div>
  );
}
