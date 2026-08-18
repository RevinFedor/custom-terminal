// Где рисовать кнопки запуска, пока во вкладке ничего не запущено.
//
// The six launches already exist, once, inside ClaudeControlBar — together with
// everything that makes them safe: the lifecycle guard that refuses a second
// launch into the same terminal, the auto-title marking, the Codex writer
// preconditions, the busy overlay. A second set of buttons that "just runs the
// same command" would be a second launcher, and it would drift from that one the
// first time any of those rules changes.
//
// So the buttons do not move — their OUTPUT does. While the tab is empty, the
// terminal publishes a node in the middle of itself and the bar draws its launch
// strip there instead of in the corner. Exactly the pattern the composer already
// uses for the whole control bar (composerControlsHost.mjs), for exactly the
// same reason: a portal changes the DOM position, not the tree position, so the
// component's state and effects are untouched.
//
// Юзер: *«кнопки… тогда переносите вниз, если у меня ничего нет — это будет
// более логично»*. In an empty tab they are the only thing to do, and they were
// the smallest thing on screen.

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
 * Publish (or withdraw) the node the launch strip should be drawn into.
 * @param {string} tabId
 * @param {Element|null} node
 */
export function setEmptyTabLaunchHost(tabId, node) {
  if (!tabId) return;
  const current = hosts.get(tabId) || null;
  const next = node || null;
  if (current === next) return;
  if (next) hosts.set(tabId, next);
  else hosts.delete(tabId);
  notify(tabId);
}

/**
 * Withdraw a slot ONLY if it is still the published one — the same ordering trap
 * the composer host documents: on a layout rebuild React mounts the new host
 * before unmounting the old one, and a cleanup keyed by tab id alone would erase
 * the slot that has just been published.
 *
 * @param {string} tabId
 * @param {Element|null} node the node this caller published
 */
export function releaseEmptyTabLaunchHost(tabId, node) {
  if (!tabId || !node) return;
  if ((hosts.get(tabId) || null) !== node) return;
  hosts.delete(tabId);
  notify(tabId);
}

/** @param {string} tabId @returns {Element|null} */
export function getEmptyTabLaunchHost(tabId) {
  if (!tabId) return null;
  return hosts.get(tabId) || null;
}

/**
 * Subscribe to host changes for one tab. Returns an unsubscribe function.
 * @param {string} tabId
 * @param {(node: Element|null) => void} listener
 * @returns {() => void}
 */
export function subscribeEmptyTabLaunchHost(tabId, listener) {
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
