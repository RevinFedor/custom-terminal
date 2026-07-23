import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDownLeft, ArrowUpRight, CircleAlert, CircleCheck, History as HistoryIcon, LoaderCircle, X } from 'lucide-react';
import Tooltip from '../UI/Tooltip';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';

const { ipcRenderer } = window.require('electron');

type OrchestrationStatus = 'creating' | 'starting' | 'sending' | 'sent' | 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

type OrchestrationRun = {
  runId: string;
  label?: string;
  status: OrchestrationStatus;
  createdAt: number;
  completedAt?: number | null;
  sourceTabId: string;
  sourceTabName?: string;
  sourceProjectId: string;
  sourceProjectName?: string;
  sourceProjectPath?: string;
  sourceAcknowledgedAt?: number | null;
  targetTabId: string;
  targetTabName?: string;
  targetProjectId: string;
  targetProjectName?: string;
  targetProjectPath?: string;
  targetToolType?: 'claude' | 'codex';
  targetAcknowledgedAt?: number | null;
  notificationStatus?: string;
  error?: string | null;
};

type Props = {
  tabId: string;
  rightOffset: number;
};

const ACTIVE = new Set<OrchestrationStatus>(['creating', 'starting', 'sending', 'sent', 'queued', 'running']);

const STATUS_LABEL: Record<OrchestrationStatus, string> = {
  creating: 'Создание',
  starting: 'Запуск',
  sending: 'Отправка',
  sent: 'Доставлено',
  queued: 'В очереди',
  running: 'Работает',
  completed: 'Готово',
  failed: 'Ошибка',
  cancelled: 'Отменено',
};

function statusColor(status: OrchestrationStatus): string {
  if (status === 'completed') return '#4ade80';
  if (status === 'failed' || status === 'cancelled') return '#f87171';
  if (status === 'queued' || status === 'sent') return '#fbbf24';
  return '#a78bfa';
}

function StatusIcon({ status }: { status: OrchestrationStatus }) {
  if (status === 'completed') return <CircleCheck size={14} strokeWidth={2.2} />;
  if (status === 'failed' || status === 'cancelled') return <CircleAlert size={14} strokeWidth={2.2} />;
  return <LoaderCircle className={status === 'running' || status === 'starting' || status === 'sending' ? 'animate-spin' : ''} size={14} strokeWidth={2.2} />;
}

function runTime(value?: number | null): string {
  if (!value) return '—';
  return new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function OrchestrationStatusChip({ tabId, rightOffset }: Props) {
  const [runs, setRuns] = useState<OrchestrationRun[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    void ipcRenderer.invoke('orchestration:list-for-tab', tabId)
      .then((items: OrchestrationRun[]) => {
        if (alive) setRuns(Array.isArray(items) ? items : []);
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

  useEffect(() => {
    if (!historyOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setHistoryOpen(false);
    };
    const onMouseDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setHistoryOpen(false);
    };
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('mousedown', onMouseDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('mousedown', onMouseDown);
    };
  }, [historyOpen]);

  const orderedRuns = useMemo(() => [...runs]
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)), [runs]);
  const activeRuns = useMemo(() => orderedRuns
    .filter((run) => ACTIVE.has(run.status)), [orderedRuns]);

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

  if (orderedRuns.length === 0) return null;

  const renderTooltip = (run: OrchestrationRun) => {
    const isSource = run.sourceTabId === tabId;
    const linkedTabName = isSource ? run.targetTabName : run.sourceTabName;
    const linkedProjectName = isSource ? run.targetProjectName : run.sourceProjectName;
    const color = statusColor(run.status);
    return (
      <div style={{ width: 276, display: 'grid', gap: 6, fontSize: 11, lineHeight: 1.35 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: '#f3f4f6', fontWeight: 600 }}>
          {isSource ? <ArrowUpRight size={14} /> : <ArrowDownLeft size={14} />}
          {isSource ? 'Исходящий запрос' : 'Входящий запрос'}
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '70px minmax(0, 1fr)', gap: '3px 7px', color: '#a3a3a3' }}>
          <span>Состояние</span><span style={{ color }}>{STATUS_LABEL[run.status]}</span>
          <span>Проект</span><span style={{ color: '#e5e7eb' }}>{linkedProjectName || '—'}</span>
          <span>Вкладка</span><span style={{ color: '#e5e7eb' }}>{linkedTabName || '—'}</span>
          <span>Начало</span><span>{runTime(run.createdAt)}</span>
          <span>runId</span><span style={{ fontFamily: 'monospace', overflowWrap: 'anywhere' }}>{run.runId}</span>
          {run.notificationStatus && isSource && <><span>Уведомление</span><span>{run.notificationStatus}</span></>}
        </div>
        {run.error && <div style={{ color: '#fca5a5', overflowWrap: 'anywhere' }}>{run.error}</div>}
      </div>
    );
  };

  const historyPanel = historyOpen ? (
    <aside
      data-orchestration-history-panel
      role="dialog"
      aria-label="История запросов"
      style={{
        position: 'absolute',
        top: 0,
        right: '100%',
        width: 330,
        maxHeight: 'min(320px, calc(100vh - 84px))',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        background: '#151515',
        border: '1px solid #3a3a3a',
        borderRadius: 6,
        boxShadow: '0 10px 28px rgba(0,0,0,0.44)',
        color: '#e5e5e5',
        zIndex: 5,
      }}
    >
      <div style={{ height: 36, padding: '0 7px 0 10px', display: 'flex', alignItems: 'center', gap: 7, borderBottom: '1px solid #303030', flexShrink: 0 }}>
        <HistoryIcon size={14} color="#a3a3a3" />
        <span style={{ minWidth: 0, flex: 1, fontSize: 11, fontWeight: 650 }}>История запросов</span>
        <span style={{ fontSize: 10, color: '#777' }}>{orderedRuns.length}</span>
        <button
          type="button"
          aria-label="Закрыть историю запросов"
          onClick={() => setHistoryOpen(false)}
          style={{ width: 24, height: 24, display: 'grid', placeItems: 'center', border: 0, background: 'transparent', color: '#999', cursor: 'pointer' }}
        >
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
              style={{
                width: '100%',
                padding: '7px 9px',
                display: 'grid',
                gap: 3,
                border: 0,
                borderBottom: '1px solid #292929',
                background: 'transparent',
                color: '#d4d4d4',
                textAlign: 'left',
                cursor: 'pointer',
              }}
            >
              <span style={{ display: 'flex', alignItems: 'center', gap: 5, minWidth: 0 }}>
                <span style={{ color, display: 'grid', placeItems: 'center', flexShrink: 0 }}><StatusIcon status={run.status} /></span>
                <span style={{ color: '#8f8f8f', display: 'grid', placeItems: 'center', flexShrink: 0 }}>
                  {isSource ? <ArrowUpRight size={12} /> : <ArrowDownLeft size={12} />}
                </span>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 11, fontWeight: 600 }}>
                  {run.label || linkedTabName || (isSource ? 'Исполнитель' : 'Источник')}
                </span>
                <span style={{ marginLeft: 'auto', color, fontSize: 9, flexShrink: 0 }}>{STATUS_LABEL[run.status]}</span>
              </span>
              <span style={{ paddingLeft: 31, color: '#858585', fontSize: 9, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {linkedProjectName || '—'} · {linkedTabName || '—'} · {runTime(run.createdAt)}
              </span>
              {run.error && <span style={{ paddingLeft: 31, color: '#fca5a5', fontSize: 9, overflowWrap: 'anywhere' }}>{run.error}</span>}
              {isSource && run.notificationStatus && run.notificationStatus !== 'pending' && (
                <span style={{ paddingLeft: 31, color: '#737373', fontSize: 9 }}>Уведомление: {run.notificationStatus}</span>
              )}
            </button>
          );
        })}
      </div>
    </aside>
  ) : null;

  return (
    <>
      <div
        ref={rootRef}
        data-orchestration-status
        style={{
          position: 'absolute',
          top: 2,
          right: rightOffset + 4,
          zIndex: 3,
          display: 'flex',
          alignItems: 'flex-start',
          gap: 4,
          pointerEvents: 'auto',
        }}
      >
        <button
          type="button"
          data-orchestration-history-button
          onClick={() => setHistoryOpen((open) => !open)}
          aria-label="Открыть историю запросов"
          style={{
            height: 26,
            padding: '0 7px',
            display: 'flex',
            alignItems: 'center',
            gap: 5,
            borderRadius: 5,
            border: '1px solid #444',
            background: '#171717',
            color: '#aaa',
            cursor: 'pointer',
            boxSizing: 'border-box',
            fontSize: 10,
          }}
        >
          <HistoryIcon size={13} />
          <span>History</span>
        </button>
        {activeRuns.length > 0 && (
          <div
            data-orchestration-active-list
            style={{
              width: 178,
              maxHeight: 82,
              overflowY: 'auto',
              border: '1px solid #444',
              borderRadius: 5,
              background: '#171717',
              boxShadow: '0 2px 10px rgba(0,0,0,0.22)',
            }}
          >
            {activeRuns.map((run, index) => {
              const isSource = run.sourceTabId === tabId;
              const linkedTabName = isSource ? run.targetTabName : run.sourceTabName;
              const color = statusColor(run.status);
              return (
                <Tooltip key={run.runId} content={renderTooltip(run)} side="bottom" always>
                  <button
                    type="button"
                    data-orchestration-active-run={run.runId}
                    onClick={() => void openLinkedTab(run)}
                    aria-label={`${isSource ? 'Open target' : 'Open source'} tab ${linkedTabName || ''}`}
                    style={{
                      width: '100%',
                      height: 26,
                      padding: '0 6px',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 5,
                      border: 0,
                      borderBottom: index < activeRuns.length - 1 ? '1px solid #303030' : 0,
                      background: 'transparent',
                      color,
                      cursor: 'pointer',
                      boxSizing: 'border-box',
                    }}
                  >
                    <StatusIcon status={run.status} />
                    {isSource ? <ArrowUpRight size={12} strokeWidth={2.2} /> : <ArrowDownLeft size={12} strokeWidth={2.2} />}
                    <span style={{ color: '#d4d4d4', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, textAlign: 'left', fontSize: 10 }}>
                      {linkedTabName || (isSource ? 'Исполнитель' : 'Источник')}
                    </span>
                  </button>
                </Tooltip>
              );
            })}
          </div>
        )}
        {historyPanel}
      </div>
    </>
  );
}
