/**
 * Virtuoso can compensate an upward resize with native scrollBy while its
 * viewport stream still contains the pre-compensation position. Waiting for
 * the browser's next scroll event can paint an empty virtual range. Publish
 * the actual viewport after the size-observer batch, before that paint.
 * This is a notification only: it never writes scroll coordinates. Two cheap
 * position reads per batch avoid inventing a scroll event when nothing moved.
 */
export function createHistoryMeasurementViewportSync({
  getScroller,
  getOwnerToken,
  isSuppressed = () => false,
  scheduleMicrotask = queueMicrotask,
  onSync,
}) {
  let pending = null;
  return {
    schedule(measuredElement) {
      const scroller = getScroller();
      if (!scroller?.isConnected || !scroller.contains(measuredElement) || isSuppressed()) return false;
      const ownerToken = getOwnerToken();
      if (pending?.scroller === scroller && pending.ownerToken === ownerToken) return true;
      const ticket = { scroller, ownerToken, scrollTop: scroller.scrollTop };
      pending = ticket;
      scheduleMicrotask(() => {
        if (pending !== ticket) return;
        pending = null;
        if (!scroller.isConnected || getScroller() !== scroller
          || getOwnerToken() !== ownerToken || isSuppressed()) return;
        if (scroller.scrollTop === ticket.scrollTop) return;
        const ScrollEvent = scroller.ownerDocument?.defaultView?.Event || Event;
        // A real row may already have left overscan after its measurement.
        // The same live scroller/owner still needs the viewport publication.
        scroller.dispatchEvent(new ScrollEvent('scroll'));
        onSync?.();
      });
      return true;
    },
    cancel() { pending = null; },
  };
}
