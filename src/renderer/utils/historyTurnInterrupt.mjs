// Escape owns a control request, not the send receipt or its History refresh.
// Main still targets an exact live turn at the existing PTY write boundary.
export function canInterruptHistoryTurn({
  status, busyAction, stopping, answeringQuestion, pendingQuestion, rewindLocked,
  recordWithoutReply = false, interruptPending = false,
}) {
  return status === 'busy' && !stopping && !answeringQuestion && !pendingQuestion
    && !rewindLocked && !recordWithoutReply && !interruptPending
    && (!busyAction || busyAction === 'send');
}

export function requestHistoryTurnInterrupt({ slot, ownerKey, currentOwner, request, onPending, onResult, onError, refresh }) {
  if (slot.current?.ownerKey === ownerKey) return slot.current.promise;
  const token = { ownerKey, promise: null };
  slot.current = token;
  const current = () => slot.current === token && currentOwner() === ownerKey;
  onPending(true);
  token.promise = Promise.resolve().then(request).then(result => {
    if (current()) onResult(result);
    if (result?.success !== true) throw new Error(result?.error || 'Interrupt failed');
    return result;
  }).catch(error => {
    if (current()) onError(error);
    return { success: false, interrupted: false, error: String(error?.message || error) };
  }).finally(() => {
    if (!current()) return;
    slot.current = null;
    onPending(false);
    // Refresh is independent of request completion and cannot hold its UI.
    refresh();
  });
  return token.promise;
}
