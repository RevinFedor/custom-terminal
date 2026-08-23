import React, { startTransition, useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useState, useRef } from 'react';
import ReactDOM from 'react-dom';
import { selectFocusedProjectId, useWorkspaceStore } from '../../store/useWorkspaceStore';
import { useProjectsStore } from '../../store/useProjectsStore';
import { resolveTabTerminalPrimary, useUIStore } from '../../store/useUIStore';
import { terminalRegistry } from '../../utils/terminalRegistry';
import TabBar from './TabBar';
import TabSidebar from './TabSidebar';
import ProjectHome from './ProjectHome';
import TerminalArea, { type AgentLifecycleSummary } from './TerminalArea';
import FloatingTerminalFrame from './FloatingTerminalFrame';
import Timeline from './Timeline';
import '../../utils/sidebarBridge'; // Init window.electronAPI bridge
import Sidebar from './Sidebar';
import FilePreview from './FilePreview';
import { useSplitAttachRowHeight, PANE_HEADER_HEIGHT_VAR, SplitPaneAttachRow } from './SplitPaneChrome';
import SpaceStrip from './SpaceStrip';
import { EXPLORER_TOP_H } from '../../constants/layout';
import TabTaskPlanPanel from './TabTaskPlanPanel';
import HistoryPanel from './HistoryPanel';
import ClaudeControlBar from './ClaudeControlBar';
import { INBOX_PROJECT_ID, INBOX_PROJECT_NAME, getInboxProjectPath, isInboxProjectId } from '../../constants/systemProjects';
import { linkFileTab } from '../../utils/linkFileTab';
import { resolvePaneSurfaceHotkeyTabId } from '../../utils/paneSurfaceHotkeyTarget.mjs';
import { paneTabs } from '../../utils/splitPanesModel.mjs';
import { probeFiles } from '../../utils/missingFileTracker';
import { buildCodexRunPayload } from '../../utils/codexLaunch';
import { getHistoryAgentRuntime } from '../../utils/historyAgentRuntimes';
import {
  directoryChangeEventNames,
  planWorkingDirectoryChange,
} from '../../utils/workingDirectoryChange.mjs';
import { resolvePtyAgentOwner } from '../../utils/ptyAgentOwner.mjs';
import { useCodexSurfaceReadSessionId } from '../../hooks/useCodexSurfaceReadSessionId';
import { getCodexSurfaceReadSessionId } from '../../utils/codexSurfaceReadIdentityStore.mjs';

const { ipcRenderer } = window.require('electron');

// Helper to detect language from file extension
const detectLanguage = (ext: string): string | null => {
  const langMap: Record<string, string> = {
    '.js': 'javascript', '.jsx': 'javascript', '.ts': 'typescript', '.tsx': 'typescript',
    '.py': 'python', '.rb': 'ruby', '.java': 'java', '.go': 'go', '.rs': 'rust',
    '.c': 'c', '.cpp': 'cpp', '.h': 'c', '.hpp': 'cpp', '.cs': 'csharp',
    '.php': 'php', '.swift': 'swift', '.kt': 'kotlin', '.scala': 'scala',
    '.html': 'html', '.css': 'css', '.scss': 'scss', '.less': 'less',
    '.json': 'json', '.xml': 'xml', '.yaml': 'yaml', '.yml': 'yaml',
    '.md': 'markdown', '.mdx': 'markdown', '.sh': 'bash', '.bash': 'bash',
    '.sql': 'sql', '.graphql': 'graphql', '.vue': 'vue', '.svelte': 'svelte'
  };
  return langMap[ext.toLowerCase()] || null;
};

const path = window.require('path');

// Narrowest terminal column that still renders a usable agent TUI. Below this
// the pushed History panel downgrades to an overlay instead of squeezing the
// terminal into an unreadable strip.
const MIN_TERMINAL_COLUMN_WIDTH = 620;

type DirectoryChangePhase = 'idle' | 'selecting' | 'waiting' | 'stopping' | 'switching' | 'restarting';

const directoryChangeErrorText = (error: unknown): string => {
  const code = String((error as any)?.message || error || 'unknown');
  if (code.includes('terminal_has_unsent_input')) return 'В терминале есть неотправленный текст. Сначала отправьте или очистите его.';
  if (code.includes('shell_not_idle')) return 'Терминал сейчас занят другой командой. Дождитесь её завершения и повторите.';
  if (code.includes('process_lookup_failed')) return 'Не удалось безопасно подтвердить состояние терминала.';
  if (code.includes('cwd_change_proof_timeout')) return 'Терминал не подтвердил переход в выбранную папку.';
  if (code.includes('working_directory_unavailable')) return 'Выбранная папка больше недоступна.';
  return code;
};

const waitForAgentTurnToSettle = ({
  runtime,
  tabId,
  projectId,
}: {
  runtime: ReturnType<typeof getHistoryAgentRuntime>;
  tabId: string;
  projectId: string;
}) => new Promise<any>((resolve, reject) => {
  let settled = false;
  let checking = false;
  const events = directoryChangeEventNames(runtime.toolType);
  const cleanup = () => {
    for (const eventName of events) ipcRenderer.removeListener(eventName, onLifecycleEvent);
  };
  const finish = (callback: () => void) => {
    if (settled) return;
    settled = true;
    cleanup();
    callback();
  };
  const verify = async () => {
    if (settled || checking) return;
    checking = true;
    try {
      const presence = await runtime.getPresence(tabId, projectId);
      if (presence.status !== 'busy') finish(() => resolve(presence));
    } catch (error) {
      finish(() => reject(error));
    } finally {
      checking = false;
    }
  };
  function onLifecycleEvent(_event: unknown, payload: any) {
    const eventTabId = typeof payload === 'string' ? payload : payload?.tabId;
    if (eventTabId !== tabId) return;
    void verify();
  }
  for (const eventName of events) ipcRenderer.on(eventName, onLifecycleEvent);
  // Close the edge between the initial caller snapshot and listener install.
  void verify();
});

type WorkspaceProps = {
  processStatus: ReadonlyMap<string, boolean>;
  busyTabs: ReadonlyMap<string, boolean>;
  pasteBusyTabs: ReadonlyMap<string, boolean>;
  inheritedBusyTabIds: ReadonlySet<string>;
};

export default function Workspace({
  processStatus,
  busyTabs,
  pasteBusyTabs,
  inheritedBusyTabIds,
}: WorkspaceProps) {
  const sharedTabActivity = useMemo(
    () => ({ processStatus, busyTabs, pasteBusyTabs }),
    [processStatus, busyTabs, pasteBusyTabs],
  );
  // DEBUG: Track Workspace mount/unmount
  useEffect(() => {
    console.warn('[Workspace:MOUNT]');
    return () => {
      console.warn('[Workspace:UNMOUNT]');
    };
  }, []);

  // Header row height follows the chip's Settings-driven size — same number
  // the per-pane rows use, or the single-mode slot clips its own chip.
  const attachRowH = useSplitAttachRowHeight();

  // Use selectors to avoid rerenders on unrelated store changes
  const activeProjectId = useWorkspaceStore((s) => s.activeProjectId);
  const focusedProjectId = useWorkspaceStore(selectFocusedProjectId);
  const focusedCurrentView = useWorkspaceStore((s) => {
    const projectId = selectFocusedProjectId(s);
    return projectId ? (s.openProjects.get(projectId)?.currentView || 'terminal') : 'terminal';
  });
  const isInboxProject = isInboxProjectId(activeProjectId);
  const getActiveProject = useWorkspaceStore((s) => s.getActiveProject);
  const getSidebarState = useWorkspaceStore((s) => s.getSidebarState);
  const setSidebarOpen = useWorkspaceStore((s) => s.setSidebarOpen);
  const setSidebarExpandedDirs = useWorkspaceStore((s) => s.setSidebarExpandedDirs);
  const setSidebarScrollTop = useWorkspaceStore((s) => s.setSidebarScrollTop);
  const handleSidebarExpandedDirsChange = useCallback((expandedDirs: Record<string, boolean>) => {
    if (activeProjectId) setSidebarExpandedDirs(activeProjectId, expandedDirs);
  }, [activeProjectId, setSidebarExpandedDirs]);
  const handleSidebarScrollChange = useCallback((scrollTop: number) => {
    if (activeProjectId) setSidebarScrollTop(activeProjectId, scrollTop);
  }, [activeProjectId, setSidebarScrollTop]);
  const setOpenFilePath = useWorkspaceStore((s) => s.setOpenFilePath);
  const rewriteFilePathReferences = useWorkspaceStore((s) => s.rewriteFilePathReferences);
  // Subscribe to sidebarOpen so Workspace re-renders when sidebar toggles
  const sidebarOpenForRender = useWorkspaceStore((s) => {
    if (isInboxProjectId(s.activeProjectId)) return false;
    const p = s.activeProjectId ? s.openProjects.get(s.activeProjectId) : null;
    return p?.sidebarOpen ?? false;
  });
  const workspaceView = useWorkspaceStore((s) => s.view);
  const projects = useProjectsStore((s) => s.projects);

  // Use selectors to avoid rerenders on unrelated UIStore changes
  const filePreview = useUIStore((s) => s.filePreview);
  const openFilePreview = useUIStore((s) => s.openFilePreview);
  const closeFilePreview = useUIStore((s) => s.closeFilePreview);
  const notesPanelWidth = useUIStore((s) => s.notesPanelWidth);
  const historyPanelOpenTabs = useUIStore((s) => s.historyPanelOpenTabs);
  const historyPanelWidth = useUIStore((s) => s.historyPanelWidth);
  const setHistoryPanelOpen = useUIStore((s) => s.setHistoryPanelOpen);
  // Side terminal open-state: the SAME per-tab map the split panes use, so a
  // single-mode side terminal is visible to every consumer (Run after shift,
  // Terminal, hotkeys) exactly as it is in a split.
  const sideTerminalOpenTabs = useUIStore((s) => s.sideTerminalOpenTabs);
  const setSideTerminalOpen = useUIStore((s) => s.setSideTerminalOpen);
  // Deliberately NOT subscribing to timelineTreeModeTabs here: the two
  // consumers below read it imperatively (getState) inside event handlers.
  // A render subscription re-rendered the WHOLE Workspace on every expand/
  // collapse of the Timeline — inside the same click frame that was already
  // paying for the Timeline's own expansion.
  const setTimelineTreeMode = useUIStore((s) => s.setTimelineTreeMode);
  const sidebarWidth = useUIStore((s) => s.sidebarWidth);
  const sidebarFontSize = useUIStore((s) => s.sidebarFontSize);
  const historyPinnedSetting = useUIStore((s) => s.historyPinned);
  const sideTerminalWidth = useUIStore((s) => s.sideTerminalWidth);
  const timelinePinned = useUIStore((s) => s.timelinePinned);
  const setTabTerminalIsPrimary = useUIStore((s) => s.setTabTerminalIsPrimary);
  const setProjectView = useWorkspaceStore((s) => s.setProjectView);
  const viewingSubAgentTabId = useWorkspaceStore((s) => s.getActiveProject()?.viewingSubAgentTabId ?? null);
  const setViewingSubAgentTabId = useWorkspaceStore((s) => s.setViewingSubAgent);

  // Fine-grained selectors for session IDs — return primitives so Zustand detects changes
  // after in-place tab mutation + set({}). Without these, Workspace never re-renders on session change
  // because all other selectors return stable references (functions, same strings).
  const effectiveClaudeSessionId = useWorkspaceStore((s) => {
    const p = s.openProjects.get(s.activeProjectId!);
    if (!p) return null;
    const tabId = p.viewingSubAgentTabId || p.activeTabId;
    const tab = tabId ? p.tabs.get(tabId) : null;
    return tab?.claudeSessionId || null;
  });
  const effectiveGeminiSessionId = useWorkspaceStore((s) => {
    const p = s.openProjects.get(s.activeProjectId!);
    if (!p) return null;
    const tabId = p.viewingSubAgentTabId || p.activeTabId;
    const tab = tabId ? p.tabs.get(tabId) : null;
    return tab?.geminiSessionId || null;
  });
  const effectiveCodexSessionId = useWorkspaceStore((s) => {
    const p = s.openProjects.get(s.activeProjectId!);
    if (!p) return null;
    const tabId = p.viewingSubAgentTabId || p.activeTabId;
    const tab = tabId ? p.tabs.get(tabId) : null;
    return tab?.codexSessionId || null;
  });
  const effectiveCommandType = useWorkspaceStore((s) => {
    const p = s.openProjects.get(s.activeProjectId!);
    if (!p) return null;
    const tabId = p.viewingSubAgentTabId || p.activeTabId;
    const tab = tabId ? p.tabs.get(tabId) : null;
    return tab?.commandType || null;
  });
  const effectiveTabType = useWorkspaceStore((s) => {
    const p = s.openProjects.get(s.activeProjectId!);
    if (!p) return null;
    const tabId = p.viewingSubAgentTabId || p.activeTabId;
    const tab = tabId ? p.tabs.get(tabId) : null;
    return tab?.tabType || null;
  });
  const effectiveAiBusy = useWorkspaceStore((s) => {
    const p = s.openProjects.get(s.activeProjectId!);
    if (!p) return false;
    const tabId = p.viewingSubAgentTabId || p.activeTabId;
    const tab = tabId ? p.tabs.get(tabId) : null;
    return tab?.aiBusy === true;
  });
  const [showSearch, setShowSearch] = useState(false);
  const [searchText, setSearchText] = useState('');
  const [searchResults, setSearchResults] = useState({ resultIndex: 0, resultCount: 0 });
  const [commandRunningByTab, setCommandRunningByTab] = useState<Map<string, boolean>>(() => new Map());
  const [agentPasteBusyByTab, setAgentPasteBusyByTab] = useState<Map<string, boolean>>(() => new Map());
  const commandStateSeqRef = useRef(0);
  const [historyControlsHeight, setHistoryControlsHeight] = useState(0);
  const [agentLifecycleStatus, setAgentLifecycleStatus] = useState<AgentLifecycleSummary | null>(null);
  const [directoryChangePhase, setDirectoryChangePhase] = useState<DirectoryChangePhase>('idle');
  const directoryChangeOperationRef = useRef(0);
  const searchInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const handlePasteBusy = (_event: unknown, data: { tabId?: string; busy?: boolean } = {}) => {
      if (!data.tabId) return;
      setAgentPasteBusyByTab((previous) => {
        const nextBusy = data.busy === true;
        if ((previous.get(data.tabId!) === true) === nextBusy) return previous;
        const next = new Map(previous);
        if (nextBusy) next.set(data.tabId!, true);
        else next.delete(data.tabId!);
        return next;
      });
    };
    ipcRenderer.on('claude:paste-busy', handlePasteBusy);
    return () => ipcRenderer.removeListener('claude:paste-busy', handlePasteBusy);
  }, []);
  // Viewport width guard for the pushed side panel. A TUI agent draws to the
  // size it was told, so squeezing the terminal below a workable column makes
  // its own output unreadable — below the threshold the panel overlays
  // instead, leaving the terminal at full width underneath.
  const [viewportWidth, setViewportWidth] = useState(() => (
    typeof window === 'undefined' ? 1600 : window.innerWidth
  ));
  useEffect(() => {
    const onResize = () => setViewportWidth(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const activeProject = getActiveProject();
  const currentProject = activeProjectId
    ? (projects[activeProjectId] || (isInboxProject ? {
        id: INBOX_PROJECT_ID,
        name: INBOX_PROJECT_NAME,
        path: getInboxProjectPath(),
        icon: null,
      } : activeProject ? {
        id: activeProject.projectId,
        name: path.basename(activeProject.projectPath || '') || 'Project',
        path: activeProject.projectPath,
        icon: null,
      } : null))
    : null;

  // Per-project currentView
  const currentView = activeProject?.currentView || 'terminal';

  const handleLinkFileToTab = useCallback(async (filePath: string, targetTabId: string) => {
    const result = await linkFileTab(filePath, targetTabId);
    useUIStore.getState().showToast(
      result.reused ? `${path.basename(filePath)} already linked` : `Linked ${path.basename(filePath)}`,
      result.reused ? 'info' : 'success',
    );
  }, []);

  const handleSidebarPathChanged = useCallback((oldPath: string, newPath: string) => {
    rewriteFilePathReferences(oldPath, newPath);
    const preview = useUIStore.getState().filePreview;
    if (!preview?.path || (preview.path !== oldPath && !preview.path.startsWith(oldPath + '/'))) return;
    useUIStore.getState().openFilePreview({
      ...preview,
      path: newPath + preview.path.slice(oldPath.length),
    });
  }, [rewriteFilePathReferences]);

  useEffect(() => {
    const onTransferred = (_event: unknown, transfer: { oldPath?: string; newPath?: string } = {}) => {
      if (!transfer.oldPath || !transfer.newPath || transfer.oldPath === transfer.newPath) return;
      handleSidebarPathChanged(transfer.oldPath, transfer.newPath);
    };
    ipcRenderer.on('gt-editor-transfer:committed', onTransferred);
    return () => ipcRenderer.removeListener('gt-editor-transfer:committed', onTransferred);
  }, [handleSidebarPathChanged]);

  // Get active tab early for process checking
  const activeTab = activeProject?.activeTabId
    ? activeProject.tabs.get(activeProject.activeTabId)
    : null;

  // Auto-switch to Home when all tabs are closed
  useEffect(() => {
    if (activeProject && activeProjectId && activeProject.tabs.size === 0 && currentView === 'terminal') {
      setProjectView(activeProjectId, 'home');
    }
  }, [activeProject?.tabs.size, currentView, activeProjectId, setProjectView]);

  // Reset viewingSubAgentTabId if the viewed tab was closed or detached
  const viewedTabParentId = viewingSubAgentTabId && activeProject
    ? activeProject.tabs.get(viewingSubAgentTabId)?.parentTabId
    : undefined;
  useEffect(() => {
    if (!viewingSubAgentTabId || !activeProject) return;
    const tab = activeProject.tabs.get(viewingSubAgentTabId);
    if (!tab || !tab.parentTabId) {
      setViewingSubAgentTabId(null);
    }
  }, [viewingSubAgentTabId, viewedTabParentId, activeProject?.tabs.size]);

  const activeTabId = activeProject?.activeTabId;

  // effectiveTab: when viewing a sub-agent, resolve to that tab; otherwise fallback to activeTab
  const effectiveTab = useMemo(() => {
    if (viewingSubAgentTabId && activeProject) {
      const subTab = activeProject.tabs.get(viewingSubAgentTabId);
      if (subTab) return subTab;
    }
    return activeTab;
  }, [viewingSubAgentTabId, activeProject, activeTab]);
  const effectiveCodexReadSessionId = useCodexSurfaceReadSessionId(
    effectiveCommandType === 'codex' ? effectiveTab?.id : null,
  );
  const effectiveCodexSurfaceSessionId = effectiveCodexSessionId || effectiveCodexReadSessionId;
  const terminalIsPrimary = useUIStore((state) => (
    effectiveTab?.id ? resolveTabTerminalPrimary(state, effectiveTab.id) : false
  ));
  // Derived from the per-tab map so switching tabs shows THIS tab's state
  // rather than whatever the previously focused tab last reported.
  const isCommandRunning = effectiveTab?.id
    ? commandRunningByTab.get(effectiveTab.id) === true
    : false;
  const effectivePtyOwner = resolvePtyAgentOwner({
    commandType: effectiveCommandType,
    claudeSessionId: effectiveClaudeSessionId,
    codexSessionId: effectiveCodexSurfaceSessionId,
  });
  const primaryHistoryTool = effectivePtyOwner;
  // A tab that owns the History ↔ terminal surface pair. Which of the two
  // holds the center is this tab's user choice. Both layouts render the SAME
  // HistoryPanel and the SAME xterm; only their presentation changes.
  const agentSurfacePairAvailable = !!effectiveTab
    && currentView === 'terminal'
    && effectiveTabType !== 'claude-sdk'
    && effectiveTabType !== 'file'
    && !filePreview
    && !!primaryHistoryTool;
  // Split workspace owns its History/terminal presentation per pane. Global
  // History geometry remains disabled here so it cannot cover neighbouring
  // panes; the focused pane mounts the one live embedded History instance.
  const splitActiveLayout = useWorkspaceStore((s) => s.splitPanes.length > 0);
  // Projects that have a tab in a pane but are NOT the one the sidebar shows.
  // Each needs its own (hidden) list mounted as the owner of its context menu.
  // Selector returns a joined STRING, never a new array — an array literal is a
  // new reference every render and would re-render the whole workspace on any
  // store write (Fingerprint Pattern, fix-performance-lags.md).
  const paneMenuOwnerKey = useWorkspaceStore((s) => {
    const sidebarPid = s.focusedProjectId || s.activeProjectId;
    const ids = new Set<string>();
    for (const pane of s.splitPanes) {
      // Every project in the STRIP, not just the shown chip's: a right-click on
      // a parked chip opens the same menu, and its owner must be mounted or the
      // menu silently does not appear.
      for (const entry of paneTabs(pane) as Array<{ projectId: string }>) {
        if (entry.projectId && entry.projectId !== sidebarPid && s.openProjects.has(entry.projectId)) {
          ids.add(entry.projectId);
        }
      }
    }
    return Array.from(ids).sort().join('|');
  });
  const paneMenuOwnerProjectIds = useMemo(
    () => (paneMenuOwnerKey ? paneMenuOwnerKey.split('|') : []),
    [paneMenuOwnerKey],
  );
  const historyIsPrimary = agentSurfacePairAvailable && !terminalIsPrimary && !splitActiveLayout;
  // Terminal-primary keeps History reachable as the side panel; it is the
  // active input surface there, so grab/dictation/task-plan still target it.
  const historyIsAgentSidePanel = agentSurfacePairAvailable && terminalIsPrimary && !splitActiveLayout;
  const focusedHistorySurfaceVisible = agentSurfacePairAvailable && !terminalIsPrimary;
  // Pin is the user's preference; a viewport too narrow for both columns
  // downgrades it to overlay for this render only, without touching the
  // stored setting — widening the window restores the pushed layout.
  //
  // ONE toggle, one meaning: "the side panel opened by Cmd+] is a column, not
  // an overlay". Which surface is in that slot — transcript or terminal —
  // depends on the layout and is not the user's question; the pin used to
  // apply to the transcript only, so the same gesture behaved differently
  // depending on which way round the tab happened to be.
  const terminalColumnFloor = MIN_TERMINAL_COLUMN_WIDTH + sidebarWidth;
  const historyPinned = historyPinnedSetting
    && viewportWidth - historyPanelWidth >= terminalColumnFloor;
  const sideTerminalPinned = historyPinnedSetting
    && viewportWidth - sideTerminalWidth >= terminalColumnFloor;
  // Single mode's side terminal is THE SAME per-tab flag the split panes use.
  // It used to be local component state, so nothing outside Workspace could see
  // it: Run after computed its shift from the store and therefore never moved in
  // single mode, while the identical gesture worked in a split. One map, one
  // meaning, every consumer reads it.
  const floatingTerminalOpen = !!(effectiveTab?.id && sideTerminalOpenTabs[effectiveTab.id]);
  const promptQueuePortalHostId = 'workspace-prompt-queue-host';
  const dockedComposerHostId = 'workspace-docked-composer-host';

  const toggleFloatingTerminal = useCallback(() => {
    const tabId = effectiveTab?.id;
    if (!tabId) return;
    if (floatingTerminalOpen) {
      setShowSearch(false);
      setSearchText('');
      setSearchResults({ resultIndex: 0, resultCount: 0 });
      terminalRegistry.clearSearch(tabId);
    }
    setSideTerminalOpen(tabId, !floatingTerminalOpen);
  }, [effectiveTab?.id, floatingTerminalOpen, setSideTerminalOpen]);

  // Terminal-primary counterpart of the floating-terminal toggle: the same
  // control in the composer's top line, pointing at the other surface.
  const toggleAgentSideHistory = useCallback(() => {
    const tabId = effectiveTab?.id;
    if (!tabId) return;
    const currentOpen = useUIStore.getState().historyPanelOpenTabs[tabId] ?? false;
    setHistoryPanelOpen(tabId, !currentOpen);
  }, [effectiveTab?.id, setHistoryPanelOpen]);

  const closeFloatingTerminal = useCallback(() => {
    const tabId = effectiveTab?.id;
    if (!tabId) return;
    setSideTerminalOpen(tabId, false);
    setShowSearch(false);
    setSearchText('');
    setSearchResults({ resultIndex: 0, resultCount: 0 });
    terminalRegistry.clearSearch(tabId);
  }, [effectiveTab?.id, setSideTerminalOpen]);

  // Swap which surface owns the center. Presentation only: the xterm keeps its
  // buffer/PTY and History keeps its owner, rows and draft — the frame around
  // them changes shape. Terminal-primary always shows History as the side
  // panel, so the user never lands in a layout with no conversation surface.
  const swapPrimarySurface = useCallback((explicitTabId?: string) => {
    // Same rule as Cmd+]: the surface pair belongs to a PANE, and the focused
    // pane's tab is not always the active one (a tab can be put into a pane
    // without taking focus). Callers that already know the tab pass it in; the
    // keyboard path resolves it from the focused pane.
    const tabId = explicitTabId || effectiveTab?.id;
    if (!agentSurfacePairAvailable || !tabId) return;
    const next = !resolveTabTerminalPrimary(useUIStore.getState(), tabId);
    if (next) {
      // Entering terminal-primary: the terminal becomes the center, so the
      // floating window flag must not survive as a second "open" source.
      setSideTerminalOpen(tabId, false);
      // The transcript panel is NOT force-opened here. Center ownership and
      // "transcript visible" are separate per-tab choices; opening it stays
      // the user's action (Cmd+] / the button).
    } else {
      // Back to History-primary: search belonged to the terminal, and the
      // terminal returns to its collapsed floating state. The side panel flag
      // is reset too, so a later Cmd+] in the centered layout opens the
      // Timeline-style panel from a known state instead of toggling it shut.
      setShowSearch(false);
      setSearchText('');
      setSearchResults({ resultIndex: 0, resultCount: 0 });
      terminalRegistry.clearSearch(tabId);
      setHistoryPanelOpen(tabId, false);
    }
    console.warn('[Workspace:Surface] swap terminalIsPrimary → ' + next
      + ' tab=' + tabId.slice(-8));
    setTabTerminalIsPrimary(tabId, next);
  }, [agentSurfacePairAvailable, effectiveTab?.id, setHistoryPanelOpen, setTabTerminalIsPrimary]);

  const handleLifecycleStatusChange = useCallback((next: AgentLifecycleSummary | null) => {
    setAgentLifecycleStatus((current) => {
      if (!current && !next) return current;
      if (current && next
        && current.tabId === next.tabId
        && current.kind === next.kind
        && current.title === next.title
        && current.description === next.description
        && current.detail === next.detail
        && current.sessionId === next.sessionId
        && current.spinner === next.spinner
        && current.dismissLabel === next.dismissLabel
        && current.onDismiss === next.onDismiss
        && current.retryLabel === next.retryLabel
        && current.onRetry === next.onRetry) return current;
      return next;
    });
  }, []);

  const handleHistoryControlsHeight = useCallback((height: number) => {
    setHistoryControlsHeight((current) => current === height ? current : height);
  }, []);
  const projectRootPath = useMemo(() => {
    const projectPath = currentProject?.path || '';
    return projectPath && !projectPath.startsWith('__unset__') ? projectPath : '';
  }, [currentProject?.path]);
  const rawExplorerPath = useMemo(() => {
    if (!effectiveTab) return projectRootPath;
    if (effectiveTab.tabType === 'file') {
      const parentCwd = effectiveTab.visualParentTabId
        ? activeProject?.tabs.get(effectiveTab.visualParentTabId)?.cwd
        : '';
      return parentCwd || projectRootPath || effectiveTab.cwd || '';
    }
    return effectiveTab.cwd || projectRootPath;
  }, [
    activeProject,
    effectiveTab?.id,
    effectiveTab?.cwd,
    effectiveTab?.tabType,
    effectiveTab?.visualParentTabId,
    projectRootPath,
  ]);
  const [resolvedExplorerPath, setResolvedExplorerPath] = useState('');
  useEffect(() => {
    const candidates: string[] = [];
    const pushCandidate = (candidate?: string | null) => {
      if (!candidate || candidate.startsWith('__unset__') || candidates.includes(candidate)) return;
      candidates.push(candidate);
    };
    pushCandidate(rawExplorerPath);
    pushCandidate(projectRootPath);

    if (!sidebarOpenForRender) {
      setResolvedExplorerPath(candidates[0] || '');
      return;
    }
    if (candidates.length === 0) {
      setResolvedExplorerPath('');
      return;
    }

    let cancelled = false;
    (async () => {
      for (const candidate of candidates) {
        try {
          const exists = await ipcRenderer.invoke('app:check-path-exists', candidate);
          if (cancelled) return;
          if (exists) {
            setResolvedExplorerPath(candidate);
            return;
          }
        } catch {}
      }
      if (!cancelled) setResolvedExplorerPath(candidates[0] || '');
    })();

    return () => { cancelled = true; };
  }, [rawExplorerPath, projectRootPath, sidebarOpenForRender]);
  const activeFileTab = currentView === 'terminal' && effectiveTab?.tabType === 'file'
    ? effectiveTab
    : null;
  const activeFileTabPath = activeFileTab?.filePath || null;

  // Track effective session state transitions for debugging
  const prevEffectiveRef = useRef({ tab: effectiveTab?.id, claude: effectiveClaudeSessionId, gemini: effectiveGeminiSessionId, codex: effectiveCodexSessionId, cmd: effectiveCommandType });
  useEffect(() => {
    const prev = prevEffectiveRef.current;
    const cur = { tab: effectiveTab?.id, claude: effectiveClaudeSessionId, gemini: effectiveGeminiSessionId, codex: effectiveCodexSessionId, cmd: effectiveCommandType };
    if (prev.tab !== cur.tab || prev.claude !== cur.claude || prev.gemini !== cur.gemini || prev.codex !== cur.codex || prev.cmd !== cur.cmd) {
      const hadSession = (prev.cmd === 'claude' && prev.claude) || (prev.cmd === 'gemini' && prev.gemini) || (prev.cmd === 'codex' && prev.codex);
      const hasSession = (cur.cmd === 'claude' && cur.claude) || (cur.cmd === 'gemini' && cur.gemini) || (cur.cmd === 'codex' && cur.codex);
      if (hadSession && !hasSession) {
        console.warn('[Workspace:Guard] Session LOST → hotkeys disabled | tab=' + (cur.tab || 'null') + ' cmdType=' + cur.cmd + ' claude=' + (cur.claude ? cur.claude.substring(0, 8) : 'null') + ' gemini=' + (cur.gemini ? cur.gemini.substring(0, 8) : 'null') + ' codex=' + (cur.codex ? cur.codex.substring(0, 8) : 'null') + ' prev.tab=' + (prev.tab || 'null') + ' prev.cmd=' + prev.cmd);
      }
      prevEffectiveRef.current = cur;
    }
  });

  // Clear search when switching between parent tab and sub-agent view
  useEffect(() => {
    setSearchText('');
    setSearchResults({ resultIndex: 0, resultCount: 0 });
    if (activeTab?.id) terminalRegistry.clearSearch(activeTab.id);
  }, [viewingSubAgentTabId]);

  // Linked file tabs are real tabs in TabSidebar but render through the same
  // FilePreview surface as Sidebar/Cmd-click file opens. The preview belongs to
  // the active file tab only while that tab stays active.
  // Split mode: a pane hosts its own SplitFilePane — the window-wide overlay
  // would cover the neighbouring panes, so it must stay closed.
  const splitActiveForPreview = useWorkspaceStore((s) => s.splitPanes.length > 0);
  useEffect(() => {
    if (!activeProjectId) return;

    if (!activeFileTabPath || !activeFileTab?.id || splitActiveForPreview) {
      const currentPreview = useUIStore.getState().filePreview;
      if (currentPreview?.source === 'tab') {
        closeFilePreview();
      }
      return;
    }

    const currentPreview = useUIStore.getState().filePreview;
    if (
      currentPreview?.source === 'tab' &&
      currentPreview.sourceTabId === activeFileTab.id &&
      currentPreview.path === activeFileTabPath
    ) {
      return;
    }

    let cancelled = false;
    (async () => {
      try {
        const result = await ipcRenderer.invoke('file:read', activeFileTabPath);
        if (!cancelled && result?.success) {
          const ext = path.extname(activeFileTabPath).toLowerCase();
          const language = detectLanguage(ext);
          openFilePreview({
            path: activeFileTabPath,
            content: result.content,
            language,
            source: 'tab',
            sourceTabId: activeFileTab.id,
          });
        } else if (!cancelled) {
          // Vanished file: refresh the shared verdict so the sidebar/switcher
          // icons flip red immediately, and keep the message human.
          probeFiles([activeFileTabPath], true);
          useUIStore.getState().showToast('Файл не найден на диске (перемещён или удалён)', 'warning');
        }
      } catch (e: any) {
        if (!cancelled) {
          useUIStore.getState().showToast(`File preview: ${e?.message || 'failed to read file'}`, 'error');
        }
      }
    })();

    return () => { cancelled = true; };
  }, [activeProjectId, activeFileTabPath, activeFileTab?.id, currentView, closeFilePreview, openFilePreview, splitActiveForPreview]);

  // Sync file preview with sidebar state (project switch + sidebar open/close)
  const previewSyncProjectIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (!activeProjectId) return;

    const { openFilePath } = getSidebarState(activeProjectId);
    const { sidebarPersistFile } = useUIStore.getState();
    // Arriving in a project is not the same event as the user closing something
    // inside it. The distinction decides both whether the remembered file may be
    // dropped and whether it should be restored.
    const projectChanged = previewSyncProjectIdRef.current !== activeProjectId;
    previewSyncProjectIdRef.current = activeProjectId;

    if (!sidebarOpenForRender) {
      // Sidebar closed — hide file preview. When persist=false, also drop the saved
      // path so the next sidebar open starts clean (just the tree, no file).
      if (filePreview && filePreview.source !== 'tab') closeFilePreview();
      // ...but only when the user actually closed it. Landing in a project whose
      // sidebar happens to be closed would otherwise erase the file that project
      // had open, exactly like the sidebar-open flag used to be erased.
      if (!sidebarPersistFile && openFilePath && !projectChanged) {
        setOpenFilePath(activeProjectId, null);
      }
      return;
    }

    // Sidebar open. `sidebarPersistFile` governs the close→reopen cycle: with it
    // off, closing the sidebar already cleared the path above, so there is
    // nothing left to restore. Returning to a project never cleared anything, so
    // a file that survived there is restored regardless of the setting.
    if (!sidebarPersistFile && !projectChanged) {
      if (filePreview) {
        console.warn('[SidebarPreviewSync] persist-off-keep-current', {
          previewPath: filePreview.path,
          previewSource: filePreview.source || null,
          openFilePath,
        });
      }
      return;
    }
    if (filePreview?.source === 'tab') return;
    if (filePreview && filePreview.path !== openFilePath) {
      closeFilePreview();
    }
    if (openFilePath && (!filePreview || filePreview.path !== openFilePath)) {
      (async () => {
        try {
          const result = await ipcRenderer.invoke('file:read', openFilePath);
          if (result.success) {
            const ext = path.extname(openFilePath).toLowerCase();
            const language = detectLanguage(ext);
            openFilePreview({ path: openFilePath, content: result.content, language, source: 'sidebar' });
          }
        } catch (e) {
          console.error('[Workspace] Failed to restore file preview:', e);
        }
      })();
    }
  }, [activeProjectId, sidebarOpenForRender, filePreview, closeFilePreview, getSidebarState, openFilePreview, setOpenFilePath]);

  // Click outside the sidebar closes it (when toggle is on). Captures mousedown
  // on window so we don't fight terminal canvas pointer-events; check whether the
  // event target lives inside [data-sidebar-portal]. FilePreview belongs to this
  // overlay flow: selecting text or pressing preview toolbar buttons must not
  // close the sidebar first, because sidebar close also hides sidebar-sourced
  // previews in the sync effect below.
  useEffect(() => {
    if (!sidebarOpenForRender || !activeProjectId) return;
    const onDown = (e: MouseEvent) => {
      const { sidebarOverlayCloseOnClickOutside } = useUIStore.getState();
      if (!sidebarOverlayCloseOnClickOutside) return;
      const target = e.target instanceof Element ? e.target as HTMLElement : null;
      if (!target) return;
      if (target.closest('[data-sidebar-toggle-trigger]')) return;
      if (target.closest('[data-run-after-picker-menu], [data-run-after-picker-portal]')) return;
      // Leaving the project is not "click outside to dismiss". Sidebar open
      // state belongs to the project, so switching to another project or to the
      // dashboard must not erase it on the way out — otherwise coming back
      // always lands on a closed sidebar, and the false is persisted to SQLite.
      if (target.closest('[data-project-navigation]')) return;
      const sidebarEl = document.querySelector('[data-sidebar-portal]') as HTMLElement | null;
      const sidebarRect = sidebarEl?.getBoundingClientRect();
      const insideSidebarDom = !!target.closest('[data-sidebar-portal]');
      const insideSidebarRect = !!sidebarRect &&
        e.clientX >= sidebarRect.left &&
        e.clientX <= sidebarRect.right &&
        e.clientY >= sidebarRect.top &&
        e.clientY <= sidebarRect.bottom;
      const insideFilePreview = !!target.closest('[data-file-preview-root]');
      const targetLabel = `${target.tagName.toLowerCase()}${target.className ? '.' + String(target.className).replace(/\s+/g, '.') : ''}`;
      if (insideSidebarDom || insideSidebarRect || insideFilePreview) {
        console.warn('[SidebarOverlayClose] keep-open', {
          reason: insideFilePreview ? 'inside-file-preview' : (insideSidebarDom ? 'inside-sidebar-dom' : 'inside-sidebar-rect'),
          target: targetLabel,
          x: e.clientX,
          y: e.clientY,
          insideFilePreview,
          rect: sidebarRect ? { left: sidebarRect.left, right: sidebarRect.right, top: sidebarRect.top, bottom: sidebarRect.bottom } : null,
        });
        return;
      }
      console.warn('[SidebarOverlayClose] close', {
        target: targetLabel,
        x: e.clientX,
        y: e.clientY,
        insideFilePreview,
      });
      setSidebarOpen(activeProjectId, false);
    };
    window.addEventListener('mousedown', onDown, true);
    return () => window.removeEventListener('mousedown', onDown, true);
  }, [sidebarOpenForRender, activeProjectId]);

  // Unpinned expanded Timeline is an overlay over the terminal. A click outside
  // Timeline should return the workspace to the collapsed rail, but clicking
  // the StatusBar pin must be allowed to convert the open overlay into pinned
  // layout without the mousedown closing it first.
  useEffect(() => {
    if (workspaceView !== 'workspace' || currentView !== 'terminal') return;
    if (!effectiveTab?.id || timelinePinned) return;
    const onDown = (e: MouseEvent) => {
      const tabId = effectiveTab.id;
      if (!useUIStore.getState().timelineTreeModeTabs[tabId]) return;
      const target = e.target as HTMLElement | null;
      if (!target) return;
      if (target.closest([
        '[data-timeline]',
        '[data-timeline-context-menu]',
        '[data-cmd-hover-popover]',
        '[data-history-timeline-pin-toggle]',
      ].join(','))) return;
      setTimelineTreeMode(tabId, false);
    };
    window.addEventListener('mousedown', onDown, true);
    return () => window.removeEventListener('mousedown', onDown, true);
  }, [workspaceView, currentView, effectiveTab?.id, timelinePinned, setTimelineTreeMode]);

  // Listen for OSC 133 command lifecycle events (Shell Integration).
  //
  // The flag is per-tab even though only the effective tab renders it: events
  // for background tabs used to be discarded outright, so a tab that started a
  // command while unfocused came back looking idle. The map keeps every tab's
  // last known state; the derived boolean below is what the UI consumes.
  useEffect(() => {
    if (!effectiveTab?.id) return;
    const boundTabId = effectiveTab.id;
    // Generation guard for the async initial read: on a fast A→B→C switch the
    // reply for an earlier tab could otherwise land as the current tab's state.
    const requestGeneration = ++commandStateSeqRef.current;

    const handleCommandStarted = (_: any, data: { tabId: string }) => {
      if (!data?.tabId) return;
      setCommandRunningByTab((prev) => (prev.get(data.tabId) === true
        ? prev
        : new Map(prev).set(data.tabId, true)));
    };

    const handleCommandFinished = (_: any, data: { tabId: string; exitCode: number }) => {
      if (!data?.tabId) return;
      setCommandRunningByTab((prev) => (prev.get(data.tabId) === false
        ? prev
        : new Map(prev).set(data.tabId, false)));
    };

    ipcRenderer.on('terminal:command-started', handleCommandStarted);
    ipcRenderer.on('terminal:command-finished', handleCommandFinished);

    // Get initial state
    ipcRenderer.invoke('terminal:getCommandState', {
      tabId: boundTabId,
      caller: 'Workspace.effectiveTabSync',
      expectedProcess: 'codex',
      allowProcessTreeLookup: effectiveCommandType === 'codex' || !!effectiveCodexSessionId,
    }).then((state: any) => {
      if (requestGeneration !== commandStateSeqRef.current) return;
      const running = state?.isRunning || false;
      setCommandRunningByTab((prev) => (prev.get(boundTabId) === running
        ? prev
        : new Map(prev).set(boundTabId, running)));
    });

    return () => {
      ipcRenderer.removeListener('terminal:command-started', handleCommandStarted);
      ipcRenderer.removeListener('terminal:command-finished', handleCommandFinished);
    };
  }, [effectiveTab?.id, effectiveCommandType, effectiveCodexSessionId]);

  // Handle resize callback for terminal refit
  const handleResize = useCallback(() => {
    // Terminal will auto-refit via ResizeObserver
  }, []);

  // CMD+] / Option+] hotkeys to toggle history panel
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (workspaceView !== 'workspace') return;
      if ((e.metaKey || e.altKey) && e.code === 'BracketRight') {
        const shortcut = e.metaKey ? 'CMD+]' : 'OPT+]';
        // The shortcut belongs to the FOCUSED PANE, and its tab is not always
        // the active one: the pane header's recent-tabs list puts a tab into a
        // pane WITHOUT moving focus or the centre. Measured on the report
        // (21:43 UTC): every press toggled the neighbouring pane's tab while
        // the pane in front of the user did nothing.
        const paneTabId = resolvePaneSurfaceHotkeyTabId({
          panes: useWorkspaceStore.getState().splitPanes,
          focusedIndex: useWorkspaceStore.getState().splitFocusedIndex,
          activeTabId: effectiveTab?.id || null,
        });
        const paneTab = paneTabId
          ? useWorkspaceStore.getState().openProjects.get(
            useWorkspaceStore.getState().splitPanes.find((p) => p.tabId === paneTabId)?.projectId
            || activeProjectId || '',
          )?.tabs.get(paneTabId)
          : null;
        const target = paneTab || effectiveTab;
        const targetCodexReadSessionId = target?.commandType === 'codex'
          ? getCodexSurfaceReadSessionId(target.id)
          : null;
        const hasSession = target
          ? (target.claudeSessionId || target.geminiSessionId || target.codexSessionId || targetCodexReadSessionId)
          : null;
        if (!target?.id || !hasSession) {
          console.warn('[Workspace:Hotkey] ' + shortcut + ' BLOCKED: target=' + (target?.id || 'null') + ' activeTab=' + (effectiveTab?.id || 'null') + ' claudeSession=' + (target?.claudeSessionId ? String(target.claudeSessionId).substring(0, 8) : 'null') + ' geminiSession=' + (target?.geminiSessionId ? String(target.geminiSessionId).substring(0, 8) : 'null') + ' codexSession=' + (target?.codexSessionId ? String(target.codexSessionId).substring(0, 8) : 'null') + ' codexRead=' + (targetCodexReadSessionId ? targetCodexReadSessionId.substring(0, 8) : 'null'));
          return;
        }
        const targetId = target.id;
        e.preventDefault();
        // In a split pane the shortcut opens THE OTHER surface of that pane,
        // whichever it is — symmetric by design, so the key never feels dead:
        //   transcript-primary → the pane's side TERMINAL,
        //   terminal-primary   → the pane's side TRANSCRIPT.
        // Only the first half existed, which is why "history does not work"
        // in a terminal pane. Both go through the pane's own per-tab flags,
        // not the single-mode ones.
        if (splitActiveLayout) {
          const ui = useUIStore.getState();
          const paneTerminalPrimary = resolveTabTerminalPrimary(ui, targetId);
          if (paneTerminalPrimary) {
            const currentOpen = ui.historyPanelOpenTabs[targetId] ?? false;
            console.warn('[Workspace:Hotkey] ' + shortcut + ' toggle side history (split): tabId=' + targetId.substring(targetId.length - 8) + ' ' + currentOpen + ' → ' + !currentOpen);
            setHistoryPanelOpen(targetId, !currentOpen);
            return;
          }
          const currentOpen = ui.sideTerminalOpenTabs[targetId] ?? false;
          console.warn('[Workspace:Hotkey] ' + shortcut + ' toggle side terminal (split): tabId=' + targetId.substring(targetId.length - 8) + ' ' + currentOpen + ' → ' + !currentOpen);
          ui.setSideTerminalOpen(targetId, !currentOpen);
          return;
        }
        // Single mode, same symmetry as a pane: the shortcut opens THE OTHER
        // surface of the current layout.
        //   transcript-primary → the side TERMINAL (was an early `return`, so
        //                        the key did nothing at all in chat mode),
        //   terminal-primary   → the side TRANSCRIPT.
        if (historyIsPrimary) {
          console.warn('[Workspace:Hotkey] ' + shortcut + ' toggle floating terminal: tabId=' + targetId.substring(targetId.length - 8) + ' ' + floatingTerminalOpen + ' → ' + !floatingTerminalOpen);
          toggleFloatingTerminal();
          return;
        }
        const currentOpen = useUIStore.getState().historyPanelOpenTabs[targetId] ?? false;
        console.warn('[Workspace:Hotkey] ' + shortcut + ' toggle history: tabId=' + targetId.substring(targetId.length - 8) + ' ' + currentOpen + ' → ' + !currentOpen);
        setHistoryPanelOpen(targetId, !currentOpen);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [workspaceView, historyIsPrimary, floatingTerminalOpen, toggleFloatingTerminal, splitActiveLayout, effectiveTab?.id, effectiveClaudeSessionId, effectiveGeminiSessionId, effectiveCodexSessionId, effectiveCodexReadSessionId, effectiveCommandType, setHistoryPanelOpen]);

  // CMD+[ / Option+[ — swap the center surface (History ↔ terminal).
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (workspaceView !== 'workspace') return;
      if ((e.metaKey || e.altKey) && e.code === 'BracketLeft') {
        if (!agentSurfacePairAvailable) return;
        e.preventDefault();
        // The focused pane's tab, for the same reason as Cmd+] above.
        const ws = useWorkspaceStore.getState();
        swapPrimarySurface(resolvePaneSurfaceHotkeyTabId({
          panes: ws.splitPanes,
          focusedIndex: ws.splitFocusedIndex,
          activeTabId: effectiveTab?.id || null,
        }) || undefined);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [workspaceView, agentSurfacePairAvailable, swapPrimarySurface, effectiveTab?.id]);

  // Double-tap ArrowDown — jump BOTH surfaces to their newest content, from
  // anywhere in the app. Aiming at the small floating arrow button is the
  // annoying part; the keyboard shortcut removes it. Single ArrowDown keeps
  // its normal meaning everywhere (caret movement, TUI history, list
  // navigation) — only the fast second press within the window triggers this,
  // and it never fires while the user is typing into a text field.
  useEffect(() => {
    if (workspaceView !== 'workspace' || currentView !== 'terminal') return;
    const DOUBLE_TAP_MS = 400;
    let lastTapAt = 0;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'ArrowDown') return;
      // Modifier chords belong to the surfaces themselves (Cmd+ArrowDown is
      // already terminal scroll-to-bottom); repeats are a held key, not taps.
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || e.repeat) return;
      const target = e.target as HTMLElement | null;
      // Typing surfaces own ArrowDown: composer, search inputs, editors, and
      // the xterm textarea all use it for their own navigation.
      if (target?.closest('input, textarea, select, [contenteditable="true"], .xterm')) {
        lastTapAt = 0;
        return;
      }
      const now = e.timeStamp;
      if (lastTapAt && now - lastTapAt <= DOUBLE_TAP_MS) {
        lastTapAt = 0;
        const tabId = effectiveTab?.id;
        if (!tabId) return;
        e.preventDefault();
        // Both surfaces, unconditionally: whichever is visible reacts, the
        // hidden one is already positioned when the user brings it back.
        window.dispatchEvent(new CustomEvent('history-panel:scroll-to-bottom', { detail: { tabId } }));
        window.dispatchEvent(new CustomEvent('timeline:scroll-to-bottom', { detail: { tabId } }));
        try { terminalRegistry.get(tabId)?.scrollToBottom(); } catch {}
        return;
      }
      lastTapAt = now;
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [workspaceView, currentView, effectiveTab?.id]);

  // CMD+\ / Option+\ hotkeys to toggle timeline tree mode
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (workspaceView !== 'workspace') return;
      const isBackslash = e.code === 'Backslash' || e.key === '\\' || e.code === 'IntlBackslash';
      if ((e.metaKey || e.altKey) && isBackslash) {
        const shortcut = e.metaKey ? 'CMD+\\' : 'OPT+\\';
        const hasSession =
          effectiveClaudeSessionId || effectiveGeminiSessionId || effectiveCodexSurfaceSessionId;
        if (!effectiveTab?.id || !hasSession) {
          console.warn('[Workspace:Hotkey] ' + shortcut + ' BLOCKED: effectiveTab=' + (effectiveTab?.id || 'null') + ' cmdType=' + effectiveCommandType + ' claudeSession=' + (effectiveClaudeSessionId ? effectiveClaudeSessionId.substring(0, 8) : 'null') + ' geminiSession=' + (effectiveGeminiSessionId ? effectiveGeminiSessionId.substring(0, 8) : 'null') + ' codexSession=' + (effectiveCodexSessionId ? effectiveCodexSessionId.substring(0, 8) : 'null'));
          return;
        }
        e.preventDefault();
        const current = useUIStore.getState().timelineTreeModeTabs[effectiveTab.id] ?? false;
        console.warn('[Workspace:Hotkey] ' + shortcut + ' toggle tree: tabId=' + effectiveTab.id.substring(effectiveTab.id.length - 8) + ' ' + current + ' → ' + !current);
        setTimelineTreeMode(effectiveTab.id, !current);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [workspaceView, effectiveTab?.id, effectiveClaudeSessionId, effectiveGeminiSessionId, effectiveCodexSessionId, effectiveCodexReadSessionId, effectiveCommandType, setTimelineTreeMode]);

  // CMD+F hotkey for terminal search
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Guard: don't fire when Workspace is hidden behind Dashboard
      if (workspaceView !== 'workspace') return;
      if (e.metaKey && e.key === 'f') {
        if (e.defaultPrevented) return;
        const target = e.target as HTMLElement | null;
        // The shared composer owns its own compact find panel. Opening the
        // terminal search on top of it made one shortcut control two surfaces.
        if (target?.closest('.gt-composer-editor')) return;
        if (historyIsPrimary && !floatingTerminalOpen) return;
        e.preventDefault();
        setShowSearch(true);
        // Focus input after render
        requestAnimationFrame(() => searchInputRef.current?.focus());
      }
      // Escape to close search
      if (e.key === 'Escape' && showSearch) {
        setShowSearch(false);
        setSearchText('');
        setSearchResults({ resultIndex: 0, resultCount: 0 });
        // Clear search highlighting
        if (effectiveTab?.id) {
          terminalRegistry.clearSearch(effectiveTab.id);
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [showSearch, effectiveTab?.id, floatingTerminalOpen, historyIsPrimary, workspaceView]);

  // Handle search
  const handleSearch = useCallback((text: string) => {
    setSearchText(text);
    if (!effectiveTab?.id || !text.trim()) {
      if (effectiveTab?.id) {
        terminalRegistry.clearSearch(effectiveTab.id);
      }
      return;
    }
    terminalRegistry.searchAndScroll(effectiveTab.id, text);
  }, [effectiveTab?.id]);

  // Handle keyboard in search
  const handleSearchKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (!effectiveTab?.id || !searchText.trim()) return;

    if (e.key === 'Enter') {
      e.preventDefault();
      if (e.shiftKey) {
        // Shift+Enter = find previous
        terminalRegistry.findPrevious(effectiveTab.id, searchText);
      } else {
        // Enter = find next
        terminalRegistry.findNext(effectiveTab.id, searchText);
      }
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      if (e.key === 'ArrowUp') {
        terminalRegistry.findPrevious(effectiveTab.id, searchText);
      } else {
        terminalRegistry.findNext(effectiveTab.id, searchText);
      }
    }
  }, [effectiveTab?.id, searchText]);

  // Find next/previous handlers for buttons
  const handleFindNext = useCallback(() => {
    if (effectiveTab?.id && searchText.trim()) {
      terminalRegistry.findNext(effectiveTab.id, searchText);
    }
  }, [effectiveTab?.id, searchText]);

  const handleFindPrevious = useCallback(() => {
    if (effectiveTab?.id && searchText.trim()) {
      terminalRegistry.findPrevious(effectiveTab.id, searchText);
    }
  }, [effectiveTab?.id, searchText]);

  // Subscribe to search results
  useEffect(() => {
    if (!effectiveTab?.id || !showSearch) return;

    terminalRegistry.onSearchResults(effectiveTab.id, (results) => {
      setSearchResults(results);
    });

    return () => {
      if (effectiveTab?.id) {
        terminalRegistry.offSearchResults(effectiveTab.id);
      }
    };
  }, [effectiveTab?.id, showSearch]);

  // Tab creation is now handled in useWorkspaceStore.openProject()

  // Delayed unmount for slide-out animation (keep mounted briefly after close).
  // Must stay above the empty-workspace guard: activeProject can be transiently
  // null during restore/HMR/project close, and returning before hooks breaks the
  // Rules of Hooks ("Rendered fewer hooks than expected").
  const isHistoryOpen = effectiveTab?.id ? (historyPanelOpenTabs[effectiveTab.id] ?? false) : false;
  const [historyMounted, setHistoryMounted] = useState(false);
  useEffect(() => {
    if (isHistoryOpen) {
      setHistoryMounted(true);
    } else if (historyMounted) {
      const timer = setTimeout(() => setHistoryMounted(false), 60);
      return () => clearTimeout(timer);
    }
  }, [isHistoryOpen, historyMounted]);

  // Session IDs come from fine-grained selectors (top of component) — not effectiveTab.
  // This ensures Workspace re-renders when Bridge updates session ID via set({}).
  // Show timeline if ANY session exists — don't gate on commandType match.
  // effectiveCommandType and effective*SessionId come from different
  // Zustand selectors that can temporarily desync (e.g. when viewingSubAgentTabId changes).
  // Requiring cmdType match caused timeline to permanently disappear.
  // Split mode: each pane renders its OWN Timeline column — the global one
  // would be a second rail for the focused tab.
  const timelineToolType = effectivePtyOwner
    || (effectiveCommandType === 'gemini' && effectiveGeminiSessionId ? 'gemini' : null);
  const timelineSessionId = timelineToolType === 'codex'
    ? effectiveCodexSurfaceSessionId
    : timelineToolType === 'claude'
      ? effectiveClaudeSessionId
      : timelineToolType === 'gemini'
        ? effectiveGeminiSessionId
        : null;
  const showTimeline = !filePreview && !splitActiveLayout
    && !!timelineToolType
    && !!timelineSessionId;
  // Timeline can hold hundreds of rendered rows. Switching its owner in the
  // urgent tab-click render synchronously tears down the old tree before the
  // new primary History surface can paint. Keep the previous Timeline owner
  // hidden for that cheap urgent frame, then hand the atomic owner tuple over
  // through React's deferred lane. The primary History surface therefore owns
  // the first paint without ever exposing the previous tab's Timeline rows.
  const timelineOwnerIdentity = useMemo(
    () => (showTimeline && effectiveTab
      ? {
          tabId: effectiveTab.id,
          sessionId: timelineSessionId || '',
          cwd: effectiveTab.cwd || currentProject?.path || '',
          toolType: timelineToolType as 'claude' | 'gemini' | 'codex',
        }
      : null),
    [showTimeline, effectiveTab?.id, effectiveTab?.cwd, timelineSessionId, timelineToolType, currentProject?.path],
  );
  const deferredTimelineOwner = useDeferredValue(timelineOwnerIdentity);
  const timelineOwnerIsCurrent = !!timelineOwnerIdentity
    && deferredTimelineOwner === timelineOwnerIdentity;
  const deferredTimelineOwnerKey = deferredTimelineOwner
    ? JSON.stringify([
        deferredTimelineOwner.tabId,
        deferredTimelineOwner.sessionId,
        deferredTimelineOwner.cwd,
        deferredTimelineOwner.toolType,
      ])
    : '';
  // The visibility boundary below can hide the previous rail without asking
  // the 100s-of-rows Timeline component to render in the urgent click frame.
  // Freeze its small runtime flags at the last committed owner until the
  // deferred owner catches up; normal same-owner busy/visibility changes still
  // flow immediately.
  const committedTimelineRuntimeRef = useRef<{
    ownerKey: string;
    isActive: boolean;
    isTurnBusy: boolean;
    isVisible: boolean;
    historySurfaceVisible: boolean;
  } | null>(null);
  const currentTimelineRuntime = {
    ownerKey: deferredTimelineOwnerKey,
    isActive: isCommandRunning,
    isTurnBusy: effectiveAiBusy || agentPasteBusyByTab.get(effectiveTab?.id || '') === true,
    isVisible: workspaceView === 'workspace' && currentView === 'terminal',
    historySurfaceVisible: focusedHistorySurfaceVisible,
  };
  const timelineRuntimeForRender = timelineOwnerIsCurrent
    ? currentTimelineRuntime
    : committedTimelineRuntimeRef.current?.ownerKey === deferredTimelineOwnerKey
      ? committedTimelineRuntimeRef.current
      : {
          ownerKey: deferredTimelineOwnerKey,
          isActive: false,
          isTurnBusy: false,
          isVisible: false,
          historySurfaceVisible: false,
        };
  useLayoutEffect(() => {
    if (!timelineOwnerIsCurrent || !deferredTimelineOwner) return;
    committedTimelineRuntimeRef.current = currentTimelineRuntime;
  }, [
    timelineOwnerIsCurrent,
    deferredTimelineOwner,
    deferredTimelineOwnerKey,
    isCommandRunning,
    effectiveAiBusy,
    agentPasteBusyByTab,
    workspaceView,
    currentView,
    focusedHistorySurfaceVisible,
  ]);
  // The agent surface pair resolves its own tool/session in BOTH layouts:
  // moving History to the side must not silently hand it the Timeline owner,
  // or the side panel would show a different conversation than the center did.
  const historyToolType = agentSurfacePairAvailable
    ? (primaryHistoryTool as 'claude' | 'codex')
    : timelineToolType;
  const historySessionId = agentSurfacePairAvailable
    ? (historyToolType === 'codex' ? effectiveCodexSurfaceSessionId : effectiveClaudeSessionId)
    : timelineSessionId;
  const shouldRenderHistoryPanel = !!effectiveTab
    && currentView === 'terminal'
    && !splitActiveLayout
    && (historyIsPrimary
      // Terminal-primary mounts History unconditionally: it owns the docked
      // composer below the terminal, which stays usable while the transcript
      // is closed, and it hosts the swap button back to History-primary. A
      // session-id gate would also strand a fresh tab with no way back.
      || historyIsAgentSidePanel
      || ((isHistoryOpen || historyMounted) && !!historySessionId));
  // Two-frame tab switch. Building a giant History for the new owner inside
  // the same render as the tab click kept ONE frame busy for 100-440ms: the
  // clicked tab's highlight appeared late and right-click/Open were dead
  // until the heavy commit finished. Deferring the OWNER IDENTITY lets React
  // commit a cheap frame first (tab highlight, live buttons, History shows
  // its loader) and render the heavy content interruptibly right after.
  // The identity moves as ONE object: tearing tabId/sessionId/toolType
  // across frames would violate the atomic owner+rows+loading contract.
  // These hooks MUST live above the empty-workspace early return below —
  // activeProject is transiently null during restore/HMR, and a hook that
  // only exists on non-empty renders crashes with "Rendered more hooks than
  // during the previous render" the moment the workspace hydrates.
  const historyOwnerTabId = effectiveTab?.id || '';
  const historyOwnerCwd = effectiveTab?.cwd || currentProject?.path || '';
  const historyOwnerControls = (historyToolType === 'claude' || historyToolType === 'codex') && effectiveTabType !== 'claude-sdk';
  const historyOwnerIdentity = useMemo(
    () => (shouldRenderHistoryPanel && historyOwnerTabId
      ? {
          tabId: historyOwnerTabId,
          sessionId: historySessionId || '',
          cwd: historyOwnerCwd,
          toolType: historyToolType,
          enableControls: historyOwnerControls,
        }
      : null),
    // Primitive deps only: a same-values identity object must keep its
    // reference, otherwise every store tick re-arms the deferred pass.
    [shouldRenderHistoryPanel, historyOwnerTabId, historySessionId, historyOwnerCwd, historyToolType, historyOwnerControls],
  );
  // Owner handoff with a REAL task boundary. useDeferredValue was supposed to
  // keep the heavy History remount out of the click frame, but React can only
  // yield BETWEEN components — HistoryPanel is one giant component, so its
  // deferred render ran as one unbreakable chunk inside the same click task
  // (measured live 04.08: 303ms/249ms long tasks named history-load:cold(open)
  // whose span exactly equals the tab-click handler; right-click and Ctrl+Tab
  // immediately after queued behind them). Two animation frames guarantee the
  // click task ends and the highlight paints before the heavy owner swap
  // starts; rapid switching naturally coalesces to the last target.
  const [deferredHistoryOwner, setDeferredHistoryOwner] = useState(historyOwnerIdentity);
  useEffect(() => {
    if (deferredHistoryOwner === historyOwnerIdentity) return;
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      // startTransition makes the heavy owner render INTERRUPTIBLE: a
      // right-click or Ctrl+Tab landing mid-render preempts it at component
      // boundaries instead of queueing behind the whole chunk. The rAF pair
      // above already guarantees the click frame painted first.
      raf2 = requestAnimationFrame(() => {
        startTransition(() => setDeferredHistoryOwner(historyOwnerIdentity));
      });
    });
    return () => {
      cancelAnimationFrame(raf1);
      if (raf2) cancelAnimationFrame(raf2);
    };
  }, [historyOwnerIdentity, deferredHistoryOwner]);
  const historyOwnerIsCurrent = deferredHistoryOwner === historyOwnerIdentity;
  // Placement freeze — same pattern as committedTimelineRuntimeRef above.
  // The panel's tree POSITION (primary / overlay / pinned) is chosen by urgent
  // flags, but its IDENTITY arrives through the deferred lane. When a switch
  // changes the layout class (agent-primary → file/terminal-primary),
  // the urgent frame used to move the node to another position while the
  // deferred owner still pointed at the OLD tab — React unmounted and
  // remounted the old owner there: a full 1000-row mount, owner effects and a
  // history load for a panel that dies one beat later (measured live:
  // SURFACE_OWNER lifetimeMs=739 rendered into an off-screen overlay).
  // Freezing the placement to the last committed one while the owner is stale
  // keeps the node in place with identical props, so that beat costs nothing.
  type HistoryPlacement = {
    ownerTabId: string;
    isPrimary: boolean;
    pinned: boolean;
    sidePanel: boolean;
    isOpen: boolean;
    terminalOpen: boolean;
  };
  const committedHistoryPlacementRef = useRef<HistoryPlacement | null>(null);
  const currentHistoryPlacement: HistoryPlacement = {
    ownerTabId: historyOwnerTabId,
    isPrimary: historyIsPrimary,
    pinned: historyPinned,
    sidePanel: historyIsAgentSidePanel,
    isOpen: historyIsPrimary || isHistoryOpen,
    terminalOpen: historyIsAgentSidePanel
      ? isHistoryOpen
      : (historyIsPrimary && floatingTerminalOpen),
  };
  const historyPlacementForRender = historyOwnerIsCurrent
    ? currentHistoryPlacement
    : committedHistoryPlacementRef.current?.ownerTabId === (deferredHistoryOwner?.tabId || '')
      ? committedHistoryPlacementRef.current
      : currentHistoryPlacement;
  useLayoutEffect(() => {
    if (historyOwnerIsCurrent) committedHistoryPlacementRef.current = currentHistoryPlacement;
  });
  // While the stale owner waits out the deferred beat, the frozen node must
  // not fight the NEW tab's layout: when the placement class changed (or the
  // new tab has no history surface at all — a linked file), the old panel would
  // either flash its rows over an unrelated surface or, kept in flow with
  // visibility:hidden, still occupy its box and shove the terminal aside for a
  // frame. display:none keeps the React instance mounted (the whole point —
  // no teardown, no dead remount) with zero layout footprint. Same-placement
  // switches (the common agent→agent case) stay visible, as before.
  const historyPlacementClassChanged =
    historyPlacementForRender.isPrimary !== currentHistoryPlacement.isPrimary
    || historyPlacementForRender.pinned !== currentHistoryPlacement.pinned
    || historyPlacementForRender.sidePanel !== currentHistoryPlacement.sidePanel;
  const historyStaleHidden = !historyOwnerIsCurrent
    && (historyPlacementClassChanged || !shouldRenderHistoryPanel);

  const handleChangeWorkingDirectory = useCallback(async () => {
    if (directoryChangeOperationRef.current !== 0) return;
    const projectId = activeProjectId;
    const visibleTabId = effectiveTab?.id || null;
    if (!projectId || !visibleTabId) return;

    const initialStore = useWorkspaceStore.getState();
    const initialWorkspace = initialStore.openProjects.get(projectId);
    const visibleTab = initialWorkspace?.tabs.get(visibleTabId);
    const ownerTab = visibleTab?.tabType === 'file' && visibleTab.visualParentTabId
      ? initialWorkspace?.tabs.get(visibleTab.visualParentTabId)
      : visibleTab;
    if (!ownerTab?.id) return;

    const operationId = Date.now() || 1;
    directoryChangeOperationRef.current = operationId;
    const isCurrentOperation = () => directoryChangeOperationRef.current === operationId;
    const setPhase = (phase: DirectoryChangePhase) => {
      if (isCurrentOperation()) setDirectoryChangePhase(phase);
    };
    const tabId = ownerTab.id;
    const currentCwd = ownerTab.cwd || rawExplorerPath || projectRootPath;
    let cwdChanged = false;

    try {
      setPhase('selecting');
      const selectedPath = await ipcRenderer.invoke('app:select-directory', {
        defaultPath: currentCwd || undefined,
      });
      if (!isCurrentOperation() || !selectedPath) return;

      const targetCwd = path.resolve(String(selectedPath));
      if (currentCwd && path.resolve(currentCwd) === targetCwd) return;

      const claudeSessionId = ownerTab.claudeSessionId || null;
      const codexSessionId = ownerTab.codexSessionId || null;
      const toolType = resolvePtyAgentOwner(ownerTab);
      const sessionId = toolType === 'codex' ? codexSessionId : toolType === 'claude' ? claudeSessionId : null;
      const runtime = toolType ? getHistoryAgentRuntime(toolType) : null;
      let presence = runtime
        ? await runtime.getPresence(tabId, projectId)
        : { status: 'inactive', conversationMaterialized: false };
      if (presence.status === 'unknown') {
        throw new Error('Не удалось определить состояние AI-сессии безопасно.');
      }

      let plan = planWorkingDirectoryChange({
        toolType,
        sessionId,
        presenceStatus: presence.status,
        conversationMaterialized: presence.conversationMaterialized === true,
      });
      if (plan.requiresConfirmation) {
        const response = await ipcRenderer.invoke('ui:confirm-destructive', {
          message: 'Сменить рабочую папку этой вкладки?',
          detail: plan.waitForTurn
            ? 'Текущий ответ сначала завершится. Затем сессия остановится и продолжится в выбранной папке отдельной веткой.'
            : 'Сессия будет перезапущена в выбранной папке отдельной веткой. Остальные вкладки не изменятся.',
          confirmLabel: 'Сменить и продолжить',
          cancelLabel: 'Отмена',
        });
        if (!response?.confirmed || !isCurrentOperation()) return;
      }

      if (plan.waitForTurn && runtime) {
        setPhase('waiting');
        useUIStore.getState().showToast(
          'Папка изменится после завершения текущего ответа',
          'info',
          3500,
          false,
          undefined,
          undefined,
          undefined,
          tabId,
        );
        presence = await waitForAgentTurnToSettle({ runtime, tabId, projectId });
        if (!isCurrentOperation()) return;
        plan = planWorkingDirectoryChange({
          toolType,
          sessionId,
          presenceStatus: presence.status,
          conversationMaterialized: presence.conversationMaterialized === true,
        });
      }

      if (plan.stopProcess && runtime) {
        setPhase('stopping');
        const stopped = await runtime.stopProcess(tabId, { reason: 'working-directory-change' });
        if (stopped?.success === false) {
          throw new Error(stopped.error || 'AI-сессию не удалось остановить');
        }
      }

      setPhase('switching');
      const changed = await ipcRenderer.invoke('terminal:change-working-directory', {
        tabId,
        targetCwd,
      });
      if (changed?.success !== true || changed?.accepted !== true || !changed?.cwd) {
        throw new Error(changed?.error || changed?.reason || 'Рабочая папка не изменилась');
      }
      cwdChanged = true;

      const latestStore = useWorkspaceStore.getState();
      let ownerProjectId: string | null = null;
      for (const [candidateProjectId, workspace] of latestStore.openProjects) {
        if (workspace.tabs.has(tabId)) {
          ownerProjectId = candidateProjectId;
          break;
        }
      }
      if (!ownerProjectId) throw new Error('Вкладка была закрыта во время смены папки');
      const rendererSaved = await latestStore.updateTabCwd(ownerProjectId, tabId, changed.cwd);
      if (!rendererSaved && changed.persisted !== true) {
        throw new Error('Новую папку не удалось сохранить для следующего запуска.');
      }

      if (plan.restartMode !== 'none' && runtime) {
        setPhase('restarting');
        let launchResult: any;
        if (plan.restartMode === 'fork' && sessionId) {
          launchResult = toolType === 'claude'
            ? await ipcRenderer.invoke('claude:run-command', {
                tabId,
                command: 'claude-f',
                forkSessionId: sessionId,
                targetCwd: changed.cwd,
                relocateWorkingDirectory: true,
                launchSource: 'explicit',
              })
            : await ipcRenderer.invoke('codex:run-command', buildCodexRunPayload({
                tabId,
                command: 'codex-f',
                sessionId,
                cwd: changed.cwd,
                launchSource: 'explicit',
              }));
        } else {
          launchResult = await runtime.startFresh?.({ tabId, cwd: changed.cwd });
        }
        if (!launchResult || launchResult.success === false || launchResult.accepted === false) {
          throw new Error(launchResult?.error || launchResult?.reason || 'AI-сессия не перезапустилась');
        }
      }

      useUIStore.getState().showToast(
        `Рабочая папка вкладки: ${path.basename(changed.cwd) || changed.cwd}`,
        'success',
        2800,
        false,
        undefined,
        undefined,
        undefined,
        tabId,
      );
    } catch (error) {
      const reason = directoryChangeErrorText(error);
      useUIStore.getState().showToast(
        cwdChanged
          ? `Папка изменена, но сессию не удалось продолжить: ${reason}`
          : `Папка не изменена: ${reason}`,
        'error',
        6500,
        false,
        undefined,
        undefined,
        undefined,
        tabId,
      );
    } finally {
      if (isCurrentOperation()) {
        directoryChangeOperationRef.current = 0;
        setDirectoryChangePhase('idle');
      }
    }
  }, [activeProjectId, effectiveTab?.id, projectRootPath, rawExplorerPath]);

  if (!activeProject || !activeProjectId || !currentProject) {
    console.warn('[Workspace:EARLY_RETURN] Empty workspace!', { activeProject: !!activeProject, activeProjectId, currentProject: !!currentProject });
    return <div className="flex-1 bg-bg-main" />;
  }

  // Get current tab's cwd for FileExplorer (fallback to project path).
  // The resolved path is produced asynchronously, so after a project switch it
  // still holds the PREVIOUS project's folder for a frame. Letting that win
  // would hand the file tree a foreign root (Inbox resolves to the home dir),
  // and the tree treats a root change as "forget which folders were expanded".
  // Accept the resolved value only while it still belongs to this project.
  const explorerPath = (
    resolvedExplorerPath
    && (resolvedExplorerPath === rawExplorerPath || resolvedExplorerPath === projectRootPath)
  )
    ? resolvedExplorerPath
    : (rawExplorerPath || projectRootPath);

  // Stale-owner beat: the tab highlight has already moved, but the heavy
  // owner identity travels through the deferred lane — for those frames the
  // panel still SHOWS the previous tab's transcript under the new tab's
  // highlight. While everything froze together this was invisible; now that
  // the switch paints promptly the mismatch reads as "clicked tab 2, still
  // seeing tab 1's history". The panel drops a loader curtain over its own
  // content stage for exactly these frames (staleOwnerCurtain below).
  const historyStaleCurtain = !historyOwnerIsCurrent && !historyStaleHidden;
  const historyPanelNode = deferredHistoryOwner ? (
    // The stale-owner beat renders with FROZEN placement (historyPlacementForRender):
    // identical tree position and placement props keep React reconciling the
    // same instance instead of remounting the dying owner into the new layout.
    // The visibility wrapper hides frozen rows when the new tab has no history
    // surface of its own; display:contents keeps the wrapper boxless so the
    // flex/absolute geometry of all three placements is untouched.
    <div style={historyStaleHidden ? { display: 'none' } : { display: 'contents' }}>
    <HistoryPanel
      staleOwnerCurtain={historyStaleCurtain}
      tabId={deferredHistoryOwner.tabId}
      sessionId={deferredHistoryOwner.sessionId}
      cwd={deferredHistoryOwner.cwd}
      width={historyPanelWidth}
      notesPanelWidth={notesPanelWidth}
      isOpen={historyPlacementForRender.isOpen}
      toolType={deferredHistoryOwner.toolType}
      enableClaudePtyControls={deferredHistoryOwner.enableControls}
      embedded={historyPlacementForRender.isPrimary || historyPlacementForRender.pinned}
      embeddedFill={historyPlacementForRender.isPrimary}
      mainSurface={historyPlacementForRender.isPrimary}
      // Terminal-primary keeps the same History as the side panel: it stays
      // the tab's live input surface (grab, dictation, task plan, Escape),
      // only its geometry differs from the centered layout.
      // The docked composer is always present in terminal-primary, so History
      // owns the tab's input there whether or not the transcript is open.
      agentSidePanel={historyPlacementForRender.sidePanel}
      // Terminal-primary docks the one composer below the terminal, so it is
      // reachable even while the transcript panel is closed.
      composerPortalHostId={historyPlacementForRender.sidePanel ? dockedComposerHostId : undefined}
      // Terminal-primary docks the composer at the bottom of the center box,
      // and this panel hangs off that same box — so it must stop above the
      // input, exactly as the mirrored side terminal already does. One measured
      // number feeds both, so they cannot disagree.
      bottomInset={historyPlacementForRender.sidePanel ? historyControlsHeight : 0}
      projectId={activeProjectId}
      // One control, one meaning: "show me the OTHER surface". In
      // History-primary the other surface is the terminal, in terminal-primary
      // it is the transcript — so the same button reports and toggles whichever
      // one is currently secondary, and is never a dead control.
      terminalOpen={historyPlacementForRender.terminalOpen}
      onToggleTerminal={historyPlacementForRender.isPrimary
        ? toggleFloatingTerminal
        : historyPlacementForRender.sidePanel ? toggleAgentSideHistory : undefined}
      onSwapPrimarySurface={agentSurfacePairAvailable ? swapPrimarySurface : undefined}
      terminalIsPrimary={terminalIsPrimary}
      lifecycleStatus={agentSurfacePairAvailable ? agentLifecycleStatus : null}
      inputBusy={agentPasteBusyByTab.get(deferredHistoryOwner.tabId) === true}
      presented={workspaceView === 'workspace'
        && currentView === 'terminal'
        && historyOwnerIsCurrent
        && !historyStaleHidden
        && historyPlacementForRender.isOpen}
      onControlsHeightChange={
        historyPlacementForRender.isPrimary || historyPlacementForRender.sidePanel
          ? handleHistoryControlsHeight
          : undefined
      }
    />
    </div>
  ) : null;
  const terminalSearchNode = currentView === 'terminal' && showSearch ? (
    <div
      data-terminal-search-overlay
      style={{
        position: 'absolute',
        top: 8,
        right: 8,
        zIndex: 100,
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        backgroundColor: 'rgba(40, 40, 40, 0.96)',
        backdropFilter: 'blur(8px)',
        border: '1px solid rgba(255, 255, 255, 0.12)',
        borderRadius: 7,
        padding: '6px 8px',
        boxShadow: '0 4px 12px rgba(0, 0, 0, 0.35)',
      }}
    >
      <input
        ref={searchInputRef}
        type="text"
        value={searchText}
        onChange={(event) => handleSearch(event.target.value)}
        onKeyDown={handleSearchKeyDown}
        placeholder="Search terminal..."
        style={{ background: 'transparent', border: 0, outline: 0, color: '#fff', fontSize: 12, width: 160 }}
      />
      {searchText && (
        <span style={{ fontSize: 10, color: searchResults.resultCount > 0 ? '#aaa' : '#f87171', minWidth: 44, textAlign: 'center' }}>
          {searchResults.resultCount > 0 ? `${searchResults.resultIndex}/${searchResults.resultCount}` : 'No results'}
        </span>
      )}
      <button onClick={handleFindPrevious} disabled={searchResults.resultCount === 0} style={{ background: 'none', border: 0, color: searchResults.resultCount ? '#bbb' : '#555', cursor: searchResults.resultCount ? 'pointer' : 'default', padding: 2 }}>▲</button>
      <button onClick={handleFindNext} disabled={searchResults.resultCount === 0} style={{ background: 'none', border: 0, color: searchResults.resultCount ? '#bbb' : '#555', cursor: searchResults.resultCount ? 'pointer' : 'default', padding: 2 }}>▼</button>
      <button
        aria-label="Close terminal search"
        onClick={() => {
          setShowSearch(false);
          setSearchText('');
          setSearchResults({ resultIndex: 0, resultCount: 0 });
          if (effectiveTab?.id) terminalRegistry.clearSearch(effectiveTab.id);
        }}
        style={{ background: 'none', border: 0, color: '#777', cursor: 'pointer', padding: 2 }}
      >✕</button>
    </div>
  ) : null;

  // DEBUG: Uncomment to debug Timeline visibility
  // console.log('[Timeline Debug] showTimeline:', showTimeline, 'claudeSessionId:', claudeSessionId, 'commandType:', activeTab?.commandType, 'isRunning:', isCommandRunning);

  if ((window as any).__NOTED_RENDER_DIAG__ === true) {
    console.warn(`[Workspace:RENDER] currentView=${currentView} showTimeline=${showTimeline} activeTabId=${activeTab?.id} effectiveTabId=${effectiveTab?.id} isCommandRunning=${isCommandRunning}`);
  }

  return (
    <div className="flex-1 flex flex-col h-full min-h-0 overflow-hidden relative">
      {/* Полоса кнопок во всю ширину окна стояла здесь и удалена 2026-08-18.
          Она тянулась через весь экран ради десятка кнопок и отнимала высоту у
          терминала постоянно. Кнопки проекта (файлы, история вкладок, VS Code,
          индекс) уехали внутрь боковой панели вкладок — туда, где стоит их
          проект; кнопки рабочей области (⌘P, Timeline, ресурсы, Docs, Git) —
          наверх, в свободную правую часть шапки приложения. */}

      {/* Строка с рабочей директорией жила здесь и переехала в шапку каждого
          окна (SplitPaneAttachRow): полоса во всю ширину ради одной короткой
          подписи была несоразмерна тому, что она сообщает, и отвечала только за
          активную вкладку — пути остальных панелей не показывались вовсе. */}

      {/* MAIN ROW: TabSidebar | Terminal. */}
      <div className="flex-1 flex min-h-0 relative">
      {/* LEFT COLUMN: vertical tab sidebar */}
      <TabSidebar
        projectId={focusedProjectId || activeProjectId}
        processStatus={processStatus}
        busyTabs={busyTabs}
        pasteBusyTabs={pasteBusyTabs}
      />

      {/* Menu owners for the OTHER projects currently visible in panes.
          Render nothing; each exists only to answer a context-menu request for
          its own project. The tab menu is built entirely from its project
          (scripts and favourites of the tab's cwd, "Move to project", the
          workspace toggle), so only that project's list can open it — and panes
          are cross-project, so the sidebar's single list cannot serve them all.
          A right click asks ABOUT a tab and must not navigate: the menu comes to
          the project, the project does not move to the menu. */}
      {paneMenuOwnerProjectIds.map((pid) => (
        <TabBar
          key={`menu-owner-${pid}`}
          projectId={pid}
          layout="vertical"
          menuOnlyForProject
          sharedProcessStatus={processStatus}
          sharedBusyTabs={busyTabs}
          sharedPasteBusyTabs={pasteBusyTabs}
        />
      ))}

      {/* CENTER COLUMN: Terminal/Home Area (no more TabBar above it) */}
      <div data-workspace-center className="flex-1 flex flex-col min-w-0 relative">

        {/* Полоса рабочих пространств — над окнами и ВНУТРИ рабочей области.
            Не над боковым списком: пространство помнит раскладку окон, то есть
            говорит про то, что справа от списка. Обычная строка в колонке, а не
            наложение: всё ниже честно уменьшается на её высоту, и окна не
            уезжают под неё. */}
        <SpaceStrip
          processStatus={processStatus}
          busyTabs={busyTabs}
          pasteBusyTabs={pasteBusyTabs}
          inheritedBusyTabIds={inheritedBusyTabIds}
        />

        <div className="flex-1 flex flex-col min-w-0 relative">
          {/* Terminal Area — Timeline + HistoryPanel are constrained to this height */}
          <div className="flex-1 flex min-w-0 relative">
          {/* Vertical stack [Terminal content | ClaudeControlBar] — bar lives below
              the terminal area only, NOT under Timeline (Timeline sits to the right
              of this column and spans the full row height). */}
          <div className="flex-1 flex flex-col min-w-0">
          {/* Attach row — single mode. A normal flex row ABOVE the center
              surface (terminal OR History-primary OR pinned pair), so it spans
              the full center width and everything below shrinks by its height.
              It cannot live inside TerminalArea: in History-primary the
              terminal is wrapped in the floating frame and the row would end
              up inside that window. Split mode renders per-pane rows instead. */}
          {!splitActiveLayout && effectiveTab && currentView === 'terminal' && (
            // Слот шапки в одиночном режиме. Обычно его высота — предсказание по
            // настройкам размеров, и всё ниже сжимается на неё. В режиме
            // ПЕРЕНОСА вкладок шапка выше на столько строк, сколько заняли чипы,
            // и предсказать это нельзя — поэтому слот отдаёт высоту той
            // переменной, которую шапка измеряет и публикует сюда сама
            // (PANE_HEADER_HEIGHT_VAR). Запасное значение — то же предсказание.
            <div
              className="shrink-0 relative"
              data-pane-header-host
              style={{ height: `var(${PANE_HEADER_HEIGHT_VAR}, ${attachRowH}px)` }}
            >
              <SplitPaneAttachRow
                projectId={activeProjectId}
                tabId={effectiveTab.id}
                focused
                sharedActivity={sharedTabActivity}
              />
            </div>
          )}
          {/* Row [terminal content | pinned History]. The pinned panel lives
              HERE rather than beside the whole column so it spans the
              terminal's height only: the composer and control bar below keep
              full width, exactly as when the panel overlays. A pinned panel
              should reserve horizontal space from the terminal, never from the
              input the user is typing into. */}
          <div className="flex-1 flex min-w-0 relative">
          {/* Terminal content. В одиночном режиме overflow hidden обрезает
              слайд боковой переписки (закрытая панель прячется сдвигом за
              край). В разделённом виде та обрезка живёт у каждого окна своя
              (SplitPaneSurface::sideOverlayOpen), а здесь она наоборот мешала:
              открытая боковая панель ЛЕВОГО окна обязана лечь поверх бокового
              списка вкладок («он его тоже должен перекрывать»), и обрезка на
              этом контейнере резала её ровно по границе рабочей области. */}
          <div className={splitActiveLayout
            ? 'flex-1 relative min-w-0'
            : 'flex-1 relative min-w-0 overflow-hidden'}>
            {/* Placement gates use the FROZEN placement (not the live flags):
                during the stale deferred beat the node must stay where the
                dying owner rendered it — see historyPlacementForRender. */}
            {historyPlacementForRender.isPrimary && historyPanelNode}

            <FloatingTerminalFrame
              tabId={effectiveTab?.id || null}
              tabName={effectiveTab?.name || 'Terminal'}
              floating={historyIsPrimary}
              open={!historyIsPrimary || floatingTerminalOpen}
              // Same pin switch as the transcript panel: one control for the
              // Cmd+] slot, whichever surface currently occupies it.
              pinned={sideTerminalPinned}
              bottomInset={
                historyIsPrimary || historyIsAgentSidePanel
                  ? historyControlsHeight
                  : 0
              }
              onClose={closeFloatingTerminal}
              searchNode={terminalSearchNode}
            >
              <TerminalArea
                projectId={activeProjectId}
                sharedActivity={sharedTabActivity}
                terminalPresented={!historyIsPrimary || floatingTerminalOpen}
                // ALWAYS portal the Run after strip out of the terminal layer,
                // in both layouts. Terminal-primary with a docked composer
                // shifts the whole terminal stage UPWARD by the composer height
                // (see FloatingTerminalFrame translateY / stableTerminalViewport)
                // so a growing input never resizes xterm. Anything left inside
                // that stage rides the shift: the Run after strip drifted up and
                // off the top with it. The strip belongs to the WORKSPACE, not
                // to the terminal — its host below is a plain sibling of the
                // shifted stage, so the terminal can move freely underneath.
                // (A tab with no agent pair has no docked composer and no host;
                // the strip then renders inline as before.)
                promptQueuePortalHostId={agentSurfacePairAvailable ? promptQueuePortalHostId : undefined}
                // Opening the transcript now lives in the composer's top line,
                // beside the status — the same physical control that opens the
                // terminal in the other layout. Keeping a second History button
                // in the Run after rail would be two places for one action.
                hidePromptQueueHistoryToggle={agentSurfacePairAvailable}
                // Both agent layouts own a History composer, so 'history' here
                // means "this tab has both inputs" — grab/Replay then pick the
                // one that actually has focus. In terminal-primary the composer
                // is docked below the terminal and stays usable with the
                // transcript closed, so it must not depend on isHistoryOpen.
                promptQueueInputSurface={agentSurfacePairAvailable ? 'history' : 'terminal'}
                onLifecycleStatusChange={handleLifecycleStatusChange}
              />
            </FloatingTerminalFrame>

            {/* Run after host — a plain sibling of the (possibly shifted)
                terminal stage, present in BOTH layouts. `bottom` is the
                measured height of the docked input, so the strip stops above
                the composer instead of running under it. In terminal-primary
                that same measurement is what shifts the terminal upward, so
                both surfaces read one number and cannot disagree.

                Слой ВЫШЕ бокового окна (у того 130). Полоска перестала
                отходить влево при его открытии — уступать место окну, которое
                закрывается одной клавишей, ей нечего, — и на прежнем слое 120
                это означало не «стоит на месте», а «спряталась под ним». Она
                принадлежит рабочей области, а боковое окно — временный гость
                поверх центра: гость не может закрывать собой постоянный
                орган управления. */}
            {(historyIsPrimary || historyIsAgentSidePanel) && (
              <div
                id={promptQueuePortalHostId}
                data-history-prompt-queue-host
                data-workspace-prompt-queue-host
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  right: 0,
                  bottom: Math.max(0, historyControlsHeight),
                  zIndex: 140,
                  pointerEvents: 'none',
                }}
              />
            )}

            {!splitActiveLayout && effectiveTab && currentView === 'terminal' && (
              <TabTaskPlanPanel
                tabId={effectiveTab.id}
                projectPath={currentProject.path}
                inputSurface={agentSurfacePairAvailable && (historyIsPrimary || isHistoryOpen)
                  ? 'history'
                  : effectiveTabType === 'claude-sdk' ? 'sdk' : 'terminal'}
                commandType={effectiveCommandType}
              />
            )}

            {/* File Preview Overlay */}
            {filePreview && (
              <FilePreview topOffset={filePreview.source === 'tab' ? attachRowH : 0} />
            )}

            {/* History Panel — overlay unless History pin mode is enabled. */}
            {!historyPlacementForRender.isPrimary && !historyPlacementForRender.pinned && historyPanelNode}
          </div>

          {/* Pinned History — sibling of the terminal content, inside the same
              row, so it takes width from the terminal and not from the composer
              or control bar underneath. */}
          {!historyPlacementForRender.isPrimary && historyPlacementForRender.pinned && historyPanelNode}

          {/* The terminal keeps a stable xterm geometry. The composer is an
              overlay at the bottom of this fixed viewport; FloatingTerminalFrame
              moves the inline terminal upward by the measured height instead
              of shrinking it and triggering a PTY resize/redraw. */}
          {historyIsAgentSidePanel && (
            <div
              id={dockedComposerHostId}
              data-workspace-docked-composer-host
              style={{
                position: 'absolute',
                left: 0,
                right: 0,
                bottom: 0,
                zIndex: 140,
                pointerEvents: 'auto',
              }}
            />
          )}
          </div>

          {/* Claude control bar — Provider/Model/Effort/Think + Ctx meter +
              SessionActionChip (Start/Continue/Stop). Visible on every Terminal
              column (any tabType except a linked file). Without a live AI session
              the bar dims the right cluster and shows a Start-capable chip so
              the user can spawn Claude from any terminal. */}
          {!splitActiveLayout && effectiveTab && currentView === 'terminal' && effectiveTabType !== 'file' && (
            <ClaudeControlBar
              tabId={effectiveTab.id}
              projectId={activeProjectId}
              // Both agent layouts author through History, so the lower bar
              // keeps its History-backed Mic/Enter/^C in either one. Only a
              // closed side panel hands authoring back to the raw PTY.
              historyIsPrimary={focusedHistorySurfaceVisible || (historyIsAgentSidePanel && isHistoryOpen)}
              claudeSessionId={effectiveClaudeSessionId}
              geminiSessionId={effectiveGeminiSessionId}
              codexSessionId={effectiveCodexSessionId}
              commandType={effectiveCommandType}
              isCommandRunning={isCommandRunning}
              projectPath={currentProject.path}
            />
          )}
          </div>

          {/* Timeline — inside terminal row so it only spans terminal height */}
          {deferredTimelineOwner && (
            <div
              data-timeline-owner-boundary
              aria-hidden={!timelineOwnerIsCurrent}
              style={{
                display: 'contents',
                visibility: timelineOwnerIsCurrent ? 'visible' : 'hidden',
                pointerEvents: timelineOwnerIsCurrent ? 'auto' : 'none',
              }}
            >
              <Timeline
                tabId={deferredTimelineOwner.tabId}
                sessionId={deferredTimelineOwner.sessionId}
                cwd={deferredTimelineOwner.cwd}
                isActive={timelineRuntimeForRender.isActive}
                isTurnBusy={timelineRuntimeForRender.isTurnBusy}
                isVisible={timelineRuntimeForRender.isVisible}
                isOpen={true}
                toolType={deferredTimelineOwner.toolType}
                pinned={timelinePinned}
                historySurfaceVisible={timelineRuntimeForRender.historySurfaceVisible}
              />
              <style>
                {timelineOwnerIsCurrent
                  ? ''
                  : '[data-timeline-portal]{visibility:hidden!important;pointer-events:none!important}'}
              </style>
            </div>
          )}
        </div>

        </div>

        {/* Project Home - Overlay AFTER TabBar+TerminalArea to keep children indices stable */}
        {/* Uses absolute positioning so visual order is unaffected */}
        {focusedProjectId && focusedCurrentView === 'home' && (
          <div className="absolute inset-0 z-50 bg-bg-main border-r border-border-main">
            <ProjectHome projectId={focusedProjectId} />
          </div>
        )}
      </div>

      </div>{/* /MAIN ROW */}

      {/* Global Overlays */}
      {/* Sidebar File Explorer - opens in current terminal's directory */}
      {(() => {
        if (isInboxProject) return null;
        if (!sidebarOpenForRender || !explorerPath) return null;
        const { sidebarExpandedDirs, sidebarScrollTop } = getSidebarState(activeProjectId);
        const effectiveSidebarWidth = sidebarWidth || 280;
        return ReactDOM.createPortal(
          <div data-sidebar-portal style={{ position: 'fixed', left: 0, top: EXPLORER_TOP_H, bottom: 0, width: effectiveSidebarWidth, zIndex: 2147482000, borderRight: '1px solid #333', boxShadow: '4px 0 20px rgba(0,0,0,0.5)' }}>
            <Sidebar
              key={activeProjectId}
              folderPath={explorerPath}
              onChangeDirectory={handleChangeWorkingDirectory}
              directoryChangeState={directoryChangePhase}
              width={effectiveSidebarWidth}
              fontSize={sidebarFontSize || 13}
              onFocus={() => {}}
              onCollapse={() => setSidebarOpen(activeProjectId, false)}
              activeFilePath={filePreview?.path || null}
              onRename={handleSidebarPathChanged}
              initialExpandedDirs={sidebarExpandedDirs}
              onExpandedDirsChange={handleSidebarExpandedDirsChange}
              initialScrollTop={sidebarScrollTop}
              onScrollChange={handleSidebarScrollChange}
              linkOwnerProjectId={activeProjectId}
              onLinkFile={handleLinkFileToTab}
              onFileSelect={(filePath: string, isDir: boolean) => {
                console.warn('[SidebarFileOpen] select', {
                  filePath,
                  isDir,
                  previewPath: filePreview?.path || null,
                  previewSource: filePreview?.source || null,
                });
                if (!isDir) {
                  if (filePreview?.path === filePath && filePreview?.source !== 'tab') {
                    console.warn('[SidebarFileOpen] close-current-preview', { filePath });
                    useUIStore.getState().closeFilePreview();
                    setOpenFilePath(activeProjectId, null);
                  } else {
                    const ipc = window.require('electron').ipcRenderer;
                    console.warn('[SidebarFileOpen] read-start', { filePath });
                    ipc.invoke('file:read', filePath).then((result: any) => {
                      console.warn('[SidebarFileOpen] read-result', {
                        filePath,
                        success: !!result?.success,
                        error: result?.error || null,
                        length: typeof result?.content === 'string' ? result.content.length : null,
                      });
                      if (result?.success) {
                        const language = detectLanguage(path.extname(filePath).toLowerCase());
                        openFilePreview({ path: filePath, content: result.content, language, source: 'sidebar' });
                        setOpenFilePath(activeProjectId, filePath);
                      }
                    });
                  }
                }
              }}
            />
            {/* Resize handle */}
            <div
              style={{ position: 'absolute', right: -3, top: 0, bottom: 0, width: 6, cursor: 'col-resize', zIndex: 1 }}
              onMouseDown={(e) => {
                e.preventDefault();
                const startX = e.clientX;
                const startW = sidebarWidth;
                const onMove = (ev: MouseEvent) => {
                  const newW = Math.max(180, Math.min(500, startW + ev.clientX - startX));
                  const container = (e.target as HTMLElement).parentElement;
                  if (container) container.style.width = newW + 'px';
                };
                const onUp = (ev: MouseEvent) => {
                  const finalW = Math.max(180, Math.min(500, startW + ev.clientX - startX));
                  useUIStore.getState().setSidebarWidth(finalW);
                  document.removeEventListener('mousemove', onMove);
                  document.removeEventListener('mouseup', onUp);
                };
                document.addEventListener('mousemove', onMove);
                document.addEventListener('mouseup', onUp);
              }}
              onMouseEnter={(e) => { (e.target as HTMLElement).style.background = 'rgba(99,102,241,0.4)'; }}
              onMouseLeave={(e) => { (e.target as HTMLElement).style.background = ''; }}
            />
          </div>,
          document.body
        );
      })()}

    </div>
  );
}
