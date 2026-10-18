// A visual clock, never a delivery proof or preparation deadline.
export function historySendTimerState({ startedAt, enterAttemptAt, status, changedAt, reason }, now = Date.now()) {
  if (!Number.isFinite(startedAt) || startedAt <= 0 || !status) return null;
  const entered = Number.isFinite(enterAttemptAt) && enterAttemptAt > 0;
  const running = !entered && (['preparing', 'sending', 'application-queued'].includes(status)
    || status === 'queued' && ['send-ready-queued', 'send-queued', 'send-retry-start'].includes(reason));
  // Unknown/legacy confirming cannot supply an invented Enter time. Hide it
  // until the exact timing arrives, rather than include the audit delay.
  if (!entered && !running && !['failed', 'cancelled'].includes(status)) return null;
  const end = entered ? enterAttemptAt : running ? now : changedAt;
  if (!Number.isFinite(end)) return null;
  return { running, seconds: Math.max(0, Math.floor((end - startedAt) / 1000)) };
}
