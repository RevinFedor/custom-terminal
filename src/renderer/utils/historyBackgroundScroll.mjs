/** One native horizontal viewport. Input/measurements stay local to the strip;
 * this does not own transcript scroll, agent activity or Inspector selection. */
export function bindHistoryBackgroundScroll({ viewport, content, wheelHost, onEdges,
  createObserver = callback => new ResizeObserver(callback) }) {
  let previousLeft, previousRight, disposed = false;
  const measure = () => {
    if (disposed) return;
    const max = Math.max(0, viewport.scrollWidth - viewport.clientWidth);
    const left = viewport.scrollLeft > 1;
    const right = max - viewport.scrollLeft > 1;
    if (left !== previousLeft || right !== previousRight) {
      previousLeft = left; previousRight = right;
      onEdges({ left, right });
    }
  };
  const wheel = event => {
    if (disposed || event.ctrlKey) return;
    const horizontal = event.shiftKey || Math.abs(event.deltaX) >= Math.abs(event.deltaY);
    // The viewport handles native horizontal gestures. Edge buttons are its
    // siblings, so route those gestures to the viewport explicitly there.
    if (horizontal && viewport.contains(event.target)) return;
    const max = Math.max(0, viewport.scrollWidth - viewport.clientWidth);
    if (!max) return;
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewport.clientWidth : 1;
    const delta = horizontal && event.deltaX !== 0 ? event.deltaX : event.deltaY;
    const next = Math.max(0, Math.min(max, viewport.scrollLeft + delta * unit));
    if (next === viewport.scrollLeft) return;
    event.preventDefault(); event.stopPropagation();
    viewport.scrollLeft = next;
    measure();
  };
  const observer = createObserver(measure);
  observer.observe(viewport); observer.observe(content);
  viewport.addEventListener('scroll', measure);
  wheelHost.addEventListener('wheel', wheel, { passive: false });
  measure();
  return {
    step(direction) {
      if (disposed) return;
      const max = Math.max(0, viewport.scrollWidth - viewport.clientWidth);
      viewport.scrollLeft = Math.max(0, Math.min(max,
        viewport.scrollLeft + direction * Math.max(32, viewport.clientWidth * .8)));
      measure();
    },
    dispose() {
      disposed = true;
      observer.disconnect();
      viewport.removeEventListener('scroll', measure);
      wheelHost.removeEventListener('wheel', wheel);
    },
  };
}
