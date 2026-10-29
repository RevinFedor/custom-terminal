import type { RefObject } from 'react';
import { Clock3, CircleAlert, CircleCheck, X } from 'lucide-react';
import { RequestTrackerRow, RequestTrackerStatus, requestRowActionStyle, requestRowLinkStyle } from './RequestTrackerRow';
import type { BuildContinueTarget } from '../../hooks/useBuildContinueStatus';
import { RequestDetailsPopover } from './RequestDetailsPopover';
import type { RequestPreviewAnchor } from './RequestDetailsPopover';
import { TabMessageSourceChip } from './TabMessageSourceChip';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';

export type BuildContinueSelection = RequestPreviewAnchor & { operationKey: string; history?: boolean };

export function buildContinueLabel(target: BuildContinueTarget) {
  if (target.cancellation) return target.cancellation.acknowledgedAt ? 'Автопродолжение отменено' : 'Проверка отмены продолжения';
  if (target.state === 'confirmed') return 'Продолжение доставлено';
  if (target.state === 'unknown') return 'Доставка неизвестна · повтор не отправляется';
  if (target.state === 'superseded') return 'Продолжено другим запросом / цель изменилась';
  if (['result-ready', 'not-needed', 'already-working'].includes(target.state)) return 'Дополнительное продолжение не требуется';
  const reasons: Record<string, string> = {
    'prior-continuation-pending': 'Ожидает прежнее восстановление',
    'runtime-owner-pending': 'Восстановление сессии',
    'runtime-input-pending': 'Автопродолжение ждёт проверки сессии',
    'input-history-proof-pending': 'Проверка прерванной задачи',
    'original-proof-pending': 'Проверка исходной задачи',
    'ready-returns-pending': 'Ожидает сохранённые результаты',
    'application-queued': 'Продолжение в очереди приложения',
  };
  return reasons[target.reason || ''] || (target.active ? 'Продолжение ожидает отправки' : 'Продолжение не отправлено');
}
export const buildContinueVisible = (target: BuildContinueTarget) => target.route.kind !== 'install-callback'
  && (target.active || target.cancellation && !target.cancellation.acknowledgedAt
    || ['unknown', 'unresolved', 'paused'].includes(target.state) && !target.cancellation);

function targetName(target: BuildContinueTarget) {
  const tab = [...(useWorkspaceStore.getState().openProjects?.values() || [])]
    .map(project => project.tabs.get(target.tabId)).find(Boolean);
  return tab?.name || target.source?.name || target.tabId;
}

export function BuildContinueTracker({ target, history = false, error, onCancel, onOpen, selected = false, disabled = false }: {
  target: BuildContinueTarget; history?: boolean; error?: string | null; onCancel: (target: BuildContinueTarget) => void;
  onOpen: (selection: BuildContinueSelection) => void; selected?: boolean; disabled?: boolean;
}) {
  const label = buildContinueLabel(target), name = targetName(target);
  const warning = ['unknown', 'unresolved', 'paused'].includes(target.state);
  const pending = target.active || target.cancellation && !target.cancellation.acknowledgedAt;
  const Icon = warning ? CircleAlert : pending ? Clock3 : CircleCheck;
  const color = warning ? '#fbbf24' : target.state === 'confirmed' ? '#4ade80'
    : target.state === 'sending' ? '#60a5fa' : '#a1a1aa';
  return <div data-request-kind="continuation" data-build-continue-operation={target.operationId}
    data-build-continue-row={target.operationKey} data-build-continue-history={history || undefined}
    style={{ minWidth: 0, borderBottom: '1px solid #303030' }}>
    <RequestTrackerRow actions={buildContinueVisible(target) && <button type="button" data-build-continue-cancel={target.operationKey}
      title={error || (target.active ? 'Отменить это автопродолжение. Уже отправленное сообщение останется в истории.'
        : 'Убрать это автопродолжение из активных. История и квитанции сохранятся; новый ввод не отправляется.')}
      aria-label="Отменить автопродолжение"
      onClick={event => { event.stopPropagation(); onCancel(target); }} style={requestRowActionStyle}><X size={13} /></button>}>
      <button type="button" data-build-continue-open={target.operationKey} aria-label={`Открыть продолжение: ${name}`}
        aria-haspopup="dialog" aria-expanded={selected} disabled={disabled}
        aria-controls={selected ? 'build-continue-preview-' + target.operationKey : undefined}
        onClick={event => {
          const anchor = event.currentTarget.closest('[data-build-continue-row]') as HTMLElement;
          onOpen({ operationKey: target.operationKey, anchor, rect: anchor.getBoundingClientRect(), history });
        }}
        style={{ ...requestRowLinkStyle, color, overflow: 'hidden', whiteSpace: 'nowrap', background: selected ? '#303030' : 'transparent' }}>
        <RequestTrackerStatus title={label}><Icon size={12} /></RequestTrackerStatus>
        <span data-build-continue-label style={{ minWidth: 0, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</span>
      </button>
    </RequestTrackerRow>
  </div>;
}

export function BuildContinuePreview({ selection, target, error, onClose, previewRef }: {
  selection: BuildContinueSelection; target: BuildContinueTarget; error?: string | null; onClose: () => void;
  previewRef: RefObject<HTMLElement | null>;
}) {
  const name = targetName(target), label = buildContinueLabel(target);
  const warning = ['unknown', 'unresolved', 'paused'].includes(target.state);
  const color = warning ? '#fbbf24' : target.state === 'confirmed' ? '#4ade80' : '#d4d4d4';
  return <RequestDetailsPopover {...selection} previewRef={previewRef} onClose={onClose}
    id={'build-continue-preview-' + target.operationKey} attributes={{ 'data-build-continue-details': target.operationKey }}
    title="Продолжение после обновления" icon={<Clock3 size={13} color="#93c5fd" />} closeLabel="Закрыть сведения о продолжении">
    <div style={{ padding: '5px 10px 10px', display: 'grid', gap: 7, fontSize: 11, lineHeight: 1.35, overflowWrap: 'anywhere' }}>
      <div style={{ color }}>{label}</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}><span style={{ color: '#999' }}>Вкладка:</span>
        <TabMessageSourceChip source={{ sourceTabId: target.tabId, sourceTabName: name,
          sourceProjectId: target.source?.projectId || undefined }} variant="row" onNavigate={onClose} />
      </div>
      {target.taskId && <div>Задача: <code>{target.taskId}</code></div>}
      <div>Установка: <code>{target.operationId}</code></div>
      {error && <div role="alert" style={{ color: '#fca5a5' }}>{error}</div>}
      <details style={{ color: '#999', fontSize: 10 }}><summary style={{ cursor: 'pointer' }}>Источник и ID</summary>
        <div style={{ display: 'grid', gap: 4, marginTop: 5 }}>
          <div>Tab ID: <code>{target.tabId}</code></div>
          <div>Запрос: <code>{target.handoffId}</code></div>
          <div>Операция: <code>{target.operationKey}</code></div>
          {target.reason && <div>Причина: {target.reason}</div>}
          {target.proofWait && <div>{target.proofWait.stage}: {target.proofWait.reason}</div>}
        </div>
      </details>
    </div>
  </RequestDetailsPopover>;
}
