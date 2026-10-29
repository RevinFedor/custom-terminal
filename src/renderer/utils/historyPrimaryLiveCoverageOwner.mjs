// Current live subjects only. The canonical inventory remains in the held root;
// this owner keeps row witnesses/booleans for one current fold, never visited IDs.
const cancelled = () => Object.assign(new Error('HISTORY_READ_CANCELLED'), { code: 'HISTORY_READ_CANCELLED' });
const invalid = () => Object.assign(new Error('HISTORY_PRIMARY_LIVE_COVERAGE_INVALID'), { code: 'HISTORY_PRIMARY_LIVE_COVERAGE_INVALID' });

export function createHistoryPrimaryLiveCoverageOwner({ readCurrent, fingerprint, publish, onError = () => {} }) {
  let running = null, pending = null, observed = null, proof = null;
  let queued = false, disposed = false;

  const read = (verifyValues = true) => {
    if (disposed) return null;
    const value = readCurrent({ verifyValues });
    const root = value?.root, live = value?.live;
    if (!root || root.closed || !root.header || !live || live.ownerKey !== value.ownerKey
      || !Array.isArray(live.entries)) return null;
    const dataSubject = root.getReceiptDataSubject();
    if (!dataSubject) return null;
    const commit = value.commit, liveCommit = value.liveCommit;
    return { root, dataSubject, ownerKey: value.ownerKey, generation: value.generation,
      live, entries: live.entries, header: root.header,
      committed: !!commit && commit.root === root && commit.dataSubject === dataSubject
        && commit.ownerKey === value.ownerKey && commit.generation === value.generation,
      liveCommitted: !!liveCommit && liveCommit.root === root && liveCommit.dataSubject === dataSubject
        && liveCommit.ownerKey === value.ownerKey && liveCommit.generation === value.generation
        && liveCommit.live === live && liveCommit.entries === live.entries
        && liveCommit.fingerprints.length === live.entries.length,
      liveCommitFingerprints: liveCommit?.fingerprints };
  };
  const same = (a, b) => !!a && !!b && a.root === b.root && a.dataSubject === b.dataSubject
    && a.ownerKey === b.ownerKey && a.generation === b.generation && a.live === b.live && a.entries === b.entries;
  const rowsCurrent = (state, value, verifyValues = true) => same(state, value) && state.rows.length === value.entries.length
    && state.rows.every((row, index) => row.entry === value.entries[index]
      && (!verifyValues || row.fingerprint === fingerprint(value.entries[index])));
  const current = (state, committed = true) => {
    const value = read(false);
    // Signed historical reads use captured immutable claim values. Keep their
    // per-await cancellation/owner/fold guards cheap; full current-value proof
    // is checked at dispatch, public consumption and every retirement boundary.
    return !!value && (!committed || value.committed) && rowsCurrent(state, value, false);
  };
  const ownership = () => ({ observed, proof, pending, running });
  const ownsSnapshot = owner => !disposed && observed === owner.observed && proof === owner.proof
    && pending === owner.pending && running === owner.running;
  // Full witness/coercion callbacks may synchronously revoke or replace us.
  // Recheck lifetime and current bindings AFTER them without another hash.
  const currentAfterWitness = (owner, state, committed = true) => ownsSnapshot(owner)
    && current(state, committed) && ownsSnapshot(owner);
  const settle = (state, value) => {
    if (state.settled) return;
    state.settled = true;
    state.resolve(value);
  };
  const cancel = state => {
    if (!state) return;
    state.controller?.abort();
    settle(state, null);
  };
  const report = error => {
    if (error?.code !== 'HISTORY_READ_CANCELLED') onError(error);
  };
  const discard = () => {
    proof = null;
    cancel(pending); pending = null;
    cancel(running);
    observed = null;
  };
  const peek = ownerKey => {
    try {
      const owner = ownership(), currentProof = proof;
      const value = read();
      if (!value || !ownsSnapshot(owner) || ownerKey !== undefined && value.ownerKey !== ownerKey) return null;
      if (value.entries.length === 0) return false;
      if (!value.committed || !currentProof || !rowsCurrent(currentProof, value)
        || !currentAfterWitness(owner, currentProof)) return null;
      // Settings conflict intentionally does not participate in this predicate.
      // A retained contradictory settings row can be identity-covered already.
      return currentProof.rows.some(row => !row.coveredIdentity);
    } catch (error) { report(error); return null; }
  };
  const schedule = () => {
    if (queued || disposed) return;
    queued = true;
    queueMicrotask(() => { queued = false; drain(); });
  };
  const publishProof = state => {
    const owner = ownership();
    const value = read();
    if (!value || !value.committed || !rowsCurrent(state, value)
      || !currentAfterWitness(owner, state)) throw cancelled();
    // A new streaming fold may already be identity-covered by an OLD data
    // cut. Plain unmatched can use that fact; retirement still needs the real
    // data-commit boundary to have observed these exact live row revisions.
    if (!value.liveCommitted || value.liveCommitFingerprints.some((fingerprint, index) =>
      fingerprint !== state.rows[index].fingerprint)) {
      if (!currentAfterWitness(owner, state)) throw cancelled();
      proof = { ...value, rows: state.rows };
      return;
    }
    const retained = state.rows.filter(row => !row.coveredIdentity || row.settingsConflict);
    const remaining = retained.length === state.entries.length ? state.entries : retained.map(row => row.entry);
    if (!currentAfterWitness(owner, state)) throw cancelled();
    // The caller may run native coercion/full witnesses of its own before
    // writing refs. It must retain this same publication lifetime at that
    // final write boundary; a prior check cannot stop a reentrant callback.
    const nextLive = publish(remaining, state.live, { ...value, rows: state.rows,
      owns: () => currentAfterWitness(owner, state) });
    const next = read();
    if (!next || next.live !== nextLive || next.entries !== remaining
      || next.root !== state.root || next.dataSubject !== state.dataSubject
      || next.ownerKey !== state.ownerKey || next.generation !== state.generation || !next.committed) throw cancelled();
    const nextProof = { ...next, rows: retained };
    if (!rowsCurrent(nextProof, next) || !currentAfterWitness(owner, nextProof)) throw cancelled();
    proof = nextProof;
    owner.proof = nextProof;
    if (remaining !== state.entries) {
      // Forget retired subjects immediately. Carry only the proved remaining
      // current fold; this publication is not a read or an UNKNOWN retry.
      const unmatched = peek(next.ownerKey);
      if (!currentAfterWitness(owner, nextProof)) throw cancelled();
      observed = { ...nextProof, settled: true, failed: false, promise: Promise.resolve(unmatched), resolve() {} };
    }
  };
  const run = async state => {
    const proofs = [];
    const owns = () => !disposed && running === state && !state.controller.signal.aborted && current(state)
      && !disposed && running === state && !state.controller.signal.aborted;
    const check = () => { if (!owns()) throw cancelled(); };
    check();
    for (let offset = 0; offset < state.rows.length; offset += 3) {
      const batch = state.rows.slice(offset, offset + 3);
      const header = state.root.header;
      const result = await state.root.readLiveIdentityCoverage(batch.map(row => row.entry), {
        signal: state.controller.signal, owns,
      });
      check();
      if (state.root.header !== header || result?.header !== header || result.dataSubject !== state.dataSubject
        || !Array.isArray(result.claims) || result.claims.length !== batch.length) throw invalid();
      for (let index = 0; index < batch.length; index += 1) {
        const resultRow = result.claims[index], row = batch[index];
        if (resultRow?.entry !== row.entry || resultRow.fingerprint !== row.fingerprint
          || typeof resultRow.coveredIdentity !== 'boolean' || typeof resultRow.settingsConflict !== 'boolean') throw invalid();
        proofs.push({ entry: row.entry, fingerprint: row.fingerprint,
          coveredIdentity: resultRow.coveredIdentity, settingsConflict: resultRow.settingsConflict });
      }
    }
    check();
    // The old filter publishes only after every live row was evaluated. Keep
    // that boundary: a later coercion failure must not retire an earlier batch.
    state.rows = proofs; state.failed = false;
    const prepared = { ...read(), rows: proofs };
    check();
    publishProof(prepared);
    settle(state, peek(state.ownerKey));
  };
  function drain() {
    if (disposed || running || !pending) return;
    const state = pending;
    const owner = ownership();
    let value;
    try {
      value = read();
      if (!value || !rowsCurrent(state, value) || !currentAfterWitness(owner, state, false)) {
        if (pending === state) pending = null;
        cancel(state); return;
      }
    } catch (error) { if (pending === state) pending = null; state.failed = true; settle(state, null); report(error); return; }
    // Data adoption can settle before React's existing layout commit. Retain
    // this observation until that commit (or replacement/cancel), never paint.
    if (!value.committed) return;
    pending = null; running = state; state.header = value.header; state.controller = new AbortController();
    void run(state).catch(error => {
      state.failed = true;
      if (observed === state) proof = null;
      settle(state, null);
      report(error);
    }).finally(() => {
      if (running === state) running = null;
      // Only an independently published pending subject/wake may continue.
      // A failed query never queues itself and never wakes another load cycle.
      if (pending) schedule();
    });
  }
  const request = (reason, ownerKey) => {
    if (disposed) return Promise.resolve(null);
    const owner = ownership();
    let value;
    try {
      value = read();
      if (ownerKey !== undefined && value?.ownerKey !== ownerKey) return Promise.resolve(null);
      if (!value) { discard(); return Promise.resolve(null); }
      if (value.entries.length === 0) { discard(); return Promise.resolve(false); }
      const known = peek(value.ownerKey);
      if (!ownsSnapshot(owner)) return Promise.resolve(null);
      if (known !== null) {
        try { if (reason === 'commit') publishProof(proof); } catch (error) {
          if (observed === owner.observed) {
            proof = null;
          }
          if (observed && observed === owner.observed) {
            observed.failed = true; settle(observed, null);
            observed.promise = Promise.resolve(null);
          }
          report(error);
          return Promise.resolve(null);
        }
        return Promise.resolve(peek(value.ownerKey));
      }
      const stillObserved = observed && rowsCurrent(observed, value);
      if (!ownsSnapshot(owner)) return Promise.resolve(null);
      const externalWake = reason === 'metadata' || reason === 'external-open';
      // A no-adoption external open can advance the query sequence yet keep
      // this exact header/data cut. Its wake may precede the old query's
      // cancellation continuation, so retain the real signal as replacement
      // demand now instead of losing it inside that obsolete promise.
      const replaceRunning = !!running && running === observed && (running.header !== value.header || externalWake);
      if (stillObserved && !replaceRunning && (!observed.failed || !externalWake)) {
        if (pending === observed) schedule();
        return observed.promise;
      }
      // One replaceable pending demand; no queue or per-visited-claim cache.
      const previousPending = pending;
      pending = null;
      proof = null;
      const transition = ownership();
      cancel(previousPending);
      cancel(running);
      if (!ownsSnapshot(transition)) return Promise.resolve(null);
      let resolve;
      const promise = new Promise(done => { resolve = done; });
      const state = { ...value, rows: value.entries.map(entry => ({ entry, fingerprint: fingerprint(entry) })),
        promise, resolve, settled: false, failed: false, controller: null };
      if (!currentAfterWitness(transition, state, false)) { settle(state, null); return promise; }
      observed = state; pending = state;
      schedule();
      return promise;
    } catch (error) {
      if (ownsSnapshot(owner)) discard();
      report(error);
      return Promise.resolve(null);
    }
  };
  return Object.freeze({
    // React may reinstall an effect on the same memoized owner. Cleanup has
    // already cancelled/forgotten its observations; setup only permits new
    // real subject/commit signals and does not replay a failed read itself.
    activate() { disposed = false; },
    wake: reason => { void request(reason || 'subject'); },
    readUnmatched: ownerKey => request('read', ownerKey),
    peekUnmatched: peek,
    // Admission is synchronous. Coverage of a current row cannot discard its
    // streaming update; unknown/new subjects are admitted for later proof.
    admits(entry, identities, alreadyPresentedLiveIdentities) {
      if (!identities.length) return true;
      try {
        const owner = ownership(), currentProof = proof;
        const value = read();
        if (!value?.committed || !currentProof || !rowsCurrent(currentProof, value)
          || !currentAfterWitness(owner, currentProof)) return true;
        const row = currentProof.rows.find(row => row.entry === entry && row.fingerprint === fingerprint(entry));
        const admitted = !row || !row.coveredIdentity
          || identities.some(id => alreadyPresentedLiveIdentities.has(id))
          || entry?.settingsFact?.provider === 'codex';
        return currentAfterWitness(owner, currentProof) ? admitted : true;
      } catch (error) { report(error); return true; }
    },
    cancelOwner(root, ownerKey, generation) {
      const matches = state => state?.root === root && state.ownerKey === ownerKey && state.generation === generation;
      if (matches(pending)) { cancel(pending); pending = null; }
      if (matches(running)) cancel(running);
      if (matches(observed)) observed = null;
      if (matches(proof)) proof = null;
    },
    invalidate: discard,
    dispose() { if (disposed) return; discard(); disposed = true; },
  });
}
