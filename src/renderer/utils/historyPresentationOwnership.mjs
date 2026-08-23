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

/**
 * Resolves the one state transition shared by History's cold-loader gate and
 * Timeline's surface-presented gate. A DOM proof is useful only when it names
 * the exact owner generation AND the exact visible visit that is still on
 * screen. A mount-wave shell is not content: mounted-row proof must include at
 * least one real row, while an honest empty-state proof has no rows.
 *
 * Keeping this transition pure makes the important invariant testable without
 * a browser: publishing a valid painted surface cannot leave viewportPending
 * armed, and a later stable hide/show visit cannot re-arm it by itself.
 */
export function resolveHistoryViewportPaintProof({
  currentOwnerKey = '',
  currentGeneration = 0,
  currentPresentation = null,
  readyOwnerKey = '',
  proofRequired = true,
  ownerKey = '',
  generation = 0,
  presentationVisit = 0,
  proof = '',
  domRows = 0,
} = {}) {
  const previous = {
    readyOwnerKey,
    proofRequired: proofRequired === true,
  };
  const realRowPainted = proof === 'mounted-painted-row' && Number(domRows) > 0;
  const emptyStatePainted = proof === 'painted-empty-state' && Number(domRows) === 0;
  const exactOwner = ownerKey !== ''
    && ownerKey === currentOwnerKey
    && Number(generation) === Number(currentGeneration);
  const exactVisit = historyPresentationOwnsWrite(
    currentPresentation,
    presentationVisit,
  );
  if (!exactOwner || !exactVisit || (!realRowPainted && !emptyStatePainted)) {
    return {
      ...previous,
      accepted: false,
      changed: false,
    };
  }

  return {
    readyOwnerKey: ownerKey,
    proofRequired: false,
    accepted: true,
    changed: previous.readyOwnerKey !== ownerKey || previous.proofRequired,
  };
}
