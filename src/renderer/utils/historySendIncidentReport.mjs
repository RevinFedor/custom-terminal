const text = (value) => typeof value === 'string' ? value.trim() : '';

export function formatHistoryIncidentMoscowTime(value) {
  const timestamp = Number.isFinite(Number(value)) ? Number(value) : Date.now();
  // Moscow is permanently UTC+3 for every supported runtime date. Using UTC
  // accessors after the fixed shift keeps tests and copied reports identical
  // regardless of the computer's current locale.
  return new Date(timestamp + (3 * 60 * 60 * 1000))
    .toISOString()
    .replace('T', ' ')
    .replace('Z', ' MSK');
}

export function buildHistorySendIncidentReport(input = {}) {
  const occurredAt = Number.isFinite(Number(input.occurredAt))
    ? Number(input.occurredAt)
    : Date.now();
  const tabId = text(input.tabId) || '-';
  const handoffId = text(input.handoffId) || '-';
  const error = text(input.error) || 'Unknown error';
  const promptText = typeof input.promptText === 'string' ? input.promptText : '';
  const lines = [
    'Noted Terminal send incident',
    'Error: ' + error,
    'Tab ID: ' + tabId,
    'Time (Moscow): ' + formatHistoryIncidentMoscowTime(occurredAt),
    'Time (UTC): ' + new Date(occurredAt).toISOString(),
    'Tool: ' + (text(input.toolType) || '-'),
    'Action: ' + (text(input.action) || '-'),
    'Handoff ID: ' + handoffId,
    'Send attempt ID: ' + (text(input.sendAttemptId) || '-'),
    'Send operation key: ' + (text(input.sendOperationKey) || '-'),
    'Status at click: ' + (text(input.statusAtSend) || '-'),
    'Effective status: ' + (text(input.effectiveStatusAtSend) || '-'),
    'Submitted: ' + (typeof input.submitted === 'boolean' ? String(input.submitted) : '-'),
    'Paste written: ' + (typeof input.pasteWritten === 'boolean' ? String(input.pasteWritten) : '-'),
    'Error code: ' + (text(input.code) || '-'),
    'Images: ' + (Number.isFinite(Number(input.images)) ? Number(input.images) : 0),
    'Chips: ' + (Number.isFinite(Number(input.chips)) ? Number(input.chips) : 0),
    'Log lookup: [HistoryHandoff] SEND_RESULT tab=' + tabId.slice(-12)
      + ' handoff=' + handoffId,
  ];
  if (promptText) {
    lines.push('Prompt (' + promptText.length + ' chars):', promptText);
  }
  return lines.join('\n');
}
