import { openHistoryPresentationPosition } from '../../shared/history-root-read-client.mjs';
import { readHistoryThroughIpc } from './historyReadTransport.mjs';

const fail = code => Object.assign(new Error(code), { code });
const cancelled = () => fail('HISTORY_READ_CANCELLED');
const unknown = () => fail('HISTORY_READER_TRANSPORT_UNKNOWN');
const always = () => true, never = () => false;
const sameValue = (left, right) => left === right || Number.isNaN(left) && Number.isNaN(right);
const scalarKey = value => value == null || ['string', 'number', 'boolean', 'bigint'].includes(typeof value);
const check = (owns, signal) => {
  if (signal?.aborted || owns() !== true || signal?.aborted) throw cancelled();
};
function waitFor(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(cancelled());
  let abort;
  const stopped = new Promise((_resolve, reject) => { abort = () => reject(cancelled()); });
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  return Promise.race([promise, stopped]).finally(() => signal.removeEventListener('abort', abort));
}
let nextProjection = 0;

/**
 * Read-only coordinates of the actual renderer projection, independent of
 * canonical Root, source presence, body/paint coverage and writer authority.
 * A selected source owns an independent held prepared/current publication;
 * query and selected validation never read compatibility arrays. The legacy
 * adapter still borrows its genuine arrays. Neither arm adds a native N Map,
 * UUID inventory or entry graph. A frame names the exact displayed inputs.
 * Every external guard is followed by a pure ORIGINAL-operation fence: a
 * callback cannot clear/replace/dispose and revive its enclosing operation.
 */
export function createHistoryPresentationPositionOwner({
  invoke, open = openHistoryPresentationPosition, onSettled = () => {}, onError = () => {},
} = {}) {
  if (typeof invoke !== 'function' || typeof open !== 'function') throw fail('HISTORY_POSITION_OWNER_INVALID');
  const ownerIdentity = {}, invalidationListeners = [];
  let current = null, queued = null, running = null, retiring = null, disposed = false, version = 0;
  const counters = { registrations: 0, published: 0, reused: 0, unitVisits: 0,
    memberVisits: 0, unqueryableUUIDs: 0, queries: 0, selectedValidations: 0, releases: 0 };
  const report = error => { try { onError(error); } catch {} };
  const original = (state, epoch) => !disposed && version === epoch && current === state
    && state !== null && state.status !== 'superseded' && !state.controller.signal.aborted;
  const live = state => {
    const epoch = version;
    if (!original(state, epoch)) return false;
    const owns = state.owns, witness = state.witness;
    const accepted = owns(witness) === true;
    return accepted && original(state, epoch) && state.owns === owns && state.witness === witness;
  };
  const settle = (state, status, error = null) => {
    if (state.status !== 'pending') return;
    const finish = state.finish; state.finish = () => {};
    state.status = status; state.error = error; finish(state.publication);
    if (!disposed && current === state) { try { onSettled(state.publication); } catch (reason) { report(reason); } }
  };
  const notify = epoch => {
    for (const listener of invalidationListeners.slice()) {
      if (version !== epoch) return;
      try { listener(); } catch (error) { report(error); }
    }
  };
  function retire(handle, client = null) {
    if (!handle && !client) return;
    if (retiring) throw fail('HISTORY_POSITION_RELEASE_OVERLAP');
    // This fixed barrier never owns rows/frame/witness. Parent ACK alone does
    // not retire independent query children with uncertain cleanup receipts.
    const record = { handle: null, error: null }; retiring = record;
    try {
      if (client) {
        counters.releases++;
        const closed = client.close();
        Promise.resolve(closed).catch(() => {});
        handle = typeof client.retirement === 'function' ? client.retirement() : { promise: closed };
      }
      if (!handle || !handle.promise || typeof handle.promise.then !== 'function') throw unknown();
      record.handle = handle;
      Promise.resolve(handle.promise).then(() => {
        if (retiring !== record) return;
        retiring = null; drain();
      }, error => {
        if (retiring !== record) return;
        record.error = error || unknown();
        const state = queued;
        if (state && current === state) { queued = null; settle(state, 'failed', unknown()); }
        report(record.error);
      });
    } catch (error) {
      record.error = error || unknown();
      const state = queued;
      if (state && current === state) { queued = null; settle(state, 'failed', unknown()); }
      report(record.error);
    }
  }
  const detach = state => {
    if (!state) return;
    const client = state.client, source = state.source; state.client = null;
    const finish = state.finish; state.finish = () => {};
    state.status = 'superseded'; state.error = null;
    // Drop native graph references before abort/close/invalidation can reenter.
    // An active iterator retains only its borrowed original input until unwind.
    state.frame = state.witness = state.units = state.itemKeys = state.source = null; state.owns = never;
    finish(state.publication);
    try { source?.discard?.(); } catch (error) { report(error); }
    if (client) retire(null, client);
    state.controller.abort();
  };
  function* records(state) {
    check(() => live(state), state.controller.signal);
    const units = state.units;
    for (let index = 0; index < units.length; index++) {
      check(() => live(state), state.controller.signal);
      const unit = units[index]; counters.unitVisits++;
      if (unit?.kind === 'entry') {
        counters.memberVisits++;
        const uuid = unit.entry?.uuid;
        if (!scalarKey(uuid)) counters.unqueryableUUIDs++;
        yield { uuid: scalarKey(uuid) ? uuid : null, index, memberIndex: -1, memberCount: 1 };
        continue;
      }
      if (!unit || !Array.isArray(unit.entries)) throw fail('HISTORY_POSITION_UNIT_INVALID');
      const members = unit.entries, memberCount = members.length;
      if (memberCount === 0) { yield { uuid: null, index, memberIndex: -2, memberCount: 0 }; continue; }
      for (let memberIndex = 0; memberIndex < memberCount; memberIndex++) {
        check(() => live(state), state.controller.signal);
        if (unit.entries !== members || members.length !== memberCount) throw fail('HISTORY_POSITION_INPUT_CHANGED');
        counters.memberVisits++;
        const uuid = members[memberIndex]?.uuid;
        if (!scalarKey(uuid)) counters.unqueryableUUIDs++;
        yield { uuid: scalarKey(uuid) ? uuid : null, index, memberIndex, memberCount };
      }
    }
  }
  function drain() {
    if (running || !queued || disposed) return;
    if (retiring) {
      if (retiring.error) { const state = queued; queued = null; settle(state, 'failed', unknown()); }
      return;
    }
    const state = queued; queued = null; running = state;
    // Reserve the running slot before invoking any guard/open callback.
    Promise.resolve().then(async () => {
      let client = null;
      try {
        check(() => live(state), state.controller.signal);
        counters.registrations++;
        const options = { projectionId: state.projectionId, unitCount: state.unitCount,
          owns: () => live(state), signal: state.controller.signal, readThroughIpc: readHistoryThroughIpc };
        client = state.source
          ? await state.source.open(options)
          : await open(invoke, { ...options, records: records(state) });
        check(() => live(state), state.controller.signal);
        if (!client || typeof client.resolve !== 'function' || typeof client.close !== 'function'
          || state.source && typeof client.entryAt !== 'function') throw fail('HISTORY_POSITION_CLIENT_INVALID');
        state.client = client; client = null; counters.published++; settle(state, 'ready');
      } catch (error) {
        if (error?.positionRetirement) retire(error.positionRetirement);
        let owned = false; try { owned = live(state); } catch {}
        if (!owned || error?.code === 'HISTORY_READ_CANCELLED') settle(state, 'superseded');
        else { settle(state, 'failed', error); report(error); }
      } finally {
        if (client) retire(null, client);
        if (current !== state) state.units = state.itemKeys = state.source = null;
      }
    }).catch(report).finally(() => { if (running === state) running = null; drain(); });
  }
  const shapeSame = (state, input) => state && state.frame === input.frame
    && state.source === input.source && state.unitCount === input.unitCount
    && state.units === input.units && state.itemKeys === input.itemKeys;
  function make(input, reused = null) {
    let finish;
    const state = { frame: input.frame, witness: input.witness, owns: input.owns,
      units: input.units, itemKeys: input.itemKeys, source: input.source, unitCount: input.unitCount,
      projectionId: reused?.projectionId || 'renderer-position-' + (++nextProjection),
      controller: new AbortController(), client: reused?.client || null,
      status: 'pending', error: null, finish: value => finish(value) };
    const promise = new Promise(resolve => { finish = resolve; });
    state.publication = Object.freeze({ get frame() { return state.frame; }, get witness() { return state.witness; },
      projectionId: state.projectionId, unitCount: state.unitCount, promise,
      get status() { return state.status; }, get error() { return state.error; } });
    return state;
  }
  function publish(input) {
    if (disposed) throw fail('HISTORY_POSITION_OWNER_DISPOSED');
    const before = version, previous = current;
    if (!input) throw fail('HISTORY_POSITION_PUBLICATION_INVALID');
    // In the selected arm even property reads of native N compatibility
    // containers are forbidden. Their lifecycle belongs to another adapter.
    const source = input.source || null;
    const captured = { units: source ? null : input.units, itemKeys: source ? null : input.itemKeys,
      source, unitCount: source ? source.unitCount : input.units?.length,
      frame: input.frame, witness: input.witness, owns: input.owns };
    if (source ? typeof source.open !== 'function' || !Number.isSafeInteger(captured.unitCount) || captured.unitCount < 0
      : !Array.isArray(captured.units) || !Array.isArray(captured.itemKeys)
        || captured.units.length !== captured.itemKeys.length) throw fail('HISTORY_POSITION_PUBLICATION_INVALID');
    if (!captured.frame || !captured.witness || typeof captured.owns !== 'function') throw fail('HISTORY_POSITION_PUBLICATION_INVALID');
    if (disposed || version !== before || captured.owns(captured.witness) !== true
      || disposed || version !== before || current !== previous) return null;
    let reuse = false;
    if (shapeSame(previous, captured)) {
      if ((previous.witness === captured.witness || previous.status === 'pending') && live(previous)) {
        if (!disposed && version === before && current === previous) return previous.publication;
        return null;
      }
      if (disposed || version !== before || current !== previous) return null;
      reuse = previous.status === 'ready' || previous.status === 'failed';
    }
    const oldQueued = queued, status = previous?.status, error = previous?.error;
    const state = make(captured, reuse ? previous : null), epoch = ++version;
    if (reuse) previous.client = null;
    current = state; queued = reuse ? null : state;
    detach(previous);
    if (oldQueued && oldQueued !== previous) detach(oldQueued);
    if (version !== epoch || current !== state || disposed) return state.publication;
    notify(epoch);
    if (version !== epoch || current !== state || disposed) return state.publication;
    if (reuse) { counters.reused++; settle(state, status === 'ready' ? 'ready' : 'failed', error); }
    else drain();
    return state.publication;
  }
  function owns(publication) { const state = current; return state?.publication === publication && live(state); }
  function entryAt(address) {
    const state = current, epoch = version;
    if (!state || address?.owner !== ownerIdentity || address.publication !== state.publication || !live(state)
      || !original(state, epoch)) return null;
    counters.selectedValidations++;
    if (state.source) {
      const client = state.client;
      if (!client || address.selectedClient !== client || !address.selectedResult) return null;
      const result = address.selectedResult, entry = client.entryAt(result);
      // entryAt is an external selected witness callback. Its answer is not
      // allowed to revive the original operation after clear/reentry/ABA.
      return entry && entry === address.entry && entry === result.entry
        && result.index === address.index && result.memberIndex === address.memberIndex
        && result.memberCount === address.memberCount && result.physicalKey === address.physicalKey
        && !!entry.uuid && sameValue(entry.uuid, address.uuid)
        && original(state, epoch) && state.client === client ? entry : null;
    }
    const unit = state.units[address.index];
    if (state.itemKeys[address.index] !== address.physicalKey) return null;
    const entry = unit?.kind === 'entry' && address.memberIndex === -1 ? unit.entry
      : unit?.kind !== 'entry' && Array.isArray(unit?.entries)
        && unit.entries.length === address.memberCount ? unit.entries[address.memberIndex] : null;
    const matches = entry && entry === address.entry && !!entry.uuid && sameValue(entry.uuid, address.uuid);
    return matches && original(state, epoch) ? entry : null;
  }
  async function query(publication, uuid, { owns: callerOwns = always, signal, queryOwner } = {}) {
    if (!scalarKey(uuid)) throw fail('HISTORY_POSITION_QUERY_INVALID');
    const state = current, epoch = version;
    let client = null;
    const valid = () => {
      if (state?.publication !== publication || !original(state, epoch) || !live(state)
        || !original(state, epoch) || signal?.aborted) return false;
      const accepted = callerOwns() === true;
      return accepted && original(state, epoch) && !signal?.aborted && (!client || state.client === client);
    };
    check(valid, signal);
    // A queued FIRST registration stays queued until its exact retirement ACK.
    // A visible consumer cannot become an indefinite waiter on that ACK.
    if (state.status === 'pending' && (retiring || running && running !== state)) {
      // A superseded raw OPEN may not have reached its catch/retirement handoff
      // yet. Its original running slot is already an unresolved predecessor;
      // do not let a same-turn successor wait indefinitely on that raw ACK.
      throw Object.assign(unknown(), { positionRegistrationPending: true });
    }
    await waitFor(publication.promise, signal); check(valid, signal);
    if (state.status === 'failed') throw state.error;
    if (state.status !== 'ready' || !state.client) throw cancelled();
    client = state.client;
    if (!uuid) return null;
    counters.queries++;
    const result = await client.resolve(uuid, { owns: valid, signal, queryOwner });
    check(valid, signal);
    if (result?.kind === 'missing') return null;
    if (result?.kind !== 'found' || !Number.isSafeInteger(result.index) || result.index < 0
      || result.index >= state.unitCount || !Number.isSafeInteger(result.memberIndex)) throw fail('HISTORY_POSITION_RESULT_INVALID');
    if (state.source) {
      if (!Number.isSafeInteger(result.memberCount) || result.memberCount < 1
        || result.memberIndex < -1 || result.memberIndex === -1 && result.memberCount !== 1
        || result.memberIndex >= result.memberCount || typeof result.physicalKey !== 'string'
        || !result.entry || !result.entry.uuid || !sameValue(result.entry.uuid, uuid)) throw fail('HISTORY_POSITION_RESULT_INVALID');
      const address = Object.freeze({ owner: ownerIdentity, publication, index: result.index,
        memberIndex: result.memberIndex, memberCount: result.memberCount,
        kind: result.memberIndex === -1 ? 'entry' : 'group', physicalKey: result.physicalKey, uuid,
        entry: result.entry, selectedResult: result, selectedClient: client });
      if (!entryAt(address)) throw fail('HISTORY_POSITION_INPUT_CHANGED');
      check(valid, signal); return address;
    }
    const unit = state.units[result.index];
    const entry = unit?.kind === 'entry' && result.memberIndex === -1 ? unit.entry
      : unit?.kind !== 'entry' && Array.isArray(unit?.entries) && result.memberIndex >= 0
        ? unit.entries[result.memberIndex] : null;
    const physicalKey = state.itemKeys[result.index];
    if (!entry || !entry.uuid || !sameValue(entry.uuid, uuid) || typeof physicalKey !== 'string') throw fail('HISTORY_POSITION_RESULT_INVALID');
    const address = Object.freeze({ owner: ownerIdentity, publication, index: result.index,
      memberIndex: result.memberIndex, memberCount: unit.kind === 'entry' ? 1 : unit.entries.length,
      kind: unit.kind === 'entry' ? 'entry' : 'group', physicalKey, uuid, entry });
    if (!entryAt(address)) throw fail('HISTORY_POSITION_INPUT_CHANGED');
    check(valid, signal); return address;
  }
  function clear() {
    const old = current, oldQueued = queued, epoch = ++version; current = queued = null;
    detach(old); if (oldQueued && oldQueued !== old) detach(oldQueued);
    if (version === epoch) notify(epoch);
    // Consumer lifetime is settled now. Raw cleanup ownership remains bounded
    // and observable in `retiring`, including after dispose or later publish.
    return Promise.resolve();
  }
  return Object.freeze({ publish, capture: () => current?.publication || null, owns, entryAt, query,
    subscribeInvalidation(listener) {
      if (typeof listener !== 'function' || invalidationListeners.length >= 4) throw fail('HISTORY_POSITION_QUERY_LANE_LIMIT');
      invalidationListeners.push(listener);
      return () => { const index = invalidationListeners.indexOf(listener); if (index >= 0) invalidationListeners.splice(index, 1); };
    },
    clear, activate() { if (disposed) throw fail('HISTORY_POSITION_OWNER_DISPOSED'); },
    dispose() { disposed = true; return clear(); },
    stats() { return { ...counters, current: current ? 1 : 0, running: running ? 1 : 0,
      pending: queued ? 1 : 0, retiring: retiring ? 1 : 0, nativeCoordinateMaps: 0 }; },
  });
}

/** One selected demand per actual consumer. Neither supersession nor an
 * uncertain query cleanup ACK closes the shared coordinate publication. */
export function createHistoryPresentationPositionQuery(owner, { onError = () => {} } = {}) {
  if (!owner || typeof owner.query !== 'function') throw fail('HISTORY_POSITION_QUERY_OWNER_INVALID');
  const queryOwner = Object.freeze({});
  let selected = null, running = null, queued = null, disposed = false, unsubscribe = null, version = 0;
  const report = error => { try { onError(error); } catch {} };
  const original = (state, epoch = state?.version) => !disposed && version === epoch && selected === state && state !== null
    && state.status !== 'superseded' && !state.controller.signal.aborted && !state.signal?.aborted;
  const live = state => {
    const epoch = version;
    if (!original(state, epoch) || state.owns() !== true || !original(state, epoch)) return false;
    return owner.owns(state.publication) && original(state, epoch);
  };
  const settle = (state, status, address = null, error = null) => {
    if (state.status !== 'pending') return state;
    const finish = state.finish, detach = state.detach; state.finish = () => {}; state.detach = null;
    state.status = status; state.address = address; state.error = error;
    state.registrationBlocked = status === 'failed' && error?.positionRegistrationPending === true;
    state.owns = never; state.signal = null;
    finish(state); detach?.(); return state;
  };
  const cancel = state => {
    if (!state) return;
    const finish = state.finish, detach = state.detach; state.finish = () => {}; state.detach = null;
    state.status = 'superseded'; state.address = null; state.error = null;
    state.owns = never; state.signal = null;
    finish?.(state); detach?.(); state.controller.abort();
  };
  function drain() {
    if (running || !queued || disposed) return;
    const state = queued, epoch = version;
    let owned = false; try { owned = live(state); } catch {}
    if (!owned || !original(state, epoch)) { if (queued === state) queued = null; cancel(state); return; }
    queued = null; running = state;
    Promise.resolve().then(() => {
      check(() => live(state), state.controller.signal);
      return owner.query(state.publication, state.uuid, { signal: state.controller.signal, owns: () => live(state), queryOwner });
    }).then(address => {
      if (!live(state)) { cancel(state); return; }
      if (address && !owner.entryAt(address)) throw fail('HISTORY_POSITION_SELECTED_INVALID');
      if (!live(state)) { cancel(state); return; }
      settle(state, address ? 'ready' : 'absent', address);
    }).catch(error => {
      let owned = false; try { owned = live(state); } catch {}
      if (!owned || error?.code === 'HISTORY_READ_CANCELLED') cancel(state);
      else { settle(state, 'failed', null, error); report(error); }
    }).finally(() => { if (running === state) running = null; drain(); });
  }
  const superseded = (publication, uuid) => {
    const state = { status: 'superseded', publication, uuid, address: null, error: null };
    state.promise = Promise.resolve(state); return state;
  };
  function read(publication, uuid, { owns = always, signal } = {}) {
    if (!scalarKey(uuid)) throw fail('HISTORY_POSITION_QUERY_INVALID');
    const before = version, previous = selected;
    const unchanged = () => !disposed && version === before && selected === previous && !signal?.aborted;
    if (!publication || !unchanged() || !owner.owns(publication) || !unchanged()
      || owns() !== true || !unchanged() || owner.capture() !== publication || !unchanged()) return superseded(publication, uuid);
    // Render/useMemo factories do not subscribe. Only four actual consumers
    // reserve local lanes; a discarded StrictMode factory retains no graph.
    if (!unsubscribe) unsubscribe = owner.subscribeInvalidation(clear);
    if (!unchanged()) return superseded(publication, uuid);
    const same = previous?.publication === publication && sameValue(previous.uuid, uuid);
    if (same && previous.status !== 'pending' && previous.status !== 'superseded'
      && !(previous.registrationBlocked && publication.status === 'ready')) {
      if (previous.status === 'ready') {
        const entry = owner.entryAt(previous.address);
        if (!unchanged()) return superseded(publication, uuid);
        if (!entry) { previous.status = 'failed'; previous.address = null;
          previous.error = fail('HISTORY_POSITION_INPUT_CHANGED'); report(previous.error); }
      }
      return previous;
    }
    if (same && previous.status === 'pending' && previous.owns === owns && previous.signal === signal) return previous;
    let finish;
    const oldQueued = queued, oldRunning = running;
    const state = { publication, uuid, owns, signal, controller: new AbortController(), version: ++version,
      status: 'pending', address: null, error: null, detach: null,
      promise: new Promise(resolve => { finish = resolve; }), finish: value => finish(value) };
    selected = queued = state;
    if (signal) {
      const abort = () => cancel(state);
      state.detach = () => signal.removeEventListener('abort', abort);
      signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
    }
    cancel(previous); if (oldQueued && oldQueued !== previous) cancel(oldQueued);
    if (oldRunning && oldRunning !== previous && oldRunning !== oldQueued) cancel(oldRunning);
    if (original(state)) drain(); return state;
  }
  function clear() {
    const old = selected, oldQueued = queued, oldRunning = running; ++version; selected = queued = null;
    cancel(old); if (oldQueued && oldQueued !== old) cancel(oldQueued);
    if (oldRunning && oldRunning !== old && oldRunning !== oldQueued) cancel(oldRunning);
  }
  return Object.freeze({ read, async resolve(publication, uuid, options) { return read(publication, uuid, options).promise; },
    peek(publication, uuid) { const state = selected, epoch = version;
      return state?.publication === publication && sameValue(state.uuid, uuid) && state.status !== 'superseded'
        && owner.owns(publication) && original(state, epoch) ? state : null; },
    clear, dispose() { disposed = true; clear(); const stop = unsubscribe; unsubscribe = null; stop?.(); },
    stats() { return { selected: selected ? 1 : 0, running: running ? 1 : 0, pending: queued ? 1 : 0 }; },
  });
}
