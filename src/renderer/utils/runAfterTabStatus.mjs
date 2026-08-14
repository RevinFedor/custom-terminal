// What the "Run after" list says about ONE tab: is it working, waiting, or idle.
//
// Pulled out of the menu component because the menu is a portal that only
// exists while it is open — the rule was untestable in place, and it was wrong
// in a way nobody could see except by catching the app in the right moment.
//
// THE WRONG ANSWER IT USED TO GIVE. The menu knew about working tabs from ONE
// witness: the prompt-queue runner's map. That map deliberately DROPS signals
// which are not turn boundaries — spinner frames, local slash-commands —
// because they must never fire a queued prompt. Correct for deciding when to
// SEND something; wrong for deciding what to DRAW. A tab whose activity
// consisted only of dropped signals never entered that map, so the menu listed
// it as idle while the sidebar showed it working. Same tab, same moment, two
// different answers.
//
// So there are two witnesses now, and the order matters:
//   • the runner's map — precise about turns;
//   • the app-wide per-tab flag (tab.aiBusy) — kept current for every tab
//     regardless of what is on screen, and the one every other surface draws.
// Either one saying "working" is enough. Only the second can answer for a tab
// the first never heard about.

/**
 * @param {object} args
 * @param {string} args.tabId
 * @param {Map<string, boolean>} args.queueBusy     runner's per-tab map
 * @param {Set<string>} args.storeBusy              tabs marked working app-wide
 * @param {Set<string>} args.inheritedBusy          working because a linked tab is
 * @param {Set<string>|null} args.waiting           armed, waiting for its trigger
 * @param {Set<string>} args.selected               chosen as a trigger here
 * @returns {'busy'|'inherited'|'waiting'|'idle'}
 */
export function resolveRunAfterTabStatus({
  tabId,
  queueBusy,
  storeBusy,
  inheritedBusy,
  waiting,
  selected,
}) {
  const has = (set, id) => !!(set && typeof set.has === 'function' && set.has(id));
  const working = (queueBusy && queueBusy.get(tabId) === true) || has(storeBusy, tabId);

  if (working) return 'busy';
  if (has(inheritedBusy, tabId)) return 'inherited';
  if (has(waiting, tabId)) return 'waiting';
  // A tab picked as a trigger, that nobody has ever reported as working, is
  // waiting for its turn to come. `waiting` being present at all is what says
  // this list is showing an armed queue rather than a plain tab inventory.
  if (waiting && has(selected, tabId) && !(queueBusy && queueBusy.has(tabId)) && !has(storeBusy, tabId)) {
    return 'waiting';
  }
  return 'idle';
}
