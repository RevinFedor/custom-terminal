function hasDefinitiveDraftState(state) {
  return state?.success === true
    && (state.hasDraft === true || state.hasDraft === false);
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

function createCodexDraftProofWaitTimeoutOutcome({ source } = {}) {
  return {
    success: false,
    hasDraft: null,
    preview: '',
    source: String(source || 'headless-main:unknown') + ':wait-timeout',
    error: 'codex-draft-proof-wait-timeout',
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
 * renderer probe is still useful as a conservative safety sensor: it may see
 * a positive composer state that the mirror has not classified yet. Renderer
 * absence or a negative renderer answer must never erase main-process proof.
 */
function mergeCodexDraftAuthority(headlessState, rendererState, {
  mergeRendererPositive = false,
} = {}) {
  if (hasDefinitiveDraftState(headlessState)) {
    if (
      headlessState.hasDraft === false
      && mergeRendererPositive === true
      && hasDefinitiveDraftState(rendererState)
      && rendererState.hasDraft === true
    ) {
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
  mergeCodexDraftAuthority,
  shouldFinishCodexDraftProofWait,
  shouldWaitForCodexDraftProof,
};
