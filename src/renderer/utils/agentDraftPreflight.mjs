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

export function buildExactDraftCaptureProof(proof, rendererDiagnostic = null) {
  return {
    hasDraft: proof?.hasDraft,
    proofOutcome: proof?.proofOutcome,
    proofReason: proof?.proofReason,
    exactCaptureRecommended: proof?.exactCaptureRecommended === true,
    source: proof?.source,
    promptRow: proof?.promptRow,
    cursorRow: proof?.cursorRow,
    cursorX: proof?.cursorX,
    occupiedEndX: proof?.occupiedEndX,
    terminalRunSeq: proof?.terminalRunSeq,
    inputRevision: proof?.inputRevision,
    terminalLifecycleGeneration: proof?.terminalLifecycleGeneration,
    mirrorGeneration: proof?.mirrorGeneration,
    mirrorWriteSeq: proof?.mirrorWriteSeq,
    mirrorFlushedSeq: proof?.mirrorFlushedSeq,
    mirrorSynchronizedOutputOpen: proof?.mirrorSynchronizedOutputOpen,
    synchronizedOutputGeneration: proof?.synchronizedOutputGeneration,
    rendererDiagnostic: rendererDiagnostic && typeof rendererDiagnostic === 'object'
      ? rendererDiagnostic
      : null,
  };
}

export function classifyExactEmptyDraftGrab(proof, grabbed) {
  if (grabbed?.success !== true) {
    return { confirmed: false, reason: grabbed?.error || 'grab-failed' };
  }
  if (grabbed?.proofOutcome !== 'absent' || grabbed?.terminalIdentityStable !== true) {
    return { confirmed: false, reason: grabbed?.proofReason || 'grab-empty-not-proven' };
  }
  if (grabbed?.editorReturnReady !== true) {
    return { confirmed: false, reason: grabbed?.editorReturnReason || 'editor-return-unconfirmed' };
  }
  if (String(grabbed?.text || '').trim() || Number(grabbed?.images || 0) > 0) {
    return { confirmed: false, reason: 'grab-returned-draft' };
  }
  const identityFields = [
    'terminalRunSeq',
    'terminalLifecycleGeneration',
    'mirrorGeneration',
  ];
  for (const field of identityFields) {
    if (proof?.[field] === null || proof?.[field] === undefined) {
      return { confirmed: false, reason: 'screen-proof-identity-missing:' + field };
    }
    if (grabbed?.[field] !== proof[field]) {
      return { confirmed: false, reason: 'screen-grab-identity-mismatch:' + field };
    }
  }
  if (
    grabbed?.screenContradiction !== true
    || grabbed?.inputRevisionTransition !== 'ctrl-g-exact-capture'
    || grabbed?.inputRevisionTransitionOwned !== true
  ) {
    return { confirmed: false, reason: 'screen-grab-input-transition-unproven' };
  }
  if (
    proof?.inputRevision === null
    || proof?.inputRevision === undefined
    || grabbed?.screenProofInputRevision !== proof.inputRevision
  ) {
    return { confirmed: false, reason: 'screen-grab-identity-mismatch:screenProofInputRevision' };
  }
  if (
    !Number.isFinite(Number(proof.inputRevision))
    || Number(grabbed?.inputRevision) !== Number(proof.inputRevision) + 1
  ) {
    return { confirmed: false, reason: 'screen-grab-identity-mismatch:inputRevision' };
  }
  return { confirmed: true, reason: 'exact-empty-grab-owned-input-transition' };
}

export function resolveAgentDraftConflict(proof, captured, { attemptedCapture = false } = {}) {
  if (attemptedCapture && captured?.success === false) {
    return {
      decision: 'capture-failed',
      error: captured.error || 'terminal draft could not be inspected exactly',
      draftText: '',
      draftImages: 0,
    };
  }

  const draftText = typeof captured?.text === 'string' ? captured.text : '';
  const draftImages = Number(captured?.images || 0);
  const emptyProof = attemptedCapture
    ? classifyExactEmptyDraftGrab(proof, captured)
    : { confirmed: false, reason: 'exact-grab-not-attempted' };

  return {
    decision: emptyProof.confirmed === true ? 'clear' : 'conflict',
    reason: emptyProof.reason,
    draftText,
    draftImages,
  };
}

/**
 * Carry the exact capture verdict forward into the final send decision.
 *
 * The screen proof may start as `unknown` and then be resolved by an exact,
 * same-lifecycle exact input capture. Ctrl+G itself owns one input-revision
 * transition, so the main process must attest that exact causal step rather
 * than pretending the revision stayed unchanged. Once the capture proves the
 * composer
 * empty, callers must not fall through to the stale original `unknown` verdict.
 */
export function applyAgentDraftCaptureResolution(initialDecision, captureResolution) {
  if (captureResolution?.decision === 'clear') {
    return {
      decision: 'clear',
      reason: captureResolution.reason || 'exact-capture-cleared',
    };
  }
  return initialDecision;
}
