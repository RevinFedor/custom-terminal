'use strict';

const crypto = require('crypto');

const SESSION_HISTORY_EVENT_TYPES = new Set(['fork', 'compact']);
const SESSION_HISTORY_PROVIDERS = new Set(['claude', 'codex']);
const CODEX_FORK_LINEAGE_SCHEMA = 'codex-fork-lineage-v2';

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
  if (!source
    || !child
    || source === child
    || segments.length === 0
    || segments.some((segment) => !segment)
    || childByteOffset === null
    || childLine === null) {
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
  const snapshotComplete = Number.isInteger(forkLiveStartLine) && forkLiveStartLine >= 0;
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
  if (!lineageManifest) return null;
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
    forkMode: 'direct-virtual',
    lineageManifest,
    origin: 'app',
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
  normalizeCodexForkSourceSegment,
  normalizeEventType,
  normalizeProvider,
  toEpochSeconds,
  timelineLineageFingerprint,
};
