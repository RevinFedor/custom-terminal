'use strict';

// The diagnostic describes the detection time; writing it may outlive the
// delivery audit. Re-read only the same attempt when presenting that report.
function terminalSendIncidentNotification(result, record, checkedAt = Date.now()) {
  const delayed = result?.incidentReason === 'send-confirmation-delayed';
  if (!delayed && result?.incidentReason !== 'send-delivery-unconfirmed') return null;
  const identity = result.sendIdentity;
  const matched = !!identity?.operationKey && !!identity?.attemptId
    && record?.operationKey === identity.operationKey
    && record.attemptId === identity.attemptId
    && record.tabId === result.tabId
    && record.handoffId === result.historyEntry?.handoffId
    && record.provider === result.toolType;
  const state = matched ? record.state : 'unavailable';
  const confirmed = state === 'confirmed';
  const confirming = delayed && state === 'audit-pending';
  const reportStatus = result.success
    ? 'Диагностика задержки сохранена.'
    : 'Диагностику задержки сохранить не удалось.';
  return {
    // A live audit is ordinary progress, not an action the user needs to fix.
    // Keep the captured packet, but don't interrupt them just because the
    // caller stopped waiting. Lost ownership/capture failures remain visible.
    notifyUser: !(delayed && matched && (confirming || confirmed) && result.success),
    headline: confirmed
      ? 'Отправка подтверждена. ' + reportStatus
      : confirming
      ? 'Подтверждение отправки задержалось. ' + reportStatus
      : 'Подтверждение отправки задержалось. ' + reportStatus,
    tone: (confirmed || confirming) && result.success ? 'info' : 'warning',
    referenceSuffix: [
      'sendOperationKey: ' + (identity?.operationKey || '-'),
      'sendAttemptId: ' + (identity?.attemptId || '-'),
      'deliveryStatusAtNotification: ' + state,
      'deliveryStatusCheckedAt: ' + new Date(checkedAt).toISOString(),
    ].join('\n'),
  };
}

// Diagnostic capture is an observer, never an admission/retry mechanism.
// Capture starts synchronously at the incident, before disk/renderer awaits.
function createTerminalIncidentReporter({ capture, notify, limit = 256 }) {
  const incidents = new Map();
  return function report(key, payload) {
    if (incidents.has(key)) return incidents.get(key);
    let captured;
    try { captured = capture(payload); } catch (error) { captured = Promise.reject(error); }
    const pending = Promise.resolve(captured).then(
      result => ({ ...payload, ...result, success: true }),
      error => ({ ...payload, success: false, error: String(error?.message || error) }),
    ).then(result => {
      try { notify(result); } catch (error) { console.warn('[TerminalIncident] notify failed', error?.message); }
      return result;
    });
    incidents.set(key, pending);
    while (incidents.size > limit) incidents.delete(incidents.keys().next().value);
    return pending;
  };
}

module.exports = { createTerminalIncidentReporter, terminalSendIncidentNotification };
