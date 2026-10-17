'use strict';

// The shared layout store owns its synchronous CAS/autocommit. Observe the
// existing public put result; notification failure must not change its receipt.
const attached = new WeakMap();

function observeCommittedPromptLayouts(store, onCommitted, onNotificationError = () => {}) {
  if (!store || typeof store.put !== 'function' || typeof onCommitted !== 'function') {
    throw new TypeError('layout store and commit observer required');
  }
  attached.get(store)?.close();
  const original = store.put;
  let active = true;
  function observedPut(...args) {
    const result = original.apply(this, args);
    if (active && result?.ok === true) {
      try { onCommitted(args[0], result.revision); }
      catch (error) {
        try { onNotificationError(error); } catch { /* preserve committed receipt */ }
      }
    }
    return result;
  }
  const observation = {
    close() {
      if (!active) return;
      active = false;
      if (store.put === observedPut) store.put = original;
      if (attached.get(store) === observation) attached.delete(store);
    },
  };
  store.put = observedPut;
  attached.set(store, observation);
  return observation;
}

module.exports = { observeCommittedPromptLayouts };
