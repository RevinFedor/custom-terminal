/**
 * Reconciles the small live History overlay with the durable transcript.
 *
 * A successful IPC response can still describe the snapshot taken just before
 * the newest live message. Retrying only while unmatched live state remains
 * closes that race without polling, timers, or rebuilding History per append.
 */
export async function flushHistoryDurableWithRetry({
  load,
  isCurrent,
  hasUnmatchedLive,
  maxAttempts = 3,
}) {
  const attemptsLimit = Math.max(1, Math.floor(maxAttempts));
  let lastLoadSucceeded = false;

  for (let attempt = 1; attempt <= attemptsLimit; attempt += 1) {
    lastLoadSucceeded = await load();
    if (!isCurrent()) {
      return {
        success: false,
        settled: false,
        stale: true,
        attempts: attempt,
      };
    }
    if (lastLoadSucceeded && !hasUnmatchedLive()) {
      return {
        success: true,
        settled: true,
        stale: false,
        attempts: attempt,
      };
    }
  }

  return {
    success: lastLoadSucceeded,
    settled: false,
    stale: false,
    attempts: attemptsLimit,
  };
}
