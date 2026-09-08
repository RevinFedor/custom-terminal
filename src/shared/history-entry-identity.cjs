'use strict';

function historyEntryHasExactIdentity(entry, identity) {
  const exact = typeof identity === 'string' ? identity.trim() : '';
  if (!exact) return false;
  if (entry?.uuid === exact || entry?.sourceIdentity === exact) return true;
  return [entry?.sourceIdentityAliases, entry?.sourceUuidAliases].some((aliases) => (
    Array.isArray(aliases) && aliases.some((alias) => alias === exact)
  ));
}

module.exports = { historyEntryHasExactIdentity };
