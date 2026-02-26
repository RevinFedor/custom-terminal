import React, { useState, useEffect } from 'react';
import { useProjectsStore } from '../../store/useProjectsStore';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';
import { useUIStore } from '../../store/useUIStore';
import { useBookmarksStore, Bookmark } from '../../store/useBookmarksStore';
import { useCmdKey, useCmdHoverPopover } from '../../hooks/useCmdHoverPopover';
import ProjectCard from './ProjectCard';
import BookmarkCard from './BookmarkCard';
import { Plus, Square, X } from 'lucide-react';

const { ipcRenderer } = window.require('electron');

interface AIProcess {
  pid: number;
  cwd: string;
  startTime: string;
  command: string;
  tabId: string | null;
  cpu: string;
  mem: string;
}

export default function Dashboard() {
  const [processStatus, setProcessStatus] = useState<Map<string, boolean>>(new Map());
  const [claudeProcesses, setClaudeProcesses] = useState<AIProcess[]>([]);
  const [geminiProcesses, setGeminiProcesses] = useState<AIProcess[]>([]);
  const [isProcessesLoading, setIsProcessesLoading] = useState(true);

  const [killTooltip, setKillTooltip] = useState<'claude' | 'gemini' | null>(null);
  const [historyCounts, setHistoryCounts] = useState<Map<string, number>>(new Map());

  // CMD+hover popover (unified hook)
  const isCmdPressed = useCmdKey();
  const processPopover = useCmdHoverPopover<number>(isCmdPressed);

  const { projects, loadProjects } = useProjectsStore();
  const { openProject, openProjects } = useWorkspaceStore();
  const { bookmarks, loadBookmarks, addBookmarkFromDialog, updateBookmark, deleteBookmark } = useBookmarksStore();
  const { openEditModal } = useUIStore();

  // Remove local modal states
  // const [editingBookmark, setEditingBookmark] = useState<Bookmark | null>(null);
  // const [editName, setEditName] = useState('');
  // const [editDescription, setEditDescription] = useState('');

  useEffect(() => {
    loadProjects();
    loadBookmarks();
  }, []);

  // Fetch history counts for all projects
  useEffect(() => {
    const fetchHistoryCounts = async () => {
      const ids = Object.keys(projects);
      if (ids.length === 0) return;
      const counts = new Map<string, number>();
      await Promise.all(
        ids.map(async (id) => {
          try {
            const count = await ipcRenderer.invoke('project:get-tab-history-count', { projectId: id });
            counts.set(id, count);
          } catch {
            counts.set(id, 0);
          }
        })
      );
      setHistoryCounts(counts);
    };
    fetchHistoryCounts();
  }, [Object.keys(projects).length]);

  // OSC 133 Event-driven process status
  useEffect(() => {
    const allTabIds: string[] = [];
    for (const [, workspace] of openProjects) {
      allTabIds.push(...workspace.tabs.keys());
    }

    if (allTabIds.length === 0) return;

    const initStatus = async () => {
      const newStatus = new Map<string, boolean>();
      await Promise.all(
        allTabIds.map(async (tabId) => {
          try {
            const state = await ipcRenderer.invoke('terminal:getCommandState', tabId);
            newStatus.set(tabId, state.isRunning);
          } catch {
            newStatus.set(tabId, false);
          }
        })
      );
      setProcessStatus(newStatus);
    };
    initStatus();

    const handleCommandStarted = (_: any, { tabId }: { tabId: string }) => {
      setProcessStatus(prev => {
        const next = new Map(prev);
        next.set(tabId, true);
        return next;
      });
    };

    const handleCommandFinished = (_: any, { tabId }: { tabId: string }) => {
      setProcessStatus(prev => {
        const next = new Map(prev);
        next.set(tabId, false);
        return next;
      });
    };

    ipcRenderer.on('terminal:command-started', handleCommandStarted);
    ipcRenderer.on('terminal:command-finished', handleCommandFinished);

    return () => {
      ipcRenderer.removeListener('terminal:command-started', handleCommandStarted);
      ipcRenderer.removeListener('terminal:command-finished', handleCommandFinished);
    };
  }, [openProjects.size]);

  // Poll for active AI processes (Claude + Gemini)
  useEffect(() => {
    let isFirst = true;
    const fetchProcesses = async () => {
      try {
        const [claude, gemini] = await Promise.all([
          ipcRenderer.invoke('system:get-claude-processes'),
          ipcRenderer.invoke('system:get-gemini-processes'),
        ]);
        setClaudeProcesses(claude || []);
        setGeminiProcesses(gemini || []);
      } catch {
        setClaudeProcesses([]);
        setGeminiProcesses([]);
      }
      if (isFirst) {
        setIsProcessesLoading(false);
        isFirst = false;
      }
    };

    fetchProcesses();
    const interval = setInterval(fetchProcesses, 10000);
    return () => clearInterval(interval);
  }, []);


  // Create project from bookmark - always creates a NEW project instance
  const handleCreateProjectFromBookmark = async (bookmark: Bookmark) => {
    console.log('[Dashboard] handleCreateProjectFromBookmark called with bookmark:', bookmark);

    // Generate unique name with suffix if needed
    let projectName = bookmark.name;
    const existingNames = Object.values(projects).map(p => p.name);
    console.log('[Dashboard] Existing project names:', existingNames);

    if (existingNames.includes(projectName)) {
      let suffix = 1;
      while (existingNames.includes(`${bookmark.name}-${suffix}`)) {
        suffix++;
      }
      projectName = `${bookmark.name}-${suffix}`;
    }
    console.log('[Dashboard] Final project name:', projectName);

    // Always create new project instance
    console.log('[Dashboard] Calling project:create-instance...');
    try {
      const newProject = await ipcRenderer.invoke('project:create-instance', {
        path: bookmark.path,
        name: projectName
      });
      console.log('[Dashboard] project:create-instance returned:', newProject);

      if (newProject) {
        console.log('[Dashboard] Loading projects...');
        await loadProjects();
        console.log('[Dashboard] Opening project:', newProject.id, newProject.path);
        openProject(newProject.id, newProject.path);
      } else {
        console.error('[Dashboard] project:create-instance returned null/undefined!');
      }
    } catch (err) {
      console.error('[Dashboard] Error in handleCreateProjectFromBookmark:', err);
    }
  };

  const handleOpenProjectWorkspace = (projectId: string) => {
    openProject(projectId, projects[projectId].path);
  };

  // Get ALL projects from DB, sorted by updated_at (most recent first)
  const allProjects = Object.values(projects);

  // Check if project is currently open
  const isProjectOpen = (projectId: string) => openProjects.has(projectId);

  // Get tabs stats for each project
  const getTabsStats = (projectId: string) => {
    const projectData = openProjects.get(projectId);
    if (!projectData) return { total: 0, active: 0, history: historyCounts.get(projectId) || 0 };

    const total = projectData.tabs.size;
    let active = 0;

    for (const tabId of projectData.tabs.keys()) {
      if (processStatus.get(tabId)) {
        active++;
      }
    }

    return { total, active, history: historyCounts.get(projectId) || 0 };
  };

  // Handle edit bookmark
  const handleEditBookmark = (bookmark: Bookmark) => {
    openEditModal(bookmark);
  };

  // Handle delete bookmark
  const handleDeleteBookmark = async (bookmark: Bookmark) => {
    if (confirm(`Delete bookmark "${bookmark.name}"?`)) {
      await deleteBookmark(bookmark.id);
    }
  };

  return (
    <div className="flex-1 flex flex-col bg-bg-main overflow-hidden">
      <div className="flex-1 overflow-y-auto overflow-x-hidden px-6 pb-6 pt-12">
        {/* All Projects Section */}
        {allProjects.length > 0 && (
          <div className="mb-8">
            <h2 className="text-sm font-medium text-[#888] mb-3">Projects</h2>
            <div
              className="gap-3"
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 180px))',
              }}
            >
              {allProjects.map((project) => (
                <ProjectCard
                  key={project.id}
                  project={project}
                  isOpen={isProjectOpen(project.id)}
                  onOpen={() => handleOpenProjectWorkspace(project.id)}
                  onMiddleClick={() => openProject(project.id, project.path, { background: true })}
                  tabsStats={getTabsStats(project.id)}
                />
              ))}
            </div>
          </div>
        )}

        {/* Bookmarks Section */}
        <div>
          <h2 className="text-sm font-medium text-[#888] mb-3">Reserved Directories</h2>

          <div className="flex flex-wrap gap-2">
            {bookmarks.map((bookmark) => (
              <BookmarkCard
                key={bookmark.id}
                bookmark={bookmark}
                onCreateProject={handleCreateProjectFromBookmark}
                onEdit={handleEditBookmark}
                onDelete={handleDeleteBookmark}
              />
            ))}

            {/* Add Directory Card - same style as BookmarkCard */}
            <div
              className="flex items-center justify-center gap-2 px-3 py-3 rounded-lg border border-dashed border-[#444] bg-transparent cursor-pointer transition-all duration-150 hover:border-[#666] hover:bg-[#1a1a1a]"
              onClick={addBookmarkFromDialog}
            >
              <Plus size={14} className="text-[#666]" />
              <span className="text-sm text-[#666]">Add Directory</span>
            </div>
          </div>
        </div>

        {/* Active AI Processes — two columns */}
        {(() => {
          const getTabLabel = (proc: AIProcess) => {
            if (!proc.tabId) return '';
            for (const [projId, workspace] of openProjects) {
              const tab = workspace.tabs.get(proc.tabId);
              if (tab) {
                const projName = projects[projId]?.name || projId;
                return `${projName} / ${tab.name}`;
              }
            }
            return proc.cwd.split('/').filter(Boolean).pop() || proc.cwd;
          };

          const handleKill = async (pid: number) => {
            await ipcRenderer.invoke('system:kill-process', pid);
            setTimeout(async () => {
              try {
                const [claude, gemini] = await Promise.all([
                  ipcRenderer.invoke('system:get-claude-processes'),
                  ipcRenderer.invoke('system:get-gemini-processes'),
                ]);
                setClaudeProcesses(claude || []);
                setGeminiProcesses(gemini || []);
              } catch { /* ignore */ }
            }, 500);
          };

          const renderProcessCard = (proc: AIProcess, accentColor: string) => {
            const isInApp = !!proc.tabId;
            const label = isInApp
              ? getTabLabel(proc)
              : proc.cwd.split('/').filter(Boolean).pop() || proc.cwd;
            const showPopover = processPopover.isVisible && processPopover.hoveredItem?.id === proc.pid;

            return (
              <div
                key={proc.pid}
                className={`relative group flex items-center gap-2 px-3 py-2.5 rounded-lg border transition-colors hover:border-[#444] ${
                  isInApp ? 'border-[#333] bg-[#1a1a1a]' : 'border-dashed border-[#333] bg-transparent'
                }`}
                {...processPopover.triggerProps(proc.pid)}
              >
                {/* Circle → Square on card hover */}
                <button
                  className="flex-shrink-0 flex items-center justify-center w-4 h-4"
                  onClick={() => handleKill(proc.pid)}
                >
                  <span
                    className="w-2 h-2 rounded-full group-hover:hidden"
                    style={{ backgroundColor: isInApp ? accentColor : '#888' }}
                  />
                  <Square
                    size={11}
                    fill="currentColor"
                    stroke="none"
                    className="hidden group-hover:block text-red-500/50 hover:text-red-400 cursor-pointer"
                  />
                </button>
                <span className={`text-sm ${isInApp ? 'text-[#ccc]' : 'text-[#888]'}`}>{label}</span>
                <span className={`text-xs ${isInApp ? 'text-[#666]' : 'text-[#555]'}`}>{proc.startTime}</span>

                {/* CMD+Hover popover (bridge + pinning via hook) */}
                {showPopover && (
                  <div
                    className="absolute z-50"
                    style={{
                      bottom: '100%',
                      left: 0,
                      paddingBottom: '4px',
                    }}
                    {...processPopover.popoverProps}
                  >
                    <div
                      style={{
                        minWidth: '180px',
                        padding: '8px 10px',
                        backgroundColor: '#1e1e1e',
                        border: '1px solid #333',
                        borderRadius: '6px',
                        boxShadow: '0 4px 12px rgba(0,0,0,0.4)',
                      }}
                    >
                      <div className="text-[10px] text-[#888] space-y-0.5 select-text cursor-text">
                        <div>PID: <span className="text-[#ccc]">{proc.pid}</span></div>
                        <div>CPU: <span className="text-[#ccc]">{proc.cpu}%</span>  MEM: <span className="text-[#ccc]">{proc.mem}%</span></div>
                        <div className="truncate" title={proc.cwd}>CWD: <span className="text-[#ccc]">{proc.cwd}</span></div>
                        <div>{isInApp ? 'In-App' : 'External'}</div>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            );
          };

          const handleKillAllExternal = async (processes: AIProcess[]) => {
            const external = processes.filter(p => !p.tabId);
            if (external.length === 0) return;
            await Promise.all(
              external.map(p => ipcRenderer.invoke('system:kill-process', p.pid))
            );
            // Refetch
            setTimeout(async () => {
              try {
                const [claude, gemini] = await Promise.all([
                  ipcRenderer.invoke('system:get-claude-processes'),
                  ipcRenderer.invoke('system:get-gemini-processes'),
                ]);
                setClaudeProcesses(claude || []);
                setGeminiProcesses(gemini || []);
              } catch { /* ignore */ }
            }, 500);
          };

          const claudeExternal = claudeProcesses.filter(p => !p.tabId);
          const geminiExternal = geminiProcesses.filter(p => !p.tabId);

          return (
            <div className="mt-8">
              {isProcessesLoading ? (
                <div className="flex items-center gap-3 py-4">
                  <div className="w-4 h-4 border-2 border-white/10 border-t-white/40 rounded-full animate-spin" />
                  <span className="text-xs text-[#555]">Scanning processes...</span>
                </div>
              ) : (
                <div className="flex gap-6">
                  {/* Claude column */}
                  <div className="flex-1">
                    <h2 className="text-sm font-medium text-[#888] mb-3 flex items-center gap-2">
                      <span style={{ color: '#e8913e' }}>Claude</span>
                      {claudeProcesses.length > 0 && (
                        <span className="text-xs text-[#555]">{claudeProcesses.length}</span>
                      )}
                      {claudeExternal.length > 0 && (
                        <div className="relative">
                          <button
                            className="text-[#555] hover:text-red-400 transition-colors cursor-pointer"
                            onClick={() => handleKillAllExternal(claudeProcesses)}
                            onMouseEnter={() => setKillTooltip('claude')}
                            onMouseLeave={() => setKillTooltip(null)}
                          >
                            <X size={12} />
                          </button>
                          {killTooltip === 'claude' && (
                            <div
                              className="absolute left-1/2 -translate-x-1/2 top-5 z-50 px-2 py-1 rounded text-[10px] text-[#aaa] whitespace-nowrap"
                              style={{ backgroundColor: '#1a1a1a', border: '1px solid #333', boxShadow: '0 2px 8px rgba(0,0,0,0.3)' }}
                            >
                              Kill {claudeExternal.length} external {claudeExternal.length > 1 ? 'processes' : 'process'}
                            </div>
                          )}
                        </div>
                      )}
                    </h2>
                    <div className="flex flex-wrap gap-2">
                      {claudeProcesses.length > 0 ? (
                        claudeProcesses.map(p => renderProcessCard(p, '#e8913e'))
                      ) : (
                        <span className="text-xs text-[#555]">No active processes</span>
                      )}
                    </div>
                  </div>

                  {/* Vertical divider */}
                  <div className="w-px self-stretch" style={{ backgroundColor: '#2a2a2a' }} />

                  {/* Gemini column */}
                  <div className="flex-1">
                    <h2 className="text-sm font-medium text-[#888] mb-3 flex items-center gap-2">
                      <span style={{ color: '#4285f4' }}>Gemini</span>
                      {geminiProcesses.length > 0 && (
                        <span className="text-xs text-[#555]">{geminiProcesses.length}</span>
                      )}
                      {geminiExternal.length > 0 && (
                        <div className="relative">
                          <button
                            className="text-[#555] hover:text-red-400 transition-colors cursor-pointer"
                            onClick={() => handleKillAllExternal(geminiProcesses)}
                            onMouseEnter={() => setKillTooltip('gemini')}
                            onMouseLeave={() => setKillTooltip(null)}
                          >
                            <X size={12} />
                          </button>
                          {killTooltip === 'gemini' && (
                            <div
                              className="absolute left-1/2 -translate-x-1/2 top-5 z-50 px-2 py-1 rounded text-[10px] text-[#aaa] whitespace-nowrap"
                              style={{ backgroundColor: '#1a1a1a', border: '1px solid #333', boxShadow: '0 2px 8px rgba(0,0,0,0.3)' }}
                            >
                              Kill {geminiExternal.length} external {geminiExternal.length > 1 ? 'sessions' : 'session'}
                            </div>
                          )}
                        </div>
                      )}
                    </h2>
                    <div className="flex flex-wrap gap-2">
                      {geminiProcesses.length > 0 ? (
                        geminiProcesses.map(p => renderProcessCard(p, '#4285f4'))
                      ) : (
                        <span className="text-xs text-[#555]">No active sessions</span>
                      )}
                    </div>
                  </div>
                </div>
              )}
            </div>
          );
        })()}
      </div>
    </div>
  );
}
