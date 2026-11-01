import type { RefObject } from 'react';
import { CircleAlert, X } from 'lucide-react';
import type { BuildContinueCaptureIssue } from '../../hooks/useBuildContinueStatus';
import { RequestTrackerRow, RequestTrackerStatus, requestRowActionStyle, requestRowLinkStyle } from './RequestTrackerRow';
import { RequestDetailsPopover } from './RequestDetailsPopover';
import type { RequestPreviewAnchor } from './RequestDetailsPopover';
import { TabMessageSourceChip } from './TabMessageSourceChip';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';

export type BuildContinueCaptureSelection = RequestPreviewAnchor & { operationId: string; issueId: string; history?: boolean };
const color = '#f87171';
function issueName(issue: BuildContinueCaptureIssue) {
  const tab = [...(useWorkspaceStore.getState().openProjects?.values() || [])]
    .map(project => project.tabs.get(issue.tabId)).find(Boolean);
  return tab?.name || issue.source?.name || issue.tabId;
}

// A capture refusal has no Send identity. Keep its presentation X separate
// from cancel-target, even when the same tab has an older continuation.
export function BuildContinueCaptureTracker({ issue, history = false, error, onDismiss, onOpen, selected = false, disabled = false }: {
  issue: BuildContinueCaptureIssue; history?: boolean; error?: string | null;
  onDismiss: (issue: BuildContinueCaptureIssue) => void; onOpen: (selection: BuildContinueCaptureSelection) => void;
  selected?: boolean; disabled?: boolean;
}) {
  const name = issueName(issue);
  return <div data-request-kind="continuation-capture" data-build-capture-operation={issue.operationId}
    data-build-capture-row={issue.issueId} data-build-capture-history={history || undefined}
    style={{ minWidth: 0, flexShrink: 0, borderBottom: '1px solid #303030' }}>
    <RequestTrackerRow actions={<button type="button" data-build-capture-dismiss={issue.issueId}
      aria-label="Закрыть ошибку сохранения задачи" title={error || 'Убрать уведомление. Причина останется в журнале установки; сообщение не отправляется.'}
      onClick={event => { event.stopPropagation(); onDismiss(issue); }} style={requestRowActionStyle}><X size={13} /></button>}>
      <button type="button" data-build-capture-open={issue.issueId} aria-label={`Открыть ошибку автопродолжения: ${name}`}
        aria-haspopup="dialog" aria-expanded={selected} disabled={disabled}
        aria-controls={selected ? 'build-capture-preview-' + issue.issueId : undefined}
        onClick={event => {
          const anchor = event.currentTarget.closest('[data-build-capture-row]') as HTMLElement;
          onOpen({ operationId: issue.operationId, issueId: issue.issueId, anchor, rect: anchor.getBoundingClientRect(), history });
        }} style={{ ...requestRowLinkStyle, color, overflow: 'hidden', whiteSpace: 'nowrap', background: selected ? '#303030' : 'transparent' }}>
        <RequestTrackerStatus title="Автопродолжение не создано"><CircleAlert size={12} /></RequestTrackerStatus>
        <span style={{ minWidth: 0, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</span>
      </button>
    </RequestTrackerRow>
  </div>;
}

export function BuildContinueCapturePreview({ selection, issue, error, onClose, previewRef }: {
  selection: BuildContinueCaptureSelection; issue: BuildContinueCaptureIssue; error?: string | null;
  onClose: () => void; previewRef: RefObject<HTMLElement | null>;
}) {
  const name = issueName(issue);
  return <RequestDetailsPopover {...selection} previewRef={previewRef} onClose={onClose}
    id={'build-capture-preview-' + issue.issueId} attributes={{ 'data-build-capture-details': issue.issueId }}
    title="Продолжение после обновления" icon={<CircleAlert size={13} color={color} />} closeLabel="Закрыть сведения об ошибке автопродолжения">
    <div style={{ padding: '5px 10px 10px', display: 'grid', gap: 7, fontSize: 11, lineHeight: 1.35, overflowWrap: 'anywhere' }}>
      <div style={{ color }}>Автопродолжение не создано</div>
      <div>Перед обновлением не удалось сохранить подтверждённую задачу для продолжения. Автоматическое сообщение не создавалось.</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}><span style={{ color: '#999' }}>Вкладка:</span>
        <TabMessageSourceChip source={{ sourceTabId: issue.tabId, sourceTabName: name,
          sourceProjectId: issue.source?.projectId || undefined }} variant="row" onNavigate={onClose} />
      </div>
      {issue.observation?.taskTurnId && <div>Задача: <code>{issue.observation.taskTurnId}</code></div>}
      <div>Установка: <code>{issue.operationId}</code></div>
      <div>Причина: <code>{issue.reason}</code></div>
      {error && <div role="alert" style={{ color: '#fca5a5' }}>{error}</div>}
      <details style={{ color: '#999', fontSize: 10 }}><summary style={{ cursor: 'pointer' }}>Источник и ID</summary>
        <div style={{ display: 'grid', gap: 4, marginTop: 5 }}>
          <div>Tab ID: <code>{issue.tabId}</code></div>
          <div>Этап: {issue.stage}</div>
          <div>Уведомление: <code>{issue.issueId}</code></div>
        </div>
      </details>
    </div>
  </RequestDetailsPopover>;
}
