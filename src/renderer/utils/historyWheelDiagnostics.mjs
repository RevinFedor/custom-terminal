// Observation only. No DOM reads/writes and no logging inside wheel handlers.
// The first three packets after a quiet input gap are enough to distinguish a
// slow first packet from later coalesced input. Native ACK/pixels require trace;
// a scroll callback or rAF is deliberately NOT labelled as a paint proof.
const MAX_PACKETS = 3;
const MAX_PENDING = 12;
const MAX_FRAMES = 8;
const MAX_QUEUED_LINES = 48;
const QUIET_MS = 250;
let observerSequence = 0;
const round = value => Number.isFinite(value) ? Math.round(value * 10) / 10 : null;

export function createHistoryWheelDiagnostics({
  context,
  log,
  now = () => performance.now(),
  timeOrigin = performance.timeOrigin,
  // This zero-delay timer batches output into a separate task. It never gates
  // input, restoration or readiness, and its delay is recorded, not assumed.
  defer = fn => setTimeout(fn, 0),
  cancelDeferred = id => clearTimeout(id),
  frame = fn => requestAnimationFrame(fn),
  cancelFrame = id => cancelAnimationFrame(id),
} = {}) {
  const instance = ++observerSequence;
  let events = new WeakMap();
  let currentScope = null;
  let lastInputTs = -Infinity;
  let burst = 0;
  let packets = 0;
  let sequence = 0;
  let pending = [];
  let lines = [];
  let dropped = 0;
  let flushTask = null;
  const frames = new Map();

  const scopeMatches = scope => {
    const next = context();
    return next.presented && next.owner === scope.owner
      && next.generation === scope.generation && next.visit === scope.visit;
  };

  const flush = () => {
    flushTask = null;
    const batch = lines;
    lines = [];
    const omitted = dropped;
    dropped = 0;
    const at = now();
    for (const item of batch) {
      try {
        log('WHEEL_PIPELINE ' + JSON.stringify({ ...item,
          flushAbs: round(timeOrigin + at), logLagMs: round(at - item.observedMs),
          ...(omitted ? { droppedLines: omitted } : {}),
        }));
      } catch { /* diagnostics must not break input or create uncaught tasks */ }
    }
  };

  const emit = (record, phase, values = {}) => {
    if (lines.length < MAX_QUEUED_LINES) {
      lines.push({ instance, tab: record.scope.tab, owner: record.scope.owner,
        generation: record.scope.generation, visit: record.scope.visit,
        id: record.id, burst: record.burst, packet: record.packet, phase,
        eventTs: record.eventTs, eventAbs: round(timeOrigin + record.eventTs),
        deltaY: record.deltaY, deltaMode: record.deltaMode, branch: record.branch,
        observedMs: now(), ...values });
    } else dropped++;
    if (flushTask === null) flushTask = defer(flush);
  };

  const endPending = reason => {
    for (const record of pending) emit(record, 'closed', { reason, scrollObserved: false });
    pending = [];
  };

  const cancelFrames = reason => {
    for (const [id, sample] of frames) {
      cancelFrame(id);
      emit(sample.record, 'frame-cancelled', { reason, stage: sample.phase });
    }
    frames.clear();
  };

  const observeFrame = (record, phase) => {
    // At most two frame callbacks per burst (first handlers / first scroll).
    if (record.packet !== 1) return;
    if (frames.size >= MAX_FRAMES) {
      emit(record, 'frame-skipped', { reason: 'sample-capacity', stage: phase });
      return;
    }
    const id = frame(() => {
      frames.delete(id);
      try {
        if (!scopeMatches(record.scope)) {
          emit(record, 'frame-cancelled', { reason: 'presentation-changed', stage: phase });
          return;
        }
        emit(record, phase, { frameAbs: round(timeOrigin + now()),
          scrollObserved: record.firstScrollAbs !== null,
          firstScrollAbs: record.firstScrollAbs });
      } catch { /* a failed observer cannot change the native event result */ }
    });
    frames.set(id, { record, phase });
  };

  const recordFor = (event, stage, enteredAt) => {
    if (event?.type !== 'wheel' || !event.isTrusted || event.deltaY === 0) return null;
    if (events.has(event)) return events.get(event);
    if (stage !== 'tool') return null;
    const scope = context();
    if (!scope.presented) return null;
    const changed = !currentScope || scope.owner !== currentScope.owner
      || scope.generation !== currentScope.generation || scope.visit !== currentScope.visit;
    const ts = Number.isFinite(event.timeStamp) ? event.timeStamp : enteredAt;
    if (changed) {
      endPending('owner-or-visit-changed');
      cancelFrames('owner-or-visit-changed');
    }
    if (changed || ts - lastInputTs > QUIET_MS || ts < lastInputTs) {
      // A second burst must not erase a still-waiting first wheel: that is
      // exactly the production first-ACK stall this observer needs to catch.
      currentScope = { ...scope };
      packets = 0;
      burst++;
    }
    lastInputTs = ts;
    if (++packets > MAX_PACKETS) return null;
    const record = { scope: currentScope, id: ++sequence, burst, packet: packets,
      eventTs: ts, deltaY: round(event.deltaY), deltaMode: event.deltaMode,
      branch: 'none', firstScrollAbs: null, intentExitAbs: null, toolExitAbs: null };
    events.set(event, record);
    if (pending.length >= MAX_PENDING) {
      emit(pending.shift(), 'closed', { reason: 'sample-capacity', scrollObserved: false });
    }
    pending.push(record);
    return record;
  };

  const wrap = (stage, handler) => function (event, ...args) {
    let record = null;
    let enteredAt;
    try {
      enteredAt = now();
      record = recordFor(event, stage, enteredAt);
    } catch { /* invoke the original handler even if observation is unavailable */ }
    let threw = true;
    try {
      const result = handler.call(this, event, ...args);
      threw = false;
      return result;
    } finally {
      if (record) {
        try {
          const exitAt = now();
          record[stage + 'ExitAbs'] = round(timeOrigin + exitAt);
          emit(record, stage, { enterAbs: round(timeOrigin + enteredAt),
            exitAbs: round(timeOrigin + exitAt),
            delayToEnterMs: round(enteredAt - record.eventTs),
            handlerMs: round(exitAt - enteredAt), threw,
            cancelable: Boolean(event.cancelable),
            defaultPrevented: Boolean(event.defaultPrevented),
            propagationStopped: Boolean(event.cancelBubble) });
          if (stage === 'tool') {
            if (record.branch === 'inner') pending = pending.filter(item => item !== record);
            observeFrame(record, 'raf-after-handlers');
          }
        } catch { /* preserve the original return value/exception */ }
      }
    }
  };

  return {
    wrap,
    toolBranch(event, branch) {
      const record = events.get(event);
      if (record && (branch === 'inner' || branch === 'edge')) record.branch = branch;
    },
    // The caller supplies a scrollTop it already read for its existing work.
    // This is first observed scroll AFTER a wheel, not proof that wheel caused
    // it (Virtuoso, tail pin and other writers retain their own diagnostics).
    observeScroll(scrollTop, handlerEnteredAt = now()) {
      if (!pending.length) return;
      try {
        const records = pending;
        pending = [];
        const at = now();
        for (const record of records) {
          if (!scopeMatches(record.scope)) {
            emit(record, 'closed', { reason: 'presentation-changed', scrollObserved: false });
            continue;
          }
          record.firstScrollAbs = round(timeOrigin + at);
          emit(record, 'scroll-observed', { scrollTop: round(scrollTop),
            scrollHandlerEnterAbs: round(timeOrigin + handlerEnteredAt),
            beforeObservationMs: round(at - handlerEnteredAt),
            firstScrollAbs: record.firstScrollAbs, fromEventMs: round(at - record.eventTs),
            toolExitAbs: record.toolExitAbs, intentExitAbs: record.intentExitAbs,
            afterIntentMs: record.intentExitAbs === null ? null
              : round(timeOrigin + at - record.intentExitAbs) });
          observeFrame(record, 'raf-after-scroll');
        }
      } catch { /* observation does not own the scroll */ }
    },
    reset(reason = 'scroller-detached') {
      try { endPending(reason); } catch {}
      try { cancelFrames(reason); } catch {}
      events = new WeakMap();
      currentScope = null;
      lastInputTs = -Infinity;
    },
    dispose() {
      this.reset('disposed');
      if (flushTask !== null) cancelDeferred(flushTask);
      flushTask = null;
      // Keep no component/event/DOM references after unmount. Output already
      // collected before disposal is flushed once in a detached deferred task.
      if (lines.length) defer(flush);
    },
  };
}
