// Where the agent's controls are drawn — one place, published by the composer.
//
// The controls themselves stay in `ClaudeControlBar`, mounted exactly where it
// has always been mounted. Months of behaviour live in that component: busy
// state bound to a tab, settings reconstructed from the transcript, the cache
// channel, the Codex writer proofs. Moving that code into the composer would
// re-open a stack of already-fixed bugs, and it would also break the component's
// defining property — it is mounted ONCE per project and rebound by changing
// `tabId`, never remounted per tab.
//
// So the component does not move; only its OUTPUT does. The composer publishes
// an empty node and says "draw here", and the bar renders into it through a
// portal. React keeps the component's state and effects untouched — a portal
// changes the DOM position, not the tree position.
//
// Why a registry instead of `document.getElementById`:
// an id lookup inside an effect answers "what existed at that moment". The
// composer's node is replaced when the panel swaps its layout, and the lookup
// would keep pointing at the detached one — the controls would silently render
// into a node nobody can see. Here the composer PUBLISHES its node and the bar
// is told; nothing is polled and nothing is timed.

/** @type {Map<string, Element|null>} */
const hosts = new Map();
/** @type {Map<string, Set<(node: Element|null) => void>>} */
const listeners = new Map();

const notify = (tabId) => {
  const subs = listeners.get(tabId);
  if (!subs) return;
  const node = hosts.get(tabId) || null;
  for (const fn of subs) fn(node);
};

/**
 * Publish (or withdraw) the node the controls should be drawn into.
 * Pass null on unmount so the bar falls back to its own place immediately,
 * rather than drawing into a detached node.
 *
 * @param {string} tabId
 * @param {Element|null} node
 */
export function setComposerControlsHost(tabId, node) {
  if (!tabId) return;
  const current = hosts.get(tabId) || null;
  const next = node || null;
  if (current === next) return;
  if (next) hosts.set(tabId, next);
  else hosts.delete(tabId);
  notify(tabId);
}

/**
 * Withdraw a slot ONLY if it is still the published one.
 *
 * The ordering trap this exists for: when the layout is rebuilt (entering or
 * leaving a split, swapping which surface is primary), React mounts the new
 * composer BEFORE unmounting the old one. A cleanup that clears by tab id alone
 * then erases the slot the new composer has just published — and the controls
 * fall back to the strip under the terminal for good, because nothing publishes
 * again. Measured live: the slot was on screen, empty, while the bar rendered in
 * its old place.
 *
 * @param {string} tabId
 * @param {Element|null} node the node this caller published
 */
export function releaseComposerControlsHost(tabId, node) {
  if (!tabId || !node) return;
  if ((hosts.get(tabId) || null) !== node) return;
  hosts.delete(tabId);
  notify(tabId);
}

/**
 * Current host for a tab, or null when its composer is not on screen.
 * @param {string} tabId
 * @returns {Element|null}
 */
export function getComposerControlsHost(tabId) {
  if (!tabId) return null;
  return hosts.get(tabId) || null;
}

/**
 * Subscribe to host changes for one tab. Returns an unsubscribe function.
 *
 * @param {string} tabId
 * @param {(node: Element|null) => void} listener
 * @returns {() => void}
 */
export function subscribeComposerControlsHost(tabId, listener) {
  if (!tabId || typeof listener !== 'function') return () => {};
  let subs = listeners.get(tabId);
  if (!subs) {
    subs = new Set();
    listeners.set(tabId, subs);
  }
  subs.add(listener);
  return () => {
    const current = listeners.get(tabId);
    if (!current) return;
    current.delete(listener);
    if (current.size === 0) listeners.delete(tabId);
  };
}
