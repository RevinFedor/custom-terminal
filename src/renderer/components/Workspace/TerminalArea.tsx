import React, { memo, useMemo, useEffect, useState } from 'react';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';
import { useProjectsStore } from '../../store/useProjectsStore';
import Terminal from './Terminal';
import EmptyTerminalPlaceholder from './EmptyTerminalPlaceholder';
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
    e.stopPropagation();
    if (!isLoading) onDismiss();
  };

  // Handle continue click - disable after first click
  const handleContinueClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (isLoading) return; // Prevent double click
    setIsLoading(true);
    onContinue();
  };

  // Handle close button click
  const handleCloseClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!isLoading) onDismiss();
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
  // Use selectors to minimize re-renders
  const openProjects = useWorkspaceStore((state) => state.openProjects);
  const createTab = useWorkspaceStore((state) => state.createTab);
  const clearInterruptedState = useWorkspaceStore((state) => state.clearInterruptedState);
  const projects = useProjectsStore((state) => state.projects);

  const currentWorkspace = openProjects.get(projectId);
  const currentProject = projects[projectId];

  // Get active tab info for interrupted session overlay
  const activeTab = currentWorkspace?.activeTabId
    ? currentWorkspace.tabs.get(currentWorkspace.activeTabId)
    : null;
  const showInterruptedOverlay = activeTab?.wasInterrupted && activeTab?.claudeSessionId;

  // Check if active project has no active Main tab
  const hasActiveMainTab = currentWorkspace?.activeTabId != null;

  const handleCreateTab = () => {
    console.log('[TerminalArea] handleCreateTab called, currentProject:', currentProject?.name);
    if (currentProject) {
      console.log('[TerminalArea] Creating tab for project:', projectId, 'path:', currentProject.path);
      createTab(projectId, undefined, currentProject.path);
    } else {
      console.log('[TerminalArea] No currentProject, cannot create tab');
    }
  };

  // Handle continuing interrupted Claude session
  const handleContinueSession = () => {
    if (activeTab?.id && activeTab?.claudeSessionId) {
      // Clear the interrupted state
      clearInterruptedState(activeTab.id);
      // Send command to terminal
      ipcRenderer.send('terminal:input', activeTab.id, `claude --dangerously-skip-permissions --resume ${activeTab.claudeSessionId}\r`);
    }
  };

  // Handle dismissing the interrupted overlay (clear session completely)
  const handleDismissOverlay = () => {
    if (activeTab?.id) {
      // Clear both wasInterrupted AND claudeSessionId
      // This prevents the overlay from appearing again on next restart
      const clearClaudeSession = useWorkspaceStore.getState().clearClaudeSession;
      clearClaudeSession(activeTab.id);
    }
  };

  // Memoize terminal list to prevent unnecessary re-renders
  const terminals = useMemo(() => {
    const result: React.ReactNode[] = [];

    console.log('[TerminalArea] Building terminal list, openProjects:', openProjects.size, 'current projectId:', projectId);

    openProjects.forEach((workspace, projId) => {
      const isActiveProject = projId === projectId;
      console.log('[TerminalArea] Project:', projId, 'isActive:', isActiveProject, 'tabs:', workspace.tabs.size, 'activeTabId:', workspace.activeTabId);

      workspace.tabs.forEach((tab) => {
        const isActive = isActiveProject && workspace.activeTabId === tab.id;
        console.log('[TerminalArea] Adding Terminal:', tab.id, 'active:', isActive, 'cwd:', tab.cwd);
        result.push(
          <Terminal
            key={tab.id}
            tabId={tab.id}
            cwd={tab.cwd}
            active={isActive}
            isActiveProject={isActiveProject}
          />
        );
      });
    });

    console.log('[TerminalArea] Total terminals:', result.length);
    return result;
  }, [openProjects, projectId]);

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
    console.log('[TerminalArea] Double click detected');
    console.log('[TerminalArea] target:', e.target);
    console.log('[TerminalArea] currentTarget:', e.currentTarget);
    console.log('[TerminalArea] target === currentTarget:', e.target === e.currentTarget);

    // Only trigger if clicking directly on the container (not on terminal)
    if (e.target === e.currentTarget) {
      console.log('[TerminalArea] Creating new tab...');
      handleCreateTab();
    }
  };

  // Render terminals for ALL open projects to prevent unmount/remount on project switch
  // This keeps terminal instances alive and prevents jitter
  return (
    <div
      className="absolute inset-0 bg-bg-main"
      onDoubleClick={handleDoubleClick}
    >
      {/* Show placeholder when no active tab */}
      {!hasActiveMainTab && currentProject && (
        <EmptyTerminalPlaceholder
          projectName={currentProject.name}
          onCreateTab={handleCreateTab}
        />
      )}

      {/* Render all terminals from all projects */}
      {terminals}

      {/* Interrupted session overlay */}
      <AnimatePresence>
        {showInterruptedOverlay && activeTab && (
          <InterruptedSessionOverlay
            tabId={activeTab.id}
            sessionId={activeTab.claudeSessionId!}
            onContinue={handleContinueSession}
            onDismiss={handleDismissOverlay}
          />
        )}
      </AnimatePresence>
    </div>
  );
}

export default memo(TerminalArea);
