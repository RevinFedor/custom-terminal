import React, { useCallback, useMemo } from 'react';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';

interface SubAgentBarProps {
  projectId: string;
  viewingSubAgentTabId: string | null;
  onViewSubAgent: (tabId: string | null) => void;
}

export default function SubAgentBar({ projectId, viewingSubAgentTabId, onViewSubAgent }: SubAgentBarProps) {
  const getActiveProject = useWorkspaceStore((s) => s.getActiveProject);
  const getSubAgentTabs = useWorkspaceStore((s) => s.getSubAgentTabs);

  const project = getActiveProject();
  const activeTabId = project?.activeTabId;
  const activeTab = activeTabId ? project?.tabs.get(activeTabId) : null;

  const subAgentTabs = useMemo(() => {
    if (!activeTabId || activeTab?.commandType !== 'gemini') return [];
    return getSubAgentTabs(activeTabId);
  }, [activeTabId, activeTab?.commandType, getSubAgentTabs]);

  const handleChipClick = useCallback((tabId: string) => {
    if (viewingSubAgentTabId === tabId) {
      onViewSubAgent(null);
    } else {
      onViewSubAgent(tabId);
    }
  }, [viewingSubAgentTabId, onViewSubAgent]);

  const handleDetach = useCallback((e: React.MouseEvent, tabId: string) => {
    e.preventDefault();
    e.stopPropagation();
    const state = useWorkspaceStore.getState();
    state.setTabParent(tabId, '');
    onViewSubAgent(null);
  }, [onViewSubAgent]);

  const handleLabelClick = useCallback(() => {
    if (viewingSubAgentTabId) onViewSubAgent(null);
  }, [viewingSubAgentTabId, onViewSubAgent]);

  // Early return AFTER all hooks
  if (!project || !activeTabId || !activeTab) return null;
  if (activeTab.commandType !== 'gemini') return null;
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

      {subAgentTabs.map((tab, i) => {
        const isViewing = viewingSubAgentTabId === tab.id;
        const isRunning = tab.claudeAgentStatus === 'running' || (!tab.claudeAgentStatus && tab.claudeSessionId);
        const isDone = tab.claudeAgentStatus === 'done';
        const isError = tab.claudeAgentStatus === 'error';

        let indicatorColor = '#DA7756';
        if (isDone) indicatorColor = '#a6e3a1';
        if (isError) indicatorColor = '#f38ba8';

        return (
          <button
            key={tab.id}
            onClick={() => handleChipClick(tab.id)}
            onContextMenu={(e) => handleDetach(e, tab.id)}
            className="flex items-center gap-1.5 px-2 py-0.5 rounded transition-colors"
            style={{
              backgroundColor: isViewing ? 'rgba(204, 120, 50, 0.3)' : 'rgba(255,255,255,0.06)',
              border: isViewing ? '1px solid rgba(204, 120, 50, 0.5)' : '1px solid transparent',
              color: isViewing ? '#cc7832' : 'rgba(255,255,255,0.7)',
              cursor: 'pointer',
            }}
            title="Click to view, right-click to detach"
          >
            {/* Square indicator instead of robot emoji */}
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
