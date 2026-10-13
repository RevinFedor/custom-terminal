// Main-issued physical authority, observed before an intent exists. This is
// not a lifecycle/status cache and cannot mint or refresh a pending intent.
const known = new Map();
const subscribed = new WeakSet();
export function rememberAgentLaunchFence(tabId, fence) {
  if (!tabId || !fence || typeof fence.terminalInstanceId !== 'string'
    || !Number.isSafeInteger(fence.stopRevision) || fence.stopRevision < 0
    || !Number.isSafeInteger(fence.order) || fence.order <= 0) return false;
  const old = known.get(tabId);
  if (old && (fence.order < old.order || fence.order === old.order
    && (fence.terminalInstanceId !== old.terminalInstanceId || fence.stopRevision !== old.stopRevision))) return false;
  known.set(tabId, Object.freeze({ terminalInstanceId: fence.terminalInstanceId,
    stopRevision: fence.stopRevision, order: fence.order }));
  return true;
}
export function readAgentLaunchFence(tabId) {
  const value = known.get(tabId);
  return value ? { ...value } : null;
}
export function observeAgentLaunchFences(events) {
  if (!events || subscribed.has(events)) return;
  subscribed.add(events);
  events.on('agent:launch-fence-revoked', (_event, value) => {
    rememberAgentLaunchFence(value?.tabId, value?.launchFence);
  });
  // A PTY exit is a loss of authority, not an idle provider turn.
  events.on('terminal:exit', (_event, tabId, _exitCode, fence) => {
    const current = known.get(tabId);
    if (current && fence?.terminalInstanceId === current.terminalInstanceId
      && fence?.stopRevision === current.stopRevision && fence?.order === current.order) known.delete(tabId);
  });
}
