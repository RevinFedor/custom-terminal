export function normalizeAppRestartTrigger(trigger) {
  if (!trigger || trigger.kind !== 'app-restart') return null;
  const armedInstanceId = typeof trigger.armedInstanceId === 'string'
    ? trigger.armedInstanceId.trim()
    : '';
  return armedInstanceId ? { kind: 'app-restart', armedInstanceId } : null;
}

export function appRestartTriggerIsSatisfied(trigger, currentInstanceId) {
  const normalized = normalizeAppRestartTrigger(trigger);
  const current = typeof currentInstanceId === 'string' ? currentInstanceId.trim() : '';
  return !!normalized && !!current && normalized.armedInstanceId !== current;
}
