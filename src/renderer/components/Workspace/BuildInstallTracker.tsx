import { useState } from 'react';
import { Hammer, LoaderCircle, CircleCheck, CircleAlert, X, ChevronDown, ChevronRight } from 'lucide-react';
import { RequestTrackerRow, RequestTrackerStatus, requestRowActionStyle, requestRowLinkStyle } from './RequestTrackerRow';
import { buildInstallPresentation } from '../../utils/buildInstallPresentation.mjs';
import type { BuildInstallJob } from '../../hooks/useBuildInstallStatus';
import activity from '../../../shared/build-install-activity.cjs';

export function BuildInstallTracker({ job, stale, error, history = false, onCancel }: {
  job: BuildInstallJob; stale: boolean; error?: string | null; history?: boolean; onCancel: (job: BuildInstallJob) => void;
}) {
  const [open, setOpen] = useState(false);
  const state = buildInstallPresentation(job, stale);
  const pendingContinuation = activity.pending(job.continuation);
  const continuationOnly = !job.running && pendingContinuation;
  const Icon = state.spinning ? LoaderCircle : !stale && job.ok === true && !job.installOutcomeUnknown ? CircleCheck : CircleAlert;
  return <div data-build-install-job={job.id} data-request-kind="install" style={{ minWidth: 0, borderBottom: '1px solid #303030' }}>
    <RequestTrackerRow actions={(job.running || pendingContinuation) && <button type="button"
      title={continuationOnly ? 'Закрыть ожидание продолжения; отправленное уведомление не отменяется' : 'Отменить установку'}
      aria-label={continuationOnly ? 'Закрыть ожидание продолжения' : 'Отменить установку'}
      disabled={stale || (continuationOnly ? !job.continuation?.canCancelContinuation : job.cancelled)}
      onClick={() => onCancel(job)} style={{ ...requestRowActionStyle,
        opacity: stale || (continuationOnly ? !job.continuation?.canCancelContinuation : job.cancelled) ? 0.5 : 1 }}><X size={13} /></button>}>
      <button type="button" aria-expanded={open} onClick={() => setOpen(value => !value)}
        title={(job.force ? 'Force Build Install · ' : 'Build Install · ') + state.label}
        style={{ ...requestRowLinkStyle, color: state.color }}>
        <RequestTrackerStatus><span className={state.spinning ? 'noted-infinite-animation animate-spin' : undefined} style={{ display: 'inline-flex' }}><Icon size={12} /></span></RequestTrackerStatus>
        <Hammer size={12} />
        <span style={{ minWidth: 0, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{job.force ? 'Force Install' : 'Build Install'}</span>
        {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
      </button>
    </RequestTrackerRow>
    {(open || history) && <div style={{ padding: '2px 8px 7px', fontSize: 10, color: '#a3a3a3', overflowWrap: 'anywhere' }}>
      <div style={{ color: state.color }}>{state.label}</div>
      {stale && <div>Показано последнее сохранённое состояние</div>}
      <div>Job: {job.id}</div>
      {job.returnTo?.sessionId && <div>Сессия: {job.returnTo.sessionId}</div>}
      {job.callback && <div>Возврат: {job.callback.status}</div>}
      {pendingContinuation && <div>Подтверждение продолжения: {job.continuation?.state}.
        Закрытие снимает только это ожидание, не останавливает текущий ответ.</div>}
      {!!job.wait?.blockers?.length && <div>Ожидание: {job.wait.blockers.map(row => row.name || row.tabId).join(', ')}</div>}
      {!!job.wait?.preservedExternalWaits?.length && <div>Сохранено ожиданий Research: {job.wait.preservedExternalWaits.length}</div>}
      {job.interruptionReport && <div>Отчёт: вкладок {job.interruptionReport.tabs.length}, MCP {job.interruptionReport.mcp.length}; unknown {job.interruptionReport.unknown.length}</div>}
      {(error || job.error || job.callback?.error) && <div role="alert" style={{ color: '#fca5a5' }}>{error || job.error || job.callback?.error}</div>}
    </div>}
  </div>;
}
