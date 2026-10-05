// An upward wheel must suspend follow before the browser scrolls. It is not
// yet proof that History moved: native edge/momentum or a consumed wheel may
// leave it exactly at the same bottom. Undo only that provisional suspension,
// after two frames with unchanged geometry and unchanged position ownership.
export function createHistoryWheelTailIntent({
  getScroller,
  getOwnerToken,
  getIntentRevision,
  setFollowIntent,
  onResolved = () => {},
  requestFrame = globalThis.requestAnimationFrame,
  cancelFrame = globalThis.cancelAnimationFrame,
}) {
  let pending = null;
  let frame = null;
  const geometry = (scroller) => ({
    top: scroller.scrollTop,
    height: scroller.scrollHeight,
    client: scroller.clientHeight,
  });
  const rejection = (probe) => {
    if (getScroller() !== probe.scroller || getOwnerToken() !== probe.owner) return 'owner-changed';
    if (getIntentRevision() !== probe.revision) return 'intent-changed';
    const current = geometry(probe.scroller);
    if (current.top !== probe.top) return 'moved';
    if (current.height !== probe.height || current.client !== probe.client) return 'resized';
    return null;
  };
  const cancel = () => {
    if (frame !== null) cancelFrame?.(frame);
    frame = null;
    pending = null;
  };
  const suspend = ({ following }) => {
    const scroller = getScroller();
    const previousStillOwns = pending !== null && rejection(pending) === null;
    cancel();
    if (!following && !previousStillOwns) {
      setFollowIntent(false);
      return;
    }
    const before = scroller ? geometry(scroller) : null;
    // Use subpixel rounding tolerance, NOT the ordinary 4px bottom threshold:
    // a real one-pixel upward scroll still belongs to the reader.
    const eligible = before
      && Math.abs(before.height - before.top - before.client) <= 0.5;
    setFollowIntent(false);
    if (!eligible) return;
    const probe = {
      scroller, ...before, owner: getOwnerToken(),
      revision: getIntentRevision(), frames: 0,
    };
    pending = probe;
    const settle = () => {
      if (pending !== probe) return;
      frame = null;
      const reason = rejection(probe);
      if (reason) {
        pending = null;
        onResolved({ reason, restored: false, ...before });
        return;
      }
      if (++probe.frames < 2) {
        frame = requestFrame(settle);
        return;
      }
      pending = null;
      setFollowIntent(true);
      onResolved({ reason: 'no-movement', restored: true, ...before });
    };
    frame = requestFrame(settle);
  };
  return { suspend, cancel };
}
