import { historyPrimaryAddressMatchesCut } from './historyPrimaryPresentationAddress.mjs';
import { readHistoryPrimaryPanelAddress } from './historyPrimaryPanelBindings.mjs';

// One active navigation/anchor subject. A selected address can outlive its body
// window while its immutable header is held. A new header must prove it again.
// There is one running request and one REPLACEABLE pending request, not a chain
// of async helpers retaining every scroll target behind the reader's FIFO.
export function createHistoryPrimarySelectedAddress({
  read = readHistoryPrimaryPanelAddress, onError = () => {},
} = {}) {
  let selected = null, running = null, queued = null, disposed = false;
  const live = state => !disposed && selected === state && !state.signal?.aborted
    && !state.root.closed && state.root.header === state.header && state.owns() === true;
  const settled = (state, status, address = null, error = null) => {
    state.detachSignal?.(); state.detachSignal = null;
    state.status = status; state.address = address; state.error = error;
    state.finish(state); state.finish = () => {};
    return state;
  };
  const cancel = state => {
    if (!state) return;
    state.controller.abort();
    if (state.status === 'pending') settled(state, 'superseded');
  };
  const validAddress = (root, header, kind, identity, address) => !!address
    && historyPrimaryAddressMatchesCut(address, header)
    && Number.isSafeInteger(address.index) && address.index >= 0 && address.index < root.totalCount
    && (kind !== 'key' || address.physicalKey === identity);
  function drain() {
    if (running || !queued || disposed) return;
    const state = queued; queued = null;
    if (!live(state)) { settled(state, 'superseded'); return; }
    running = state;
    Promise.resolve().then(() => read(state.root, state.kind, state.identity, {
      signal: state.controller.signal, owns: () => live(state),
    })).then(result => {
      if (!live(state)) { settled(state, 'superseded'); return; }
      if (result.root !== state.root || result.header !== state.header) {
        throw Object.assign(new Error('HISTORY_PRIMARY_SELECTED_ADDRESS_CUT'),
          { code: 'HISTORY_PRIMARY_SELECTED_ADDRESS_CUT' });
      }
      if (result.address && !validAddress(state.root, state.header, state.kind, state.identity, result.address)) {
        throw Object.assign(new Error('HISTORY_PRIMARY_SELECTED_ADDRESS_INVALID'),
          { code: 'HISTORY_PRIMARY_SELECTED_ADDRESS_INVALID' });
      }
      settled(state, result.address ? 'ready' : 'absent', result.address);
    }).catch(error => {
      if (!live(state) || error?.code === 'HISTORY_READ_CANCELLED') settled(state, 'superseded');
      else { settled(state, 'failed', null, error); onError(error); }
    }).finally(() => {
      if (running === state) running = null;
      if (!live(state) && selected === state && state.status === 'pending') settled(state, 'superseded');
      drain();
    });
  }
  const same = (state, root, kind, identity) => state && state.root === root
    && state.header === root.header && state.kind === kind && state.identity === identity;
  const listen = state => {
    state.detachSignal?.(); state.detachSignal = null;
    if (!state.signal || state.status !== 'pending') return;
    const signal = state.signal, abort = () => cancel(state);
    signal.addEventListener('abort', abort, { once: true });
    state.detachSignal = () => signal.removeEventListener('abort', abort);
    if (signal.aborted) abort();
  };
  function select(root, kind, identity, { owns = () => true, signal, address = null } = {}) {
    if (disposed || !root?.header || root.closed || signal?.aborted || owns() !== true) {
      const state = { status: 'superseded', root, header: root?.header, kind, identity, address: null };
      state.promise = Promise.resolve(state); return state;
    }
    if (same(selected, root, kind, identity) && selected.status !== 'superseded') {
      // The read capability can be reused by a new current gesture. Position
      // authority still belongs to the caller and is checked after every await.
      selected.owns = owns; selected.signal = signal;
      listen(selected);
      return selected;
    }
    // Rebind the one active key directly from the new bounded window when it
    // is already proved there. Never relabel an old rank as a new-cut address.
    if (!address && selected?.root === root && selected.kind === 'key' && kind === 'key'
      && selected.identity === identity && selected.address) {
      const candidate = root.addressAt(selected.address.index);
      if (validAddress(root, root.header, kind, identity, candidate)) address = candidate;
    }
    cancel(selected); cancel(queued); if (running) running.controller.abort();
    let finish;
    const state = selected = { root, header: root.header, kind, identity, owns, signal,
      status: 'pending', address: null, error: null, controller: new AbortController(),
      promise: new Promise(resolve => { finish = resolve; }), finish: value => finish(value) };
    listen(state);
    if (address && validAddress(root, state.header, kind, identity, address)) {
      queued = null; return settled(state, 'ready', address);
    }
    queued = state; drain(); return state;
  }
  return Object.freeze({
    read: select,
    seed(root, kind, identity, address, options) { return select(root, kind, identity, { ...options, address }); },
    async resolve(root, kind, identity, options) { return select(root, kind, identity, options).promise; },
    async resolveKeyOrTarget(root, key, identity, options) {
      const header = root?.header;
      const fallback = () => same(selected, root, 'entry', identity) && selected.fallbackForKey === key;
      if (identity && fallback()) return select(root, 'entry', identity, options).promise;
      const request = key ? select(root, 'key', key, options) : null;
      const result = request ? await request.promise : null;
      if (result && result.status !== 'absent' || !identity) return result;
      // Absence of this one physical key is immutable only within the held
      // header. Remember its UUID fallback on the same selected subject so
      // later convergence frames do not re-run the absent-key query.
      if (root?.header !== header || request && selected !== request && !fallback()) {
        return { status: 'superseded', root, header, address: null };
      }
      const target = select(root, 'entry', identity, options);
      target.fallbackForKey = key;
      return target.promise;
    },
    peek(root, kind, identity) { return same(selected, root, kind, identity) && live(selected) ? selected : null; },
    clear() { cancel(selected); cancel(queued); running?.controller.abort(); selected = queued = null; },
    dispose() { disposed = true; cancel(selected); cancel(queued); running?.controller.abort(); selected = queued = null; },
    stats() { return { selected: selected ? 1 : 0, running: running ? 1 : 0, pending: queued ? 1 : 0 }; },
  });
}
