/**
 * Pixel box of a pane's heavy content relative to its movable outer wrapper.
 *
 * During divider drag the wrapper follows the pointer, while this box remains
 * fixed until release. Keeping the arithmetic pure makes sub-pixel offsets and
 * invalid/zero geometry testable without mounting the Electron renderer.
 */
export function paneResizeFreezeBox(wrapperRect, contentRect) {
  const values = [
    wrapperRect?.left,
    wrapperRect?.top,
    contentRect?.left,
    contentRect?.top,
    contentRect?.width,
    contentRect?.height,
  ];
  if (!values.every(Number.isFinite)) return null;
  if (contentRect.width <= 0 || contentRect.height <= 0) return null;
  const left = contentRect.left - wrapperRect.left;
  const top = contentRect.top - wrapperRect.top;
  if (!Number.isFinite(left) || !Number.isFinite(top)) return null;
  return { left, top, width: contentRect.width, height: contentRect.height };
}
