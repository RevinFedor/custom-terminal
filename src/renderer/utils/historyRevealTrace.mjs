// One bounded trace attached to the existing reveal transaction. No observers,
// timers, layout reads or scroll writes are installed here. The caller supplies
// its click-frame geometry and the already-running Virtuoso measurement signal.
const number = value => Number.isFinite(value) ? value : null;
const id = value => typeof value === 'string' ? value.slice(0, 180) : null;
const exactKey = value => typeof value === 'string' && value.length <= 4096 ? value : null;
const geometry = value => ({
  scrollTop: number(value?.scrollTop), scrollHeight: number(value?.scrollHeight),
  clientHeight: number(value?.clientHeight), anchorTop: number(value?.anchorTop),
  anchorHeight: number(value?.anchorHeight), unitTop: number(value?.unitTop), unitHeight: number(value?.unitHeight),
  distance: Number.isFinite(value?.scrollTop) && Number.isFinite(value?.scrollHeight)
    && Number.isFinite(value?.clientHeight) ? value.scrollHeight - value.clientHeight - value.scrollTop : null,
});

export function createHistoryRevealTrace({ getState, log, now = () => performance.timeOrigin + performance.now() }) {
  let sequence = 0, pending = null;
  const state = () => {
    try {
      const value = getState();
      return { owner: id(value?.owner), generation: number(value?.generation), visit: number(value?.visit),
        actionId: id(value?.actionId), gesture: number(value?.gesture), intentRevision: number(value?.intentRevision),
        follow: value?.follow === true, followProp: value?.followProp === true, presented: value?.presented === true,
        pointer: value?.pointer === true, pinPending: value?.pinPending === true,
        restore: value?.restore === true, jump: value?.jump === true };
    } catch { return null; }
  };
  const current = (ticket, value) => !!value && value.owner === ticket.owner.owner
    && value.generation === ticket.owner.generation && value.visit === ticket.owner.visit;
  const emit = (ticket, phase, values = {}) => {
    if (!ticket || ticket.records >= 5) return;
    ticket.records++;
    try { log({ id: ticket.id, phase, opening: ticket.opening, card: ticket.card, unitKey: ticket.unitKey,
      beginAbs: ticket.beginAbs, atAbs: now(), ...values, actionId: ticket.owner.actionId }); } catch { /* Never alter the reveal. */ }
  };
  const close = reason => {
    if (!pending) return;
    emit(pending, 'closed', { reason, writerResult: 'not-claimed' }); pending = null;
  };
  return {
    begin({ card, unitKey, opening, snapshot, snapshotSource = 'supplied', geometryAgeMs = null }) {
      close('superseded');
      const owner = state();
      if (!owner?.owner || !owner.presented) return null;
      const ticket = { id: ++sequence, opening: opening === true, card: id(card), unitKey: id(unitKey),
        unitKeyExact: exactKey(unitKey),
        beginAbs: now(), owner, records: 0, measured: false, synced: false, baseline: geometry(snapshot) };
      pending = ticket;
      emit(ticket, 'begin', { ...owner, ...ticket.baseline, geometrySource: id(snapshotSource),
        geometryAgeMs: number(geometryAgeMs), writerResult: 'none' });
      const commit = () => {
        if (pending !== ticket) return;
        const value = state();
        if (!current(ticket, value)) { close('owner-changed'); return; }
        // Do not measure the just-mutated DOM to populate a diagnostic.
        emit(ticket, 'commit', { ...value, geometrySource: 'begin-cached', ...ticket.baseline,
          writerResult: 'existing-reveal-commit-returned-no-trace-write' });
      };
      commit.finishAnchor = outcome => {
        if (pending !== ticket) return;
        emit(ticket, 'settled', { ...state(), source: 'existing-anchor-convergence',
          writerResult: id(outcome?.reason), writes: number(outcome?.writes), frames: number(outcome?.frames),
          maxDriftPx: number(outcome?.maxDriftPx), positionSignals: number(outcome?.positionSignals) });
        pending = null;
      };
      return commit;
    },
    measure(unitKey, snapshot) {
      const ticket = pending;
      if (!ticket || ticket.measured || !ticket.unitKeyExact || exactKey(unitKey) !== ticket.unitKeyExact) return;
      const value = state();
      if (!current(ticket, value)) { close('owner-changed'); return; }
      ticket.measured = true;
      try {
        const measured = geometry(snapshot());
        emit(ticket, 'measurement', { ...value, ...measured, geometrySource: 'existing-itemSize',
          deltaTop: measured.scrollTop !== null && ticket.baseline.scrollTop !== null
            ? measured.scrollTop - ticket.baseline.scrollTop : null,
          gestureChanged: value.gesture !== ticket.owner.gesture, writerResult: 'not-attributed' });
      } catch { emit(ticket, 'measurement', { ...value, geometrySource: 'unavailable', writerResult: 'not-attributed' }); }
    },
    viewportSync({ before, after } = {}) {
      const ticket = pending;
      if (!ticket || !ticket.measured || ticket.synced) return;
      const value = state();
      if (!current(ticket, value)) { close('owner-changed'); return; }
      ticket.synced = true;
      emit(ticket, 'settle-signal', { ...value, source: 'existing-viewport-publication',
        before: number(before), after: number(after), gestureChanged: value.gesture !== ticket.owner.gesture,
        writerResult: 'viewport-notified-no-trace-position-write', settled: 'signal-only-not-pixel-proof' });
    },
    cancel: close,
  };
}
