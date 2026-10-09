const assert = require('node:assert/strict');
const test = require('node:test');

const {
  fingerprintHistoryEntry,
  diffHistoryEntriesAgainstDigest,
  HistoryDeltaDigestStore,
} = require('./history-delta');

const userRow = (uuid, content) => ({
  uuid,
  role: 'user',
  timestamp: '2026-08-06T10:00:00.000Z',
  content,
  sessionId: 'session-a',
});

test('native question reply certificate enrichment is a metadata-only delta, including tool carriers', () => {
  const row = userRow('native-user', 'unchanged raw envelope');
  const proof = { version: 1, provider: 'codex', transportHash: 'a'.repeat(64),
    links: [{ callId: 'call', questionIndex: 0, questionHash: 'b'.repeat(64), callSourceIdentity: 'origin' }] };
  assert.notEqual(fingerprintHistoryEntry(row), fingerprintHistoryEntry({ ...row, questionReplyProof: proof }));
  const withProof = { ...row, questionReplyProof: proof }, before = fingerprintHistoryEntry(withProof);
  proof.links[0].questionHash = 'c'.repeat(64);
  assert.notEqual(fingerprintHistoryEntry(withProof), before);
  const tool = { ...row, role: 'assistant', content: '', actions: [{ tool: '__raw__', rawTool: {
    toolName: 'AskUserQuestion', toolUseId: 'toolu', args: {}, result: 'same raw result',
  } }] };
  const toolBefore = fingerprintHistoryEntry(tool);
  tool.actions[0].rawTool.questionReplyProof = { ...proof, provider: 'claude' };
  assert.notEqual(fingerprintHistoryEntry(tool), toolBefore);
});

test('rewrite dependency coordinates and mutable middle content cannot hide behind equal previews', () => {
  const row = { ...userRow('u1', ''), sourceRecordLine: 12, thinking: 'same preview',
    thinkingRef: { payloadId: 'thinking:u1', totalChars: 10000, recordLine: 12 } };
  assert.notEqual(fingerprintHistoryEntry(row), fingerprintHistoryEntry({ ...row, sourceRecordLine: 13 }));
  assert.notEqual(fingerprintHistoryEntry(row), fingerprintHistoryEntry({ ...row, thinkingRef: { ...row.thinkingRef, recordLine: 13 } }));
  const action = { tool: 'Task', toolUseId: 'task-1', subagentStatus: 'completed', result: 'x'.repeat(100) + 'A' + 'y'.repeat(100) };
  const taskRow = { ...row, actions: [action] };
  const first = fingerprintHistoryEntry(taskRow);
  action.result = 'x'.repeat(100) + 'B' + 'y'.repeat(100);
  assert.notEqual(first, fingerprintHistoryEntry(taskRow));
  const tags = ['x'.repeat(60), 'A', 'y'.repeat(60)];
  const tagged = { ...row, semanticTags: tags };
  const beforeTag = fingerprintHistoryEntry(tagged);
  tags[1] = 'B';
  assert.notEqual(beforeTag, fingerprintHistoryEntry(tagged));
});

test('fingerprint is stable across rebuilds of identical rows', () => {
  const build = () => ({
    uuid: 'codex-assistant-1',
    role: 'assistant',
    timestamp: '2026-08-06T10:00:01.000Z',
    content: 'answer text',
    thinking: 'x'.repeat(100_000),
    sessionId: 'session-a',
    actions: [{
      tool: '__raw__',
      rawTool: {
        toolUseId: 'call-1:canonical:0',
        toolName: 'Bash',
        args: { command: 'ls', description: 'list' },
        result: 'y'.repeat(50_000),
        isError: false,
      },
    }],
  });
  assert.equal(fingerprintHistoryEntry(build()), fingerprintHistoryEntry(build()));
});

test('fingerprint moves on every presentation-relevant mutation shape', () => {
  const base = {
    uuid: 'codex-assistant-2',
    role: 'assistant',
    timestamp: '2026-08-06T10:00:02.000Z',
    content: '',
    sessionId: 'session-a',
    actions: [{
      tool: '__raw__',
      rawTool: { toolUseId: 'call-2', toolName: 'Bash', args: { command: 'sleep 5' } },
    }],
  };
  const withResult = {
    ...base,
    actions: [{
      tool: '__raw__',
      rawTool: { ...base.actions[0].rawTool, result: 'done', isError: false },
    }],
  };
  assert.notEqual(fingerprintHistoryEntry(base), fingerprintHistoryEntry(withResult));

  const taskRunning = {
    uuid: 'codex-assistant-3',
    role: 'assistant',
    timestamp: '2026-08-06T10:00:03.000Z',
    content: '',
    actions: [{ tool: 'Task', toolUseId: 'spawn-1', description: 'Researcher', subagentStatus: 'running' }],
  };
  const taskDone = {
    ...taskRunning,
    actions: [{ tool: 'Task', toolUseId: 'spawn-1', description: 'Researcher', subagentStatus: 'completed', result: 'ok' }],
  };
  assert.notEqual(fingerprintHistoryEntry(taskRunning), fingerprintHistoryEntry(taskDone));

  // A dehydrated row differs from its hydrated twin (preview + ref witness).
  const hydrated = {
    ...base,
    actions: [{
      tool: '__raw__',
      rawTool: { ...base.actions[0].rawTool, result: 'z'.repeat(40_000) },
    }],
  };
  const dehydrated = {
    ...base,
    actions: [{
      tool: '__raw__',
      rawTool: {
        ...base.actions[0].rawTool,
        result: 'z'.repeat(2048) + '\n… (+37 KB)',
        resultRef: { payloadId: 'result:call-2', totalChars: 40_000 },
      },
    }],
  };
  assert.notEqual(fingerprintHistoryEntry(hydrated), fingerprintHistoryEntry(dehydrated));

  // Decoration arrival (chips / timing) must reship the row.
  const plain = userRow('codex-user-1', 'prompt');
  const decorated = { ...plain, promptChips: [{ kind: 'prompt', title: 'Из библиотеки' }] };
  assert.notEqual(fingerprintHistoryEntry(plain), fingerprintHistoryEntry(decorated));
  const timed = {
    ...plain,
    responseTiming: { intervalId: 5, startTs: 1, endTs: 2, durationMs: 1 },
  };
  assert.notEqual(fingerprintHistoryEntry(plain), fingerprintHistoryEntry(timed));
});

test('diff ships only changed rows and preserves order', () => {
  const first = [userRow('u1', 'one'), userRow('u2', 'two'), userRow('u3', 'three')];
  const digest0 = diffHistoryEntriesAgainstDigest(null, first);
  assert.equal(digest0.changed.length, 3, 'no previous digest → everything is new');

  // Append one row, enrich one old row, keep the rest untouched.
  const second = [
    first[0],
    { ...first[1], content: 'two (edited)' },
    first[2],
    userRow('u4', 'four'),
  ];
  const digest1 = diffHistoryEntriesAgainstDigest(digest0, second);
  assert.deepEqual(digest1.order, ['u1', 'u2', 'u3', 'u4']);
  assert.deepEqual(digest1.changed.map((row) => row.uuid), ['u2', 'u4']);
  assert.equal(digest1.unchangedCount, 2);

  // Rollback: rows disappear from the order; nothing changed to ship.
  const third = [first[0]];
  const digest2 = diffHistoryEntriesAgainstDigest(digest1, third);
  assert.deepEqual(digest2.order, ['u1']);
  assert.equal(digest2.changed.length, 0);
});

test('digest store is a bounded LRU keyed by session and tab', () => {
  const store = new HistoryDeltaDigestStore(2);
  store.set('codex', 's1', 'tab-a', { revisionToken: 'r1', order: ['u1'], fingerprints: new Map() });
  store.set('codex', 's2', 'tab-a', { revisionToken: 'r2', order: [], fingerprints: new Map() });
  assert.ok(store.get('codex', 's1', 'tab-a'), 'refreshes recency');
  store.set('codex', 's3', 'tab-a', { revisionToken: 'r3', order: [], fingerprints: new Map() });
  assert.equal(store.get('codex', 's2', 'tab-a'), null, 'oldest evicted');
  assert.ok(store.get('codex', 's1', 'tab-a'));
  assert.ok(store.get('codex', 's3', 'tab-a'));
  assert.equal(store.get('codex', 's1', 'tab-b'), null, 'tab id is part of the key');
});
