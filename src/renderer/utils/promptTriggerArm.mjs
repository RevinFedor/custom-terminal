// Does setting a card's condition also mean "start the queue"?
//
// Naming ANOTHER TAB as the condition is not a parameter edit — it is the whole
// promise: "send this after that tab finishes". There is nothing left to
// confirm, so the queue arms itself. Crucially this does not depend on whether
// the target is running right now: an idle target means "wait for its next run
// to start and then finish", exactly like a timer that has not elapsed yet.
// Treating "no loader" as "nothing to wait for" is what left the switch off and
// the hint red after the user had already stated the condition.
//
// Two deliberate asymmetries:
//
//  • A TIMER does not arm. It is a number the user is still typing, and the
//    field locks itself once the queue is armed and this card is next — arming
//    on commit would slam the field shut mid-edit. Choosing a tab has no such
//    editing phase: the pick IS the commit.
//
//  • Only the card that would fire NEXT arms the queue. Arming from a later
//    card would start the queue on the HEAD's terms — and a head with no
//    condition fires at the next end of turn, i.e. the user configures card #2
//    and card #1 goes out immediately. Consent covers the condition that was
//    just named, not somebody else's.
//
// Clearing a condition never arms (that is the opposite intent), and an
// already-armed queue simply stays armed.

export function shouldArmQueueForTrigger({ trigger, isHead }) {
  if (!isHead) return false;
  return trigger?.kind === 'onTab' && !!trigger.tabId;
}
