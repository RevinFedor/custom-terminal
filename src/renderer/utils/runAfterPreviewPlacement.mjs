/**
 * Resolve the fixed-position card used to preview Run after composer tokens.
 *
 * `anchor.right` is the editor's CSS `right` offset. Keeping this calculation
 * outside React makes both layout branches testable without a browser resize:
 * a card sits to the left when the usable side strip is wide enough, otherwise
 * it shares the editor's left edge and starts below it.
 */
export function resolveRunAfterPreviewPlacement({
  viewport,
  anchor,
  editorWidth,
  editorHeight,
  margin,
  gap,
  maxWidth,
  minSideWidth,
  minPreviewWidth,
  minPreviewHeight,
}) {
  const availableLeft = viewport.width
    - anchor.right
    - editorWidth
    - gap
    - margin;
  const beside = availableLeft >= minSideWidth;
  const availableWidth = beside
    ? availableLeft
    : viewport.width - anchor.right - margin;
  const width = Math.max(
    minPreviewWidth,
    Math.min(maxWidth, editorWidth, availableWidth),
  );
  const top = beside
    ? anchor.top
    : anchor.top + editorHeight + gap;
  const right = beside
    ? anchor.right + editorWidth + gap
    : anchor.right;
  const maxHeight = beside
    ? anchor.maxHeight
    : Math.max(minPreviewHeight, viewport.height - top - margin);

  return {
    placement: beside ? 'left' : 'below',
    availableLeft,
    width,
    top,
    right,
    maxHeight,
  };
}
