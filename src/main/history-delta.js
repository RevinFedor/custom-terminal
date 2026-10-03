'use strict';
const crypto = require('node:crypto');

// History delta: ship only changed rows to a renderer that already holds the
// previous projection.
//
// A live Codex session appends a few records per turn, but the refresh path
// used to rebuild the WHOLE projection and clone every row over IPC — 15,352
// rows / ~70MB of presentation for one appended tool result (tab-3163, live
// 06.08 11:37: LOAD_APPLY 4733ms right at switch+scroll start). The renderer
// then deep-compared all rows (JSON.stringify per action) to keep stable
// references for memoized cards.
//
// The delta contract inverts that: main keeps a compact digest of what it
// last sent to a given (session, tab) — the ordered uuid list plus one cheap
// fingerprint per row — and when the renderer proves it still holds that
// exact revision, the response carries only the rows whose fingerprint moved
// plus the new order. Unchanged rows keep their EXACT old object references
// on the renderer by construction, so per-row deep equality never runs.
//
// Why fingerprints and not a suffix: the projection is append-MOSTLY, not
// append-only. A function_call materialized in-flight is later enriched with
// its output under the same uuid; a subagent Task card spawned thousands of
// rows ago flips to completed by a record at the tail; thread_rolled_back
// removes turns. Mutations reach arbitrarily far back, so change detection
// must look at every row — but looking is O(1) per row, and only genuinely
// changed rows are serialized.
//
// Immutable message text uses a bounded sample. Mutable Task results and
// structured metadata need full witnesses; payload refs also name the physical
// producer record so equal previews cannot conceal a changed result. This is
// presentation freshness, not cross-file integrity: a rewrite additionally
// needs the writer's exact record mapping and full row/dependency checks.

const SEP = '\u0000';

/** cyrb53 — fast 53-bit string hash (public domain). */
function cyrb53(str, seed = 0) {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

/** Bounded witness for a possibly-huge string: O(1) regardless of length. */
function sampleText(value) {
  if (typeof value !== 'string' || value.length === 0) return '';
  if (value.length <= 56) return value;
  return value.length + SEP + value.slice(0, 24) + SEP + value.slice(-24);
}

function sampleValue(value) {
  if (value == null) return '';
  if (typeof value === 'string') return sampleText(value);
  try {
    // Bounded: chips/tags/refs are small arrays. Never used for args/results.
    const serialized = JSON.stringify(value);
    return serialized.length <= 56 ? serialized
      : crypto.createHash('sha256').update(serialized).digest('hex');
  } catch {
    return 'unserializable';
  }
}

// Args are parsed from immutable rollout lines: for a given call identity
// they change only when the projection replaces the whole action shape
// (canonical patch actions, humanized names) — and those swaps also change
// toolName or diffHunks, which are witnessed. Serializing args here would
// re-stringify every Write/Edit body on every refresh; a structural count
// is enough.
function argsWitness(args) {
  if (!args || typeof args !== 'object') return String(args ?? '');
  return String(Object.keys(args).length);
}

const taskResultWitnesses = new WeakMap();
function taskResultWitness(action) {
  const previous = taskResultWitnesses.get(action);
  if (previous && typeof action.result === 'string' && previous.value === action.result) return previous.witness;
  let serialized;
  try { serialized = typeof action.result === 'string' ? action.result : JSON.stringify(action.result ?? null) || ''; }
  catch { return 'unserializable'; }
  const witness = crypto.createHash('sha256').update(serialized).digest('hex');
  if (typeof action.result === 'string') taskResultWitnesses.set(action, { value: action.result, witness });
  return witness;
}

function fingerprintAction(action) {
  if (!action || typeof action !== 'object') return String(action ?? '');
  if (action.actionRef) return JSON.stringify(action); // bounded on-demand header + exact body hash
  if (action.tool === '__raw__') {
    const raw = action.rawTool || {};
    // Per-hunk coordinates matter: a late patch_apply_end swaps heuristic
    // line numbers for real ones without changing row counts.
    const hunks = Array.isArray(raw.diffHunks)
      ? raw.diffHunks.map((hunk) => (
          (hunk?.oldStart ?? '-') + ':' + (hunk?.newStart ?? '-') + ':'
          + (Array.isArray(hunk?.entries) ? hunk.entries.length : 0)
        )).join(',')
      : '-';
    return ['__raw__', raw.toolUseId || '', raw.toolName || '',
      sampleText(typeof raw.result === 'string' ? raw.result : sampleValue(raw.result)),
      raw.isError ? '1' : '0',
      raw.resultRef ? raw.resultRef.payloadId + ':' + raw.resultRef.totalChars + ':' + (raw.resultRef.recordLine ?? '') : '-',
      String(raw.resultSourceLine ?? ''),
      raw.backgroundStatus || '-',
      hunks, argsWitness(raw.args),
    ].join(SEP);
  }
  if (action.tool === 'Task') {
    return ['Task', action.toolUseId || '', action.description || '',
      action.subagentStatus || '', taskResultWitness(action),
      action.agentSessionId || '', action.processGeneration || '',
      action.startedAt || '', action.completedAt || '', action.durationMs || '',
    ].join(SEP);
  }
  return sampleValue(action);
}

/**
 * One cheap presentation witness per entry. Covers exactly the mutable
 * surface the renderer presents (mirror of historyEntryPresentationEqual on
 * the renderer side); a field missing here means a mutation of that field
 * would NOT reach an already-delivered renderer row until the next full load.
 */
function fingerprintHistoryEntry(entry) {
  if (!entry || typeof entry !== 'object') return cyrb53('null');
  // A stub contains only identity and grouping metadata. Its whole small
  // shape is observable: dropping actionSummary/hasThinking/etc. from the
  // witness can change grouping without updating a retained renderer row.
  if (entry.rowStub === true) return cyrb53('stub' + SEP + JSON.stringify(entry));
  const parts = [
    entry.role || '', entry.timestamp || '', sampleText(entry.content || ''),
    entry.textPhase || '', String(entry.thinkingSeconds ?? ''),
    String(entry.postTokens ?? ''), entry.compactEncrypted ? '1' : '0',
    sampleText(entry.thinking || ''),
    entry.thinkingRef ? entry.thinkingRef.payloadId + ':' + entry.thinkingRef.totalChars + ':' + (entry.thinkingRef.recordLine ?? '') + ':' + (entry.thinkingRef.contentHash || '') : '-',
    sampleText(entry.compactSummary || ''),
    entry.compactSummaryRef ? entry.compactSummaryRef.payloadId + ':' + entry.compactSummaryRef.totalChars + ':' + (entry.compactSummaryRef.recordLine ?? '') + ':' + (entry.compactSummaryRef.contentHash || '') : '-',
    String(entry.sourceRecordLine ?? ''),
    sampleValue(entry.sourceIdentityAliases), sampleValue(entry.sourceUuidAliases),
    sampleValue(entry.promptPresentationAuditAliases),
    entry.promptPresentationAuditTimestamp || '', entry.promptPresentationTransportHash || '',
    String(entry.preTokens ?? ''), entry.queueStatus || '', entry.deliveryStatus || '',
    entry.statusReason || '', String(entry.statusChangedAt ?? ''),
    entry.rewindStatus || '', entry.sourceIdentity || '', entry.sessionId || '',
    entry.responseTiming
      ? [entry.responseTiming.intervalId, entry.responseTiming.startTs,
          entry.responseTiming.endTs, entry.responseTiming.durationMs].join(',')
      : '-',
    Array.isArray(entry.promptChips) ? sampleValue(entry.promptChips) : '-',
    Array.isArray(entry.semanticTags) ? sampleValue(entry.semanticTags) : '-',
    Array.isArray(entry.imagePaths) ? sampleValue(entry.imagePaths) : '-',
  ];
  const actions = Array.isArray(entry.actions) ? entry.actions : [];
  for (const action of actions) parts.push(fingerprintAction(action));
  return cyrb53(parts.join(SEP));
}

/**
 * Compares a fresh projection against the previous digest.
 * Returns the next digest parts plus the changed-row list.
 */
function diffHistoryEntriesAgainstDigest(prevDigest, entries) {
  const source = Array.isArray(entries) ? entries : [];
  const order = new Array(source.length);
  const fingerprints = new Map();
  const changed = [];
  const prevFingerprints = prevDigest?.fingerprints instanceof Map
    ? prevDigest.fingerprints
    : null;
  for (let index = 0; index < source.length; index++) {
    const entry = source[index];
    const uuid = String(entry?.uuid || '');
    order[index] = uuid;
    const fingerprint = fingerprintHistoryEntry(entry);
    fingerprints.set(uuid, fingerprint);
    if (!prevFingerprints || prevFingerprints.get(uuid) !== fingerprint) {
      changed.push(entry);
    }
  }
  return {
    order,
    fingerprints,
    changed,
    unchangedCount: source.length - changed.length,
  };
}

/**
 * Per-(session, tab) digest store. Bounded LRU: a digest is ~1-2MB for a
 * 15K-row session (uuid list + numeric fingerprints), and only sessions a
 * renderer actively refreshes need one.
 */
class HistoryDeltaDigestStore {
  constructor(maxEntries = 6) {
    this.maxEntries = maxEntries;
    this.digests = new Map();
  }

  static key(toolType, sessionId, tabId) {
    return String(toolType || '') + ':' + String(sessionId || '') + ':' + String(tabId || '-');
  }

  get(toolType, sessionId, tabId) {
    const key = HistoryDeltaDigestStore.key(toolType, sessionId, tabId);
    const digest = this.digests.get(key);
    if (!digest) return null;
    this.digests.delete(key);
    this.digests.set(key, digest);
    return digest;
  }

  set(toolType, sessionId, tabId, digest) {
    const key = HistoryDeltaDigestStore.key(toolType, sessionId, tabId);
    this.digests.delete(key);
    this.digests.set(key, digest);
    while (this.digests.size > this.maxEntries) {
      const lruKey = this.digests.keys().next().value;
      if (lruKey === undefined) break;
      this.digests.delete(lruKey);
    }
  }

  stats() {
    let rows = 0;
    for (const digest of this.digests.values()) rows += digest.order?.length || 0;
    return { digests: this.digests.size, rows };
  }

  invalidateSession(toolType, sessionId) {
    const prefix = String(toolType || '') + ':' + String(sessionId || '') + ':';
    for (const key of this.digests.keys()) if (key.startsWith(prefix)) this.digests.delete(key);
  }
}

module.exports = {
  cyrb53,
  fingerprintHistoryEntry,
  diffHistoryEntriesAgainstDigest,
  HistoryDeltaDigestStore,
};
