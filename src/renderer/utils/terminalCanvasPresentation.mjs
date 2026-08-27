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
