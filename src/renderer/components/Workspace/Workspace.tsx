import React, { useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useState, useRef } from 'react';
import ReactDOM from 'react-dom';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';
import { useProjectsStore } from '../../store/useProjectsStore';
import { useUIStore } from '../../store/useUIStore';
import { terminalRegistry } from '../../utils/terminalRegistry';
import TabBar from './TabBar';
import TabSidebar from './TabSidebar';
import ProjectToolbar from './ProjectToolbar';
import ProjectHome from './ProjectHome';
import TerminalArea, { type AgentLifecycleSummary } from './TerminalArea';
import FloatingTerminalFrame from './FloatingTerminalFrame';
import Timeline from './Timeline';
import '../../utils/sidebarBridge'; // Init window.electronAPI bridge
import Sidebar from './Sidebar';
import FilePreview from './FilePreview';
import TabTaskPlanPanel from './TabTaskPlanPanel';
import HistoryPanel from './HistoryPanel';
import ClaudeControlBar from './ClaudeControlBar';
import { INBOX_PROJECT_ID, INBOX_PROJECT_NAME, getInboxProjectPath, isInboxProjectId } from '../../constants/systemProjects';
import { linkFileTab } from '../../utils/linkFileTab';

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

export default function Workspace() {
  // DEBUG: Track Workspace mount/unmount
  useEffect(() => {
    console.warn('[Workspace:MOUNT]');
    return () => {
      console.warn('[Workspace:UNMOUNT]');
    };
  }, []);

  // Use selectors to avoid rerenders on unrelated store changes
  const activeProjectId = useWorkspaceStore((s) => s.activeProjectId);
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
  const timelineTreeModeTabs = useUIStore((s) => s.timelineTreeModeTabs);
  const setTimelineTreeMode = useUIStore((s) => s.setTimelineTreeMode);
  const sidebarWidth = useUIStore((s) => s.sidebarWidth);
  const sidebarFontSize = useUIStore((s) => s.sidebarFontSize);
  const historyPinned = useUIStore((s) => s.historyPinned);
  const timelinePinned = useUIStore((s) => s.timelinePinned);
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
  const commandStateSeqRef = useRef(0);
  const [floatingTerminalOpenTabs, setFloatingTerminalOpenTabs] = useState<Record<string, boolean>>({});
  const [historyControlsHeight, setHistoryControlsHeight] = useState(0);
  const [agentLifecycleStatus, setAgentLifecycleStatus] = useState<AgentLifecycleSummary | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

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
  // Derived from the per-tab map so switching tabs shows THIS tab's state
  // rather than whatever the previously focused tab last reported.
  const isCommandRunning = effectiveTab?.id
    ? commandRunningByTab.get(effectiveTab.id) === true
    : false;
  const primaryHistoryTool = effectiveCommandType === 'codex'
    ? 'codex'
    : effectiveCommandType === 'claude'
      ? 'claude'
      : effectiveCodexSessionId && !effectiveClaudeSessionId
        ? 'codex'
        : effectiveClaudeSessionId
          ? 'claude'
          : null;
  const historyIsPrimary = !!effectiveTab
    && currentView === 'terminal'
    && effectiveTabType !== 'claude-sdk'
    && effectiveTabType !== 'browser'
    && effectiveTabType !== 'file'
    && !filePreview
    && !!primaryHistoryTool;
  const floatingTerminalOpen = !!(effectiveTab?.id && floatingTerminalOpenTabs[effectiveTab.id]);
  const promptQueuePortalHostId = 'workspace-prompt-queue-host';

  const toggleFloatingTerminal = useCallback(() => {
    const tabId = effectiveTab?.id;
    if (!tabId) return;
    if (floatingTerminalOpen) {
      setShowSearch(false);
      setSearchText('');
      setSearchResults({ resultIndex: 0, resultCount: 0 });
      terminalRegistry.clearSearch(tabId);
    }
    setFloatingTerminalOpenTabs((current) => ({ ...current, [tabId]: !current[tabId] }));
  }, [effectiveTab?.id, floatingTerminalOpen]);

  const closeFloatingTerminal = useCallback(() => {
    const tabId = effectiveTab?.id;
    if (!tabId) return;
    setFloatingTerminalOpenTabs((current) => current[tabId] ? { ...current, [tabId]: false } : current);
    setShowSearch(false);
    setSearchText('');
    setSearchResults({ resultIndex: 0, resultCount: 0 });
    terminalRegistry.clearSearch(tabId);
  }, [effectiveTab?.id]);

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
  useEffect(() => {
    if (!activeProjectId) return;

    if (!activeFileTabPath || !activeFileTab?.id) {
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
          useUIStore.getState().showToast(`File preview: ${result?.error || 'failed to read file'}`, 'error');
        }
      } catch (e: any) {
        if (!cancelled) {
          useUIStore.getState().showToast(`File preview: ${e?.message || 'failed to read file'}`, 'error');
        }
      }
    })();

    return () => { cancelled = true; };
  }, [activeProjectId, activeFileTabPath, activeFileTab?.id, currentView, closeFilePreview, openFilePreview]);

  // Sync file preview with sidebar state (project switch + sidebar open/close)
  useEffect(() => {
    if (!activeProjectId) return;

    const { openFilePath } = getSidebarState(activeProjectId);
    const { sidebarPersistFile } = useUIStore.getState();

    if (!sidebarOpenForRender) {
      // Sidebar closed — hide file preview. When persist=false, also drop the saved
      // path so the next sidebar open starts clean (just the tree, no file).
      if (filePreview && filePreview.source !== 'tab') closeFilePreview();
      if (!sidebarPersistFile && openFilePath) {
        setOpenFilePath(activeProjectId, null);
      }
      return;
    }

    // Sidebar open — persist=false only disables automatic restore on reopen.
    // A direct file click must still keep its preview; otherwise the click opens
    // successfully and this sync effect closes it in the next render.
    if (!sidebarPersistFile) {
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
        if (historyIsPrimary) return;
        const shortcut = e.metaKey ? 'CMD+]' : 'OPT+]';
        const hasSession = effectiveClaudeSessionId || effectiveGeminiSessionId || effectiveCodexSessionId;
        if (!effectiveTab?.id || !hasSession) {
          console.warn('[Workspace:Hotkey] ' + shortcut + ' BLOCKED: effectiveTab=' + (effectiveTab?.id || 'null') + ' cmdType=' + effectiveCommandType + ' claudeSession=' + (effectiveClaudeSessionId ? effectiveClaudeSessionId.substring(0, 8) : 'null') + ' geminiSession=' + (effectiveGeminiSessionId ? effectiveGeminiSessionId.substring(0, 8) : 'null') + ' codexSession=' + (effectiveCodexSessionId ? effectiveCodexSessionId.substring(0, 8) : 'null'));
          return;
        }
        e.preventDefault();
        const currentOpen = useUIStore.getState().historyPanelOpenTabs[effectiveTab.id] ?? false;
        console.warn('[Workspace:Hotkey] ' + shortcut + ' toggle history: tabId=' + effectiveTab.id.substring(effectiveTab.id.length - 8) + ' ' + currentOpen + ' → ' + !currentOpen);
        if (!currentOpen && !timelinePinned) setTimelineTreeMode(effectiveTab.id, false); // unpinned Timeline conflicts with History
        setHistoryPanelOpen(effectiveTab.id, !currentOpen);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [workspaceView, historyIsPrimary, effectiveTab?.id, effectiveClaudeSessionId, effectiveGeminiSessionId, effectiveCodexSessionId, effectiveCommandType, setHistoryPanelOpen, setTimelineTreeMode, timelinePinned]);

  // CMD+\ / Option+\ hotkeys to toggle timeline tree mode
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (workspaceView !== 'workspace') return;
      const isBackslash = e.code === 'Backslash' || e.key === '\\' || e.code === 'IntlBackslash';
      if ((e.metaKey || e.altKey) && isBackslash) {
        const shortcut = e.metaKey ? 'CMD+\\' : 'OPT+\\';
        const hasSession =
          effectiveClaudeSessionId || effectiveGeminiSessionId || effectiveCodexSessionId;
        if (!effectiveTab?.id || !hasSession) {
          console.warn('[Workspace:Hotkey] ' + shortcut + ' BLOCKED: effectiveTab=' + (effectiveTab?.id || 'null') + ' cmdType=' + effectiveCommandType + ' claudeSession=' + (effectiveClaudeSessionId ? effectiveClaudeSessionId.substring(0, 8) : 'null') + ' geminiSession=' + (effectiveGeminiSessionId ? effectiveGeminiSessionId.substring(0, 8) : 'null') + ' codexSession=' + (effectiveCodexSessionId ? effectiveCodexSessionId.substring(0, 8) : 'null'));
          return;
        }
        e.preventDefault();
        const current = useUIStore.getState().timelineTreeModeTabs[effectiveTab.id] ?? false;
        console.warn('[Workspace:Hotkey] ' + shortcut + ' toggle tree: tabId=' + effectiveTab.id.substring(effectiveTab.id.length - 8) + ' ' + current + ' → ' + !current);
        if (!current && !historyPinned) setHistoryPanelOpen(effectiveTab.id, false); // unpinned History conflicts with Timeline
        setTimelineTreeMode(effectiveTab.id, !current);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [workspaceView, effectiveTab?.id, effectiveClaudeSessionId, effectiveGeminiSessionId, effectiveCodexSessionId, effectiveCommandType, setTimelineTreeMode, setHistoryPanelOpen, historyPinned]);

  // CMD+F hotkey for terminal search
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Guard: don't fire when Workspace is hidden behind Dashboard
      if (workspaceView !== 'workspace') return;
      if (e.metaKey && e.key === 'f') {
        if (historyIsPrimary && !floatingTerminalOpen) return;
        e.preventDefault();
        setShowSearch(true);
        // Focus input after render
        setTimeout(() => searchInputRef.current?.focus(), 50);
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
  const showTimeline = !filePreview && (effectiveClaudeSessionId || effectiveGeminiSessionId || effectiveCodexSessionId);
  const timelineSessionId = effectiveCodexSessionId && effectiveCommandType === 'codex'
    ? effectiveCodexSessionId
    : effectiveGeminiSessionId && effectiveCommandType === 'gemini'
      ? effectiveGeminiSessionId
      : effectiveClaudeSessionId;
  const timelineToolType = (effectiveCodexSessionId && effectiveCommandType === 'codex'
    ? 'codex'
    : effectiveGeminiSessionId && effectiveCommandType === 'gemini'
      ? 'gemini'
      : 'claude') as 'claude' | 'gemini' | 'codex';
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
          toolType: timelineToolType,
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
    isTurnBusy: effectiveAiBusy,
    isVisible: workspaceView === 'workspace' && currentView === 'terminal',
    historySurfaceVisible: historyIsPrimary,
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
    workspaceView,
    currentView,
    historyIsPrimary,
  ]);
  const historyToolType = historyIsPrimary ? (primaryHistoryTool as 'claude' | 'codex') : timelineToolType;
  const historySessionId = historyIsPrimary
    ? (historyToolType === 'codex' ? effectiveCodexSessionId : effectiveClaudeSessionId)
    : timelineSessionId;
  const shouldRenderHistoryPanel = !!effectiveTab
    && currentView === 'terminal'
    && (historyIsPrimary || ((isHistoryOpen || historyMounted) && !!historySessionId));
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
  const deferredHistoryOwner = useDeferredValue(historyOwnerIdentity);

  if (!activeProject || !activeProjectId || !currentProject) {
    console.warn('[Workspace:EARLY_RETURN] Empty workspace!', { activeProject: !!activeProject, activeProjectId, currentProject: !!currentProject });
    return <div className="flex-1 bg-bg-main" />;
  }

  // Get current tab's cwd for FileExplorer (fallback to project path).
  const explorerPath = resolvedExplorerPath || rawExplorerPath || projectRootPath;

  const historyPanelNode = deferredHistoryOwner ? (
    <HistoryPanel
      tabId={deferredHistoryOwner.tabId}
      sessionId={deferredHistoryOwner.sessionId}
      cwd={deferredHistoryOwner.cwd}
      width={historyPanelWidth}
      notesPanelWidth={notesPanelWidth}
      isOpen={historyIsPrimary || isHistoryOpen}
      toolType={deferredHistoryOwner.toolType}
      enableClaudePtyControls={deferredHistoryOwner.enableControls}
      embedded={historyIsPrimary || historyPinned}
      embeddedFill={historyIsPrimary}
      mainSurface={historyIsPrimary}
      projectId={activeProjectId}
      terminalOpen={historyIsPrimary && floatingTerminalOpen}
      onToggleTerminal={historyIsPrimary ? toggleFloatingTerminal : undefined}
      lifecycleStatus={historyIsPrimary ? agentLifecycleStatus : null}
      onControlsHeightChange={historyIsPrimary ? handleHistoryControlsHeight : undefined}
    />
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
      {/* TOP ROW: ProjectToolbar — full width across all columns.
          Divider под тулбаром НЕ здесь — он рендерится внутри TabSidebar, чтобы линия
          обрывалась на границе сайдбара и не уходила в область терминала. */}
      <div className="h-[30px] shrink-0">
        <ProjectToolbar isSystemProject={isInboxProject} />
      </div>

      {/* MAIN ROW: TabSidebar | Terminal. */}
      <div className="flex-1 flex min-h-0 relative">
      {/* LEFT COLUMN: vertical tab sidebar */}
      <TabSidebar projectId={activeProjectId} />

      {/* CENTER COLUMN: Terminal/Home Area (no more TabBar above it) */}
      <div className="flex-1 flex flex-col min-w-0 relative">

        <div className="flex-1 flex flex-col min-w-0 relative">
          {/* Terminal Area — Timeline + HistoryPanel are constrained to this height */}
          <div className="flex-1 flex min-w-0 relative">
          {/* Vertical stack [Terminal content | ClaudeControlBar] — bar lives below
              the terminal area only, NOT under Timeline (Timeline sits to the right
              of this column and spans the full row height). */}
          <div className="flex-1 flex flex-col min-w-0">
          {/* Terminal content — overflow hidden clips HistoryPanel slide animation */}
          <div className="flex-1 relative min-w-0 overflow-hidden">
            {historyIsPrimary && historyPanelNode}

            <FloatingTerminalFrame
              tabId={effectiveTab?.id || null}
              floating={historyIsPrimary}
              open={!historyIsPrimary || floatingTerminalOpen}
              bottomInset={historyIsPrimary ? historyControlsHeight : 0}
              onClose={closeFloatingTerminal}
              searchNode={terminalSearchNode}
            >
              <TerminalArea
                projectId={activeProjectId}
                terminalPresented={!historyIsPrimary || floatingTerminalOpen}
                promptQueuePortalHostId={historyIsPrimary ? promptQueuePortalHostId : undefined}
                hidePromptQueueHistoryToggle={historyIsPrimary}
                promptQueueInputSurface={historyIsPrimary ? 'history' : 'terminal'}
                suppressLifecycleOverlays={historyIsPrimary}
                onLifecycleStatusChange={handleLifecycleStatusChange}
              />
            </FloatingTerminalFrame>

            {historyIsPrimary && (
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
                  zIndex: 120,
                  pointerEvents: 'none',
                }}
              />
            )}

            {effectiveTab && currentView === 'terminal' && (
              <TabTaskPlanPanel
                tabId={effectiveTab.id}
                projectPath={currentProject.path}
                inputSurface={historyIsPrimary ? 'history' : effectiveTabType === 'claude-sdk' ? 'sdk' : 'terminal'}
                commandType={effectiveCommandType}
              />
            )}

            {/* File Preview Overlay */}
            {filePreview && <FilePreview />}

            {/* History Panel — overlay unless History pin mode is enabled. */}
            {!historyIsPrimary && !historyPinned && historyPanelNode}
          </div>

          {/* Claude control bar — Provider/Model/Effort/Think + Ctx meter +
              SessionActionChip (Start/Continue/Stop). Visible on every Terminal
              column (any tabType except 'browser'). Without a live AI session
              the bar dims the right cluster and shows a Start-capable chip so
              the user can spawn Claude from any terminal. */}
          {effectiveTab && currentView === 'terminal' && effectiveTabType !== 'browser' && effectiveTabType !== 'file' && (
            <ClaudeControlBar
              tabId={effectiveTab.id}
              projectId={activeProjectId}
              historyIsPrimary={historyIsPrimary}
              claudeSessionId={effectiveClaudeSessionId}
              geminiSessionId={effectiveGeminiSessionId}
              codexSessionId={effectiveCodexSessionId}
              commandType={effectiveCommandType}
              isCommandRunning={isCommandRunning}
              projectPath={currentProject.path}
            />
          )}
          </div>

          {!historyIsPrimary && historyPinned && historyPanelNode}

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
        {currentView === 'home' && (
          <div className="absolute inset-0 z-50 bg-bg-main border-r border-border-main">
            <ProjectHome projectId={activeProjectId} />
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
          <div data-sidebar-portal style={{ position: 'fixed', left: 0, top: 70, bottom: 0, width: effectiveSidebarWidth, zIndex: 2147482000, borderRight: '1px solid #333', boxShadow: '4px 0 20px rgba(0,0,0,0.5)' }}>
            <Sidebar
              key={activeProjectId}
              folderPath={explorerPath}
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
