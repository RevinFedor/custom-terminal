import frameOrder from '../../shared/codex-draft-frame-order.cjs';
const { rendererDraftFrameRejection } = frameOrder;

function isDefinitiveDraftValue(value) {
  return value === true || value === false;
}

function normalizeVisualState(visualState) {
  return {
    hasDraft: isDefinitiveDraftValue(visualState?.hasDraft)
      ? visualState.hasDraft
      : null,
    source: String(visualState?.source || 'unavailable'),
    preview: String(visualState?.preview || ''),
    debug: String(visualState?.debug || ''),
    frameIdentity: visualState?.frameIdentity,
  };
}

/**
 * The main/headless mirror owns the negative proof ("the composer is empty").
 * A mounted renderer xterm may add a positive safety signal, but its absence
 * must never disable History-primary controls and a renderer-only empty frame
 * must never authorize a destructive picker/send operation.
 */
export function resolveCodexDraftAuthority(mainState, visualState) {
  const visual = normalizeVisualState(visualState);
  const mainHasDraft = mainState?.success === true
    && isDefinitiveDraftValue(mainState?.hasDraft)
    ? mainState.hasDraft
    : null;

  if (mainHasDraft !== null) {
    // If a mounted renderer sees text that the headless mirror missed, retain
    // the text instead of opening a native picker over it. Renderer absence or
    // a renderer "empty" result cannot veto a definitive main-owned result.
    const frameRejection = mainHasDraft === false && visual.hasDraft === true
      ? rendererDraftFrameRejection(mainState, visual) : null;
    const visualPositive = visual.hasDraft === true && !frameRejection;
    const hasDraft = mainHasDraft === true || visualPositive;
    return {
      ...(mainState || {}),
      success: true,
      hasDraft,
      preview: hasDraft && visualPositive
        ? visual.preview
        : String(mainState?.preview || ''),
      source: visualPositive && mainHasDraft === false
        ? String(mainState?.source || 'main') + '+visual-positive:' + visual.source
        : String(mainState?.source || 'main'),
      authority: visualPositive && mainHasDraft === false
        ? 'main-plus-visual-positive'
        : 'main',
      visualHasDraft: visual.hasDraft,
      visualSource: visual.source,
      visualPreview: visual.preview,
      visualDebug: visual.debug,
      ...(frameRejection ? { rendererPositiveIgnored: frameRejection } : {}),
    };
  }

  // A positive visual signal is safe additional evidence: it only causes the
  // draft-preserving path. Visual "empty" alone is insufficient because a
  // hidden/unmounted renderer is not the owner of PTY state.
  if (visual.hasDraft === true) {
    return {
      ...(mainState || {}),
      success: true,
      hasDraft: true,
      preview: visual.preview,
      source: 'visual-positive:' + visual.source,
      authority: 'visual-positive',
      visualHasDraft: true,
      visualSource: visual.source,
      visualPreview: visual.preview,
      visualDebug: visual.debug,
    };
  }

  return {
    ...(mainState || {}),
    success: mainState?.success === true,
    hasDraft: null,
    preview: String(mainState?.preview || ''),
    source: String(mainState?.source || 'main-unavailable'),
    authority: 'unknown',
    visualHasDraft: visual.hasDraft,
    visualSource: visual.source,
    visualPreview: visual.preview,
    visualDebug: visual.debug,
  };
}

export async function readCodexDraftAuthority({
  invoke,
  tabId,
  reason,
  timeoutMs = 700,
  waitFor,
  waitTimeoutMs,
  waitOnUnknownOnly = false,
  visualState,
}) {
  let mainState;
  try {
    mainState = await invoke('codex:get-draft-state', tabId, {
      reason,
      timeoutMs,
      ...(typeof waitFor === 'boolean' ? { waitFor } : {}),
      ...(Number.isFinite(Number(waitTimeoutMs))
        ? { waitTimeoutMs: Number(waitTimeoutMs) }
        : {}),
      ...(waitOnUnknownOnly === true ? { waitOnUnknownOnly: true } : {}),
      ...(visualState?.hasDraft === true ? { visualState: {
        hasDraft: true,
        source: String(visualState.source || 'renderer'),
        preview: String(visualState.preview || '').slice(0, 180),
        frameIdentity: visualState.frameIdentity || null,
      } } : {}),
    });
  } catch (error) {
    mainState = {
      success: false,
      hasDraft: null,
      preview: '',
      source: 'main-ipc-error',
      error: String(error?.message || error),
    };
  }
  return resolveCodexDraftAuthority(mainState, visualState);
}
