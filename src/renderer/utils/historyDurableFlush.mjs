/**
 * Reconciles the small live History overlay with the durable transcript.
 *
 * A successful IPC response can still describe the snapshot taken just before
 * the newest live message. Retrying only while known unmatched live state
 * remains closes that race without polling, timers, or renewed observations.
 * UNKNOWN ends this observation; only an existing external signal may wake it.
 *
 * @param {{ load: () => Promise<boolean>, isCurrent: () => boolean,
 *   hasUnmatchedLive: () => boolean | null | Promise<boolean | null>,
 *   maxAttempts?: number }} options
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
    if (isCurrent() !== true) {
      return {
        success: false,
        settled: false,
        stale: true,
        attempts: attempt,
      };
    }
    if (!lastLoadSucceeded) continue;
    let unmatched;
    try { unmatched = await hasUnmatchedLive(); } catch { unmatched = null; }
    if (isCurrent() !== true) {
      return {
        success: false,
        settled: false,
        stale: true,
        attempts: attempt,
      };
    }
    if (typeof unmatched !== 'boolean') {
      return {
        success: true,
        settled: false,
        stale: false,
        unknown: true,
        attempts: attempt,
      };
    }
    if (unmatched === false) {
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
