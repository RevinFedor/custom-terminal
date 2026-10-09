import { stabilizeHistoryRevealAnchor } from './historyRevealAnchor.mjs';

/** Correct only late resize compensation AFTER a collapse's legal native
 * clamp. Reuse History's existing semantic-anchor convergence/gesture owner;
 * never force every collapse to the tail or manufacture footer space. */
export function createHistoryCardRevealAnchor({
  getScroller, getOwnerToken, getGestureGeneration, isPointerGestureActive = () => false,
  isPresented = () => true, isSuppressed = () => false, stabilize = stabilizeHistoryRevealAnchor,
}) {
  let cancel = null;
  const stop = () => { const previous = cancel; cancel = null; previous?.(); };
  return {
    afterCommit(anchor, opening, onFinish) {
      stop();
      const scroller = getScroller();
      if (opening || !isPresented() || isSuppressed() || !scroller?.isConnected || !anchor?.isConnected
        || !scroller.contains(anchor)) return;
      const owner = getOwnerToken(), gesture = getGestureGeneration();
      // A shrink can already have clamped scrollTop to its new valid maximum.
      // Preserve THIS post-commit position, not an impossible pre-collapse
      // coordinate; the later Virtuoso subtract must not compensate it again.
      const targetTop = anchor.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
      cancel = stabilize({
        targetTop,
        readAnchorTop: () => anchor.isConnected && scroller.contains(anchor)
          ? anchor.getBoundingClientRect().top - scroller.getBoundingClientRect().top : null,
        adjustScrollBy: delta => { scroller.scrollTop += delta; },
        subscribePositionChange: listener => {
          scroller.addEventListener('scroll', listener, { capture: true, passive: true });
          return () => scroller.removeEventListener('scroll', listener, true);
        },
        isCurrent: () => isPresented() && !isSuppressed() && scroller.isConnected && getScroller() === scroller
          && getOwnerToken() === owner,
        hasUserGesture: () => isPointerGestureActive() || getGestureGeneration() !== gesture,
        onFinish,
      });
    },
    cancel: stop,
  };
}
