export function measureTerminalViewportIntersection({
  left,
  top,
  width,
  height,
  viewportWidth,
  viewportHeight,
} = {}) {
  const values = [left, top, width, height, viewportWidth, viewportHeight];
  if (!values.every((value) => typeof value === 'number' && Number.isFinite(value))) {
    return { right: null, bottom: null, intersectsViewport: false };
  }

  const [safeLeft, safeTop, safeWidth, safeHeight, safeViewportWidth, safeViewportHeight] = values;
  const right = safeLeft + safeWidth;
  const bottom = safeTop + safeHeight;
  return {
    right,
    bottom,
    intersectsViewport: safeWidth > 0
      && safeHeight > 0
      && safeViewportWidth > 0
      && safeViewportHeight > 0
      && right > 0
      && bottom > 0
      && safeLeft < safeViewportWidth
      && safeTop < safeViewportHeight,
  };
}
