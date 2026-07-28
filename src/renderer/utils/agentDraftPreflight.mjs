export function classifyAgentDraftPreflight(proof) {
  const outcome = proof?.proofOutcome;
  if (outcome === 'unknown') {
    return { decision: 'unknown', reason: proof?.proofReason || 'proof-outcome-unknown' };
  }
  if (proof?.hasDraft === true || outcome === 'found') {
    return { decision: 'conflict', reason: proof?.proofReason || 'draft-found' };
  }
  if (proof?.hasDraft === false || outcome === 'absent') {
    return { decision: 'clear', reason: proof?.proofReason || 'draft-absent' };
  }
  return { decision: 'unknown', reason: proof?.proofReason || 'draft-state-not-proven' };
}
