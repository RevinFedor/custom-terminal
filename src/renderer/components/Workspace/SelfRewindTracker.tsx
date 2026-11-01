import { useEffect, useState } from 'react';
import type { RefObject } from 'react';
import { CircleAlert, CircleCheck, History, LoaderCircle, X } from 'lucide-react';
import type { SelfRewindOperation } from '../../hooks/useSelfRewinds';
import { RequestTrackerRow, RequestTrackerStatus, requestRowActionStyle, requestRowLinkStyle } from './RequestTrackerRow';
import { RequestDetailsPopover } from './RequestDetailsPopover';
import type { RequestPreviewAnchor } from './RequestDetailsPopover';
import { ContextUpdatePreviewBody } from './TabContextUpdates';
const { ipcRenderer } = window.require('electron');
export type SelfRewindSelection = RequestPreviewAnchor & { operationId: string; history?: boolean };

export function selfRewindPresentation(operation: SelfRewindOperation) {
  if (operation.state === 'outcome-unknown') return { label: 'Состояние отката неизвестно', pending: false, failed: true, color: '#fbbf24' };
  if (operation.state === 'failed') return { label: 'Не удалось завершить откат', pending: false, failed: true, color: '#f87171' };
  if (operation.state === 'completed') {
    const delivery = operation.followup?.receiptState;
    if (delivery === 'confirmed') return { label: 'Новая задача доставлена', pending: false, failed: false, color: '#4ade80' };
    if (['not-submitted', 'provider-not-accepted', 'cancelled'].includes(delivery || '')) {
      return { label: 'Откат выполнен · задача не принята', pending: false, failed: true, color: '#f87171' };
    }
    if (operation.hasNextPrompt) {
      const unknown = ['delivery-unknown', 'outcome-unknown'].includes(delivery || '') || !!operation.followup?.cancelledAt;
      return { label: unknown ? 'Доставка задачи не подтверждена'
        : ['enter-armed', 'audit-pending'].includes(delivery || '') ? 'Проверка доставки задачи' : 'Новая задача в очереди',
        pending: !unknown, failed: unknown, color: '#e87994' };
    }
    return { label: 'Откат истории выполнен', pending: false, failed: false, color: '#4ade80' };
  }
  const labels: Record<string, string> = { accepted: 'Сохраняем контекст', preparing: 'Проверяем точку отката',
    stopping: 'Останавливаем прежний ход', stopped: 'Подготавливаем откат', rewriting: 'Откатываем историю',
    rewritten: 'Сохраняем историю', adopting: 'Привязываем историю', adopted: 'Контекст восстановлен', resuming: 'Возобновляем сессию' };
  return { label: labels[operation.phase] || 'Выполняем Rewind', pending: true, failed: false, color: '#e87994' };
}
export const selfRewindVisible = (operation: SelfRewindOperation) => !operation.presentationHiddenAt
  && (operation.state !== 'completed' || selfRewindPresentation(operation).pending || selfRewindPresentation(operation).failed);

function errorLabel(error: string) {
  const labels: Record<string, string> = {
    self_rewind_context_revision_changed: 'Рабочий контекст изменился до принятия отката',
    self_rewind_context_snapshot_invalid: 'Не удалось подтвердить сохранённый снимок контекста',
    self_rewind_context_member_changed: 'Версия обновления рабочего контекста изменилась',
    self_rewind_owner_changed: 'Владелец ввода или сессия изменились',
    history_operation_owner_changed: 'Сессия изменилась во время операции',
    history_operation_session_changed: 'Не удалось подтвердить выбранную сессию до начала отката',
    history_operation_interrupted: 'Приложение не подтвердило завершение операции',
    terminal_draft_conflict: 'В терминале появился другой черновик',
    terminal_draft_unknown: 'Не удалось проверить черновик терминала',
  };
  const code = Object.keys(labels).find(key => error === key || error.endsWith(': ' + key));
  return code ? labels[code] : error;
}

export function SelfRewindTracker({ operation, history = false, selected = false, onOpen, onDismiss }: {
  operation: SelfRewindOperation; history?: boolean; selected?: boolean;
  onOpen: (selection: SelfRewindSelection) => void; onDismiss: (operation: SelfRewindOperation) => void;
}) {
  const view = selfRewindPresentation(operation), Icon = view.pending ? LoaderCircle : view.failed ? CircleAlert : CircleCheck;
  return <div data-request-kind="self-rewind" data-self-rewind-row={operation.operationId}
    style={{ minWidth: 0, flexShrink: 0, borderBottom: '1px solid #303030' }}>
    <RequestTrackerRow actions={operation.state !== 'running' && !history && <button type="button"
      title="Скрыть карточку. История и отправка новой задачи не отменяются" aria-label="Скрыть карточку отката"
      onClick={event => { event.stopPropagation(); onDismiss(operation); }} style={requestRowActionStyle}><X size={13} /></button>}>
      <button type="button" data-self-rewind-open={operation.operationId} aria-haspopup="dialog" aria-expanded={selected}
        title={view.label} onClick={event => {
          const anchor = event.currentTarget.closest('[data-self-rewind-row]') as HTMLElement;
          onOpen({ operationId: operation.operationId, anchor, rect: anchor.getBoundingClientRect(), history });
        }} style={{ ...requestRowLinkStyle, color: view.color, overflow: 'hidden', background: selected ? '#303030' : 'transparent' }}>
        <RequestTrackerStatus><span className={view.pending ? 'noted-infinite-animation animate-spin' : undefined}
          style={{ display: 'inline-flex' }}><Icon size={12} /></span></RequestTrackerStatus>
        <span style={{ minWidth: 0, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{history
          ? 'Rewind · ' + new Date(operation.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'Rewind'}</span>
      </button>
    </RequestTrackerRow>
  </div>;
}

export function SelfRewindPreview({ selection, operation, onClose, previewRef }: {
  selection: SelfRewindSelection; operation: SelfRewindOperation; onClose: () => void;
  previewRef: RefObject<HTMLElement | null>;
}) {
  const [details, setDetails] = useState<{ operationId: string; retainedContext: string; nextPromptPreview?: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true; setDetails(null); setError(null);
    void ipcRenderer.invoke('self-rewind:details', { tabId: operation.tabId, operationId: operation.operationId })
      .then(value => { if (active && value?.operationId === operation.operationId) setDetails(value); })
      .catch(reason => { if (active) setError(String(reason?.message || reason)); });
    return () => { active = false; };
  }, [operation.tabId, operation.operationId]);
  const view = selfRewindPresentation(operation), current = details?.operationId === operation.operationId ? details : null;
  const failure = error || operation.followup?.error || operation.error;
  return <RequestDetailsPopover {...selection} previewRef={previewRef} onClose={onClose}
    title="Rewind своей сессии" icon={<History size={13} color="#e87994" />}
    id={'self-rewind-preview-' + operation.operationId} closeLabel="Закрыть сведения об откате"
    attributes={{ 'data-self-rewind-details': operation.operationId }}>
    <div style={{ padding: '5px 10px 10px', display: 'grid', gap: 7, fontSize: 11, lineHeight: 1.35, overflowWrap: 'anywhere' }}>
      <div style={{ color: view.color }}>{view.label}</div>
      {failure && <div role="alert" style={{ color: '#fca5a5' }}>{errorLabel(failure)}</div>}
      {view.failed && <div style={{ color: '#aaa' }}>{operation.historyMutated ? 'История уже изменена' : 'Изменение истории не подтверждено'}
        {operation.bindingCommitted ? ' · привязка сохранена' : ''}</div>}
      {current && <ContextUpdatePreviewBody update={{ text: current.retainedContext }} onNavigate={onClose} />}
      {current?.nextPromptPreview && <div style={{ whiteSpace: 'pre-wrap' }}>{current.nextPromptPreview}</div>}
      <details style={{ color: '#999', fontSize: 10 }}><summary style={{ cursor: 'pointer' }}>Источник и ID</summary>
        <div>Операция: <code>{operation.operationId}</code></div>
        <div>Исходная сессия: <code>{operation.expectedSessionId}</code></div>
        {operation.newSessionId && <div>После отката: <code>{operation.newSessionId}</code></div>}
        {operation.resume?.status && <div>Resume: {operation.resume.status}</div>}
        {operation.followup && <div>Отправка: <code>{operation.followup.handoffId}</code></div>}
      </details>
    </div>
  </RequestDetailsPopover>;
}
