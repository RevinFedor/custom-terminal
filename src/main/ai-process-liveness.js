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

const latestCacheQueries = new WeakMap();

async function inspectProcessLookupCached({
  cache,
  key,
  maxAgeMs,
  now,
  query,
  meta = {},
  scope = null,
  isScopeCurrent = null,
}) {
  const readNow = typeof now === 'function' ? now : Date.now;
  const at = readNow();
  const cached = cache?.get?.(key);
  const current = value => typeof isScopeCurrent !== 'function' || isScopeCurrent(value) === true;
  const stale = () => unknownProcessLookup(new Error('process lookup owner changed'), { ...meta, reason: 'process_scope_changed' });
  if (!current(scope)) return stale();
  if (cached && Array.isArray(cached.matches) && (at - cached.at) < maxAgeMs && current(cached.scope)) {
    return knownProcessLookup(cached.matches, { ...meta, source: 'cache' });
  }
  let pending = cache && latestCacheQueries.get(cache);
  if (!pending && cache) { pending = new Map(); latestCacheQueries.set(cache, pending); }
  const queryToken = {};
  pending?.set(key, queryToken);
  try {
    const result = await inspectProcessLookup(query, { ...meta, source: 'query' });
    if (!current(scope)) return stale();
    // Unknown is never cached. A late old query cannot republish proof for a
    // replaced owner or overwrite a more recent completed query of this key.
    if (result.status !== AI_PROCESS_LOOKUP_STATUS.UNKNOWN && pending?.get(key) === queryToken) {
      cache?.set?.(key, { at: readNow(), matches: result.matches, scope });
    }
    return result;
  } finally {
    if (pending?.get(key) === queryToken) pending.delete(key);
  }
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

function resolveClaudeRuntimeAfterFailedStop({
  claudeTurnBusy = false,
  claudePromptReady = false,
} = {}) {
  // A failed process lookup preserves the established runtime, but it does
  // not make the glyph spinner authoritative. Public Claude busy state is
  // owned exclusively by the Stop-hook turn flag.
  const busy = claudeTurnBusy === true;
  const inputReady = claudePromptReady === true || busy;
  return {
    sessionStatus: busy ? 'busy' : (inputReady ? 'active' : 'starting'),
    busy,
    inputReady,
  };
}

function selectAiProcessForStop(matches) {
  if (!Array.isArray(matches)) return null;

  const candidates = matches.filter((match) => {
    const pid = Number(match?.pid);
    const depth = Number(match?.depth);
    const processName = String(match?.processName || '');
    return Number.isInteger(pid)
      && pid > 0
      && Number.isInteger(depth)
      && depth > 0
      && (processName === 'claude' || processName === 'gemini' || processName === 'codex');
  });

  // Preserve the historical Stop contract: a direct AI child of the tab's
  // shell wins, in ps/PID order. Codex alone supports a nested fallback
  // because its install layouts may insert a node/vendor wrapper.
  const direct = candidates
    .filter((match) => Number(match.depth) === 1)
    .sort((a, b) => Number(a.pid) - Number(b.pid))[0];
  if (direct) return direct;

  return candidates
    .filter((match) => Number(match.depth) > 1 && match.processName === 'codex')
    .sort((a, b) => Number(a.depth) - Number(b.depth) || Number(a.pid) - Number(b.pid))[0]
    || null;
}

/**
 * Build the exact process scope owned by one selected AI process.
 *
 * A Stop must not end at the Claude/Codex parent while leaving a tool command
 * (for example `sleep`, a shell, or a language server) orphaned behind it.
 * Process groups are used only when their leader is itself inside the proven
 * descendant tree. Everything not covered by such a group remains an explicit
 * PID target, so missing/odd PGID data degrades safely to the observed tree.
 */
function buildAiStopScope({
  candidate,
  children,
  shellPid,
} = {}) {
  const rootPid = Number(candidate?.pid);
  if (!Number.isInteger(rootPid) || rootPid <= 0) return null;

  const members = [{
    pid: rootPid,
    ppid: Number(candidate?.ppid) || null,
    pgid: Number(candidate?.pgid) || null,
    depth: 0,
  }];
  const seen = new Set([rootPid]);
  const stack = [{ pid: rootPid, depth: 0 }];

  while (stack.length > 0) {
    const current = stack.pop();
    const descendants = children instanceof Map
      ? (children.get(current.pid) || children.get(String(current.pid)) || [])
      : [];
    for (const child of descendants) {
      const pid = Number(child?.pid);
      if (!Number.isInteger(pid) || pid <= 0 || seen.has(pid)) continue;
      seen.add(pid);
      const member = {
        pid,
        ppid: Number(child?.ppid) || current.pid,
        pgid: Number(child?.pgid) || null,
        depth: current.depth + 1,
      };
      members.push(member);
      stack.push({ pid, depth: member.depth });
    }
  }

  // Deepest jobs first. A group is safe only when its leader is a proven
  // member of this AI subtree; this prevents a malformed PGID from targeting
  // the terminal shell or another tab's foreground job.
  const normalizedShellPid = Number(shellPid);
  const processGroups = members
    .filter((member) => member.pgid === member.pid
      && member.pgid > 1
      && member.pgid !== normalizedShellPid)
    .sort((a, b) => b.depth - a.depth || b.pid - a.pid)
    .map((member) => member.pgid);
  const groupSet = new Set(processGroups);
  const signalPids = members
    .filter((member) => !groupSet.has(member.pgid))
    .sort((a, b) => b.depth - a.depth || b.pid - a.pid)
    .map((member) => member.pid);

  return {
    rootPid,
    processGroups,
    signalPids,
    trackedPids: members
      .slice()
      .sort((a, b) => b.depth - a.depth || b.pid - a.pid)
      .map((member) => member.pid),
  };
}

module.exports = {
  AI_PROCESS_LOOKUP_STATUS,
  AiProcessLookupError,
  buildAiStopScope,
  decideCodexExitProbe,
  inspectProcessLookup,
  inspectProcessLookupCached,
  knownProcessLookup,
  requireKnownProcessLookup,
  resolveClaudeRuntimeAfterFailedStop,
  resolveProcessPresence,
  selectAiProcessForStop,
  unknownProcessLookup,
};
