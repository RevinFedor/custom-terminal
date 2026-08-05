import React, { useState, useEffect } from 'react';
import { useProjectsStore } from '../../store/useProjectsStore';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';
import { useCmdKey, useCmdHoverPopover } from '../../hooks/useCmdHoverPopover';
import ProjectCard from './ProjectCard';
import Tooltip from '../UI/Tooltip';
import ControlHint from '../UI/ControlHint';
import { ChevronDown, ChevronRight, Square, X } from 'lucide-react';
import { isInboxProjectId } from '../../constants/systemProjects';

const { ipcRenderer } = window.require('electron');

interface AIProcess {
  pid: number;
  ppid?: number;
  cwd: string;
  startTime: string;
  command: string;
  tabId: string | null;
  cpu: string;
  mem: string;
  ownerInstance?: 'current' | 'custom-terminal' | 'external';
  ownerPid?: number | null;
  ownerLabel?: string;
  protectedByApp?: boolean;
  killable?: boolean;
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
  ownerInstance?: 'current' | 'custom-terminal' | 'external';
  ownerPid?: number | null;
  ownerLabel?: string;
  protectedByApp?: boolean;
  killable?: boolean;
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

type AiProcessSectionKey = 'claude' | 'gemini' | 'codex';
const AI_PROCESS_COLLAPSED_COUNT = 2;
const AI_PROCESS_EXPANDED_VISIBLE_COUNT = 8;

export default function Dashboard() {
  const [processStatus, setProcessStatus] = useState<Map<string, boolean>>(new Map());
  const [claudeProcesses, setClaudeProcesses] = useState<AIProcess[]>([]);
  const [geminiProcesses, setGeminiProcesses] = useState<AIProcess[]>([]);
  const [codexProcesses, setCodexProcesses] = useState<AIProcess[]>([]);
  const [mcpProcesses, setMcpProcesses] = useState<MCPProcess[]>([]);
  const [electronDevProcesses, setElectronDevProcesses] = useState<ElectronDevProcess[]>([]);
  const [mcpExpanded, setMcpExpanded] = useState(false);
  const [expandedAiProcessSections, setExpandedAiProcessSections] = useState<Set<AiProcessSectionKey>>(() => new Set());
  const [isProcessesLoading, setIsProcessesLoading] = useState(true);
  const [stoppingProcesses, setStoppingProcesses] = useState<Set<string>>(() => new Set());

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

  const toggleAiProcessSection = (section: AiProcessSectionKey) => {
    setExpandedAiProcessSections(prev => {
      const next = new Set(prev);
      if (next.has(section)) {
        next.delete(section);
      } else {
        next.add(section);
      }
      return next;
    });
  };

  const refreshProcesses = async () => {
    try {
      const dashboardProcesses = await ipcRenderer.invoke('system:get-dashboard-processes');
      setClaudeProcesses(dashboardProcesses?.claude || []);
      setGeminiProcesses(dashboardProcesses?.gemini || []);
      setCodexProcesses(dashboardProcesses?.codex || []);
      setMcpProcesses(dashboardProcesses?.mcp || []);
      setElectronDevProcesses(dashboardProcesses?.electronDev || []);
    } catch {
      setClaudeProcesses([]);
      setGeminiProcesses([]);
      setCodexProcesses([]);
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
      const ids = Object.keys(projects).filter((id) => !isInboxProjectId(id));
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
      // ONE request for every tab of every open project. Asking per tab here
      // meant the Dashboard alone could fire 100+ concurrent main-process
      // lookups on open — the same stampede that stalled project switching.
      const newStatus = new Map<string, boolean>();
      try {
        const result = await ipcRenderer.invoke('terminal:getCommandStates', {
          caller: 'Dashboard.statusInit',
          tabs: allTabs.map(({ tabId, commandType }) => ({ tabId, commandType })),
        });
        const states = result?.states || {};
        for (const { tabId } of allTabs) {
          newStatus.set(tabId, states[tabId]?.isRunning === true);
        }
      } catch {
        for (const { tabId } of allTabs) newStatus.set(tabId, false);
      }
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

  // Process snapshot is intentionally low-frequency. Old Dashboard process
  // polling overloaded macOS sysmond by repeatedly calling ps/pgrep; keep this
  // to mount/focus/visibility/events plus a slow visible-window safety refresh.
  useEffect(() => {
    let disposed = false;
    let inFlight = false;
    let isFirst = true;
    let eventRefreshTimer: number | null = null;

    const fetchProcesses = async (force = false) => {
      if (disposed || inFlight) return;
      if (!force && document.visibilityState === 'hidden') return;
      inFlight = true;
      try {
        await refreshProcesses();
      } finally {
        inFlight = false;
      }
      if (!disposed && isFirst) {
        setIsProcessesLoading(false);
        isFirst = false;
      }
    };

    const scheduleEventRefresh = () => {
      if (eventRefreshTimer !== null) window.clearTimeout(eventRefreshTimer);
      eventRefreshTimer = window.setTimeout(() => {
        eventRefreshTimer = null;
        fetchProcesses(false);
      }, 1200);
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') fetchProcesses(true);
    };
    const handleFocus = () => fetchProcesses(true);

    fetchProcesses(true);
    const interval = window.setInterval(() => fetchProcesses(false), 60000);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('focus', handleFocus);
    ipcRenderer.on('terminal:command-started', scheduleEventRefresh);
    ipcRenderer.on('terminal:command-finished', scheduleEventRefresh);

    return () => {
      disposed = true;
      window.clearInterval(interval);
      if (eventRefreshTimer !== null) window.clearTimeout(eventRefreshTimer);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('focus', handleFocus);
      ipcRenderer.removeListener('terminal:command-started', scheduleEventRefresh);
      ipcRenderer.removeListener('terminal:command-finished', scheduleEventRefresh);
    };
  }, []);

  const handleOpenProjectWorkspace = (projectId: string) => {
    openProject(projectId, projects[projectId].path);
  };

  // Get ALL projects from DB, sorted by updated_at (most recent first)
  const allProjects = Object.values(projects).filter((project) => !isInboxProjectId(project.id));

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

        {/* Active AI Processes */}
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

          const isKillableExternalProcess = (proc: AIProcess) => (
            !proc.tabId &&
            proc.killable !== false &&
            proc.protectedByApp !== true
          );

          const canStopProcessFromThisInstance = (proc: AIProcess) => {
            if (proc.tabId) return true;
            if (proc.protectedByApp && proc.ownerInstance === 'custom-terminal') return false;
            return proc.killable !== false;
          };

          const getProcessOwnerRank = (proc: AIProcess) => {
            if (proc.tabId || proc.ownerInstance === 'current') return 0;
            if (proc.protectedByApp) return 1;
            return 2;
          };

          const sortAiProcessesForDisplay = (items: AIProcess[]) => (
            [...items].sort((a, b) => {
              const ownerRank = getProcessOwnerRank(a) - getProcessOwnerRank(b);
              if (ownerRank !== 0) return ownerRank;
              const labelCompare = (a.ownerLabel || '').localeCompare(b.ownerLabel || '');
              if (labelCompare !== 0) return labelCompare;
              return a.pid - b.pid;
            })
          );

          const getOwnerBadge = (proc: AIProcess) => {
            if (!proc.ownerLabel || proc.ownerLabel === 'external') return '';
            return proc.ownerLabel;
          };

          const handleKill = async (proc: AIProcess) => {
            const processKey = `ai:${proc.pid}`;
            if (stoppingProcesses.has(processKey)) return;
            if (!canStopProcessFromThisInstance(proc)) return;

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
            const canStop = canStopProcessFromThisInstance(proc);
            const processKey = `ai:${proc.pid}`;
            const isStopping = stoppingProcesses.has(processKey);
            const ownerBadge = getOwnerBadge(proc);
            const label = isInApp
              ? getTabLabel(proc)
              : proc.cwd.split('/').filter(Boolean).pop() || proc.cwd;
            const showPopover = processPopover.isVisible && processPopover.hoveredItem?.id === proc.pid;
            const cardStateClass = isStopping
              ? 'cursor-default border-red-500/30 bg-red-500/10'
              : canStop
                ? `cursor-pointer hover:border-red-500/40 hover:bg-red-500/10 focus:border-red-500/40 ${isInApp || proc.protectedByApp ? 'border-[#333] bg-[#1a1a1a]' : 'border-dashed border-[#333] bg-transparent'}`
                : 'cursor-default border-[#2a2a2a] bg-[#151515]';
            const labelColor = isStopping
              ? 'text-[#ddd]'
              : canStop
                ? (isInApp ? 'text-[#ccc]' : 'text-[#888]')
                : 'text-[#9a9a9a]';

            return (
              <div
                key={proc.pid}
                role={canStop ? 'button' : undefined}
                tabIndex={canStop ? 0 : -1}
                className={`relative group flex h-8 min-w-0 items-center gap-1.5 px-2 rounded-md border select-none transition-colors focus:outline-none ${cardStateClass}`}
                {...processPopover.triggerProps(proc.pid)}
                onClick={() => { if (!isStopping && canStop) handleKill(proc); }}
                onKeyDown={(event) => handleActionKeyDown(event, () => { if (!isStopping && canStop) handleKill(proc); })}
              >
                <span className="flex-shrink-0 flex items-center justify-center w-3.5 h-4">
                  {isStopping ? (
                    <span className="w-3 h-3 rounded-full border border-red-400/25 border-t-red-300 animate-spin" />
                  ) : (
                    <>
                      <span
                        className={`w-2 h-2 rounded-full ${canStop ? 'group-hover:hidden' : ''}`}
                        style={{ backgroundColor: isInApp ? accentColor : proc.protectedByApp ? '#8a8a8a' : '#888' }}
                      />
                      {canStop && (
                        <Square
                          size={11}
                          fill="currentColor"
                          stroke="none"
                          className="hidden group-hover:block text-red-400"
                        />
                      )}
                    </>
                  )}
                </span>
                <span className={`min-w-0 flex-1 truncate text-xs ${labelColor}`}>{label}</span>
                {ownerBadge && !isStopping && (
                  <span className="flex h-4 flex-shrink-0 items-center rounded border border-white/[0.06] bg-white/[0.04] px-1 text-[9px] leading-none text-[#aaa]">
                    {ownerBadge}
                  </span>
                )}
                <span className={`flex-shrink-0 text-[10px] ${isStopping ? 'text-red-300/80' : isInApp ? 'text-[#777]' : 'text-[#666]'}`}>
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
                        <div>Owner: <span className="text-[#ccc]">{proc.ownerLabel || (isInApp ? 'this app' : 'external')}</span></div>
                        {proc.ownerPid && (
                          <div>Owner PID: <span className="text-[#ccc]">{proc.ownerPid}</span></div>
                        )}
                        {!canStop && (
                          <div className="text-[#aaa]">Protected from this instance</div>
                        )}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            );
          };

          const renderAiProcessSection = (
            section: AiProcessSectionKey,
            title: string,
            processes: AIProcess[],
            externalProcesses: AIProcess[],
            accentColor: string,
            emptyLabel: string
          ) => {
            const isExpanded = expandedAiProcessSections.has(section);
            const displayProcesses = sortAiProcessesForDisplay(processes);
            const protectedCount = processes.filter(p => p.protectedByApp && !p.tabId).length;
            const hasOverflow = displayProcesses.length > AI_PROCESS_COLLAPSED_COUNT;
            const visibleProcesses = isExpanded || !hasOverflow
              ? displayProcesses
              : displayProcesses.slice(0, AI_PROCESS_COLLAPSED_COUNT);
            const hiddenCount = Math.max(0, displayProcesses.length - AI_PROCESS_COLLAPSED_COUNT);
            const toggleLabel = isExpanded ? `Свернуть (${displayProcesses.length})` : `Развернуть ещё (${hiddenCount})`;
            const expandedRows = Math.ceil(AI_PROCESS_EXPANDED_VISIBLE_COUNT / 2);
            const expandedMaxHeight = expandedRows * 32 + Math.max(0, expandedRows - 1) * 6;

            return (
              <div className="min-w-0 max-w-[340px]">
                <div className="mb-2 flex items-center gap-2">
                  <h2 className="flex items-center gap-2 text-sm font-medium text-[#888]">
                    <span style={{ color: accentColor }}>{title}</span>
                    {processes.length > 0 && (
                      <span className="text-xs text-[#aaa]">{processes.length}</span>
                    )}
                  </h2>
                  {protectedCount > 0 && (
                    <span className="text-[10px] text-[#8f8f8f] whitespace-nowrap">protected {protectedCount}</span>
                  )}
                  {externalProcesses.length > 0 && (
                    <div className="relative flex items-center gap-1">
                      <ControlHint label={`Остановить внешние ${title}-процессы`}>
                        <button
                          className="flex h-6 w-6 items-center justify-center rounded-md text-[#777] transition-colors hover:bg-red-500/10 hover:text-red-400 cursor-pointer"
                          onClick={() => handleKillAllExternal(externalProcesses)}
                        >
                          <X size={15} strokeWidth={2.4} />
                        </button>
                      </ControlHint>
                      <span className="text-[10px] text-[#777] whitespace-nowrap">external only</span>
                    </div>
                  )}
                  {hasOverflow && isExpanded && (
                    <button
                      className="ml-1 rounded-md px-2 py-1 text-[11px] text-[#aaa] transition-colors hover:bg-white/[0.05] hover:text-[#ddd] cursor-pointer"
                      onClick={() => toggleAiProcessSection(section)}
                    >
                      {toggleLabel}
                    </button>
                  )}
                </div>

                <div
                  className={`grid grid-cols-2 gap-1.5 ${isExpanded ? 'overflow-y-auto pr-1' : ''}`}
                  style={isExpanded ? { maxHeight: expandedMaxHeight } : undefined}
                >
                  {processes.length > 0 ? (
                    visibleProcesses.map(p => renderProcessCard(p, accentColor))
                  ) : (
                    <span className="text-xs text-[#555]">{emptyLabel}</span>
                  )}
                </div>

                {hasOverflow && (
                  <button
                    className="mt-2 rounded-md px-2 py-1 text-[11px] text-[#aaa] transition-colors hover:bg-white/[0.05] hover:text-[#ddd] cursor-pointer"
                    onClick={() => toggleAiProcessSection(section)}
                  >
                    {toggleLabel}
                  </button>
                )}
              </div>
            );
          };

          const handleKillAllExternal = async (processes: AIProcess[]) => {
            const external = processes.filter(isKillableExternalProcess);
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
            const orphans = mcpProcesses.filter(p => !p.isAlive && p.killable !== false);
            if (orphans.length === 0) return;
            const keys = orphans.map(p => `mcp:${p.pid}`);
            keys.forEach(key => setProcessStopping(key, true));
            try {
              await Promise.all(orphans.map(p => ipcRenderer.invoke('system:kill-process', p.pid)));
            } finally {
              keys.forEach(refreshAfterProcessStop);
            }
          };

          const canStopMcpProcess = (proc: MCPProcess) => proc.killable !== false;

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

          const claudeExternal = claudeProcesses.filter(isKillableExternalProcess);
          const geminiExternal = geminiProcesses.filter(isKillableExternalProcess);
          const codexExternal = codexProcesses.filter(isKillableExternalProcess);
          const mcpOrphans = mcpProcesses.filter(p => !p.isAlive && p.killable !== false);

          return (
            <div className="mt-8">
              {isProcessesLoading ? (
                <div className="flex items-center gap-3 py-4">
                  <div className="w-4 h-4 border-2 border-white/10 border-t-white/40 rounded-full animate-spin" />
                  <span className="text-xs text-[#555]">Scanning processes...</span>
                </div>
              ) : (
                <div
                  className="grid gap-4"
                  style={{ gridTemplateColumns: 'repeat(3, minmax(0, 340px))' }}
                >
                  {renderAiProcessSection(
                    'claude',
                    'Claude',
                    claudeProcesses,
                    claudeExternal,
                    '#e8913e',
                    'No active processes'
                  )}
                  {renderAiProcessSection(
                    'gemini',
                    'Gemini',
                    geminiProcesses,
                    geminiExternal,
                    '#4285f4',
                    'No active sessions'
                  )}
                  {renderAiProcessSection(
                    'codex',
                    'Codex',
                    codexProcesses,
                    codexExternal,
                    '#9ca3af',
                    'No active chats'
                  )}
                </div>
              )}

              {/* MCP processes — collapsed by default, shown as count + dropdown */}
              {!isProcessesLoading && mcpProcesses.length > 0 && (
                <div className="mt-4 max-w-[560px] pt-3 border-t border-[#222]">
                  <div className="flex items-center gap-2">
                    <button
                      className="group flex h-7 items-center gap-2 rounded-md px-1.5 text-xs text-[#aaa] transition-colors hover:bg-white/[0.03] hover:text-[#ddd] cursor-pointer"
                      onClick={() => setMcpExpanded(v => !v)}
                    >
                      <span className="flex h-5 w-5 items-center justify-center rounded-md bg-white/[0.04] text-[#aaa] transition-colors group-hover:bg-white/[0.08] group-hover:text-[#ddd]">
                        {mcpExpanded ? (
                          <ChevronDown size={15} strokeWidth={2.4} />
                        ) : (
                          <ChevronRight size={15} strokeWidth={2.4} />
                        )}
                      </span>
                      <span className="font-medium">MCP servers</span>
                      <span className="text-[#b0b0b0]">({mcpProcesses.length})</span>
                      {mcpOrphans.length > 0 && (
                        <span className="text-[#888]">({mcpOrphans.length} orphan)</span>
                      )}
                      <span className="text-[#777]">
                        {mcpExpanded ? `Свернуть (${mcpProcesses.length})` : `Развернуть (${mcpProcesses.length})`}
                      </span>
                    </button>
                    {mcpOrphans.length > 0 && (
                      <ControlHint label={`Остановить orphan MCP-процессы: ${mcpOrphans.length}`}>
                        <button
                          className="flex h-7 w-7 items-center justify-center rounded-md text-[#777] transition-colors hover:bg-red-500/10 hover:text-red-400 cursor-pointer"
                          onClick={(e) => { e.stopPropagation(); handleKillAllOrphanMcp(); }}
                        >
                          <X size={16} strokeWidth={2.5} />
                        </button>
                      </ControlHint>
                    )}
                  </div>
                  {mcpExpanded && (
                    <>
                      <div className="mt-2 max-h-64 max-w-[560px] overflow-y-auto flex flex-col gap-1">
                        {mcpProcesses.map(p => {
                          const processKey = `mcp:${p.pid}`;
                          const isStopping = stoppingProcesses.has(processKey);
                          const canStopMcp = canStopMcpProcess(p);
                          const statusLabel = !p.isAlive
                            ? 'orphan'
                            : p.ownerLabel && p.ownerLabel !== 'external'
                              ? p.ownerLabel
                              : '';

                          return (
                            <div
                              key={p.pid}
                              role={canStopMcp ? 'button' : undefined}
                              tabIndex={canStopMcp ? 0 : -1}
                              title={p.command}
                              className={`group grid items-center gap-2 px-2 py-1 rounded text-xs select-none transition-colors focus:outline-none ${
                                isStopping
                                  ? 'cursor-default bg-red-500/10 text-[#ddd]'
                                  : canStopMcp
                                    ? `cursor-pointer hover:border-red-500/40 hover:bg-red-500/10 focus:bg-red-500/10 ${p.isAlive ? 'text-[#aaa]' : 'text-[#666]'}`
                                    : 'cursor-default text-[#888]'
                              }`}
                              style={{ gridTemplateColumns: '16px minmax(0, 1fr) auto auto auto' }}
                              onClick={() => { if (!isStopping && canStopMcp) handleKillMcp(p.pid); }}
                              onKeyDown={(event) => handleActionKeyDown(event, () => { if (!isStopping && canStopMcp) handleKillMcp(p.pid); })}
                            >
                              <span className="flex-shrink-0 flex items-center justify-center w-4 h-4">
                                {isStopping ? (
                                  <span className="w-3 h-3 rounded-full border border-red-400/25 border-t-red-300 animate-spin" />
                                ) : (
                                  <>
                                    <span
                                      className={`w-2 h-2 rounded-full ${canStopMcp ? 'group-hover:hidden' : ''}`}
                                      style={{ backgroundColor: p.isAlive ? '#888' : '#444' }}
                                    />
                                    {canStopMcp && (
                                      <Square
                                        size={11}
                                        fill="currentColor"
                                        stroke="none"
                                        className="hidden group-hover:block text-red-400"
                                      />
                                    )}
                                  </>
                                )}
                              </span>
                              <Tooltip content={p.command}>
                                <span className="min-w-0 truncate">{p.name}</span>
                              </Tooltip>
                              <span className={isStopping ? 'text-red-300/80' : 'text-[#777]'}>
                                {isStopping ? 'stopping' : `pid ${p.pid}`}
                              </span>
                              <span className="text-[#777]">{p.startTime}</span>
                              {statusLabel && !isStopping && <span className="text-[#777]">{statusLabel}</span>}
                            </div>
                          );
                        })}
                      </div>
                      <button
                        className="mt-2 flex h-7 items-center gap-1.5 rounded-md px-2 text-[11px] text-[#aaa] transition-colors hover:bg-white/[0.05] hover:text-[#ddd] cursor-pointer"
                        onClick={() => setMcpExpanded(false)}
                      >
                        <ChevronDown size={14} strokeWidth={2.4} />
                        Свернуть ({mcpProcesses.length})
                      </button>
                    </>
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
