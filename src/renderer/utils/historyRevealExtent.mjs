/**
 * A growing list must not temporarily lose its existing scroll range.
 * Virtuoso changes index-addressed sizes over several commits when a group
 * inserts rows. A short intermediate tail clamps scrollTop BEFORE any anchor
 * writer can restore it. Keep only the already-visible physical extent until
 * the new DOM sizes have reached the list's measurement attributes.
 *
 * This does not add collapse space or steer scrollTop. The guard sits outside
 * the measured list, so it cannot hide a list resize from ResizeObserver.
 */
export function holdHistoryRevealExtent({
  scroller,
  isCommitted,
  isCurrent = () => true,
  onFinish,
} = {}) {
  const viewport = scroller?.querySelector('[data-viewport-type="element"]');
  const list = viewport?.querySelector('[data-testid="virtuoso-item-list"]');
  if (!viewport || !list) return () => {};

  const extent = Math.ceil(scroller.scrollTop + scroller.clientHeight);
  const guard = scroller.ownerDocument.createElement('div');
  guard.setAttribute('data-history-reveal-extent', String(extent));
  guard.setAttribute('aria-hidden', 'true');
  Object.assign(guard.style, {
    position: 'absolute', top: `${Math.max(0, extent - 1)}px`,
    width: '1px', height: '1px', visibility: 'hidden', pointerEvents: 'none',
  });
  viewport.appendChild(guard);

  let finished = false;
  let queued = false;
  const view = scroller.ownerDocument.defaultView;
  const finish = (reason = 'cancelled') => {
    if (finished) return;
    finished = true;
    resizeObserver.disconnect();
    mutationObserver.disconnect();
    scroller.removeEventListener('wheel', cancelForInput, true);
    scroller.removeEventListener('touchmove', cancelForInput, true);
    scroller.removeEventListener('pointerdown', cancelForInput, true);
    scroller.removeEventListener('keydown', cancelForInput, true);
    guard.remove();
    onFinish?.({ reason, extent });
  };
  const cancelForInput = () => finish('user-input');
  const check = () => {
    queued = false;
    if (finished) return;
    if (!scroller.isConnected || !isCurrent()) { finish('stale-owner'); return; }
    if (!isCommitted()) return;

    // Reading scrollHeight here would count our own guard as proof. Measure
    // the actual list/header/footer instead, in the viewport's coordinates.
    const viewportTop = viewport.getBoundingClientRect().top;
    const naturalExtent = Math.max(0, ...Array.from(viewport.children)
      .filter((child) => !child.hasAttribute('data-history-reveal-extent'))
      .map((child) => child.getBoundingClientRect().bottom - viewportTop));
    if (Math.ceil(naturalExtent) < extent) return;
    const rows = Array.from(list.children).filter((row) => row.hasAttribute('data-index'));
    if (!rows.length || rows.some((row) => {
      const known = Number(row.getAttribute('data-known-size'));
      const actual = Math.round(row.getBoundingClientRect().height);
      return !Number.isFinite(known) || actual <= 0 || Math.abs(actual - known) > 1;
    })) return;
    finish('measured');
  };
  const scheduleCheck = () => {
    if (finished || queued) return;
    queued = true;
    queueMicrotask(check);
  };
  const resizeObserver = new view.ResizeObserver(scheduleCheck);
  for (const child of viewport.children) if (child !== guard) resizeObserver.observe(child);
  const mutationObserver = new view.MutationObserver(scheduleCheck);
  mutationObserver.observe(viewport, {
    subtree: true, childList: true, attributes: true,
    attributeFilter: ['data-known-size', 'data-index', 'aria-expanded', 'style'],
  });
  for (const type of ['wheel', 'touchmove', 'pointerdown', 'keydown']) {
    scroller.addEventListener(type, cancelForInput, { capture: true, passive: true });
  }
  scheduleCheck();
  return finish;
}
