'use strict';

const crypto = require('crypto');
const { normalizeForkOperation, historyRewriteOperation } = require('../shared/fork-operation.cjs');

const SESSION_HISTORY_EVENT_TYPES = new Set(['fork', 'compact']);
const SESSION_HISTORY_PROVIDERS = new Set(['claude', 'codex']);
const CODEX_FORK_LINEAGE_SCHEMA = 'codex-fork-lineage-v2';
const CODEX_FORK_MAX_SOURCE_SEGMENTS = 16;

function cleanString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeProvider(value) {
  const provider = cleanString(value).toLowerCase();
  return SESSION_HISTORY_PROVIDERS.has(provider) ? provider : null;
}

function normalizeEventType(value) {
  const eventType = cleanString(value).toLowerCase();
  return SESSION_HISTORY_EVENT_TYPES.has(eventType) ? eventType : null;
}

function isRealIterationTurn(turn) {
  return (turn?.kind === 'user' || turn?.kind === 'queued_command') && turn?.isNoise !== true;
}

function isCompactTurn(turn) {
  return turn?.kind === 'compact_boundary' || turn?.kind === 'compact_summary';
}

function toEpochSeconds(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.floor(value > 1e12 ? value / 1000 : value);
  }
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : null;
}

function forkEventKey(provider, sourceSessionId, childSessionId) {
  const normalizedProvider = normalizeProvider(provider);
  const source = cleanString(sourceSessionId);
  const child = cleanString(childSessionId);
  if (!normalizedProvider || !source || !child || source === child) return null;
  return `fork:${normalizedProvider}:${source}:${child}`;
}

function normalizeNonNegativeInteger(value) {
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric >= 0 ? numeric : null;
}

function normalizeSha256(value) {
  const digest = cleanString(value).toLowerCase();
  return /^[a-f0-9]{64}$/.test(digest) ? digest : null;
}

function normalizeCodexForkSourceSegment(segment) {
  const physicalSessionId = cleanString(segment?.physicalSessionId || segment?.sessionId);
  const fromByte = normalizeNonNegativeInteger(segment?.fromByte);
  const toByte = normalizeNonNegativeInteger(segment?.toByte);
  const startLine = normalizeNonNegativeInteger(segment?.startLine);
  const endLine = normalizeNonNegativeInteger(segment?.endLine);
  const prefixDigest = normalizeSha256(segment?.prefixDigest || segment?.sha256);
  if (!physicalSessionId
    || fromByte === null
    || toByte === null
    || toByte < fromByte
    || startLine === null
    || endLine === null
    || endLine < startLine
    || !prefixDigest) {
    return null;
  }
  const segmentId = cleanString(segment?.segmentId) || crypto
    .createHash('sha256')
    .update(JSON.stringify([physicalSessionId, fromByte, toByte, startLine, endLine, prefixDigest]))
    .digest('hex')
    .slice(0, 24);
  return {
    segmentId,
    physicalSessionId,
    fromByte,
    toByte,
    startLine,
    endLine,
    prefixDigest,
  };
}

function codexForkLineageManifestDigest(manifest) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify({
      schema: CODEX_FORK_LINEAGE_SCHEMA,
      mode: 'direct-virtual',
      sourceSessionId: manifest.sourceSessionId,
      childSessionId: manifest.childSessionId,
      sourceSegments: manifest.sourceSegments,
      childTailStart: manifest.childTailStart,
    }))
    .digest('hex');
}

function buildCodexForkLineageManifest({
  sourceSessionId,
  childSessionId,
  sourceSegments,
  childTailStart,
} = {}) {
  const source = cleanString(sourceSessionId);
  const child = cleanString(childSessionId);
  const segments = Array.isArray(sourceSegments)
    ? sourceSegments.map(normalizeCodexForkSourceSegment)
    : [];
  const childByteOffset = normalizeNonNegativeInteger(childTailStart?.byteOffset);
  const childLine = normalizeNonNegativeInteger(childTailStart?.line);
  const childPrefixDigest = normalizeSha256(childTailStart?.prefixDigest);
  const physicalOwners = new Set(segments.filter(Boolean).map((segment) => segment.physicalSessionId));
  const segmentIds = new Set(segments.filter(Boolean).map((segment) => segment.segmentId));
  if (!source
    || !child
    || source === child
    || segments.length === 0
    || segments.length > CODEX_FORK_MAX_SOURCE_SEGMENTS
    || segments.some((segment) => !segment)
    || physicalOwners.size !== segments.length
    || physicalOwners.has(child)
    || segmentIds.size !== segments.length
    || childByteOffset === null
    || childLine === null
    || !childPrefixDigest) {
    return null;
  }
  const manifest = {
    schema: CODEX_FORK_LINEAGE_SCHEMA,
    mode: 'direct-virtual',
    sourceSessionId: source,
    childSessionId: child,
    sourceSegments: segments,
    childTailStart: {
      physicalSessionId: child,
      byteOffset: childByteOffset,
      line: childLine,
      prefixDigest: childPrefixDigest,
    },
  };
  return {
    ...manifest,
    manifestDigest: codexForkLineageManifestDigest(manifest),
  };
}

function normalizeCodexForkLineageManifest(value, expected = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (value.schema !== CODEX_FORK_LINEAGE_SCHEMA || value.mode !== 'direct-virtual') return null;
  const manifest = buildCodexForkLineageManifest({
    sourceSessionId: value.sourceSessionId,
    childSessionId: value.childSessionId,
    sourceSegments: value.sourceSegments,
    childTailStart: value.childTailStart,
  });
  if (!manifest || manifest.manifestDigest !== normalizeSha256(value.manifestDigest)) return null;
  const expectedSource = cleanString(expected.sourceSessionId);
  const expectedChild = cleanString(expected.childSessionId);
  if (expectedSource && manifest.sourceSessionId !== expectedSource) return null;
  if (expectedChild && manifest.childSessionId !== expectedChild) return null;
  return manifest;
}

function normalizeCodexForkSourceSnapshot(value, sourceSessionId = null) {
  const source = cleanString(value?.sourceSessionId);
  if (!source || (sourceSessionId && source !== sourceSessionId) || value.snapshotComplete !== true) return null;
  const proof = buildCodexForkLineageManifest({
    sourceSessionId: source,
    childSessionId: 'pending-child:' + source,
    sourceSegments: value.sourceSegments,
    childTailStart: { byteOffset: 0, line: 0, prefixDigest: '0'.repeat(64) },
  });
  if (!proof || !Array.isArray(value.entryUuids)) return null;
  return { ...value, sourceSessionId: source, sourceSegments: proof.sourceSegments };
}

function isProvenMaterializedCompactFork(event, meta, records, timeline) {
  if (event?.forkMode !== 'latest_compact'
    || !['app', 'terminal-mcp', 'orchestration'].includes(event?.origin)
    || event.snapshotComplete !== true
    || event.childSessionId !== meta?.id
    || event.sourceSessionId !== meta?.forked_from_id
    || !Array.isArray(event.entryUuids) || event.entryUuids.length === 0) return false;
  const first = (records || []).find((record) => record?.type !== 'session_meta');
  if (first?.type !== 'compacted') return false;
  const expected = event.entryUuids;
  const actual = (timeline || []).slice(0, expected.length).map((entry) => entry.uuid);
  return actual.length === expected.length
    && actual.every((uuid, index) => uuid === expected[index])
    && (!event.boundaryEntryUuid || actual.at(-1) === event.boundaryEntryUuid);
}

// An app rewrite can deliberately retain ZERO iterations. This is not a thin
// native fork whose missing prefix should be borrowed from the parent. Require
// the durable complete empty snapshot AND the same projection's standalone
// metadata; a mode label, bare SID, or absent provider paging hint is not proof.
function isProvenEmptyCodexHistoryRewrite(event, meta) {
  const kind = historyRewriteOperation(event?.forkMode);
  return !!kind
    && event?.provider === 'codex' && event.eventType === 'fork'
    && ['app', 'terminal-mcp', 'orchestration'].includes(event.origin)
    // Rewind uses the same physical history_delete writer as Delete; product
    // intent remains independent of that physical mode.
    && (!event.operationKind || ['rewind', 'edit', 'delete'].includes(event.operationKind))
    && event.isDirect !== false && event.snapshotComplete === true
    && event.lineageManifest == null
    && Array.isArray(event.entryUuids) && event.entryUuids.length === 0
    && event.boundaryEntryUuid == null
    && !!event.sourceSessionId && event.sourceSessionId !== event.childSessionId
    && event.childSessionId === meta?.id
    && (meta.session_id == null || meta.session_id === meta.id)
    && event.sourceSessionId === meta.forked_from_id
    && meta.history_mode === 'legacy'
    && meta.history_base == null && meta.forked_from_ordinal_exclusive == null;
}

function compactEventKey(provider, sessionId, boundaryIdentity) {
  const normalizedProvider = normalizeProvider(provider);
  const session = cleanString(sessionId);
  const identity = cleanString(boundaryIdentity);
  if (!normalizedProvider || !session || !identity) return null;
  return `compact:${normalizedProvider}:${session}:${identity}`;
}

function fallbackCompactIdentity(turn, turnIndex) {
  const material = [turn?.userTimestamp || '', turn?.kind || '', turnIndex].join(':');
  return 'derived-' + crypto.createHash('sha256').update(material).digest('hex').slice(0, 24);
}

function decorateTurnsWithIterationCoordinates(turns) {
  const source = Array.isArray(turns) ? turns : [];
  const decorated = [];
  let nextIterationIndex = 0;
  let pendingCompactBoundary = null;

  for (let turnIndex = 0; turnIndex < source.length; turnIndex += 1) {
    const turn = source[turnIndex] || {};
    const item = { ...turn, turnIndex };

    if (isRealIterationTurn(turn)) {
      item.iterationIndex = nextIterationIndex;
      nextIterationIndex += 1;
      if (turn.kind === 'user') pendingCompactBoundary = null;
    } else if (isCompactTurn(turn)) {
      item.afterIterationIndex = nextIterationIndex > 0 ? nextIterationIndex - 1 : null;
      item.nextIterationIndex = nextIterationIndex;
      if (turn.kind === 'compact_boundary') {
        const boundaryIdentity = cleanString(turn.userUuid) || fallbackCompactIdentity(turn, turnIndex);
        item.compactEventIdentity = boundaryIdentity;
        item.compactPart = 'boundary';
        pendingCompactBoundary = {
          turnIndex,
          identity: boundaryIdentity,
          afterIterationIndex: item.afterIterationIndex,
          nextIterationIndex: item.nextIterationIndex,
        };
      } else if (pendingCompactBoundary) {
        item.compactEventIdentity = pendingCompactBoundary.identity;
        item.compactPart = 'summary';
        item.compactBoundaryTurnIndex = pendingCompactBoundary.turnIndex;
        item.afterIterationIndex = pendingCompactBoundary.afterIterationIndex;
        item.nextIterationIndex = pendingCompactBoundary.nextIterationIndex;
        pendingCompactBoundary = null;
      } else {
        item.compactEventIdentity = cleanString(turn.userUuid) || fallbackCompactIdentity(turn, turnIndex);
        item.compactPart = 'summary';
        pendingCompactBoundary = null;
      }
    }

    decorated.push(item);
  }

  return {
    turns: decorated,
    totalIterations: nextIterationIndex,
  };
}

function deriveCompactEvents({ provider, sessionId, turns }) {
  const normalizedProvider = normalizeProvider(provider);
  const session = cleanString(sessionId);
  if (!normalizedProvider || !session) return [];
  const decorated = decorateTurnsWithIterationCoordinates(turns).turns;
  const events = [];
  const optionalNumber = (value) => {
    if (value === null || value === undefined || value === '') return null;
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
  };

  for (const turn of decorated) {
    if (!isCompactTurn(turn) || turn.compactPart === 'summary' && turn.compactBoundaryTurnIndex !== undefined) {
      continue;
    }
    const identity = turn.compactEventIdentity;
    const eventKey = compactEventKey(normalizedProvider, session, identity);
    if (!eventKey) continue;
    const pairedSummary = turn.kind === 'compact_boundary'
      ? decorated.find((candidate) => candidate?.compactBoundaryTurnIndex === turn.turnIndex)
      : null;
    events.push({
      eventKey,
      eventType: 'compact',
      provider: normalizedProvider,
      sessionId: session,
      boundaryEntryUuid: cleanString(turn.userUuid) || identity,
      summaryEntryUuid: pairedSummary?.compactEventIdentity === identity
        ? cleanString(pairedSummary.userUuid) || null
        : null,
      occurredAt: toEpochSeconds(turn.userTimestamp || pairedSummary?.userTimestamp),
      turnIndex: turn.turnIndex,
      afterIterationIndex: turn.afterIterationIndex,
      nextIterationIndex: turn.nextIterationIndex,
      trigger: cleanString(turn.trigger) || null,
      preTokens: optionalNumber(turn.preTokens),
      postTokens: optionalNumber(turn.postTokens),
      origin: 'transcript',
    });
  }

  return events;
}

function deriveCodexForkSnapshot(entries, sessionMeta) {
  const sourceSessionId = cleanString(sessionMeta?.forked_from_id);
  if (!sourceSessionId) return null;
  const forkLiveStartLine = Number(sessionMeta?.forkLiveStartLine);
  const providerPaginated = sessionMeta?.history_mode === 'paginated'
    && cleanString(sessionMeta?.history_base?.thread_id) === sourceSessionId;
  // A paginated child deliberately omits its inherited prefix from its own
  // rollout. Seeing the first child task proves only where the local tail
  // begins; it can never prove that an empty list is the whole inherited
  // snapshot. The exact app-owned manifest is recovered from history_base.
  const snapshotComplete = !providerPaginated
    && Number.isInteger(forkLiveStartLine)
    && forkLiveStartLine >= 0;
  const inheritedEntries = snapshotComplete
    ? (Array.isArray(entries) ? entries : []).filter((entry) => {
        const sourceLine = Number(entry?.sourceLine);
        return Number.isInteger(sourceLine) && sourceLine <= forkLiveStartLine;
      })
    : [];
  const entryUuids = inheritedEntries
    .map((entry) => cleanString(entry?.uuid))
    .filter(Boolean);
  return {
    sourceSessionId,
    entryUuids,
    boundaryEntryUuid: entryUuids.at(-1) || null,
    snapshotComplete,
    occurredAt: sessionMeta?.timestamp || null,
  };
}

function buildCodexLaunchForkEvent({
  snapshot,
  childSessionId,
  childTabId = null,
  childTailStart = null,
  occurredAt = null,
  operationKind = 'provider',
} = {}) {
  const sourceSessionId = cleanString(snapshot?.sourceSessionId);
  const child = cleanString(childSessionId);
  const entryUuids = Array.isArray(snapshot?.entryUuids)
    ? snapshot.entryUuids.map(cleanString).filter(Boolean)
    : [];
  if (!sourceSessionId
    || !child
    || sourceSessionId === child
    || snapshot?.snapshotComplete !== true) {
    return null;
  }
  const lineageManifest = buildCodexForkLineageManifest({
    sourceSessionId,
    childSessionId: child,
    sourceSegments: snapshot?.sourceSegments,
    childTailStart: childTailStart || snapshot?.childTailStart,
  });
  const nextIterationIndex = Number(snapshot?.nextIterationIndex);
  return {
    provider: 'codex',
    sourceSessionId,
    childSessionId: child,
    entryUuids,
    boundaryEntryUuid: cleanString(snapshot?.boundaryEntryUuid) || entryUuids.at(-1) || null,
    snapshotComplete: true,
    afterIterationIndex: Number.isInteger(nextIterationIndex) && nextIterationIndex > 0
      ? nextIterationIndex - 1
      : null,
    nextIterationIndex: Number.isInteger(nextIterationIndex) && nextIterationIndex >= 0
      ? nextIterationIndex
      : null,
    occurredAt: occurredAt || snapshot?.capturedAt || null,
    forkMode: lineageManifest ? 'direct-virtual' : 'full',
    operationKind: normalizeForkOperation(operationKind) || 'provider',
    ...(lineageManifest ? { lineageManifest } : {}),
    origin: operationKind === 'fork' ? 'app' : 'transcript',
    isDirect: true,
    childTabId: cleanString(childTabId) || null,
  };
}

function deriveClaudeForkSnapshot(turns, recordMap) {
  if (!(recordMap instanceof Map)) return null;
  const bySource = new Map();
  for (const turn of Array.isArray(turns) ? turns : []) {
    const uuid = cleanString(turn?.userUuid);
    if (!uuid) continue;
    const record = recordMap.get(uuid);
    const sourceSessionId = cleanString(record?.forkedFrom?.sessionId);
    if (!sourceSessionId) continue;
    const row = bySource.get(sourceSessionId) || [];
    row.push(uuid);
    bySource.set(sourceSessionId, row);
  }
  if (bySource.size === 0) return null;
  const [sourceSessionId, entryUuids] = [...bySource.entries()]
    .sort((left, right) => right[1].length - left[1].length)[0];
  return {
    sourceSessionId,
    entryUuids,
    boundaryEntryUuid: entryUuids.at(-1) || null,
    snapshotComplete: true,
  };
}

function timelineLineageFingerprint(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const kind = cleanString(entry.type || entry.kind || entry.role);
  const timestamp = cleanString(entry.timestamp || entry.ts);
  const content = typeof entry.content === 'string'
    ? entry.content
    : typeof entry.preview === 'string'
      ? entry.preview
      : '';
  if (!kind || !timestamp) return null;
  return crypto.createHash('sha256')
    .update(JSON.stringify([kind, timestamp, content]))
    .digest('hex');
}

function mapTimelineEntryUuidsAcrossFork(sourceEntries, childEntries) {
  const sourceBuckets = new Map();
  for (const entry of Array.isArray(sourceEntries) ? sourceEntries : []) {
    const uuid = cleanString(entry?.uuid);
    const fingerprint = timelineLineageFingerprint(entry);
    if (!uuid || !fingerprint) continue;
    const bucket = sourceBuckets.get(fingerprint) || [];
    bucket.push(uuid);
    sourceBuckets.set(fingerprint, bucket);
  }

  const mappings = [];
  for (const entry of Array.isArray(childEntries) ? childEntries : []) {
    const childUuid = cleanString(entry?.uuid);
    const fingerprint = timelineLineageFingerprint(entry);
    if (!childUuid || !fingerprint) continue;
    const bucket = sourceBuckets.get(fingerprint);
    const sourceUuid = bucket?.shift();
    if (!sourceUuid) continue;
    mappings.push({ sourceUuid, childUuid });
  }
  return mappings;
}

module.exports = {
  isProvenEmptyCodexHistoryRewrite,
  CODEX_FORK_LINEAGE_SCHEMA,
  buildCodexForkLineageManifest,
  cleanString,
  compactEventKey,
  decorateTurnsWithIterationCoordinates,
  buildCodexLaunchForkEvent,
  deriveClaudeForkSnapshot,
  deriveCodexForkSnapshot,
  deriveCompactEvents,
  forkEventKey,
  isCompactTurn,
  isRealIterationTurn,
  mapTimelineEntryUuidsAcrossFork,
  normalizeCodexForkLineageManifest,
  normalizeCodexForkSourceSnapshot,
  isProvenMaterializedCompactFork,
  normalizeCodexForkSourceSegment,
  normalizeEventType,
  normalizeProvider,
  toEpochSeconds,
  timelineLineageFingerprint,
};
