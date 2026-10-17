const SCROLL_KEYS = new Set(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' ']);

// The editor owns its initial lazy-layout restore. Persist only the reader's
// subsequent scrolls, so a mount-time clamped offset cannot replace that target.
export function bindFilePaneReadingPosition({ scroller, path, save,
  schedule = callback => window.setTimeout(callback, 200),
  cancel = timer => window.clearTimeout(timer) }) {
  let readerOwnsScroll = false, pending = null, timer = null, disposed = false;
  const claim = () => { readerOwnsScroll = true; };
  const key = event => { if (SCROLL_KEYS.has(event.key)) claim(); };
  const flush = () => {
    if (timer !== null) cancel(timer);
    timer = null;
    const top = pending;
    pending = null;
    if (top !== null) save(path, top);
  };
  const scroll = () => {
    if (disposed || !readerOwnsScroll) return;
    pending = scroller.scrollTop;
    if (timer === null) timer = schedule(flush);
  };
  for (const name of ['wheel', 'touchstart', 'pointerdown']) scroller.addEventListener(name, claim, { capture: true, passive: true });
  scroller.addEventListener('keydown', key, true);
  scroller.addEventListener('scroll', scroll, { passive: true });
  return () => {
    if (disposed) return;
    disposed = true;
    for (const name of ['wheel', 'touchstart', 'pointerdown']) scroller.removeEventListener(name, claim, true);
    scroller.removeEventListener('keydown', key, true);
    scroller.removeEventListener('scroll', scroll);
    flush();
  };
}
