import { formatHistoryIncidentMoscowTime } from './historySendIncidentReport.mjs';

const text = (value) => typeof value === 'string' ? value.trim() : '';

export function buildRunAfterIncidentReport(input = {}) {
  const occurredAt = Number.isFinite(Number(input.occurredAt))
    ? Number(input.occurredAt)
    : Date.now();
  const tabId = text(input.tabId) || '-';
  const reason = text(input.reason) || 'unknown';
  return [
    'Noted Terminal Run after incident',
    'Error: ' + reason,
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
