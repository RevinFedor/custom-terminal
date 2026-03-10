import React, { useCallback, useEffect, useMemo, useState, useRef } from 'react';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';
import { useProjectsStore } from '../../store/useProjectsStore';
import { useUIStore } from '../../store/useUIStore';
import { terminalRegistry } from '../../utils/terminalRegistry';
import TabBar from './TabBar';
import ProjectToolbar from './ProjectToolbar';
import ProjectHome from './ProjectHome';
import TerminalArea from './TerminalArea';
import Timeline from './Timeline';
import NotesPanel from './NotesPanel';
import FileExplorer from './FileExplorer';
import FilePreview from './FilePreview';
import Resizer from './Resizer';
import ResearchSheet from '../Research/ResearchSheet';
import NotesEditorModal from './NotesEditorModal';
import HistoryPanel from './HistoryPanel';
import SubAgentBar from './SubAgentBar';

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
  const workspaceView = useWorkspaceStore((s) => s.view);
  const projects = useProjectsStore((s) => s.projects);

  // Use selectors to avoid rerenders on unrelated UIStore changes
  const filePreview = useUIStore((s) => s.filePreview);
  const openFilePreview = useUIStore((s) => s.openFilePreview);
  const closeFilePreview = useUIStore((s) => s.closeFilePreview);
  const openNotesEditor = useUIStore((s) => s.openNotesEditor);
  const notesEditorOpen = useUIStore((s) => s.notesEditorOpen);
  const notesPanelWidth = useUIStore((s) => s.notesPanelWidth);
  const historyPanelOpenTabs = useUIStore((s) => s.historyPanelOpenTabs);
  const historyPanelWidth = useUIStore((s) => s.historyPanelWidth);
  const setHistoryPanelOpen = useUIStore((s) => s.setHistoryPanelOpen);
  const timelineTreeModeTabs = useUIStore((s) => s.timelineTreeModeTabs);
  const setTimelineTreeMode = useUIStore((s) => s.setTimelineTreeMode);
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
  const effectiveCommandType = useWorkspaceStore((s) => {
    const p = s.openProjects.get(s.activeProjectId!);
    if (!p) return null;
    const tabId = p.viewingSubAgentTabId || p.activeTabId;
    const tab = tabId ? p.tabs.get(tabId) : null;
    return tab?.commandType || null;
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

  // effectiveTab: when viewing a sub-agent, resolve to that tab; otherwise fallback to activeTab
  const effectiveTab = useMemo(() => {
    if (viewingSubAgentTabId && activeProject) {
      const subTab = activeProject.tabs.get(viewingSubAgentTabId);
      if (subTab) return subTab;
    }
    return activeTab;
  }, [viewingSubAgentTabId, activeProject, activeTab]);

  // Clear search when switching between parent tab and sub-agent view
  useEffect(() => {
    setSearchText('');
    setSearchResults({ resultIndex: 0, resultCount: 0 });
    if (activeTab?.id) terminalRegistry.clearSearch(activeTab.id);
  }, [viewingSubAgentTabId]);

  // Listen for mcp:switch-to-sub-agent (triggered by clicking UUID in terminal)
  useEffect(() => {
    const handler = (_: any, data: { claudeTabId: string }) => {
      console.warn('[Workspace] mcp:switch-to-sub-agent →', data.claudeTabId);
      setViewingSubAgentTabId(data.claudeTabId);
    };
    ipcRenderer.on('mcp:switch-to-sub-agent', handler);
    return () => { ipcRenderer.removeListener('mcp:switch-to-sub-agent', handler); };
  }, []);

  // Restore file preview when switching projects
  useEffect(() => {
    if (!activeProjectId) return;

    const { openFilePath } = getSidebarState(activeProjectId);

    // Close current file preview when switching projects
    if (filePreview && filePreview.path !== openFilePath) {
      closeFilePreview();
    }

    // If project has saved open file, restore it
    if (openFilePath && (!filePreview || filePreview.path !== openFilePath)) {
      (async () => {
        try {
          const result = await ipcRenderer.invoke('file:read', openFilePath);
          if (result.success) {
            const ext = path.extname(openFilePath).toLowerCase();
            const language = detectLanguage(ext);
            openFilePreview({
              path: openFilePath,
              content: result.content,
              language
            });
          }
        } catch (e) {
          console.error('[Workspace] Failed to restore file preview:', e);
        }
      })();
    }
  }, [activeProjectId]);

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
    ipcRenderer.invoke('terminal:getCommandState', effectiveTab.id).then((state: any) => {
      setIsCommandRunning(state?.isRunning || false);
    });

    return () => {
      ipcRenderer.removeListener('terminal:command-started', handleCommandStarted);
      ipcRenderer.removeListener('terminal:command-finished', handleCommandFinished);
    };
  }, [effectiveTab?.id]);

  // Handle resize callback for terminal refit
  const handleResize = useCallback(() => {
    // Terminal will auto-refit via ResizeObserver
  }, []);

  // CMD+E hotkey to open notes editor
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Guard: don't fire when Workspace is hidden behind Dashboard
      if (workspaceView !== 'workspace') return;
      if (e.metaKey && e.key === 'e' && !notesEditorOpen && activeProjectId) {
        e.preventDefault();
        openNotesEditor(activeProjectId);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [activeProjectId, notesEditorOpen, openNotesEditor, workspaceView]);

  // CMD+\ hotkey to toggle history panel
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (workspaceView !== 'workspace') return;
      const isBackslash = e.code === 'Backslash' || e.key === '\\' || e.code === 'IntlBackslash';
      if (e.metaKey && isBackslash && effectiveTab?.id) {
        const hasSession =
          (effectiveCommandType === 'claude' && effectiveClaudeSessionId) ||
          (effectiveCommandType === 'gemini' && effectiveGeminiSessionId);
        if (hasSession) {
          e.preventDefault();
          const currentOpen = useUIStore.getState().historyPanelOpenTabs[effectiveTab.id] ?? false;
          if (!currentOpen) setTimelineTreeMode(effectiveTab.id, false); // close tree mode when opening history
          setHistoryPanelOpen(effectiveTab.id, !currentOpen);
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [workspaceView, effectiveTab?.id, effectiveClaudeSessionId, effectiveGeminiSessionId, effectiveCommandType, setHistoryPanelOpen, setTimelineTreeMode]);

  // CMD+] hotkey to toggle timeline tree mode
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (workspaceView !== 'workspace') return;
      if (e.metaKey && e.code === 'BracketRight' && effectiveTab?.id) {
        const hasSession =
          (effectiveCommandType === 'claude' && effectiveClaudeSessionId) ||
          (effectiveCommandType === 'gemini' && effectiveGeminiSessionId);
        if (hasSession) {
          e.preventDefault();
          const current = useUIStore.getState().timelineTreeModeTabs[effectiveTab.id] ?? false;
          if (!current) setHistoryPanelOpen(effectiveTab.id, false); // close history when opening tree mode
          setTimelineTreeMode(effectiveTab.id, !current);
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [workspaceView, effectiveTab?.id, effectiveClaudeSessionId, effectiveGeminiSessionId, effectiveCommandType, setTimelineTreeMode, setHistoryPanelOpen]);

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

  if (!activeProject || !activeProjectId || !currentProject) {
    console.warn('[Workspace:EARLY_RETURN] Empty workspace!', { activeProject: !!activeProject, activeProjectId, currentProject: !!currentProject });
    return <div className="flex-1 bg-bg-main" />;
  }

  // Get current tab's cwd for FileExplorer (fallback to project path)
  const explorerPath = effectiveTab?.cwd || (currentProject.path?.startsWith('__unset__') ? '' : currentProject.path);

  // Session IDs come from fine-grained selectors (top of component) — not effectiveTab.
  // This ensures Workspace re-renders when Bridge updates session ID via set({}).
  const showTimeline = !filePreview && (
    (effectiveClaudeSessionId && effectiveCommandType === 'claude') ||
    (effectiveGeminiSessionId && effectiveCommandType === 'gemini')
  );
  const timelineSessionId = effectiveCommandType === 'gemini' ? effectiveGeminiSessionId : effectiveClaudeSessionId;
  const timelineToolType = (effectiveCommandType === 'gemini' ? 'gemini' : 'claude') as 'claude' | 'gemini';

  // DEBUG: Uncomment to debug Timeline visibility
  // console.log('[Timeline Debug] showTimeline:', showTimeline, 'claudeSessionId:', claudeSessionId, 'commandType:', activeTab?.commandType, 'isRunning:', isCommandRunning);

  // Per-tab history panel state
  const isHistoryOpen = effectiveTab?.id ? (historyPanelOpenTabs[effectiveTab.id] ?? false) : false;

  // Delayed unmount for slide-out animation (keep mounted 200ms after close)
  const [historyMounted, setHistoryMounted] = useState(false);
  useEffect(() => {
    if (isHistoryOpen) {
      setHistoryMounted(true);
    } else if (historyMounted) {
      const timer = setTimeout(() => setHistoryMounted(false), 60);
      return () => clearTimeout(timer);
    }
  }, [isHistoryOpen]);

  // DEBUG: Track state changes
  console.warn(`[Workspace:RENDER] currentView=${currentView} showTimeline=${showTimeline} activeTabId=${activeTab?.id} effectiveTabId=${effectiveTab?.id} isCommandRunning=${isCommandRunning}`);

  return (
    <div className="flex-1 flex h-full overflow-hidden relative">
      {/* LEFT COLUMN: Tabs + Terminal/Home Area */}
      <div className="flex-1 flex flex-col min-w-0 relative">
        {/* TabBar Row */}
        <div className="h-[30px] border-b border-border-main">
          <TabBar projectId={activeProjectId} />
        </div>

        {/* Sub-agent bar (visible when Gemini tab has Claude sub-agents) */}
        {activeProjectId && (
          <SubAgentBar projectId={activeProjectId} />
        )}

        {/* Terminal Area — Timeline + HistoryPanel are constrained to this height */}
        <div className="flex-1 flex min-w-0 relative">
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

            {/* Research Sheet */}
            <ResearchSheet projectId={activeProjectId} projectPath={currentProject.path} />

            {/* History Panel — absolute overlay within terminal area only */}
            {(isHistoryOpen || historyMounted) && timelineSessionId && effectiveTab && currentView === 'terminal' && (
              <HistoryPanel
                tabId={effectiveTab.id}
                sessionId={timelineSessionId}
                cwd={effectiveTab.cwd || currentProject.path}
                width={historyPanelWidth}
                notesPanelWidth={notesPanelWidth}
                isOpen={isHistoryOpen}
                toolType={timelineToolType}
              />
            )}
          </div>

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
            />
          )}
        </div>

        {/* Project Home - Overlay AFTER TabBar+TerminalArea to keep children indices stable */}
        {/* Uses absolute positioning so visual order is unaffected */}
        {currentView === 'home' && (
          <div className="absolute inset-0 z-50 bg-bg-main border-r border-border-main">
            <ProjectHome projectId={activeProjectId} />
          </div>
        )}
      </div>

      {/* RIGHT COLUMN: Toolbar + Notes + Resizer */}
      <div className="flex flex-col shrink-0 overflow-hidden relative border-l border-border-main" style={{ width: notesPanelWidth }}>
        {/* ProjectToolbar Row — aligned with TabBar */}
        <div className="h-[30px] border-b border-border-main">
          <ProjectToolbar />
        </div>

        {/* Bottom Row: Resizer + Notes Panel */}
        <div className="flex-1 flex overflow-hidden">
          <Resizer onResize={handleResize} />
          <div className="flex-1 overflow-hidden relative">
            {!filePreview && (
              <NotesPanel projectId={activeProjectId} project={currentProject} />
            )}
          </div>
        </div>
      </div>

      {/* Global Overlays */}
      {/* File Explorer - opens in current terminal's directory */}
      <FileExplorer projectPath={explorerPath} projectId={activeProjectId} />

      {/* Notes Editor Modal */}
      <NotesEditorModal />

    </div>
  );
}
