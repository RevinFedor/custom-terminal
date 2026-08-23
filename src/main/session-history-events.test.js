const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildCodexLaunchForkEvent,
  decorateTurnsWithIterationCoordinates,
  deriveClaudeForkSnapshot,
  deriveCodexForkSnapshot,
  deriveCompactEvents,
  mapTimelineEntryUuidsAcrossFork,
} = require('./session-history-events');

test('Codex launch commits an exact source snapshot before a thin child has user rows', () => {
  assert.deepEqual(buildCodexLaunchForkEvent({
    snapshot: {
      sourceSessionId: '01a02eb0-f7dc-7910-9969-1bffae88d8d3',
      entryUuids: ['source-u1', 'source-a1', 'source-u2'],
      boundaryEntryUuid: 'source-u2',
      snapshotComplete: true,
      nextIterationIndex: 2,
      sourceSegments: [{
        physicalSessionId: '01a02eb0-f7dc-7910-9969-1bffae88d8d3',
        fromByte: 0,
        toByte: 7067455,
        startLine: 0,
        endLine: 637,
        prefixDigest: 'a'.repeat(64),
      }],
      capturedAt: 1787492358150,
    },
    childSessionId: '01a02ed8-e41e-7522-97ad-dedf6e7233ac',
    childTabId: 'tab-678',
    childTailStart: { byteOffset: 19336, line: 2, prefixDigest: 'c'.repeat(64) },
    occurredAt: 1787492360223,
  }), {
    provider: 'codex',
    sourceSessionId: '01a02eb0-f7dc-7910-9969-1bffae88d8d3',
    childSessionId: '01a02ed8-e41e-7522-97ad-dedf6e7233ac',
    entryUuids: ['source-u1', 'source-a1', 'source-u2'],
    boundaryEntryUuid: 'source-u2',
    snapshotComplete: true,
    afterIterationIndex: 1,
    nextIterationIndex: 2,
    occurredAt: 1787492360223,
    forkMode: 'direct-virtual',
    lineageManifest: {
      schema: 'codex-fork-lineage-v2',
      mode: 'direct-virtual',
      sourceSessionId: '01a02eb0-f7dc-7910-9969-1bffae88d8d3',
      childSessionId: '01a02ed8-e41e-7522-97ad-dedf6e7233ac',
      sourceSegments: [{
        segmentId: '4a4e779d2174f2510b7f27e5',
        physicalSessionId: '01a02eb0-f7dc-7910-9969-1bffae88d8d3',
        fromByte: 0,
        toByte: 7067455,
        startLine: 0,
        endLine: 637,
        prefixDigest: 'a'.repeat(64),
      }],
      childTailStart: {
        physicalSessionId: '01a02ed8-e41e-7522-97ad-dedf6e7233ac',
        byteOffset: 19336,
        line: 2,
        prefixDigest: 'c'.repeat(64),
      },
      manifestDigest: '2d0e4c4e66c5fa44bdf8630f78ddd44a7d2cf29c3284f64c526eade9559419ba',
    },
    origin: 'app',
    isDirect: true,
    childTabId: 'tab-678',
  });
  assert.equal(buildCodexLaunchForkEvent({
    snapshot: { sourceSessionId: 'source', snapshotComplete: false },
    childSessionId: 'child',
  }), null);
  assert.equal(buildCodexLaunchForkEvent({
    snapshot: {
      sourceSessionId: 'source',
      snapshotComplete: true,
      sourceSegments: [{
        physicalSessionId: 'source',
        fromByte: 0,
        toByte: 10,
        startLine: 0,
        endLine: 1,
        prefixDigest: 'not-a-digest',
      }],
    },
    childSessionId: 'child',
    childTailStart: { byteOffset: 5, line: 1, prefixDigest: 'c'.repeat(64) },
  }), null, 'V1 coordinates without an exact raw digest stay non-renderable');
});

test('iteration coordinates ignore noise and keep compact between user iterations', () => {
  const result = decorateTurnsWithIterationCoordinates([
    { kind: 'user', userUuid: 'u0', isNoise: false },
    { kind: 'user', userUuid: 'noise', isNoise: true },
    { kind: 'compact_boundary', userUuid: 'boundary' },
    { kind: 'compact_summary', userUuid: 'summary' },
    { kind: 'queued_command', userUuid: 'u1', isNoise: false },
  ]);

  assert.equal(result.totalIterations, 2);
  assert.equal(result.turns[0].iterationIndex, 0);
  assert.equal(result.turns[2].afterIterationIndex, 0);
  assert.equal(result.turns[2].nextIterationIndex, 1);
  assert.equal(result.turns[3].compactEventIdentity, 'boundary');
  assert.equal(result.turns[4].iterationIndex, 1);
});

test('Claude boundary and summary persist as one logical compact event', () => {
  const events = deriveCompactEvents({
    provider: 'claude',
    sessionId: 'session-a',
    turns: [
      { kind: 'user', userUuid: 'u0', isNoise: false },
      {
        kind: 'compact_boundary',
        userUuid: 'boundary',
        userTimestamp: '2026-08-18T10:00:00.000Z',
        trigger: 'manual',
        preTokens: 100,
        postTokens: 20,
      },
      { kind: 'compact_summary', userUuid: 'summary' },
    ],
  });

  assert.equal(events.length, 1);
  assert.equal(events[0].boundaryEntryUuid, 'boundary');
  assert.equal(events[0].summaryEntryUuid, 'summary');
  assert.equal(events[0].afterIterationIndex, 0);
  assert.equal(events[0].nextIterationIndex, 1);
});

test('Claude compact pairing survives an injected queue carrier between boundary and summary', () => {
  const events = deriveCompactEvents({
    provider: 'claude',
    sessionId: 'session-queued',
    turns: [
      { kind: 'user', userUuid: 'u0', isNoise: false },
      { kind: 'compact_boundary', userUuid: 'boundary' },
      { kind: 'queued_command', userUuid: 'queued', isNoise: false },
      { kind: 'compact_summary', userUuid: 'summary' },
    ],
  });

  assert.equal(events.length, 1);
  assert.equal(events[0].boundaryEntryUuid, 'boundary');
  assert.equal(events[0].summaryEntryUuid, 'summary');
  assert.equal(events[0].nextIterationIndex, 1);
});

test('Codex standalone compact receives the same iteration coordinates', () => {
  const events = deriveCompactEvents({
    provider: 'codex',
    sessionId: 'session-b',
    turns: [
      { kind: 'compact_summary', userUuid: 'compact-0', userTimestamp: 1787000000 },
      { kind: 'user', userUuid: 'u0', isNoise: false },
    ],
  });

  assert.equal(events.length, 1);
  assert.equal(events[0].afterIterationIndex, null);
  assert.equal(events[0].nextIterationIndex, 0);
  assert.equal(events[0].preTokens, null);
  assert.equal(events[0].postTokens, null);
});

test('Codex fork snapshots use child UUIDs before the proven live boundary', () => {
  assert.deepEqual(deriveCodexForkSnapshot([
    { uuid: 'inherited-compact', sourceLine: 8 },
    { uuid: 'inherited-user', sourceLine: 20 },
    { uuid: 'child-user', sourceLine: 31 },
  ], {
    forked_from_id: 'source',
    timestamp: '2026-08-18T10:00:00.000Z',
    forkLiveStartLine: 30,
  }), {
    sourceSessionId: 'source',
    entryUuids: ['inherited-compact', 'inherited-user'],
    boundaryEntryUuid: 'inherited-user',
    snapshotComplete: true,
    occurredAt: '2026-08-18T10:00:00.000Z',
  });
});

test('Codex fork lineage remains non-renderable until its live boundary is proven', () => {
  assert.deepEqual(deriveCodexForkSnapshot([
    { uuid: 'ambiguous', sourceLine: 10 },
  ], {
    forked_from_id: 'source',
    timestamp: '2026-08-18T10:00:00.000Z',
  }), {
    sourceSessionId: 'source',
    entryUuids: [],
    boundaryEntryUuid: null,
    snapshotComplete: false,
    occurredAt: '2026-08-18T10:00:00.000Z',
  });
});

test('Claude native fork snapshots are rebuilt from copied forkedFrom records', () => {
  const recordMap = new Map([
    ['u0', { uuid: 'u0', forkedFrom: { sessionId: 'parent' } }],
    ['compact', { uuid: 'compact', forkedFrom: { sessionId: 'parent' } }],
    ['child', { uuid: 'child' }],
  ]);
  assert.deepEqual(deriveClaudeForkSnapshot([
    { kind: 'user', userUuid: 'u0' },
    { kind: 'compact_boundary', userUuid: 'compact' },
    { kind: 'user', userUuid: 'child' },
  ], recordMap), {
    sourceSessionId: 'parent',
    entryUuids: ['u0', 'compact'],
    boundaryEntryUuid: 'compact',
    snapshotComplete: true,
  });
});

test('Codex lineage maps unchanged duplicate entries FIFO while ignoring replacements', () => {
  const source = [
    { uuid: 'source-a', type: 'user', timestamp: '2026-08-18T10:00:00Z', content: 'same' },
    { uuid: 'source-b', type: 'user', timestamp: '2026-08-18T10:00:00Z', content: 'same' },
    { uuid: 'source-c', type: 'compact', timestamp: '2026-08-18T10:01:00Z', content: 'compact' },
  ];
  const child = [
    { uuid: 'child-a', type: 'user', timestamp: '2026-08-18T10:00:00Z', content: 'same' },
    { uuid: 'replacement', type: 'user', timestamp: '2026-08-18T10:00:30Z', content: 'new' },
    { uuid: 'child-b', type: 'user', timestamp: '2026-08-18T10:00:00Z', content: 'same' },
    { uuid: 'child-c', type: 'compact', timestamp: '2026-08-18T10:01:00Z', content: 'compact' },
  ];

  assert.deepEqual(mapTimelineEntryUuidsAcrossFork(source, child), [
    { sourceUuid: 'source-a', childUuid: 'child-a' },
    { sourceUuid: 'source-b', childUuid: 'child-b' },
    { sourceUuid: 'source-c', childUuid: 'child-c' },
  ]);
});
