import React, { useCallback, useEffect, useMemo, useState, useRef } from 'react';
import ReactDOM from 'react-dom';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';
import { useProjectsStore } from '../../store/useProjectsStore';
import { useUIStore } from '../../store/useUIStore';
import { terminalRegistry } from '../../utils/terminalRegistry';
import TabBar from './TabBar';
import TabSidebar from './TabSidebar';
import ProjectToolbar from './ProjectToolbar';
import ProjectHome from './ProjectHome';
import TerminalArea from './TerminalArea';
import Timeline from './Timeline';
// NotesPanel deleted — заметки переехали в TabNotesSlideout (Cmd+E).
// import NotesPanel from './NotesPanel';
import '../../utils/sidebarBridge'; // Init window.electronAPI bridge
import Sidebar from './Sidebar';
import FilePreview from './FilePreview';
// Resizer was used only by the deleted right-side NotesPanel column.
// import Resizer from './Resizer';
import TabNotesSlideout from './TabNotesSlideout';
import HistoryPanel from './HistoryPanel';
import ClaudeControlBar from './ClaudeControlBar';

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
  const getActiveProject = useWorkspaceStore((s) => s.getActiveProject);
  const getSidebarState = useWorkspaceStore((s) => s.getSidebarState);
  const setSidebarOpen = useWorkspaceStore((s) => s.setSidebarOpen);
  const setSidebarExpandedDirs = useWorkspaceStore((s) => s.setSidebarExpandedDirs);
  const setOpenFilePath = useWorkspaceStore((s) => s.setOpenFilePath);
  const createTabAfterCurrent = useWorkspaceStore((s) => s.createTabAfterCurrent);
  // Subscribe to sidebarOpen so Workspace re-renders when sidebar toggles
  const sidebarOpenForRender = useWorkspaceStore((s) => {
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
  const [showSearch, setShowSearch] = useState(false);
  const [searchText, setSearchText] = useState('');
  const [searchResults, setSearchResults] = useState({ resultIndex: 0, resultCount: 0 });
  const [isCommandRunning, setIsCommandRunning] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const activeProject = getActiveProject();
  const currentProject = activeProjectId ? projects[activeProjectId] : null;

  // Per-project currentView
  const currentView = activeProject?.currentView || 'terminal';

  const fileLinkTargets = useMemo(() => {
    if (!activeProject) return [];
    return Array.from(activeProject.tabs.values())
      .filter((tab: any) => {
        if (tab.parentTabId || tab.isUtility || tab.tabType === 'file') return false;
        return tab.tabType === 'claude-sdk' || tab.commandType === 'claude' || tab.commandType === 'codex';
      })
      .map((tab: any) => ({
        id: tab.id,
        name: tab.name || 'Untitled',
        kind: tab.commandType === 'codex' ? 'Codex' : (tab.tabType === 'claude-sdk' ? 'SDK' : 'Claude'),
      }));
  }, [activeProject]);

  const handleLinkFileToTab = useCallback(async (filePath: string, targetTabId: string) => {
    if (!activeProjectId) return;
    const workspace = useWorkspaceStore.getState().openProjects.get(activeProjectId);
    const targetTab = workspace?.tabs.get(targetTabId);
    if (!workspace || !targetTab) return;

    const fileName = path.basename(filePath);
    const fileDir = path.dirname(filePath);
    await createTabAfterCurrent(activeProjectId, fileName, targetTab.cwd || fileDir, {
      tabType: 'file',
      filePath,
      color: 'purple',
      nameSetManually: true,
      background: true,
      afterTabId: targetTabId,
      visualParentTabId: targetTabId,
      groupId: targetTab.groupId,
    } as any);
    useUIStore.getState().showToast(`Linked ${fileName}`, 'success');
  }, [activeProjectId, createTabAfterCurrent]);

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

    // Sidebar open — restore saved file only if persist toggle is on. Otherwise
    // we want a clean tree on every reopen.
    if (!sidebarPersistFile) {
      if (filePreview && filePreview.source !== 'tab') closeFilePreview();
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
  // event target lives inside [data-sidebar-portal]. We also let clicks inside the
  // file preview (it sits next to the sidebar) propagate through and close the
  // sidebar, since user wants the sidebar to behave as an overlay.
  useEffect(() => {
    if (!sidebarOpenForRender || !activeProjectId) return;
    const onDown = (e: MouseEvent) => {
      const { sidebarOverlayCloseOnClickOutside } = useUIStore.getState();
      if (!sidebarOverlayCloseOnClickOutside) return;
      const target = e.target as HTMLElement | null;
      if (!target) return;
      // Inside the sidebar itself — keep open.
      if (target.closest('[data-sidebar-portal]')) return;
      // Inside the file preview — also keep open (sidebar+preview are "linked").
      if (target.closest('[data-file-preview-root]')) return;
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

  // Listen for OSC 133 command lifecycle events (Shell Integration)
  useEffect(() => {
    if (!effectiveTab?.id) return;

    const handleCommandStarted = (_: any, data: { tabId: string }) => {
      if (data.tabId === effectiveTab.id) {
        setIsCommandRunning(true);
      }
    };

    const handleCommandFinished = (_: any, data: { tabId: string; exitCode: number }) => {
      if (data.tabId === effectiveTab.id) {
        setIsCommandRunning(false);
      }
    };

    ipcRenderer.on('terminal:command-started', handleCommandStarted);
    ipcRenderer.on('terminal:command-finished', handleCommandFinished);

    // Get initial state
    ipcRenderer.invoke('terminal:getCommandState', {
      tabId: effectiveTab.id,
      caller: 'Workspace.effectiveTabSync',
      expectedProcess: 'codex',
      allowProcessTreeLookup: effectiveCommandType === 'codex' || !!effectiveCodexSessionId,
    }).then((state: any) => {
      setIsCommandRunning(state?.isRunning || false);
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

  // CMD+E toggles the per-tab notes slide-out (the "Open" button next to
  // "ЗАМЕТКИ ВКЛАДКИ"). File-explorer sidebar is handled by Cmd+B separately.
  // Layout-agnostic via e.code='KeyE' (см. methodology/design.md::Layout-agnostic
  // shortcuts) — иначе на Cyrillic шорткат молча отвалится.
  // Раньше слот занимал Cmd+J; перенесён на Cmd+E по запросу юзера (16.05.2026).
  // Cmd+E одновременно перестал быть alias'ом на Opt+V prompt picker — picker
  // остался только на Opt+V.
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (workspaceView !== 'workspace') return;
      if (e.metaKey && !e.altKey && !e.ctrlKey && !e.shiftKey && e.code === 'KeyE' && activeTabId) {
        e.preventDefault();
        const cur = useUIStore.getState().notesPanelOpenTabs[activeTabId] ?? false;
        useUIStore.getState().setNotesPanelOpen(activeTabId, !cur);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [activeTabId, workspaceView]);

  // CMD+\ hotkey to toggle history panel
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (workspaceView !== 'workspace') return;
      const isBackslash = e.code === 'Backslash' || e.key === '\\' || e.code === 'IntlBackslash';
      if (e.metaKey && isBackslash) {
        const hasSession = effectiveClaudeSessionId || effectiveGeminiSessionId || effectiveCodexSessionId;
        if (!effectiveTab?.id || !hasSession) {
          console.warn('[Workspace:Hotkey] CMD+\\ BLOCKED: effectiveTab=' + (effectiveTab?.id || 'null') + ' cmdType=' + effectiveCommandType + ' claudeSession=' + (effectiveClaudeSessionId ? effectiveClaudeSessionId.substring(0, 8) : 'null') + ' geminiSession=' + (effectiveGeminiSessionId ? effectiveGeminiSessionId.substring(0, 8) : 'null') + ' codexSession=' + (effectiveCodexSessionId ? effectiveCodexSessionId.substring(0, 8) : 'null'));
          return;
        }
        e.preventDefault();
        const currentOpen = useUIStore.getState().historyPanelOpenTabs[effectiveTab.id] ?? false;
        console.warn('[Workspace:Hotkey] CMD+\\ toggle history: tabId=' + effectiveTab.id.substring(effectiveTab.id.length - 8) + ' ' + currentOpen + ' → ' + !currentOpen);
        if (!currentOpen && !timelinePinned) setTimelineTreeMode(effectiveTab.id, false); // unpinned Timeline conflicts with History
        setHistoryPanelOpen(effectiveTab.id, !currentOpen);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [workspaceView, effectiveTab?.id, effectiveClaudeSessionId, effectiveGeminiSessionId, effectiveCodexSessionId, effectiveCommandType, setHistoryPanelOpen, setTimelineTreeMode, timelinePinned]);

  // CMD+] hotkey to toggle timeline tree mode
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (workspaceView !== 'workspace') return;
      if (e.metaKey && e.code === 'BracketRight') {
        const hasSession =
          effectiveClaudeSessionId || effectiveGeminiSessionId || effectiveCodexSessionId;
        if (!effectiveTab?.id || !hasSession) {
          console.warn('[Workspace:Hotkey] CMD+] BLOCKED: effectiveTab=' + (effectiveTab?.id || 'null') + ' cmdType=' + effectiveCommandType + ' claudeSession=' + (effectiveClaudeSessionId ? effectiveClaudeSessionId.substring(0, 8) : 'null') + ' geminiSession=' + (effectiveGeminiSessionId ? effectiveGeminiSessionId.substring(0, 8) : 'null') + ' codexSession=' + (effectiveCodexSessionId ? effectiveCodexSessionId.substring(0, 8) : 'null'));
          return;
        }
        e.preventDefault();
        const current = useUIStore.getState().timelineTreeModeTabs[effectiveTab.id] ?? false;
        console.warn('[Workspace:Hotkey] CMD+] toggle tree: tabId=' + effectiveTab.id.substring(effectiveTab.id.length - 8) + ' ' + current + ' → ' + !current);
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
  }, [showSearch, effectiveTab?.id, workspaceView]);

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

  if (!activeProject || !activeProjectId || !currentProject) {
    console.warn('[Workspace:EARLY_RETURN] Empty workspace!', { activeProject: !!activeProject, activeProjectId, currentProject: !!currentProject });
    return <div className="flex-1 bg-bg-main" />;
  }

  // Get current tab's cwd for FileExplorer (fallback to project path)
  const explorerPath = effectiveTab?.cwd || (currentProject.path?.startsWith('__unset__') ? '' : currentProject.path);

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
  const shouldRenderHistoryPanel = (isHistoryOpen || historyMounted) && !!timelineSessionId && !!effectiveTab && currentView === 'terminal';
  const historyPanelNode = shouldRenderHistoryPanel ? (
    <HistoryPanel
      tabId={effectiveTab.id}
      sessionId={timelineSessionId}
      cwd={effectiveTab.cwd || currentProject.path}
      width={historyPanelWidth}
      notesPanelWidth={notesPanelWidth}
      isOpen={isHistoryOpen}
      toolType={timelineToolType}
      enableClaudePtyControls={(timelineToolType === 'claude' || timelineToolType === 'codex') && effectiveTabType !== 'claude-sdk'}
      embedded={historyPinned}
    />
  ) : null;

  // DEBUG: Uncomment to debug Timeline visibility
  // console.log('[Timeline Debug] showTimeline:', showTimeline, 'claudeSessionId:', claudeSessionId, 'commandType:', activeTab?.commandType, 'isRunning:', isCommandRunning);

  if ((window as any).__NOTED_RENDER_DIAG__ === true) {
    console.warn(`[Workspace:RENDER] currentView=${currentView} showTimeline=${showTimeline} activeTabId=${activeTab?.id} effectiveTabId=${effectiveTab?.id} isCommandRunning=${isCommandRunning}`);
  }

  return (
    <div className="flex-1 flex flex-col h-full overflow-hidden relative">
      {/* TOP ROW: ProjectToolbar — full width across all columns.
          Divider под тулбаром НЕ здесь — он рендерится внутри TabSidebar, чтобы линия
          обрывалась на границе сайдбара и не уходила в область терминала. */}
      <div className="h-[30px] shrink-0">
        <ProjectToolbar />
      </div>

      {/* MAIN ROW: two columns now — TabSidebar | Terminal. Right NotesPanel
          column was removed (заметки переехали в TabNotesSlideout). */}
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
            <TerminalArea projectId={activeProjectId} />

            {/* Search Bar (Cmd+F) - only in terminal view */}
            {currentView === 'terminal' && showSearch && (
              <div
                style={{
                  position: 'absolute',
                  top: '8px',
                  right: '16px',
                  zIndex: 100,
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px',
                  backgroundColor: 'rgba(40, 40, 40, 0.95)',
                  backdropFilter: 'blur(8px)',
                  border: '1px solid rgba(255, 255, 255, 0.1)',
                  borderRadius: '8px',
                  padding: '6px 10px',
                  boxShadow: '0 4px 12px rgba(0, 0, 0, 0.3)'
                }}
              >
                {/* ... search input content ... */}
                <input
                  ref={searchInputRef}
                  type="text"
                  value={searchText}
                  onChange={(e) => handleSearch(e.target.value)}
                  onKeyDown={handleSearchKeyDown}
                  placeholder="Search..."
                  style={{
                    backgroundColor: 'transparent',
                    border: 'none',
                    outline: 'none',
                    color: '#fff',
                    fontSize: '13px',
                    width: '160px'
                  }}
                />
                {searchText && (
                  <span style={{
                    fontSize: '11px',
                    color: searchResults.resultCount > 0 ? 'rgba(255, 255, 255, 0.6)' : 'rgba(255, 100, 100, 0.8)',
                    minWidth: '50px',
                    textAlign: 'center'
                  }}>
                    {searchResults.resultCount > 0
                      ? `${searchResults.resultIndex}/${searchResults.resultCount}`
                      : 'No results'}
                  </span>
                )}
                <button
                  onClick={handleFindPrevious}
                  disabled={searchResults.resultCount === 0}
                  style={{ background: 'none', border: 'none', color: searchResults.resultCount > 0 ? 'rgba(255, 255, 255, 0.7)' : 'rgba(255, 255, 255, 0.3)', cursor: searchResults.resultCount > 0 ? 'pointer' : 'default', fontSize: '12px', padding: '2px 4px' }}
                >▲</button>
                <button
                  onClick={handleFindNext}
                  disabled={searchResults.resultCount === 0}
                  style={{ background: 'none', border: 'none', color: searchResults.resultCount > 0 ? 'rgba(255, 255, 255, 0.7)' : 'rgba(255, 255, 255, 0.3)', cursor: searchResults.resultCount > 0 ? 'pointer' : 'default', fontSize: '12px', padding: '2px 4px' }}
                >▼</button>
                <button
                  onClick={() => {
                    setShowSearch(false);
                    setSearchText('');
                    setSearchResults({ resultIndex: 0, resultCount: 0 });
                    if (effectiveTab?.id) {
                      terminalRegistry.clearSearch(effectiveTab.id);
                    }
                  }}
                  style={{ background: 'none', border: 'none', color: 'rgba(255, 255, 255, 0.5)', cursor: 'pointer', fontSize: '14px', padding: '2px 4px', marginLeft: '4px' }}
                >✕</button>
              </div>
            )}

            {/* File Preview Overlay */}
            {filePreview && <FilePreview />}

            {/* History Panel — overlay unless History pin mode is enabled. */}
            {!historyPinned && historyPanelNode}
          </div>

          {/* Claude control bar — Provider/Model/Effort/Think + Ctx meter +
              SessionActionChip (Start/Continue/Stop). Visible on every Terminal
              column (any tabType except 'browser'). Without a live AI session
              the bar dims the right cluster and shows a Start-capable chip so
              the user can spawn Claude from any terminal. */}
          {effectiveTab && currentView === 'terminal' && effectiveTabType !== 'browser' && effectiveTabType !== 'file' && (
            <ClaudeControlBar
              tabId={effectiveTab.id}
              claudeSessionId={effectiveClaudeSessionId}
              geminiSessionId={effectiveGeminiSessionId}
              codexSessionId={effectiveCodexSessionId}
              commandType={effectiveCommandType}
              isCommandRunning={isCommandRunning}
              projectPath={currentProject.path}
            />
          )}
          </div>

          {historyPinned && historyPanelNode}

          {/* Timeline — inside terminal row so it only spans terminal height */}
          {showTimeline && (
            <Timeline
              tabId={effectiveTab.id}
              sessionId={timelineSessionId}
              cwd={effectiveTab.cwd || currentProject.path}
              isActive={isCommandRunning}
              isVisible={workspaceView === 'workspace' && currentView === 'terminal'}
              isOpen={true}
              toolType={timelineToolType}
              pinned={timelinePinned}
            />
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

      {/* Right NotesPanel column removed — заметки переехали в TabNotesSlideout
          (открывается по Cmd+E или по клику кнопки в активной вкладке TabSidebar).
          InfoPanel (project Info содержимое) тоже больше не рендерится постоянно —
          его прежний правый сайдбар удалён вместе с NotesPanel'ом. */}

      </div>{/* /MAIN ROW */}

      {/* Global Overlays */}
      {/* Sidebar File Explorer - opens in current terminal's directory */}
      {(() => {
        if (!sidebarOpenForRender || !explorerPath) return null;
        const { sidebarExpandedDirs } = getSidebarState(activeProjectId);
        const sidebarWidth = useUIStore.getState().sidebarWidth || 280;
        return ReactDOM.createPortal(
          <div data-sidebar-portal style={{ position: 'fixed', left: 0, top: 70, bottom: 0, width: sidebarWidth, zIndex: 99999, borderRight: '1px solid #333', boxShadow: '4px 0 20px rgba(0,0,0,0.5)' }}>
            <Sidebar
              folderPath={explorerPath}
              width={sidebarWidth}
              fontSize={useUIStore.getState().sidebarFontSize || 13}
              onFocus={() => {}}
              onCollapse={() => setSidebarOpen(activeProjectId, false)}
              activeFilePath={filePreview?.path || null}
              initialExpandedDirs={sidebarExpandedDirs}
              onExpandedDirsChange={(expandedDirs: Record<string, boolean>) => setSidebarExpandedDirs(activeProjectId, expandedDirs)}
              linkTargets={fileLinkTargets}
              onLinkFile={handleLinkFileToTab}
              onFileSelect={(filePath: string, isDir: boolean) => {
                if (!isDir) {
                  if (filePreview?.path === filePath) {
                    useUIStore.getState().closeFilePreview();
                    setOpenFilePath(activeProjectId, null);
                  } else {
                    const ipc = window.require('electron').ipcRenderer;
                    ipc.invoke('file:read', filePath).then((result: any) => {
                      if (result?.success) {
                        const ext = filePath.split('.').pop()?.toLowerCase() || '';
                        openFilePreview({ path: filePath, content: result.content, language: ext, source: 'sidebar' });
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

      {/* Per-tab Notes slide-out — binds to whichever tab is flagged in
          useUIStore.notesPanelOpenTabs (one-at-a-time). Doesn't need activeTabId
          prop since opening on a non-active tab is now a supported gesture. */}
      <TabNotesSlideout />

    </div>
  );
}
