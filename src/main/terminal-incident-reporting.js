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

// Notification grouping never supplies launch/input authority. It joins only
// the watchdog and waiter that proved the same physical Codex launch; each
// retains its own independently captured diagnostic artifact.
function codexStartupDiagnosticGroup(tabId, launchId, lifecycleGeneration) {
  if (![tabId, launchId, lifecycleGeneration].every(value => typeof value === 'string' && value.trim())) return null;
  return JSON.stringify(['codex-startup-diagnostic', tabId, launchId, lifecycleGeneration]);
}

function codexStartupWaitDiagnosticGroup(tabId, toolType, expected, observed) {
  if (toolType !== 'codex' || !expected?.launchId || !expected?.lifecycleGeneration
    || expected.launchId !== observed?.launchId
    || expected.lifecycleGeneration !== observed?.lifecycleGeneration) return null;
  return codexStartupDiagnosticGroup(tabId, expected.launchId, expected.lifecycleGeneration);
}

// Diagnostic capture is an observer, never an admission/retry mechanism.
// Capture starts synchronously at the incident, before disk/renderer awaits.
function createTerminalIncidentReporter({ capture, notify, limit = 256 }) {
  const incidents = new Map();
  const notifiedGroups = new Map();
  return function report(key, payload) {
    if (incidents.has(key)) return incidents.get(key);
    let captured;
    try { captured = capture(payload); } catch (error) { captured = Promise.reject(error); }
    const pending = Promise.resolve(captured).then(
      result => ({ ...payload, ...result, success: true }),
      error => ({ ...payload, success: false, error: String(error?.message || error) }),
    ).then(result => {
      const group = typeof result.notificationGroup === 'string' && result.notificationGroup ? result.notificationGroup : null;
      const presented = group && notifiedGroups.has(group)
        ? { ...result, silent: true, duplicateNotification: true } : result;
      try {
        const delivered = notify(presented);
        if (group && result.success && !presented.silent && delivered !== false) {
          notifiedGroups.set(group, true);
          while (notifiedGroups.size > limit) notifiedGroups.delete(notifiedGroups.keys().next().value);
        }
      } catch (error) { console.warn('[TerminalIncident] notify failed', error?.message); }
      return result;
    });
    incidents.set(key, pending);
    while (incidents.size > limit) incidents.delete(incidents.keys().next().value);
    return pending;
  };
}

// Diagnostic attribution uses the existing Main receipt, not caller text or a
// nearest/latest attempt. It never grants execution rights or changes a row.
function resolveTerminalIncidentSendIdentity(store, { tabId, provider, handoffId, attemptId } = {}) {
  if (!tabId || !handoffId || !attemptId) return null;
  try {
    const record = store.list({ tabId, handoffId, limit: 16 }).find(row =>
      row.tabId === tabId && row.provider === provider && row.handoffId === handoffId && row.attemptId === attemptId);
    return record ? { operationKey: record.operationKey, attemptId: record.attemptId, handoffId: record.handoffId } : null;
  } catch { return null; }
}

// The renderer reports a failure, not a new delivery fact. Only bounded IDs
// cross this diagnostic channel; prompt text, attachment bytes and exceptions
// stay out. Missing durable identity is explicit (standalone slash can have no
// receipt). This payload never admits a Send or changes its outcome.
function terminalSendFailureDiagnosticPayload(input = {}, store) {
  const id = value => typeof value === 'string' && /^[a-zA-Z0-9:_/+=.-]{1,256}$/.test(value) ? value : null;
  const tabId = id(input.tabId), handoffId = id(input.handoffId);
  if (!tabId || !handoffId || !['codex', 'claude'].includes(input.toolType)) return null;
  const reportedAttemptId = id(input.sendAttemptId);
  const proven = resolveTerminalIncidentSendIdentity(store,
    { tabId, provider: input.toolType, handoffId, attemptId: reportedAttemptId });
  return { tabId, toolType: input.toolType, incidentReason: 'send-failure-reported', silent: true,
    sendIdentity: proven || { handoffId },
    context: { source: 'history-send-catch', terminalEvidence: 'current-at-main-report-not-original-submission',
      reportedAt: Number.isFinite(input.reportedAt) ? input.reportedAt : null,
      reportedIdentity: { handoffId, attemptId: reportedAttemptId, operationKey: id(input.sendOperationKey) },
      durableIdentity: proven ? 'exact-tab-handoff-attempt' : 'unavailable',
      code: id(input.code), submitted: typeof input.submitted === 'boolean' ? input.submitted : null,
      pasteWritten: typeof input.pasteWritten === 'boolean' ? input.pasteWritten : null } };
}
module.exports = { createTerminalIncidentReporter, terminalSendIncidentNotification,
  codexStartupDiagnosticGroup, codexStartupWaitDiagnosticGroup,
  resolveTerminalIncidentSendIdentity, terminalSendFailureDiagnosticPayload };
