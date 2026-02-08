import React, { useState, useEffect } from 'react';
import { useWorkspaceStore, TabColor, TabType, PendingAction } from '../../store/useWorkspaceStore';
import { useProjectsStore } from '../../store/useProjectsStore';
import { useUIStore } from '../../store/useUIStore';
import { useCmdKey, useCmdHoverPopover, CmdHoverPopover } from '../../hooks/useCmdHoverPopover';
import { Terminal, FolderOpen, Plus, Clock, Trash2 } from 'lucide-react';
import { MarkdownEditor } from '@anthropic/markdown-editor';

const { ipcRenderer } = window.require('electron');

interface ProjectHomeProps {
  projectId: string;
}

interface TabHistoryEntry {
  id: number;
  project_id: string;
  name: string;
  cwd: string;
  color: string | null;
  notes: string | null;
  command_type: string | null;
  tab_type: string;
  url: string | null;
  created_at: number;
  closed_at: number;
  claude_session_id: string | null;
  gemini_session_id: string | null;
  message_count: number | null;
}

type TimeGroup = 'Today' | 'Yesterday' | 'This Week' | 'This Month' | 'Older';

const TIME_GROUP_ORDER: TimeGroup[] = ['Today', 'Yesterday', 'This Week', 'This Month', 'Older'];

function getTimeGroup(timestamp: number): TimeGroup {
  const now = new Date();
  const date = new Date(timestamp * 1000);

  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterdayStart = new Date(todayStart.getTime() - 86400000);
  const weekStart = new Date(todayStart.getTime() - todayStart.getDay() * 86400000);
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

  if (date >= todayStart) return 'Today';
  if (date >= yesterdayStart) return 'Yesterday';
  if (date >= weekStart) return 'This Week';
  if (date >= monthStart) return 'This Month';
  return 'Older';
}

function groupByTime(entries: TabHistoryEntry[]): Map<TimeGroup, TabHistoryEntry[]> {
  const groups = new Map<TimeGroup, TabHistoryEntry[]>();
  for (const entry of entries) {
    const group = getTimeGroup(entry.closed_at);
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group)!.push(entry);
  }
  // Return in order, skipping empty groups
  const ordered = new Map<TimeGroup, TabHistoryEntry[]>();
  for (const key of TIME_GROUP_ORDER) {
    if (groups.has(key)) ordered.set(key, groups.get(key)!);
  }
  return ordered;
}

function formatTimestamp(unix: number): string {
  const date = new Date(unix * 1000);
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }) + ', ' + date.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

// Color configs matching TabBar
const TAB_COLORS: Record<TabColor, { bgColor: string; borderColor: string }> = {
  default: { bgColor: 'rgba(255,255,255,0.05)', borderColor: '#666' },
  red: { bgColor: 'rgba(239, 68, 68, 0.2)', borderColor: 'rgb(239, 68, 68)' },
  yellow: { bgColor: 'rgba(234, 179, 8, 0.2)', borderColor: 'rgb(234, 179, 8)' },
  green: { bgColor: 'rgba(34, 197, 94, 0.2)', borderColor: 'rgb(34, 197, 94)' },
  blue: { bgColor: 'rgba(59, 130, 246, 0.2)', borderColor: 'rgb(59, 130, 246)' },
  purple: { bgColor: 'rgba(168, 85, 247, 0.2)', borderColor: 'rgb(168, 85, 247)' },
  claude: { bgColor: 'rgba(218, 119, 86, 0.2)', borderColor: '#DA7756' },
  gemini: { bgColor: 'rgba(78, 134, 248, 0.2)', borderColor: '#4E86F8' },
};

export default function ProjectHome({ projectId }: ProjectHomeProps) {
  const { openProjects, switchTab, createTab } = useWorkspaceStore();
  const { projects, updateProject } = useProjectsStore();
  const { setCurrentView } = useUIStore();
  const tabNotesFontSize = useUIStore((s) => s.tabNotesFontSize);
  const tabNotesPaddingX = useUIStore((s) => s.tabNotesPaddingX);
  const tabNotesPaddingY = useUIStore((s) => s.tabNotesPaddingY);
  const [syncName, setSyncName] = useState<string | null>(null);
  const [history, setHistory] = useState<TabHistoryEntry[]>([]);

  // CMD+hover popovers (unified hooks)
  const isCmdPressed = useCmdKey();
  const activePopover = useCmdHoverPopover<string>(isCmdPressed);
  const historyPopover = useCmdHoverPopover<number>(isCmdPressed);

  useEffect(() => {
    const handleSync = (e: any) => {
      if (e.detail.projectId === projectId) {
        setSyncName(e.detail.name);
      }
    };
    window.addEventListener('project:name-sync', handleSync);
    return () => window.removeEventListener('project:name-sync', handleSync);
  }, [projectId]);

  const workspace = openProjects.get(projectId);
  const project = projects[projectId];
  const tabs = workspace ? Array.from(workspace.tabs.values()) : [];

  // Restore a closed tab from history
  const restoreTab = async (entry: TabHistoryEntry) => {
    console.log('[RESTORE] 1. restoreTab clicked:', {
      name: entry.name,
      cwd: entry.cwd,
      command_type: entry.command_type,
      color: entry.color,
      tab_type: entry.tab_type,
      claude_session_id: entry.claude_session_id,
      gemini_session_id: entry.gemini_session_id,
    });

    // Build pendingAction: resume old session if ID exists, otherwise start new
    let pendingAction: PendingAction | undefined;
    if (entry.command_type === 'claude') {
      if (entry.claude_session_id) {
        pendingAction = { type: 'claude-continue', sessionId: entry.claude_session_id };
      } else {
        pendingAction = { type: 'claude-new' };
      }
    } else if (entry.command_type === 'gemini') {
      if (entry.gemini_session_id) {
        pendingAction = { type: 'gemini-continue', sessionId: entry.gemini_session_id };
      } else {
        pendingAction = { type: 'gemini-new' };
      }
    }

    console.log('[RESTORE] 2. pendingAction built:', pendingAction);

    setCurrentView('terminal');
    console.log('[RESTORE] 3. setCurrentView("terminal") done, calling createTab...');
    const tabId = await createTab(projectId, entry.name, entry.cwd, {
      color: (entry.color || undefined) as TabColor | undefined,
      notes: entry.notes || undefined,
      commandType: entry.command_type as any || undefined,
      tabType: (entry.tab_type || 'terminal') as TabType,
      url: entry.url || undefined,
      pendingAction,
      claudeSessionId: entry.claude_session_id || undefined,
      geminiSessionId: entry.gemini_session_id || undefined,
    });
    console.log('[RESTORE] 4. createTab returned tabId:', tabId);

    // Remove from history after successful restore
    await ipcRenderer.invoke('project:delete-tab-history-entry', { id: entry.id });
    setHistory(prev => prev.filter(h => h.id !== entry.id));
    console.log('[RESTORE] 4a. History entry deleted, id:', entry.id);
  };

  // Fetch history when projectId changes or tabs count changes (tab closed -> refetch)
  useEffect(() => {
    if (!projectId) return;
    ipcRenderer.invoke('project:get-tab-history', { projectId }).then((data: TabHistoryEntry[]) => {
      setHistory(data || []);
    });
  }, [projectId, tabs.length]);

  const displayName = syncName || project?.name || '';

  const handleCreateTab = async () => {
    if (project) {
      await createTab(projectId, undefined, project.path);
      setCurrentView('terminal');
    }
  };

  const handleClearHistory = async () => {
    await ipcRenderer.invoke('project:clear-tab-history', { projectId });
    setHistory([]);
  };

  if (!workspace || !project) {
    return (
      <div className="flex-1 flex items-center justify-center text-[#666]">
        Project not found
      </div>
    );
  }

  const handleTabClick = (tabId: string) => {
    switchTab(projectId, tabId);
    setCurrentView('terminal');
  };

  const getFolderName = (path: string) => {
    const parts = path.split('/');
    return parts[parts.length - 1] || path;
  };

  const groupedHistory = groupByTime(history);

  return (
    <div className="flex-1 bg-bg-main p-6 overflow-y-auto overflow-x-hidden">
      {/* Project Header */}
      <div className="mb-6">
        <h1 className="text-xl text-white font-medium mb-1">{displayName}</h1>
        <div className="flex items-center gap-2 text-[#666] text-sm">
          <FolderOpen size={14} />
          <span>{project.path}</span>
        </div>
      </div>

      {/* Active Tabs Grid */}
      <div className="mb-4">
        <h2 className="text-sm text-[#888] mb-3">Active Tabs ({tabs.length})</h2>
        <div className="flex flex-wrap gap-3 w-full">
          {tabs.map((tab) => {
            const colorConfig = TAB_COLORS[tab.color || 'default'];
            const isActive = workspace.activeTabId === tab.id;

            return (
              <div
                key={tab.id}
                {...activePopover.triggerProps(tab.id)}
              >
                <button
                  onClick={() => handleTabClick(tab.id)}
                  className="group cursor-pointer transition-all duration-150"
                  style={{
                    position: 'relative',
                    maxWidth: '150px',
                    maxHeight: '50px',
                    minWidth: '100px',
                    padding: '8px 12px',
                    backgroundColor: colorConfig.bgColor,
                    border: `1px solid ${isActive ? colorConfig.borderColor : 'transparent'}`,
                    borderRadius: '6px',
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'flex-start',
                    gap: '2px',
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.borderColor = colorConfig.borderColor;
                  }}
                  onMouseLeave={(e) => {
                    if (!isActive) {
                      e.currentTarget.style.borderColor = 'transparent';
                    }
                  }}
                >
                  {isCmdPressed && tab.notes && (
                    <span
                      style={{
                        position: 'absolute',
                        top: '4px',
                        right: '4px',
                        width: '5px',
                        height: '5px',
                        borderRadius: '50%',
                        backgroundColor: '#DA7756',
                        zIndex: 10,
                      }}
                    />
                  )}
                  <div className="flex items-center gap-2 w-full">
                    <Terminal size={12} className="text-[#888] flex-shrink-0" />
                    <span
                      className="text-sm text-white truncate"
                      style={{ maxWidth: '110px' }}
                    >
                      {tab.name}
                    </span>
                  </div>
                  <span
                    className="text-[10px] text-[#666] truncate w-full"
                  >
                    {getFolderName(tab.cwd)}
                  </span>
                </button>
              </div>
            );
          })}

          {/* New Tab Button */}
          <button
            onClick={handleCreateTab}
            className="cursor-pointer transition-all duration-150 hover:border-[#666]"
            style={{
              maxWidth: '150px',
              maxHeight: '50px',
              minWidth: '100px',
              padding: '8px 12px',
              backgroundColor: 'transparent',
              border: '1px dashed #444',
              borderRadius: '6px',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '4px',
            }}
          >
            <Plus size={16} className="text-[#666]" />
            <span className="text-[11px] text-[#666]">New Tab</span>
          </button>
        </div>
      </div>

      {/* History Section */}
      {history.length > 0 && (
        <div className="mt-6">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <Clock size={14} className="text-[#888]" />
              <h2 className="text-sm text-[#888]">History ({history.length})</h2>
            </div>
            <button
              onClick={handleClearHistory}
              className="flex items-center gap-1 text-[11px] text-[#666] hover:text-[#999] cursor-pointer transition-colors"
            >
              <Trash2 size={12} />
              Clear
            </button>
          </div>

          {Array.from(groupedHistory.entries()).map(([group, entries]) => (
            <div key={group} className="mb-4">
              <div className="text-[10px] text-[#555] uppercase tracking-wider mb-2">{group}</div>
              <div className="flex flex-wrap gap-2">
                {entries.map((entry) => {
                  const color = (entry.color || 'default') as TabColor;
                  const colorConfig = TAB_COLORS[color];

                  return (
                    <div
                      key={entry.id}
                      className="relative"
                      {...historyPopover.triggerProps(entry.id)}
                    >
                      <div
                        className="transition-all duration-150 cursor-pointer hover:opacity-70"
                        onClick={() => restoreTab(entry)}
                        style={{
                          maxWidth: '140px',
                          minWidth: '90px',
                          padding: '6px 10px',
                          backgroundColor: colorConfig.bgColor,
                          borderRadius: '5px',
                          borderLeft: `2px solid ${colorConfig.borderColor}`,
                          opacity: 0.5,
                          display: 'flex',
                          flexDirection: 'column',
                          gap: '1px',
                        }}
                      >
                        <span
                          className="text-[12px] text-white truncate"
                          style={{ maxWidth: '120px' }}
                        >
                          {entry.name}
                        </span>
                        <span className="text-[9px] text-[#666] truncate">
                          {getFolderName(entry.cwd)}
                        </span>
                      </div>

                      {/* CMD indicator: notes exist */}
                      {isCmdPressed && entry.notes && (
                        <span
                          style={{
                            position: 'absolute',
                            top: '6px',
                            right: '6px',
                            width: '5px',
                            height: '5px',
                            borderRadius: '50%',
                            backgroundColor: '#DA7756',
                            zIndex: 10,
                          }}
                        />
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* CMD+Hover Active Tab Popover — unified hook + CmdHoverPopover */}
      {activePopover.isVisible && activePopover.hoveredItem && (() => {
        const tab = tabs.find(t => t.id === activePopover.hoveredItem!.id);
        if (!tab) return null;
        const pos = getPopoverPosition(activePopover.hoveredItem!.rect);
        return (
          <CmdHoverPopover
            rect={activePopover.hoveredItem!.rect}
            popoverProps={activePopover.popoverProps}
            smartPosition
            maxHeight={350}
          >
            {tab.notes && (
              <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', borderBottom: '1px solid #333' }}>
                <MarkdownEditor
                  content={tab.notes}
                  onChange={() => {}}
                  readOnly
                  compact
                  showLineNumbers={false}
                  fontSize={tabNotesFontSize}
                  contentPaddingX={tabNotesPaddingX}
                  contentPaddingY={tabNotesPaddingY}
                  wordWrap
                />
              </div>
            )}
            <div style={{ padding: '6px 10px', flexShrink: 0 }}>
              <div className="text-[10px] text-[#888] space-y-0.5">
                <div className="truncate">Path: {tab.cwd}</div>
                {tab.commandType && <div>Type: {tab.commandType}</div>}
              </div>
            </div>
          </CmdHoverPopover>
        );
      })()}

      {/* CMD+Hover History Popover — unified hook + CmdHoverPopover */}
      {historyPopover.isVisible && historyPopover.hoveredItem && (() => {
        const entry = history.find(h => h.id === historyPopover.hoveredItem!.id);
        if (!entry) return null;
        return (
          <CmdHoverPopover
            rect={historyPopover.hoveredItem!.rect}
            popoverProps={historyPopover.popoverProps}
            smartPosition
            maxHeight={350}
          >
            {entry.notes && (
              <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', borderBottom: '1px solid #333' }}>
                <MarkdownEditor
                  content={entry.notes}
                  onChange={() => {}}
                  readOnly
                  compact
                  showLineNumbers={false}
                  fontSize={tabNotesFontSize}
                  contentPaddingX={tabNotesPaddingX}
                  contentPaddingY={tabNotesPaddingY}
                  wordWrap
                />
              </div>
            )}
            <div style={{ padding: '6px 10px', flexShrink: 0 }}>
              <div className="text-[10px] text-[#888] space-y-0.5">
                <div>Created: {formatTimestamp(entry.created_at)}</div>
                <div>Closed: {formatTimestamp(entry.closed_at)}</div>
                <div className="truncate" title={entry.cwd}>Path: {entry.cwd}</div>
                {entry.command_type && (
                  <div>Type: {entry.command_type}</div>
                )}
                {entry.message_count != null && (
                  <div className="text-[#ccc]">Messages: {entry.message_count}</div>
                )}
              </div>
              <div
                className="mt-2 pt-2 border-t border-[#333] text-[10px] text-[#DA7756] cursor-pointer hover:text-[#e89070]"
                onClick={(e) => {
                  e.stopPropagation();
                  historyPopover.close();
                  restoreTab(entry);
                }}
              >
                Восстановить вкладку
              </div>
            </div>
          </CmdHoverPopover>
        );
      })()}
    </div>
  );
}
