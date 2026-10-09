import { formatHistoryIncidentMoscowTime } from './historySendIncidentReport.mjs';

const text = (value) => typeof value === 'string' ? value.trim() : '';

export function buildRunAfterIncidentReport(input = {}) {
  const occurredAt = Number.isFinite(Number(input.occurredAt))
    ? Number(input.occurredAt)
    : Date.now();
  const tabId = text(input.tabId) || '-';
  const reason = text(input.reason) || 'unknown';
  // A requested process Stop is neither a Run After error nor queue Pause.
  if (reason === 'manual-stop') return null;
  const ownerId = text(input.ownerTabId);
  const remaining = Number.isSafeInteger(input.remainingItems) && input.remainingItems >= 0
    ? input.remainingItems : null;
  return [
    'Noted Terminal Run after incident',
    'Error: ' + reason,
    ...(ownerId ? ['Queue tab: ' + (text(input.ownerName) || ownerId) + ' (' + ownerId + ')'] : []),
    ...(remaining !== null ? ['Карточек сохранено: ' + remaining] : []),
    'Trigger: ' + (text(input.triggerName) || 'unknown'),
    'Tab ID: ' + tabId,
    'Session ID: ' + (text(input.sessionId) || '-'),
    'Time (Moscow): ' + formatHistoryIncidentMoscowTime(occurredAt),
    'Time (UTC): ' + new Date(occurredAt).toISOString(),
    'Outcome: ' + (text(input.outcome) || '-'),
    'Source: ' + (text(input.source) || '-'),
    'Log lookup: [PromptQueueRunner] tab=' + tabId.slice(-12) + ' reason=' + reason,
  ].join('\n');
}
