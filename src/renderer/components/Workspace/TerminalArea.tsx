import React from 'react';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';
import Terminal from './Terminal';

interface TerminalAreaProps {
  projectId: string;
}

export default function TerminalArea({ projectId }: TerminalAreaProps) {
  const { openProjects } = useWorkspaceStore();
  const workspace = openProjects.get(projectId);

  if (!workspace) return null;

  const tabs = Array.from(workspace.tabs.values());

  return (
    <div className="absolute inset-0 bg-bg-main">
      {tabs.map((tab) => (
        <Terminal
          key={tab.id}
          tabId={tab.id}
          cwd={tab.cwd}
          active={workspace.activeTabId === tab.id}
        />
      ))}
    </div>
  );
}
