'use strict';

// Runs inside TabMessageService's SQLite transaction. Defer process-local
// cancellation/publication until commit; the durable guard already forbids a
// new attempt/Enter, including a crash between commit and that notification.
function prepareTabMessageDeliveryCancellation({ store, queue, db }, message) {
  if (!store || store.db !== db || queue && queue.store !== store) return { ok: false };
  const record = store.get(message.operationKey);
  const result = store.cancelDelivery({ operationKey: message.operationKey,
    tabId: message.targetTabId, handoffId: message.handoffId, attemptId: record?.attemptId || null,
    allowUnreserved: true, notify: false, reason: 'tab-message-cancel', presentationDismissed: true });
  return { ...result, afterCommit: () => queue?.cancelDelivery(message.targetTabId,
    message.handoffId, { dismiss: true, reason: 'tab-message-cancel' }) };
}

module.exports = { prepareTabMessageDeliveryCancellation };
