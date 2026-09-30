// Состояние запуска/остановки агента ОДНОЙ вкладки.
//
// Раньше вся эта машина жила в `TerminalArea` в единственном экземпляре и была
// привязана к АКТИВНОЙ вкладке: `activeAgentStartingInfo` читал
// `workspace.activeTabId`, и каждый обработчик события начинался со сравнения с
// ней. Из-за этого состояние не просто скрывалось, когда вкладка не активна, —
// оно НЕ СТРОИЛОСЬ. Панель истории получала пустоту, и «CLAUDE START FAILED» с
// кнопкой RETRY не показывался ни в неактивной вкладке, ни во второй панели
// сплита, хотя главное свойство этой плашки — что она про КОНКРЕТНЫЙ процесс, и
// к фокусу отношения не имеет (пользователь: «на вкладке вообще с этим не
// связано никак, и не может быть связано»).
//
// Это тот же класс дефекта, что описан в
// `docs/tmp/окно-вкладок-и-переключатель-фичи.md` про хоткей `Cmd+[`: обработчик
// читал активную вкладку вместо вкладки той панели, на которую смотрит
// пользователь. Лечится так же — целью становится конкретная вкладка.
//
// Поэтому здесь всё параметризовано `tabId`: сколько вкладок видно, столько
// экземпляров этой машины и живёт. Само состояние durable — main держит его по
// каждой вкладке отдельно (`claude:get-startup-defaults-gate`,
// `agent:get-launch-preparation-state`, `agent:get-stopping-state`), поэтому
// экземпляр восстанавливает свою вкладку запросом, а события остаются быстрым
// путём, а не единственным.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';
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
import { applyClaudeStartupDefaultsGateFromMain, fetchClaudeStartupDefaultsGate } from '../../utils/claudeStartupDefaultsGate';
import { describeClaudeStartupFailure, formatClaudeStartupFailureReport } from '../../utils/claudeStartupFailure.mjs';
import { resolvePtyAgentOwner } from '../../utils/ptyAgentOwner.mjs';
import {
  clearCodexSurfaceReadIdentity,
  publishCodexSurfaceReadIdentity,
} from '../../utils/codexSurfaceReadIdentityStore.mjs';
import type { AgentLifecycleSummary } from './agentLifecycleSummary';
import { reconcileRestoredInterruptedTab } from '../../utils/interruptedAutoRestore.mjs';

const { ipcRenderer } = window.require('electron');

export type AgentLifecycleEngine = 'claude' | 'codex';

export type SessionStartingState = {
  tabId: string;
  engine: AgentLifecycleEngine;
  sessionId?: string | null;
  since: number;
  lastNotReady?: any;
  holdUntilReady?: boolean;
  manualActionRequired?: boolean;
  startupPending?: boolean;
  startupFailed?: boolean;
  startupError?: string | null;
  startupErrorCode?: string | null;
  startupFailedCommand?: string | null;
  startupProofOutcome?: string | null;
  startupUserRetryable?: boolean;
  startupGeneration?: string | null;
  startupAttemptId?: string | null;
  startupFailureId?: string | null;
  startupGateRevision?: number;
  stickySource?: 'claude-startup-defaults';
  launchPreparing?: boolean;
  launchPreparationPhase?: string | null;
  launchPreparationToken?: number | null;
  launchPreparationStatus?: 'preparing' | 'accepted' | 'rejected' | null;
  lifecycleWarning?: {
    id?: string | null;
    type?: string | null;
    code?: string | null;
    message?: string | null;
    detectedAt?: number | null;
  } | null;
};

export type AgentStoppingState = {
  tabId: string;
  engine: AgentLifecycleEngine;
  since: number;
  reason?: string | null;
};

export const getSessionStartingPresentation = (state: SessionStartingState) => {
  const engineLabel = state.engine === 'codex' ? 'CODEX' : 'CLAUDE';
  const sessionLabel = state.sessionId ? state.sessionId.slice(0, 8) : null;
  const reason = String(state.lastNotReady?.reason || '');
  const blockers = new Set<string>(Array.isArray(state.lastNotReady?.blockers)
    ? state.lastNotReady.blockers
    : []);
  const hasBlocker = (name: string) => blockers.has(name) || reason.includes(name);
  const isError = state.startupFailed === true;

  if (state.lifecycleWarning?.type === 'model-capacity') {
    return {
      isError: state.lifecycleWarning.code === 'codex_capacity_retry_exhausted',
      title: '⚠ CODEX MODEL AT CAPACITY',
      subtitle: state.lifecycleWarning.message
        || 'Selected model is at capacity. Please try a different model.',
      detail: state.lifecycleWarning.code === 'codex_capacity_retry_exhausted'
        ? 'Automatic retries stopped; choose another model or continue manually'
        : 'Automatic continuation follows request settings; you can also choose another model',
    };
  }

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
    const settingFailure = state.engine === 'claude'
      && (state.stickySource === 'claude-startup-defaults' || !!failedCommand)
      ? describeClaudeStartupFailure({
        error: state.startupError,
        errorCode: state.startupErrorCode,
        failedCommand,
      })
      : null;
    return {
      isError: true,
      title: settingFailure ? settingFailure.title : `${engineLabel} START FAILED`,
      // Name the command that actually failed. "Terminal input did not become
      // ready" was wrong in the real incident: the input WAS ready, one startup
      // command was swallowed by the TUI.
      subtitle: settingFailure ? '' : (failedCommand
        ? (proofOutcome === 'unresolved'
          ? `Could not confirm ${failedCommand}`
          : `${failedCommand} was not applied`)
        : (launchFailure?.subtitle || 'Terminal input did not become ready')),
      detail: launchFailure?.detail
        || (settingFailure ? settingFailure.message + '\n\n' + settingFailure.detail : null)
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

  if (hasBlocker('resume-goal') || hasBlocker('usage-exhaustion')) {
    const manual = reason.endsWith('_action_required');
    return { isError: false,
      title: manual ? 'CODEX ЖДЁТ ВЫБОРА' : 'CODEX: ВЫБОР ДЕЙСТВИЯ',
      subtitle: state.lastNotReady?.message || (hasBlocker('resume-goal') ? 'Настройка возобновления Goal' : 'Достигнут лимит использования'),
      detail: manual ? 'Откройте терминал и завершите выбор. Затем можно отправить сообщение из поля ввода.' : 'Применяется глобальная настройка System' };
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
      subtitle: 'MCP servers are still starting',
      detail: `${engineLabel} is not ready for prompts yet`,
    };
  }

  return {
    isError: false,
    title: state.sessionId ? `LOADING ${engineLabel} SESSION...` : `STARTING ${engineLabel}...`,
    subtitle: state.sessionId
      ? 'Restoring the saved conversation'
      : 'Waiting for the terminal to become ready',
    detail: sessionLabel ? `Session ${sessionLabel}` : null,
  };
};

/**
 * Какой агент живёт в этой вкладке. Пустая строка — вкладка не агентская, и
 * машину для неё запускать не нужно.
 *
 * Это единственное место, где решение зависит от записи вкладки, а НЕ от того,
 * активна она или нет.
 */
export function useAgentLifecycleTarget(projectId: string, tabId: string | null) {
  const key = useWorkspaceStore((s) => {
    if (!tabId) return '';
    const ws = s.openProjects.get(projectId);
    const tab = ws?.tabs.get(tabId);
    if (!tab || tab.tabType === 'claude-sdk') return '';
    // Тот же резолвер владельца PTY, что и раньше: какой агент занимает
    // терминал, решается в одном месте на весь проект.
    const engine = resolvePtyAgentOwner(tab) as AgentLifecycleEngine | null;
    if (!engine) return '';
    const sessionId = engine === 'codex' ? (tab.codexSessionId || '') : (tab.claudeSessionId || '');
    return `${tab.id}|${engine}|${sessionId}`;
  });
  return useMemo(() => {
    if (!key) return null;
    const [id, engine, sessionId] = key.split('|');
    if (!id || (engine !== 'claude' && engine !== 'codex')) return null;
    return { tabId: id, engine: engine as AgentLifecycleEngine, sessionId: sessionId || null };
  }, [key]);
}

/**
 * Полная машина «запускается / настраивается / не запустился / останавливается»
 * для одной вкладки.
 *
 * `enabled` — только про то, показывает ли проект терминальную поверхность
 * вообще. Активность вкладки здесь НЕ участвует: процесс идёт независимо от
 * того, куда смотрит пользователь.
 */
export function useAgentLifecycle({
  projectId,
  tabId,
  enabled,
}: {
  projectId: string;
  tabId: string | null;
  enabled: boolean;
}): AgentLifecycleSummary | null {
  const target = useAgentLifecycleTarget(projectId, tabId);
  // «Прерванная сессия» (`wasInterrupted`) больше НЕ имеет собственной
  // lifecycle-презентации. Раньше она рисовала плашку «SESSION INTERRUPTED» и
  // красила статус-иконку терминала в янтарный — юзер (2026-09-11): прерванность
  // не является состоянием терминала, вкладка должна выглядеть просто неактивной.
  // Маркер по-прежнему живёт в store: он кормит AutoResume-очередь следующего
  // boot, счётчик/Resume-all в сайдбаре, а отказ восстановления показывается
  // warning-тостом из AutoResume (App.tsx), не плашкой на терминале.
  const targetRef = useRef(target);
  const probeSeqRef = useRef(0);
  const dismissedKeysRef = useRef<Set<string>>(new Set());
  const [sessionStarting, setSessionStarting] = useState<SessionStartingState | null>(null);
  const [agentStopping, setAgentStopping] = useState<AgentStoppingState | null>(null);

  useEffect(() => {
    targetRef.current = target;
  }, [target]);

  const dismissKey = useCallback((info: { tabId: string; engine: AgentLifecycleEngine; sessionId?: string | null }) => (
    `${info.tabId}|${info.engine}|${info.sessionId || ''}`
  ), []);

  const invalidateProbe = useCallback((eventTabId: string) => {
    probeSeqRef.current = invalidateSessionStartingProbeSequence(
      probeSeqRef.current,
      targetRef.current,
      eventTabId,
    );
  }, []);

  const applyLaunchPreparationState = useCallback((state: any) => {
    const info = targetRef.current;
    if (!info || !enabled) return;
    const stateTabId = String(state?.tabId || info.tabId);
    const engine = state?.toolType === 'codex'
      ? 'codex'
      : (state?.toolType === 'claude' ? 'claude' : info.engine);
    if (info.tabId !== stateTabId || info.engine !== engine) return;
    if (state?.preparing === true || state?.cleared === true) invalidateProbe(stateTabId);
    if (state?.preparing === true) dismissedKeysRef.current.delete(dismissKey(info));
    setSessionStarting((prev) => applyAgentLaunchPreparationSnapshot(prev, info, state));
  }, [dismissKey, enabled, invalidateProbe]);

  const refreshSessionStarting = useCallback(async (reason: string) => {
    const info = targetRef.current;
    const seq = ++probeSeqRef.current;
    if (!info || !enabled) {
      setSessionStarting(null);
      return;
    }
    try {
      const presence = await getHistoryAgentRuntime(info.engine).getPresence(info.tabId, projectId);
      const latest = targetRef.current;
      if (!isSessionStartingProbeCurrent(seq, probeSeqRef.current, info, latest)) return;
      if (info.engine === 'codex') {
        publishCodexSurfaceReadIdentity(info.tabId, presence.runtimeSnapshot || null);
        reconcileRestoredInterruptedTab(useWorkspaceStore.getState(), info.tabId, presence.runtimeSnapshot);
      }
      const isVisibleStartupState = presence.status === 'starting'
        || presence.manualActionRequired === true
        || !!presence.lifecycleWarning;
      if (isVisibleStartupState && dismissedKeysRef.current.has(dismissKey(info))) return;
      if (!isVisibleStartupState) dismissedKeysRef.current.delete(dismissKey(info));
      setSessionStarting((prev) => {
        const next = syncSessionStartingWithPresence(prev, info, presence);
        if (!prev && next) {
          console.warn('[AgentLifecycle] show tab=' + info.tabId.slice(-12) + ' engine=' + info.engine + ' reason=' + reason);
        } else if (prev?.tabId === info.tabId && !next) {
          console.warn('[AgentLifecycle] hide tab=' + info.tabId.slice(-12) + ' engine=' + info.engine + ' reason=' + reason + ' status=' + presence.status);
        }
        return next;
      });
    } catch (e: any) {
      if (seq !== probeSeqRef.current) return;
      console.warn('[AgentLifecycle] presence failed tab=' + info.tabId.slice(-12) + ' engine=' + info.engine + ' reason=' + reason + ' error=' + (e?.message || String(e)));
    }
  }, [dismissKey, enabled, projectId]);

  useEffect(() => {
    if (!target || !enabled) {
      probeSeqRef.current++;
      setSessionStarting(null);
      return;
    }
    void refreshSessionStarting('tab-bind');
  }, [enabled, refreshSessionStarting, target]);

  // Launch preparation starts before a shell command exists, so neither OSC
  // command state nor TUI presence can reconstruct it. Main keeps an exact
  // tab-scoped snapshot; this read makes tab switches lossless.
  useEffect(() => {
    if (!target || !enabled) return;
    let cancelled = false;
    ipcRenderer.invoke('agent:get-launch-preparation-state', target.tabId)
      .then((result: any) => {
        if (cancelled) return;
        if (targetRef.current?.tabId !== target.tabId) return;
        applyLaunchPreparationState(result?.state || null);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [applyLaunchPreparationState, enabled, target]);

  // Re-read the startup gate whenever this machine (re)binds to a Claude tab.
  // The gate event used to be delivered only to the ACTIVE tab; in the
  // 2026-07-25 incident the `failed` event landed 549ms after the user switched
  // away, the active-tab guard dropped it, and coming back showed a generic
  // "starting" with no reason. The event is an optimization; this is the
  // contract — and now it runs for every visible tab, not just the focused one.
  useEffect(() => {
    if (!target || target.engine !== 'claude' || !enabled) return;
    let cancelled = false;
    void fetchClaudeStartupDefaultsGate(target.tabId).then((gate) => {
      if (cancelled) return;
      if (targetRef.current?.tabId !== target.tabId) return;
      setSessionStarting((prev) => restoreClaudeStartupDefaultsGate(prev, target, gate));
      console.warn('[AgentLifecycle] gate-restored tab=' + target.tabId.slice(-12)
        + ' status=' + (gate?.status || 'absent')
        + ' command=' + (gate?.failedCommand || '-')
        + ' outcome=' + (gate?.proofOutcome || '-'));
    }).catch((error: any) => {
      console.warn('[AgentLifecycle] gate read unavailable tab=' + target.tabId.slice(-12)
        + ' error=' + String(error?.message || error));
    });
    return () => { cancelled = true; };
  }, [enabled, target]);

  useEffect(() => {
    if (!tabId || !enabled) {
      setAgentStopping(null);
      return;
    }
    let cancelled = false;
    ipcRenderer.invoke('agent:get-stopping-state', tabId)
      .then((state: any) => {
        if (cancelled) return;
        if (state?.stopping) {
          const engine: AgentLifecycleEngine = state.toolType === 'codex' ? 'codex' : 'claude';
          setAgentStopping((prev) => {
            if (prev?.tabId === tabId && prev.engine === engine) {
              return { ...prev, reason: state.reason || prev.reason || null };
            }
            console.warn('[AgentLifecycle] stopping-hydrate tab=' + tabId.slice(-12) + ' engine=' + engine + ' reason=' + (state.reason || '-'));
            return {
              tabId,
              engine,
              since: state.since || Date.now(),
              reason: state.reason || null,
            };
          });
        } else {
          setAgentStopping((prev) => prev?.tabId === tabId ? null : prev);
        }
      })
      .catch((e: any) => {
        if (!cancelled) console.warn('[AgentLifecycle] stopping-hydrate failed tab=' + tabId.slice(-12) + ' error=' + (e?.message || String(e)));
      });
    return () => { cancelled = true; };
  }, [enabled, tabId]);

  useEffect(() => {
    if (!enabled) return;
    const isMine = (eventTabId?: string | null) => {
      const info = targetRef.current;
      return !!eventTabId && !!info && info.tabId === eventTabId;
    };
    const showFromEvent = (eventTabId: string, reason: string) => {
      const info = targetRef.current;
      if (!isMine(eventTabId) || !info) return;
      dismissedKeysRef.current.delete(dismissKey(info));
      console.warn('[AgentLifecycle] event-start tab=' + eventTabId.slice(-12) + ' engine=' + info.engine + ' reason=' + reason);
      setSessionStarting((prev) => prev?.tabId === eventTabId ? prev : {
        tabId: eventTabId,
        engine: info.engine,
        sessionId: info.sessionId,
        holdUntilReady: true,
        since: Date.now(),
      });
    };
    const hideFromEvent = (
      eventTabId: string,
      reason: string,
      force = false,
      clearRejected = false,
    ) => {
      if (!isMine(eventTabId)) return;
      const info = targetRef.current;
      invalidateProbe(eventTabId);
      if (info) dismissedKeysRef.current.delete(dismissKey(info));
      setSessionStarting((prev) => {
        if (prev?.tabId !== eventTabId) return prev;
        const next = hideSessionStartingFromLifecycle(prev, eventTabId, {
          force,
          clearRejected,
        });
        if (!next) console.warn('[AgentLifecycle] event-hide tab=' + eventTabId.slice(-12) + ' reason=' + reason + ' engine=' + prev.engine);
        return next;
      });
    };
    const onCommandStarted = (_: any, data: { tabId: string; commandType?: string | null }) => {
      if (!isMine(data?.tabId)) return;
      if (data.commandType === 'codex') {
        clearCodexSurfaceReadIdentity(data.tabId);
      }
      if (data.commandType === 'claude' || data.commandType === 'codex') {
        showFromEvent(data.tabId, 'command-started');
      } else {
        void refreshSessionStarting('command-started');
      }
    };
    const onCommandFinished = (_: any, data: { tabId: string }) => {
      hideFromEvent(data?.tabId, 'command-finished', true);
      const info = targetRef.current;
      if (info?.tabId === data?.tabId && info.engine === 'codex') {
        void refreshSessionStarting('command-finished');
      }
    };
    const onClaudeReady = (_: any, data: { tabId: string }) => {
      const info = targetRef.current;
      if (info?.tabId === data?.tabId && info.engine !== 'claude') return;
      hideFromEvent(data?.tabId, 'claude-tui-ready', true, true);
    };
    const onCodexReady = (_: any, data: { tabId: string }) => {
      hideFromEvent(data?.tabId, 'codex-tui-ready', true, true);
      const info = targetRef.current;
      if (info?.tabId === data?.tabId && info.engine === 'codex') {
        void refreshSessionStarting('codex-tui-ready');
      }
    };
    const onClaudeBusy = (_: any, data: { tabId: string; busy: boolean; reason?: string }) => {
      if (!data?.busy || data.reason === 'spinner') return;
      hideFromEvent(data.tabId, 'claude-busy', true);
    };
    const onCodexBusy = (_: any, data: { tabId: string; busy: boolean }) => {
      if (!data?.busy) return;
      hideFromEvent(data.tabId, 'codex-busy', true);
      const info = targetRef.current;
      if (info?.tabId === data.tabId && info.engine === 'codex') {
        void refreshSessionStarting('codex-busy');
      }
    };
    const onCodexSessionDetected = (_: any, data: { tabId?: string }) => {
      const info = targetRef.current;
      if (!isMine(data?.tabId) || info?.engine !== 'codex') return;
      void refreshSessionStarting('codex-session-detected');
    };
    const onCodexNotReady = (_: any, data: { tabId?: string; reason?: string | null }) => {
      const info = targetRef.current;
      if (!isMine(data?.tabId) || info?.engine !== 'codex') return;
      if (data?.reason === 'manual-stop') {
        invalidateProbe(String(data.tabId));
        setSessionStarting(null);
        console.warn('[AgentLifecycle] ignore not-ready after manual Stop tab=' + String(data.tabId).slice(-12));
        return;
      }
      void refreshSessionStarting('codex-tui-not-ready:' + (data?.reason || '-'));
    };
    const onCodexManualAction = (_: any, data: { tabId?: string; type?: string | null }) => {
      const info = targetRef.current;
      if (!isMine(data?.tabId) || info?.engine !== 'codex') return;
      void refreshSessionStarting('codex-manual-action:' + (data?.type || '-'));
    };
    const onCodexRuntimePolicy = (_: any, data: any) => {
      if (data?.toolType === 'codex' && data?.source === 'runtime-policy' && isMine(data?.tabId)) {
        void refreshSessionStarting('codex-runtime-policy');
      }
    };
    const onCodexLifecycleWarning = (_: any, data: { tabId?: string; warning?: any }) => {
      const info = targetRef.current;
      if (!isMine(data?.tabId) || info?.engine !== 'codex') return;
      if (data?.warning) dismissedKeysRef.current.delete(dismissKey(info));
      void refreshSessionStarting('codex-lifecycle-warning:' + (data?.warning?.type || 'cleared'));
    };
    const onLaunchPreparation = (_: any, state: any) => {
      if (!isMine(state?.tabId)) return;
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
      if (!eventTabId || eventTabId !== tabId) return;
      const engine: AgentLifecycleEngine = data.toolType === 'codex' ? 'codex' : 'claude';
      if (data.stopping) {
        invalidateProbe(eventTabId);
        setSessionStarting(null);
        setAgentStopping((prev) => {
          if (prev?.tabId === eventTabId && prev.engine === engine) {
            return { ...prev, reason: data.reason || prev.reason || null };
          }
          console.warn('[AgentLifecycle] stopping-show tab=' + eventTabId.slice(-12) + ' engine=' + engine + ' reason=' + (data.reason || '-'));
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
            console.warn('[AgentLifecycle] stopping-hide tab=' + eventTabId.slice(-12) + ' reason=' + (data.reason || '-'));
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
        errorCode?: string | null;
        failedCommand?: string | null;
        proofOutcome?: string | null;
        userRetryable?: boolean;
        dismissed?: boolean;
      }>).detail || {};
      const gateTabId = detail.tabId || '';
      const info = targetRef.current;
      if (!isMine(gateTabId) || info?.engine !== 'claude') return;
      if (detail.status === 'pending' || (detail.status === 'failed' && !detail.dismissed)) {
        dismissedKeysRef.current.delete(dismissKey(info));
      }
      if (detail.status === 'ready' || detail.status === 'cleared') {
        invalidateProbe(gateTabId);
      }
      if (detail.status === 'ready' || detail.status === 'cleared' || detail.status === 'pending' || detail.status === 'failed') {
        setSessionStarting((prev) => {
          const next = applyClaudeStartupDefaultsGate(prev, info, { ...detail, tabId: gateTabId });
          console.warn('[AgentLifecycle] gate-' + detail.status + ' tab=' + gateTabId.slice(-12) + ' reason=' + (detail.reason || '-') + ' error=' + (detail.error || '-'));
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
    ipcRenderer.on('agent:readiness-changed', onCodexRuntimePolicy);
    ipcRenderer.on('codex:lifecycle-warning', onCodexLifecycleWarning);
    ipcRenderer.on('agent:launch-preparation-state', onLaunchPreparation);
    ipcRenderer.on('claude:busy-state', onClaudeBusy);
    ipcRenderer.on('codex:busy-state', onCodexBusy);
    ipcRenderer.on('codex:session-detected', onCodexSessionDetected);
    ipcRenderer.on('agent:stopping-state', onAgentStopping);
    window.addEventListener('claude-startup-defaults-gate', onClaudeStartupGate);
    return () => {
      ipcRenderer.removeListener('terminal:command-started', onCommandStarted);
      ipcRenderer.removeListener('terminal:command-finished', onCommandFinished);
      ipcRenderer.removeListener('claude:tui-ready', onClaudeReady);
      ipcRenderer.removeListener('codex:tui-ready', onCodexReady);
      ipcRenderer.removeListener('codex:tui-not-ready', onCodexNotReady);
      ipcRenderer.removeListener('codex:tui-manual-action-required', onCodexManualAction);
      ipcRenderer.removeListener('agent:readiness-changed', onCodexRuntimePolicy);
      ipcRenderer.removeListener('codex:lifecycle-warning', onCodexLifecycleWarning);
      ipcRenderer.removeListener('agent:launch-preparation-state', onLaunchPreparation);
      ipcRenderer.removeListener('claude:busy-state', onClaudeBusy);
      ipcRenderer.removeListener('codex:busy-state', onCodexBusy);
      ipcRenderer.removeListener('codex:session-detected', onCodexSessionDetected);
      ipcRenderer.removeListener('agent:stopping-state', onAgentStopping);
      window.removeEventListener('claude-startup-defaults-gate', onClaudeStartupGate);
    };
  }, [applyLaunchPreparationState, dismissKey, enabled, invalidateProbe, refreshSessionStarting, tabId]);

  const handleDismiss = useCallback(() => {
    const current = sessionStarting;
    if (current) {
      dismissedKeysRef.current.add(dismissKey(current));
      console.warn('[AgentLifecycle] dismissed tab=' + current.tabId.slice(-12) + ' engine=' + current.engine);
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
          console.warn('[AgentLifecycle] launch failure dismiss failed tab='
            + current.tabId.slice(-12) + ' error=' + (error?.message || String(error)));
        });
      }
      if (current.engine === 'codex' && current.lifecycleWarning?.id) {
        void ipcRenderer.invoke('codex:clear-lifecycle-warning', {
          tabId: current.tabId,
          warningId: current.lifecycleWarning.id,
        }).then((result: any) => {
          if (result?.warning) {
            dismissedKeysRef.current.delete(dismissKey(current));
            void refreshSessionStarting('warning-dismiss-superseded');
          }
        }).catch((error: any) => {
          console.warn('[AgentLifecycle] warning dismiss failed tab='
            + current.tabId.slice(-12) + ' error=' + (error?.message || String(error)));
        });
      }
      if (current.engine === 'claude' && current.startupFailed && current.startupAttemptId) {
        void ipcRenderer.invoke('claude:dismiss-startup-defaults-failure', {
          tabId: current.tabId, generation: current.startupGeneration, attemptId: current.startupAttemptId,
          failureId: current.startupFailureId,
        }).then((result: any) => {
          if (result?.gate) applyClaudeStartupDefaultsGateFromMain({ ...result.gate, tabId: current.tabId });
          if (result?.dismissed !== true) void refreshSessionStarting('settings-dismiss-superseded');
        }).catch((error: any) => {
          console.warn('[AgentLifecycle] settings dismiss unavailable tab=' + current.tabId.slice(-12)
            + ' error=' + String(error?.message || error));
        });
      }
    }
    setSessionStarting(null);
  }, [applyLaunchPreparationState, dismissKey, refreshSessionStarting, sessionStarting]);

  // Explicit user approval re-enters the main-owned transaction for the same
  // live launch. Main keeps already-proven earlier steps and retries only the
  // failed one.
  const handleRetry = useCallback(async () => {
    const current = sessionStarting;
    if (!current || current.engine !== 'claude') return;
    console.warn('[StartupRetry] decision=user action=manual-retry tab=' + current.tabId.slice(-12)
      + ' command=' + (current.startupFailedCommand || '-'));
    setSessionStarting(null);
    const result = await ipcRenderer.invoke('claude:retry-startup-defaults', {
      tabId: current.tabId,
      generation: current.startupGeneration,
      attemptId: current.startupAttemptId,
    }).catch((error: any) => ({
      success: false,
      accepted: false,
      error: error?.message || String(error),
    }));
    if (result?.gate) {
      applyClaudeStartupDefaultsGateFromMain({ ...result.gate, tabId: current.tabId });
      if (targetRef.current?.tabId === current.tabId) {
        setSessionStarting((prev) => restoreClaudeStartupDefaultsGate(prev, current, result.gate));
      }
      return;
    }
    if (result?.accepted === true) return;
    if (result?.reason === 'stale-settings-attempt' || result?.reason === 'no-live-generation') {
      void refreshSessionStarting('settings-retry-superseded');
      return;
    }
    setSessionStarting((prev) => applyClaudeStartupDefaultsGate(prev, current, {
      tabId: current.tabId,
      status: 'failed',
      reason: 'manual-retry-rejected',
      error: result?.error || result?.reason || 'No live Claude launch to retry',
      failedCommand: current.startupFailedCommand || null,
      proofOutcome: current.startupProofOutcome || null,
      userRetryable: false,
    }));
  }, [refreshSessionStarting, sessionStarting]);

  // Restore is automatic and sequential. Once main has begun or rejected the
  // exact launch, that current transaction is more informative than the old
  // persisted `wasInterrupted` marker. The marker remains durable on failure
  // for the next app start, but it renders no summary of its own (see above).
  return useMemo<AgentLifecycleSummary | null>(() => {
    if (!enabled || !tabId) return null;
    if (agentStopping && agentStopping.tabId === tabId) {
      const engineLabel = agentStopping.engine === 'codex' ? 'CODEX' : 'CLAUDE';
      return {
        tabId: agentStopping.tabId,
        engine: agentStopping.engine,
        kind: 'stopping',
        title: `STOPPING ${engineLabel}...`,
        description: 'Waiting for the process to exit safely',
        detail: agentStopping.reason || null,
        spinner: true,
      };
    }
    if (sessionStarting && sessionStarting.tabId === tabId) {
      const presentation = getSessionStartingPresentation(sessionStarting);
      const isInfo = sessionStarting.manualActionRequired === true && !sessionStarting.lifecycleWarning;
      const isWarning = !!sessionStarting.lifecycleWarning;
      const canRetryStartupSettings = presentation.isError
        && sessionStarting.startupUserRetryable === true;
      return {
        tabId: sessionStarting.tabId,
        sessionId: sessionStarting.sessionId || null,
        engine: sessionStarting.engine,
        kind: isWarning ? 'warning' : presentation.isError ? 'error' : isInfo ? 'info' : 'starting',
        title: presentation.title,
        description: presentation.subtitle,
        detail: presentation.detail,
        copyText: sessionStarting.engine === 'claude' && sessionStarting.startupFailed
          ? formatClaudeStartupFailureReport({ tabId: sessionStarting.tabId, sessionId: sessionStarting.sessionId,
            generation: sessionStarting.startupGeneration, attemptId: sessionStarting.startupAttemptId,
            error: sessionStarting.startupError, errorCode: sessionStarting.startupErrorCode,
            failedCommand: sessionStarting.startupFailedCommand, proofOutcome: sessionStarting.startupProofOutcome })
          : undefined,
        spinner: !presentation.isError && !isWarning && !isInfo,
        dismissLabel: presentation.isError || isWarning || isInfo ? 'Скрыть сообщение' : undefined,
        onDismiss: presentation.isError || isWarning || isInfo ? handleDismiss : undefined,
        retryLabel: canRetryStartupSettings ? 'RETRY SETTINGS' : undefined,
        onRetry: canRetryStartupSettings ? handleRetry : undefined,
      };
    }
    return null;
  }, [agentStopping, enabled, handleDismiss, handleRetry, sessionStarting, tabId]);
}
