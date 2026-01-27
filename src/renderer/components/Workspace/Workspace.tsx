import React, { useCallback, useEffect, useState, useRef } from 'react';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';
import { useProjectsStore } from '../../store/useProjectsStore';
import { useUIStore } from '../../store/useUIStore';
import { terminalRegistry } from '../../utils/terminalRegistry';
import TabBar from './TabBar';
import TerminalArea from './TerminalArea';
import Timeline from './Timeline';
import NotesPanel from './NotesPanel';
import FileExplorer from './FileExplorer';
import FilePreview from './FilePreview';
import Resizer from './Resizer';
import ResearchSheet from '../Research/ResearchSheet';
import NotesEditorModal from './NotesEditorModal';

const { ipcRenderer } = window.require('electron');

export default function Workspace() {
  const { activeProjectId, getActiveProject } = useWorkspaceStore();
  const { projects } = useProjectsStore();
  const { filePreview, openNotesEditor, notesEditorOpen } = useUIStore();
  const [showSearch, setShowSearch] = useState(false);
  const [searchText, setSearchText] = useState('');
  const [searchResults, setSearchResults] = useState({ resultIndex: 0, resultCount: 0 });
  const [isCommandRunning, setIsCommandRunning] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const activeProject = getActiveProject();
  const currentProject = activeProjectId ? projects[activeProjectId] : null;

  // Get active tab early for process checking
  const activeTab = activeProject?.activeTabId
    ? activeProject.tabs.get(activeProject.activeTabId)
    : null;

  // Listen for OSC 133 command lifecycle events (Shell Integration)
  useEffect(() => {
    if (!activeTab?.id) return;

    const handleCommandStarted = (_: any, data: { tabId: string }) => {
      if (data.tabId === activeTab.id) {
        setIsCommandRunning(true);
      }
    };

    const handleCommandFinished = (_: any, data: { tabId: string; exitCode: number }) => {
      if (data.tabId === activeTab.id) {
        setIsCommandRunning(false);
      }
    };

    ipcRenderer.on('terminal:command-started', handleCommandStarted);
    ipcRenderer.on('terminal:command-finished', handleCommandFinished);

    // Get initial state
    ipcRenderer.invoke('terminal:getCommandState', activeTab.id).then((state: any) => {
      setIsCommandRunning(state?.isRunning || false);
    });

    return () => {
      ipcRenderer.removeListener('terminal:command-started', handleCommandStarted);
      ipcRenderer.removeListener('terminal:command-finished', handleCommandFinished);
    };
  }, [activeTab?.id]);

  // Handle resize callback for terminal refit
  const handleResize = useCallback(() => {
    // Terminal will auto-refit via ResizeObserver
  }, []);

  // CMD+E hotkey to open notes editor
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.metaKey && e.key === 'e' && !notesEditorOpen && activeProjectId) {
        e.preventDefault();
        openNotesEditor(activeProjectId);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [activeProjectId, notesEditorOpen, openNotesEditor]);

  // CMD+F hotkey for terminal search
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
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
        if (activeTab?.id) {
          terminalRegistry.clearSearch(activeTab.id);
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [showSearch, activeTab?.id]);

  // Handle search
  const handleSearch = useCallback((text: string) => {
    setSearchText(text);
    if (!activeTab?.id || !text.trim()) {
      if (activeTab?.id) {
        terminalRegistry.clearSearch(activeTab.id);
      }
      return;
    }
    terminalRegistry.searchAndScroll(activeTab.id, text);
  }, [activeTab?.id]);

  // Handle keyboard in search
  const handleSearchKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (!activeTab?.id || !searchText.trim()) return;

    if (e.key === 'Enter') {
      e.preventDefault();
      if (e.shiftKey) {
        // Shift+Enter = find previous
        terminalRegistry.findPrevious(activeTab.id, searchText);
      } else {
        // Enter = find next
        terminalRegistry.findNext(activeTab.id, searchText);
      }
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      if (e.key === 'ArrowUp') {
        terminalRegistry.findPrevious(activeTab.id, searchText);
      } else {
        terminalRegistry.findNext(activeTab.id, searchText);
      }
    }
  }, [activeTab?.id, searchText]);

  // Find next/previous handlers for buttons
  const handleFindNext = useCallback(() => {
    if (activeTab?.id && searchText.trim()) {
      terminalRegistry.findNext(activeTab.id, searchText);
    }
  }, [activeTab?.id, searchText]);

  const handleFindPrevious = useCallback(() => {
    if (activeTab?.id && searchText.trim()) {
      terminalRegistry.findPrevious(activeTab.id, searchText);
    }
  }, [activeTab?.id, searchText]);

  // Subscribe to search results
  useEffect(() => {
    if (!activeTab?.id || !showSearch) return;

    terminalRegistry.onSearchResults(activeTab.id, (results) => {
      setSearchResults(results);
    });

    return () => {
      if (activeTab?.id) {
        terminalRegistry.offSearchResults(activeTab.id);
      }
    };
  }, [activeTab?.id, showSearch]);

  // Tab creation is now handled in useWorkspaceStore.openProject()

  if (!activeProject || !activeProjectId || !currentProject) {
    return <div className="flex-1 bg-bg-main" />;
  }

  // Get current tab's cwd for FileExplorer (fallback to project path)
  const explorerPath = activeTab?.cwd || currentProject.path;

  // Get Claude session ID for Timeline
  const claudeSessionId = activeTab?.claudeSessionId || null;

  // Show Timeline when:
  // 1. Tab has Claude session (commandType='claude' and sessionId exists)
  // 2. A command is currently running (detected via OSC 133 Shell Integration)
  const showTimeline = !filePreview && claudeSessionId && activeTab?.commandType === 'claude' && isCommandRunning;

  return (
    <div className="flex-1 flex flex-col h-full overflow-hidden relative">
      <TabBar projectId={activeProjectId} />

      <div className="flex-1 flex overflow-hidden min-h-0">
        {/* Main Terminal Area with FilePreview overlay */}
        <div className="flex-1 relative min-w-0">
          <TerminalArea projectId={activeProjectId} />

          {/* Search Bar (Cmd+F) */}
          {showSearch && (
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

              {/* Results count */}
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

              {/* Navigation arrows */}
              <button
                onClick={handleFindPrevious}
                disabled={searchResults.resultCount === 0}
                title="Previous (Shift+Enter)"
                style={{
                  background: 'none',
                  border: 'none',
                  color: searchResults.resultCount > 0 ? 'rgba(255, 255, 255, 0.7)' : 'rgba(255, 255, 255, 0.3)',
                  cursor: searchResults.resultCount > 0 ? 'pointer' : 'default',
                  fontSize: '12px',
                  padding: '2px 4px'
                }}
              >
                ▲
              </button>
              <button
                onClick={handleFindNext}
                disabled={searchResults.resultCount === 0}
                title="Next (Enter)"
                style={{
                  background: 'none',
                  border: 'none',
                  color: searchResults.resultCount > 0 ? 'rgba(255, 255, 255, 0.7)' : 'rgba(255, 255, 255, 0.3)',
                  cursor: searchResults.resultCount > 0 ? 'pointer' : 'default',
                  fontSize: '12px',
                  padding: '2px 4px'
                }}
              >
                ▼
              </button>

              {/* Close button */}
              <button
                onClick={() => {
                  setShowSearch(false);
                  setSearchText('');
                  setSearchResults({ resultIndex: 0, resultCount: 0 });
                  if (activeTab?.id) {
                    terminalRegistry.clearSearch(activeTab.id);
                  }
                }}
                title="Close (Escape)"
                style={{
                  background: 'none',
                  border: 'none',
                  color: 'rgba(255, 255, 255, 0.5)',
                  cursor: 'pointer',
                  fontSize: '14px',
                  padding: '2px 4px',
                  marginLeft: '4px'
                }}
              >
                ✕
              </button>
            </div>
          )}

          {/* File Preview Overlay */}
          {filePreview && <FilePreview />}

          {/* Research Sheet */}
          <ResearchSheet projectId={activeProjectId} projectPath={currentProject.path} />
        </div>

        {/* Timeline for Claude session navigation - only when Claude is running */}
        {showTimeline && (
          <Timeline
            tabId={activeTab.id}
            sessionId={claudeSessionId}
            cwd={activeTab.cwd}
          />
        )}

        {/* Resizer */}
        {!filePreview && <Resizer onResize={handleResize} />}

        {/* Notes Panel */}
        {!filePreview && (
          <NotesPanel projectId={activeProjectId} project={currentProject} />
        )}
      </div>

      {/* File Explorer - opens in current terminal's directory */}
      <FileExplorer projectPath={explorerPath} />

      {/* Notes Editor Modal */}
      <NotesEditorModal />
    </div>
  );
}
