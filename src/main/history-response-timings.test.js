const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildHistoryResponseEntryCloneMappings,
  decorateHistoryResponseTimings,
  normalizeHistoryResponseToolType,
  resolveActivitySessionIdForEngine,
  selectHistoryResponseTimingTarget,
  shouldCreateHistoryResponseTiming,
} = require('./history-response-timings');

const assistant = (uuid, timestamp, extra = {}) => ({
  uuid,
  role: 'assistant',
  timestamp,
  content: 'answer',
  sessionId: 'session-1',
  ...extra,
});

test('tool engines normalize only to History providers', () => {
  assert.equal(normalizeHistoryResponseToolType('claude'), 'claude');
  assert.equal(normalizeHistoryResponseToolType('codex'), 'codex');
  assert.equal(normalizeHistoryResponseToolType('claude-sdk'), null);
  assert.equal(normalizeHistoryResponseToolType('gemini'), null);
});

test('only a proven response completion creates a durable response timer', () => {
  assert.equal(shouldCreateHistoryResponseTiming({
    toolType: 'claude',
    event: 'Stop',
  }), true);
  assert.equal(shouldCreateHistoryResponseTiming({
    toolType: 'claude',
    event: 'StopFailure',
  }), false);
  assert.equal(shouldCreateHistoryResponseTiming({
    toolType: 'claude',
    reason: 'local-command',
  }), false);
  assert.equal(shouldCreateHistoryResponseTiming({
    toolType: 'codex',
    reason: 'task_complete',
    outcome: { hasFinalResult: true },
  }), true);
  assert.equal(shouldCreateHistoryResponseTiming({
    toolType: 'codex',
    reason: 'task_complete',
    outcome: { hasFinalResult: false },
  }), false);
});

test('activity identity selects only the active engine session', () => {
  const mixed = {
    bridgeSessionId: 'claude-live',
    codexRuntimeSessionId: 'codex-live',
    claudeSessionId: 'claude-db',
    codexSessionId: 'codex-db',
  };
  assert.equal(resolveActivitySessionIdForEngine('codex', mixed), 'codex-live');
  assert.equal(resolveActivitySessionIdForEngine('claude', mixed), 'claude-live');
  assert.equal(resolveActivitySessionIdForEngine('codex', {
    ...mixed,
    codexRuntimeSessionId: null,
  }), 'codex-db');
});

test('response timing ignores intermediate tool rows when one contentful response is exact', () => {
  const entries = [
    assistant('old', '2026-07-24T10:00:00.000Z'),
    { uuid: 'user', role: 'user', timestamp: '2026-07-24T10:01:00.000Z', content: 'prompt', sessionId: 'session-1' },
    assistant('tool-only', '2026-07-24T10:01:01.000Z', { content: '', actions: [{ tool: 'Read' }] }),
    assistant('final', '2026-07-24T10:01:04.900Z'),
    { uuid: 'compact', role: 'compact', timestamp: '2026-07-24T10:01:05.000Z', content: 'COMPACTED', sessionId: 'session-1' },
  ];
  assert.equal(selectHistoryResponseTimingTarget(entries, {
    startTs: Date.parse('2026-07-24T10:01:00.000Z'),
    endTs: Date.parse('2026-07-24T10:01:05.000Z'),
    sessionId: 'session-1',
  })?.uuid, 'final');
});

test('response timing stays pending for tool/thinking-only snapshots and ambiguous responses', () => {
  const timing = {
    startTs: Date.parse('2026-07-24T10:01:00.000Z'),
    endTs: Date.parse('2026-07-24T10:01:05.000Z'),
    sessionId: 'session-1',
  };
  const partial = [
    assistant('tool-only', '2026-07-24T10:01:01.000Z', {
      content: '',
      actions: [{ tool: 'Read' }],
    }),
    assistant('thinking-only', '2026-07-24T10:01:02.000Z', {
      content: '',
      thinking: 'working',
    }),
  ];

  assert.equal(selectHistoryResponseTimingTarget(partial, timing), null);
  assert.equal(selectHistoryResponseTimingTarget([
    ...partial,
    assistant('first-answer', '2026-07-24T10:01:03.000Z'),
    assistant('second-answer', '2026-07-24T10:01:04.900Z'),
  ], timing), null);
  assert.equal(selectHistoryResponseTimingTarget([
    ...partial,
    assistant('final', '2026-07-24T10:01:04.900Z'),
  ], timing)?.uuid, 'final');
});

test('decorator leaves a partial tool snapshot pending and binds after final response appears', () => {
  const rows = [{
    intervalId: 19,
    toolType: 'codex',
    tabId: 'tab-1',
    sessionId: 'session-1',
    entryUuid: null,
    startTs: Date.parse('2026-07-24T10:01:00.000Z'),
    endTs: Date.parse('2026-07-24T10:01:05.000Z'),
    durationMs: 5000,
  }];
  const db = {
    getPendingHistoryResponseTimings: () => rows.filter((row) => !row.entryUuid),
    bindHistoryResponseTimingEntry: ({ intervalId, entryUuid }) => {
      const row = rows.find((candidate) => candidate.intervalId === intervalId);
      row.entryUuid = entryUuid;
      return true;
    },
    getHistoryResponseTimingsForEntries: () => [],
  };
  const toolOnly = assistant('tool-only', '2026-07-24T10:01:01.000Z', {
    content: '',
    actions: [{ tool: 'Read' }],
  });

  decorateHistoryResponseTimings(db, {
    toolType: 'codex',
    sessionId: 'session-1',
    tabId: 'tab-1',
    entries: [toolOnly],
  });
  assert.equal(rows[0].entryUuid, null);

  decorateHistoryResponseTimings(db, {
    toolType: 'codex',
    sessionId: 'session-1',
    tabId: 'tab-1',
    entries: [
      toolOnly,
      assistant('final', '2026-07-24T10:01:04.900Z'),
    ],
  });
  assert.equal(rows[0].entryUuid, 'final');
});

test('response timing never falls back to a previous response or another session', () => {
  assert.equal(selectHistoryResponseTimingTarget([
    assistant('old', '2026-07-24T10:00:58.500Z'),
    assistant('other-session', '2026-07-24T10:01:02.000Z', { sessionId: 'session-2' }),
  ], {
    startTs: Date.parse('2026-07-24T10:01:00.000Z'),
    endTs: Date.parse('2026-07-24T10:01:05.000Z'),
    sessionId: 'session-1',
  }), null);
});

test('proven child clone mapping is exact and fails closed for duplicate responses', () => {
  const source = [
    assistant('source-a', '2026-07-24T10:01:02.000Z', { content: 'unique' }),
    assistant('source-duplicate-1', '2026-07-24T10:01:03.000Z', { content: 'same' }),
    assistant('source-duplicate-2', '2026-07-24T10:01:03.000Z', { content: 'same' }),
  ];
  const child = [
    assistant('child-a', '2026-07-24T10:01:02.000Z', {
      content: 'unique',
      sessionId: 'session-child',
      sourceIdentity: 'child:1',
    }),
    assistant('child-duplicate-1', '2026-07-24T10:01:03.000Z', {
      content: 'same',
      sessionId: 'session-child',
    }),
    assistant('child-duplicate-2', '2026-07-24T10:01:03.000Z', {
      content: 'same',
      sessionId: 'session-child',
    }),
  ];
  assert.deepEqual(buildHistoryResponseEntryCloneMappings(source, child), [{
    sourceEntryUuid: 'source-a',
    childEntryUuid: 'child-a',
    childSourceIdentity: 'child:1',
  }]);
});

test('decorator binds a pending interval once and projects its persisted duration', () => {
  const rows = [{
    intervalId: 17,
    toolType: 'codex',
    tabId: 'tab-1',
    sessionId: 'session-1',
    entryUuid: null,
    startTs: Date.parse('2026-07-24T10:01:00.000Z'),
    endTs: Date.parse('2026-07-24T10:01:05.000Z'),
    durationMs: 5000,
  }];
  const db = {
    getPendingHistoryResponseTimings: () => rows.filter((row) => !row.entryUuid),
    bindHistoryResponseTimingEntry: ({ intervalId, entryUuid, sourceIdentity }) => {
      const row = rows.find((candidate) => candidate.intervalId === intervalId);
      row.entryUuid = entryUuid;
      row.sourceIdentity = sourceIdentity;
      return true;
    },
    getHistoryResponseTimingsForEntries: (_toolType, uuids) => {
      const wanted = new Set(uuids);
      return rows.filter((row) => row.entryUuid && wanted.has(row.entryUuid));
    },
  };
  const entries = [assistant('final', '2026-07-24T10:01:04.900Z', {
    sourceIdentity: 'source-7',
  })];
  const decorated = decorateHistoryResponseTimings(db, {
    toolType: 'codex',
    sessionId: 'session-1',
    tabId: 'tab-1',
    entries,
  });
  assert.equal(rows[0].entryUuid, 'final');
  assert.equal(rows[0].sourceIdentity, 'source-7');
  assert.deepEqual(decorated[0].responseTiming, {
    intervalId: 17,
    startTs: rows[0].startTs,
    endTs: rows[0].endTs,
    durationMs: 5000,
  });
});
