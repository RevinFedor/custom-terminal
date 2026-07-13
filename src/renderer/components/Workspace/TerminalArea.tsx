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
import { getHistoryAgentRuntime } from '../../utils/historyAgentRuntimes';

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
  const isError = state.startupFailed === true
    || state.lastNotReady?.phase === 'startup-timeout'
    || reason.includes('startup-timeout');

  if (isError) {
    return {
      isError: true,
      title: `${engineLabel} START FAILED`,
      subtitle: 'Terminal input did not become ready',
      detail: state.startupError || 'Close this status or stop the process and try again',
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

  if (hasBlocker('update-prompt')) {
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
}: {
  title: string;
  subtitle: string;
  detail?: string | null;
  tone: AgentLifecycleTone;
  topOffset?: number;
  onDismiss?: () => void;
  dismissLabel?: string;
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
  topOffset = 12,
}: {
  state: SessionStartingState;
  onDismiss: () => void;
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

  useEffect(() => {
    activeAgentStartingInfoRef.current = activeAgentStartingInfo;
  }, [activeAgentStartingInfo]);

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
      const presence = await getHistoryAgentRuntime(info.engine).getPresence(info.tabId);
      if (seq !== startingProbeSeqRef.current) return;
      const latest = activeAgentStartingInfoRef.current;
      if (!latest || latest.tabId !== info.tabId || latest.engine !== info.engine) return;
      if (presence.status === 'starting') {
        if (dismissedStartingKeysRef.current.has(startingDismissKey(info))) return;
        setSessionStarting((prev) => {
          if (prev?.tabId === info.tabId && prev.engine === info.engine) {
            return {
              ...prev,
              sessionId: info.sessionId,
              lastNotReady: presence.lastNotReady,
              holdUntilReady: prev.holdUntilReady,
              startupPending: prev.startupPending,
              startupFailed: prev.startupFailed || presence.startupFailed,
              startupError: prev.startupError || presence.startupError,
            };
          }
          console.warn('[SessionStartingOverlay] show tab=' + info.tabId.slice(-12) + ' engine=' + info.engine + ' reason=' + reason);
          return {
            tabId: info.tabId,
            engine: info.engine,
            sessionId: info.sessionId,
            since: Date.now(),
            lastNotReady: presence.lastNotReady,
            startupFailed: presence.startupFailed,
            startupError: presence.startupError,
          };
        });
      } else {
        dismissedStartingKeysRef.current.delete(startingDismissKey(info));
        setSessionStarting((prev) => {
          const keepHoldingForCommandStartRace = prev?.holdUntilReady
            && presence.status === 'inactive'
            && !presence.manualActionRequired;
          if (prev?.tabId === info.tabId && (prev.startupFailed || prev.startupPending || keepHoldingForCommandStartRace)) return prev;
          if (prev?.tabId === info.tabId) {
            console.warn('[SessionStartingOverlay] hide tab=' + info.tabId.slice(-12) + ' engine=' + info.engine + ' reason=' + reason + ' status=' + presence.status);
          }
          return prev?.tabId === info.tabId ? null : prev;
        });
      }
    } catch (e: any) {
      if (seq !== startingProbeSeqRef.current) return;
      console.warn('[SessionStartingOverlay] presence failed tab=' + info.tabId.slice(-12) + ' engine=' + info.engine + ' reason=' + reason + ' error=' + (e?.message || String(e)));
    }
  }, [currentView, startingDismissKey]);

  useEffect(() => {
    if (!activeAgentStartingInfo || currentView !== 'terminal') {
      startingProbeSeqRef.current++;
      setSessionStarting(null);
      return;
    }
    void refreshSessionStarting('active-tab');
    const interval = window.setInterval(() => {
      void refreshSessionStarting('poll');
    }, 1000);
    return () => window.clearInterval(interval);
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
      if (info?.tabId === tabId) dismissedStartingKeysRef.current.delete(startingDismissKey(info));
      setSessionStarting((prev) => {
        if (prev?.tabId !== tabId) return prev;
        if (prev.startupFailed) return prev;
        if (prev?.tabId === tabId && (prev.startupPending || (!force && prev.holdUntilReady))) return prev;
        console.warn('[SessionStartingOverlay] event-hide tab=' + tabId.slice(-12) + ' reason=' + reason + ' engine=' + prev.engine);
        return null;
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
    };
    const onCodexBusy = (_: any, data: { tabId: string; busy: boolean }) => {
      if (!data.busy) return;
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
      }>).detail || {};
      const gateTabId = detail.tabId || '';
      const info = activeAgentStartingInfoRef.current;
      if (!gateTabId || !info || info.tabId !== gateTabId || info.engine !== 'claude' || currentView !== 'terminal') return;
      if (detail.status === 'ready') {
        setSessionStarting((prev) => {
          if (prev?.tabId === gateTabId) console.warn('[SessionStartingOverlay] gate-ready tab=' + gateTabId.slice(-12) + ' reason=' + (detail.reason || '-'));
          return prev?.tabId === gateTabId ? null : prev;
        });
        return;
      }
      if (detail.status === 'pending' || detail.status === 'failed') {
        dismissedStartingKeysRef.current.delete(startingDismissKey(info));
        setSessionStarting((prev) => {
          console.warn('[SessionStartingOverlay] gate-' + detail.status + ' tab=' + gateTabId.slice(-12) + ' reason=' + (detail.reason || '-') + ' error=' + (detail.error || '-'));
          return {
            tabId: gateTabId,
            engine: 'claude',
            sessionId: info.sessionId,
            since: prev?.tabId === gateTabId ? prev.since : Date.now(),
            startupPending: detail.status === 'pending',
            startupFailed: detail.status === 'failed',
            startupError: detail.status === 'failed' ? (detail.error || detail.reason || 'Claude startup defaults failed') : null,
          };
        });
      }
    };

    ipcRenderer.on('terminal:command-started', onCommandStarted);
    ipcRenderer.on('terminal:command-finished', onCommandFinished);
    ipcRenderer.on('claude:tui-ready', onClaudeReady);
    ipcRenderer.on('codex:tui-ready', onCodexReady);
    ipcRenderer.on('claude:busy-state', onClaudeBusy);
    ipcRenderer.on('codex:busy-state', onCodexBusy);
    ipcRenderer.on('agent:stopping-state', onAgentStopping);
    window.addEventListener('claude-startup-defaults-gate', onClaudeStartupGate);
    return () => {
      ipcRenderer.removeListener('terminal:command-started', onCommandStarted);
      ipcRenderer.removeListener('terminal:command-finished', onCommandFinished);
      ipcRenderer.removeListener('claude:tui-ready', onClaudeReady);
      ipcRenderer.removeListener('codex:tui-ready', onCodexReady);
      ipcRenderer.removeListener('claude:busy-state', onClaudeBusy);
      ipcRenderer.removeListener('codex:busy-state', onCodexBusy);
      ipcRenderer.removeListener('agent:stopping-state', onAgentStopping);
      window.removeEventListener('claude-startup-defaults-gate', onClaudeStartupGate);
    };
  }, [activeTabId, currentView, refreshSessionStarting, startingDismissKey]);

  const handleDismissSessionStarting = useCallback(() => {
    const current = sessionStarting;
    if (current) {
      dismissedStartingKeysRef.current.add(startingDismissKey(current));
      console.warn('[SessionStartingOverlay] dismissed tab=' + current.tabId.slice(-12) + ' engine=' + current.engine);
    }
    setSessionStarting(null);
  }, [sessionStarting, startingDismissKey]);

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
  const showInterruptedOverlay = !!activeTabInterruptedEngine
    && !!activeTabSessionId
    && currentView === 'terminal'
    && !isRestoring
    && !showAgentStoppingOverlay;
  const showSessionStartingOverlay = !!sessionStarting
    && currentView === 'terminal'
    && !showAgentStoppingOverlay
    && !showInterruptedOverlay
    && activeTabIdForOverlay === sessionStarting.tabId;

  
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
        ipcRenderer.send('terminal:force-command-started', { tabId, commandType: 'codex', sessionId: targetSessionId });
      } else {
        // Arm the 15s stale-bridge guard BEFORE the resume write (см.
        // fix-bridge-stale-takeover.md layer 4/5) — иначе протухший bridge.json
        // перезапишет sessionId таба в окне resume.
        markPendingResume(tabId, targetSessionId);
        const cmd = `claude --dangerously-skip-permissions --resume ${targetSessionId}\r`;
        console.log('[TerminalArea] Sending terminal:input:', cmd);
        ipcRenderer.send('terminal:input', tabId, cmd);
        ipcRenderer.send('terminal:force-command-started', { tabId, commandType: 'claude', sessionId: targetSessionId });
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
            />
          );
        }
      });
    });

    const durMs = Date.now() - t0;
    console.warn(`[TerminalArea:useMemo] RECALCULATING projectId=${projectId.slice(-12)} total=${totalCount} sdk=${sdkCount} durMs=${durMs}`);
    return result;
  }, [terminalFingerprint, activeLayerKey, projectId]);

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
        {showAgentStoppingOverlay && agentStopping && (
          <AgentStoppingOverlay
            key={`${agentStopping.tabId}:${agentStopping.since}`}
            state={agentStopping}
            topOffset={activeExternalRun ? 44 : 12}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {showSessionStartingOverlay && sessionStarting && (
          <SessionStartingOverlay
            key={`${sessionStarting.tabId}:${sessionStarting.since}`}
            state={sessionStarting}
            onDismiss={handleDismissSessionStarting}
            topOffset={activeExternalRun ? 44 : 12}
          />
        )}
      </AnimatePresence>

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
