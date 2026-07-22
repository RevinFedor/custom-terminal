'use strict';

const AI_PROCESS_LOOKUP_STATUS = Object.freeze({
  FOUND: 'found',
  ABSENT: 'absent',
  UNKNOWN: 'unknown',
});

class AiProcessLookupError extends Error {
  constructor(message, options = {}) {
    super(message || 'AI process lookup failed', options.cause ? { cause: options.cause } : undefined);
    this.name = 'AiProcessLookupError';
    this.code = 'AI_PROCESS_LOOKUP_FAILED';
    this.tabId = options.tabId || null;
    this.expectedName = options.expectedName || null;
  }
}

function knownProcessLookup(matches, meta = {}) {
  if (!Array.isArray(matches)) {
    throw new TypeError('Process lookup must resolve to an array of matches');
  }
  return {
    status: matches.length > 0
      ? AI_PROCESS_LOOKUP_STATUS.FOUND
      : AI_PROCESS_LOOKUP_STATUS.ABSENT,
    matches,
    error: null,
    ...meta,
  };
}

function unknownProcessLookup(error, meta = {}) {
  const lookupError = error?.code === 'AI_PROCESS_LOOKUP_FAILED'
    ? error
    : new AiProcessLookupError(error?.message || String(error || 'AI process lookup failed'), {
      cause: error instanceof Error ? error : undefined,
      tabId: meta.tabId,
      expectedName: meta.expectedName,
    });
  return {
    status: AI_PROCESS_LOOKUP_STATUS.UNKNOWN,
    matches: [],
    error: lookupError,
    ...meta,
  };
}

async function inspectProcessLookup(query, meta = {}) {
  try {
    return knownProcessLookup(await query(), meta);
  } catch (error) {
    return unknownProcessLookup(error, meta);
  }
}

function requireKnownProcessLookup(result) {
  if (!result || result.status === AI_PROCESS_LOOKUP_STATUS.UNKNOWN) {
    throw result?.error || new AiProcessLookupError('AI process lookup result is unknown');
  }
  return result.matches;
}

async function inspectProcessLookupCached({
  cache,
  key,
  maxAgeMs,
  now,
  query,
  meta = {},
}) {
  const readNow = typeof now === 'function' ? now : Date.now;
  const at = readNow();
  const cached = cache?.get?.(key);
  if (cached && Array.isArray(cached.matches) && (at - cached.at) < maxAgeMs) {
    return knownProcessLookup(cached.matches, { ...meta, source: 'cache' });
  }

  const result = await inspectProcessLookup(query, { ...meta, source: 'query' });
  // Unknown is deliberately not cached. A transient observer failure must not
  // become a two-second authoritative "no process" answer for every caller.
  if (result.status !== AI_PROCESS_LOOKUP_STATUS.UNKNOWN) {
    cache?.set?.(key, { at: readNow(), matches: result.matches });
  }
  return result;
}

function decideCodexExitProbe(result) {
  if (result?.status === AI_PROCESS_LOOKUP_STATUS.FOUND) return 'keep-alive';
  if (result?.status === AI_PROCESS_LOOKUP_STATUS.ABSENT) return 'finalize';
  return 'retry';
}

function resolveProcessPresence(result, { established = false } = {}) {
  if (result?.status === AI_PROCESS_LOOKUP_STATUS.FOUND) {
    return { present: true, lookupUnknown: false, error: null };
  }
  if (result?.status === AI_PROCESS_LOOKUP_STATUS.ABSENT) {
    return { present: false, lookupUnknown: false, error: null };
  }
  return {
    present: established === true,
    lookupUnknown: true,
    error: result?.error || new AiProcessLookupError('AI process lookup result is unknown'),
  };
}

module.exports = {
  AI_PROCESS_LOOKUP_STATUS,
  AiProcessLookupError,
  decideCodexExitProbe,
  inspectProcessLookup,
  inspectProcessLookupCached,
  knownProcessLookup,
  requireKnownProcessLookup,
  resolveProcessPresence,
  unknownProcessLookup,
};
