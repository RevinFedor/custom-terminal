// A visual clock, never delivery proof, input readiness or a deadline.
export function normalizeHistorySendInputTiming(value) {
  if (value?.version !== 1 || !Number.isFinite(value.preparationStartedAt) || value.preparationStartedAt <= 0) return undefined;
  return Object.freeze({ version: 1, preparationStartedAt: value.preparationStartedAt,
    ...(Number.isFinite(value.payloadStartedAt) && value.payloadStartedAt > 0 ? { payloadStartedAt: value.payloadStartedAt } : {}) });
}
export function historySendTimerState({ sendInputTiming, status, changedAt }, now = Date.now()) {
  const timing = normalizeHistorySendInputTiming(sendInputTiming);
  if (!timing || !status) return null; // No click/Enter/legacy inference.
  const inserted = !!timing.payloadStartedAt;
  if (!inserted && (status === 'application-queued' || status === 'sent')) return null;
  const running = !inserted && !['failed', 'cancelled'].includes(status);
  // A failed pre-input preparation has its own terminal elapsed duration;
  // it is not presented as a successful insertion time.
  const end = inserted ? timing.payloadStartedAt : running ? now : changedAt;
  if (!Number.isFinite(end)) return null;
  return { running, seconds: Math.max(0, Math.floor((end - timing.preparationStartedAt) / 1000)) };
}
