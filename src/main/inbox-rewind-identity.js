'use strict';
const { historyEntryHasExactIdentity } = require('../shared/history-entry-identity.cjs');

// The accepted send owns the rewind target. Neither visible text nor a local
// message index authorizes a mutation of the provider transcript.
function resolveInboxRewindTarget(entries, audit, requested = {}) {
  const identity = audit?.sourceIdentity || audit?.entryUuid;
  if (!identity) return { ok: false, code: 'external_run_rewind_target_unavailable' };
  const matches = (Array.isArray(entries) ? entries : []).filter((entry) => (
    !entry?.serviceCarrier
    && (entry?.type === 'user' || entry?.role === 'user' || entry?.kind === 'user')
    && historyEntryHasExactIdentity(entry, identity)
  ));
  if (matches.length !== 1) return { ok: false, code: 'external_run_rewind_identity_unresolved' };
  const entry = matches[0];
  if ([requested.entryUuid, requested.sourceIdentity].some((value) => value && !historyEntryHasExactIdentity(entry, value))) {
    return { ok: false, code: 'external_run_rewind_identity_mismatch' };
  }
  return { ok: true, entry };
}

module.exports = { resolveInboxRewindTarget };
