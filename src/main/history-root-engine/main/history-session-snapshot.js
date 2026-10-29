'use strict';

const CAPABILITY = Object.freeze({ version: 1, providers: ['codex'], maxIterations: 8, maxChars: 20000,
  endpoint: '/overseer/session/:sessionId/snapshot', consistency: 'verified-prefix', completeRecordsOnly: true,
  lineageRead: 'physical-or-prepared-view',
  decodeLimits: require('./codex-catalog-search').SNAPSHOT_LIMITS });

function normalizeSessionSnapshotRequest(value = {}) {
  if (Object.keys(value).some(key => !['sessionId', 'cwd', 'tabId', 'limit', 'maxChars'].includes(key))
    || typeof value.sessionId !== 'string' || !value.sessionId.trim() || value.sessionId.length > 512
    || value.cwd != null && (typeof value.cwd !== 'string' || !value.cwd || value.cwd.length > 4096)
    || value.tabId != null && (typeof value.tabId !== 'string' || !value.tabId || value.tabId.length > 512)
    || value.limit != null && (!Number.isInteger(value.limit) || value.limit < 1 || value.limit > CAPABILITY.maxIterations)
    || value.maxChars != null && (!Number.isInteger(value.maxChars) || value.maxChars < 0 || value.maxChars > CAPABILITY.maxChars)) {
    throw Object.assign(new Error('invalid_session_snapshot_request'), { statusCode: 400, code: 'invalid_session_snapshot_request' });
  }
  return { sessionId: value.sessionId, cwd: value.cwd || null, tabId: value.tabId || null,
    limit: value.limit ?? 5, maxChars: value.maxChars ?? 4000 };
}

async function readSessionSnapshot(value, { resolve, captureOwner, captureRuntime, read, assertCurrent }) {
  const request = normalizeSessionSnapshotRequest(value), requestedAt = new Date().toISOString();
  const owner = captureOwner(request), resolved = await resolve(request);
  if (resolved.provider !== 'codex') throw Object.assign(new Error('session_snapshot_provider_unsupported'),
    { statusCode: 400, code: 'session_snapshot_provider_unsupported' });
  const runtimeObservedAt = new Date().toISOString(), runtime = captureRuntime(request);
  const result = await read(request);
  if (!result?.success) throw Object.assign(new Error(result?.error || 'session_snapshot_unavailable'),
    { code: result?.error || 'session_snapshot_unavailable' });
  if (owner !== captureOwner(request)) throw Object.assign(new Error('Session owner changed during snapshot'),
    { code: 'CODEX_SOURCE_READ_INVALIDATED' });
  assertCurrent(result);
  return { ...result, requestedAt, readOnly: true, consistency: CAPABILITY.consistency,
    completionAuthority: false, runtime: { ...runtime, observedAt: runtimeObservedAt },
    entries: result.entries.map(entry => ({ ...entry, isLatest: entry.iterationIndex === result.totalIterations - 1,
      isCurrent: entry.iterationIndex === result.totalIterations - 1
        && result.coverage.trailingPartialBytes === 0 && runtime?.known === true
        && runtime.liveLifecycle === true && ['active', 'idle', 'busy'].includes(runtime.status)
        && runtime.sessionId === request.sessionId && !!entry.turnId && runtime.turnId === entry.turnId })) };
}

module.exports = { SESSION_SNAPSHOT_CAPABILITY: CAPABILITY, normalizeSessionSnapshotRequest, readSessionSnapshot };
