'use strict';

const completionNotificationCapability = Object.freeze({ version: 1, modes: ['oneshot','persistent'],
  endpoint: '/api/terminal-tabs/:tabId/completion-notification', read: true, set: true,
  event: 'completion-notification-changed', ordering: 'renderer-epoch-sequence', persistentCommit: 'sqlite-ack' });

async function completionNotificationRequest({ method, tabId, body, db, bridge }) {
  const fail = (status, code, extra = {}) => ({ status, data: { ...extra, ok: false, success: false, code, error: code } });
  if (method === 'POST' && (!body || !['oneshot','persistent'].includes(body.mode)
    || typeof body.enabled !== 'boolean' || Object.keys(body).some(key => !['mode','enabled'].includes(key)))) {
    return fail(400, 'completion_notification_request_invalid', { mutationOutcome: 'not-started' });
  }
  const target = db.getTabCompletionNotificationPreference(tabId);
  if (!target) return fail(404, 'tab_not_found', { mutationOutcome: 'not-started' });
  if (!['terminal','claude-sdk'].includes(target.tabType)) {
    return fail(422, 'completion_notification_ineligible', { mutationOutcome: 'not-started' });
  }
  let snapshot;
  try {
    snapshot = await bridge(method === 'POST' ? 'setTabCompletionNotification' : 'getTabCompletionNotification',
      { projectId: target.projectId, tabId, ...(method === 'POST' ? body : {}) }, 5000);
  } catch (error) {
    return fail(503, 'completion_notification_bridge_unavailable', {
      mutationOutcome: method === 'POST' && error?.dispatched !== false ? 'unknown' : 'not-started',
      readbackRequired: method === 'POST' && error?.dispatched !== false,
    });
  }
  const current = db.getTabCompletionNotificationPreference(tabId);
  if (!current || current.projectId !== target.projectId || current.tabType !== target.tabType
    || (snapshot?.projectId && snapshot.projectId !== target.projectId) || (snapshot?.tabId && snapshot.tabId !== tabId)) {
    return fail(409, 'completion_notification_target_changed', { mutationOutcome: method === 'POST' ? 'unknown' : 'not-started' });
  }
  if (!snapshot?.version?.epoch || !Number.isSafeInteger(snapshot.version.sequence)
    || ['completionNotificationArmed','completionNotificationPersistent','completionNotificationFired']
      .some(key => typeof snapshot[key] !== 'boolean')) {
    return fail(snapshot?.code === 'completion_notification_ineligible' ? 422 : 503,
      snapshot?.code || 'completion_notification_state_unavailable',
      { mutationOutcome: method === 'POST' ? 'unknown' : 'not-started' });
  }
  const persisted = current.persistent === 1;
  const data = { ...snapshot, success: snapshot.ok === true,
    storedPersistent: persisted,
    persistentDurable: !snapshot.persistencePending && persisted === snapshot.completionNotificationPersistent };
  if (!snapshot.ok) return fail(snapshot.code === 'completion_notification_superseded' ? 409 : 503,
    snapshot.code || 'completion_notification_state_unavailable', { ...data, readbackRequired: method === 'POST' });
  if (method === 'POST' && body.mode === 'persistent'
    && (snapshot.persistentCommitted !== true || persisted !== body.enabled)) {
    return fail(409, 'completion_notification_persistence_unconfirmed', { ...data, readbackRequired: true });
  }
  return { status: 200, data };
}

module.exports = { completionNotificationCapability, completionNotificationRequest };
