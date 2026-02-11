import React, { useState, useEffect, useRef } from 'react';
import { useWorkspaceStore, TabColor, TabType, PendingAction } from '../../store/useWorkspaceStore';
import { useProjectsStore } from '../../store/useProjectsStore';
import { useUIStore } from '../../store/useUIStore';
import { useCmdKey, useCmdHoverPopover, CmdHoverPopover } from '../../hooks/useCmdHoverPopover';
import { Terminal, FolderOpen, Plus, Clock, Trash2, Pencil, Star, ChevronDown, ChevronRight } from 'lucide-react';
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

interface FavoriteEntry {
  id: number;
  project_id: string;
  name: string | null;
  cwd: string | null;
  color: string | null;
  notes: string | null;
  command_type: string | null;
  tab_type: string;
  url: string | null;
  claude_session_id: string | null;
  gemini_session_id: string | null;
  created_at: number;
}

type ContextMenuState = {
  x: number;
  y: number;
  type: 'active-tab' | 'favorite' | 'history';
  itemId: string | number;
} | null;

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
  const { openProjects, switchTab, createTab, closeTab, setProjectView } = useWorkspaceStore();
  const { projects, updateProject } = useProjectsStore();
  const { showToast } = useUIStore();
  const tabNotesFontSize = useUIStore((s) => s.tabNotesFontSize);
  const tabNotesPaddingX = useUIStore((s) => s.tabNotesPaddingX);
  const tabNotesPaddingY = useUIStore((s) => s.tabNotesPaddingY);
  const [syncName, setSyncName] = useState<string | null>(null);
  const [history, setHistory] = useState<TabHistoryEntry[]>([]);
  const [favorites, setFavorites] = useState<FavoriteEntry[]>([]);
  const [historyExpanded, setHistoryExpanded] = useState(false);
  const [homeContextMenu, setHomeContextMenu] = useState<ContextMenuState>(null);

  // CMD+hover popovers (unified hooks)
  const isCmdPressed = useCmdKey();
  const activePopover = useCmdHoverPopover<string>(isCmdPressed);
  const historyPopover = useCmdHoverPopover<number>(isCmdPressed);

  // Close context menu on mousedown outside
  const contextMenuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!homeContextMenu) return;
    const handleMouseDown = (e: MouseEvent) => {
      if (contextMenuRef.current && !contextMenuRef.current.contains(e.target as Node)) {
        setHomeContextMenu(null);
      }
    };
    document.addEventListener('mousedown', handleMouseDown);
    return () => document.removeEventListener('mousedown', handleMouseDown);
  }, [homeContextMenu]);

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

    setProjectView(projectId, 'terminal');
    await createTab(projectId, entry.name, entry.cwd, {
      color: (entry.color || undefined) as TabColor | undefined,
      notes: entry.notes || undefined,
      commandType: entry.command_type as any || undefined,
      tabType: (entry.tab_type || 'terminal') as TabType,
      url: entry.url || undefined,
      pendingAction,
      claudeSessionId: entry.claude_session_id || undefined,
      geminiSessionId: entry.gemini_session_id || undefined,
    });

    await ipcRenderer.invoke('project:delete-tab-history-entry', { id: entry.id });
    setHistory(prev => prev.filter(h => h.id !== entry.id));
  };

  // Restore from favorite (creates new tab, does NOT delete favorite)
  const restoreFromFavorite = async (entry: FavoriteEntry) => {
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

    setProjectView(projectId, 'terminal');
    await createTab(projectId, entry.name || 'tab', entry.cwd || project?.path || '/', {
      color: (entry.color || undefined) as TabColor | undefined,
      notes: entry.notes || undefined,
      commandType: entry.command_type as any || undefined,
      tabType: (entry.tab_type || 'terminal') as TabType,
      url: entry.url || undefined,
      pendingAction,
      claudeSessionId: entry.claude_session_id || undefined,
      geminiSessionId: entry.gemini_session_id || undefined,
    });
  };

  // Fetch history + favorites
  useEffect(() => {
    if (!projectId) return;
    ipcRenderer.invoke('project:get-tab-history', { projectId }).then((data: TabHistoryEntry[]) => {
      setHistory(data || []);
    });
    ipcRenderer.invoke('project:get-favorites', { projectId }).then((data: FavoriteEntry[]) => {
      setFavorites(data || []);
    });
  }, [projectId, tabs.length]);

  const displayName = syncName || project?.name || '';

  const handleCreateTab = async () => {
    if (project) {
      await createTab(projectId, undefined, project.path);
      setProjectView(projectId, 'terminal');
    }
  };

  const [showKeepNotes, setShowKeepNotes] = useState(false);

  const handleClearHistory = async () => {
    await ipcRenderer.invoke('project:clear-tab-history', { projectId });
    setHistory([]);
  };

  const handleClearExceptNotes = async () => {
    await ipcRenderer.invoke('project:clear-tab-history-except-notes', { projectId });
    const data = await ipcRenderer.invoke('project:get-tab-history', { projectId });
    setHistory(data || []);
  };

  const handleChangeDirectory = async () => {
    const selected = await ipcRenderer.invoke('app:select-directory');
    if (selected) {
      await updateProject(projectId, { path: selected });
    }
  };

  // Add active tab to favorites
  const addActiveTabToFavorites = async (tabId: string) => {
    const tab = workspace?.tabs.get(tabId);
    if (!tab) return;
    await ipcRenderer.invoke('project:add-favorite', {
      projectId,
      tab: {
        name: tab.name,
        cwd: tab.cwd,
        color: tab.color || null,
        notes: tab.notes || null,
        commandType: tab.commandType || null,
        tabType: tab.tabType || 'terminal',
        url: tab.url || null,
        claudeSessionId: tab.claudeSessionId || null,
        geminiSessionId: tab.geminiSessionId || null,
      }
    });
    showToast(`"${tab.name}" added to favorites`, 'success');
    // Refetch favorites
    const data = await ipcRenderer.invoke('project:get-favorites', { projectId });
    setFavorites(data || []);
  };

  // Add history entry to favorites
  const addHistoryToFavorites = async (entry: TabHistoryEntry) => {
    await ipcRenderer.invoke('project:add-favorite', {
      projectId,
      tab: {
        name: entry.name,
        cwd: entry.cwd,
        color: entry.color || null,
        notes: entry.notes || null,
        commandType: entry.command_type || null,
        tabType: entry.tab_type || 'terminal',
        url: entry.url || null,
        claudeSessionId: entry.claude_session_id || null,
        geminiSessionId: entry.gemini_session_id || null,
      }
    });
    showToast(`"${entry.name}" added to favorites`, 'success');
    const data = await ipcRenderer.invoke('project:get-favorites', { projectId });
    setFavorites(data || []);
  };

  // Delete favorite
  const deleteFavorite = async (id: number) => {
    await ipcRenderer.invoke('project:delete-favorite', { id });
    setFavorites(prev => prev.filter(f => f.id !== id));
  };

  // Delete history entry
  const deleteHistoryEntry = async (id: number) => {
    await ipcRenderer.invoke('project:delete-tab-history-entry', { id });
    setHistory(prev => prev.filter(h => h.id !== id));
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
    setProjectView(projectId, 'terminal');
  };

  const getFolderName = (pathStr: string) => {
    const parts = pathStr.split('/');
    return parts[parts.length - 1] || pathStr;
  };

  const groupedHistory = groupByTime(history);

  // Context menu handler for cards
  const handleCardContextMenu = (e: React.MouseEvent, type: ContextMenuState['type'], itemId: string | number) => {
    e.preventDefault();
    e.stopPropagation();
    setHomeContextMenu({ x: e.clientX, y: e.clientY, type: type!, itemId });
  };

  return (
    <div className="flex-1 bg-bg-main p-6 overflow-y-auto overflow-x-hidden" style={{ position: 'relative' }}>
      {/* Project Header */}
      <div className="mb-6">
        <h1 className="text-xl text-white font-medium mb-1">{displayName}</h1>
        <div className="flex items-center gap-2 text-[#666] text-sm">
          <FolderOpen size={14} />
          <span>{project.path}</span>
          <button
            onClick={handleChangeDirectory}
            className="text-[#666] hover:text-[#999] cursor-pointer transition-colors p-0.5"
            title="Change project directory"
          >
            <Pencil size={12} />
          </button>
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
                onContextMenu={(e) => handleCardContextMenu(e, 'active-tab', tab.id)}
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

      {/* Favorites Section */}
      {favorites.length > 0 && (
        <div className="mb-4 mt-4">
          <div className="flex items-center gap-2 mb-3">
            <Star size={14} className="text-[#b8860b]" />
            <h2 className="text-sm text-[#888]">Favorites ({favorites.length})</h2>
          </div>
          <div className="flex flex-wrap gap-2">
            {favorites.map((entry) => {
              const color = (entry.color || 'default') as TabColor;
              const colorConfig = TAB_COLORS[color];

              return (
                <div
                  key={entry.id}
                  className="transition-all duration-150 cursor-pointer"
                  onClick={() => restoreFromFavorite(entry)}
                  onAuxClick={(e) => {
                    if (e.button === 1) {
                      e.preventDefault();
                      deleteFavorite(entry.id);
                    }
                  }}
                  onContextMenu={(e) => handleCardContextMenu(e, 'favorite', entry.id)}
                  style={{
                    maxWidth: '140px',
                    minWidth: '90px',
                    padding: '6px 10px',
                    backgroundColor: colorConfig.bgColor,
                    borderRadius: '5px',
                    borderLeft: `2px solid ${colorConfig.borderColor}`,
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '1px',
                  }}
                  onMouseEnter={(e) => {
                    (e.currentTarget as HTMLDivElement).style.opacity = '0.7';
                  }}
                  onMouseLeave={(e) => {
                    (e.currentTarget as HTMLDivElement).style.opacity = '1';
                  }}
                >
                  <span
                    className="text-[12px] text-white truncate"
                    style={{ maxWidth: '120px' }}
                  >
                    {entry.name || 'tab'}
                  </span>
                  <span className="text-[9px] text-[#666] truncate">
                    {entry.cwd ? getFolderName(entry.cwd) : ''}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* History Section — collapsed by default */}
      {history.length > 0 && (
        <div className="mt-6" style={{ position: 'relative' }}>
          {/* History Header — always visible */}
          <div className="flex items-center justify-between mb-3">
            {/* Left: toggle (inline, only text clickable) */}
            <div
              className="flex items-center gap-2 cursor-pointer"
              style={{ display: 'inline-flex' }}
              onClick={() => {
                console.warn('[ProjectHome] toggle history, was:', historyExpanded);
                setHistoryExpanded(prev => !prev);
              }}
            >
              {historyExpanded ? (
                <ChevronDown size={14} className="text-[#888]" />
              ) : (
                <ChevronRight size={14} className="text-[#888]" />
              )}
              <Clock size={14} className="text-[#888]" />
              <h2 className="text-sm text-[#888]">History ({history.length})</h2>
            </div>
            {/* Right: Clear + Keep with notes */}
            <div
              className="flex items-center gap-2"
              onMouseEnter={() => {
                console.warn('[ProjectHome] Clear hover enter, hasNotes:', history.some(h => h.notes));
                setShowKeepNotes(true);
              }}
              onMouseLeave={() => {
                console.warn('[ProjectHome] Clear hover leave');
                setShowKeepNotes(false);
              }}
            >
              {showKeepNotes && history.some(h => h.notes) && (
                <button
                  onClick={handleClearExceptNotes}
                  className="flex items-center gap-1 text-[11px] text-[#DA7756] hover:text-[#e89070] cursor-pointer transition-all"
                >
                  Keep with notes
                </button>
              )}
              <button
                onClick={(e) => {
                  console.warn('[ProjectHome] Clear clicked');
                  handleClearHistory();
                }}
                className="flex items-center gap-1 text-[11px] text-[#666] hover:text-[#999] cursor-pointer transition-colors"
              >
                <Trash2 size={12} />
                Clear
              </button>
            </div>
          </div>

          {/* History Content — animated expand/collapse */}
          <div
            style={{
              maxHeight: historyExpanded ? '2000px' : '0',
              opacity: historyExpanded ? 1 : 0,
              overflow: 'hidden',
              transition: 'max-height 0.3s ease, opacity 0.2s ease',
            }}
          >
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
                        onContextMenu={(e) => handleCardContextMenu(e, 'history', entry.id)}
                      >
                        <div
                          className="transition-all duration-150 cursor-pointer hover:opacity-70"
                          onClick={() => restoreTab(entry)}
                          onAuxClick={(e) => {
                            if (e.button === 1) {
                              e.preventDefault();
                              deleteHistoryEntry(entry.id);
                            }
                          }}
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
        </div>
      )}

      {/* Context Menu (fixed, pattern from TabBar) */}
      {homeContextMenu && (
        <div
          ref={contextMenuRef}
          onClick={(e) => e.stopPropagation()}
          style={{
            position: 'fixed',
            left: homeContextMenu.x,
            top: homeContextMenu.y,
            zIndex: 9999,
          }}
        >
          <div
            className="bg-[#2a2a2a] border border-[#444] rounded-xl shadow-2xl py-1 min-w-[160px]"
            style={{ transform: 'translateY(-4px)' }}
          >
            {/* Active Tab Context Menu */}
            {homeContextMenu.type === 'active-tab' && (() => {
              const tabId = homeContextMenu.itemId as string;
              const tab = workspace.tabs.get(tabId);
              if (!tab) return null;
              return (
                <>
                  <button
                    className="w-full text-left px-4 py-1.5 text-[13px] text-[#ccc] hover:bg-white/10 cursor-pointer"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleTabClick(tabId);
                      setHomeContextMenu(null);
                    }}
                  >
                    Switch to Tab
                  </button>
                  <button
                    className="w-full text-left px-4 py-1.5 text-[13px] text-[#ccc] hover:bg-white/10 cursor-pointer"
                    onClick={(e) => {
                      e.stopPropagation();
                      addActiveTabToFavorites(tabId);
                      setHomeContextMenu(null);
                    }}
                  >
                    Add to Favorites
                  </button>
                  <div className="my-1 border-t border-[#444]" />
                  <button
                    className="w-full text-left px-4 py-1.5 text-[13px] text-[#f87171] hover:bg-white/10 cursor-pointer"
                    onClick={(e) => {
                      e.stopPropagation();
                      closeTab(projectId, tabId);
                      setHomeContextMenu(null);
                    }}
                  >
                    Close Tab
                  </button>
                </>
              );
            })()}

            {/* Favorite Context Menu */}
            {homeContextMenu.type === 'favorite' && (() => {
              const favId = homeContextMenu.itemId as number;
              const entry = favorites.find(f => f.id === favId);
              if (!entry) return null;
              return (
                <>
                  <button
                    className="w-full text-left px-4 py-1.5 text-[13px] text-[#ccc] hover:bg-white/10 cursor-pointer"
                    onClick={(e) => {
                      e.stopPropagation();
                      restoreFromFavorite(entry);
                      setHomeContextMenu(null);
                    }}
                  >
                    Open
                  </button>
                  <div className="my-1 border-t border-[#444]" />
                  <button
                    className="w-full text-left px-4 py-1.5 text-[13px] text-[#f87171] hover:bg-white/10 cursor-pointer"
                    onClick={(e) => {
                      e.stopPropagation();
                      deleteFavorite(favId);
                      setHomeContextMenu(null);
                    }}
                  >
                    Remove from Favorites
                  </button>
                </>
              );
            })()}

            {/* History Context Menu */}
            {homeContextMenu.type === 'history' && (() => {
              const histId = homeContextMenu.itemId as number;
              const entry = history.find(h => h.id === histId);
              if (!entry) return null;
              return (
                <>
                  <button
                    className="w-full text-left px-4 py-1.5 text-[13px] text-[#ccc] hover:bg-white/10 cursor-pointer"
                    onClick={(e) => {
                      e.stopPropagation();
                      restoreTab(entry);
                      setHomeContextMenu(null);
                    }}
                  >
                    Restore
                  </button>
                  <button
                    className="w-full text-left px-4 py-1.5 text-[13px] text-[#ccc] hover:bg-white/10 cursor-pointer"
                    onClick={(e) => {
                      e.stopPropagation();
                      addHistoryToFavorites(entry);
                      setHomeContextMenu(null);
                    }}
                  >
                    Add to Favorites
                  </button>
                  <div className="my-1 border-t border-[#444]" />
                  <button
                    className="w-full text-left px-4 py-1.5 text-[13px] text-[#f87171] hover:bg-white/10 cursor-pointer"
                    onClick={(e) => {
                      e.stopPropagation();
                      deleteHistoryEntry(histId);
                      setHomeContextMenu(null);
                    }}
                  >
                    Delete
                  </button>
                </>
              );
            })()}
          </div>
        </div>
      )}

      {/* CMD+Hover Active Tab Popover — unified hook + CmdHoverPopover */}
      {activePopover.isVisible && activePopover.hoveredItem && (() => {
        const tab = tabs.find(t => t.id === activePopover.hoveredItem!.id);
        if (!tab) return null;
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
