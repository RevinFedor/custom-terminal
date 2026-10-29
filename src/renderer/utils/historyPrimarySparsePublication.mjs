const failure = code => Object.assign(new Error(code), { code });
const sameOwner = (left, right) => left?.ownerKey === right?.ownerKey && left?.generation === right?.generation;

/** Actual Panel publication owner. Historical arrays are weak witnesses only.
 * publishCompatibility is the explicitly retained Np adapter: it scans an
 * existing array to extract genuine CURRENT objects and stores O(local) refs.
 * Selected callers read these locals without a historical array dependency.
 * Publishing/committing this subject confers no Main ACK, layout or Input. */
export function createHistoryPrimarySparsePublicationOwner({ isLocal, onReleaseError = () => {},
  agentSourceOwner = null, agentCatalogEnabled = () => false }) {
  if (typeof isLocal !== 'function') throw failure('HISTORY_PRIMARY_LOCAL_PREDICATE');
  let current = null, prepared = null, sparse = null, sequence = 0, closed = false;
  const release = held => {
    if (held) Promise.resolve().then(() => held.close()).catch(error => {
      // Cleanup has already lost its raw receipt. A diagnostic callback may
      // not create an unhandled rejection or replace the original failure.
      try { onReleaseError(error); } catch {}
    });
  };
  const publish = (entries, scope, nextPrepared = prepared, nextSparse = sparse, valid = () => true, sourceHint = null) => {
    const before = current, beforeSequence = sequence;
    if (closed || !Array.isArray(entries) || !scope || typeof valid !== 'function')
      throw failure('HISTORY_PRIMARY_LOCAL_PUBLICATION');
    const ownerKey = scope.ownerKey, generation = scope.generation;
    const agentEnabled = !!agentSourceOwner && agentCatalogEnabled() === true;
    if (typeof ownerKey !== 'string' || !Number.isSafeInteger(generation)) throw failure('HISTORY_PRIMARY_LOCAL_PUBLICATION');
    const unchanged = () => !closed && current === before && sequence === beforeSequence;
    const check = () => {
      // clear()/close() can leave current===null unchanged. The original
      // lifecycle sequence must therefore survive both classification and
      // the caller's full original witness, including same-array fast return.
      if (!unchanged() || valid() !== true || !unchanged()
        || scope.ownerKey !== ownerKey || scope.generation !== generation || nextPrepared?.closed || !unchanged())
        throw failure('HISTORY_READ_CANCELLED');
    };
    if (current?.entries.deref() === entries && current.ownerKey === ownerKey && current.generation === generation
      && prepared === nextPrepared && sparse === nextSparse
      && (!agentSourceOwner || !!current.agentCatalog === agentEnabled)) { check(); return current; }
    // This is the remaining compatibility extraction, never the historical
    // matcher. Do not fingerprint N historical payloads or copy their values.
    const agentPlan = agentSourceOwner?.prepare(entries, { ownerKey, generation }, {
      prepared: nextPrepared, hint: sourceHint, enabled: agentEnabled,
    });
    let rows, agentCatalog;
    try {
      rows = agentPlan?.rows || Object.freeze(entries.filter(isLocal));
      check();
      agentCatalog = agentPlan?.commit() || null;
    } catch (error) { agentPlan?.discard(); throw error; }
    const old = prepared;
    prepared = nextPrepared; sparse = nextSparse;
    current = Object.freeze({ kind: prepared ? 'prepared-with-current-locals' : 'current-local-only',
      ownerKey, generation, sequence: ++sequence,
      prepared, sparse, rows, entries: new WeakRef(entries), dataSubject: Object.freeze({}),
      ...(agentSourceOwner ? { agentCatalog } : {}) });
    if (old !== prepared) release(old);
    return current;
  };
  return Object.freeze({
    publishCompatibility(entries, scope, { owns = () => true, sourceHint = null } = {}) {
      // An owner handoff may preserve a visual prefix elsewhere, but cannot
      // inherit this subject's old authoring/commit authority.
      const before = current, beforeSequence = sequence;
      if (typeof owns !== 'function') throw failure('HISTORY_PRIMARY_LOCAL_PUBLICATION');
      const keepPrepared = sameOwner(before, scope);
      const unchanged = () => !closed && current === before && sequence === beforeSequence;
      return publish(entries, scope, keepPrepared ? prepared : null, keepPrepared ? sparse : null,
        () => unchanged() && owns() === true && unchanged(), sourceHint);
    },
    adopt(proof, entries, scope) {
      const before = current, beforeSequence = sequence;
      const unchanged = () => !closed && current === before && sequence === beforeSequence;
      if (!proof?.prepared || !proof.publication || proof.publication.header !== proof.prepared.header
        || proof.publication.dataSubject !== proof.prepared.receiptDataSubject
        || proof.isCurrent() !== true) throw failure('HISTORY_PRIMARY_PREPARED_PUBLICATION');
      if (!unchanged()) throw failure('HISTORY_READ_CANCELLED');
      const held = proof.prepared.retain();
      try {
        if (!unchanged()) throw failure('HISTORY_READ_CANCELLED');
        return publish(entries, scope, held, proof.publication,
          () => unchanged() && proof.isCurrent() === true && unchanged());
      }
      catch (error) { release(held); throw error; }
    },
    current(scope) { return !closed && (!scope || sameOwner(current, scope)) ? current : null; },
    localRows(scope) { return !closed && sameOwner(current, scope) ? current.rows : null; },
    matches(publication, entries, scope) {
      return !closed && current === publication && sameOwner(publication, scope)
        && publication?.entries.deref() === entries && (!publication.prepared || !publication.prepared.closed);
    },
    clear() {
      const old = prepared; current = null; prepared = null; sparse = null; ++sequence; release(old);
      agentSourceOwner?.clear();
    },
    close() { if (closed) return; closed = true; ++sequence; const old = prepared; current = null; prepared = null; sparse = null; release(old); agentSourceOwner?.close(); },
  });
}
