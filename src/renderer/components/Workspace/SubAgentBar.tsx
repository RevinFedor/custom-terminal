import React, { useCallback, useEffect, useMemo } from 'react';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';

const { ipcRenderer } = window.require('electron');

interface SubAgentBarProps {
  projectId: string;
}

export default function SubAgentBar({ projectId }: SubAgentBarProps) {
  const viewingSubAgentTabId = useWorkspaceStore((s) => s.openProjects.get(projectId)?.viewingSubAgentTabId ?? null);
  const setViewingSubAgent = useWorkspaceStore((s) => s.setViewingSubAgent);
  // Reactive primitives: re-renders when activeTabId or tabs.size changes
  const activeTabId = useWorkspaceStore((s) => s.openProjects.get(projectId)?.activeTabId);
  const tabsSize = useWorkspaceStore((s) => s.openProjects.get(projectId)?.tabs.size ?? 0);

  const activeCommandType = useWorkspaceStore((s) => {
    const workspace = s.openProjects.get(projectId);
    const tab = workspace?.tabs.get(workspace?.activeTabId ?? '');
    return tab?.commandType;
  });

  // Stable string key: re-derive sub-agents only when tab IDs, statuses, claudeActive, busy, or taskCount change
  // Search CROSS-PROJECT: sub-agents may have been created in a different project (activeProjectId bug)
  const subAgentKey = useWorkspaceStore((s) => {
    if (!activeTabId) return '';
    const parts: string[] = [];
    for (const [, workspace] of s.openProjects) {
      for (const [, tab] of workspace.tabs) {
        if (tab.parentTabId === activeTabId) {
          parts.push(tab.id + ':' + (tab.claudeAgentStatus || '') + ':' + (tab.claudeActive ? '1' : '0') + ':' + (tab.claudeBusy ? '1' : '0') + ':' + (tab.claudeTaskCount || 0));
        }
      }
    }
    return parts.join(',');
  });

  // Derive full tab objects (recalculates only when key string changes)
  const subAgentTabs = useMemo(() => {
    if (!subAgentKey) return [];
    const state = useWorkspaceStore.getState();
    const result: any[] = [];
    for (const [, workspace] of state.openProjects) {
      for (const [, tab] of workspace.tabs) {
        if (tab.parentTabId === activeTabId) result.push(tab);
      }
    }
    return result;
  }, [subAgentKey, activeTabId]);

  const handleChipClick = useCallback((tabId: string) => {
    if (viewingSubAgentTabId === tabId) {
      setViewingSubAgent(null);
    } else {
      setViewingSubAgent(tabId);
    }
  }, [viewingSubAgentTabId, setViewingSubAgent]);

  // Middle-click to close sub-agent tab (same as regular tabs)
  const handleChipMiddleClick = useCallback((e: React.MouseEvent, tabId: string) => {
    if (e.button !== 1) return;
    e.preventDefault();
    if (viewingSubAgentTabId === tabId) setViewingSubAgent(null);
    useWorkspaceStore.getState().closeTab(projectId, tabId);
  }, [projectId, viewingSubAgentTabId, setViewingSubAgent]);

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
        setViewingSubAgent(null);
      }
    };
    ipcRenderer.on('sub-agent-context-menu-command', handler);
    return () => { ipcRenderer.removeListener('sub-agent-context-menu-command', handler); };
  }, [setViewingSubAgent]);

  const handleLabelClick = useCallback(() => {
    if (viewingSubAgentTabId) setViewingSubAgent(null);
  }, [viewingSubAgentTabId, setViewingSubAgent]);

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
        const alive = tab.claudeActive !== false; // undefined (pre-existing tabs) treated as alive
        const taskCount = tab.claudeTaskCount || 0;

        // Process alive indicator: ● filled = alive, ◌ hollow = dead
        const aliveColor = alive ? '#a6e3a1' : 'rgba(255,255,255,0.25)';

        // Status text after name (running state shown by pulsing ● only)
        let statusText = '';
        if (isError && alive) {
          statusText = 'error';
        } else if (taskCount > 0) {
          statusText = taskCount === 1 ? '1 task' : `${taskCount} tasks`;
        } else if (isDone && !alive) {
          statusText = 'done';
        }

        // Tooltip with full context
        const tooltipParts = [
          `Process: ${alive ? 'alive' : 'dead'}`,
          `Status: ${tab.claudeAgentStatus || 'idle'}`,
          taskCount > 0 ? `Tasks completed: ${taskCount}` : null,
          'Click to view, right-click for options',
        ].filter(Boolean);

        return (
          <button
            key={tab.id}
            onClick={() => handleChipClick(tab.id)}
            onAuxClick={(e) => handleChipMiddleClick(e, tab.id)}
            onContextMenu={(e) => handleContextMenu(e, tab)}
            className="flex items-center gap-1.5 px-2 py-0.5 rounded transition-colors"
            style={{
              backgroundColor: isViewing ? 'rgba(204, 120, 50, 0.3)' : 'rgba(255,255,255,0.06)',
              border: isViewing ? '1px solid rgba(204, 120, 50, 0.5)' : '1px solid transparent',
              color: isViewing ? '#cc7832' : 'rgba(255,255,255,0.7)',
              cursor: 'pointer',
              opacity: alive ? 1 : 0.6,
            }}
            title={tooltipParts.join('\n')}
          >
            {/* Process alive indicator: ● = alive, ◌ = dead */}
            <span
              style={{
                fontSize: '9px',
                lineHeight: 1,
                color: aliveColor,
                animation: isRunning ? 'tab-dot-pulse 1.5s ease-in-out infinite' : 'none',
              }}
            >
              {alive ? '\u25CF' : '\u25CC'}
            </span>
            <span>Claude #{i + 1}</span>
            {statusText && (
              <span style={{
                color: isError ? '#f38ba8' : isRunning ? '#DA7756' : 'rgba(255,255,255,0.4)',
                fontSize: '10px',
                fontStyle: isRunning ? 'italic' : 'normal',
              }}>
                {isError ? '\u2717 ' : ''}{statusText}
              </span>
            )}
          </button>
        );
      })}

    </div>
  );
}
