'use strict';

function imageCount(capture) {
  const explicit = Number(capture?.images);
  if (Number.isFinite(explicit) && explicit >= 0) return explicit;
  return Array.isArray(capture?.imagePaths) ? capture.imagePaths.length : 0;
}

function exactCaptureIdentityIsUsable(capture) {
  return capture?.success === true
    && capture?.editorReturnReady === true
    && capture?.terminalIdentityStable === true
    && typeof capture?.text === 'string'
    && Number.isFinite(Number(capture?.inputRevision))
    && Number.isFinite(Number(capture?.terminalRunSeq))
    && !!capture?.terminalLifecycleGeneration
    && !!capture?.mirrorGeneration;
}

function classifyClaudeFreshExactEmptyCapture(capture) {
  if (!exactCaptureIdentityIsUsable(capture)) {
    return {
      valid: false,
      composerDraftState: 'unknown',
      reason: capture?.error || 'claude_exact_composer_capture_unproven',
      draftPreserved: true,
    };
  }

  const images = imageCount(capture);
  const text = String(capture.text);
  if (text.trim() || images > 0) {
    return {
      valid: false,
      composerDraftState: images > 0 ? 'mixed-or-image-draft' : 'foreign-draft',
      reason: 'claude_existing_draft_before_paste',
      draftPreserved: true,
      textLength: text.length,
      images,
    };
  }

  if (
    capture.mirrorSynchronizedOutputOpen === true
    || !Number.isFinite(Number(capture.mirrorWriteSeq))
    || Number(capture.mirrorWriteSeq) !== Number(capture.mirrorFlushedSeq)
    || !Number.isFinite(Number(capture.synchronizedOutputGeneration))
  ) {
    return {
      valid: false,
      composerDraftState: 'unknown',
      reason: 'claude_exact_composer_capture_frame_unproven',
      draftPreserved: true,
    };
  }

  return {
    valid: true,
    composerDraftState: 'empty',
    reason: 'claude_exact_composer_empty_at_final_boundary',
    evidence: {
      ...capture,
      proofOutcome: 'absent',
      hasDraft: false,
      text: '',
      preview: '',
      proofReason: 'external-editor-empty-current-operation',
      inputRevisionTransition: 'ctrl-g-exact-capture',
      inputRevisionTransitionOwned: true,
    },
  };
}

function classifyClaudePostEnterOutcome({
  expectedText,
  capture,
  transcriptRead,
  acceptedResult = null,
  turnBusy = false,
} = {}) {
  if (acceptedResult?.success === true) {
    return {
      final: true,
      semanticStatus: 'accepted',
      providerAccepted: true,
      providerTurnCreated: true,
      lateReconciliationPending: false,
      acceptedResult,
    };
  }

  if (turnBusy === true) {
    return {
      final: false,
      semanticStatus: 'unknown',
      providerAccepted: null,
      providerTurnCreated: null,
      composerDraftState: 'not-inspected-active-turn',
      lateReconciliationPending: true,
      reason: 'claude_turn_still_active',
    };
  }

  if (!exactCaptureIdentityIsUsable(capture)) {
    return {
      final: false,
      semanticStatus: 'unknown',
      providerAccepted: null,
      providerTurnCreated: null,
      composerDraftState: 'unknown',
      lateReconciliationPending: true,
      reason: capture?.error || 'claude_post_enter_composer_unproven',
    };
  }

  const expected = typeof expectedText === 'string' ? expectedText : '';
  const actual = String(capture.text);
  const images = imageCount(capture);
  const exactOriginal = !!expected && images === 0 && actual === expected;
  const containsOriginal = !!expected && actual.includes(expected);
  const composerDraftState = images > 0
    ? 'mixed-or-image-draft'
    : exactOriginal
      ? 'exact-original'
      : !actual
        ? 'empty'
        : containsOriginal
          ? 'mixed-draft'
          : 'changed-draft';

  if (transcriptRead?.success !== true) {
    return {
      final: false,
      semanticStatus: 'unknown',
      providerAccepted: null,
      providerTurnCreated: null,
      composerDraftState,
      pasteObservedInComposer: exactOriginal || containsOriginal ? true : null,
      lateReconciliationPending: true,
      reason: transcriptRead?.error || 'claude_post_enter_transcript_unproven',
    };
  }

  const userRecordCount = Number(transcriptRead.userRecordCount || 0);
  if (userRecordCount > 0 || !exactOriginal) {
    return {
      final: false,
      semanticStatus: 'unknown',
      providerAccepted: null,
      providerTurnCreated: userRecordCount > 0 ? null : false,
      composerDraftState,
      pasteObservedInComposer: exactOriginal || containsOriginal ? true : null,
      lateReconciliationPending: true,
      reason: userRecordCount > 0
        ? 'claude_other_user_turn_after_boundary'
        : 'claude_post_enter_composer_not_exact_original',
    };
  }

  return {
    final: true,
    success: false,
    code: 'claude_prompt_not_accepted_exact_draft_remained',
    error: 'claude_prompt_not_accepted_exact_draft_remained',
    semanticStatus: 'not-submitted',
    providerAccepted: false,
    providerTurnCreated: false,
    composerDraftState: 'exact-original',
    pasteObservedInComposer: true,
    exactDraftRemained: true,
    draftPreserved: true,
    lateReconciliationPending: false,
  };
}

module.exports = {
  classifyClaudeFreshExactEmptyCapture,
  classifyClaudePostEnterOutcome,
  exactCaptureIdentityIsUsable,
};
