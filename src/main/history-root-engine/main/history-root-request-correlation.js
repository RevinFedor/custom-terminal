'use strict';

// Diagnostic vocabulary only. These fields never select a queue, authenticate
// a capability, or carry a node token/body into the request log.
const methods = new Set(['readHistoryRootPage', 'forkHistoryRootLeaf', 'releaseHistoryRoot']);
const kinds = new Set(['range', 'fields', 'leaf', 'rowWindow', 'find', 'projection', 'timeline-query']);
const operations = new Set(['offset', 'window', 'resolve', 'row', 'annotation', 'group', 'range',
  'status', 'measure', 'resize', 'document', 'retain', 'iteration', 'neighbour', 'note-neighbour']);
const encodings = new Set(['text', 'v8-base64']);
function historyRootRequestCorrelation(method, payload) {
  if (!methods.has(method) || !payload || typeof payload !== 'object') return {};
  const result = {};
  if (typeof payload.leaseId === 'string' && payload.leaseId.length === 36
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(payload.leaseId)) {
    result.rootLeaseId = payload.leaseId;
  }
  if (method === 'readHistoryRootPage' && kinds.has(payload.kind)) {
    result.rootReadKind = payload.kind;
    if (payload.kind === 'timeline-query' && operations.has(payload.operation)) {
      result.rootReadOperation = payload.operation;
    }
  }
  if (method === 'forkHistoryRootLeaf' && encodings.has(payload.encoding)) {
    result.rootReadEncoding = payload.encoding;
  }
  return result;
}
module.exports = { historyRootRequestCorrelation };
