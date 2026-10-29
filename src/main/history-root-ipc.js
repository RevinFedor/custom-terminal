'use strict';

// Long-lived read capabilities belong to an actual WebContents generation.
// Neither a renderer-supplied sender id nor a tab id can transfer that lease.
// This is installed on the existing transcript service, not another reader.
const { randomUUID } = require('node:crypto');
const { historyReadCancelled } = require('./history-read-control');
const fail = code => Object.assign(new Error(code), { code });
const READ_METHODS = new Set(['openHistoryRoot', 'openHistoryPayload', 'readHistoryRootPage',
  'forkHistoryRootLeaf', 'releaseHistoryRoot', 'historyInputDocument']);

function createHistoryRootIpcBridge({ reader, demands }) {
  if (!reader?.call || !demands?.run) throw fail('HISTORY_ROOT_READER_UNAVAILABLE');
  const owners = new Map();
  const retire = (sender, owner) => {
    if (owners.get(sender) !== owner) return;
    owners.delete(sender); owner.retired = true;
    sender.removeListener('destroyed', owner.destroy);
    sender.removeListener('render-process-gone', owner.destroy);
    sender.removeListener('did-start-navigation', owner.navigate);
    // Cleanup must not start/restart a reader. If the exact child is gone its
    // capabilities are gone too; UNKNOWN transport is never replay authority.
    reader.postWorkerEvent?.({ event: 'release-root-consumer', consumerKey: owner.key });
  };
  function ownerFor(sender) {
    if (!sender || typeof sender.on !== 'function' || typeof sender.removeListener !== 'function'
      || typeof sender.isDestroyed !== 'function' || sender.isDestroyed()) {
      throw fail('HISTORY_READ_DEMAND_OWNER_INVALID');
    }
    let owner = owners.get(sender);
    if (!owner) {
      owner = { key: randomUUID(), retired: false, destroy: null, navigate: null };
      owner.destroy = () => retire(sender, owner);
      owner.navigate = (_event, _url, inPlace, mainFrame) => {
        if (mainFrame === true && inPlace === false) retire(sender, owner);
      };
      owners.set(sender, owner);
      sender.on('destroyed', owner.destroy);
      sender.on('render-process-gone', owner.destroy);
      sender.on('did-start-navigation', owner.navigate);
    }
    return owner;
  }
  async function run(event, payload, method) {
    if (!READ_METHODS.has(method)) throw fail('HISTORY_ROOT_METHOD');
    const sender = event?.sender, owner = ownerFor(sender);
    let admitted, preparedRequestId, catalogRequestId, bodyRequestId;
    // Capture cleanup provenance before awaiting the reader. A malformed
    // response cannot name another prepared allocation (or shared parent).
    if (method === 'forkHistoryRootLeaf' && payload?.encoding === 'history-primary-prepared-presentation-v1') {
      preparedRequestId = payload.preparedRequestId;
      if (typeof preparedRequestId !== 'string'
        || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(preparedRequestId)) {
        throw fail('HISTORY_PRIMARY_PREPARED_VALIDATION_BINDING');
      }
    }
    if (method === 'forkHistoryRootLeaf' && payload?.encoding === 'history-primary-agent-catalog-v1') {
      catalogRequestId = payload.catalogRequestId;
      if (typeof catalogRequestId !== 'string'
        || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(catalogRequestId)) {
        throw fail('HISTORY_AGENT_CATALOG_BINDING');
      }
    }
    if (method === 'forkHistoryRootLeaf' && payload?.encoding === 'history-entry-body-borrow-v1') {
      bodyRequestId = payload.bodyRequestId;
      if (typeof bodyRequestId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(bodyRequestId)) throw fail('HISTORY_BODY_BINDING');
    }
    try { return await demands.run(event, payload || {}, async request => {
      if (bodyRequestId !== undefined && (request.encoding !== 'history-entry-body-borrow-v1'
        || request.bodyRequestId !== bodyRequestId)) throw fail('HISTORY_BODY_BINDING');
      if (owner.retired || sender.isDestroyed()) throw historyReadCancelled();
      if (preparedRequestId !== undefined && (request.encoding !== 'history-primary-prepared-presentation-v1'
        || request.preparedRequestId !== preparedRequestId)) throw fail('HISTORY_PRIMARY_PREPARED_VALIDATION_BINDING');
      if (catalogRequestId !== undefined && (request.encoding !== 'history-primary-agent-catalog-v1'
        || request.catalogRequestId !== catalogRequestId)) throw fail('HISTORY_AGENT_CATALOG_BINDING');
      // The process transport is private; overwrite any forged wire context.
      const result = await reader.call(method, { ...request, _historyRootConsumerKey: owner.key });
      // Reader admission precedes the registry's final consumer check. Keep
      // only the new capability receipt so that rejection in that small gap
      // cannot orphan a lease which the renderer never received.
      if (['openHistoryRoot', 'openHistoryPayload', 'forkHistoryRootLeaf'].includes(method)
        || method==='readHistoryRootPage'&&request.kind==='timeline-query'&&['document','retain'].includes(request.operation)
        || method === 'historyInputDocument' && request.operation === 'prepare') admitted = result;
      if (owner.retired || sender.isDestroyed()) {
        reader.postWorkerEvent?.({ event: 'release-root-consumer', consumerKey: owner.key });
        throw historyReadCancelled();
      }
      return result;
    }); } catch (error) {
      if (admitted?.success && !(bodyRequestId !== undefined && admitted.kind === 'unsupported')) {
        const d = preparedRequestId === undefined && catalogRequestId === undefined && bodyRequestId === undefined ? admitted.inputDocument : null;
        const capability = d ? { kind: 'input', documentId: d.documentId, ownerKey: d.ownerKey,
          sourceRevision: d.sourceRevision, sourceGeneration: d.sourceGeneration }
          : admitted.leaseId ? { kind: 'root', leaseId: admitted.leaseId, ownerKey: admitted.ownerKey,
            revision: admitted.revision, generation: admitted.generation,
            ...(bodyRequestId === undefined ? {} : { bodyRequestId }),
            ...(preparedRequestId === undefined ? {} : { preparedRequestId }),
            ...(catalogRequestId === undefined ? {} : { catalogRequestId }) } : null;
        if (capability) reader.postWorkerEvent?.({ event: 'release-root-result', consumerKey: owner.key, capability });
      }
      throw error;
    }
  }
  return Object.freeze({ run,
    close() { for (const [sender, owner] of owners) retire(sender, owner); },
    stats() { return { consumers: owners.size }; },
  });
}

module.exports = { createHistoryRootIpcBridge };
