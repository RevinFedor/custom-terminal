import React, { memo, useCallback, useMemo, useEffect, useState, useRef } from 'react';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';
import { useProjectsStore } from '../../store/useProjectsStore';
import Terminal from './Terminal';
import BrowserTab from './BrowserTab';
import ClaudeSDKTab from './ClaudeSDK/ClaudeSDKTab';
import { motion, AnimatePresence } from 'framer-motion';
import { terminalRegistry } from '../../utils/terminalRegistry';
import { markPendingResume } from '../../utils/pendingResume';
import { buildCodexRunPayload } from '../../utils/codexLaunch';

const { ipcRenderer } = window.require('electron');

type InterruptedEngine = 'claude' | 'codex';

// Overlay for interrupted AI sessions
const InterruptedSessionOverlay = memo(({ tabId, sessionId, engine, onContinue, onDismiss }: {
  tabId: string;
  sessionId: string;
  engine: InterruptedEngine;
  onContinue: () => void;
  onDismiss: () => void;
}) => {
  const [isLoading, setIsLoading] = useState(false);
  const engineLabel = engine === 'codex' ? 'Codex' : 'Claude';

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
          Приложение было закрыто во время активной {engineLabel} сессии
        </p>

        {/* Session ID */}
        <div className="bg-[#1a1a1a] rounded-lg p-2 mb-4">
          <code className="text-[10px] text-[#666] break-all">{sessionId}</code>
        </div>

        {/* Continue button */}
        <button
          className="w-full bg-accent hover:bg-accent/80 disabled:bg-accent/50 disabled:cursor-not-allowed text-white py-2.5 px-4 rounded-lg font-bold text-sm transition-colors flex items-center justify-center gap-2"
          onClick={handleContinueClick}
          disabled={isLoading}
        >
          {isLoading ? (
            <>
              <div className="w-2.5 h-2.5 rounded-full bg-white animate-glow-blue" />
              <span className="tracking-widest">LOADING...</span>
            </>
          ) : '⏵ ПРОДОЛЖИТЬ СЕССИЮ'}
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
  const viewingSubAgentTabId = useWorkspaceStore((s) => s.openProjects.get(projectId)?.viewingSubAgentTabId ?? null);

  // DEBUG: Track TerminalArea mount/unmount lifecycle
  useEffect(() => {
    console.warn('[TerminalArea:MOUNT] projectId=', projectId);
    return () => {
      console.warn('[TerminalArea:UNMOUNT] projectId=', projectId);
    };
  }, []);

  // Targeted selectors — avoid subscribing to entire openProjects Map
  const createTab = useWorkspaceStore((state) => state.createTab);
  const clearInterruptedState = useWorkspaceStore((state) => state.clearInterruptedState);
  const currentView = useWorkspaceStore((s) => s.openProjects.get(projectId)?.currentView || 'terminal');
  const activeTabId = useWorkspaceStore((s) => s.openProjects.get(projectId)?.activeTabId ?? null);

  // DEBUG: Track render reason
  const renderCountRef = useRef(0);
  renderCountRef.current++;

  // Check if sub-agent is actively visible (parent Gemini tab is the active tab)
  const isSubAgentVisible = useWorkspaceStore((s) => {
    if (!viewingSubAgentTabId) return false;
    const ws = s.openProjects.get(projectId);
    if (!ws?.activeTabId) return false;
    const viewedTab = ws.tabs.get(viewingSubAgentTabId);
    return !!viewedTab && viewedTab.parentTabId === ws.activeTabId;
  });

  if ((window as any).__NOTED_RENDER_DIAG__ === true) {
    console.warn(`[TerminalArea:RENDER #${renderCountRef.current}] projectId=${projectId} currentView=${currentView}`);
  }

  // Get active tab info for interrupted session overlay (targeted selectors)
  const activeTabInterruptedKey = useWorkspaceStore((s) => {
    const ws = s.openProjects.get(projectId);
    if (!ws?.activeTabId) return '';
    const tab = ws.tabs.get(ws.activeTabId);
    // SDK tabs handle resume via claude-sdk:send-message, not PTY overlay
    if (!tab || tab.tabType === 'claude-sdk' || !tab.wasInterrupted || tab.overlayDismissed) return '';
    if (tab.commandType === 'codex' && tab.codexSessionId) return `codex:${tab.codexSessionId}`;
    if (tab.claudeSessionId && !tab.claudeActive) return `claude:${tab.claudeSessionId}`;
    if (tab.codexSessionId) return `codex:${tab.codexSessionId}`;
    return '';
  });
  const [activeTabInterruptedEngine, activeTabSessionId] = useMemo(() => {
    if (!activeTabInterruptedKey) return [null, null] as [InterruptedEngine | null, string | null];
    const idx = activeTabInterruptedKey.indexOf(':');
    if (idx < 0) return [null, null] as [InterruptedEngine | null, string | null];
    return [
      activeTabInterruptedKey.slice(0, idx) as InterruptedEngine,
      activeTabInterruptedKey.slice(idx + 1),
    ];
  }, [activeTabInterruptedKey]);
  const activeTabIdForOverlay = activeTabId;
  const isRestoring = useWorkspaceStore((s) => s.isRestoring);
  const showInterruptedOverlay = !!activeTabInterruptedEngine && !!activeTabSessionId && currentView === 'terminal' && !isRestoring;

  
  // Handle continuing interrupted AI session (use fresh state from getState)
  const handleContinueSession = (sessionId?: string, engine?: InterruptedEngine | null) => {
    const tabId = activeTabId;
    const targetSessionId = sessionId || activeTabSessionId;
    const targetEngine = engine || activeTabInterruptedEngine;
    console.log('[TerminalArea] handleContinueSession called, activeTab:', tabId, 'engine:', targetEngine, 'sessionId:', targetSessionId);

    if (tabId && targetSessionId && targetEngine) {
      console.log('[TerminalArea] Clearing interrupted state and sending command');
      clearInterruptedState(tabId);

      const setTabCommandType = useWorkspaceStore.getState().setTabCommandType;
      setTabCommandType(tabId, targetEngine);

      terminalRegistry.get(tabId)?.scrollToBottom();
      terminalRegistry.get(tabId)?.focus();
      requestAnimationFrame(() => terminalRegistry.get(tabId)?.focus());

      if (targetEngine === 'codex') {
        const ws = useWorkspaceStore.getState().openProjects.get(projectId);
        const cwd = ws?.tabs.get(tabId)?.cwd;
        console.log('[TerminalArea] Sending codex:run-command codex-c:', targetSessionId);
        ipcRenderer.send('codex:run-command', buildCodexRunPayload({ tabId, command: 'codex-c', sessionId: targetSessionId, cwd }));
      } else {
        // Arm the 15s stale-bridge guard BEFORE the resume write (см.
        // fix-bridge-stale-takeover.md layer 4/5) — иначе протухший bridge.json
        // перезапишет sessionId таба в окне resume.
        markPendingResume(tabId, targetSessionId);
        const cmd = `claude --dangerously-skip-permissions --resume ${targetSessionId}\r`;
        console.log('[TerminalArea] Sending terminal:input:', cmd);
        ipcRenderer.send('terminal:input', tabId, cmd);
        ipcRenderer.send('terminal:force-command-started', tabId);
      }
    } else {
      console.log('[TerminalArea] handleContinueSession: Missing activeTab, engine or sessionId!');
    }
  };

  // Handle dismissing the interrupted overlay
  const handleDismissOverlay = () => {
    const tabId = activeTabId;
    console.log('[TerminalArea] handleDismissOverlay called, activeTab:', tabId);
    if (tabId) {
      const dismissInterruptedSession = useWorkspaceStore.getState().dismissInterruptedSession;
      dismissInterruptedSession(tabId);
    }
  };

  // Stable string selector — re-renders only when tab structure changes.
  // Active-tab state is local to Terminal/BrowserTab/ClaudeSDKTab; including
  // activeTabId here recreates all persistent terminal layers on every tab click.
  const terminalFingerprint = useWorkspaceStore((s) => {
    const parts: string[] = [];
    s.openProjects.forEach((workspace, projId) => {
      const subAgentPart = projId === projectId && workspace.viewingSubAgentTabId
        ? `:sub=${workspace.viewingSubAgentTabId}:host=${workspace.activeTabId || ''}`
        : '';
      parts.push(`${projId}${subAgentPart}`);
      workspace.tabs.forEach((tab) => {
        parts.push(`${tab.id}:${tab.tabType || 'terminal'}`);
      });
    });
    return parts.join(',');
  });

  const terminals = useMemo(() => {
    const t0 = Date.now();
    const result: React.ReactNode[] = [];
    const currentOpenProjects = useWorkspaceStore.getState().openProjects;
    let sdkCount = 0;
    let totalCount = 0;

    currentOpenProjects.forEach((workspace, projId) => {
      workspace.tabs.forEach((tab) => {
        if (tab.tabType === 'claude-sdk') {
          sdkCount++;
          totalCount++;
          result.push(
            <ClaudeSDKTab
              key={tab.id}
              tabId={tab.id}
              cwd={tab.cwd}
              ownerProjectId={projId}
            />
          );
        } else if (tab.tabType === 'browser') {
          result.push(
            <BrowserTab
              key={tab.id}
              tabId={tab.id}
              url={tab.url || 'http://localhost:3000'}
              ownerProjectId={projId}
              terminalId={tab.terminalId || tab.id}
              terminalName={tab.terminalName}
              activeView={tab.activeView || 'browser'}
              cwd={tab.cwd}
            />
          );
        } else if (tab.tabType === 'file') {
          totalCount++;
          // Linked file tabs render through the global FilePreview overlay in Workspace.
          // They are real tabs for grouping/DnD/status, but they have no PTY layer.
          return;
        } else {
          totalCount++;
          result.push(
            <Terminal
              key={tab.id}
              tabId={tab.id}
              cwd={tab.cwd}
              ownerProjectId={projId}
            />
          );
        }
      });
    });

    const durMs = Date.now() - t0;
    console.warn(`[TerminalArea:useMemo] RECALCULATING projectId=${projectId.slice(-12)} total=${totalCount} sdk=${sdkCount} durMs=${durMs}`);
    return result;
  }, [terminalFingerprint, projectId]);

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

      // Find project that contains this cwd (read fresh state)
      const currentOpenProjects = useWorkspaceStore.getState().openProjects;
      let targetProjectId: string | null = null;
      currentOpenProjects.forEach((workspace, projId) => {
        if (workspace.projectPath === data.cwd || data.cwd?.startsWith(workspace.projectPath)) {
          targetProjectId = projId;
        }
      });

      if (!targetProjectId) {
        targetProjectId = projectId;
      }

      await createTab(targetProjectId, 'Claude Fork', data.cwd, {
        pendingCommand,
        claudeSessionId: data.newSessionId
      });
    };

    ipcRenderer.on('claude:fork-complete', handleForkComplete);
    return () => {
      ipcRenderer.removeListener('claude:fork-complete', handleForkComplete);
    };
  }, [createTab, projectId]);

  // Handle double-click on empty space to create new tab
  const handleDoubleClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      const project = useProjectsStore.getState().projects[projectId];
      if (project) createTab(projectId, undefined, project.path);
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

      {/* Orange border overlay when viewing sub-agent */}
      {isSubAgentVisible && (
        <div
          className="absolute inset-0 pointer-events-none"
          style={{
            boxShadow: 'inset 0 0 0 2px rgba(204, 120, 50, 0.4)',
            borderRadius: '4px',
            zIndex: 10,
          }}
        />
      )}

      {/* Interrupted session overlay */}
      <AnimatePresence>
        {showInterruptedOverlay && activeTabId && activeTabSessionId && (
          <InterruptedSessionOverlay
            tabId={activeTabId}
            sessionId={activeTabSessionId}
            engine={activeTabInterruptedEngine || 'claude'}
            onContinue={() => handleContinueSession(activeTabSessionId, activeTabInterruptedEngine)}
            onDismiss={handleDismissOverlay}
          />
        )}
      </AnimatePresence>
    </div>
  );
}

export default memo(TerminalArea);
