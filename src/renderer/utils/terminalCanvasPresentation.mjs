// A live xterm has two independent presentation facts:
// - whether the user can currently see/interact with the terminal;
// - whether its already-rendered Canvas pixels should remain resident.
//
// Conflating them made a workflow switch put the full-screen Canvas through
// visibility:hidden -> visible and forced Chromium to paint it again. The
// outer tab boundary now owns user-visible opacity while this helper keeps the
// renderer layer resident without granting focus, pointer or ResizeObserver
// ownership to a hidden terminal.

export function resolveTerminalSurfacePresented({
  inPane = false,
  shownInPane = false,
  centerPresented = false,
  terminalPresented = true,
  appView = 'workspace',
} = {}) {
  if (appView !== 'workspace') return false;
  return inPane
    ? shownInPane
    : centerPresented && terminalPresented;
}

export function resolveTerminalCanvasVisible({
  effectivePresented = false,
  retainCanvasPixels = false,
  ready = false,
} = {}) {
  return effectivePresented || (retainCanvasPixels && ready);
}

export function shouldRepaintTerminalOnActivation({
  retainCanvasPixels = false,
  dimensionsChanged = false,
} = {}) {
  return !retainCanvasPixels || dimensionsChanged;
}

// xterm 5.5 keeps Viewport DOM synchronization separate from parsing/rendering.
// Retention uses opacity, so its offsetParent guard does not make this work idle.
// Coalesce only *new visual refresh requests*. A frame already admitted before
// hide may finish normally; no parser, buffer, onWriteParsed or render event is
// suppressed. The caller keeps initial calibration/prewarm admitted until ready.
export function retainXtermViewportPresentation(term, isPresented) {
  const viewport = term?._core?.viewport;
  const element = viewport?._viewportElement;
  const browser = viewport?._coreBrowserService?.window;
  if (!viewport || typeof viewport._refresh !== 'function'
    || typeof viewport._innerRefresh !== 'function'
    || typeof viewport.syncScrollArea !== 'function'
    || typeof viewport._handleScroll !== 'function'
    || !('_refreshAnimationFrame' in viewport)
    || typeof browser?.cancelAnimationFrame !== 'function'
    || typeof element?.addEventListener !== 'function'
    || typeof element?.removeEventListener !== 'function'
    || typeof term.loadAddon !== 'function') return null; // Unsupported shape: original behavior.

  const refresh = viewport._refresh;
  const innerRefresh = viewport._innerRefresh;
  let dirty = false, flushing = false, disposed = false;
  const cancelFrame = () => {
    if (viewport._refreshAnimationFrame !== null) {
      browser.cancelAnimationFrame(viewport._refreshAnimationFrame);
      viewport._refreshAnimationFrame = null;
    }
  };
  viewport._refresh = function refreshPresentedXtermViewport(immediate) {
    if (disposed) return;
    if (!flushing && !isPresented()) { dirty = true; return; }
    return refresh.call(this, immediate);
  };
  viewport._innerRefresh = function commitXtermViewportRefresh() {
    if (disposed) return;
    dirty = false;
    return innerRefresh.call(this);
  };
  const flush = (checkGeometry = false) => {
    if (disposed || (!dirty && !checkGeometry) || flushing) return;
    if (viewport._refreshAnimationFrame !== null) dirty = true;
    cancelFrame();
    flushing = true;
    try {
      // Keep upstream buffer/geometry bookkeeping. syncScrollArea can decide
      // nothing changed after it already recorded a deferred buffer length;
      // in that case the dirty visual projection still needs one real refresh.
      viewport.syncScrollArea(true);
      if (dirty) refresh.call(viewport, true);
      // Consume our programmatic-scroll acknowledgement now. A browser can
      // coalesce it with the first real wheel after reveal; leaving the ignore
      // flag armed would otherwise discard that user's first raw-terminal step.
      if (viewport._ignoreNextScrollEvent) viewport._handleScroll();
    } finally { flushing = false; }
  };
  // A queued/clamped/reparented DOM scroll must not feed the old pixel offset
  // back into a newer buffer. Reconcile before xterm's bound scroll listener;
  // keep that listener and its native compensation/scroll notifications intact.
  const reconcileScroll = () => { if (dirty) flush(); };
  element.addEventListener('scroll', reconcileScroll, true);
  term.loadAddon({
    activate() {},
    dispose() {
      disposed = true;
      dirty = false;
      cancelFrame();
      element.removeEventListener('scroll', reconcileScroll, true);
      // Keep closed guards on the retired instance: constructor/reset callbacks
      // can still arrive late. Never redirect them to a replacement terminal.
    },
  });
  return { sync() { if (!disposed && isPresented()) flush(true); } };
}
