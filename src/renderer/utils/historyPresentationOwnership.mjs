/**
 * A mounted History owner can move between presented and dormant without a
 * React unmount. `visit` versions that presentation lifetime so delayed DOM
 * work from the previous visible visit cannot commit after hide/show.
 */
export function createHistoryPresentationProof(presented = true) {
  const visible = presented === true;
  return {
    presented: visible,
    visit: visible ? 1 : 0,
    resumes: 0,
  };
}

export function advanceHistoryPresentationProof(previous, presented) {
  const visible = presented === true;
  const current = previous || createHistoryPresentationProof(visible);
  if (current.presented === visible) return current;
  return {
    presented: visible,
    visit: visible ? current.visit + 1 : current.visit,
    resumes: visible ? current.resumes + 1 : current.resumes,
  };
}

export function historyPresentationOwnsWrite(proof, capturedVisit) {
  return proof?.presented === true
    && Number(proof.visit) === Number(capturedVisit);
}

