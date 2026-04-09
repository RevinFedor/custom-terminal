import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pin } from 'lucide-react';
import { draggable } from '@atlaskit/pragmatic-drag-and-drop/element/adapter';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';

const { ipcRenderer } = window.require('electron');

interface QueueItem {
  taskId: string;
  tabName: string;
  promptPreview: string;
}

// Draggable chip wrapper — allows dragging sub-agent chips back to TabBar to detach
function DraggableChip({ tabId, projectId, children, ...props }: {
  tabId: string;
  projectId: string;
  children: React.ReactNode;
} & React.HTMLAttributes<HTMLDivElement>) {
  const chipRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = chipRef.current;
    if (!el) return;
    return draggable({
      element: el,
      getInitialData: () => ({ type: 'TAB' as const, id: tabId, zone: 'main' as const, index: -1, projectId }),
    });
  }, [tabId, projectId]);

  return <div ref={chipRef} {...props}>{children}</div>;
}

interface SubAgentBarProps {
  projectId: string;
  adoptDragOver?: boolean;
}

export default function SubAgentBar({ projectId, adoptDragOver }: SubAgentBarProps) {
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
  const [showDropdown, setShowDropdown] = useState(false);
  const [pinned, setPinned] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

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
    setShowDropdown(false);
    setPinned(false);
  }, [activeTabId]);

  // Close dropdown on click outside (when pinned)
  useEffect(() => {
    if (!pinned) return;
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setPinned(false);
        setShowDropdown(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [pinned]);

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

  // ========== LISTEN FOR ADOPT STATUS UPDATES ==========
  useEffect(() => {
    const handler = (_: any, data: { claudeTabId: string; geminiTabId: string; status: string }) => {
      const state = useWorkspaceStore.getState();
      // Update tab status based on adoption phase
      if (data.status === 'summarizing') {
        state.setTabParent(data.claudeTabId, data.geminiTabId);
        state.setClaudeAgentStatus(data.claudeTabId, 'summarizing');
      } else if (data.status === 'ready') {
        state.setClaudeAgentStatus(data.claudeTabId, 'done');
      }
    };
    ipcRenderer.on('mcp:agent-adopted', handler);
    return () => { ipcRenderer.removeListener('mcp:agent-adopted', handler); };
  }, []);

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

  // Show bar if we have sub-agents, queued responses, or adopt drag is active
  if (!hasSubAgents && !hasQueue && !adoptDragOver) return null;

  // Active processes: sub-agents working with armed interceptor
  const activeProcesses = subAgentTabs.filter((t: any) =>
    t.claudeBusy === true && t.interceptorState === 'armed'
  );
  const hasActive = activeProcesses.length > 0;

  // Badge label
  const badgeParts: string[] = [];
  if (hasActive) badgeParts.push(activeProcesses.length === 1 ? '1 active' : `${activeProcesses.length} active`);
  if (hasQueue) badgeParts.push(queueItems.length === 1 ? '1 queued' : `${queueItems.length} queued`);
  const badgeLabel = badgeParts.length > 0 ? badgeParts.join(', ') : `${subAgentTabs.length} agent${subAgentTabs.length > 1 ? 's' : ''}`;

  return (
    <div
      className="flex items-center gap-1.5 px-2 border-b border-border-main"
      style={{
        height: '28px',
        backgroundColor: adoptDragOver ? 'rgba(99, 102, 241, 0.15)' : 'rgba(30, 30, 30, 0.95)',
        fontSize: '11px',
        borderColor: adoptDragOver ? 'rgba(99, 102, 241, 0.5)' : undefined,
        transition: 'background-color 0.15s, border-color 0.15s',
      }}
    >
      {/* Drop hint when dragging Claude tab */}
      {adoptDragOver && !hasSubAgents && (
        <span style={{ color: 'rgba(99, 102, 241, 0.8)', fontSize: '10px' }}>
          Drop to adopt as sub-agent
        </span>
      )}
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
            const isSummarizing = tab.claudeAgentStatus === 'summarizing';
            const alive = tab.claudeActive !== false; // undefined (pre-existing tabs) treated as alive
            const taskCount = tab.claudeTaskCount || 0;
            const isBusy = tab.claudeBusy === true;
            const interceptor = tab.interceptorState as 'armed' | 'disarmed' | null | undefined;

            // Indicator color: interceptor state shown via color, busy via spinner
            let dotColor: string;
            let dotSpinning = false;
            if (isSummarizing) {
              dotColor = '#6366f1'; // indigo spinner during API summarization
              dotSpinning = true;
            } else if (!alive) {
              dotColor = 'rgba(255,255,255,0.25)'; // gray = dead
            } else if (isBusy) {
              dotColor = '#a6e3a1'; // green spinner when busy
              dotSpinning = true;
            } else {
              dotColor = '#a6e3a1'; // green = idle, alive
            }

            // Status text after name (running state shown by pulsing ● only)
            let statusText = '';
            if (isSummarizing) {
              statusText = 'summarizing...';
            } else if (isError && alive) {
              statusText = 'error';
            } else if (taskCount > 0) {
              statusText = taskCount === 1 ? '1 task' : `${taskCount} tasks`;
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
              <DraggableChip
                key={tab.id}
                tabId={tab.id}
                projectId={projectId}
                onClick={() => handleChipClick(tab.id)}
                onAuxClick={(e: React.MouseEvent) => handleChipMiddleClick(e, tab.id)}
                onContextMenu={(e: React.MouseEvent) => handleContextMenu(e, tab)}
                className="flex items-center gap-1.5 px-2 py-0.5 rounded transition-colors shrink-0"
                style={{
                  backgroundColor: isViewing ? 'rgba(204, 120, 50, 0.3)' : 'rgba(255,255,255,0.06)',
                  border: isViewing ? '1px solid rgba(204, 120, 50, 0.5)' : '1px solid transparent',
                  color: isViewing ? '#cc7832' : 'rgba(255,255,255,0.7)',
                  cursor: 'grab',
                  opacity: alive ? 1 : 0.6,
                }}
                title={tooltipParts.join('\n')}
              >
                {/* Process indicator: blinking when busy/summarizing, dot when idle */}
                {dotSpinning ? (
                  <span
                    className={isSummarizing ? 'animate-glow-indigo' : 'animate-glow-green'}
                    style={{
                      display: 'inline-block',
                      width: '8px',
                      height: '8px',
                      borderRadius: '50%',
                      backgroundColor: dotColor,
                      verticalAlign: 'middle',
                      boxShadow: `0 0 8px ${dotColor}80`
                    }}
                  />
                ) : (
                  <span
                    style={{
                      fontSize: '9px',
                      lineHeight: 1,
                      color: dotColor,
                    }}
                  >
                    {alive ? '\u25CF' : '\u25CC'}
                  </span>
                )}
                <span>{tab.name || ('Claude #' + (i + 1))}</span>
                {statusText && (
                  <span style={{
                    color: isSummarizing ? '#818cf8' : isError ? '#f87171' : isRunning ? '#cc7832' : 'rgba(255,255,255,0.6)',
                    fontSize: '9px',
                    fontWeight: (isRunning || isSummarizing || isError) ? 'bold' : 'normal',
                    letterSpacing: '0.02em',
                  }}>
                    {isError ? '\u2717 ' : ''}{statusText.toUpperCase()}
                  </span>
                )}
              </DraggableChip>
            );
          })}
          </div>
        </>
      )}

      {/* Spacer pushes status indicator to the right */}
      <div className="flex-1" />

      {/* Right side: Status badge (always visible when sub-agents exist) */}
      {hasSubAgents && (
        <div
          ref={dropdownRef}
          className="relative flex items-center gap-1.5 shrink-0"
          onMouseEnter={() => { if (!pinned) setShowDropdown(true); }}
          onMouseLeave={() => { if (!pinned) setShowDropdown(false); }}
        >
          {/* Status badge — click to pin/unpin dropdown */}
          <div
            onClick={() => { setPinned(!pinned); setShowDropdown(true); }}
            className="flex items-center gap-1 px-2 py-0.5 rounded"
            style={{
              backgroundColor: (hasActive || hasQueue) ? 'rgba(180, 130, 255, 0.15)' : 'rgba(255,255,255,0.04)',
              border: pinned ? '1px solid rgba(180, 130, 255, 0.5)' : (hasActive || hasQueue) ? '1px solid rgba(180, 130, 255, 0.3)' : '1px solid rgba(255,255,255,0.08)',
              color: (hasActive || hasQueue) ? 'rgba(180, 130, 255, 0.9)' : 'rgba(255,255,255,0.4)',
              fontSize: '10px',
              cursor: 'pointer',
            }}
          >
            {(hasActive || hasQueue) && (
              <span
                style={{
                  display: 'inline-block',
                  width: '8px',
                  height: '8px',
                  borderRadius: '50%',
                  border: '1.5px solid rgba(180, 130, 255, 0.2)',
                  borderTopColor: 'rgba(180, 130, 255, 0.9)',
                  boxSizing: 'border-box',
                  animation: 'tab-dot-spin 0.8s linear infinite',
                  verticalAlign: 'middle',
                }}
              />
            )}
            <span>{badgeLabel}</span>
            {/* Pin icon — reserved space always, visible on hover/pinned */}
            <Pin
              size={10}
              style={{
                width: '12px',
                flexShrink: 0,
                opacity: pinned || showDropdown ? 1 : 0,
                color: pinned ? 'rgba(180, 130, 255, 0.9)' : 'rgba(255,255,255,0.3)',
                transition: 'opacity 0.15s',
                transform: pinned ? 'rotate(0deg)' : 'rotate(45deg)',
              }}
            />
          </div>

          {/* Send now button (only when queue has items) */}
          {hasQueue && (
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
          )}

          {/* Dropdown */}
          {showDropdown && (
            <div
              style={{
                position: 'absolute',
                top: '100%',
                right: 0,
                paddingTop: '6px', // invisible bridge
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
              {/* Header */}
              <div style={{ fontSize: '10px', color: 'rgba(255,255,255,0.4)', marginBottom: '6px' }}>
                {hasActive ? 'Working' : hasQueue ? 'Queued' : 'Agents'}
              </div>

              {/* Active processes section */}
              {hasActive && activeProcesses.map((tab: any, i: number) => (
                <div
                  key={tab.id}
                  onClick={() => handleChipClick(tab.id)}
                  style={{
                    fontSize: '10px',
                    color: 'rgba(255,255,255,0.7)',
                    padding: '4px 6px',
                    borderTop: i > 0 ? '1px solid rgba(255,255,255,0.06)' : 'none',
                    cursor: 'pointer',
                    borderRadius: '3px',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px',
                  }}
                  onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.backgroundColor = 'rgba(255,255,255,0.06)'; }}
                  onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.backgroundColor = 'transparent'; }}
                >
                  <span
                    className="w-1.5 h-1.5 rounded-full bg-purple-500 animate-glow-purple"
                    style={{
                      display: 'inline-block',
                      boxShadow: '0 0 6px #a855f780',
                    }}
                  />
                  <span style={{ color: '#b4a0ff', fontWeight: 'bold' }}>{tab.name || 'claude-sub'}</span>
                  <span style={{ color: 'rgba(255,255,255,0.5)', fontStyle: 'italic', letterSpacing: '0.02em' }}>AWAITING RESPONSE...</span>
                </div>
              ))}

              {/* Queue section */}
              {hasQueue && (
                <>
                  {hasActive && (
                    <div style={{
                      fontSize: '10px',
                      color: 'rgba(255,255,255,0.4)',
                      marginBottom: '4px',
                      marginTop: '8px',
                      paddingTop: '6px',
                      borderTop: '1px solid rgba(255,255,255,0.08)',
                    }}>
                      Queued — waiting for input to clear
                    </div>
                  )}
                  {queueItems.map((item, i) => (
                    <div
                      key={item.taskId + '-' + i}
                      style={{
                        fontSize: '10px',
                        color: 'rgba(255,255,255,0.7)',
                        padding: '3px 0',
                        borderTop: (i > 0 || hasActive) ? '1px solid rgba(255,255,255,0.06)' : 'none',
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
                </>
              )}

              {/* Idle agents list (when nothing active/queued) */}
              {!hasActive && !hasQueue && subAgentTabs.map((tab: any, i: number) => {
                const alive = tab.claudeActive !== false;
                const taskCount = tab.claudeTaskCount || 0;
                return (
                  <div
                    key={tab.id}
                    onClick={() => handleChipClick(tab.id)}
                    style={{
                      fontSize: '10px',
                      color: 'rgba(255,255,255,0.7)',
                      padding: '4px 6px',
                      borderTop: i > 0 ? '1px solid rgba(255,255,255,0.06)' : 'none',
                      cursor: 'pointer',
                      borderRadius: '3px',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '6px',
                    }}
                    onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.backgroundColor = 'rgba(255,255,255,0.06)'; }}
                    onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.backgroundColor = 'transparent'; }}
                  >
                    <span style={{
                      fontSize: '9px',
                      color: alive ? '#a6e3a1' : 'rgba(255,255,255,0.25)',
                    }}>{alive ? '\u25CF' : '\u25CC'}</span>
                    <span>{tab.name || 'claude-sub'}</span>
                    {taskCount > 0 && (
                      <span style={{ color: 'rgba(255,255,255,0.35)' }}>
                        {taskCount} task{taskCount > 1 ? 's' : ''}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
            </div>
          )}
        </div>
      )}

    </div>
  );
}
