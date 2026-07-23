function hasDefinitiveDraftState(state) {
  return state?.success === true
    && (state.hasDraft === true || state.hasDraft === false);
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
  enforceCodexInteractiveSurfaceDraftAuthority,
  hasDefinitiveDraftState,
  mergeCodexDraftAuthority,
};
