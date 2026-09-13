// A one-shot UI command can precede mounting the target Timeline (for example
// when it is requested from the global queue overview). Keep delivery until
// that surface subscribes; the queue editor still owns the selection result.
const pending = new Map();
export function requestQueuedRewindTarget(tabId, requestId) {
  const request = { tabId, requestId };
  pending.set(tabId, request);
  window.dispatchEvent(new CustomEvent('prompt-queue:request-rewind-target', { detail: request }));
}
export function pendingQueuedRewindTarget(tabId) { return pending.get(tabId) || null; }
export function consumeQueuedRewindTarget(tabId, requestId) {
  if (pending.get(tabId)?.requestId === requestId) pending.delete(tabId);
}
export function cancelQueuedRewindTarget(tabId, requestId) {
  consumeQueuedRewindTarget(tabId, requestId);
  window.dispatchEvent(new CustomEvent('prompt-queue:rewind-target-cancelled', { detail: { tabId, requestId } }));
}
