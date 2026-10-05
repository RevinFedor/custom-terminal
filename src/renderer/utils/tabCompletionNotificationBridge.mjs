// A read/set adapter over the existing workspace actions, not a bell owner.
// Capture order belongs to this renderer lifetime, not HTTP reply arrival.
export function createTabCompletionNotificationBridge({ getState, persistencePending,
  epoch = globalThis.crypto.randomUUID() }) {
  let sequence = 0;
  const read = ({ projectId, tabId }) => {
    const tab = getState().openProjects.get(projectId)?.tabs.get(tabId);
    if (!tab) return { ok: false, code: 'completion_notification_state_unavailable' };
    if (!['terminal', 'claude-sdk'].includes(tab.tabType || 'terminal')) {
      return { ok: false, code: 'completion_notification_ineligible' };
    }
    return { ok: true, projectId, tabId, version: { epoch, sequence: ++sequence },
      completionNotificationArmed: tab.completionNotificationArmed === true,
      completionNotificationPersistent: tab.completionNotificationPersistent === true,
      completionNotificationFired: tab.completionNotificationFired === true,
      completionNotificationFiredAt: Number(tab.completionNotificationFiredAt) || null,
      persistencePending: persistencePending(projectId) === true };
  };
  return { read, async set(request) {
    const before = read(request);
    if (!before.ok) return before;
    const { projectId, tabId, mode, enabled } = request;
    if (!['oneshot','persistent'].includes(mode) || typeof enabled !== 'boolean') {
      return { ok: false, code: 'completion_notification_request_invalid' };
    }
    let result;
    if (mode === 'persistent') {
      result = await getState().setTabCompletionNotificationPersistent(projectId, tabId, enabled);
    } else getState().setTabCompletionNotificationArmed(projectId, tabId, enabled);
    const current = read(request);
    if (!current.ok) return current;
    if (mode === 'persistent' && result?.success !== true) {
      return { ...current, ok: false, code: 'completion_notification_persistence_failed' };
    }
    const applied = current[mode === 'persistent' ? 'completionNotificationPersistent' : 'completionNotificationArmed'] === enabled;
    return { ...current, ok: applied, ...(applied ? {} : { code: 'completion_notification_superseded' }),
      persistentCommitted: mode === 'persistent' ? true : undefined };
  } };
}
