export const TERMINAL_FULL_VIEW_REQUEST = 'noted:terminal-full-view-request';

// A view lease, not a second terminal or lifecycle owner.
let activeView = null;
export function acquireTerminalFullView(close) {
  activeView?.close();
  const lease = { close };
  activeView = lease;
  return () => { if (activeView === lease) activeView = null; };
}

export function requestTerminalFullView(element, tabId) {
  element?.dispatchEvent(new CustomEvent(TERMINAL_FULL_VIEW_REQUEST, {
    bubbles: true, detail: { tabId },
  }));
}

// Chromium may clear native scroll offsets when a connected subtree moves.
// xterm's buffer.viewportY can stay unchanged, so a no-op scrollToLine cannot
// repair that mismatch. Keep native offsets across this synchronous move.
export function preserveTerminalViewportScroll(host, relocate) {
  const positions = Array.from(host.querySelectorAll('.xterm-viewport'), node => ({
    node, top: node.scrollTop, left: node.scrollLeft,
  }));
  try { return relocate(); }
  finally {
    for (const { node, top, left } of positions) {
      if (node.isConnected === false) continue;
      node.scrollTop = top;
      node.scrollLeft = left;
    }
  }
}

// Reveal an existing rectangle, do not maximize or fit its terminal grid.
// Only the surrounding scroll viewport may be smaller on a small app window.
export function resolveTerminalLiftGeometry(rect, bounds) {
  const width = Math.max(1, rect.width);
  const height = Math.max(1, rect.height);
  const viewportWidth = Math.min(width, Math.max(1, bounds.right - bounds.left));
  const viewportHeight = Math.min(height, Math.max(1, bounds.bottom - bounds.top));
  return {
    width, height, viewportWidth, viewportHeight,
    left: Math.max(bounds.left, Math.min(rect.left, bounds.right - viewportWidth)),
    top: Math.max(bounds.top, Math.min(rect.top, bounds.bottom - viewportHeight)),
  };
}
