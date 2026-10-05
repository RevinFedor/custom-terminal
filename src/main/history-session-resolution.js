'use strict';

function failure(code, message, diagnostics, status = 409) {
  return Object.assign(new Error(message), { code, status, diagnostics });
}

function forkProofSummary(fork) {
  if (!fork) return null;
  return {
    provider: fork.provider || null,
    sourceSessionId: fork.sourceSessionId || null,
    childSessionId: fork.childSessionId || null,
    forkMode: fork.forkMode || 'unknown',
    origin: fork.origin || null,
    snapshotComplete: fork.snapshotComplete === true,
    entryUuidCount: Array.isArray(fork.entryUuids) ? fork.entryUuids.length : 0,
    boundaryEntryUuid: fork.boundaryEntryUuid || null,
    manifestDigest: fork.lineageManifest?.manifestDigest || null,
    sourceSegmentCount: fork.lineageManifest?.sourceSegments?.length || 0,
    // A relation alone is not authority to concatenate a parent and child.
    boundaryRecorded: fork.snapshotComplete === true || !!fork.lineageManifest?.manifestDigest,
  };
}

async function resolveHistorySession({ sessionId, cwd = null, provider = null }, { getBindings, getFork, resolveFiles, resolveLegacyCodexFile }) {
  const bindings = await getBindings(sessionId);
  const fork = await getFork(sessionId);
  const claims = [...new Set([
    ...(bindings || []).map(row => row.provider), fork?.provider,
  ].filter(value => value === 'claude' || value === 'codex'))];
  const expected = provider || (claims.length === 1 ? claims[0] : null);
  const lookup = await resolveFiles({ sessions: ['claude', 'codex'].map(tool => ({
    provider: tool, sessionId, cwd,
  })) });
  const sources = (lookup.results || []).map(row => ({
    provider: row.provider, state: row.state, reason: row.reason, location: row.location,
    filePath: row.filePath || null,
  }));
  if (expected !== 'claude' && !sources.some(row => row.provider === 'codex' && row.filePath) && resolveLegacyCodexFile) {
    const legacy = await resolveLegacyCodexFile(sessionId, cwd);
    if (legacy?.filePath) sources.push({ provider: 'codex', state: 'available', reason: 'canonical-metadata-lookup', location: 'active', filePath: legacy.filePath });
  }
  const found = sources.filter(row => row.filePath && ['available', 'archived', 'partial'].includes(row.state));
  const diagnostics = { sessionId, requestedCwd: cwd, expectedProvider: expected,
    catalogProviders: claims, bindings: (bindings || []).slice(0, 20), bindingCount: bindings?.length || 0,
    bindingsTruncated: (bindings?.length || 0) > 20, sources, fork: forkProofSummary(fork),
    lookup: 'shared-session-availability', parentSubstitution: false };
  if (claims.length > 1 || (provider && claims.length && !claims.includes(provider)) || found.length > 1) {
    throw failure('history_provider_ambiguous', 'Session provider identity is ambiguous', diagnostics);
  }
  if (found.length === 1 && expected && found[0].provider !== expected) {
    throw failure('history_provider_conflict', 'Transcript provider conflicts with the saved session identity', diagnostics);
  }
  if (!found.length) {
    const uncertain = sources.some(row => row.state === 'unknown');
    throw failure(uncertain ? 'history_source_unavailable' : 'history_source_missing',
      uncertain ? 'Session source could not be inspected' : `${expected || 'Claude/Codex'} session source not found`,
      diagnostics, uncertain ? 503 : 404);
  }
  return { ...found[0], sessionId, diagnostics };
}

function historyReadError(error) {
  return {
    error: String(error?.message || error),
    ...(error?.code ? { code: error.code } : {}),
    ...(error?.lineageReason ? { lineageReason: error.lineageReason } : {}),
    ...(error?.diagnostics ? { diagnostics: error.diagnostics } : {}),
  };
}

module.exports = { resolveHistorySession, forkProofSummary, historyReadError };
