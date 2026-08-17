// Armed Run after queues as install blockers.
//
// `/api/active-loaders` used to answer a narrower question than its callers
// asked: "is a turn running right now?" instead of "is there work left that the
// user is waiting on?". A queue chain answers only the second one. Between two
// links — the trigger tab finished, the owner tab has not started yet — nobody
// is running, so the snapshot said idle and the rebuild killed the app mid-chain.
//
// Measured (2026-08-16, production.log): tab-2532 finished at 07:35:01.6,
// tab-2570 started at 07:35:03.3, and the idle poll landed at 07:35:02.0 — a
// 1.7s hole. IDLE_CONFIRM=2 at a 1s interval does not cover it, and no amount of
// extra confirmations would: the hole is a real state, not a sampling artifact.
// The fix is to make the promise itself visible, not to sample harder.
//
// A promise is durable state (SQLite `promptQueueByTab`), so this reads the
// same persisted snapshot the queue writes — main has no live copy of the
// renderer's queue store, and inventing a second one is exactly the drift this
// codebase keeps paying for.
//
// What counts as an outstanding promise:
//   • Run after armed AND at least one enabled card left to send. `enabled`
//     defaults to true — a card saved before that field existed is runnable.
//   • Loop armed with non-empty text: it re-sends after every answer, so it is
//     never "done" while it is on.
//
// What does NOT count, deliberately:
//   • Cards with Run after off. That is staging — a saved draft, not a promise.
//   • An armed queue whose cards are all disabled: nothing left to send.
//   • A tab that no longer exists. A closed tab's leftover row must not wedge
//     the rebuild forever; the caller supplies the liveness test.
//
// The blockers produced here carry `status:'queued'`, distinct from `'busy'`:
// the tab is not running, it is *owed*. Observers only check `idle`, but a human
// reading the log should see which of the two it is.

const QUEUE_BLOCKER_KIND = 'prompt-queue';
const QUEUE_STATE_BLOCKER_KIND = 'prompt-queue-state';

function promptQueueReadFailureBlocker(error) {
  return {
    tabId: '__prompt_queue_state__',
    kind: QUEUE_STATE_BLOCKER_KIND,
    status: 'unknown',
    reason: 'persisted-queue-read-failed',
    error: String(error?.message || error || 'unknown error'),
  };
}

function isEnabledQueuedItem(item) {
  return !!item && item.enabled !== false;
}

function countEnabledItems(entry) {
  const items = Array.isArray(entry?.items) ? entry.items : [];
  let count = 0;
  for (const item of items) if (isEnabledQueuedItem(item)) count += 1;
  return count;
}

function hasArmedLoop(entry, sharedLoopText) {
  if (entry?.loopPromptEnabled !== true) return false;
  // The loop body is shared across tabs and stored separately; a per-tab
  // override wins when present. Empty text means the loop is configured but
  // has nothing to send, which the runner also treats as inactive.
  const text = typeof entry?.loopPromptText === 'string' && entry.loopPromptText.length > 0
    ? entry.loopPromptText
    : (typeof sharedLoopText === 'string' ? sharedLoopText : '');
  return text.trim().length > 0;
}

/**
 * Describe one tab's outstanding queue promise, or null when it owes nothing.
 * Exported separately so the reason is testable without the whole snapshot.
 */
function describeQueuePromise(entry, sharedLoopText) {
  if (!entry || typeof entry !== 'object') return null;
  const enabledCount = countEnabledItems(entry);
  const queueArmed = entry.autoRun === true && enabledCount > 0;
  const loopArmed = hasArmedLoop(entry, sharedLoopText);
  if (!queueArmed && !loopArmed) return null;
  return {
    reason: queueArmed && loopArmed ? 'queue+loop' : (queueArmed ? 'queue' : 'loop'),
    pending: enabledCount,
  };
}

/**
 * Build install blockers for every tab that still owes queued work.
 *
 * @param {object} params
 * @param {object|null} params.persistedQueues  parsed `promptQueueByTab`
 * @param {string|null} params.sharedLoopText   parsed `promptQueueSharedLoopPrompt`
 * @param {(tabId: string) => boolean} [params.tabExists]  liveness test; a tab
 *        that fails it is skipped, so a closed tab's stale row cannot block
 *        forever. Defaults to "every tab in the snapshot is live".
 * @param {(tabId: string) => object} [params.labelFor]  project/name decoration
 * @param {Set<string>} [params.seen]  tab ids already claimed by a stronger
 *        (running) loader — one tab contributes at most one blocker, and an
 *        actually-running turn is the more informative of the two.
 */
function computePromptQueueInstallBlockers({
  persistedQueues,
  sharedLoopText = null,
  tabExists = () => true,
  labelFor = () => ({}),
  seen = new Set(),
} = {}) {
  if (!persistedQueues || typeof persistedQueues !== 'object' || Array.isArray(persistedQueues)) {
    return [];
  }
  const blockers = [];
  for (const [tabId, entry] of Object.entries(persistedQueues)) {
    if (!tabId || seen.has(tabId)) continue;
    const promise = describeQueuePromise(entry, sharedLoopText);
    if (!promise) continue;
    if (!tabExists(tabId)) continue;
    blockers.push({
      tabId,
      kind: QUEUE_BLOCKER_KIND,
      // Not 'busy': this tab is not running, it is owed. Observers only read
      // `idle`, but the distinction has to survive into the log.
      status: 'queued',
      reason: promise.reason,
      pending: promise.pending,
      ...labelFor(tabId),
    });
  }
  return blockers;
}

module.exports = {
  QUEUE_BLOCKER_KIND,
  QUEUE_STATE_BLOCKER_KIND,
  computePromptQueueInstallBlockers,
  describeQueuePromise,
  promptQueueReadFailureBlocker,
};
