// When may a tab's completion bell actually ring?
//
// "Turn ended" and "the work this tab promised is finished" are two different
// questions, and the bell answers the SECOND one. A tab that ends a turn while
// it still owes the user queued prompts (Run after) or a background
// orchestration has not finished anything the user asked to be told about —
// ringing there produces one notification per queue item instead of one per
// completed job.
//
// Deferring must never CLEAR the armed bell: the caller returns early and the
// bell stays armed for the next end-of-turn, which is the one that finds
// nothing pending and rings.
//
// Abnormal endings never defer. An error/stop/interrupt also disarms Run after
// (the DISARM contract in fact-prompt-queue.md), so a deferred bell would have
// no future turn to ring on and would go silent forever. Settling an abnormal
// outcome clears the bell without emitting — same as before this gate existed.

export function shouldDeferTabCompletionNotification({
  successful,
  orchestrationBlocked = false,
  queueContinuationPending = false,
  goalWork = null,
}) {
  if (successful && goalWork?.version === 1 && goalWork.pending === true) return 'native-goal-' + goalWork.phase;
  if (orchestrationBlocked) return 'orchestration-blocked';
  if (!successful) return null;
  if (queueContinuationPending) return 'queue-continuation-pending';
  return null;
}
