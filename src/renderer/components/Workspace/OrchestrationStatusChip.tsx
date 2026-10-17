import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import {
  ArrowDownLeft,
  ArrowUpRight,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  History as HistoryIcon,
  LoaderCircle,
  Pause,
  Play,
  RotateCcw,
  Search,
  Send,
  Settings2,
  Timer,
  TimerOff,
  X,
} from 'lucide-react';
import Tooltip from '../UI/Tooltip';
import { TabMessagePreview, TabMessageRow, TabMessageTracker } from './TabMessageTracker';
import type { MessageSelection } from './TabMessageTracker';
import { useTabMessages } from '../../hooks/useTabMessages';
import { useRequestDockLayout } from '../../hooks/useRequestDockLayout';
import { tabMessageTimestamp, tabMessageVisibleInTracker } from '../../utils/tabMessageProjection';
import { isRequestSuccessPresentation } from '../../utils/requestTrackerVisibility.mjs';
import { RequestTrackerRow, RequestTrackerStatus, requestRowActionStyle, requestRowLinkStyle } from './RequestTrackerRow';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';
import type { OrchestrationRun, OrchestrationStatus } from '../../store/useOrchestrationStore';
import { isOrchestrationResultProofPending, mergeOrchestrationRuns } from '../../utils/orchestrationRunProjection.mjs';
import { orchestrationRequestTime, orchestrationDetailRows } from '../../utils/orchestrationDetails.mjs';

const { ipcRenderer } = window.require('electron');

type OrchestrationSettings = {
  codexCapacityRetryEnabled: boolean;
  codexCapacityRetryLimit: number;
  codexCapacityRetryDelaysMs?: number[];
  failureGraceMs: number;
  successAutoStopMs: number;
  reactToManualInterrupt: boolean;
  autoStopCreatedTargets: boolean;
};

type Props = {
  tabId: string;
  panelOpen: boolean;
  effectiveWidth: number;
  queueVisible?: boolean;
};

const ACTIVE = new Set<OrchestrationStatus>([
  'creating',
  'starting',
  'sending',
  'sent',
  'queued',
  'running',
  'waiting_descendants',
  'waiting_recovery',
]);

const NOTIFICATION_ERRORS = new Set(['waiting-for-input', 'failed', 'unconfirmed']);

const STATUS_LABEL: Record<OrchestrationStatus, string> = {
  creating: 'Создание',
  starting: 'Запуск',
  sending: 'Отправка',
  sent: 'Доставлено',
  queued: 'Ожидает отправки',
  running: 'Работает',
  waiting_descendants: 'Ждёт дочерние',
  waiting_recovery: 'Связь прервана',
  completed: 'Готово',
  failed: 'Ошибка',
  cancelled: 'Закрыто',
};

function statusColor(status: OrchestrationStatus): string {
  if (status === 'completed') return '#4ade80';
  if (status === 'failed') return '#f87171';
  if (status === 'waiting_recovery') return '#fbbf24';
  if (status === 'queued') return '#a1a1aa';
  if (status === 'sent') return '#4ade80';
  if (status === 'sending') return '#60a5fa';
  if (status === 'cancelled') return '#737373';
  return '#a78bfa';
}

type RunPresentation = {
  color: string;
  icon: 'success' | 'error' | 'cancelled' | 'loading' | 'proof' | 'waiting' | 'recovery';
  label: string;
  spinning: boolean;
};

function hasSourceNotificationError(run: OrchestrationRun, tabId: string): boolean {
  return run.sourceTabId === tabId
    && run.notificationSuppressed !== true
    && NOTIFICATION_ERRORS.has(run.notificationStatus || '');
}

function hasPendingSourceHandoff(run: OrchestrationRun, tabId: string): boolean {
  return run.sourceTabId === tabId
    && !isOrchestrationResultProofPending(run)
    && run.sourceFollowupPending === true
    && !run.sourceFollowupStartedAt
    && !hasSourceNotificationError(run, tabId);
}

function canCancelPendingSourceHandoff(run: OrchestrationRun, tabId: string): boolean {
  return hasPendingSourceHandoff(run, tabId)
    && !run.notificationCancelRequestedAt
    && (run.notificationStatus === 'pending' || run.notificationStatus === 'sending');
}

function canRetrySourceNotification(run: OrchestrationRun, tabId: string): boolean {
  return hasSourceNotificationError(run, tabId);
}

function isPaused(run: OrchestrationRun): boolean {
  return run.status === 'waiting_recovery' && run.outcome === 'paused';
}

function canPause(run: OrchestrationRun): boolean {
  if (run.runKind === 'external-research') return false;
  if (isPaused(run) || run.sourceFollowupStartedAt || run.sourceFollowupPending === true) return false;
  if (isOrchestrationResultProofPending(run)) return true;
  if (run.status === 'waiting_recovery') return run.outcome === 'interrupted';
  return ACTIVE.has(run.status)
    && Boolean(run.deliveryAcceptedAt || run.targetPromptProofAt);
}

function attentionDismissedForTab(run: OrchestrationRun, tabId: string): boolean {
  if (run.sourceTabId === tabId && run.sourceAttentionDismissedAt) return true;
  if (run.targetTabId === tabId && run.targetAttentionDismissedAt) return true;
  return false;
}

function runPresentation(run: OrchestrationRun, tabId: string): RunPresentation {
  if (isOrchestrationResultProofPending(run)) {
    return {
      color: '#60a5fa',
      icon: 'proof',
      label: 'Проверка результата',
      spinning: false,
    };
  }
  if (run.status === 'sent' && !run.targetPromptProofAt
    && (run.deliveryAuditPendingAt || run.requiresTargetPromptProof === true)) {
    return {
      color: '#fbbf24',
      icon: 'waiting',
      label: 'Проверка доставки',
      spinning: false,
    };
  }
  if (hasSourceNotificationError(run, tabId)) {
    const unconfirmed = run.notificationStatus === 'unconfirmed';
    return {
      color: unconfirmed || run.notificationStatus === 'waiting-for-input' ? '#fbbf24' : '#f87171',
      icon: 'error',
      label: unconfirmed
        ? 'Доставка не подтверждена'
        : run.notificationStatus === 'waiting-for-input' ? 'Не доставлено' : 'Ошибка доставки',
      spinning: false,
    };
  }
  if (run.status === 'failed') return { color: '#f87171', icon: 'error', label: 'Ошибка', spinning: false };
  if (run.status === 'waiting_recovery') {
    if (run.runKind === 'response-observation') return { color: '#fbbf24', icon: 'error',
      label: 'Проверка недоступна', spinning: false };
    return {
      color: '#fbbf24',
      icon: 'recovery',
      label: run.continuation && ['prepared', 'sending', 'unconfirmed', 'blocked'].includes(run.continuation.state)
        ? run.continuation.state === 'unconfirmed' ? 'Проверка продолжения'
          : run.continuation.state === 'blocked' ? 'Продолжение не отправлено' : 'Подготовка продолжения'
        : isPaused(run)
        ? 'На паузе'
        : run.outcome === 'interrupted' ? 'Работа прервана' : 'Связь прервана',
      spinning: false,
    };
  }
  if (hasPendingSourceHandoff(run, tabId)) {
    return {
      color: run.notificationStatus === 'sent' ? '#4ade80' : run.notificationStatus === 'sending' ? '#60a5fa' : '#a1a1aa',
      icon: 'loading',
      label: run.notificationCancelRequestedAt ? 'Отмена передачи' : 'Передача результата',
      spinning: true,
    };
  }
  if (run.status === 'completed') return { color: '#4ade80', icon: 'success', label: 'Готово', spinning: false };
  if (run.status === 'cancelled') return { color: '#737373', icon: 'cancelled', label: 'Закрыто', spinning: false };
  if (run.runKind === 'response-observation') {
    return { color: '#a78bfa', icon: 'waiting', label: run.status === 'waiting_descendants'
      ? 'Ждёт завершения работы' : 'Ждёт ответ', spinning: false };
  }
  if (run.status === 'sending') {
    return { color: '#60a5fa', icon: 'waiting', label: 'Ожидает доставки', spinning: false };
  }
  if (run.status === 'queued' || run.status === 'sent') {
    return {
      color: run.status === 'queued'
        ? (run.deliveryTransportUnknownAt || run.externalResearchTransportError || run.externalResearchDeliveryUnknown ? '#fbbf24' : '#a1a1aa')
        : '#4ade80',
      icon: 'waiting',
      label: run.status === 'queued' && run.deliveryDeferredReason === 'target-not-idle:busy'
        ? 'Ждёт занятую вкладку'
        : run.status === 'queued' && run.deliveryDeferredReason === 'external-research-transport'
          ? 'Ждёт SC Desktop'
          : STATUS_LABEL[run.status],
      spinning: false,
    };
  }
  return {
    color: statusColor(run.status),
    icon: 'loading',
    label: STATUS_LABEL[run.status],
    spinning: run.status === 'running'
      || run.status === 'starting'
      || run.status === 'waiting_descendants',
  };
}

function runVisibleInTracker(run: OrchestrationRun, tabId: string): boolean {
  const presentation = runPresentation(run, tabId);
  if (isRequestSuccessPresentation(presentation)) return false;
  if (ACTIVE.has(run.status) || isOrchestrationResultProofPending(run)
    || hasPendingSourceHandoff(run, tabId)) return true;
  return presentation.icon === 'error'
    && Boolean(run.attentionRequiredAt) && !attentionDismissedForTab(run, tabId);
}

function StatusIcon({ presentation, compact = false }: { presentation: RunPresentation; compact?: boolean }) {
  if (compact && presentation.icon === 'loading') return null;
  let icon: ReactNode;
  if (presentation.icon === 'success') icon = <CircleCheck size={14} strokeWidth={2.2} />;
  else if (presentation.icon === 'error') icon = <CircleAlert size={14} strokeWidth={2.2} />;
  else if (presentation.icon === 'cancelled') icon = <X size={14} strokeWidth={2.2} />;
  else if (presentation.icon === 'proof') icon = <Search size={14} strokeWidth={2.2} />;
  else if (presentation.icon === 'waiting') icon = <Timer size={14} strokeWidth={2.2} />;
  else if (presentation.icon === 'recovery') {
    icon = (
      <>
        <Timer size={13} strokeWidth={2.2} />
        <CircleAlert size={10} strokeWidth={2.4} />
      </>
    );
  } else {
    icon = (
      <span
        className={presentation.spinning ? 'animate-spin' : ''}
        style={{
          display: 'block', width: 14, height: 14, flexShrink: 0,
          // SVG transform animation rebuilds the retained document's
          // compositor layers in Chromium 120. Rotate the same glyph on an
          // HTML layer; the existing hidden-owner gate pauses this host.
          willChange: presentation.spinning ? 'transform' : undefined,
        }}
      >
        <LoaderCircle size={14} strokeWidth={2.2} style={{ display: 'block' }} />
      </span>
    );
  }
  return (
    <RequestTrackerStatus
      data-orchestration-status-icon={presentation.icon}
    >
      {icon}
    </RequestTrackerStatus>
  );
}

function RunDetailFields({ run, tabId, omitTime = false }: { run: OrchestrationRun; tabId: string; omitTime?: boolean }) {
  return <>{orchestrationDetailRows(run, tabId).filter(row => !omitTime || row.key !== 'time').map(row => (
    <div key={row.key} data-orchestration-detail-field={row.key} style={{ display: 'contents' }}>
      <span>{row.label}</span>
      <span style={{ color: row.error ? '#fca5a5' : '#c7c7c7', minWidth: 0,
        overflowWrap: 'anywhere', whiteSpace: 'pre-wrap', fontVariantNumeric: 'tabular-nums' }}>{row.value}</span>
    </div>
  ))}</>;
}

function countdown(deadline: number | null | undefined, now: number): string | null {
  if (!deadline) return null;
  const seconds = Math.max(0, Math.ceil((deadline - now) / 1000));
  const minutes = Math.floor(seconds / 60);
  const tail = String(seconds % 60).padStart(2, '0');
  return `${minutes}:${tail}`;
}

function minutes(ms: number): number {
  return Math.round(Math.max(0, ms) / 60_000);
}

export function OrchestrationStatusChip({ tabId, panelOpen, effectiveWidth, queueVisible = panelOpen }: Props) {
  const [runs, setRuns] = useState<OrchestrationRun[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [expandedRunIds, setExpandedRunIds] = useState<Set<string>>(() => new Set());
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settings, setSettings] = useState<OrchestrationSettings | null>(null);
  const [actionError, setActionError] = useState<Record<string, string>>({});
  const [now, setNow] = useState(Date.now());
  const rootRef = useRef<HTMLDivElement>(null);
  const settingsSaveChain = useRef<Promise<unknown>>(Promise.resolve());
  const settingsSaveSequence = useRef(0);
  const [settingsSaveError, setSettingsSaveError] = useState(false);
  const openingLinkedRuns = useRef(new Set<string>());
  const [openingLinkedRunIds, setOpeningLinkedRunIds] = useState<Set<string>>(() => new Set());
  const messagePreviewRef = useRef<HTMLElement>(null);
  const messages = useTabMessages(tabId);
  const [selectedMessage, setSelectedMessage] = useState<MessageSelection | null>(null);
  const selectedThread = messages.threads.find(thread => thread.question.messageId === selectedMessage?.messageId);
  const closeMessage = useCallback(() => setSelectedMessage(null), []);
  const openMessage = useCallback((selection: MessageSelection) => {
    setSettingsOpen(false);
    setSelectedMessage(current => current?.messageId === selection.messageId ? null : selection);
  }, []);
  const cancelMessage = async (messageId: string) => {
    if (await messages.cancel(messageId)) {
      setSelectedMessage(current => current?.messageId === messageId ? null : current);
    }
  };

  useEffect(() => {
    let alive = true;
    setRuns([]);
    setExpandedRunIds(new Set());
    setHistoryOpen(false);
    setSettingsOpen(false);
    setSelectedMessage(null);
    void ipcRenderer.invoke('orchestration:get-settings')
      .then((value: OrchestrationSettings) => {
        if (alive && value) setSettings(value);
      })
      .catch(() => {});

    const onChanged = (_event: unknown, payload: { run?: OrchestrationRun }) => {
      const run = payload?.run;
      if (!run || (run.sourceTabId !== tabId && run.targetTabId !== tabId)) return;
      setRuns((current) => mergeOrchestrationRuns(current, [run]));
      setNow(Date.now());
    };
    ipcRenderer.on('orchestration:changed', onChanged);
    void ipcRenderer.invoke('orchestration:list-for-tab', tabId)
      .then((items: OrchestrationRun[]) => {
        if (alive) {
          setRuns((current) => mergeOrchestrationRuns(items, current));
          setNow(Date.now());
        }
      })
      .catch(() => {});
    return () => {
      alive = false;
      ipcRenderer.removeListener('orchestration:changed', onChanged);
    };
  }, [tabId]);

  const hasCountdown = runs.some((run) => run.status === 'waiting_recovery' && run.recoveryDeadlineAt);
  useEffect(() => {
    if (!hasCountdown) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [hasCountdown]);

  useEffect(() => {
    if (!historyOpen && !settingsOpen) return;
    // Read the child surface through a ref so its close cannot replace the
    // parent's outside-click listener in the middle of the same event.
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented && !messagePreviewRef.current) {
        setHistoryOpen(false);
        setSettingsOpen(false);
      }
    };
    const onMouseDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!rootRef.current?.contains(target) && !messagePreviewRef.current?.contains(target)) {
        setHistoryOpen(false);
        setSettingsOpen(false);
        closeMessage();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('mousedown', onMouseDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('mousedown', onMouseDown);
    };
  }, [historyOpen, settingsOpen, closeMessage]);

  const orderedRuns = useMemo(() => [...runs]
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)), [runs]);
  const historyEntries = useMemo(() => [
    ...orderedRuns.map(run => ({ kind: 'run' as const, run, at: run.createdAt || 0, id: 'run:' + run.runId })),
    ...messages.threads.map(thread => ({ kind: 'message' as const, thread,
      at: tabMessageTimestamp(thread.question.createdAt), id: 'message:' + thread.question.messageId })),
  ].sort((a, b) => b.at - a.at || a.id.localeCompare(b.id)), [orderedRuns, messages.threads]);
  const statusRuns = useMemo(() => orderedRuns.filter(run => runVisibleInTracker(run, tabId)), [orderedRuns, tabId]);
  const hasVisibleMessages = messages.threads.some(thread => tabMessageVisibleInTracker(thread, tabId));
  const hasDockEntries = statusRuns.length > 0 || hasVisibleMessages || Boolean(messages.listError);
  const dock = useRequestDockLayout(rootRef, queueVisible, effectiveWidth,
    hasDockEntries || historyOpen || settingsOpen || selectedMessage !== null);

  const openLinkedTab = useCallback(async (run: OrchestrationRun) => {
    if (openingLinkedRuns.current.has(run.runId)) return;
    const isSource = run.sourceTabId === tabId;
    const external = isSource && run.runKind === 'external-research';
    const projectId = isSource ? run.targetProjectId : run.sourceProjectId;
    const projectPath = isSource ? run.targetProjectPath : run.sourceProjectPath;
    const linkedTabId = isSource ? run.targetTabId : run.sourceTabId;
    if (!external && !linkedTabId) return;
    openingLinkedRuns.current.add(run.runId);
    setOpeningLinkedRunIds(new Set(openingLinkedRuns.current));
    setActionError(current => ({ ...current, [run.runId]: '' }));
    try {
      if (external) {
        const result = await ipcRenderer.invoke('orchestration:open-research-job', { runId: run.runId });
        if (result?.success !== true) throw new Error(result?.error || 'Не удалось открыть задачу в SC Desktop');
      } else {
        const opened = await useWorkspaceStore.getState().openTabById(linkedTabId, {
          projectId, projectPath, sourceTabId: tabId, reason: 'orchestration-linked-tab',
        });
        if (!opened) return;
      }
      setHistoryOpen(false);
      closeMessage();
      void ipcRenderer.invoke('orchestration:acknowledge', { runId: run.runId, tabId }).catch(() => {});
    } catch (error) {
      setActionError(current => ({ ...current,
        [run.runId]: error instanceof Error ? error.message : String(error) }));
    } finally {
      openingLinkedRuns.current.delete(run.runId);
      setOpeningLinkedRunIds(new Set(openingLinkedRuns.current));
    }
  }, [tabId, closeMessage]);

  const actionInflight = useRef(new Set<string>());
  const cancellationInflight = useRef(new Set<string>());
  const [actionPending, setActionPending] = useState(new Set<string>());
  const [newRequestAvailable, setNewRequestAvailable] = useState(new Set<string>());
  const runAction = useCallback(async (run: OrchestrationRun, action: 'retry' | 'report' | 'dismiss' | 'dismiss-attention' | 'detach' | 'wait' | 'pause' | 'resume' | 'continue' | 'new-request') => {
    const cancelling = ['detach', 'dismiss', 'report'].includes(action);
    const guard = cancelling ? cancellationInflight.current : actionInflight.current;
    if (guard.has(run.runId)) return;
    guard.add(run.runId);
    if (!cancelling) setActionPending(new Set(actionInflight.current));
    try {
    let cancelSendAccepted = false;
    if (action === 'detach'
      && run.runKind !== 'external-research'
      && !isOrchestrationResultProofPending(run)) {
      const cancellingSourceHandoff = canCancelPendingSourceHandoff(run, tabId);
      if (run.runKind !== 'response-observation' || cancellingSourceHandoff) {
        const cancellationTabId = cancellingSourceHandoff ? run.sourceTabId : run.targetTabId;
        const cancellationHandoffId = !cancellingSourceHandoff && run.continuation && run.continuation.state !== 'bound'
          ? run.continuation.handoffId : cancellingSourceHandoff
          ? (run.notificationHandoffId || `orchestration-complete:${run.runId}`)
          : `orchestration:${run.runId}`;
        const sendCancellation = await ipcRenderer.invoke('agent:cancel-send', {
          tabId: cancellationTabId,
          handoffId: cancellationHandoffId,
        }).catch(() => null);
        cancelSendAccepted = sendCancellation?.cancelled === true;
      }
    }
    const result = await ipcRenderer.invoke('orchestration:action', {
      runId: run.runId,
      action,
      tabId,
      cancelSendAccepted,
    }).catch((error: unknown) => ({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }));
    if (result?.run) {
      setRuns((current) => [...current.filter((item) => item.runId !== result.run.runId), result.run]);
    }
    if (result?.canCreateNewRequest) setNewRequestAvailable(current => new Set(current).add(run.runId));
    setActionError((current) => ({
      ...current,
      [run.runId]: result?.ok === false ? (result.error || 'Действие не выполнено') : '',
    }));
    } finally {
      guard.delete(run.runId);
      if (!cancelling) setActionPending(new Set(actionInflight.current));
    }
  }, [tabId]);

  const saveSettings = useCallback(async (patch: Partial<OrchestrationSettings>) => {
    const sequence = ++settingsSaveSequence.current;
    setSettingsSaveError(false);
    setSettings((current) => current ? { ...current, ...patch } : current);
    const pending = settingsSaveChain.current.catch(() => {}).then(() => ipcRenderer.invoke('orchestration:update-settings', patch));
    settingsSaveChain.current = pending;
    const updated = await pending.catch(() => null);
    if (updated && sequence === settingsSaveSequence.current) setSettings(updated);
    if (!updated && sequence === settingsSaveSequence.current) setSettingsSaveError(true);
  }, []);

  const actionButton = (
    run: OrchestrationRun,
    action: 'retry' | 'report' | 'dismiss' | 'dismiss-attention' | 'detach' | 'wait' | 'pause' | 'resume' | 'continue' | 'new-request',
    label: string,
    icon: ReactNode,
    color: string,
  ) => (
    <button
      type="button"
      data-orchestration-action={action}
      data-orchestration-run-id={run.runId}
      title={label}
      aria-label={label}
      disabled={actionPending.has(run.runId) && !['detach', 'dismiss', 'report'].includes(action)}
      onClick={(event) => {
        event.stopPropagation();
        void runAction(run, action);
      }}
      style={{
        width: 25,
        height: 25,
        display: 'grid',
        placeItems: 'center',
        border: '1px solid #3b3b3b',
        borderRadius: 4,
        background: '#1c1c1c',
        color,
        cursor: actionPending.has(run.runId) && !['detach', 'dismiss', 'report'].includes(action) ? 'default' : 'pointer',
        opacity: actionPending.has(run.runId) && !['detach', 'dismiss', 'report'].includes(action) ? 0.6 : 1,
      }}
    >
      {icon}
    </button>
  );

  const renderTooltip = (run: OrchestrationRun) => {
    const isSource = run.sourceTabId === tabId;
    const linkedTabName = isSource ? run.targetTabName : run.sourceTabName;
    const linkedProjectName = isSource ? run.targetProjectName : run.sourceProjectName;
    const presentation = runPresentation(run, tabId);
    const remaining = countdown(run.recoveryDeadlineAt, now);
    return (
      <div style={{ width: 276, display: 'grid', gap: 6, fontSize: 11, lineHeight: 1.35 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '82px minmax(0, 1fr)', gap: '3px 7px', color: '#a3a3a3' }}>
          <span>Состояние</span><span style={{ color: presentation.color }}>{presentation.label}</span>
          {remaining && <><span>Отправка</span><span style={{ color: '#fbbf24', fontVariantNumeric: 'tabular-nums' }}>{remaining}</span></>}
          {run.status === 'waiting_recovery' && run.outcome === 'interrupted' && <><span>Продолжение</span><span style={{ color: '#e5e7eb' }}>Следующее сообщение в этой вкладке</span></>}
          {isPaused(run) && <><span>Возобновление</span><span style={{ color: '#e5e7eb' }}>Следующий новый ход во вкладке</span></>}
          <span>Проект</span><span style={{ color: '#e5e7eb' }}>{linkedProjectName || '—'}</span>
          <span>{run.runKind === 'external-research' && isSource ? 'Исполнитель' : 'Вкладка'}</span><span style={{ color: '#e5e7eb' }}>{linkedTabName || '—'}</span>
          <RunDetailFields run={run} tabId={tabId} />
          {run.continuation?.error && <><span>Продолжение</span><span style={{ color: '#fbbf24' }}>{run.continuation.error}</span></>}
          <span>runId</span><span style={{ fontFamily: 'monospace', overflowWrap: 'anywhere' }}>{run.runId}</span>
          {run.externalResearchJobId && <><span>jobId</span><span style={{ fontFamily: 'monospace', overflowWrap: 'anywhere' }}>{run.externalResearchJobId}</span></>}
        </div>
        {actionError[run.runId] && <div style={{ color: '#fca5a5' }}>{actionError[run.runId]}</div>}
      </div>
    );
  };

  const renderTooltipActions = (run: OrchestrationRun, compact = false) => {
    const isSource = run.sourceTabId === tabId;
    const canCancelActiveRun = ACTIVE.has(run.status) && run.status !== 'waiting_recovery';
    const canCancelHandoff = canCancelPendingSourceHandoff(run, tabId);
    const canRetryNotification = canRetrySourceNotification(run, tabId);
    const canDetachResultProof = isOrchestrationResultProofPending(run);
    const paused = isPaused(run);
    const pauseAvailable = canPause(run);
    const presentation = runPresentation(run, tabId);
    const canDismissAttention = presentation.icon === 'error'
      && run.status !== 'waiting_recovery'
      && Boolean(run.attentionRequiredAt)
      && !attentionDismissedForTab(run, tabId);
    return (
      <div style={{ width: '100%', minWidth: 0, display: 'flex', alignItems: 'center', gap: 6 }}>
        {!compact && <span style={{ minWidth: 0, flex: 1, display: 'flex', alignItems: 'center', gap: 5, color: '#f3f4f6', fontWeight: 600 }}>
          {isSource ? <ArrowUpRight size={14} /> : <ArrowDownLeft size={14} />}
          <span>{isSource ? 'Исходящий запрос' : 'Входящий запрос'}</span>
        </span>}
        <span style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: compact ? 1 : 0,
          ...(compact ? { flexWrap: 'wrap', justifyContent: 'flex-end', minWidth: 0 } as const : {}) }}>
          {(canCancelActiveRun || canCancelHandoff || canDetachResultProof) && actionButton(
            run,
            'detach',
            canCancelHandoff ? 'Отменить передачу результата' : 'Отвязать запрос',
            <X size={13} />,
            '#f87171',
          )}
          {pauseAvailable && actionButton(run, 'pause', 'Поставить связь на паузу', <Pause size={13} />, '#fbbf24')}
          {paused && actionButton(run, 'resume', 'Продолжить связь со следующего нового хода', <Play size={13} />, '#fbbf24')}
          {canRetryNotification && actionButton(run, 'retry', 'Повторить доставку результата', <RotateCcw size={13} />, '#fbbf24')}
          {run.status === 'waiting_recovery' && !paused && run.runKind !== 'external-research' && run.runKind !== 'response-observation'
            && actionButton(run, 'continue', run.continuation?.state === 'unconfirmed' ? 'Проверить продолжение' : 'Продолжить запрос', <Play size={13} />, '#a78bfa')}
          {run.runKind !== 'external-research' && run.runKind !== 'response-observation'
            && (newRequestAvailable.has(run.runId) || run.replacementRunId || run.status === 'failed' || run.status === 'cancelled')
            && actionButton(run, 'new-request', 'Создать новое поручение в текущих историях; старый запрос сохраняется', <ArrowUpRight size={13} />, '#a78bfa')}
          {run.status === 'waiting_recovery' && !paused && !run.continuation && actionButton(
            run,
            'retry',
            run.runKind === 'response-observation' ? 'Повторить проверку' : run.outcome === 'interrupted' ? 'Восстановить связь вручную' : 'Восстановить связь',
            <RotateCcw size={13} />,
            '#fbbf24',
          )}
          {run.status === 'waiting_recovery' && !paused && run.outcome === 'interrupted' && run.recoveryDeadlineAt && actionButton(run, 'wait', 'Продолжить ожидание без таймера', <TimerOff size={13} />, '#fbbf24')}
          {run.status === 'waiting_recovery' && !paused && run.runKind !== 'response-observation' && actionButton(run, 'report', 'Передать ошибку родителю', <Send size={13} />, '#f87171')}
          {run.status === 'waiting_recovery' && actionButton(run, paused ? 'detach' : 'dismiss', paused ? 'Отвязать запрос' : 'Закрыть без сообщения', <X size={13} />, '#a3a3a3')}
          {canDismissAttention && actionButton(run, 'dismiss-attention', 'Закрыть уведомление об ошибке', <X size={13} />, '#a3a3a3')}
        </span>
      </div>
    );
  };

  const panelStyle: CSSProperties = {
    position: 'absolute',
    top: dock.panelTop,
    right: dock.panelRight,
    width: dock.panelWidth,
    maxHeight: 'min(290px, calc(100vh - 110px))',
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
    background: '#151515',
    border: '1px solid #3a3a3a',
    borderRadius: 6,
    boxShadow: '0 10px 28px rgba(0,0,0,0.44)',
    color: '#e5e5e5',
    zIndex: 8,
  };

  const historyPanel = historyOpen ? (
    <aside data-orchestration-history-panel role="dialog" aria-label="История запросов" style={panelStyle}>
      <div style={{ height: 34, padding: '0 7px 0 9px', display: 'flex', alignItems: 'center', gap: 7, borderBottom: '1px solid #303030', flexShrink: 0 }}>
        <HistoryIcon size={14} color="#a3a3a3" />
        <span style={{ minWidth: 0, flex: 1, fontSize: 11, fontWeight: 650 }}>История запросов</span>
        <span style={{ fontSize: 10, color: '#777' }}>{historyEntries.length}</span>
        <button type="button" aria-label="Закрыть" onClick={() => { setHistoryOpen(false); closeMessage(); }} style={{ width: 24, height: 24, display: 'grid', placeItems: 'center', border: 0, background: 'transparent', color: '#999', cursor: 'pointer' }}>
          <X size={14} />
        </button>
      </div>
      <div data-request-history-list className="scrollbar-thin" style={{ minHeight: 0, overflowY: 'auto' }}>
        {messages.listError && <div role="alert" style={{ padding: 8, fontSize: 10, color: '#fbbf24' }}>Сообщения недоступны: {messages.listError}</div>}
        {!historyEntries.length && !messages.listError && <div style={{ padding: 10, fontSize: 11, color: '#888' }}>Запросов пока нет</div>}
        {historyEntries.map((entry) => {
          if (entry.kind === 'message') return <TabMessageRow key={entry.id} thread={entry.thread} tabId={tabId}
            history selected={selectedMessage?.messageId === entry.thread.question.messageId}
            onOpen={openMessage} onDismiss={cancelMessage} error={messages.actionErrors[entry.thread.question.messageId]} />;
          const run = entry.run;
          const isSource = run.sourceTabId === tabId;
          const linkedTabName = isSource ? run.targetTabName : run.sourceTabName;
          const linkedProjectName = isSource ? run.targetProjectName : run.sourceProjectName;
          const presentation = runPresentation(run, tabId);
          const requestTime = orchestrationRequestTime(run);
          const expanded = expandedRunIds.has(run.runId);
          const canDismissAttention = presentation.icon === 'error'
            && run.status !== 'waiting_recovery'
            && Boolean(run.attentionRequiredAt)
            && !attentionDismissedForTab(run, tabId);
          return (
            <div key={run.runId} data-orchestration-run-id={run.runId} style={{ borderBottom: '1px solid #292929', background: expanded ? '#191919' : 'transparent' }}>
              <div style={{ minHeight: 44, padding: '0 6px 0 3px', display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto auto', alignItems: 'center', gap: 3 }}>
                <button
                  type="button"
                  aria-expanded={expanded}
                  onClick={() => setExpandedRunIds((current) => {
                    const next = new Set(current);
                    if (next.has(run.runId)) next.delete(run.runId);
                    else next.add(run.runId);
                    return next;
                  })}
                  style={{ minWidth: 0, alignSelf: 'stretch', padding: '5px 4px', display: 'grid', gridTemplateColumns: '14px 26px minmax(0, 1fr)', gridTemplateRows: 'auto auto', alignItems: 'center', columnGap: 5, border: 0, background: 'transparent', color: '#d4d4d4', textAlign: 'left', cursor: 'pointer' }}
                >
                  <span style={{ gridRow: '1 / 3', color: '#737373', display: 'grid', placeItems: 'center' }}>{expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}</span>
                  <span style={{ color: presentation.color, display: 'grid', placeItems: 'center' }}><StatusIcon presentation={presentation} /></span>
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 11, fontWeight: 600 }}>{run.label || linkedTabName || 'Запрос'}</span>
                  <span style={{ color: '#8f8f8f', display: 'grid', placeItems: 'center' }}>{isSource ? <ArrowUpRight size={12} /> : <ArrowDownLeft size={12} />}</span>
                  <span style={{ color: '#858585', fontSize: 9, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{linkedProjectName || '—'} · {linkedTabName || '—'}</span>
                </button>
                <span style={{ color: presentation.color, fontSize: 9, whiteSpace: 'nowrap' }}>{presentation.label}</span>
                {canDismissAttention ? (
                  <button
                    type="button"
                    aria-label="Закрыть уведомление об ошибке"
                    title="Закрыть уведомление об ошибке"
                    onClick={() => void runAction(run, 'dismiss-attention')}
                    style={{ width: 23, height: 23, display: 'grid', placeItems: 'center', border: 0, borderRadius: 4, background: 'transparent', color: '#999', cursor: 'pointer' }}
                  >
                    <X size={13} />
                  </button>
                ) : <span style={{ width: 23 }} />}
                <time data-orchestration-request-time dateTime={requestTime.dateTime}
                  style={{ gridColumn: '1 / -1', margin: '-4px 0 5px 54px', minWidth: 0, color: '#858585',
                    fontSize: 9, fontVariantNumeric: 'tabular-nums', overflowWrap: 'anywhere' }}>
                  {requestTime.label} {requestTime.value}
                </time>
              </div>
              {expanded && (
                <div data-orchestration-run-details={run.runId} style={{ margin: '0 8px 8px 36px', padding: '7px 8px', display: 'grid', gridTemplateColumns: '68px minmax(0, 1fr)', gap: '4px 7px', borderLeft: `2px solid ${presentation.color}`, background: '#121212', color: '#919191', fontSize: 9, lineHeight: 1.35 }}>
                  <RunDetailFields run={run} tabId={tabId} omitTime />
                  <span>runId</span><span style={{ color: '#aaa', fontFamily: 'monospace', overflowWrap: 'anywhere' }}>{run.runId}</span>
                  <span />
                  <span style={{ display: 'flex', justifyContent: 'flex-end', gap: 4 }}>
                    {renderTooltipActions(run, true)}
                      <button type="button"
                        title={isSource && run.runKind === 'external-research' ? 'Открыть задачу в SC Desktop' : 'Открыть связанную вкладку'}
                        aria-label={isSource && run.runKind === 'external-research' ? 'Открыть задачу в SC Desktop' : 'Открыть связанную вкладку'}
                        aria-busy={openingLinkedRunIds.has(run.runId)}
                        onClick={() => void openLinkedTab(run)} style={{ width: 24, height: 24, display: 'grid', placeItems: 'center', border: '1px solid #333', borderRadius: 4, background: '#191919', color: '#aaa', cursor: openingLinkedRunIds.has(run.runId) ? 'default' : 'pointer' }}>
                        {isSource ? <ArrowUpRight size={13} /> : <ArrowDownLeft size={13} />}
                      </button>
                  </span>
                  {actionError[run.runId] && <><span>Действие</span><span style={{ color: '#fca5a5' }}>{actionError[run.runId]}</span></>}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </aside>
  ) : null;

  const settingsPanel = settingsOpen && settings ? (
    <aside data-orchestration-settings-panel role="dialog" aria-label="Настройки запросов"
      style={{ ...panelStyle, maxHeight: 'min(560px, calc(100vh - 110px))', display: 'flex', flexDirection: 'column' }}>
      <div style={{ height: 34, flexShrink: 0, padding: '0 7px 0 9px', display: 'flex', alignItems: 'center', gap: 7, borderBottom: '1px solid #303030' }}>
        <Settings2 size={14} color="#a3a3a3" />
        <span style={{ flex: 1, fontSize: 11, fontWeight: 650 }}>Настройки запросов</span>
        <button type="button" aria-label="Закрыть" onClick={() => setSettingsOpen(false)} style={{ width: 24, height: 24, display: 'grid', placeItems: 'center', border: 0, background: 'transparent', color: '#999', cursor: 'pointer' }}><X size={14} /></button>
      </div>
      <div data-orchestration-settings-body className="scrollbar-thin" style={{ padding: 10, minHeight: 0, overflowY: 'auto', display: 'grid', gap: 9, fontSize: 11 }}>
        <label style={{ display: 'grid', gridTemplateColumns: '1fr 64px', alignItems: 'center', gap: 8, color: '#aaa' }}>
          Передать ошибку через, мин
          <input type="number" min={0} max={10080} value={minutes(settings.failureGraceMs)} onChange={(event) => void saveSettings({ failureGraceMs: Number(event.target.value) * 60_000 })} style={{ width: 64, background: '#1d1d1d', color: '#ddd', border: '1px solid #3b3b3b', borderRadius: 4, padding: '4px 6px' }} />
        </label>
        <label style={{ display: 'grid', gridTemplateColumns: '1fr 64px', alignItems: 'center', gap: 8, color: '#aaa' }}>
          Остановить после успеха, мин
          <input type="number" min={0} max={10080} value={minutes(settings.successAutoStopMs)} onChange={(event) => void saveSettings({ successAutoStopMs: Number(event.target.value) * 60_000 })} style={{ width: 64, background: '#1d1d1d', color: '#ddd', border: '1px solid #3b3b3b', borderRadius: 4, padding: '4px 6px' }} />
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, color: '#aaa' }}>
          <input type="checkbox" checked={settings.reactToManualInterrupt} onChange={(event) => void saveSettings({ reactToManualInterrupt: event.target.checked })} />
          Реагировать на ручной Escape
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, color: '#aaa' }}>
          <input type="checkbox" checked={settings.autoStopCreatedTargets} onChange={(event) => void saveSettings({ autoStopCreatedTargets: event.target.checked })} />
          Останавливать созданных исполнителей
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, color: '#aaa' }}>
          <input type="checkbox" data-codex-capacity-retry-enabled checked={settings.codexCapacityRetryEnabled} onChange={(event) => void saveSettings({ codexCapacityRetryEnabled: event.target.checked })} />
          Продолжать при перегрузке модели
        </label>
        <div data-codex-capacity-retry-options style={{ marginLeft: 18, paddingLeft: 10, borderLeft: '1px solid #404040', display: 'grid', gap: 9 }}>
        <label style={{ display: 'grid', gridTemplateColumns: '1fr 64px', alignItems: 'center', gap: 8, color: '#aaa' }}>
          Повторов без прогресса
          <input type="number" data-codex-capacity-retry-limit min={1} max={10} step={1} value={settings.codexCapacityRetryLimit} disabled={!settings.codexCapacityRetryEnabled} onChange={(event) => {
            const value = Number(event.target.value);
            if (Number.isFinite(value)) void saveSettings({ codexCapacityRetryLimit: Math.max(1, Math.min(10, Math.trunc(value))) });
          }} style={{ width: 64, background: '#1d1d1d', color: '#ddd', border: '1px solid #3b3b3b', borderRadius: 4, padding: '4px 6px' }} />
        </label>
        <div style={{ color: '#999' }}>Если перегрузка повторяется:</div>
        {(settings.codexCapacityRetryDelaysMs || []).map((delay, index, delays) => (
          <div key={index} data-codex-capacity-delay-row style={{ display: 'flex', alignItems: 'center', gap: 6, color: '#aaa' }}>
            <label style={{ display: 'flex', flex: 1, alignItems: 'center', gap: 6 }}>
              <span style={{ flex: 1 }}>Затем через</span>
              <input type="number" aria-label={'Задержка повтора ' + (index + 1)} data-codex-capacity-delay min={1} max={10080} step={1}
                value={delay / 60_000} disabled={!settings.codexCapacityRetryEnabled}
                onChange={event => {
                  const value = Number(event.target.value);
                  if (Number.isFinite(value)) void saveSettings({ codexCapacityRetryDelaysMs: delays.map((ms, i) =>
                    i === index ? Math.max(1, Math.min(10080, Math.trunc(value))) * 60_000 : ms) });
                }} style={{ width: 54, background: '#1d1d1d', color: '#ddd', border: '1px solid #3b3b3b', borderRadius: 4, padding: '4px 6px' }} />
              <span>мин</span>
            </label>
            <button type="button" aria-label={'Удалить повтор ' + (index + 1)} disabled={!settings.codexCapacityRetryEnabled}
              onClick={() => void saveSettings({ codexCapacityRetryDelaysMs: delays.filter((_, i) => i !== index) })}
              style={{ border: 0, background: 'transparent', color: '#999', cursor: 'pointer' }}><X size={13} /></button>
          </div>
        ))}
        <button type="button" data-codex-capacity-add-delay disabled={!settings.codexCapacityRetryEnabled || (settings.codexCapacityRetryDelaysMs?.length || 0) >= 10}
          onClick={() => void saveSettings({ codexCapacityRetryDelaysMs: [...(settings.codexCapacityRetryDelaysMs || []), 60 * 60_000] })}
          style={{ justifySelf: 'start', color: '#c084fc', background: 'transparent', border: 0, padding: 0, cursor: 'pointer' }}>+ Добавить повтор</button>
        <div style={{ color: '#777', lineHeight: 1.4 }}>Для Codex: после ответа или вызова инструмента отсчёт начинается заново.</div>
        </div>
        {settingsSaveError && <div role="alert" style={{ color: '#f87171' }}>Настройки не сохранены. Измените значение, чтобы повторить сохранение.</div>}
      </div>
    </aside>
  ) : null;

  return (
    <div
      ref={rootRef}
      data-orchestration-status
      style={{ display: 'contents', pointerEvents: 'auto' }}
    >
      <div data-orchestration-activity-dock data-collapsed={!dock.visible || undefined} className="scrollbar-thin"
        style={{ position: 'absolute', top: 0, right: dock.right, width: 178, maxHeight: dock.maxHeight,
          display: dock.visible && hasDockEntries ? 'flex' : 'none', flexDirection: 'column',
          border: '1px solid #444', borderRadius: 5, background: '#171717', boxSizing: 'border-box',
          boxShadow: '0 2px 10px rgba(0,0,0,0.22)',
          overflowY: 'auto', overflowX: 'hidden', pointerEvents: 'auto' }}>
      <TabMessageTracker tabId={tabId} controller={messages} onOpen={openMessage} onDismiss={cancelMessage} selectedMessageId={selectedMessage?.messageId} />
      {statusRuns.length > 0 && (
        <div
          data-orchestration-active-list
          style={{
            width: '100%',
            minWidth: 0,
            flexShrink: 0,
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          {statusRuns.map((run, index) => {
            const isSource = run.sourceTabId === tabId;
            const linkedTabName = isSource ? run.targetTabName : run.sourceTabName;
            const presentation = runPresentation(run, tabId);
            const canDismissAttention = presentation.icon === 'error'
              && run.status !== 'waiting_recovery'
              && Boolean(run.attentionRequiredAt)
              && !attentionDismissedForTab(run, tabId);
            const canDismissRecovery = run.status === 'waiting_recovery';
            const canDetachResultProof = isOrchestrationResultProofPending(run);
            const paused = isPaused(run);
            const externalSourceRun = isSource && run.runKind === 'external-research';
            const activeRunContent = (
              <>
                <StatusIcon presentation={presentation} compact />
                {isSource ? <ArrowUpRight size={12} strokeWidth={2.2} /> : <ArrowDownLeft size={12} strokeWidth={2.2} />}
                <span style={{ color: '#d4d4d4', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, textAlign: 'left', fontSize: 10 }}>{linkedTabName || 'Запрос'}</span>
                {run.status === 'waiting_recovery' && countdown(run.recoveryDeadlineAt, now) && <span style={{ fontSize: 9, fontVariantNumeric: 'tabular-nums' }}>{countdown(run.recoveryDeadlineAt, now)}</span>}
              </>
            );
            return (
              <Tooltip
                key={run.runId}
                content={renderTooltip(run)}
                actionBar={renderTooltipActions(run)}
                side="left"
                align="start"
                boundarySelector="[data-split-pane-queue-host], [data-workspace-prompt-queue-host]"
                disabled={!dock.visible || historyOpen || settingsOpen || Boolean(selectedMessage)}
                always
              >
                <RequestTrackerRow data-orchestration-active-run={run.runId}
                  style={{ borderBottom: index < statusRuns.length - 1 ? '1px solid #303030' : 0 }}
                  actions={(canDismissAttention || canDismissRecovery || canDetachResultProof) && (
                    <button type="button" data-orchestration-dismiss={run.runId}
                      title={canDetachResultProof || paused ? 'Отвязать запрос' : canDismissRecovery ? 'Закрыть без сообщения' : 'Закрыть уведомление об ошибке'}
                      aria-label={canDetachResultProof || paused ? 'Отвязать запрос' : canDismissRecovery ? 'Закрыть без сообщения' : 'Закрыть уведомление об ошибке'}
                      onClick={event => {
                        event.stopPropagation();
                        void runAction(run, canDetachResultProof || paused ? 'detach' : canDismissRecovery ? 'dismiss' : 'dismiss-attention');
                      }} style={requestRowActionStyle}><X size={13} /></button>
                  )}>
                    <button
                      type="button"
                      data-orchestration-external-target={externalSourceRun || undefined}
                      onClick={() => void openLinkedTab(run)}
                      title={externalSourceRun ? 'Открыть задачу в SC Desktop' : 'Открыть связанную вкладку'}
                      aria-label={externalSourceRun ? `Открыть задачу в SC Desktop: ${linkedTabName || 'Research'}` : `Открыть ${linkedTabName || 'связанную вкладку'}`}
                      aria-busy={openingLinkedRunIds.has(run.runId)}
                      onMouseEnter={event => { event.currentTarget.style.background = '#303030'; }}
                      onMouseLeave={event => { event.currentTarget.style.background = 'transparent'; }}
                      style={{ ...requestRowLinkStyle, color: presentation.color,
                        cursor: openingLinkedRunIds.has(run.runId) ? 'default' : 'pointer' }}
                    >
                      {activeRunContent}
                    </button>
                </RequestTrackerRow>
              </Tooltip>
            );
          })}
        </div>
      )}
      </div>
      {/* A button that opened a panel must LOOK opened: without it the only
          way to tell which of the two panels is on screen is to read the panel
          itself. Active state brightens border/background/text together — an
          opacity-only difference is not reliably visible. Hover matches the
          neighbouring controls. */}
      <button
        type="button"
        data-orchestration-history-button
        data-active={historyOpen ? 'true' : undefined}
        onClick={() => { setHistoryOpen((open) => !open); setSettingsOpen(false); closeMessage(); }}
        aria-label="Открыть историю запросов"
        aria-expanded={historyOpen}
        title="История запросов и переписки"
        style={{
          height: 26,
          padding: '0 7px',
          display: 'flex',
          alignItems: 'center',
          gap: 5,
          borderRadius: 5,
          border: `1px solid ${historyOpen ? '#6b6b6b' : '#444'}`,
          background: historyOpen ? '#2c2c2c' : '#171717',
          color: historyOpen ? '#f0f0f0' : '#aaa',
          cursor: 'pointer',
          boxSizing: 'border-box',
          fontSize: 10,
          transition: 'background-color 0.12s ease, color 0.12s ease, border-color 0.12s ease',
        }}
        onMouseEnter={(e) => {
          if (historyOpen) return;
          (e.currentTarget as HTMLElement).style.background = '#232323';
          (e.currentTarget as HTMLElement).style.color = '#ddd';
        }}
        onMouseLeave={(e) => {
          if (historyOpen) return;
          (e.currentTarget as HTMLElement).style.background = '#171717';
          (e.currentTarget as HTMLElement).style.color = '#aaa';
        }}
      >
        <HistoryIcon size={13} color={!dock.visible && (statusRuns.length > 0
          || hasVisibleMessages) ? '#a78bfa' : undefined} /><span>History</span>
      </button>
      <button
        type="button"
        data-orchestration-settings-button
        data-active={settingsOpen ? 'true' : undefined}
        onClick={() => { setSettingsOpen((open) => !open); setHistoryOpen(false); closeMessage(); }}
        aria-label="Настройки запросов"
        aria-expanded={settingsOpen}
        title="Настройки запросов"
        style={{
          width: 26,
          height: 26,
          display: 'grid',
          placeItems: 'center',
          borderRadius: 5,
          border: `1px solid ${settingsOpen ? '#6b6b6b' : '#444'}`,
          background: settingsOpen ? '#2c2c2c' : '#171717',
          color: settingsOpen ? '#f0f0f0' : '#888',
          cursor: 'pointer',
          transition: 'background-color 0.12s ease, color 0.12s ease, border-color 0.12s ease',
        }}
        onMouseEnter={(e) => {
          if (settingsOpen) return;
          (e.currentTarget as HTMLElement).style.background = '#232323';
          (e.currentTarget as HTMLElement).style.color = '#ccc';
        }}
        onMouseLeave={(e) => {
          if (settingsOpen) return;
          (e.currentTarget as HTMLElement).style.background = '#171717';
          (e.currentTarget as HTMLElement).style.color = '#888';
        }}
      >
        <Settings2 size={13} />
      </button>
      {historyPanel}
      {settingsPanel}
      {selectedMessage && selectedThread && <TabMessagePreview key={tabId + ':' + selectedMessage.messageId}
        selection={selectedMessage} thread={selectedThread} controller={messages} onClose={closeMessage} previewRef={messagePreviewRef} />}
    </div>
  );
}
