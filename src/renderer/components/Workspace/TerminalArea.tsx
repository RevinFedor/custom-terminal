import React, { memo, useCallback, useMemo, useEffect, useState, useRef } from 'react';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';
import { useProjectsStore } from '../../store/useProjectsStore';
import Terminal from './Terminal';
import ClaudeSDKTab from './ClaudeSDK/ClaudeSDKTab';
import { useSplitAttachRowHeight, SplitDividerLayer, SplitFilePane, SplitPaneAttachRow, SplitPaneFocusFrame, splitPaneRectStyle, SPLIT_PANE_CONTENT_INSET_PX } from './SplitPaneChrome';
import { motion, AnimatePresence } from 'framer-motion';
import { terminalRegistry } from '../../utils/terminalRegistry';
import { clearPendingResume, markPendingResume } from '../../utils/pendingResume';
import { buildCodexRunPayload } from '../../utils/codexLaunch';
import { isEmptyPane, paneIsStacked, splitSizesFingerprint } from '../../utils/splitPanesModel.mjs';
import { notePointerDownForDismissal } from '../../utils/overlayDismissGesture.mjs';
import SplitPaneSurface, { splitPaneQueueHostId } from './SplitPaneSurface';
import type { AgentLifecycleSummary } from './agentLifecycleSummary';
// Машина состояний запуска/остановки живёт здесь и параметризована `tabId`,
// поэтому её монтирует и одиночный режим, и каждая панель сплита отдельно.
import { useAgentLifecycle } from './useAgentLifecycle';
import { resolvePtyAgentOwner } from '../../utils/ptyAgentOwner.mjs';
import AiLaunchStrip, { type AiLaunchAction } from './AiLaunchStrip';
import { readSessionIdFromClipboard } from '../../utils/clipboardSessionId';
import { EMPTY_TAB_NAME } from '../../utils/emptyTab.mjs';

const { ipcRenderer } = window.require('electron');

type InterruptedEngine = 'claude' | 'codex';

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
    <div
      className={`absolute inset-0 ${visible ? 'flex' : 'hidden'} items-center justify-center bg-[#111113] text-[#d4d4d4]`}
      style={{ pointerEvents: visible ? 'auto' : 'none' }}
    >
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

// Типы состояния запуска/остановки и сборка его текста переехали в
// `useAgentLifecycle` вместе с самой машиной. Копии здесь удалены намеренно: две
// формулировки одного статуса разъехались бы при первой правке подписи, и одна
// поверхность тихо осталась бы с прежним текстом.

// The floating lifecycle CARD (AgentLifecycleStatusCard + its two wrappers,
// SessionStartingOverlay and AgentStoppingOverlay) lived here and was removed:
// the transcript's own status control already says the same thing, in the
// surface that owns the session. See the note at its former render site below.
//
// What is kept is the STATE behind it — sessionStarting / agentStopping and the
// lifecycleSummary built from them — because that state is what every surface
// now reads, including panes.

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

// Declared in its own module (./agentLifecycleSummary) because SplitPaneSurface
// consumes it and this file renders SplitPaneSurface. Re-exported here so the
// existing importers keep working.
export type { AgentLifecycleSummary };

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
  // Состояние запуска/остановки СВОЕЙ вкладки. Машина переехала в
  // `useAgentLifecycle`: она параметризована `tabId`, поэтому каждая видимая
  // вкладка держит свой экземпляр. Здесь — экземпляр для одиночного режима
  // (центральная поверхность проекта); панели сплита монтируют свои сами.
  //
  // Раньше эта машина жила прямо тут в единственном экземпляре и читала
  // `activeTabId`, из-за чего плашка процесса не строилась для неактивной
  // вкладки вообще — не «скрывалась», а отсутствовала.
  const lifecycleSummary = useAgentLifecycle({
    projectId,
    tabId: activeTabId,
    enabled: currentView === 'terminal',
  });

  useEffect(() => {
    onLifecycleStatusChange?.(lifecycleSummary);
  }, [lifecycleSummary, onLifecycleStatusChange]);

  useEffect(() => () => {
    onLifecycleStatusChange?.(null);
  }, [onLifecycleStatusChange]);

  // Прерванная сессия: сводка выше уже несёт этот вид состояния для СВОЕЙ
  // вкладки, поэтому оверлей читает её, а не считает признак второй раз.
  const isRestoring = useWorkspaceStore((s) => s.isRestoring);
  const activeTabIdForOverlay = activeTabId;
  const interruptedLifecycle = lifecycleSummary?.kind === 'interrupted' ? lifecycleSummary : null;
  const activeTabSessionId = interruptedLifecycle?.sessionId || null;
  // Движок берётся из поля сводки, а НЕ из её заголовка: разбор подписи
  // (`title.startsWith('CODEX')`) связал бы возобновление сессии с текстом, и
  // правка формулировки молча сломала бы «продолжить».
  const activeTabInterruptedEngine: InterruptedEngine | null = interruptedLifecycle?.engine || null;
  const showInterruptedOverlay = !!interruptedLifecycle
    && currentView === 'terminal'
    && !isRestoring;

  
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

  // DEBUG: Track render reason
  const renderCountRef = useRef(0);
  renderCountRef.current++;

  // Check if sub-agent is actively visible (parent Gemini tab is the active tab)
  const isSubAgentVisible = useWorkspaceStore((s) => {
    if (!viewingSubAgentTabId) return false;
    const ws = s.openProjects.get(projectId);
    if (!ws?.activeTabId) return false;
    const viewedTab = ws.tabs.get(viewingSubAgentTabId);
    return !!viewedTab && (viewedTab as any).parentTabId === ws.activeTabId;
  });

  if ((window as any).__NOTED_RENDER_DIAG__ === true) {
    console.warn(`[TerminalArea:RENDER #${renderCountRef.current}] projectId=${projectId} currentView=${currentView}`);
  }

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
        parts.push(`${tab.id}:${tab.tabType || 'terminal'}:${(tab as any).restoreError ? 'restore-error' : 'ok'}`);
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
      // Split composition/focus — pane wrappers restyle without remounts.
      s.splitPanes.map((p) => p.tabId).join('+'),
      String(s.splitFocusedIndex),
      // Divider positions: committed once per finished drag (the live drag
      // moves the DOM directly), so this rebuild runs once per drag, and a
      // LATER rebuild repaints the wrappers at the dragged sizes instead of
      // snapping them back to the equal split.
      splitSizesFingerprint(s.splitSizes),
    ].join('|');
  });

  // Split pane click-to-focus. Capture phase: the pane must become the app's
  // active tab BEFORE the click lands in xterm/composer, so keyboard focus and
  // toolbar follow-through never lag one click behind.
  const splitPaneCount = useWorkspaceStore((s) => s.splitPanes.length);
  const focusedEmptyPaneIndex = useWorkspaceStore((s) => (
    s.splitPanes.length > 0 && isEmptyPane(s.splitPanes[s.splitFocusedIndex])
      ? s.splitFocusedIndex
      : -1
  ));
  useEffect(() => {
    if (splitPaneCount === 0) return;
    const onPointerDown = (e: PointerEvent) => {
      // LEFT button only. A right-click opens a menu ABOUT something; a middle
      // click removes something. Neither is "I want to work in this pane", and
      // moving focus on them yanked the surface out from under the menu the
      // user had just opened. Same rule as the pane header chip.
      if (e.button !== 0) return;
      // An overlay is open → this click belongs to IT: its job is to close the
      // menu, not to work in whatever is underneath. Checked here because this
      // listener is on pointerdown in the CAPTURE phase, while every dismiss
      // handler is on mousedown in the bubble phase — so focus always won the
      // race and the dismissal looked like a deliberate click into the pane.
      // (Reported: right-click pane 1's chip from pane 2, then click inside
      // pane 1 — the menu closed AND pane 1 took focus.)
      if (notePointerDownForDismissal(document)) return;
      const el = (e.target as HTMLElement)?.closest?.('[data-split-pane-index]');
      if (!el) return;
      const idx = Number(el.getAttribute('data-split-pane-index'));
      const st = useWorkspaceStore.getState();
      // The click both FOCUSES the pane and reaches whatever is under it.
      //
      // There used to be a swallow here: the first click into an unfocused pane
      // only selected it, so a stray hit could not expand a thinking block as a
      // side effect of "go here". Removed by request (2026-08-17) — in practice
      // it read as a dead click, and the accidental expansion it prevented is
      // cheaper to undo than a click that does nothing.
      if (Number.isFinite(idx) && idx !== st.splitFocusedIndex) st.focusSplitPane(idx);
    };
    window.addEventListener('pointerdown', onPointerDown, true);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true);
    };
  }, [splitPaneCount]);

  useEffect(() => {
    if (focusedEmptyPaneIndex < 0) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const activeElement = document.activeElement;
      if (activeElement && activeElement !== document.body) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      useWorkspaceStore.getState().removeEmptySplitPane(focusedEmptyPaneIndex);
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [focusedEmptyPaneIndex]);

  // Header row height follows the chip's Settings-driven size. Read OUTSIDE
  // the memo and listed in its deps: a header that grew while the memo held a
  // stale 26 is exactly the chip-over-the-separator bug.
  const attachRowH = useSplitAttachRowHeight();

  // Запуск агента из ШАПКИ ПУСТОГО ОКНА.
  //
  // Полоса кнопок — та же, что в баре новой вкладки (AiLaunchStrip), но здесь
  // ей некуда приземлиться: вкладки в этом окне ещё нет, а превращать чужую
  // (как делает бар, стоящий ВНУТРИ вкладки) тут нечего. Поэтому создаём новую
  // вкладку в конце списка проекта и она сама встаёт в это окно: панель в
  // фокусе принимает активируемую вкладку — то самое общее правило активации,
  // которым пользуются и боковой список, и Ctrl+Tab.
  //
  // Проект берём у ОКНА, а не «активный»: окна кросс-проектные, и вкладка,
  // созданная в чужом проекте, выглядела бы как чужая папка в чужом списке.
  // Пустое окно своего проекта не помнит, поэтому спрашиваем боковое меню —
  // это и есть «где я сейчас работаю».
  const launchIntoEmptyPane = useCallback(async (
    paneIndex: number,
    action: AiLaunchAction | 'empty',
  ) => {
    const store = useWorkspaceStore.getState();
    const targetProjectId = store.getFocusedProjectId() || store.activeProjectId;
    if (!targetProjectId) return;
    const workspace = store.openProjects.get(targetProjectId);
    if (!workspace) return;
    // Окно должно быть в фокусе ДО создания вкладки: активация кладёт её именно
    // в сфокусированное окно, а кликнуть могли по кнопке в шапке соседнего.
    if (store.splitFocusedIndex !== paneIndex) store.focusSplitPane(paneIndex);

    const projectPath = workspace.projectPath && !workspace.projectPath.startsWith('__unset__')
      ? workspace.projectPath
      : '';
    const activeTab = workspace.activeTabId ? workspace.tabs.get(workspace.activeTabId) : null;
    const cwd = projectPath || activeTab?.cwd || '';

    if (action === 'empty') {
      // «Пустая вкладка»: живой shell без агента. Отдельного типа вкладки нет —
      // «пустая» это описание, а не состояние (см. emptyTab.mjs).
      await useWorkspaceStore.getState().createTab(targetProjectId, EMPTY_TAB_NAME, cwd, {
        skipInitialRename: true,
      });
      return;
    }
    if (action === 'sdk') {
      await useWorkspaceStore.getState().createSDKTab(targetProjectId);
      return;
    }
    if (action === 'claude' || action === 'codex') {
      // Тот же контракт, что у всех прочих точек запуска: вкладка несёт
      // pendingAction, а CLI поднимает Terminal.tsx, когда shell готов. Свой
      // запуск отсюда гонялся бы с ним и стартовал два процесса в одном PTY.
      await useWorkspaceStore.getState().createTab(targetProjectId, undefined, cwd, {
        color: action,
        pendingAction: { type: action === 'codex' ? 'codex-new' : 'claude-new' },
        skipInitialRename: true,
      });
      return;
    }
    // Форки из буфера: без UUID в буфере создавать вкладку незачем — пустая
    // вкладка «на всякий случай» это мусор, который пользователь не просил.
    const clipSid = readSessionIdFromClipboard();
    if (!clipSid) {
      useUIStore.getState().showToast('В буфере нет session ID (UUID)', 'warning');
      return;
    }
    if (action === 'sdk-fork') {
      const forkResult = await ipcRenderer.invoke('claude:fork-session-file', {
        sourceSessionId: clipSid,
        cwd,
        skipChainResolve: true,
      });
      if (!forkResult?.success) {
        useUIStore.getState().showToast('Fork failed: ' + (forkResult?.error || 'unknown'), 'error');
        return;
      }
      const sdkTabId = await useWorkspaceStore.getState().createSDKTab(
        targetProjectId,
        `${clipSid.slice(0, 8)}_fork`,
      );
      useWorkspaceStore.getState().updateSDKState(sdkTabId, { claudeSessionId: forkResult.newSessionId });
      return;
    }
    const isCodex = action === 'codex-fork';
    await useWorkspaceStore.getState().createTab(
      targetProjectId,
      `${clipSid.slice(0, 8)}_${isCodex ? 'codex' : 'fork'}`,
      cwd,
      {
        color: isCodex ? 'codex' : 'claude',
        pendingAction: { type: isCodex ? 'codex-fork' : 'claude-fork', sessionId: clipSid },
        nameSetManually: false,
        skipInitialRename: true,
      },
    );
  }, []);

  const terminals = useMemo(() => {
    const t0 = Date.now();
    const result: React.ReactNode[] = [];
    const state = useWorkspaceStore.getState();
    const currentOpenProjects = state.openProjects;
    const activeProjectId = state.activeProjectId;
    const appView = state.view;
    // Split workspace: pane tabs render side-by-side; every OTHER layer keeps
    // its normal mount but is forced inactive. Wrapper divs are persistent
    // (same key/type in both modes) so entering/leaving the split never
    // remounts xterm.
    const splitPanes = state.splitPanes;
    const splitSizes = state.splitSizes;
    const splitActive = splitPanes.length > 0;
    const splitFocusedTabId = splitActive ? (splitPanes[state.splitFocusedIndex]?.tabId || null) : null;
    // Куда рисуется вкладка. ПЕРВОЕ окно, а не последнее: вся разметка окна —
    // шапка, содержимое, рамка фокуса — рендерится вкладкой, которую окно
    // показывает, поэтому тихая перезапись оставляла бы предыдущее окно вообще
    // без разметки: чёрный прямоугольник без шапки, «окно тупо пропало».
    // Состояния «одна вкладка в двух окнах» быть не должно — модель снимает
    // дубликат и при добавлении, и при восстановлении сессии, — поэтому если он
    // всё же дошёл сюда, он должен быть ГРОМКИМ, а не невидимым.
    const paneIndexByTabId = new Map<string, number>();
    splitPanes.forEach((p, i) => {
      if (!p.tabId) return; // намеренно пустое окно
      const already = paneIndexByTabId.get(p.tabId);
      if (already !== undefined) {
        console.warn('[TerminalArea] duplicate pane tab=' + p.tabId.slice(-12)
          + ' panes=' + already + ',' + i + ' — rendering in ' + already);
        return;
      }
      paneIndexByTabId.set(p.tabId, i);
    });
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
        const paneIndex = splitActive ? (paneIndexByTabId.get(tab.id) ?? -1) : -1;
        const inPane = paneIndex >= 0;
        // In split mode ONLY pane tabs are visible; each pane tab renders
        // regardless of which project is globally active.
        const isActiveProject = splitActive
          ? (inPane && appView === 'workspace')
          : isActiveProjectForLayer(projId);
        const active = splitActive
          ? (inPane && appView === 'workspace')
          : isActiveTerminalLayer(projId, tab.id);

        let inner: React.ReactNode = null;
        if (tab.tabType === 'claude-sdk') {
          sdkCount++;
          totalCount++;
          inner = (
            <ClaudeSDKTab
              key={tab.id}
              tabId={tab.id}
              cwd={tab.cwd}
              ownerProjectId={projId}
              active={active}
              isActiveProject={isActiveProject}
            />
          );
        } else if (tab.tabType === 'file') {
          totalCount++;
          // Single mode: linked file tabs render through the global
          // FilePreview overlay in Workspace (no PTY layer, nothing here).
          // Split mode: the pane hosts its own read-only markdown surface —
          // the global overlay is a window-wide singleton and would cover
          // the neighbouring panes.
          if (!inPane) return;
          inner = (
            <SplitFilePane
              key={tab.id}
              filePath={tab.filePath || ''}
              visible={active}
            />
          );
        } else if ((tab as any).restoreError) {
          totalCount++;
          inner = (
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
          // A pane owns its Run after strip: the overlay portals into the
          // pane's own host (z-layer of the PANE, not of the terminal), and
          // agent panes always author through History (docked or inline
          // composer), same as the single-mode agent layouts.
          const paneAgentPair = inPane && resolvePtyAgentOwner(tab) !== null;
          inner = (
            <Terminal
              key={tab.id}
              tabId={tab.id}
              cwd={tab.cwd}
              ownerProjectId={projId}
              active={active}
              isActiveProject={isActiveProject}
              presented={terminalPresented}
              promptQueuePortalHostId={inPane ? splitPaneQueueHostId(tab.id) : promptQueuePortalHostId}
              hidePromptQueueHistoryToggle={inPane ? paneAgentPair : hidePromptQueueHistoryToggle}
              promptQueueInputSurface={inPane
                ? (paneAgentPair ? 'history' : 'terminal')
                : promptQueueInputSurface}
            />
          );
        }

        // Persistent wrapper: single mode = full-size transparent layer, split
        // mode = pane rect with attach row + focus frame. pointerEvents:none —
        // each tab surface re-enables its own hits when presented, so hidden
        // full-size wrappers never shadow the panes below them.
        const focusedPane = inPane && tab.id === splitFocusedTabId;
        result.push(
          <div
            key={`pane:${tab.id}`}
            data-terminal-pane-wrapper={tab.id}
            {...(inPane ? { 'data-split-pane-index': paneIndex } : {})}
            style={{
              ...(inPane
                ? splitPaneRectStyle(paneIndex, splitPanes, splitSizes)
                : { position: 'absolute' as const, inset: 0 }),
              zIndex: inPane ? 2 : (splitActive ? 0 : 1),
              pointerEvents: 'none',
            }}
          >
            {inPane && (
              <SplitPaneAttachRow
                projectId={projId}
                tabId={tab.id}
                focused={focusedPane}
                paneIndex={paneIndex}
              />
            )}
            {/* Toast anchor of THIS tab. A toast about this tab is portalled here,
                so it appears at the top-right of the surface it is about instead
                of the top-right of the whole window (where a message about the
                left pane landed over the right one). Empty box, no hit-testing:
                the toast itself re-enables pointer events. */}
            <div
              data-toast-anchor-tab-id={tab.id}
              style={{
                position: 'absolute',
                top: inPane ? attachRowH + 8 : 8,
                right: 8,
                zIndex: 210,
                pointerEvents: 'none',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'flex-end',
                gap: 8,
                maxWidth: 'min(420px, calc(100% - 16px))',
              }}
            />
            <div
              data-terminal-pane-content
              style={{
                position: 'absolute',
                top: inPane ? attachRowH : 0,
                // A pane's content stops 2px short of the frame. The frame is a
                // 1px line drawn ON the pane's edge; content that reaches the
                // same pixel column touches it, and anything light there — a
                // scrollbar thumb, the Timeline's rail — visually fuses with the
                // line, so the frame reads as noticeably thicker on that side
                // than on the other three. (Reported: "the white frame looks
                // thicker on the left where the scroll is".) Two pixels is
                // enough to separate them and small enough to cost no layout.
                left: inPane ? SPLIT_PANE_CONTENT_INSET_PX : 0,
                right: inPane ? SPLIT_PANE_CONTENT_INSET_PX : 0,
                bottom: 0,
                pointerEvents: 'none',
              }}
            >
              {inPane && tab.tabType !== 'file' ? (
                <SplitPaneSurface
                  projectId={projId}
                  tabId={tab.id}
                  focused={focusedPane}
                  // Статус процесса панель собирает САМА, по своему `tabId`.
                  // Раньше он приходил отсюда пропом, но строился только для
                  // активной вкладки — то есть во второй панели его не было
                  // никогда, сколько бы она ни фильтровала по `tabId`.
                  stacked={paneIsStacked(splitPanes, paneIndex)}
                >
                  {inner}
                </SplitPaneSurface>
              ) : inner}
            </div>
            {inPane && <SplitPaneFocusFrame focused={focusedPane} />}
          </div>
        );
      });
    });

    splitPanes.forEach((pane, paneIndex) => {
      if (!isEmptyPane(pane)) return;
      const focusedPane = paneIndex === state.splitFocusedIndex;
      result.push(
        <div
          key={`pane:empty:${paneIndex}`}
          data-terminal-pane-wrapper="empty"
          data-split-pane-index={paneIndex}
          style={{
            ...splitPaneRectStyle(paneIndex, splitPanes, splitSizes),
            zIndex: 2,
            pointerEvents: 'none',
            background: '#161616',
          }}
        >
          <div
            data-split-attach-row
            // Двойной клик по пустому месту шапки — то же, что в шапке обычного
            // окна: ещё одна вкладка сюда. Пустое окно только выглядит иначе,
            // жест один.
            onDoubleClick={(e) => {
              e.stopPropagation();
              launchIntoEmptyPane(paneIndex, 'empty');
            }}
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              right: 0,
              height: attachRowH,
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              padding: '0 8px',
              boxSizing: 'border-box',
              zIndex: 3,
              pointerEvents: 'auto',
              color: '#8a8a8f',
              fontSize: 11,
              fontWeight: 600,
              userSelect: 'none',
            }}
          >
            {/* Шапка пустого окна называет ЕГО состояние, а кнопки запуска
                переехали вниз, в центр (см. ниже): полоса из шести кнопок в
                строке заголовка выглядела как содержимое окна, хотя окно пустое.
                Юзер: *«кнопки… тогда переносите вниз, если у меня ничего нет —
                это будет более логично»*. */}
            <span style={{ color: '#6f6f75', fontWeight: 500 }}>Нет вкладки</span>
            <span style={{ flex: 1 }} />
            <button
              title="Убрать пустую панель"
              onClick={(e) => {
                e.stopPropagation();
                useWorkspaceStore.getState().removeEmptySplitPane(paneIndex);
              }}
              onPointerDown={(e) => e.stopPropagation()}
              style={{
                width: 18,
                height: 18,
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                padding: 0,
                border: 'none',
                borderRadius: 4,
                background: 'transparent',
                color: '#8f8f94',
                cursor: 'pointer',
                fontSize: 14,
                lineHeight: 1,
              }}
            >
              ×
            </button>
          </div>
          <div
            // Двойной клик по телу — тот же жест, что по шапке: всё окно пустое,
            // и требовать попасть именно в верхние 26 пикселей было бы правилом
            // без причины.
            onDoubleClick={(e) => {
              e.stopPropagation();
              launchIntoEmptyPane(paneIndex, 'empty');
            }}
            style={{
              position: 'absolute',
              top: attachRowH,
              left: 0,
              right: 0,
              bottom: 0,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 10,
              padding: 16,
              background: '#161616',
              color: '#777',
              fontSize: 12.5,
              textAlign: 'center',
              pointerEvents: 'auto',
              userSelect: 'none',
            }}
          >
            {/* ТА ЖЕ полоса запуска, что в баре вкладки — один компонент, не
                копия. Здесь она ВЕДУЩАЯ (рисует и чип Claude): живой сессии в
                пустом окне нет, а значит нет и её отдельной кнопки управления,
                рядом с которой чип оказался бы вторым. */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', justifyContent: 'center' }}>
              <AiLaunchStrip
                ownsClaudeChip
                onLaunch={(action) => launchIntoEmptyPane(paneIndex, action)}
              />
            </div>
            <div style={{ color: '#5f5f65', fontSize: 11.5 }}>
              Двойной клик — пустая вкладка · Ctrl+Tab / Cmd+P или клик по вкладке слева
            </div>
          </div>
          <SplitPaneFocusFrame focused={focusedPane} />
        </div>
      );
    });

    const durMs = Date.now() - t0;
    console.warn(`[TerminalArea:useMemo] RECALCULATING projectId=${projectId.slice(-12)} total=${totalCount} sdk=${sdkCount} split=${splitPanes.length} durMs=${durMs}`);
    return result;
    // lifecycleSummary is a dependency, not a captured constant: panes read the
    // agent's start/stop status from it, and without it here a pane would keep
    // rendering the status from whenever this memo last ran.
  }, [terminalFingerprint, activeLayerKey, projectId, terminalPresented, promptQueuePortalHostId, hidePromptQueueHistoryToggle, promptQueueInputSurface, lifecycleSummary, attachRowH]);

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

      {/* Divider grab strips OVER the pane boundaries. Sibling of the pane
          wrappers on purpose: the live drag walks parentElement to reposition
          them without a store write per mousemove. */}
      <SplitDividerLayer />

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

      {/* The floating "LOADING … SESSION" card used to live here. Removed:
          the same status is already carried by the transcript's own status
          control (HistoryPanel → activeLifecycle), which shows the title, the
          error text and both the dismiss and RETRY buttons — so the card was a
          second answer to a question already answered, in a place that did not
          belong to the tab it described.
          Two concrete costs: it was anchored to the whole window rather than
          to its pane, so in a split it appeared over a NEIGHBOUR's area; and
          its 400px box sat across the pane header, swallowing right-clicks on
          the tab chip underneath. The status now lives inside the surface that
          owns the session — including in panes, which is what the
          lifecycleStatus prop on SplitPaneSurface is for. */}

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
