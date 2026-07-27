import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import {
  ArrowDownLeft,
  ArrowUpRight,
  CircleAlert,
  CircleCheck,
  CircleStop,
  History as HistoryIcon,
  LoaderCircle,
  RotateCcw,
  Send,
  Settings2,
  X,
} from 'lucide-react';
import Tooltip from '../UI/Tooltip';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';
import type { OrchestrationRun, OrchestrationStatus } from '../../store/useOrchestrationStore';

const { ipcRenderer } = window.require('electron');

type OrchestrationSettings = {
  failureGraceMs: number;
  successAutoStopMs: number;
  reactToManualInterrupt: boolean;
  autoStopCreatedTargets: boolean;
};

type Props = {
  tabId: string;
  rightOffset: number;
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

const STATUS_LABEL: Record<OrchestrationStatus, string> = {
  creating: 'Создание',
  starting: 'Запуск',
  sending: 'Отправка',
  sent: 'Доставлено',
  queued: 'Ожидает ввода',
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
  if (status === 'waiting_recovery' || status === 'queued' || status === 'sent') return '#fbbf24';
  if (status === 'cancelled') return '#737373';
  return '#a78bfa';
}

function StatusIcon({ status }: { status: OrchestrationStatus }) {
  if (status === 'completed') return <CircleCheck size={14} strokeWidth={2.2} />;
  if (status === 'failed' || status === 'waiting_recovery') return <CircleAlert size={14} strokeWidth={2.2} />;
  if (status === 'cancelled') return <X size={14} strokeWidth={2.2} />;
  return (
    <LoaderCircle
      className={status === 'running' || status === 'starting' || status === 'sending' || status === 'waiting_descendants' ? 'animate-spin' : ''}
      size={14}
      strokeWidth={2.2}
    />
  );
}

function runTime(value?: number | null): string {
  if (!value) return '—';
  return new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
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

export function OrchestrationStatusChip({ tabId, rightOffset }: Props) {
  const [runs, setRuns] = useState<OrchestrationRun[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settings, setSettings] = useState<OrchestrationSettings | null>(null);
  const [actionError, setActionError] = useState<Record<string, string>>({});
  const [now, setNow] = useState(Date.now());
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    void ipcRenderer.invoke('orchestration:list-for-tab', tabId)
      .then((items: OrchestrationRun[]) => {
        if (alive) setRuns(Array.isArray(items) ? items : []);
      })
      .catch(() => {});
    void ipcRenderer.invoke('orchestration:get-settings')
      .then((value: OrchestrationSettings) => {
        if (alive && value) setSettings(value);
      })
      .catch(() => {});

    const onChanged = (_event: unknown, payload: { run?: OrchestrationRun }) => {
      const run = payload?.run;
      if (!run || (run.sourceTabId !== tabId && run.targetTabId !== tabId)) return;
      setRuns((current) => {
        const next = current.filter((item) => item.runId !== run.runId);
        next.push(run);
        return next;
      });
    };
    ipcRenderer.on('orchestration:changed', onChanged);
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
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setHistoryOpen(false);
        setSettingsOpen(false);
      }
    };
    const onMouseDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setHistoryOpen(false);
        setSettingsOpen(false);
      }
    };
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('mousedown', onMouseDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('mousedown', onMouseDown);
    };
  }, [historyOpen, settingsOpen]);

  const orderedRuns = useMemo(() => [...runs]
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)), [runs]);
  const activeRuns = useMemo(() => orderedRuns.filter((run) => (
    ACTIVE.has(run.status)
    || (run.sourceTabId === tabId && ['waiting-for-input', 'failed'].includes(run.notificationStatus || ''))
  )), [orderedRuns, tabId]);

  const openLinkedTab = useCallback(async (run: OrchestrationRun) => {
    const isSource = run.sourceTabId === tabId;
    const projectId = isSource ? run.targetProjectId : run.sourceProjectId;
    const projectPath = isSource ? run.targetProjectPath : run.sourceProjectPath;
    const linkedTabId = isSource ? run.targetTabId : run.sourceTabId;
    if (!projectId || !linkedTabId) return;

    setHistoryOpen(false);
    const state = useWorkspaceStore.getState();
    let resolvedPath = projectPath || '';
    if (!state.openProjects.has(projectId) && !resolvedPath) {
      const project = await ipcRenderer.invoke('project:getById', projectId).catch(() => null);
      resolvedPath = project?.path || '';
    }
    if (!state.openProjects.has(projectId)) {
      if (!resolvedPath) return;
      await state.openProject(projectId, resolvedPath, { background: false });
    } else {
      state.showWorkspace(projectId);
    }
    const latest = useWorkspaceStore.getState();
    latest.setProjectView(projectId, 'terminal');
    latest.switchTab(projectId, linkedTabId);
    void ipcRenderer.invoke('orchestration:acknowledge', { runId: run.runId, tabId }).catch(() => {});
  }, [tabId]);

  const runAction = useCallback(async (run: OrchestrationRun, action: 'retry' | 'report' | 'dismiss' | 'cancel') => {
    const result = await ipcRenderer.invoke('orchestration:action', { runId: run.runId, action }).catch((error: unknown) => ({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }));
    if (result?.run) {
      setRuns((current) => [...current.filter((item) => item.runId !== result.run.runId), result.run]);
    }
    setActionError((current) => ({
      ...current,
      [run.runId]: result?.ok === false ? (result.error || 'Действие не выполнено') : '',
    }));
  }, []);

  const saveSettings = useCallback(async (patch: Partial<OrchestrationSettings>) => {
    setSettings((current) => current ? { ...current, ...patch } : current);
    const updated = await ipcRenderer.invoke('orchestration:update-settings', patch).catch(() => null);
    if (updated) setSettings(updated);
  }, []);

  if (orderedRuns.length === 0) return null;

  const actionButton = (
    run: OrchestrationRun,
    action: 'retry' | 'report' | 'dismiss' | 'cancel',
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
        cursor: 'pointer',
      }}
    >
      {icon}
    </button>
  );

  const renderTooltip = (run: OrchestrationRun) => {
    const isSource = run.sourceTabId === tabId;
    const linkedTabName = isSource ? run.targetTabName : run.sourceTabName;
    const linkedProjectName = isSource ? run.targetProjectName : run.sourceProjectName;
    const color = statusColor(run.status);
    const remaining = countdown(run.recoveryDeadlineAt, now);
    return (
      <div style={{ width: 276, display: 'grid', gap: 6, fontSize: 11, lineHeight: 1.35 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '70px minmax(0, 1fr)', gap: '3px 7px', color: '#a3a3a3' }}>
          <span>Состояние</span><span style={{ color }}>{STATUS_LABEL[run.status]}</span>
          {remaining && <><span>Отправка</span><span style={{ color: '#fbbf24', fontVariantNumeric: 'tabular-nums' }}>{remaining}</span></>}
          <span>Проект</span><span style={{ color: '#e5e7eb' }}>{linkedProjectName || '—'}</span>
          <span>Вкладка</span><span style={{ color: '#e5e7eb' }}>{linkedTabName || '—'}</span>
          <span>Начало</span><span>{runTime(run.createdAt)}</span>
          <span>runId</span><span style={{ fontFamily: 'monospace', overflowWrap: 'anywhere' }}>{run.runId}</span>
          {run.notificationStatus && isSource && <><span>Уведомление</span><span>{run.notificationStatus}</span></>}
        </div>
        {run.error && <div style={{ color: '#fca5a5', overflowWrap: 'anywhere' }}>{run.error}</div>}
        {actionError[run.runId] && <div style={{ color: '#fca5a5' }}>{actionError[run.runId]}</div>}
      </div>
    );
  };

  const renderTooltipActions = (run: OrchestrationRun) => {
    const isSource = run.sourceTabId === tabId;
    const canCancel = ACTIVE.has(run.status) && run.status !== 'waiting_recovery';
    return (
      <div style={{ width: '100%', minWidth: 0, display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ minWidth: 0, flex: 1, display: 'flex', alignItems: 'center', gap: 5, color: '#f3f4f6', fontWeight: 600 }}>
          {isSource ? <ArrowUpRight size={14} /> : <ArrowDownLeft size={14} />}
          <span>{isSource ? 'Исходящий запрос' : 'Входящий запрос'}</span>
        </span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
          {canCancel && actionButton(run, 'cancel', 'Отменить текущий запрос', <CircleStop size={13} />, '#f87171')}
          {run.status === 'waiting_recovery' && actionButton(run, 'retry', 'Восстановить связь', <RotateCcw size={13} />, '#fbbf24')}
          {run.status === 'waiting_recovery' && actionButton(run, 'report', 'Передать ошибку родителю', <Send size={13} />, '#f87171')}
          {run.status === 'waiting_recovery' && actionButton(run, 'dismiss', 'Закрыть без сообщения', <X size={13} />, '#a3a3a3')}
        </span>
      </div>
    );
  };

  const panelStyle: CSSProperties = {
    position: 'absolute',
    top: 30,
    right: 0,
    width: 310,
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
        <span style={{ fontSize: 10, color: '#777' }}>{orderedRuns.length}</span>
        <button type="button" aria-label="Закрыть" onClick={() => setHistoryOpen(false)} style={{ width: 24, height: 24, display: 'grid', placeItems: 'center', border: 0, background: 'transparent', color: '#999', cursor: 'pointer' }}>
          <X size={14} />
        </button>
      </div>
      <div style={{ minHeight: 0, overflowY: 'auto' }}>
        {orderedRuns.map((run) => {
          const isSource = run.sourceTabId === tabId;
          const linkedTabName = isSource ? run.targetTabName : run.sourceTabName;
          const linkedProjectName = isSource ? run.targetProjectName : run.sourceProjectName;
          const color = statusColor(run.status);
          return (
            <button
              key={run.runId}
              type="button"
              data-orchestration-run-id={run.runId}
              onClick={() => void openLinkedTab(run)}
              style={{ width: '100%', padding: '7px 9px', display: 'grid', gap: 3, border: 0, borderBottom: '1px solid #292929', background: 'transparent', color: '#d4d4d4', textAlign: 'left', cursor: 'pointer' }}
            >
              <span style={{ display: 'flex', alignItems: 'center', gap: 5, minWidth: 0 }}>
                <span style={{ color, display: 'grid', placeItems: 'center', flexShrink: 0 }}><StatusIcon status={run.status} /></span>
                <span style={{ color: '#8f8f8f', display: 'grid', placeItems: 'center', flexShrink: 0 }}>{isSource ? <ArrowUpRight size={12} /> : <ArrowDownLeft size={12} />}</span>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 11, fontWeight: 600 }}>{run.label || linkedTabName || 'Запрос'}</span>
                <span style={{ marginLeft: 'auto', color, fontSize: 9, flexShrink: 0 }}>{STATUS_LABEL[run.status]}</span>
              </span>
              <span style={{ paddingLeft: 31, color: '#858585', fontSize: 9, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{linkedProjectName || '—'} · {linkedTabName || '—'} · {runTime(run.createdAt)}</span>
            </button>
          );
        })}
      </div>
    </aside>
  ) : null;

  const settingsPanel = settingsOpen && settings ? (
    <aside data-orchestration-settings-panel role="dialog" aria-label="Настройки запросов" style={panelStyle}>
      <div style={{ height: 34, padding: '0 7px 0 9px', display: 'flex', alignItems: 'center', gap: 7, borderBottom: '1px solid #303030' }}>
        <Settings2 size={14} color="#a3a3a3" />
        <span style={{ flex: 1, fontSize: 11, fontWeight: 650 }}>Настройки запросов</span>
        <button type="button" aria-label="Закрыть" onClick={() => setSettingsOpen(false)} style={{ width: 24, height: 24, display: 'grid', placeItems: 'center', border: 0, background: 'transparent', color: '#999', cursor: 'pointer' }}><X size={14} /></button>
      </div>
      <div style={{ padding: 10, display: 'grid', gap: 9, fontSize: 11 }}>
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
      </div>
    </aside>
  ) : null;

  return (
    <div
      ref={rootRef}
      data-orchestration-status
      style={{ position: 'absolute', top: 2, right: rightOffset + 4, zIndex: 3, display: 'flex', alignItems: 'flex-start', gap: 4, pointerEvents: 'auto' }}
    >
      {activeRuns.length > 0 && (
        <div data-orchestration-active-list style={{ width: 178, maxHeight: 82, overflowY: 'auto', border: '1px solid #444', borderRadius: 5, background: '#171717', boxShadow: '0 2px 10px rgba(0,0,0,0.22)' }}>
          {activeRuns.map((run, index) => {
            const isSource = run.sourceTabId === tabId;
            const linkedTabName = isSource ? run.targetTabName : run.sourceTabName;
            const color = statusColor(run.status);
            return (
              <Tooltip
                key={run.runId}
                content={renderTooltip(run)}
                actionBar={renderTooltipActions(run)}
                side="bottom"
                always
              >
                <button
                  type="button"
                  data-orchestration-active-run={run.runId}
                  onClick={() => void openLinkedTab(run)}
                  aria-label={`Открыть ${linkedTabName || 'связанную вкладку'}`}
                  style={{ width: '100%', height: 26, padding: '0 6px', display: 'flex', alignItems: 'center', gap: 5, border: 0, borderBottom: index < activeRuns.length - 1 ? '1px solid #303030' : 0, background: 'transparent', color, cursor: 'pointer', boxSizing: 'border-box' }}
                >
                  <StatusIcon status={run.status} />
                  {isSource ? <ArrowUpRight size={12} strokeWidth={2.2} /> : <ArrowDownLeft size={12} strokeWidth={2.2} />}
                  <span style={{ color: '#d4d4d4', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, textAlign: 'left', fontSize: 10 }}>{linkedTabName || 'Запрос'}</span>
                  {run.status === 'waiting_recovery' && countdown(run.recoveryDeadlineAt, now) && <span style={{ fontSize: 9, fontVariantNumeric: 'tabular-nums' }}>{countdown(run.recoveryDeadlineAt, now)}</span>}
                </button>
              </Tooltip>
            );
          })}
        </div>
      )}
      <button type="button" data-orchestration-history-button onClick={() => { setHistoryOpen((open) => !open); setSettingsOpen(false); }} aria-label="Открыть историю запросов" style={{ height: 26, padding: '0 7px', display: 'flex', alignItems: 'center', gap: 5, borderRadius: 5, border: '1px solid #444', background: '#171717', color: '#aaa', cursor: 'pointer', boxSizing: 'border-box', fontSize: 10 }}>
        <HistoryIcon size={13} /><span>History</span>
      </button>
      <button type="button" data-orchestration-settings-button onClick={() => { setSettingsOpen((open) => !open); setHistoryOpen(false); }} aria-label="Настройки запросов" title="Настройки запросов" style={{ width: 26, height: 26, display: 'grid', placeItems: 'center', borderRadius: 5, border: '1px solid #444', background: '#171717', color: '#888', cursor: 'pointer' }}>
        <Settings2 size={13} />
      </button>
      {historyPanel}
      {settingsPanel}
    </div>
  );
}
