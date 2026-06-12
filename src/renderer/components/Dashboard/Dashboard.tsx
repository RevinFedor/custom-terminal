import React, { useState, useEffect } from 'react';
import { useProjectsStore } from '../../store/useProjectsStore';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';
import { useCmdKey, useCmdHoverPopover } from '../../hooks/useCmdHoverPopover';
import ProjectCard from './ProjectCard';
import Tooltip from '../UI/Tooltip';
import { Square, X } from 'lucide-react';

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

interface MCPProcess {
  pid: number;
  ppid: number;
  cpu: string;
  mem: string;
  startTime: string;
  command: string;
  name: string;
  isAlive: boolean; // ppid belongs to live PTY/CLI
}

interface ElectronDevProcess {
  pid: number;
  ppid: number;
  launcherPid: number | null;
  cwd: string;
  name: string;
  startTime: string;
  command: string;
  cpu: string;
  mem: string;
  isOrphan: boolean;
}

export default function Dashboard() {
  const [processStatus, setProcessStatus] = useState<Map<string, boolean>>(new Map());
  const [claudeProcesses, setClaudeProcesses] = useState<AIProcess[]>([]);
  const [geminiProcesses, setGeminiProcesses] = useState<AIProcess[]>([]);
  const [mcpProcesses, setMcpProcesses] = useState<MCPProcess[]>([]);
  const [electronDevProcesses, setElectronDevProcesses] = useState<ElectronDevProcess[]>([]);
  const [mcpExpanded, setMcpExpanded] = useState(false);
  const [isProcessesLoading, setIsProcessesLoading] = useState(true);
  const [stoppingProcesses, setStoppingProcesses] = useState<Set<string>>(() => new Set());

  const [killTooltip, setKillTooltip] = useState<'claude' | 'gemini' | null>(null);
  const [historyCounts, setHistoryCounts] = useState<Map<string, number>>(new Map());
  const [autoResume, setAutoResume] = useState(false);

  // CMD+hover popover (unified hook)
  const isCmdPressed = useCmdKey();
  const processPopover = useCmdHoverPopover<number>(isCmdPressed);

  const { projects, loadProjects } = useProjectsStore();
  const { openProject, openProjects } = useWorkspaceStore();

  const handleActionKeyDown = (event: React.KeyboardEvent, action: () => void) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    action();
  };

  const setProcessStopping = (key: string, stopping: boolean) => {
    setStoppingProcesses(prev => {
      const next = new Set(prev);
      if (stopping) {
        next.add(key);
      } else {
        next.delete(key);
      }
      return next;
    });
  };

  const refreshProcesses = async () => {
    try {
      const [claude, gemini, mcp, electronDev] = await Promise.all([
        ipcRenderer.invoke('system:get-claude-processes'),
        ipcRenderer.invoke('system:get-gemini-processes'),
        ipcRenderer.invoke('system:get-mcp-processes'),
        ipcRenderer.invoke('system:get-electron-dev-processes'),
      ]);
      setClaudeProcesses(claude || []);
      setGeminiProcesses(gemini || []);
      setMcpProcesses(mcp || []);
      setElectronDevProcesses(electronDev || []);
    } catch {
      setClaudeProcesses([]);
      setGeminiProcesses([]);
      setMcpProcesses([]);
      setElectronDevProcesses([]);
    }
  };

  const refreshAfterProcessStop = (key: string) => {
    window.setTimeout(async () => {
      await refreshProcesses();
      setProcessStopping(key, false);
    }, 500);
  };

  const handleKillElectronDev = async (proc: ElectronDevProcess) => {
    const processKey = `electron:${proc.pid}`;
    if (stoppingProcesses.has(processKey)) return;

    setProcessStopping(processKey, true);
    try {
      await ipcRenderer.invoke('system:kill-electron-dev-process', proc.pid);
    } finally {
      refreshAfterProcessStop(processKey);
    }
  };

  useEffect(() => {
    loadProjects();
    // Load auto-resume setting
    ipcRenderer.invoke('app:getState', 'auto_resume_sessions').then((val: any) => {
      if (val === true || val === 'true') setAutoResume(true);
    }).catch(() => {});
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
    const allTabs: Array<{ tabId: string; commandType?: string }> = [];
    for (const [, workspace] of openProjects) {
      workspace.tabs.forEach((tab: any, tabId) => {
        allTabs.push({ tabId, commandType: tab?.commandType });
      });
    }

    if (allTabs.length === 0) return;

    const initStatus = async () => {
      const newStatus = new Map<string, boolean>();
      await Promise.all(
        allTabs.map(async ({ tabId, commandType }) => {
          try {
            const state = await ipcRenderer.invoke('terminal:getCommandState', {
              tabId,
              caller: 'Dashboard.statusInit',
              expectedProcess: 'codex',
              allowProcessTreeLookup: commandType === 'codex',
            });
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

  // Poll for active AI processes + Electron dev apps.
  useEffect(() => {
    let isFirst = true;
    const fetchProcesses = async () => {
      await refreshProcesses();
      if (isFirst) {
        setIsProcessesLoading(false);
        isFirst = false;
      }
    };

    fetchProcesses();
    const interval = setInterval(fetchProcesses, 10000);
    return () => clearInterval(interval);
  }, []);

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

  return (
    <div className="flex-1 flex flex-col bg-bg-main overflow-hidden">
      <div className="flex-1 overflow-y-auto overflow-x-hidden px-6 pb-6 pt-12">
        {/* All Projects Section */}
        {allProjects.length > 0 && (
          <div className="mb-8">
            <h2 className="text-sm font-medium text-[#888] mb-3">Projects</h2>
            <div
              className="gap-2"
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(118px, 150px))',
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

        {!isProcessesLoading && electronDevProcesses.length > 0 && (
          <div className="mb-5 -mt-4 px-1">
            <div className="flex items-center gap-2 overflow-x-auto">
              <span className="text-xs text-[#666] flex-shrink-0">Electron Dev</span>
              {electronDevProcesses.map((proc) => {
                const processKey = `electron:${proc.pid}`;
                const isStopping = stoppingProcesses.has(processKey);

                return (
                  <div
                    key={proc.pid}
                    role="button"
                    tabIndex={0}
                    title={`${proc.command}\n${proc.cwd}`}
                    className={`group h-7 max-w-[280px] flex items-center gap-2 px-2.5 rounded-md border text-xs select-none transition-colors focus:outline-none ${
                      isStopping
                        ? 'cursor-wait border-red-500/30 bg-red-500/10 text-[#ddd]'
                        : 'cursor-pointer border-[#333] bg-[#171717] text-[#aaa] hover:border-red-500/40 hover:bg-red-500/10 hover:text-[#ddd] focus:border-red-500/40'
                    }`}
                    onClick={() => { if (!isStopping) handleKillElectronDev(proc); }}
                    onKeyDown={(event) => handleActionKeyDown(event, () => { if (!isStopping) handleKillElectronDev(proc); })}
                  >
                    <span className="flex-shrink-0 flex items-center justify-center w-4 h-4">
                      {isStopping ? (
                        <span className="w-3 h-3 rounded-full border border-red-400/25 border-t-red-300 animate-spin" />
                      ) : (
                        <>
                          <span className="w-2 h-2 rounded-full bg-[#888] group-hover:hidden" />
                          <Square
                            size={11}
                            fill="currentColor"
                            stroke="none"
                            className="hidden group-hover:block text-red-400"
                          />
                        </>
                      )}
                    </span>
                    <span className="truncate">{proc.name}</span>
                    <span className={isStopping ? 'text-red-300/80' : 'text-[#555] group-hover:text-red-300/80'}>
                      {isStopping ? 'stopping' : `pid ${proc.pid}`}
                    </span>
                    {proc.isOrphan && !isStopping && <span className="text-[#666] group-hover:text-red-300/80">orphan</span>}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Settings */}
        <div className="flex items-center gap-3 mb-4 px-1">
          <Tooltip content="Автоматически возобновлять прерванные AI-сессии при запуске приложения">
            <label className="flex items-center gap-2 cursor-pointer select-none">
              <div
                className="relative w-8 h-4 rounded-full transition-colors"
                style={{ backgroundColor: autoResume ? 'rgba(74, 222, 128, 0.4)' : 'rgba(255,255,255,0.1)' }}
                onClick={() => {
                  const next = !autoResume;
                  setAutoResume(next);
                  ipcRenderer.invoke('app:setState', { key: 'auto_resume_sessions', value: next });
                }}
              >
                <div
                  className="absolute top-0.5 w-3 h-3 rounded-full transition-all"
                  style={{
                    left: autoResume ? '18px' : '2px',
                    backgroundColor: autoResume ? '#4ade80' : '#666',
                  }}
                />
              </div>
              <span className="text-xs text-[#888]">Auto-resume AI sessions</span>
            </label>
          </Tooltip>
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

          const handleKill = async (proc: AIProcess) => {
            const processKey = `ai:${proc.pid}`;
            if (stoppingProcesses.has(processKey)) return;

            // Protect In-App processes: route through normal close path so PTY cleanup runs
            if (proc.tabId) {
              const ok = window.confirm('Это активная сессия в табе. Закрыть?');
              if (!ok) return;

              setProcessStopping(processKey, true);
              ipcRenderer.send('terminal:kill', proc.tabId);
            } else {
              setProcessStopping(processKey, true);
              try {
                await ipcRenderer.invoke('system:kill-process', proc.pid);
              } finally {
                refreshAfterProcessStop(processKey);
              }
              return;
            }
            refreshAfterProcessStop(processKey);
          };

          const renderProcessCard = (proc: AIProcess, accentColor: string) => {
            const isInApp = !!proc.tabId;
            const processKey = `ai:${proc.pid}`;
            const isStopping = stoppingProcesses.has(processKey);
            const label = isInApp
              ? getTabLabel(proc)
              : proc.cwd.split('/').filter(Boolean).pop() || proc.cwd;
            const showPopover = processPopover.isVisible && processPopover.hoveredItem?.id === proc.pid;

            return (
              <div
                key={proc.pid}
                role="button"
                tabIndex={0}
                className={`relative group flex items-center gap-2 px-3 py-2.5 rounded-lg border select-none transition-colors focus:outline-none ${
                  isStopping
                    ? 'cursor-wait border-red-500/30 bg-red-500/10'
                    : `cursor-pointer hover:border-red-500/40 hover:bg-red-500/10 focus:border-red-500/40 ${isInApp ? 'border-[#333] bg-[#1a1a1a]' : 'border-dashed border-[#333] bg-transparent'}`
                }`}
                {...processPopover.triggerProps(proc.pid)}
                onClick={() => { if (!isStopping) handleKill(proc); }}
                onKeyDown={(event) => handleActionKeyDown(event, () => { if (!isStopping) handleKill(proc); })}
              >
                <span className="flex-shrink-0 flex items-center justify-center w-4 h-4">
                  {isStopping ? (
                    <span className="w-3 h-3 rounded-full border border-red-400/25 border-t-red-300 animate-spin" />
                  ) : (
                    <>
                      <span
                        className="w-2 h-2 rounded-full group-hover:hidden"
                        style={{ backgroundColor: isInApp ? accentColor : '#888' }}
                      />
                      <Square
                        size={11}
                        fill="currentColor"
                        stroke="none"
                        className="hidden group-hover:block text-red-400"
                      />
                    </>
                  )}
                </span>
                <span className={`text-sm ${isStopping ? 'text-[#ddd]' : isInApp ? 'text-[#ccc]' : 'text-[#888]'}`}>{label}</span>
                <span className={`text-xs ${isStopping ? 'text-red-300/80' : isInApp ? 'text-[#666]' : 'text-[#555]'}`}>
                  {isStopping ? 'stopping' : proc.startTime}
                </span>

                {/* CMD+Hover popover (bridge + pinning via hook) */}
                {showPopover && (
                  <div
                    className="absolute z-50"
                    data-process-popover
                    style={{
                      bottom: '100%',
                      left: 0,
                      paddingBottom: '4px',
                    }}
                    {...processPopover.popoverProps}
                    onMouseDown={(e) => e.stopPropagation()}
                    onClick={(e) => e.stopPropagation()}
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
                        <Tooltip content={proc.cwd}>
                          <div className="truncate">CWD: <span className="text-[#ccc]">{proc.cwd}</span></div>
                        </Tooltip>
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
            const keys = external.map(p => `ai:${p.pid}`);
            keys.forEach(key => setProcessStopping(key, true));
            try {
              await Promise.all(
                external.map(p => ipcRenderer.invoke('system:kill-process', p.pid))
              );
            } finally {
              keys.forEach(refreshAfterProcessStop);
            }
          };

          const handleKillAllOrphanMcp = async () => {
            const orphans = mcpProcesses.filter(p => !p.isAlive);
            if (orphans.length === 0) return;
            const keys = orphans.map(p => `mcp:${p.pid}`);
            keys.forEach(key => setProcessStopping(key, true));
            try {
              await Promise.all(orphans.map(p => ipcRenderer.invoke('system:kill-process', p.pid)));
            } finally {
              keys.forEach(refreshAfterProcessStop);
            }
          };

          const handleKillMcp = async (pid: number) => {
            const processKey = `mcp:${pid}`;
            if (stoppingProcesses.has(processKey)) return;

            setProcessStopping(processKey, true);
            try {
              await ipcRenderer.invoke('system:kill-process', pid);
            } finally {
              refreshAfterProcessStop(processKey);
            }
          };

          const claudeExternal = claudeProcesses.filter(p => !p.tabId);
          const geminiExternal = geminiProcesses.filter(p => !p.tabId);
          const mcpOrphans = mcpProcesses.filter(p => !p.isAlive);

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

              {/* MCP processes — collapsed by default, shown as count + dropdown */}
              {!isProcessesLoading && mcpProcesses.length > 0 && (
                <div className="mt-4 pt-3 border-t border-[#222]">
                  <button
                    className="flex items-center gap-2 text-xs text-[#888] hover:text-[#ccc] transition-colors"
                    onClick={() => setMcpExpanded(v => !v)}
                  >
                    <span>{mcpExpanded ? '▾' : '▸'}</span>
                    <span>MCP servers</span>
                    <span className="text-[#555]">{mcpProcesses.length}</span>
                    {mcpOrphans.length > 0 && (
                      <span className="text-[#666]">({mcpOrphans.length} orphan)</span>
                    )}
                    {mcpOrphans.length > 0 && (
                      <Tooltip content={`Kill ${mcpOrphans.length} orphan MCP processes`}>
                        <span
                          className="ml-1 text-[#555] hover:text-red-400 transition-colors cursor-pointer"
                          onClick={(e) => { e.stopPropagation(); handleKillAllOrphanMcp(); }}
                        >
                          <X size={12} />
                        </span>
                      </Tooltip>
                    )}
                  </button>
                  {mcpExpanded && (
                    <div className="mt-2 max-h-64 overflow-y-auto flex flex-col gap-1">
                      {mcpProcesses.map(p => {
                        const processKey = `mcp:${p.pid}`;
                        const isStopping = stoppingProcesses.has(processKey);

                        return (
                          <div
                            key={p.pid}
                            role="button"
                            tabIndex={0}
                            title={p.command}
                            className={`group flex items-center gap-2 px-2 py-1 rounded text-xs select-none transition-colors focus:outline-none ${
                              isStopping
                                ? 'cursor-wait bg-red-500/10 text-[#ddd]'
                                : `cursor-pointer hover:border-red-500/40 hover:bg-red-500/10 focus:bg-red-500/10 ${p.isAlive ? 'text-[#aaa]' : 'text-[#666]'}`
                            }`}
                            onClick={() => { if (!isStopping) handleKillMcp(p.pid); }}
                            onKeyDown={(event) => handleActionKeyDown(event, () => { if (!isStopping) handleKillMcp(p.pid); })}
                          >
                            <span className="flex-shrink-0 flex items-center justify-center w-4 h-4">
                              {isStopping ? (
                                <span className="w-3 h-3 rounded-full border border-red-400/25 border-t-red-300 animate-spin" />
                              ) : (
                                <>
                                  <span
                                    className="w-2 h-2 rounded-full group-hover:hidden"
                                    style={{ backgroundColor: p.isAlive ? '#888' : '#444' }}
                                  />
                                  <Square
                                    size={11}
                                    fill="currentColor"
                                    stroke="none"
                                    className="hidden group-hover:block text-red-400"
                                  />
                                </>
                              )}
                            </span>
                            <Tooltip content={p.command}>
                              <span className="flex-1 truncate">{p.name}</span>
                            </Tooltip>
                            <span className={isStopping ? 'text-red-300/80' : 'text-[#555]'}>
                              {isStopping ? 'stopping' : `pid ${p.pid}`}
                            </span>
                            <span className="text-[#555]">{p.startTime}</span>
                            {!p.isAlive && !isStopping && <span className="text-[#666]">orphan</span>}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })()}
      </div>
    </div>
  );
}
