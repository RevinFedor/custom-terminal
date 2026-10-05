/** A clicked child can disappear outside its hover parent's bounds. Preserve
 * one return trip, not focus or pin: entering the parent restores normal leave. */
export function createHoverReturnGate() {
  let clicked = null;
  let returning = false;
  return {
    capture(element) { clicked = element; },
    settle(element) {
      if (clicked !== element) return;
      if (!element.isConnected) returning = true;
      clicked = null;
    },
    reset() { clicked = null; returning = false; },
    holds(point, insideParent) {
      if (!point || insideParent) { this.reset(); return false; }
      if (clicked && !clicked.isConnected) { clicked = null; returning = true; }
      return returning;
    },
  };
}

/** Capture before the click handler unmounts its portal. Owner IDs keep other
 * queues/menus out; an ordinary click inside the parent grants no return trip. */
export function captureQueueHoverReturn(event, root, gate) {
  const satellite = event.target?.closest?.('[data-run-after-hover-owner]');
  if (!root || !satellite || root.contains(satellite)) return;
  const rect = root.getBoundingClientRect();
  if (event.clientX >= rect.left && event.clientX <= rect.right
    && event.clientY >= rect.top && event.clientY <= rect.bottom) return;
  const owner = satellite.dataset.runAfterHoverOwner;
  if (!owner) return;
  const owns = root.dataset.promptQueueHoverOwner === owner
    || Array.from(root.querySelectorAll('[data-prompt-queue-hover-owner]'))
      .some(element => element.dataset.promptQueueHoverOwner === owner);
  if (owns) {
    gate.capture(satellite);
    // Inspect this click's commit once. A filter click that kept its popup
    // open must not grant a return trip for a later Escape/dismissal.
    requestAnimationFrame(() => gate.settle(satellite));
  }
}
