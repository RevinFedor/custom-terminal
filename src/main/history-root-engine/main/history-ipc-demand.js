'use strict';

// Demand belongs to one renderer request, never to the session or its writer.
// The sender object (not a renderer-supplied sender id) is the cancellation scope.
const { randomUUID } = require('node:crypto');
const { createReadControl, currentReadControl, withReadControl,
  historyReadCancelled } = require('./history-read-control');

function createHistoryIpcDemands() {
  const owners = new Map();
  const validId = id => typeof id === 'string' && /^[a-zA-Z0-9:_-]{1,128}$/.test(id);
  function retire(sender, owner) {
    if (owner.reads.size || owners.get(sender) !== owner) return;
    sender?.removeListener?.('destroyed', owner.destroyed);
    sender?.removeListener?.('render-process-gone', owner.destroyed);
    sender?.removeListener?.('did-start-navigation', owner.navigation);
    owners.delete(sender);
  }
  function cancel(event, payload = {}) {
    if (!validId(payload.readDemandId)) return false;
    const lease = owners.get(event?.sender)?.reads.get(payload.readDemandId);
    if (!lease) return false;
    lease.controller.abort(historyReadCancelled('renderer-demand-revoked'));
    return true;
  }
  function run(event, payload = {}, operation) {
    const sender = event?.sender;
    if (!sender || typeof sender.on !== 'function' || typeof sender.removeListener !== 'function'
      || typeof sender.isDestroyed !== 'function') return Promise.reject(Object.assign(
      new Error('History demand sender unavailable'), { code: 'HISTORY_READ_DEMAND_OWNER_INVALID' }));
    if (sender?.isDestroyed?.()) return Promise.reject(historyReadCancelled('renderer-destroyed'));
    const id = payload.readDemandId == null ? randomUUID() : payload.readDemandId;
    if (!validId(id)) return Promise.reject(Object.assign(new Error('Invalid History demand id'),
      { code: 'HISTORY_READ_DEMAND_INVALID' }));
    let owner = owners.get(sender);
    if (!owner) {
      owner = { reads: new Map(), destroyed: null, navigation: null };
      owner.destroyed = () => {
        for (const lease of owner.reads.values()) lease.controller.abort(historyReadCancelled('renderer-destroyed'));
      };
      owner.navigation = (_event, _url, isInPlace, isMainFrame) => {
        if (isMainFrame === true && isInPlace === false) owner.destroyed();
      };
      owners.set(sender, owner);
      sender?.on?.('destroyed', owner.destroyed);
      sender?.on?.('render-process-gone', owner.destroyed);
      sender?.on?.('did-start-navigation', owner.navigation);
    }
    if (owner.reads.has(id)) return Promise.reject(Object.assign(new Error('History demand id already active'),
      { code: 'HISTORY_READ_DEMAND_CONFLICT' }));
    const controller = new AbortController();
    const parent = currentReadControl();
    const control = parent?.forkSignal?.(controller.signal) || createReadControl({ signal: controller.signal });
    const parentAbort = () => controller.abort(historyReadCancelled('parent-demand-revoked'));
    parent?.signal?.addEventListener('abort', parentAbort, { once: true });
    if (parent?.signal?.aborted || sender?.isDestroyed?.()) parentAbort();
    owner.reads.set(id, { controller }); // before the first callback/await
    // Cancellation ids do not enter business fingerprints, provider DTOs or revisions.
    const { readDemandId, ...request } = payload;
    return Promise.resolve().then(() => withReadControl(control, async () => {
      control.assertCurrent();
      const result = await operation(request);
      control.assertCurrent();
      return result;
    })).finally(() => {
      parent?.signal?.removeEventListener('abort', parentAbort);
      owner.reads.delete(id);
      control.finish();
      retire(sender, owner);
    });
  }
  function stats() {
    let reads = 0;
    for (const owner of owners.values()) reads += owner.reads.size;
    return { owners: owners.size, reads };
  }
  return Object.freeze({ run, cancel, stats });
}

const historyIpcDemands = createHistoryIpcDemands();
module.exports = { createHistoryIpcDemands, historyIpcDemands };
