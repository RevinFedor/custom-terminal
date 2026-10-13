import { EMPTY_DISK_CAPACITY, diskCapacityPresentation } from '../utils/diskCapacityPresentation.mjs';

// One IPC lease and one freshness deadline per renderer, not per component copy.
export function createDiskCapacityStore({ ipc, now = Date.now,
  setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout } = {}) {
  let snapshot = EMPTY_DISK_CAPACITY, timer = null, generation = 0, token = null, receiver = null;
  const listeners = new Set();
  const clearTimer = () => { if (timer !== null) clearTimeoutFn(timer); timer = null; };
  const publish = next => { snapshot = Object.freeze(next); for (const listener of listeners) listener(); };
  const accept = (value, owner) => {
    if (generation !== owner || !listeners.size) return;
    if (value?.epoch && value.epoch === snapshot.epoch && value.revision < snapshot.revision) return;
    clearTimer();
    const state = diskCapacityPresentation(value, now());
    publish(state === 'error' && value?.status === 'ready'
      ? { ...EMPTY_DISK_CAPACITY, status: 'error', errorCode: 'invalid-measurement' }
      : { ...value, status: state === 'stale' ? 'stale' : value?.status || 'unknown',
        ...(state === 'stale' ? { warning: null } : {}) });
    const expiry = value?.status === 'ready' ? value.expiresAt : value?.ram?.expiresAt;
    if (expiry > now()) {
      timer = setTimeoutFn(() => { timer = null;
        if (generation === owner && listeners.size) publish({ ...snapshot,
          status: snapshot.status === 'error' ? 'error' : 'stale', warning: null,
          ...(snapshot.ram ? { ram: { ...snapshot.ram, status: 'stale' } } : {}) });
      }, expiry - now());
    }
  };
  const start = () => {
    const owner = ++generation;
    token = `disk-${now()}-${owner}`;
    if (diskCapacityPresentation(snapshot, now()) === 'stale') snapshot = { ...snapshot, status: 'stale', warning: null };
    let received = false;
    receiver = (_event, value) => { received = true; accept(value, owner); };
    const unavailable = () => { if (!received) accept({ ...EMPTY_DISK_CAPACITY, status: 'error', errorCode: 'ipc-unavailable' }, owner); };
    ipc.on('system:disk-capacity', receiver);
    try {
      Promise.resolve(ipc.invoke('system:disk-capacity-subscribe', token))
        .then(value => accept(value, owner), unavailable);
    } catch { unavailable(); }
  };
  const stop = () => {
    ++generation;
    clearTimer();
    ipc.removeListener('system:disk-capacity', receiver);
    receiver = null;
    const previousToken = token; token = null;
    try { Promise.resolve(ipc.invoke('system:disk-capacity-unsubscribe', previousToken)).catch(() => {}); } catch {}
  };
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      if (listeners.size === 1) start();
      return () => { if (listeners.delete(listener) && !listeners.size) stop(); };
    },
  };
}
