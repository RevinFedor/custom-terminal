import React, { memo, useMemo, useEffect, useState, useRef } from 'react';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';
import { useProjectsStore } from '../../store/useProjectsStore';
import Terminal from './Terminal';
import BrowserTab from './BrowserTab';
import { motion, AnimatePresence } from 'framer-motion';

const { ipcRenderer } = window.require('electron');

// Overlay for interrupted Claude sessions
const InterruptedSessionOverlay = memo(({ tabId, sessionId, onContinue, onDismiss }: {
  tabId: string;
  sessionId: string;
  onContinue: () => void;
  onDismiss: () => void;
}) => {
  const [isLoading, setIsLoading] = useState(false);

  // Handle backdrop click
  const handleBackdropClick = (e: React.MouseEvent) => {
    console.log('[InterruptedOverlay] Backdrop click, isLoading:', isLoading, 'tabId:', tabId);
    e.stopPropagation();
    if (!isLoading) {
      console.log('[InterruptedOverlay] Calling onDismiss');
      onDismiss();
    }
  };

  // Handle continue click - disable after first click
  const handleContinueClick = (e: React.MouseEvent) => {
    console.log('[InterruptedOverlay] Continue click, isLoading:', isLoading, 'tabId:', tabId, 'sessionId:', sessionId);
    e.stopPropagation();
    if (isLoading) {
      console.log('[InterruptedOverlay] Already loading, ignoring');
      return;
    }
    console.log('[InterruptedOverlay] Setting isLoading=true, calling onContinue');
    setIsLoading(true);
    onContinue();
  };

  // Handle close button click
  const handleCloseClick = (e: React.MouseEvent) => {
    console.log('[InterruptedOverlay] Close button click, isLoading:', isLoading, 'tabId:', tabId);
    e.stopPropagation();
    if (!isLoading) {
      console.log('[InterruptedOverlay] Calling onDismiss');
      onDismiss();
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="absolute inset-0 z-50 flex items-center justify-center"
      onClick={handleBackdropClick}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      {/* Semi-transparent backdrop */}
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm pointer-events-none" />

      {/* Modal */}
      <motion.div
        initial={{ scale: 0.95, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        exit={{ scale: 0.95, opacity: 0 }}
        className="relative bg-panel border border-border-main rounded-xl shadow-2xl p-6 max-w-sm mx-4 z-10"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Close button */}
        <button
          className="absolute top-3 right-3 text-[#666] hover:text-white text-xl leading-none w-6 h-6 flex items-center justify-center rounded hover:bg-white/10 disabled:opacity-50"
          onClick={handleCloseClick}
          disabled={isLoading}
        >
          ×
        </button>

        {/* Icon */}
        <div className="w-12 h-12 rounded-full bg-yellow-500/20 flex items-center justify-center mb-4 mx-auto">
          <span className="text-2xl">⚠️</span>
        </div>

        {/* Title */}
        <h3 className="text-white text-center font-medium mb-2">
          Сессия была прервана
        </h3>

        {/* Description */}
        <p className="text-[#888] text-sm text-center mb-4">
          Приложение было закрыто во время активной Claude сессии
        </p>

        {/* Session ID */}
        <div className="bg-[#1a1a1a] rounded-lg p-2 mb-4">
          <code className="text-[10px] text-[#666] break-all">{sessionId}</code>
        </div>

        {/* Continue button */}
        <button
          className="w-full bg-accent hover:bg-accent/80 disabled:bg-accent/50 disabled:cursor-not-allowed text-white py-2.5 px-4 rounded-lg font-medium text-sm transition-colors"
          onClick={handleContinueClick}
          disabled={isLoading}
        >
          {isLoading ? '⏳ Загрузка...' : '⏵ Продолжить сессию'}
        </button>

        {/* Hint */}
        <p className="text-[#555] text-[10px] text-center mt-3">
          Или нажмите на фон чтобы закрыть
        </p>
      </motion.div>
    </motion.div>
  );
});

interface TerminalAreaProps {
  projectId: string;
}

function TerminalArea({ projectId }: TerminalAreaProps) {
  // DEBUG: Track TerminalArea mount/unmount lifecycle
  useEffect(() => {
    console.warn('[TerminalArea:MOUNT] projectId=', projectId);
    return () => {
      console.warn('[TerminalArea:UNMOUNT] projectId=', projectId);
    };
  }, []);

  // Use selectors to minimize re-renders
  const openProjects = useWorkspaceStore((state) => state.openProjects);
  const createTab = useWorkspaceStore((state) => state.createTab);
  const clearInterruptedState = useWorkspaceStore((state) => state.clearInterruptedState);
  const projects = useProjectsStore((state) => state.projects);

  // DEBUG: Track render reason
  const renderCountRef = useRef(0);
  renderCountRef.current++;

  const currentWorkspace = openProjects.get(projectId);
  const currentView = currentWorkspace?.currentView || 'terminal';

  console.warn(`[TerminalArea:RENDER #${renderCountRef.current}] projectId=${projectId} currentView=${currentView} openProjects.size=${openProjects.size}`);

  const currentProject = projects[projectId];

  // Get active tab info for interrupted session overlay
  const activeTab = currentWorkspace?.activeTabId
    ? currentWorkspace.tabs.get(currentWorkspace.activeTabId)
    : null;
  const showInterruptedOverlay = activeTab?.wasInterrupted && activeTab?.claudeSessionId && currentView === 'terminal';

  
  // Handle continuing interrupted Claude session
  const handleContinueSession = (sessionId?: string) => {
    const targetSessionId = sessionId || activeTab?.claudeSessionId;
    console.log('[TerminalArea] handleContinueSession called, activeTab:', activeTab?.id, 'sessionId:', targetSessionId);

    if (activeTab?.id && targetSessionId) {
      console.log('[TerminalArea] Clearing interrupted state and sending command');
      // Clear the interrupted state
      clearInterruptedState(activeTab.id);

      // Set command type to 'claude' for Timeline visibility
      const setTabCommandType = useWorkspaceStore.getState().setTabCommandType;
      setTabCommandType(activeTab.id, 'claude');

      // Send command to terminal
      const cmd = `claude --dangerously-skip-permissions --resume ${targetSessionId}\r`;
      console.log('[TerminalArea] Sending terminal:input:', cmd);
      ipcRenderer.send('terminal:input', activeTab.id, cmd);

      // Signal command started immediately for Timeline visibility
      ipcRenderer.send('terminal:force-command-started', activeTab.id);
    } else {
      console.log('[TerminalArea] handleContinueSession: Missing activeTab or sessionId!');
    }
  };

  // Handle dismissing the interrupted overlay (clear session completely)
  const handleDismissOverlay = () => {
    console.log('[TerminalArea] handleDismissOverlay called, activeTab:', activeTab?.id);
    if (activeTab?.id) {
      console.log('[TerminalArea] Clearing Claude session completely');
      // Clear both wasInterrupted AND claudeSessionId using dismiss action that triggers re-render
      const dismissInterruptedSession = useWorkspaceStore.getState().dismissInterruptedSession;
      dismissInterruptedSession(activeTab.id);
    } else {
      console.log('[TerminalArea] handleDismissOverlay: No activeTab!');
    }
  };

  // Memoize terminal list - use stable key for comparison
  // Only rebuild when tabs actually change (add/remove), not on every state update
  const terminalKeys = useMemo(() => {
    const keys: string[] = [];
    openProjects.forEach((workspace) => {
      workspace.tabs.forEach((tab) => {
        keys.push(tab.id);
      });
    });
    return keys.join(',');
  }, [openProjects]);

  const terminals = useMemo(() => {
    console.warn('[TerminalArea:useMemo] RECALCULATING terminals. terminalKeys:', terminalKeys, 'projectId:', projectId);
    const result: React.ReactNode[] = [];

    openProjects.forEach((workspace, projId) => {
      const isActiveProject = projId === projectId;

      workspace.tabs.forEach((tab) => {
        // NOTE: currentView check moved INTO Terminal component to avoid useMemo recalculation on view switch
        const isActive = isActiveProject && workspace.activeTabId === tab.id;
        if (tab.tabType === 'browser') {
          result.push(
            <BrowserTab
              key={tab.id}
              tabId={tab.id}
              url={tab.url || 'http://localhost:3000'}
              active={isActive}
              isActiveProject={isActiveProject}
              terminalId={tab.terminalId}
              terminalName={tab.terminalName}
              activeView={tab.activeView || 'terminal'}
              cwd={tab.cwd}
            />
          );
        } else {
          result.push(
            <Terminal
              key={tab.id}
              tabId={tab.id}
              cwd={tab.cwd}
              active={isActive}
              isActiveProject={isActiveProject}
            />
          );
        }
      });
    });

    return result;
  }, [terminalKeys, projectId, openProjects]);

  // Listen for Claude fork completion to create new tab with command
  useEffect(() => {
    const handleForkComplete = async (_: any, data: { success: boolean; newSessionId?: string; cwd?: string; error?: string }) => {
      console.log('[TerminalArea] Fork complete received:', data);
      if (!data.success || !data.newSessionId || !data.cwd) {
        console.error('[TerminalArea] Fork failed:', data.error);
        return;
      }

      // Create new tab with pending command
      const pendingCommand = `claude --dangerously-skip-permissions --resume ${data.newSessionId}`;
      console.log('[TerminalArea] Creating new tab with command:', pendingCommand);

      // Find project that contains this cwd
      let targetProjectId: string | null = null;
      openProjects.forEach((workspace, projId) => {
        if (workspace.projectPath === data.cwd || data.cwd?.startsWith(workspace.projectPath)) {
          targetProjectId = projId;
        }
      });

      if (!targetProjectId) {
        // Default to current project
        targetProjectId = projectId;
      }

      // Create new tab
      await createTab(targetProjectId, 'Claude Fork', data.cwd, {
        pendingCommand,
        claudeSessionId: data.newSessionId
      });
    };

    ipcRenderer.on('claude:fork-complete', handleForkComplete);
    return () => {
      ipcRenderer.removeListener('claude:fork-complete', handleForkComplete);
    };
  }, [createTab, openProjects, projectId]);

  // Handle double-click on empty space to create new tab
  const handleDoubleClick = (e: React.MouseEvent) => {
    // Only trigger if clicking directly on the container (not on terminal)
    if (e.target === e.currentTarget && currentProject) {
      createTab(projectId, undefined, currentProject.path);
    }
  };

  // Render terminals for ALL open projects to prevent unmount/remount on project switch
  // This keeps terminal instances alive and prevents jitter
  return (
    <div
      className="absolute inset-0 bg-bg-main"
      onDoubleClick={handleDoubleClick}
    >
      {/* Render all terminals from all projects */}
      {terminals}

      {/* Interrupted session overlay */}
      <AnimatePresence>
        {showInterruptedOverlay && activeTab && (
          <InterruptedSessionOverlay
            tabId={activeTab.id}
            sessionId={activeTab.claudeSessionId!}
            onContinue={() => handleContinueSession(activeTab.claudeSessionId!)}
            onDismiss={handleDismissOverlay}
          />
        )}
      </AnimatePresence>
    </div>
  );
}

export default memo(TerminalArea);
