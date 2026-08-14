export function resolveStableTerminalViewportOffsets({ floating, bottomInset }) {
  const inset = Number.isFinite(Number(bottomInset))
    ? Math.max(0, Number(bottomInset))
    : 0;

  // The History composer is a visual overlay, not terminal geometry. Keep the
  // xterm viewport (and therefore the PTY rows) stable for both the inline and
  // side-panel presentations; move the already-sized surface upward and let
  // the parent clip the part that leaves the viewport.
  return {
    top: 0,
    bottom: 0,
    translateY: inset > 0 ? -inset : 0,
  };
}
