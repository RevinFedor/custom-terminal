// Own native background work (Claude Task/Agent calls, Codex live subagents),
// projected for Run After / Loop admission AND for the tab card's loader.
//
// Why this exists separately from `turnBusy`:
//   A parent turn can finish while its own async Agent is still running. That
//   work belongs to THIS tab — the tab loader already shows it (TabBar) and
//   Auto-stop / Stop idle / the mini-orchestrator already refuse to act while
//   it is positive (`getCombinedTabBackgroundWorkCount` in main). Run After was
//   the one consumer still deciding purely on the busy→idle edge, so a queued
//   card could be sent into a tab whose own subagent was still working.
//
// Scope note: Main deliberately counts only agents here, NOT background
// Bash/Monitor tasks (`taskCount`). A detached `npm run dev` must not hold a
// tab busy forever. This projection keeps that exact boundary — it reuses
// main's count instead of inventing a second notion of background work.
//
// Unknown is not idle: until the first authoritative read lands, callers get
// `false` (no block) only because main publishes a record for every tab with
// live work at subscribe time. A positive count always blocks.

const BACKGROUND_WORK_CHANNEL = 'tab:background-work';

const counts = new Map();
const revisions = new Map();
const listeners = new Set();

let initializePromise = null;
let subscribed = false;
// Per-tab restore promises. The module-level `initializePromise` answers "the
// runner's startup set has been read"; a card mounting later asks about ONE
// tab that set may never have contained, so it needs its own memo. Both are
// one-shot: many cards mounting together cost one request per tab, not one per
// card, and a later remount of the same card costs none.
const tabRestores = new Map();

function ipc() {
  try {
    return window.require('electron').ipcRenderer;
  } catch {
    return null;
  }
}

/**
 * Apply one main-owned record. A monotonically increasing revision prevents a
 * slower startup snapshot from overwriting a newer live transition — the same
 * rule TabBar uses for the loader, so both surfaces cannot disagree.
 *
 * @returns {boolean} whether the stored active state changed
 */
export function applyTabBackgroundWorkRecord(record) {
  const tabId = String(record?.tabId || '').trim();
  if (!tabId) return false;
  const revision = Number(record?.revision);
  const previousRevision = revisions.get(tabId) ?? -1;
  if (Number.isFinite(revision)) {
    if (revision < previousRevision) return false;
    revisions.set(tabId, revision);
  } else if (previousRevision >= 0) {
    return false;
  }
  const count = Number(record?.count) || 0;
  const previous = counts.get(tabId) || 0;
  if (count > 0) counts.set(tabId, count);
  else counts.delete(tabId);
  return (previous > 0) !== (count > 0);
}

/** Positive own background work blocks the next queue/Loop step for this tab. */
export function tabOwnBackgroundWorkBlocks(tabId) {
  return (counts.get(String(tabId || '')) || 0) > 0;
}

export function tabOwnBackgroundWorkCount(tabId) {
  return counts.get(String(tabId || '')) || 0;
}

/**
 * Notified only on a real active→idle transition of one tab, so the runner can
 * retry an outcome it already observed. This never invents a new natural final.
 */
export function subscribeTabOwnBackgroundWork(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Presentation subscription for ONE tab: fires on that tab's active↔idle
 * transition and on nothing else.
 *
 * Separate from `subscribeTabOwnBackgroundWork` on purpose. That one feeds the
 * queue runner, which is a single module-level consumer and wants every tab's
 * transition. A card is mounted per tab, often dozens at once, and waking all
 * of them for a neighbour's subagent is the "subscribe to the whole Map"
 * mistake this project keeps paying for.
 *
 * Returns the unsubscribe function. The caller is responsible for seeding the
 * initial value with `tabOwnBackgroundWorkBlocks`, because this channel carries
 * transitions only.
 */
export function subscribeTabBackgroundWorkPresentation(tabId, listener) {
  const key = String(tabId || '').trim();
  if (!key) return () => {};
  return subscribeTabOwnBackgroundWork((event) => {
    if (event?.tabId === key) listener(event.active === true);
  });
}

function subscribeChannel() {
  const channel = ipc();
  if (!channel || subscribed) return channel;
  subscribed = true;
  channel.on(BACKGROUND_WORK_CHANNEL, (_event, record) => {
    if (!applyTabBackgroundWorkRecord(record)) return;
    const tabId = String(record?.tabId || '').trim();
    const active = tabOwnBackgroundWorkBlocks(tabId);
    for (const listener of listeners) {
      try {
        listener({ tabId, active });
      } catch (error) {
        console.warn('[TabBackgroundWork] listener failed: ' + String(error?.message || error));
      }
    }
  });
  return channel;
}

/**
 * Read main's current counts for ONE tab. Used by a card that mounted while
 * work was already running: the channel carries transitions only, so without
 * this read the card would look idle until the last child exits.
 */
export function restoreTabOwnBackgroundWork(tabId) {
  const key = String(tabId || '').trim();
  if (!key) return Promise.resolve();
  const existing = tabRestores.get(key);
  if (existing) return existing;
  const channel = subscribeChannel();
  const restore = (channel
    ? channel.invoke('agent:list-background-work', { tabIds: [key] })
    : Promise.resolve(null)
  ).then((result) => {
    for (const record of result?.records || []) applyTabBackgroundWorkRecord(record);
  }).catch((error) => {
    // Unknown stays unknown: the live channel still supplies transitions, and
    // a failed read must not be remembered as "this tab is idle".
    tabRestores.delete(key);
    console.warn('[TabBackgroundWork] restore pending for ' + key + ': ' + String(error?.message || error));
  });
  tabRestores.set(key, restore);
  return restore;
}

export function initializeTabOwnBackgroundWork(tabIds = []) {
  const channel = subscribeChannel();
  if (!initializePromise) {
    const requested = [...new Set(tabIds.map((value) => String(value || '').trim()).filter(Boolean))];
    initializePromise = (channel && requested.length
      ? channel.invoke('agent:list-background-work', { tabIds: requested })
      : Promise.resolve(null)
    ).then((result) => {
      for (const record of result?.records || []) applyTabBackgroundWorkRecord(record);
    }).catch((error) => {
      // An unavailable read leaves every tab unknown rather than idle-by-default;
      // the live channel above still supplies the authoritative transitions.
      console.warn('[TabBackgroundWork] startup restore pending: ' + String(error?.message || error));
    });
  }
  return initializePromise;
}

// Test seam only: reset module state between cases.
export function resetTabOwnBackgroundWorkForTest() {
  counts.clear();
  revisions.clear();
  listeners.clear();
  tabRestores.clear();
  initializePromise = null;
  subscribed = false;
}
