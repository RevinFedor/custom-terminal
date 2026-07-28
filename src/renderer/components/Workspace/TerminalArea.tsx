import React, { memo, useCallback, useMemo, useEffect, useState, useRef } from 'react';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';
import { useProjectsStore } from '../../store/useProjectsStore';
import Terminal from './Terminal';
import BrowserTab from './BrowserTab';
import ClaudeSDKTab from './ClaudeSDK/ClaudeSDKTab';
import { motion, AnimatePresence } from 'framer-motion';
import { terminalRegistry } from '../../utils/terminalRegistry';
import { clearPendingResume, markPendingResume } from '../../utils/pendingResume';
import { buildCodexRunPayload } from '../../utils/codexLaunch';
import { getHistoryAgentRuntime } from '../../utils/historyAgentRuntimes';
import {
  applyAgentLaunchPreparationSnapshot,
  applyClaudeStartupDefaultsGate,
  describeLaunchPreparationFailure,
  hideSessionStartingFromLifecycle,
  invalidateSessionStartingProbeSequence,
  isSessionStartingProbeCurrent,
  restoreClaudeStartupDefaultsGate,
  syncSessionStartingWithPresence,
} from '../../utils/sessionStartingState.mjs';
import { fetchClaudeStartupDefaultsGate } from '../../utils/claudeStartupDefaultsGate';

const { ipcRenderer } = window.require('electron');

type InterruptedEngine = 'claude' | 'codex';

type SessionStartingState = {
  tabId: string;
  engine: InterruptedEngine;
  sessionId?: string | null;
  since: number;
  lastNotReady?: any;
  holdUntilReady?: boolean;
  startupPending?: boolean;
  startupFailed?: boolean;
  startupError?: string | null;
  startupFailedCommand?: string | null;
  startupProofOutcome?: string | null;
  startupUserRetryable?: boolean;
  stickySource?: 'claude-startup-defaults';
  launchPreparing?: boolean;
  launchPreparationPhase?: string | null;
  launchPreparationToken?: number | null;
  launchPreparationStatus?: 'preparing' | 'accepted' | 'rejected' | null;
};

type AgentStoppingState = {
  tabId: string;
  engine: InterruptedEngine;
  since: number;
  reason?: string | null;
};

type ExternalRunMeta = {
  runId?: string;
  provider?: string;
  source?: string;
  conversationKey?: string;
  status?: string;
  startedAt?: number;
  completedAt?: number;
  autoStopAt?: number | null;
  autoStopMs?: number | null;
  autoCloseAt?: number | null;
  autoCloseMs?: number | null;
  collapsed?: boolean;
  sessionId?: string | null;
};

const statusColor = (status?: string) => {
  if (status === 'running' || status === 'sending' || status === 'starting' || status === 'stopping') return '#d97706';
  if (status === 'done' || status === 'idle') return '#22c55e';
  if (status === 'stopped') return '#94a3b8';
  if (status && status.includes('fail')) return '#ef4444';
  return '#8b5cf6';
};

const formatTtl = (target?: number | null) => {
  if (!target) return '';
  const left = Math.max(0, Math.ceil((target - Date.now()) / 1000));
  const m = Math.floor(left / 60);
  const s = left % 60;
  return m > 0 ? `${m}:${String(s).padStart(2, '0')}` : `${s}s`;
};

const ExternalRunBadge = memo(({ meta }: { meta: ExternalRunMeta }) => {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!meta.autoStopAt && !meta.autoCloseAt) return;
    const id = window.setInterval(() => setTick((v) => v + 1), 1000);
    return () => window.clearInterval(id);
  }, [meta.autoStopAt, meta.autoCloseAt]);
  const stopTtl = formatTtl(meta.autoStopAt);
  const closeTtl = formatTtl(meta.autoCloseAt);
  const provider = (meta.provider || 'agent').toUpperCase();
  const source = meta.source || 'external';
  const status = meta.status || 'starting';
  if (meta.collapsed) {
    return (
      <div
        style={{
          position: 'absolute',
          left: 12,
          top: 10,
          zIndex: 18,
          width: 26,
          height: 22,
          borderRadius: 6,
          border: '1px solid rgba(255,255,255,0.12)',
          background: 'rgba(10,10,14,0.78)',
          boxShadow: '0 10px 24px rgba(0,0,0,0.32)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          pointerEvents: 'none',
          backdropFilter: 'blur(10px)',
        }}
        title={[provider, source, meta.conversationKey, status].filter(Boolean).join(' · ')}
      >
        <span style={{ width: 7, height: 7, borderRadius: 999, background: statusColor(status), boxShadow: `0 0 12px ${statusColor(status)}` }} />
      </div>
    );
  }
  return (
    <div
      style={{
        position: 'absolute',
        left: 12,
        top: 10,
        zIndex: 18,
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        maxWidth: 'min(520px, calc(100% - 24px))',
        padding: '6px 9px',
        borderRadius: 8,
        border: '1px solid rgba(255,255,255,0.12)',
        background: 'rgba(10,10,14,0.78)',
        boxShadow: '0 10px 24px rgba(0,0,0,0.32)',
        color: '#e5e7eb',
        fontSize: 11,
        lineHeight: '14px',
        pointerEvents: 'none',
        backdropFilter: 'blur(10px)',
        fontVariantNumeric: 'tabular-nums',
      }}
      title={[provider, source, meta.conversationKey, status].filter(Boolean).join(' · ')}
    >
      <span style={{ width: 7, height: 7, borderRadius: 999, background: statusColor(status), boxShadow: `0 0 12px ${statusColor(status)}` }} />
      <span style={{ fontWeight: 750, letterSpacing: 0 }}>{provider}</span>
      <span style={{ color: '#9ca3af', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 180 }}>{source}</span>
      <span style={{ color: '#cbd5e1' }}>{status}</span>
      {stopTtl && <span style={{ color: '#fbbf24' }}>stop {stopTtl}</span>}
      {closeTtl && <span style={{ color: '#93c5fd' }}>tab {closeTtl}</span>}
    </div>
  );
});

const RestoredTerminalError = memo(({ tabId, ownerProjectId, cwd, error, visible: visibleProp }: { tabId: string; ownerProjectId: string; cwd: string; error: any; visible?: boolean }) => {
  const visibleFromStore = useWorkspaceStore((s) => {
    const ws = s.openProjects.get(ownerProjectId);
    return s.activeProjectId === ownerProjectId && ws?.activeTabId === tabId && ws?.currentView === 'terminal';
  });
  const visible = visibleProp ?? visibleFromStore;
  const isMissingCwd = error?.type === 'working_directory_missing';
  return (
    <div className={`absolute inset-0 ${visible ? 'flex' : 'hidden'} items-center justify-center bg-[#111113] text-[#d4d4d4]`}>
      <div className="max-w-[720px] rounded-lg border border-red-500/30 bg-red-950/20 px-6 py-5 shadow-2xl">
        <div className="text-sm font-semibold uppercase tracking-wide text-red-300">
          Cannot restore terminal
        </div>
        <div className="mt-3 text-[15px] leading-6 text-[#e5e7eb]">
          {isMissingCwd
            ? 'The saved working directory no longer exists.'
            : 'The saved terminal failed before PTY creation.'}
        </div>
        <div className="mt-3 break-all rounded-md border border-white/10 bg-black/30 px-3 py-2 font-mono text-sm text-[#fca5a5]">
          {error?.cwd || cwd || 'unknown cwd'}
        </div>
        <div className="mt-3 text-sm text-[#a1a1aa]">
          Close this tab or recreate it in an existing folder. Other tabs and projects can still restore.
        </div>
      </div>
    </div>
  );
});

const getSessionStartingPresentation = (state: SessionStartingState) => {
  const engineLabel = state.engine === 'codex' ? 'CODEX' : 'CLAUDE';
  const sessionLabel = state.sessionId ? state.sessionId.slice(0, 8) : null;
  const reason = String(state.lastNotReady?.reason || '');
  const blockers = new Set<string>(Array.isArray(state.lastNotReady?.blockers)
    ? state.lastNotReady.blockers
    : []);
  const hasBlocker = (name: string) => blockers.has(name) || reason.includes(name);
  const isError = state.startupFailed === true;

  if (state.launchPreparing) {
    const repairingHistory = state.launchPreparationPhase === 'repairing-history';
    return {
      isError: false,
      title: state.sessionId ? `PREPARING ${engineLabel} SESSION...` : `STARTING ${engineLabel}...`,
      subtitle: repairingHistory
        ? 'Checking the saved conversation before launch'
        : 'Checking the terminal before launch',
      detail: sessionLabel ? `Session ${sessionLabel}` : null,
    };
  }

  if (isError) {
    const failedCommand = String(state.startupFailedCommand || '');
    const proofOutcome = String(state.startupProofOutcome || '');
    const launchFailure = describeLaunchPreparationFailure(state);
    return {
      isError: true,
      title: `${engineLabel} START FAILED`,
      // Name the command that actually failed. "Terminal input did not become
      // ready" was wrong in the real incident: the input WAS ready, one startup
      // command was swallowed by the TUI.
      subtitle: failedCommand
        ? (proofOutcome === 'unresolved'
          ? `Could not confirm ${failedCommand}`
          : `${failedCommand} was not applied`)
        : (launchFailure?.subtitle || 'Terminal input did not become ready'),
      detail: launchFailure?.detail
        || state.startupError
        || 'Close this status or stop the process and try again',
    };
  }

  if (state.startupPending) {
    return {
      isError: false,
      title: `CONFIGURING ${engineLabel}...`,
      subtitle: 'Applying startup settings',
      detail: sessionLabel ? `Session ${sessionLabel}` : null,
    };
  }

  if (hasBlocker('auth-required')) {
    return {
      isError: false,
      title: `${engineLabel} NEEDS SIGN-IN`,
      subtitle: 'The terminal is waiting for your sign-in choice',
      detail: 'Choose a sign-in method in the terminal',
    };
  }

  if (hasBlocker('update-prompt') || hasBlocker('model-migration')) {
    return {
      isError: false,
      title: `LOADING ${engineLabel} SESSION...`,
      subtitle: 'The terminal is still loading behind the startup menu',
      detail: 'Codex is not ready for prompts yet',
    };
  }

  if (hasBlocker('trust-directory') || hasBlocker('cwd-chooser')) {
    return {
      isError: false,
      title: `WAITING FOR ${engineLabel}...`,
      subtitle: 'The terminal is waiting for a confirmation',
      detail: `${engineLabel} is not ready for prompts yet`,
    };
  }

  if (hasBlocker('mcp-startup')) {
    return {
      isError: false,
      title: `STARTING ${engineLabel} TOOLS...`,
      subtitle: 'Loading terminal integrations',
      detail: sessionLabel ? `Session ${sessionLabel}` : null,
    };
  }

  const isPreparingTerminal = reason === 'empty'
    || reason === 'no-sync-marker'
    || reason === 'no-codex-ui-text'
    || reason === 'no-composer-frame';
  return {
    isError: false,
    title: state.sessionId ? `LOADING ${engineLabel} SESSION...` : `STARTING ${engineLabel}...`,
    subtitle: isPreparingTerminal
      ? 'Restoring history and preparing terminal input'
      : 'Waiting for terminal input to become ready',
    detail: sessionLabel ? `Session ${sessionLabel}` : null,
  };
};

type AgentLifecycleTone = 'starting' | 'stopping' | 'error';

const AgentLifecycleStatusCard = memo(({
  title,
  subtitle,
  detail,
  tone,
  topOffset = 12,
  onDismiss,
  dismissLabel = 'Dismiss agent status',
  onRetry,
  retryLabel = 'RETRY',
}: {
  title: string;
  subtitle: string;
  detail?: string | null;
  tone: AgentLifecycleTone;
  topOffset?: number;
  onDismiss?: () => void;
  dismissLabel?: string;
  onRetry?: () => void;
  retryLabel?: string;
}) => {
  const isError = tone === 'error';
  const isStopping = tone === 'stopping';
  const accent = isError ? '#ef4444' : (isStopping ? '#d97706' : '#60a5fa');
  const borderColor = isError
    ? 'rgba(239,68,68,0.48)'
    : (isStopping ? 'rgba(217,119,6,0.38)' : 'rgba(255,255,255,0.14)');
  const background = isError
    ? 'rgba(45,16,20,0.96)'
    : (isStopping ? 'rgba(31,24,16,0.96)' : 'rgba(17,17,22,0.94)');

  const keepTerminalFocus = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
  };

  const handleDismiss = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    onDismiss?.();
  };

  return (
    <div
      className="absolute left-3 right-3 z-40 pointer-events-none"
      style={{ top: topOffset }}
      role={isError ? 'alert' : 'status'}
      aria-live={isError ? 'assertive' : 'polite'}
    >
      <div
        className="relative flex items-center gap-3 rounded-lg border px-3 py-2.5 shadow-2xl"
        style={{
          width: 400,
          maxWidth: '100%',
          borderColor,
          background,
          boxShadow: isError
            ? '0 12px 28px rgba(0,0,0,0.42), 0 0 20px rgba(239,68,68,0.12)'
            : isStopping
              ? '0 12px 28px rgba(0,0,0,0.42), 0 0 18px rgba(217,119,6,0.10)'
              : '0 12px 28px rgba(0,0,0,0.42)',
        }}
      >
        {isError ? (
          <div
            className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-xs font-black"
            style={{ borderColor: 'rgba(239,68,68,0.9)', color: '#fecaca', background: 'rgba(239,68,68,0.16)' }}
          >
            !
          </div>
        ) : (
          <div
            className="h-5 w-5 shrink-0 rounded-full border-2 border-white/20 animate-spin"
            style={{ borderTopColor: accent }}
          />
        )}

        <div className="min-w-0 flex-1 text-left" style={{ paddingRight: onDismiss ? 28 : 0 }}>
          <div
            className="truncate text-[11px] font-bold tracking-[0.12em]"
            style={{ color: isError ? '#fecaca' : '#ffffff' }}
          >
            {title}
          </div>
          <div className="mt-0.5 truncate text-[11px]" style={{ color: isError ? '#fca5a5' : '#a1a1aa' }}>
            {subtitle}
          </div>
          {detail ? (
            <div className="mt-0.5 truncate text-[10px]" style={{ color: isError ? '#ef4444' : '#6b7280' }}>
              {detail}
            </div>
          ) : null}
          {onRetry ? (
            // Explicit retry. Automatic re-send happens only for a provably
            // undelivered command; when the delivery is unknown the decision is
            // the user's, so applying the setting twice stays impossible
            // without an intent.
            <button
              type="button"
              className="pointer-events-auto mt-1.5 cursor-pointer rounded-md border px-2 py-0.5 text-[10px] font-bold tracking-[0.1em]"
              style={{
                borderColor: 'rgba(239,68,68,0.5)',
                background: 'rgba(239,68,68,0.12)',
                color: '#fecaca',
              }}
              onMouseDown={keepTerminalFocus}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onRetry();
              }}
            >
              {retryLabel}
            </button>
          ) : null}
        </div>

        {onDismiss ? (
          <button
            type="button"
            aria-label={dismissLabel}
            className="pointer-events-auto absolute right-2 top-2 flex h-6 w-6 cursor-pointer items-center justify-center rounded-md border border-white/10 bg-white/[0.04] text-base leading-none text-[#8b8b91] hover:border-white/20 hover:bg-white/[0.08] hover:text-white"
            onMouseDown={keepTerminalFocus}
            onClick={handleDismiss}
          >
            ×
          </button>
        ) : null}
      </div>
    </div>
  );
});

const SessionStartingOverlay = memo(({
  state,
  onDismiss,
  onRetry,
  topOffset = 12,
}: {
  state: SessionStartingState;
  onDismiss: () => void;
  onRetry?: () => void;
  topOffset?: number;
}) => {
  const presentation = getSessionStartingPresentation(state);
  return (
    <AgentLifecycleStatusCard
      title={presentation.title}
      subtitle={presentation.subtitle}
      detail={presentation.detail}
      tone={presentation.isError ? 'error' : 'starting'}
      topOffset={topOffset}
      onDismiss={onDismiss}
      dismissLabel="Dismiss starting status"
      onRetry={presentation.isError && state.startupUserRetryable ? onRetry : undefined}
      retryLabel="RETRY SETTINGS"
    />
  );
});

const AgentStoppingOverlay = memo(({
  state,
  topOffset = 12,
}: {
  state: AgentStoppingState;
  topOffset?: number;
}) => {
  const engineLabel = state.engine === 'codex' ? 'CODEX' : 'CLAUDE';
  return (
    <AgentLifecycleStatusCard
      title={`STOPPING ${engineLabel}...`}
      subtitle="Waiting for the process to exit safely"
      detail={state.reason || null}
      tone="stopping"
      topOffset={topOffset}
    />
  );
});

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

export interface AgentLifecycleSummary {
  tabId: string;
  sessionId?: string | null;
  kind: 'starting' | 'stopping' | 'interrupted' | 'error';
  title: string;
  description: string;
  detail?: string | null;
  spinner: boolean;
  dismissLabel?: string;
  onDismiss?: () => void;
  retryLabel?: string;
  onRetry?: () => void;
}

interface TerminalAreaProps {
  projectId: string;
  terminalPresented?: boolean;
  promptQueuePortalHostId?: string;
  hidePromptQueueHistoryToggle?: boolean;
  promptQueueInputSurface?: 'terminal' | 'history';
  suppressLifecycleOverlays?: boolean;
  onLifecycleStatusChange?: (status: AgentLifecycleSummary | null) => void;
}

function TerminalArea({
  projectId,
  terminalPresented = true,
  promptQueuePortalHostId,
  hidePromptQueueHistoryToggle = false,
  promptQueueInputSurface = 'terminal',
  suppressLifecycleOverlays = false,
  onLifecycleStatusChange,
}: TerminalAreaProps) {
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
  const activeExternalRun = useWorkspaceStore((s) => {
    const ws = s.openProjects.get(projectId);
    if (!ws?.activeTabId) return null;
    return ((ws.tabs.get(ws.activeTabId) as any)?.externalRun || null) as ExternalRunMeta | null;
  });
  const activeAgentStartingKey = useWorkspaceStore((s) => {
    const ws = s.openProjects.get(projectId);
    if (!ws?.activeTabId || ws.currentView !== 'terminal') return '';
    const tab = ws.tabs.get(ws.activeTabId);
    if (!tab || tab.tabType === 'claude-sdk') return '';
    const engine: InterruptedEngine | null =
      tab.commandType === 'codex' ? 'codex'
      : tab.commandType === 'claude' ? 'claude'
      : tab.codexSessionId ? 'codex'
      : tab.claudeSessionId ? 'claude'
      : null;
    if (!engine) return '';
    const sessionId = engine === 'codex' ? (tab.codexSessionId || '') : (tab.claudeSessionId || '');
    return `${tab.id}|${engine}|${sessionId}`;
  });
  const activeAgentStartingInfo = useMemo(() => {
    if (!activeAgentStartingKey) return null;
    const [tabId, engine, sessionId] = activeAgentStartingKey.split('|');
    if (!tabId || (engine !== 'claude' && engine !== 'codex')) return null;
    return {
      tabId,
      engine: engine as InterruptedEngine,
      sessionId: sessionId || null,
    };
  }, [activeAgentStartingKey]);
  const activeAgentStartingInfoRef = useRef(activeAgentStartingInfo);
  const startingProbeSeqRef = useRef(0);
  const dismissedStartingKeysRef = useRef<Set<string>>(new Set());
  const [sessionStarting, setSessionStarting] = useState<SessionStartingState | null>(null);
  const [agentStopping, setAgentStopping] = useState<AgentStoppingState | null>(null);

  const startingDismissKey = useCallback((info: { tabId: string; engine: InterruptedEngine; sessionId?: string | null }) => (
    `${info.tabId}|${info.engine}|${info.sessionId || ''}`
  ), []);

  const invalidateStartingProbeForTab = useCallback((tabId: string) => {
    startingProbeSeqRef.current = invalidateSessionStartingProbeSequence(
      startingProbeSeqRef.current,
      activeAgentStartingInfoRef.current,
      tabId,
    );
  }, []);

  const applyLaunchPreparationState = useCallback((state: any) => {
    const info = activeAgentStartingInfoRef.current;
    if (!info || currentView !== 'terminal') return;
    const tabId = String(state?.tabId || info.tabId);
    const engine = state?.toolType === 'codex'
      ? 'codex'
      : (state?.toolType === 'claude' ? 'claude' : info.engine);
    if (info.tabId !== tabId || info.engine !== engine) return;
    const restoresVisibleState = state?.preparing === true
      || (state && state.preparing === false && state.accepted !== true && state.cleared !== true);
    if (restoresVisibleState) {
      dismissedStartingKeysRef.current.delete(startingDismissKey(info));
      invalidateStartingProbeForTab(tabId);
    } else if (state?.cleared === true) {
      invalidateStartingProbeForTab(tabId);
    }
    setSessionStarting((prev) => applyAgentLaunchPreparationSnapshot(prev, info, state));
  }, [currentView, invalidateStartingProbeForTab, startingDismissKey]);

  useEffect(() => {
    activeAgentStartingInfoRef.current = activeAgentStartingInfo;
  }, [activeAgentStartingInfo]);

  // Launch preparation starts before a shell command exists, so neither OSC
  // command state nor TUI presence can reconstruct it. Main keeps an exact
  // tab-scoped snapshot; this read makes tab switches lossless.
  useEffect(() => {
    const info = activeAgentStartingInfo;
    if (!info || currentView !== 'terminal') return;
    let cancelled = false;
    ipcRenderer.invoke('agent:get-launch-preparation-state', info.tabId)
      .then((result: any) => {
        if (cancelled) return;
        if (activeAgentStartingInfoRef.current?.tabId !== info.tabId) return;
        applyLaunchPreparationState(result?.state || null);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [activeAgentStartingInfo, activeAgentStartingKey, applyLaunchPreparationState, currentView]);

  // Re-read the startup gate whenever this surface (re)binds to a Claude tab.
  // The gate event is delivered only to the ACTIVE tab; in the 2026-07-25
  // incident the `failed` event landed 549ms after the user switched away, the
  // active-tab guard dropped it, and coming back showed a generic "starting"
  // with no reason — while the failure was still recorded in both the renderer
  // map and main's mirror. The event is now an optimization; this is the
  // contract.
  useEffect(() => {
    const info = activeAgentStartingInfo;
    if (!info || info.engine !== 'claude' || currentView !== 'terminal') return;
    let cancelled = false;
    fetchClaudeStartupDefaultsGate(info.tabId).then((gate) => {
      if (cancelled) return;
      if (activeAgentStartingInfoRef.current?.tabId !== info.tabId) return;
      setSessionStarting((prev) => restoreClaudeStartupDefaultsGate(prev, info, gate));
      console.warn('[SessionStartingOverlay] gate-restored tab=' + info.tabId.slice(-12)
        + ' status=' + (gate?.status || 'absent')
        + ' command=' + (gate?.failedCommand || '-')
        + ' outcome=' + (gate?.proofOutcome || '-'));
    });
    return () => { cancelled = true; };
  }, [activeAgentStartingInfo, currentView]);

  useEffect(() => {
    if (!activeTabId || currentView !== 'terminal') {
      setAgentStopping(null);
      return;
    }
    let cancelled = false;
    ipcRenderer.invoke('agent:get-stopping-state', activeTabId)
      .then((state: any) => {
        if (cancelled) return;
        if (state?.stopping) {
          const engine = state.toolType === 'codex' ? 'codex' : 'claude';
          setAgentStopping((prev) => {
            if (prev?.tabId === activeTabId && prev.engine === engine) {
              return { ...prev, reason: state.reason || prev.reason || null };
            }
            console.warn('[AgentStoppingOverlay] hydrate tab=' + activeTabId.slice(-12) + ' engine=' + engine + ' reason=' + (state.reason || '-'));
            return {
              tabId: activeTabId,
              engine,
              since: state.since || Date.now(),
              reason: state.reason || null,
            };
          });
        } else {
          setAgentStopping((prev) => prev?.tabId === activeTabId ? null : prev);
        }
      })
      .catch((e: any) => {
        if (!cancelled) console.warn('[AgentStoppingOverlay] hydrate failed tab=' + activeTabId.slice(-12) + ' error=' + (e?.message || String(e)));
      });
    return () => { cancelled = true; };
  }, [activeTabId, currentView]);

  const refreshSessionStarting = useCallback(async (reason: string) => {
    const info = activeAgentStartingInfoRef.current;
    const seq = ++startingProbeSeqRef.current;
    if (!info || currentView !== 'terminal') {
      setSessionStarting(null);
      return;
    }
    try {
      const presence = await getHistoryAgentRuntime(info.engine).getPresence(info.tabId, projectId);
      const latest = activeAgentStartingInfoRef.current;
      if (!isSessionStartingProbeCurrent(seq, startingProbeSeqRef.current, info, latest)) return;
      const isVisibleStartupState = presence.status === 'starting' || presence.manualActionRequired === true;
      if (isVisibleStartupState && dismissedStartingKeysRef.current.has(startingDismissKey(info))) return;
      if (!isVisibleStartupState) {
        dismissedStartingKeysRef.current.delete(startingDismissKey(info));
      }
      setSessionStarting((prev) => {
        const next = syncSessionStartingWithPresence(prev, info, presence);
        if (!prev && next) {
          console.warn('[SessionStartingOverlay] show tab=' + info.tabId.slice(-12) + ' engine=' + info.engine + ' reason=' + reason);
        } else if (prev?.tabId === info.tabId && !next) {
          console.warn('[SessionStartingOverlay] hide tab=' + info.tabId.slice(-12) + ' engine=' + info.engine + ' reason=' + reason + ' status=' + presence.status);
        }
        return next;
      });
    } catch (e: any) {
      if (seq !== startingProbeSeqRef.current) return;
      console.warn('[SessionStartingOverlay] presence failed tab=' + info.tabId.slice(-12) + ' engine=' + info.engine + ' reason=' + reason + ' error=' + (e?.message || String(e)));
    }
  }, [currentView, projectId, startingDismissKey]);

  useEffect(() => {
    if (!activeAgentStartingInfo || currentView !== 'terminal') {
      startingProbeSeqRef.current++;
      setSessionStarting(null);
      return;
    }
    void refreshSessionStarting('active-tab');
  }, [activeAgentStartingKey, activeAgentStartingInfo, currentView, refreshSessionStarting]);

  useEffect(() => {
    const showFromEvent = (tabId: string, reason: string) => {
      const info = activeAgentStartingInfoRef.current;
      if (!info || info.tabId !== tabId || currentView !== 'terminal') return;
      dismissedStartingKeysRef.current.delete(startingDismissKey(info));
      console.warn('[SessionStartingOverlay] event-start tab=' + tabId.slice(-12) + ' engine=' + info.engine + ' reason=' + reason);
      setSessionStarting((prev) => prev?.tabId === tabId ? prev : {
        tabId,
        engine: info.engine,
        sessionId: info.sessionId,
        holdUntilReady: true,
        since: Date.now(),
      });
    };
    const hideFromEvent = (tabId: string, reason: string, force = false) => {
      const info = activeAgentStartingInfoRef.current;
      invalidateStartingProbeForTab(tabId);
      if (info?.tabId === tabId) dismissedStartingKeysRef.current.delete(startingDismissKey(info));
      setSessionStarting((prev) => {
        if (prev?.tabId !== tabId) return prev;
        const next = hideSessionStartingFromLifecycle(prev, tabId, { force });
        if (!next) console.warn('[SessionStartingOverlay] event-hide tab=' + tabId.slice(-12) + ' reason=' + reason + ' engine=' + prev.engine);
        return next;
      });
    };
    const onCommandStarted = (_: any, data: { tabId: string; commandType?: string | null }) => {
      if (data.commandType === 'claude' || data.commandType === 'codex') {
        showFromEvent(data.tabId, 'command-started');
      } else {
        void refreshSessionStarting('command-started');
      }
    };
    const onCommandFinished = (_: any, data: { tabId: string }) => hideFromEvent(data.tabId, 'command-finished', true);
    const onClaudeReady = (_: any, data: { tabId: string }) => {
      const info = activeAgentStartingInfoRef.current;
      if (info?.tabId === data.tabId && info.engine !== 'claude') return;
      hideFromEvent(data.tabId, 'claude-tui-ready', true);
    };
    const onCodexReady = (_: any, data: { tabId: string }) => hideFromEvent(data.tabId, 'codex-tui-ready', true);
    const onClaudeBusy = (_: any, data: { tabId: string; busy: boolean }) => {
      if (!data.busy) return;
      hideFromEvent(data.tabId, 'claude-busy', true);
    };
    const onCodexBusy = (_: any, data: { tabId: string; busy: boolean }) => {
      if (!data.busy) return;
      hideFromEvent(data.tabId, 'codex-busy', true);
    };
    const onCodexNotReady = (_: any, data: { tabId?: string; reason?: string | null }) => {
      const eventTabId = data?.tabId || '';
      const info = activeAgentStartingInfoRef.current;
      if (!eventTabId || !info || info.tabId !== eventTabId || info.engine !== 'codex' || currentView !== 'terminal') return;
      if (data.reason === 'manual-stop') {
        invalidateStartingProbeForTab(eventTabId);
        setSessionStarting(null);
        console.warn('[SessionStartingOverlay] ignore not-ready after manual Stop tab=' + eventTabId.slice(-12));
        return;
      }
      void refreshSessionStarting('codex-tui-not-ready:' + (data.reason || '-'));
    };
    const onCodexManualAction = (_: any, data: { tabId?: string; type?: string | null }) => {
      const eventTabId = data?.tabId || '';
      const info = activeAgentStartingInfoRef.current;
      if (!eventTabId || !info || info.tabId !== eventTabId || info.engine !== 'codex' || currentView !== 'terminal') return;
      void refreshSessionStarting('codex-manual-action:' + (data.type || '-'));
    };
    const onLaunchPreparation = (_: any, state: any) => {
      applyLaunchPreparationState(state);
    };
    const onAgentStopping = (_: any, data: {
      tabId?: string;
      toolType?: string | null;
      stopping?: boolean;
      reason?: string | null;
      since?: number;
    }) => {
      const eventTabId = data?.tabId || '';
      if (!eventTabId) return;
      const engine: InterruptedEngine = data.toolType === 'codex' ? 'codex' : 'claude';
      if (data.stopping) {
        if (eventTabId !== activeTabId || currentView !== 'terminal') return;
        invalidateStartingProbeForTab(eventTabId);
        setSessionStarting(null);
        setAgentStopping((prev) => {
          if (prev?.tabId === eventTabId && prev.engine === engine) {
            return { ...prev, reason: data.reason || prev.reason || null };
          }
          console.warn('[AgentStoppingOverlay] show tab=' + eventTabId.slice(-12) + ' engine=' + engine + ' reason=' + (data.reason || '-'));
          return {
            tabId: eventTabId,
            engine,
            since: data.since || Date.now(),
            reason: data.reason || null,
          };
        });
      } else {
        setAgentStopping((prev) => {
          if (prev?.tabId === eventTabId) {
            console.warn('[AgentStoppingOverlay] hide tab=' + eventTabId.slice(-12) + ' reason=' + (data.reason || '-'));
            return null;
          }
          return prev;
        });
      }
    };
    const onClaudeStartupGate = (event: Event) => {
      const detail = (event as CustomEvent<{
        tabId?: string;
        status?: string;
        reason?: string;
        error?: string | null;
        failedCommand?: string | null;
        proofOutcome?: string | null;
        userRetryable?: boolean;
      }>).detail || {};
      const gateTabId = detail.tabId || '';
      const info = activeAgentStartingInfoRef.current;
      if (!gateTabId || !info || info.tabId !== gateTabId || info.engine !== 'claude' || currentView !== 'terminal') return;
      if (detail.status === 'pending' || detail.status === 'failed') {
        dismissedStartingKeysRef.current.delete(startingDismissKey(info));
      }
      if (detail.status === 'ready' || detail.status === 'cleared') {
        invalidateStartingProbeForTab(gateTabId);
      }
      if (detail.status === 'ready' || detail.status === 'cleared' || detail.status === 'pending' || detail.status === 'failed') {
        setSessionStarting((prev) => {
          const next = applyClaudeStartupDefaultsGate(prev, info, { ...detail, tabId: gateTabId });
          console.warn('[SessionStartingOverlay] gate-' + detail.status + ' tab=' + gateTabId.slice(-12) + ' reason=' + (detail.reason || '-') + ' error=' + (detail.error || '-'));
          return next;
        });
      }
    };

    ipcRenderer.on('terminal:command-started', onCommandStarted);
    ipcRenderer.on('terminal:command-finished', onCommandFinished);
    ipcRenderer.on('claude:tui-ready', onClaudeReady);
    ipcRenderer.on('codex:tui-ready', onCodexReady);
    ipcRenderer.on('codex:tui-not-ready', onCodexNotReady);
    ipcRenderer.on('codex:tui-manual-action-required', onCodexManualAction);
    ipcRenderer.on('agent:launch-preparation-state', onLaunchPreparation);
    ipcRenderer.on('claude:busy-state', onClaudeBusy);
    ipcRenderer.on('codex:busy-state', onCodexBusy);
    ipcRenderer.on('agent:stopping-state', onAgentStopping);
    window.addEventListener('claude-startup-defaults-gate', onClaudeStartupGate);
    return () => {
      ipcRenderer.removeListener('terminal:command-started', onCommandStarted);
      ipcRenderer.removeListener('terminal:command-finished', onCommandFinished);
      ipcRenderer.removeListener('claude:tui-ready', onClaudeReady);
      ipcRenderer.removeListener('codex:tui-ready', onCodexReady);
      ipcRenderer.removeListener('codex:tui-not-ready', onCodexNotReady);
      ipcRenderer.removeListener('codex:tui-manual-action-required', onCodexManualAction);
      ipcRenderer.removeListener('agent:launch-preparation-state', onLaunchPreparation);
      ipcRenderer.removeListener('claude:busy-state', onClaudeBusy);
      ipcRenderer.removeListener('codex:busy-state', onCodexBusy);
      ipcRenderer.removeListener('agent:stopping-state', onAgentStopping);
      window.removeEventListener('claude-startup-defaults-gate', onClaudeStartupGate);
    };
  }, [activeTabId, applyLaunchPreparationState, currentView, invalidateStartingProbeForTab, refreshSessionStarting, startingDismissKey]);

  const handleDismissSessionStarting = useCallback(() => {
    const current = sessionStarting;
    if (current) {
      dismissedStartingKeysRef.current.add(startingDismissKey(current));
      console.warn('[SessionStartingOverlay] dismissed tab=' + current.tabId.slice(-12) + ' engine=' + current.engine);
      if (
        current.launchPreparationStatus === 'rejected'
        && Number(current.launchPreparationToken || 0) > 0
      ) {
        void ipcRenderer.invoke('agent:clear-launch-preparation-state', {
          tabId: current.tabId,
          token: current.launchPreparationToken,
          reason: 'user-dismissed',
        }).then((result: any) => {
          // A new launch may supersede the card between click and IPC. Its
          // exact token is intentionally not cleared; immediately apply the
          // authoritative replacement instead.
          if (result?.cleared !== true && result?.state) {
            applyLaunchPreparationState(result.state);
          }
        }).catch((error: any) => {
          console.warn('[SessionStartingOverlay] launch failure dismiss failed tab='
            + current.tabId.slice(-12) + ' error=' + (error?.message || String(error)));
        });
      }
    }
    setSessionStarting(null);
  }, [applyLaunchPreparationState, sessionStarting, startingDismissKey]);

  // Explicit user approval re-enters the main-owned transaction for the same
  // live launch. Main keeps already-proven earlier steps and retries only the
  // failed setting.
  const handleRetryStartupDefaults = useCallback(async () => {
    const current = sessionStarting;
    if (!current || current.engine !== 'claude') return;
    console.warn('[StartupRetry] decision=user action=manual-retry tab=' + current.tabId.slice(-12)
      + ' command=' + (current.startupFailedCommand || '-'));
    setSessionStarting(null);
    const result = await ipcRenderer.invoke('claude:retry-startup-defaults', {
      tabId: current.tabId,
    }).catch((error: any) => ({
      success: false,
      accepted: false,
      error: error?.message || String(error),
    }));
    if (result?.accepted === true) return;
    setSessionStarting((prev) => applyClaudeStartupDefaultsGate(prev, current, {
      tabId: current.tabId,
      status: 'failed',
      reason: 'manual-retry-rejected',
      error: result?.error || result?.reason || 'No live Claude launch to retry',
      failedCommand: current.startupFailedCommand || null,
      proofOutcome: current.startupProofOutcome || null,
      userRetryable: false,
    }));
  }, [sessionStarting]);

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
  const showAgentStoppingOverlay = !!agentStopping
    && currentView === 'terminal'
    && activeTabIdForOverlay === agentStopping.tabId;
  const showSessionStartingOverlay = !!sessionStarting
    && currentView === 'terminal'
    && !showAgentStoppingOverlay
    && activeTabIdForOverlay === sessionStarting.tabId;
  const showInterruptedOverlay = !!activeTabInterruptedEngine
    && !!activeTabSessionId
    && currentView === 'terminal'
    && !isRestoring
    && !showAgentStoppingOverlay
    && !showSessionStartingOverlay;

  const lifecycleSummary = useMemo<AgentLifecycleSummary | null>(() => {
    if (showAgentStoppingOverlay && agentStopping) {
      const engineLabel = agentStopping.engine === 'codex' ? 'CODEX' : 'CLAUDE';
      return {
        tabId: agentStopping.tabId,
        kind: 'stopping',
        title: `STOPPING ${engineLabel}...`,
        description: 'Waiting for the process to exit safely',
        detail: agentStopping.reason || null,
        spinner: true,
      };
    }
    if (showInterruptedOverlay && activeTabIdForOverlay && activeTabSessionId) {
      const engineLabel = activeTabInterruptedEngine === 'codex' ? 'CODEX' : 'CLAUDE';
      return {
        tabId: activeTabIdForOverlay,
        sessionId: activeTabSessionId,
        kind: 'interrupted',
        title: `${engineLabel} SESSION INTERRUPTED`,
        description: 'The saved conversation can be continued from this tab',
        detail: `Session ${activeTabSessionId}`,
        spinner: false,
      };
    }
    if (showSessionStartingOverlay && sessionStarting) {
      const presentation = getSessionStartingPresentation(sessionStarting);
      const canRetryStartupSettings = presentation.isError
        && sessionStarting.startupUserRetryable === true;
      return {
        tabId: sessionStarting.tabId,
        sessionId: sessionStarting.sessionId || null,
        kind: presentation.isError ? 'error' : 'starting',
        title: presentation.title,
        description: presentation.subtitle,
        detail: presentation.detail,
        spinner: !presentation.isError,
        dismissLabel: presentation.isError ? 'Dismiss starting status' : undefined,
        onDismiss: presentation.isError ? handleDismissSessionStarting : undefined,
        retryLabel: canRetryStartupSettings ? 'RETRY SETTINGS' : undefined,
        onRetry: canRetryStartupSettings ? handleRetryStartupDefaults : undefined,
      };
    }
    return null;
  }, [activeTabIdForOverlay, activeTabInterruptedEngine, activeTabSessionId, agentStopping, handleDismissSessionStarting, handleRetryStartupDefaults, sessionStarting, showAgentStoppingOverlay, showInterruptedOverlay, showSessionStartingOverlay]);

  useEffect(() => {
    onLifecycleStatusChange?.(lifecycleSummary);
  }, [lifecycleSummary, onLifecycleStatusChange]);

  useEffect(() => () => {
    onLifecycleStatusChange?.(null);
  }, [onLifecycleStatusChange]);

  
  // Handle continuing interrupted AI session (use fresh state from getState)
  const continueSessionInflightRef = useRef<Set<string>>(new Set());
  const handleContinueSession = async (sessionId?: string, engine?: InterruptedEngine | null) => {
    const tabId = activeTabId;
    const targetSessionId = sessionId || activeTabSessionId;
    const targetEngine = engine || activeTabInterruptedEngine;
    console.log('[TerminalArea] handleContinueSession called, activeTab:', tabId, 'engine:', targetEngine, 'sessionId:', targetSessionId);

    if (tabId && targetSessionId && targetEngine) {
      if (continueSessionInflightRef.current.has(tabId)) {
        console.warn('[TerminalArea] Continue already in flight for tab:', tabId);
        return;
      }
      continueSessionInflightRef.current.add(tabId);
      console.log('[TerminalArea] Sending resume; interrupted state stays until launch is accepted');

      const setTabCommandType = useWorkspaceStore.getState().setTabCommandType;
      setTabCommandType(tabId, targetEngine);

      terminalRegistry.get(tabId)?.scrollToBottom();
      terminalRegistry.get(tabId)?.focus();
      requestAnimationFrame(() => terminalRegistry.get(tabId)?.focus());

      try {
        let runResult: any;
        if (targetEngine === 'codex') {
          const ws = useWorkspaceStore.getState().openProjects.get(projectId);
          const cwd = ws?.tabs.get(tabId)?.cwd;
          console.log('[TerminalArea] Invoking codex:run-command codex-c:', targetSessionId);
          runResult = await ipcRenderer.invoke('codex:run-command', buildCodexRunPayload({
            tabId,
            command: 'codex-c',
            sessionId: targetSessionId,
            cwd,
          }));
        } else {
          // Arm the 15s stale-bridge guard immediately before the confirmed
          // launch request; clear it again if main rejects the write.
          markPendingResume(tabId, targetSessionId);
          const tabCwd = useWorkspaceStore.getState().openProjects.get(projectId)?.tabs.get(tabId)?.cwd;
          console.log('[TerminalArea] Invoking claude:run-command resume:', targetSessionId);
          runResult = await ipcRenderer.invoke('claude:run-command', {
            tabId,
            command: 'claude-c',
            sessionId: targetSessionId,
            ...(tabCwd ? { cdTo: tabCwd } : {}),
          });
        }
        if (runResult?.success === false || runResult?.accepted === false) {
          if (targetEngine === 'claude') clearPendingResume(tabId);
          console.warn('[TerminalArea] Resume rejected tab=' + tabId.slice(-12)
            + ' engine=' + targetEngine
            + ' error=' + (runResult?.error || runResult?.reason || 'unknown'));
          return;
        }
        clearInterruptedState(tabId);
      } catch (error: any) {
        if (targetEngine === 'claude') clearPendingResume(tabId);
        console.warn('[TerminalArea] Resume failed tab=' + tabId.slice(-12)
          + ' engine=' + targetEngine
          + ' error=' + (error?.message || String(error)));
      } finally {
        continueSessionInflightRef.current.delete(tabId);
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

  // Stable string selector — re-renders only when tab structure changes or a
  // tab changes its own rendered surface. Active project/tab visibility is
  // tracked separately below so project switches do not remount xterm.
  const terminalFingerprint = useWorkspaceStore((s) => {
    const parts: string[] = [];
    s.openProjects.forEach((workspace, projId) => {
      const subAgentPart = projId === projectId && workspace.viewingSubAgentTabId
        ? `:sub=${workspace.viewingSubAgentTabId}:host=${workspace.activeTabId || ''}`
        : '';
      parts.push(`${projId}${subAgentPart}`);
      workspace.tabs.forEach((tab) => {
        parts.push(`${tab.id}:${tab.tabType || 'terminal'}:${tab.activeView || ''}:${tab.terminalId || ''}:${(tab as any).restoreError ? 'restore-error' : 'ok'}`);
      });
    });
    return parts.join(',');
  });

  // Active layer is intentionally separate from the structural fingerprint.
  // Terminals stay mounted across project switches, but the visible DOM layer
  // must be driven by one fresh store snapshot so an old project cannot keep
  // `active=1`/opacity=1 after the active project changes.
  const activeLayerKey = useWorkspaceStore((s) => {
    const activeProjectId = s.activeProjectId || '';
    const workspace = activeProjectId ? s.openProjects.get(activeProjectId) : null;
    return [
      s.view,
      activeProjectId,
      workspace?.activeTabId || '',
      workspace?.currentView || '',
      workspace?.viewingSubAgentTabId || '',
    ].join('|');
  });

  const terminals = useMemo(() => {
    const t0 = Date.now();
    const result: React.ReactNode[] = [];
    const state = useWorkspaceStore.getState();
    const currentOpenProjects = state.openProjects;
    const activeProjectId = state.activeProjectId;
    const appView = state.view;
    let sdkCount = 0;
    let totalCount = 0;

    const isActiveProjectForLayer = (projId: string) => (
      appView === 'workspace' && activeProjectId === projId
    );

    const isActiveTerminalLayer = (projId: string, tabId: string) => {
      if (!isActiveProjectForLayer(projId)) return false;
      const workspace = currentOpenProjects.get(projId);
      if (!workspace || workspace.currentView !== 'terminal') return false;

      if (workspace.viewingSubAgentTabId) {
        const viewedTab = workspace.tabs.get(workspace.viewingSubAgentTabId);
        if (viewedTab && viewedTab.parentTabId === workspace.activeTabId) {
          return tabId === workspace.viewingSubAgentTabId;
        }
      }

      return workspace.activeTabId === tabId;
    };

    currentOpenProjects.forEach((workspace, projId) => {
      workspace.tabs.forEach((tab) => {
        const isActiveProject = isActiveProjectForLayer(projId);
        const active = isActiveTerminalLayer(projId, tab.id);
        if (tab.tabType === 'claude-sdk') {
          sdkCount++;
          totalCount++;
          result.push(
            <ClaudeSDKTab
              key={tab.id}
              tabId={tab.id}
              cwd={tab.cwd}
              ownerProjectId={projId}
              active={active}
              isActiveProject={isActiveProject}
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
              active={active}
              isActiveProject={isActiveProject}
            />
          );
        } else if (tab.tabType === 'file') {
          totalCount++;
          // Linked file tabs render through the global FilePreview overlay in Workspace.
          // They are real tabs for grouping/DnD/status, but they have no PTY layer.
          return;
        } else if ((tab as any).restoreError) {
          totalCount++;
          result.push(
            <RestoredTerminalError
              key={tab.id}
              tabId={tab.id}
              ownerProjectId={projId}
              cwd={tab.cwd}
              error={(tab as any).restoreError}
              visible={active}
            />
          );
        } else {
          totalCount++;
          result.push(
            <Terminal
              key={tab.id}
              tabId={tab.id}
              cwd={tab.cwd}
              ownerProjectId={projId}
              active={active}
              isActiveProject={isActiveProject}
              presented={terminalPresented}
              promptQueuePortalHostId={promptQueuePortalHostId}
              hidePromptQueueHistoryToggle={hidePromptQueueHistoryToggle}
              promptQueueInputSurface={promptQueueInputSurface}
            />
          );
        }
      });
    });

    const durMs = Date.now() - t0;
    console.warn(`[TerminalArea:useMemo] RECALCULATING projectId=${projectId.slice(-12)} total=${totalCount} sdk=${sdkCount} durMs=${durMs}`);
    return result;
  }, [terminalFingerprint, activeLayerKey, projectId, terminalPresented, promptQueuePortalHostId, hidePromptQueueHistoryToggle, promptQueueInputSurface]);

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

      {currentView === 'terminal' && activeExternalRun && (
        <ExternalRunBadge meta={activeExternalRun} />
      )}

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

      {/* Local per-tab resume/start status. It deliberately does not own focus or
          a full-screen hit area: startup menus remain directly interactive. */}
      <AnimatePresence>
        {!suppressLifecycleOverlays && showAgentStoppingOverlay && agentStopping && (
          <AgentStoppingOverlay
            key={`${agentStopping.tabId}:${agentStopping.since}`}
            state={agentStopping}
            topOffset={activeExternalRun ? 44 : 12}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {!suppressLifecycleOverlays && showSessionStartingOverlay && sessionStarting && (
          <SessionStartingOverlay
            key={`${sessionStarting.tabId}:${sessionStarting.since}`}
            state={sessionStarting}
            onDismiss={handleDismissSessionStarting}
            onRetry={handleRetryStartupDefaults}
            topOffset={activeExternalRun ? 44 : 12}
          />
        )}
      </AnimatePresence>

      {/* Interrupted session overlay */}
      <AnimatePresence>
        {!suppressLifecycleOverlays && showInterruptedOverlay && activeTabId && activeTabSessionId && (
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
