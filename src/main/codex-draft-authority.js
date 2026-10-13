const { rendererDraftFrameRejection } = require('../shared/codex-draft-frame-order.cjs');
const { agentInputObservationInvalidated } = require('../shared/agent-input-observation.cjs');

function hasDefinitiveDraftState(state) {
  return state?.success === true
    && (state.hasDraft === true || state.hasDraft === false);
}

// Different observations of one evolving screen are not themselves an
// incident. Suppress the heavy forensic capture only after the authority
// merge actually discarded an older same-generation sample and retained
// current main empty proof. Unknown ownership or a fresh disagreement stays
// diagnostic; this policy does not change draft protection or send results.
function isExpectedStaleCodexDraftObservation(headlessState, rendererState, result) {
  return hasDefinitiveDraftState(headlessState) && headlessState.hasDraft === false
    && hasDefinitiveDraftState(rendererState) && rendererState.hasDraft === true
    && result?.success === true && result.hasDraft === false
    && result.rendererPositiveIgnored === 'renderer-frame-behind'
    && rendererDraftFrameRejection(headlessState, rendererState) === 'renderer-frame-behind';
}

function shouldWaitForCodexDraftProof({
  initialHasDraft,
  expected,
  waitOnUnknownOnly = false,
} = {}) {
  if (initialHasDraft === expected) return false;
  if (waitOnUnknownOnly === true) return initialHasDraft === null;
  return true;
}

function shouldFinishCodexDraftProofWait({
  hasDraft,
  expected,
  waitOnUnknownOnly = false,
} = {}) {
  if (waitOnUnknownOnly === true) {
    return hasDraft === true || hasDraft === false;
  }
  return hasDraft === expected;
}

function createCodexDraftProofWaitTimeoutOutcome({ source, debug, frameBlocker, frameState } = {}) {
  return {
    success: false,
    hasDraft: null,
    preview: '',
    source: String(source || 'headless-main:unknown') + ':wait-timeout',
    error: 'codex-draft-proof-wait-timeout',
    ...(debug ? { debug } : {}),
    ...(frameBlocker ? { frameBlocker } : {}),
    ...(frameState ? { frameState: { ...frameState } } : {}),
  };
}

function getCodexDraftFrameBlocker({
  synchronizedOutputOpen = false,
  writeSeq = null,
  flushedSeq = null,
  pendingResizeWriteSeq = null,
} = {}) {
  if (synchronizedOutputOpen === true) return 'synchronized-output-open';

  const currentWriteSeq = writeSeq;
  const currentFlushedSeq = flushedSeq;
  if (
    !Number.isFinite(currentWriteSeq)
    || !Number.isFinite(currentFlushedSeq)
    || currentWriteSeq !== currentFlushedSeq
  ) return 'frame-not-flushed';

  if (pendingResizeWriteSeq !== null && pendingResizeWriteSeq !== undefined) {
    const resizeBoundary = pendingResizeWriteSeq;
    if (!Number.isFinite(resizeBoundary) || currentWriteSeq <= resizeBoundary) {
      return 'post-resize-frame-not-observed';
    }
  }

  return null;
}

function enforceCodexInteractiveSurfaceDraftAuthority(candidate, {
  nativeRewindProven = false,
  activePicker = false,
  preview = '',
} = {}) {
  if (nativeRewindProven !== true && activePicker !== true) return candidate;
  const surface = nativeRewindProven ? 'native-rewind-overlay' : 'active-picker';
  return {
    ...(candidate || {}),
    success: true,
    hasDraft: null,
    preview: String(preview || candidate?.preview || '').slice(0, 160),
    source: 'headless-main:' + surface,
    authority: 'non-composer-interactive-surface',
  };
}

/**
 * The headless terminal mirror is the durable draft authority. A fresh
 * renderer probe is still useful as a conservative safety sensor at the same
 * or a newer PTY boundary. A freshly requested read of an old renderer is not
 * a fresh frame: old picker rows must not override current main empty proof. Renderer
 * absence or a negative renderer answer must never erase main-process proof.
 */
function mergeCodexDraftAuthority(headlessState, rendererState, {
  mergeRendererPositive = false,
} = {}) {
  if (agentInputObservationInvalidated(headlessState)) {
    return { ...headlessState, success: false, hasDraft: null, preview: '', authority: 'unknown' };
  }
  if (hasDefinitiveDraftState(headlessState)) {
    if (
      headlessState.hasDraft === false
      && hasDefinitiveDraftState(rendererState)
      && rendererState.hasDraft === true
    ) {
      const frameRejection = rendererDraftFrameRejection(headlessState, rendererState);
      // The inner IPC read may request a renderer hint while main is unknown,
      // then recover current main-empty without enabling positive promotion.
      // Still retain WHY that older hint is ignored. Otherwise diagnostics
      // call ordinary catch-up a protected contradiction (tab34,100→141).
      if (frameRejection) return { ...headlessState, rendererPositiveIgnored: frameRejection };
      if (mergeRendererPositive !== true) return headlessState;
      return {
        ...headlessState,
        success: true,
        hasDraft: true,
        preview: rendererState.preview || headlessState.preview || '',
        source: String(headlessState.source || 'headless-main')
          + '+renderer-positive:'
          + String(rendererState.source || 'renderer'),
        rendererPositive: true,
      };
    }
    return headlessState;
  }

  if (hasDefinitiveDraftState(rendererState) && rendererState.hasDraft === true) {
    // Unknown current Main input is NOT empty. But a proven older screen is
    // not current positive evidence either (4196: transcript row5031 vs5132).
    // Keep unknown + the existing frame wake/deadline; never authorize paste
    // or trigger an unnecessary exact grab solely from this stale hint.
    if (rendererDraftFrameRejection(headlessState, rendererState) === 'renderer-frame-behind') {
      return { ...headlessState, success: false, hasDraft: null, preview: '',
        authority: 'unknown', rendererPositiveIgnored: 'renderer-frame-behind' };
    }
    return {
      ...rendererState,
      success: true,
      hasDraft: true,
      source: 'renderer-positive:' + String(rendererState.source || 'renderer'),
      authority: 'renderer-positive',
    };
  }

  // A renderer-only "empty" answer cannot authorize a PTY mutation. The
  // renderer may be unmounted, stale, or looking at a different frame; only
  // the main/headless mirror owns negative proof.
  return {
    ...(headlessState || rendererState || {}),
    success: false,
    hasDraft: null,
    preview: '',
    error: headlessState?.error || 'headless-draft-state-unavailable',
    source: String(headlessState?.source || 'headless-unavailable')
      + '+renderer-negative-untrusted:'
      + String(rendererState?.source || 'renderer-unavailable'),
    authority: 'unknown',
  };
}

module.exports = {
  createCodexDraftProofWaitTimeoutOutcome,
  enforceCodexInteractiveSurfaceDraftAuthority,
  getCodexDraftFrameBlocker,
  hasDefinitiveDraftState,
  isExpectedStaleCodexDraftObservation,
  mergeCodexDraftAuthority,
  shouldFinishCodexDraftProofWait,
  shouldWaitForCodexDraftProof,
};
