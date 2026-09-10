import { captureHistoryResizeAnchor, measureHistoryResizeAnchor, registerHistoryResizeSurface } from './historyResizeAnchor.mjs';

// One controller per History. Geometry producers do not know transcript keys,
// and History does not write split sizes or take workspace focus.
export function createHistoryResizeController(options) {
  const { root, getScroller, getOwner, isPresented, getFollowBottom, converge,
    jumpToKey, onPrepare, onPhase, onFinish, log = () => {},
    requestFrame = requestAnimationFrame, cancelFrame = cancelAnimationFrame,
    setTimer = setTimeout, clearTimer = clearTimeout,
  } = options;
  const stage = root.querySelector('[data-history-content-stage]');
  let current = null;
  let cached = null;
  let serial = 0;
  let cacheFrame = 0;
  let nativeTimer = null;
  let nativeFinish = null;
  let disposed = false;

  function currentAnchor(scroller, width) {
    if (cached?.owner === getOwner() && Math.abs(cached.width - width) <= 0.5
      && (cached.anchor.kind === 'tail') === !!getFollowBottom()) {
      const measured = measureHistoryResizeAnchor(scroller, cached.anchor);
      // A wrapped line can gain characters BEFORE our reading point. Choosing
      // its new first character on every resize slowly walks the reader away.
      // Keep the same point until scrolling/content actually moves it.
      if (measured && measured.proof !== 'row-text-changed' && Math.abs(measured.drift) <= 2) return cached.anchor;
    }
    return captureHistoryResizeAnchor(scroller, getFollowBottom());
  }

  function phase(value) {
    if (value) root.setAttribute('data-history-resize-locked', value);
    else root.removeAttribute('data-history-resize-locked');
    onPhase(value);
  }
  function refresh() {
    if (disposed || current || cacheFrame || !isPresented()) return;
    cacheFrame = requestFrame(() => {
      cacheFrame = 0;
      if (disposed || current || !isPresented() || options.isPositionBusy?.()) return;
      const scroller = getScroller();
      if (!scroller) return;
      const width = stage?.getBoundingClientRect().width;
      // A resize event/observer must get the last OLD-width reading point,
      // not a new snapshot already measured after the browser reflowed it.
      if (cached?.owner === getOwner() && Math.abs(cached.width - width) > 0.5) return;
      const anchor = currentAnchor(scroller, width);
      if (anchor) cached = { anchor, owner: getOwner(), width };
    });
  }
  function finish(session, reason, outcome = null) {
    if (current !== session) return;
    current = null;
    phase(null);
    log({ event: 'END', id: session.id, reason, mode: session.anchor.kind,
      proof: session.measurement?.proof || '-', ...outcome,
      clamped: session.clamped === true, textDriftPx: session.measurement?.drift ?? null });
    onFinish({ reason, anchor: session.anchor, owner: session.owner,
      scroller: getScroller(), restored: reason === 'restored', outcome });
    cached = reason === 'restored' && !session.clamped && session.owner === getOwner()
      ? { anchor: session.anchor, owner: session.owner, width: stage?.getBoundingClientRect().width }
      : null;
    refresh();
  }
  function cancel(reason = 'cancelled') {
    if (nativeTimer !== null) clearTimer(nativeTimer);
    nativeTimer = null;
    nativeFinish = null;
    if (current) finish(current, reason);
  }
  function prepare(reason = 'split-divider', fromCache = false) {
    if (disposed || !isPresented()) return null;
    const owner = getOwner();
    const anchor = current?.owner === owner ? current.anchor
      : fromCache ? (cached?.owner === owner ? cached.anchor : null)
        : currentAnchor(getScroller(), stage?.getBoundingClientRect().width);
    if (!anchor) return null; // No text was shown yet; ordinary cold proof owns it.
    const session = { id: ++serial, owner, anchor, reason, measurement: null, remountRequested: false };
    return {
      activate() {
        if (disposed || getOwner() !== owner || !isPresented()) return;
        cancel('superseded');
        current = session;
        phase(fromCache ? 'settling' : 'dragging');
        onPrepare(session);
        log({ event: 'BEGIN', id: session.id, mode: anchor.kind, key: anchor.key?.slice(-48) || '-', reason });
      },
      finish(changed = true) {
        if (current !== session) return;
        if (!changed) { finish(session, 'unchanged'); return; }
        phase('settling');
        converge({
          cancelled: () => disposed || current !== session ? 'superseded'
            : getOwner() !== owner ? 'owner-change' : !isPresented() ? 'hidden' : null,
          measureDrift: () => {
            const s = getScroller();
            if (options.isContentReady && !options.isContentReady(anchor)) return null;
            session.measurement = measureHistoryResizeAnchor(s, anchor);
            if (!s || !session.measurement) return null;
            // A shorter document can make the old top gap unreachable. Clamp
            // to its REAL range; never append a second invisible bottom.
            const target = Math.max(0, Math.min(s.scrollHeight - s.clientHeight, s.scrollTop + session.measurement.drift));
            session.clamped = Math.abs(target - s.scrollTop - session.measurement.drift) > 0.5;
            return target - s.scrollTop;
          },
          jump: () => {
            const s = getScroller();
            if (!s) return true; // Physical list is between mounts.
            if (anchor.kind === 'tail' && options.isContentReady && !options.isContentReady(anchor)) {
              return jumpToKey(null, null, true);
            }
            const measured = measureHistoryResizeAnchor(s, anchor);
            if (!measured) return jumpToKey(anchor.key, anchor.uuid);
            s.scrollTop = Math.max(0, Math.min(s.scrollHeight - s.clientHeight, s.scrollTop + measured.drift));
            return true;
          },
          onSettled: (outcome) => finish(session, outcome.settled === '1' ? 'restored' : 'not-settled', outcome),
          onAborted: (outcome) => finish(session, outcome.reason, outcome),
        });
      },
    };
  }

  const unbind = registerHistoryResizeSurface(root, prepare);
  const blockScroll = (event) => {
    if (!current || !stage?.contains(event.target)) return;
    if (event.target?.closest?.('input, textarea, [contenteditable="true"]')) return;
    if (event.type === 'keydown' && !['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) return;
    event.preventDefault(); event.stopImmediatePropagation();
  };
  root.addEventListener('wheel', blockScroll, { capture: true, passive: false });
  root.addEventListener('touchmove', blockScroll, { capture: true, passive: false });
  root.addEventListener('keydown', blockScroll, true);
  const onScroll = (event) => { if (event.target === getScroller()) refresh(); };
  root.addEventListener('scroll', onScroll, true);

  const onNativeResize = () => {
    if (!isPresented() || (current && current.reason !== 'content-width-or-window')) return;
    if (!nativeFinish) {
      const participant = prepare('content-width-or-window', true);
      if (!participant) return;
      participant.activate();
      nativeFinish = participant.finish;
    }
    if (nativeTimer !== null) clearTimer(nativeTimer);
    // DOM window resize has no end event. This only debounces the incoming
    // gesture; readiness afterwards is measured, never inferred from time.
    nativeTimer = setTimer(() => {
      nativeTimer = null;
      const complete = nativeFinish;
      nativeFinish = null;
      complete?.(true);
    }, 150);
  };
  const view = root.ownerDocument.defaultView;
  view.addEventListener('resize', onNativeResize);
  const observer = new view.ResizeObserver(() => {
    if (!cached || current || !isPresented()) return;
    if (Math.abs(cached.width - stage.getBoundingClientRect().width) > 0.5) onNativeResize();
  });
  if (stage) observer.observe(stage);
  refresh();
  return {
    active: () => !!current,
    refresh,
    cancel,
    claimRemount() {
      if (!current) return true;
      if (current.remountRequested) return false;
      current.remountRequested = true;
      return true;
    },
    dispose() {
      disposed = true;
      cancel('unmounted');
      if (cacheFrame) cancelFrame(cacheFrame);
      unbind(); observer.disconnect();
      view.removeEventListener('resize', onNativeResize);
      root.removeEventListener('wheel', blockScroll, true);
      root.removeEventListener('touchmove', blockScroll, true);
      root.removeEventListener('keydown', blockScroll, true);
      root.removeEventListener('scroll', onScroll, true);
    },
  };
}
