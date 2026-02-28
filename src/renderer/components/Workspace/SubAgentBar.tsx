import React, { useCallback, useEffect, useMemo } from 'react';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';

const { ipcRenderer } = window.require('electron');

interface SubAgentBarProps {
  projectId: string;
  viewingSubAgentTabId: string | null;
  onViewSubAgent: (tabId: string | null) => void;
}

export default function SubAgentBar({ projectId, viewingSubAgentTabId, onViewSubAgent }: SubAgentBarProps) {
  // Reactive primitives: re-renders when activeTabId or tabs.size changes
  const activeTabId = useWorkspaceStore((s) => s.openProjects.get(projectId)?.activeTabId);
  const tabsSize = useWorkspaceStore((s) => s.openProjects.get(projectId)?.tabs.size ?? 0);

  const activeCommandType = useWorkspaceStore((s) => {
    const workspace = s.openProjects.get(projectId);
    const tab = workspace?.tabs.get(workspace?.activeTabId ?? '');
    return tab?.commandType;
  });

  // Stable string key: re-derive sub-agents only when tab IDs or statuses change
  const subAgentKey = useWorkspaceStore((s) => {
    const workspace = s.openProjects.get(projectId);
    if (!workspace || !activeTabId) return '';
    const parts: string[] = [];
    for (const [, tab] of workspace.tabs) {
      if (tab.parentTabId === activeTabId) {
        parts.push(tab.id + ':' + (tab.claudeAgentStatus || ''));
      }
    }
    return parts.join(',');
  });

  // Derive full tab objects (recalculates only when key string changes)
  const subAgentTabs = useMemo(() => {
    if (!subAgentKey) return [];
    const state = useWorkspaceStore.getState();
    const workspace = state.openProjects.get(projectId);
    if (!workspace) return [];
    const result: any[] = [];
    for (const [, tab] of workspace.tabs) {
      if (tab.parentTabId === activeTabId) result.push(tab);
    }
    return result;
  }, [subAgentKey, projectId, activeTabId]);

  const handleChipClick = useCallback((tabId: string) => {
    if (viewingSubAgentTabId === tabId) {
      onViewSubAgent(null);
    } else {
      onViewSubAgent(tabId);
    }
  }, [viewingSubAgentTabId, onViewSubAgent]);

  const handleContextMenu = useCallback((e: React.MouseEvent, tab: any) => {
    e.preventDefault();
    e.stopPropagation();
    ipcRenderer.send('show-sub-agent-context-menu', {
      claudeTabId: tab.id,
      claudeSessionId: tab.claudeSessionId || null,
    });
  }, []);

  // Listen for detach command from native context menu
  useEffect(() => {
    const handler = (_: any, data: { action: string; claudeTabId: string }) => {
      if (data.action === 'detach') {
        const state = useWorkspaceStore.getState();
        state.setTabParent(data.claudeTabId, undefined as any);
        onViewSubAgent(null);
      }
    };
    ipcRenderer.on('sub-agent-context-menu-command', handler);
    return () => { ipcRenderer.removeListener('sub-agent-context-menu-command', handler); };
  }, [onViewSubAgent]);

  const handleLabelClick = useCallback(() => {
    if (viewingSubAgentTabId) onViewSubAgent(null);
  }, [viewingSubAgentTabId, onViewSubAgent]);

  // Early return AFTER all hooks
  if (activeCommandType !== 'gemini') return null;
  if (subAgentTabs.length === 0) return null;

  return (
    <div
      className="flex items-center gap-1.5 px-2 border-b border-border-main"
      style={{
        height: '28px',
        backgroundColor: 'rgba(30, 30, 30, 0.95)',
        fontSize: '11px',
      }}
    >
      {/* Fixed-width label that toggles between "Sub-agents:" and "← Back" — no layout shift */}
      <button
        onClick={handleLabelClick}
        className="flex items-center rounded transition-colors shrink-0"
        style={{
          fontSize: '10px',
          color: viewingSubAgentTabId ? 'rgba(255,255,255,0.6)' : 'rgba(255,255,255,0.35)',
          cursor: viewingSubAgentTabId ? 'pointer' : 'default',
          minWidth: '68px',
          background: viewingSubAgentTabId ? 'rgba(255,255,255,0.05)' : 'transparent',
          padding: '2px 6px',
        }}
      >
        {viewingSubAgentTabId ? '← Back' : 'Sub-agents:'}
      </button>

      {subAgentTabs.map((tab: any, i: number) => {
        const isViewing = viewingSubAgentTabId === tab.id;
        const isRunning = tab.claudeAgentStatus === 'running';
        const isDone = tab.claudeAgentStatus === 'done';
        const isError = tab.claudeAgentStatus === 'error';

        let indicatorColor = '#DA7756';
        if (isDone) indicatorColor = '#a6e3a1';
        if (isError) indicatorColor = '#f38ba8';

        return (
          <button
            key={tab.id}
            onClick={() => handleChipClick(tab.id)}
            onContextMenu={(e) => handleContextMenu(e, tab)}
            className="flex items-center gap-1.5 px-2 py-0.5 rounded transition-colors"
            style={{
              backgroundColor: isViewing ? 'rgba(204, 120, 50, 0.3)' : 'rgba(255,255,255,0.06)',
              border: isViewing ? '1px solid rgba(204, 120, 50, 0.5)' : '1px solid transparent',
              color: isViewing ? '#cc7832' : 'rgba(255,255,255,0.7)',
              cursor: 'pointer',
            }}
            title="Click to view, right-click for options"
          >
            {/* Square indicator */}
            <span
              style={{
                display: 'inline-block',
                width: '7px',
                height: '7px',
                borderRadius: '2px',
                backgroundColor: indicatorColor,
                boxShadow: isRunning ? `0 0 6px ${indicatorColor}80` : 'none',
                animation: isRunning ? 'tab-dot-pulse 1.5s ease-in-out infinite' : 'none',
              }}
            />
            <span>Claude #{i + 1}</span>
            {isDone && <span style={{ color: '#a6e3a1', fontSize: '10px' }}>✓</span>}
            {isError && <span style={{ color: '#f38ba8', fontSize: '10px' }}>✗</span>}
          </button>
        );
      })}

    </div>
  );
}
