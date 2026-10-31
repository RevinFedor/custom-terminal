import type { RefObject } from 'react';
import { Hammer, LoaderCircle, CircleCheck, CircleAlert, X } from 'lucide-react';
import { RequestTrackerRow, RequestTrackerStatus, requestRowActionStyle, requestRowLinkStyle } from './RequestTrackerRow';
import { RequestDetailsPopover } from './RequestDetailsPopover';
import type { RequestPreviewAnchor } from './RequestDetailsPopover';
import { buildInstallPresentation } from '../../utils/buildInstallPresentation.mjs';
import type { BuildInstallJob } from '../../hooks/useBuildInstallStatus';
import activity from '../../../shared/build-install-activity.cjs';

export type BuildInstallSelection = RequestPreviewAnchor & { jobId: string; requestId: string; history?: boolean };

export function BuildInstallTracker({ job, stale, history = false, onCancel, onOpen, selected = false, disabled = false }: {
  job: BuildInstallJob; stale: boolean; error?: string | null; history?: boolean; onCancel: (job: BuildInstallJob) => void;
  onOpen: (selection: BuildInstallSelection) => void; selected?: boolean; disabled?: boolean;
}) {
  const state = buildInstallPresentation(job, stale);
  const pendingContinuation = activity.pending(job.continuation);
  const Icon = state.spinning ? LoaderCircle : state.color === '#4ade80' ? CircleCheck : CircleAlert;
  return <div data-build-install-job={job.id} data-request-kind="install" style={{ minWidth: 0, flexShrink: 0, borderBottom: '1px solid #303030' }}>
    <RequestTrackerRow actions={(job.running || pendingContinuation) && <button type="button"
      title="Отменить запрос, его ожидания и будущие продолжения"
      aria-label="Отменить запрос установки"
      disabled={stale || job.requestCancelledAt != null}
      onClick={event => { event.stopPropagation(); onCancel(job); }} style={{ ...requestRowActionStyle,
        opacity: stale || job.requestCancelledAt != null ? 0.5 : 1 }}><X size={13} /></button>}>
      <button type="button" data-build-install-open={job.id} aria-expanded={selected} aria-haspopup="dialog" disabled={disabled}
        aria-label={`Открыть установку: ${job.id}`} aria-controls={selected ? 'build-install-preview-' + job.id : undefined}
        onClick={event => {
          const anchor = event.currentTarget.closest('[data-build-install-job]') as HTMLElement;
          onOpen({ jobId: job.id, requestId: job.requestId, anchor, rect: anchor.getBoundingClientRect(), history });
        }}
        style={{ ...requestRowLinkStyle, color: state.color, background: selected ? '#303030' : 'transparent' }}>
        <RequestTrackerStatus title={state.label}><span className={state.spinning ? 'noted-infinite-animation animate-spin' : undefined} style={{ display: 'inline-flex' }}><Icon size={12} /></span></RequestTrackerStatus>
        <Hammer size={12} style={{ flexShrink: 0 }} />
        <span style={{ minWidth: 0, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{job.force ? 'Force Install' : 'Build Install'}</span>
      </button>
    </RequestTrackerRow>
  </div>;
}

export function BuildInstallPreview({ job, stale, error, selection, onClose, previewRef }: {
  job: BuildInstallJob; stale: boolean; error?: string | null; selection: BuildInstallSelection;
  onClose: () => void; previewRef: RefObject<HTMLElement | null>;
}) {
  const state = buildInstallPresentation(job, stale);
  const pendingContinuation = activity.pending(job.continuation);
  return <RequestDetailsPopover {...selection} previewRef={previewRef} onClose={onClose}
    id={'build-install-preview-' + job.id} attributes={{ 'data-build-install-details': job.id }}
    title={job.force ? 'Force Install' : 'Build Install'} icon={<Hammer size={13} color={state.color} />}
    closeLabel="Закрыть сведения об установке">
    <div style={{ padding: '5px 10px 10px', display: 'grid', gap: 7, fontSize: 11, lineHeight: 1.35, overflowWrap: 'anywhere' }}>
      <div style={{ color: state.color }}>{state.label}</div>
      {stale && <div>Показано последнее сохранённое состояние</div>}
      {pendingContinuation && <div>{job.callback?.status === 'sent'
        ? 'Ответ на уведомление ещё выполняется или проверяется. После его завершения карточка уйдёт в историю.'
        : 'Ожидается доставка уведомления в сессию.'}</div>}
      {!!job.wait?.blockers?.length && <div>Ожидание: {job.wait.blockers.map(row => row.name || row.tabId).join(', ')}</div>}
      {(error || job.error || job.callback?.error) && <div role="alert" style={{ color: '#fca5a5' }}>{error || job.error || job.callback?.error}</div>}
      <div>Job: <code>{job.id}</code></div>
      <details style={{ color: '#999', fontSize: 10 }}><summary style={{ cursor: 'pointer' }}>Источник и ID</summary>
        <div style={{ display: 'grid', gap: 4, marginTop: 5 }}>
          <div>Запрос: <code>{job.requestId}</code></div>
          {job.returnTo?.sessionId && <div>Сессия: <code>{job.returnTo.sessionId}</code></div>}
          {job.callback && <div>Возврат: {job.callback.status}</div>}
          {!!job.wait?.preservedExternalWaits?.length && <div>Сохранено ожиданий Research: {job.wait.preservedExternalWaits.length}</div>}
          {job.interruptionReport && <div>Отчёт: вкладок {job.interruptionReport.tabs.length}, MCP {job.interruptionReport.mcp.length}; unknown {job.interruptionReport.unknown.length}</div>}
        </div>
      </details>
    </div>
  </RequestDetailsPopover>;
}
