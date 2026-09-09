'use strict';

// A writable composer is insufficient for Escape: while MCP is starting it
// accepts text, but Escape cancels startup instead of priming Native Rewind.
// This action-specific observer never changes the shared send-ready verdict.
function waitForCodexRewindActionReady({
  readSnapshot, inspectReady, isCurrent, subscribe, cancelPromise,
  timeoutMs = 30_000,
}) {
  return new Promise(resolve => {
    let settled = false;
    let unsubscribe = () => {};
    let lastReason = 'frame-unavailable';
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe();
      resolve({ ...result, rollbackMayHaveApplied: false });
    };
    const check = () => {
      if (settled) return;
      if (!isCurrent()) {
        finish({ success: false, error: 'codex_operation_changed_before_rewind' });
        return;
      }
      const snapshot = readSnapshot();
      if (snapshot?.success !== true || snapshot.authoritativeFrameCommitted !== true) return;
      const inspected = inspectReady(snapshot);
      // Reuse the shared parser's current-frame scope, including wrapped
      // startup rows. Historical warnings must not hold a later composer.
      const startup = [...(inspected?.blockers || []), ...(inspected?.ignoredBlockers || [])]
        .includes('mcp-startup');
      lastReason = startup ? 'mcp-startup-owns-escape' : (inspected?.reason || 'not-ready');
      if (inspected?.ready === true && !startup) finish({ success: true });
    };
    const timer = setTimeout(() => finish({
      success: false, error: 'codex_rewind_action_not_ready', reason: lastReason,
    }), timeoutMs);
    unsubscribe = subscribe(check);
    cancelPromise?.then(() => finish({ success: false, cancelled: true, error: 'rewind_cancelled' }));
    check();
  });
}

module.exports = { waitForCodexRewindActionReady };
