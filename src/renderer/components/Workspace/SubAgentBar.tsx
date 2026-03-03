import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';

const { ipcRenderer } = window.require('electron');

interface QueueItem {
  taskId: string;
  tabName: string;
  promptPreview: string;
}

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

  // ========== RESPONSE QUEUE STATE ==========
  const [queueItems, setQueueItems] = useState<QueueItem[]>([]);
  const [showQueueTooltip, setShowQueueTooltip] = useState(false);

  // Listen for queue updates from main process
  useEffect(() => {
    const handler = (_: any, data: { tabId: string; queue: QueueItem[] }) => {
      if (data.tabId === activeTabId) {
        setQueueItems(data.queue);
      }
    };
    ipcRenderer.on('gemini:queue-update', handler);

    // Initial load
    if (activeTabId) {
      ipcRenderer.invoke('gemini:get-queue', activeTabId).then((result: any) => {
        if (result?.queue) setQueueItems(result.queue);
      });
    }

    return () => { ipcRenderer.removeListener('gemini:queue-update', handler); };
  }, [activeTabId]);

  // Reset queue when tab changes
  useEffect(() => {
    setQueueItems([]);
    setShowQueueTooltip(false);
  }, [activeTabId]);

  // Stable string key: re-derive sub-agents only when tab IDs, statuses, claudeActive, busy, taskCount, or interceptor change
  // Search CROSS-PROJECT: sub-agents may have been created in a different project (activeProjectId bug)
  const subAgentKey = useWorkspaceStore((s) => {
    if (!activeTabId) return '';
    const parts: string[] = [];
    for (const [, workspace] of s.openProjects) {
      for (const [, tab] of workspace.tabs) {
        if (tab.parentTabId === activeTabId) {
          parts.push(tab.id + ':' + (tab.claudeAgentStatus || '') + ':' + (tab.claudeActive ? '1' : '0') + ':' + (tab.claudeBusy ? '1' : '0') + ':' + (tab.claudeTaskCount || 0) + ':' + (tab.interceptorState || ''));
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

  // Listen for context menu commands from native menu
  useEffect(() => {
    const handler = (_: any, data: { action: string; claudeTabId: string }) => {
      if (data.action === 'detach') {
        const state = useWorkspaceStore.getState();
        state.setTabParent(data.claudeTabId, undefined as any);
        setViewingSubAgent(null);
      } else if (data.action === 'deliver-last-response') {
        ipcRenderer.invoke('mcp:deliver-last-response', data.claudeTabId);
      }
    };
    ipcRenderer.on('sub-agent-context-menu-command', handler);
    return () => { ipcRenderer.removeListener('sub-agent-context-menu-command', handler); };
  }, [setViewingSubAgent]);

  const handleLabelClick = useCallback(() => {
    if (viewingSubAgentTabId) setViewingSubAgent(null);
  }, [viewingSubAgentTabId, setViewingSubAgent]);

  // Force-flush: deliver next queued response immediately
  const handleForceFlush = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    if (!activeTabId) return;
    ipcRenderer.invoke('gemini:force-flush-queue', activeTabId);
  }, [activeTabId]);

  // Early return AFTER all hooks
  if (activeCommandType !== 'gemini') return null;

  const hasSubAgents = subAgentTabs.length > 0;
  const hasQueue = queueItems.length > 0;

  // Show bar if we have sub-agents OR queued responses
  if (!hasSubAgents && !hasQueue) return null;

  return (
    <div
      className="flex items-center gap-1.5 px-2 border-b border-border-main"
      style={{
        height: '28px',
        backgroundColor: 'rgba(30, 30, 30, 0.95)',
        fontSize: '11px',
      }}
    >
      {/* Left side: Sub-agents label and chips */}
      {hasSubAgents && (
        <>
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

          {/* Scrollable chips container */}
          <div className="flex items-center gap-1.5 min-w-0 overflow-x-auto scrollbar-hide">
          {subAgentTabs.map((tab: any, i: number) => {
            const isViewing = viewingSubAgentTabId === tab.id;
            const isRunning = tab.claudeAgentStatus === 'running';
            const isDone = tab.claudeAgentStatus === 'done';
            const isError = tab.claudeAgentStatus === 'error';
            const alive = tab.claudeActive !== false; // undefined (pre-existing tabs) treated as alive
            const taskCount = tab.claudeTaskCount || 0;
            const isBusy = tab.claudeBusy === true;
            const interceptor = tab.interceptorState as 'armed' | 'disarmed' | null | undefined;

            // Indicator color: interceptor state takes priority when busy
            let dotColor: string;
            let dotPulsing = false;
            if (!alive) {
              dotColor = 'rgba(255,255,255,0.25)'; // gray = dead
            } else if (isBusy && interceptor === 'armed') {
              dotColor = '#b4a0ff'; // purple = armed + busy
              dotPulsing = true;
            } else if (isBusy && interceptor === 'disarmed') {
              dotColor = '#f38ba8'; // red = disarmed + busy
              dotPulsing = true;
            } else if (isBusy) {
              dotColor = '#DA7756'; // orange = busy (no interceptor state — legacy)
              dotPulsing = true;
            } else {
              dotColor = '#a6e3a1'; // green = idle, alive
            }

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
            const interceptorLabel = interceptor === 'armed' ? 'Interceptor: ON (will deliver)' :
              interceptor === 'disarmed' ? 'Interceptor: OFF (won\'t deliver)' : null;
            const tooltipParts = [
              `Process: ${alive ? 'alive' : 'dead'}`,
              `Status: ${tab.claudeAgentStatus || 'idle'}`,
              interceptorLabel,
              taskCount > 0 ? `Tasks completed: ${taskCount}` : null,
              'Click to view, right-click for options',
            ].filter(Boolean);

            return (
              <button
                key={tab.id}
                onClick={() => handleChipClick(tab.id)}
                onAuxClick={(e) => handleChipMiddleClick(e, tab.id)}
                onContextMenu={(e) => handleContextMenu(e, tab)}
                className="flex items-center gap-1.5 px-2 py-0.5 rounded transition-colors shrink-0"
                style={{
                  backgroundColor: isViewing ? 'rgba(204, 120, 50, 0.3)' : 'rgba(255,255,255,0.06)',
                  border: isViewing ? '1px solid rgba(204, 120, 50, 0.5)' : '1px solid transparent',
                  color: isViewing ? '#cc7832' : 'rgba(255,255,255,0.7)',
                  cursor: 'pointer',
                  opacity: alive ? 1 : 0.6,
                }}
                title={tooltipParts.join('\n')}
              >
                {/* Process indicator: color depends on interceptor + busy state */}
                <span
                  style={{
                    fontSize: '9px',
                    lineHeight: 1,
                    color: dotColor,
                    animation: dotPulsing ? 'tab-dot-pulse 1.5s ease-in-out infinite' : 'none',
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
        </>
      )}

      {/* Spacer pushes queue indicator to the right */}
      <div className="flex-1" />

      {/* Right side: Queue indicator with force-send */}
      {hasQueue && (
        <div
          className="relative flex items-center gap-1.5 shrink-0"
          onMouseEnter={() => setShowQueueTooltip(true)}
          onMouseLeave={() => setShowQueueTooltip(false)}
        >
          {/* Queue badge */}
          <div
            className="flex items-center gap-1 px-2 py-0.5 rounded"
            style={{
              backgroundColor: 'rgba(180, 130, 255, 0.15)',
              border: '1px solid rgba(180, 130, 255, 0.3)',
              color: 'rgba(180, 130, 255, 0.9)',
              fontSize: '10px',
            }}
          >
            <span style={{
              fontSize: '9px',
              animation: 'tab-dot-pulse 2s ease-in-out infinite',
            }}>
              {'\u25CF'}
            </span>
            <span>
              {queueItems.length === 1
                ? '1 queued'
                : `${queueItems.length} queued`
              }
            </span>
          </div>

          {/* Send now button */}
          <button
            onClick={handleForceFlush}
            className="flex items-center gap-1 px-2 py-0.5 rounded transition-colors"
            style={{
              backgroundColor: 'rgba(166, 227, 161, 0.15)',
              border: '1px solid rgba(166, 227, 161, 0.3)',
              color: 'rgba(166, 227, 161, 0.9)',
              fontSize: '10px',
              cursor: 'pointer',
            }}
            title="Force deliver next response (clears input)"
          >
            Send now
          </button>

          {/* Tooltip with queue details */}
          {showQueueTooltip && (
            <div
              style={{
                position: 'absolute',
                top: '100%',
                right: 0,
                paddingTop: '6px', // invisible bridge — keeps hover alive between badge and tooltip
                zIndex: 200,
              }}
            >
            <div
              style={{
                backgroundColor: 'rgba(30, 30, 30, 0.98)',
                border: '1px solid rgba(255, 255, 255, 0.15)',
                borderRadius: '6px',
                padding: '8px 10px',
                minWidth: '220px',
                maxWidth: '400px',
                boxShadow: '0 4px 12px rgba(0, 0, 0, 0.4)',
              }}
            >
              <div style={{
                fontSize: '10px',
                color: 'rgba(255,255,255,0.4)',
                marginBottom: '6px',
              }}>
                Waiting for input to clear
              </div>
              {queueItems.map((item, i) => (
                <div
                  key={item.taskId + '-' + i}
                  style={{
                    fontSize: '10px',
                    color: 'rgba(255,255,255,0.7)',
                    padding: '3px 0',
                    borderTop: i > 0 ? '1px solid rgba(255,255,255,0.06)' : 'none',
                  }}
                >
                  <span style={{ color: 'rgba(180, 130, 255, 0.7)' }}>
                    {item.tabName}:
                  </span>{' '}
                  <span style={{ color: 'rgba(255,255,255,0.5)' }}>
                    {item.promptPreview.length > 80
                      ? item.promptPreview.substring(0, 80) + '...'
                      : item.promptPreview
                    }
                  </span>
                </div>
              ))}
            </div>
            </div>
          )}
        </div>
      )}

    </div>
  );
}
