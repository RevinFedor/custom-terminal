import React, { memo, useCallback, useMemo, useEffect, useState, useRef } from 'react';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';
import { useProjectsStore } from '../../store/useProjectsStore';
import Terminal from './Terminal';
import BrowserTab from './BrowserTab';
import ClaudeSDKTab from './ClaudeSDK/ClaudeSDKTab';
import { motion, AnimatePresence } from 'framer-motion';
import { terminalRegistry } from '../../utils/terminalRegistry';

const { ipcRenderer } = window.require('electron');

// ========== INTERCEPTOR BADGE ==========
// Shows on sub-agent terminal viewport when Claude is busy.
// Purple = armed (response will be delivered), Red = disarmed (won't deliver).
// Clickable to toggle state.
function InterceptorBadge({ claudeTabId, interceptorState, busy }: {
  claudeTabId: string;
  interceptorState: 'armed' | 'disarmed' | null | undefined;
  busy: boolean;
}) {
  if (!busy || !interceptorState) return null;

  const isArmed = interceptorState === 'armed';
  const actionHint = isArmed ? 'Click to disarm' : 'Click to arm';
  const label = isArmed ? 'INTERCEPTOR: ON' : 'INTERCEPTOR: OFF';
  const blinkClass = isArmed ? 'animate-glow-purple' : 'animate-glow-red';

  return (
    <button
      onClick={handleClick}
      className="flex items-center gap-1.5 rounded transition-all shadow-[0_0_15px_rgba(0,0,0,0.4)]"
      style={{
        position: 'absolute',
        top: '8px',
        right: '12px',
        zIndex: 100,
        backgroundColor: isArmed ? 'rgba(180, 160, 255, 0.25)' : 'rgba(243, 139, 168, 0.25)',
        border: `2px solid ${isArmed ? '#a855f7' : '#ef4444'}`,
        color: '#ffffff',
        padding: '6px 12px',
        fontSize: '11px',
        fontWeight: 'bold',
        cursor: 'pointer',
        backdropFilter: 'blur(12px)',
        letterSpacing: '0.05em',
      }}
      title={`${label}\n${actionHint}`}
    >
      <span
        className={`w-2 h-2 rounded-full ${blinkClass}`}
        style={{
          display: 'inline-block',
          boxShadow: `0 0 8px ${isArmed ? '#a855f7' : '#ef4444'}`,
        }}
      />
      <span>{label}</span>
    </button>
  );
}

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

  // Interceptor badge: get sub-agent tab's busy + interceptor state
  // IMPORTANT: separate primitive selectors to avoid infinite re-render loop.
  // Returning a new object from useWorkspaceStore selector causes Object.is mismatch → re-render → new object → loop.
  const subAgentInterceptorState = useWorkspaceStore((s) => {
    if (!viewingSubAgentTabId) return null;
    for (const [, workspace] of s.openProjects) {
      const tab = workspace.tabs.get(viewingSubAgentTabId);
      if (tab) return tab.interceptorState ?? null;
    }
    return null;
  });
  const subAgentBusy = useWorkspaceStore((s) => {
    if (!viewingSubAgentTabId) return false;
    for (const [, workspace] of s.openProjects) {
      const tab = workspace.tabs.get(viewingSubAgentTabId);
      if (tab) return tab.claudeBusy === true;
    }
    return false;
  });
  const subAgentBadgeProps = viewingSubAgentTabId && (subAgentInterceptorState || subAgentBusy)
    ? { claudeTabId: viewingSubAgentTabId, interceptorState: subAgentInterceptorState, busy: subAgentBusy }
    : null;

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

  console.warn(`[TerminalArea:RENDER #${renderCountRef.current}] projectId=${projectId} currentView=${currentView}`);

  // Get active tab info for interrupted session overlay (targeted selectors)
  const activeTabWasInterrupted = useWorkspaceStore((s) => {
    const ws = s.openProjects.get(projectId);
    if (!ws?.activeTabId) return false;
    const tab = ws.tabs.get(ws.activeTabId);
    // SDK tabs handle resume via claude-sdk:send-message, not PTY overlay
    if (tab?.tabType === 'claude-sdk') return false;
    return !!tab?.wasInterrupted && !!tab?.claudeSessionId && !tab?.claudeActive;
  });
  const activeTabSessionId = useWorkspaceStore((s) => {
    const ws = s.openProjects.get(projectId);
    if (!ws?.activeTabId) return null;
    return ws.tabs.get(ws.activeTabId)?.claudeSessionId ?? null;
  });
  const activeTabIdForOverlay = activeTabId;
  const isRestoring = useWorkspaceStore((s) => s.isRestoring);
  const showInterruptedOverlay = activeTabWasInterrupted && activeTabSessionId && currentView === 'terminal' && !isRestoring;

  
  // Handle continuing interrupted Claude session (use fresh state from getState)
  const handleContinueSession = (sessionId?: string) => {
    const tabId = activeTabId;
    const targetSessionId = sessionId || activeTabSessionId;
    console.log('[TerminalArea] handleContinueSession called, activeTab:', tabId, 'sessionId:', targetSessionId);

    if (tabId && targetSessionId) {
      console.log('[TerminalArea] Clearing interrupted state and sending command');
      clearInterruptedState(tabId);

      const setTabCommandType = useWorkspaceStore.getState().setTabCommandType;
      setTabCommandType(tabId, 'claude');

      terminalRegistry.get(tabId)?.scrollToBottom();
      const cmd = `claude --dangerously-skip-permissions --resume ${targetSessionId}\r`;
      console.log('[TerminalArea] Sending terminal:input:', cmd);
      ipcRenderer.send('terminal:input', tabId, cmd);
      ipcRenderer.send('terminal:force-command-started', tabId);
    } else {
      console.log('[TerminalArea] handleContinueSession: Missing activeTab or sessionId!');
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

  // Stable string selector — only changes when tab IDs are added/removed (not on every state mutation)
  const terminalFingerprint = useWorkspaceStore((s) => {
    const parts: string[] = [];
    s.openProjects.forEach((workspace, projId) => {
      parts.push(`${projId}:${workspace.activeTabId}`);
      workspace.tabs.forEach((tab) => {
        parts.push(`${tab.id}:${tab.tabType || 'terminal'}`);
      });
    });
    return parts.join(',');
  });

  const terminals = useMemo(() => {
    console.warn('[TerminalArea:useMemo] RECALCULATING terminals. fingerprint:', terminalFingerprint, 'projectId:', projectId);
    const result: React.ReactNode[] = [];
    const currentOpenProjects = useWorkspaceStore.getState().openProjects;

    currentOpenProjects.forEach((workspace, projId) => {
      const isActiveProject = projId === projectId;

      workspace.tabs.forEach((tab) => {
        // NOTE: currentView check moved INTO Terminal component to avoid useMemo recalculation on view switch
        // MCP sub-agent viewport: when viewingSubAgentTabId is set, show that tab instead of the active Gemini tab
        let isActive = isActiveProject && workspace.activeTabId === tab.id;
        if (isActiveProject && viewingSubAgentTabId) {
          const viewedTab = workspace.tabs.get(viewingSubAgentTabId);
          // Only apply sub-agent override when active tab IS the parent Gemini tab
          if (viewedTab && viewedTab.parentTabId === workspace.activeTabId) {
            if (tab.id === viewingSubAgentTabId) {
              isActive = true;
            } else if (tab.id === workspace.activeTabId) {
              isActive = false; // Hide the Gemini tab, show sub-agent instead
            }
          }
        }
        if (tab.tabType === 'claude-sdk') {
          result.push(
            <ClaudeSDKTab
              key={tab.id}
              tabId={tab.id}
              active={isActive}
              isActiveProject={isActiveProject}
              cwd={tab.cwd}
            />
          );
        } else if (tab.tabType === 'browser') {
          result.push(
            <BrowserTab
              key={tab.id}
              tabId={tab.id}
              url={tab.url || 'http://localhost:3000'}
              active={isActive}
              isActiveProject={isActiveProject}
              terminalId={tab.terminalId || tab.id}
              terminalName={tab.terminalName}
              activeView={tab.activeView || 'browser'}
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
  }, [terminalFingerprint, projectId, viewingSubAgentTabId]);

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

      {/* Interceptor badge on sub-agent viewport */}
      {subAgentBadgeProps && (
        <InterceptorBadge
          claudeTabId={subAgentBadgeProps.claudeTabId}
          interceptorState={subAgentBadgeProps.interceptorState}
          busy={subAgentBadgeProps.busy}
        />
      )}

      {/* Interrupted session overlay */}
      <AnimatePresence>
        {showInterruptedOverlay && activeTabId && activeTabSessionId && (
          <InterruptedSessionOverlay
            tabId={activeTabId}
            sessionId={activeTabSessionId}
            onContinue={() => handleContinueSession(activeTabSessionId)}
            onDismiss={handleDismissOverlay}
          />
        )}
      </AnimatePresence>
    </div>
  );
}

export default memo(TerminalArea);
