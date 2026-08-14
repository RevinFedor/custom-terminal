// Clearing a queue item's trigger (the ✕ next to it): does Run after stay on?
//
// The trigger answers "WHEN does this item fire". Run after answers "does the
// queue fire at all". Two different questions — except in one case, and that
// case is why the ✕ needed a rule of its own.
//
// When the queue holds exactly ONE runnable item and that item's trigger is
// removed, the two questions collapse: there is nothing left with a condition to
// wait for, so leaving Run after armed means the queue is "on" with no answer to
// when — and it would fire on the next plain turn end, which is not what removing
// a condition asks for. With two or more items the queue still has a plan, so the
// switch must not be touched: turning it off there would silently disarm work the
// user never mentioned.
//
// Note what is deliberately NOT part of the count: the trigger of the item being
// cleared, and whether the FIRST item had one. The user's rule was explicit —
// «если два пункта и первый без таймера, то Run after продолжает работать как
// работал» — i.e. only the number of runnable items decides.

/**
 * @param {object} args
 * @param {number} args.runnableCount how many enabled (non-done) items the queue holds
 * @returns {boolean} true when Run after should be switched off
 */
export function shouldDisarmAfterTriggerClear({ runnableCount }) {
  const count = Number(runnableCount);
  if (!Number.isFinite(count)) return false;
  return count <= 1;
}
