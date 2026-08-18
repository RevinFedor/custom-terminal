const test = require('node:test');
const assert = require('node:assert/strict');
const {
  decorateTurnsWithIterationCoordinates,
  deriveClaudeForkSnapshot,
  deriveCodexForkSnapshot,
  deriveCompactEvents,
  mapTimelineEntryUuidsAcrossFork,
} = require('./session-history-events');

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
