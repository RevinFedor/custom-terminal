import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyHistoryLiveToolResultsToEntry,
  buildHistoryLivePresentation,
  extractHistoryLiveToolResults,
  historyLivePresentationKey,
  reconcileCommittedHistoryLiveProjection,
  reduceHistoryLiveProjection,
} from './historyLiveProjection.mjs';

const envelope = (message, timestamp = '2026-07-24T11:00:00.000Z') => ({
  type: 'message',
  sessionId: 'session-a',
  timestamp,
  message,
});

const canonical = (uuid, role, content, extra = {}) => ({
  type: role,
  uuid,
  sessionId: 'session-a',
  ...extra,
  message: { role, content },
});

test('live row remains until the committed durable projection contains it', () => {
  const live = [
    { uuid: 'live-a', sourceIdentity: 'source-a' },
    { uuid: 'live-b', sourceIdentity: 'source-b' },
  ];

  const beforeCommit = reconcileCommittedHistoryLiveProjection(live, [
    { uuid: 'durable-old', sourceIdentity: 'source-old' },
  ]);
  assert.strictEqual(beforeCommit.entries, live);

  const afterCommit = reconcileCommittedHistoryLiveProjection(live, [
    { uuid: 'durable-a', sourceIdentity: 'source-a' },
  ]);
  assert.deepEqual(afterCommit.entries, [live[1]]);
  assert.equal(afterCommit.durableIdentities.has('source-a'), true);
  assert.equal(afterCommit.durableIdentities.has('source-b'), false);
});

test('one presentation prefers durable data without duplicating its live row', () => {
  const durable = [
    { uuid: 'user-1', role: 'user' },
    {
      uuid: 'durable-answer',
      role: 'assistant',
      sourceIdentity: 'codex-answer-session-a-42',
      content: 'Final answer',
    },
  ];
  const live = [{
    uuid: 'live-answer',
    role: 'assistant',
    sourceIdentity: 'codex-answer-session-a-42',
    content: 'Streaming answer',
    liveProjection: true,
  }];

  const presented = buildHistoryLivePresentation(durable, live);
  assert.strictEqual(presented, durable);
  assert.equal(presented.length, 2);
  assert.equal(presented[1].content, 'Final answer');
});

test('unmatched live rows append to the durable list and keep a stable handoff key', () => {
  const durable = [{ uuid: 'user-1', role: 'user' }];
  const live = [{
    uuid: 'live-answer',
    role: 'assistant',
    sourceIdentity: 'codex-answer-session-a-42',
    liveProjection: true,
  }];
  const presented = buildHistoryLivePresentation(durable, live);

  assert.deepEqual(presented, [...durable, ...live]);
  assert.equal(
    historyLivePresentationKey(live[0]),
    historyLivePresentationKey({
      uuid: 'durable-answer',
      role: 'assistant',
      sourceIdentity: 'codex-answer-session-a-42',
    }),
  );
  assert.notEqual(
    historyLivePresentationKey(live[0]),
    historyLivePresentationKey({ uuid: 'other-answer' }),
  );
});

test('user audit proof does not remount a local prompt before durable adoption', () => {
  const beforeAudit = {
    uuid: 'local-prompt-1',
    role: 'queued',
  };
  const afterAudit = {
    ...beforeAudit,
    sourceIdentity: 'codex-user-source-session-a-42',
  };
  assert.equal(
    historyLivePresentationKey(beforeAudit),
    historyLivePresentationKey(afterAudit),
  );
});

test('current live answer stays before prompts queued for the next turn', () => {
  const currentPrompt = {
    uuid: 'user-current',
    role: 'user',
    content: 'Current question',
  };
  const queuedNext = {
    uuid: 'local-prompt-next',
    role: 'queued',
    queueStatus: 'queued',
    statusAtSend: 'busy',
    content: 'Next question',
  };
  const liveAnswer = {
    uuid: 'live-current',
    role: 'assistant',
    sourceIdentity: 'codex-answer-current',
    liveProjection: true,
  };

  assert.deepEqual(
    buildHistoryLivePresentation([currentPrompt, queuedNext], [liveAnswer])
      .map((entry) => entry.uuid),
    ['user-current', 'live-current', 'local-prompt-next'],
  );
});

test('a promoted sent prompt moves before the live answer of its own turn', () => {
  const sentPrompt = {
    uuid: 'local-prompt-next',
    role: 'queued',
    queueStatus: 'sent',
    statusAtSend: 'busy',
    content: 'Next question',
  };
  const liveAnswer = {
    uuid: 'live-next',
    role: 'assistant',
    sourceIdentity: 'codex-answer-next',
    liveProjection: true,
  };

  assert.deepEqual(
    buildHistoryLivePresentation([sentPrompt], [liveAnswer])
      .map((entry) => entry.uuid),
    ['local-prompt-next', 'live-next'],
  );
});

test('ordinary user text is omitted by default and can be explicitly included', () => {
  const input = envelope(canonical('user-1', 'user', [
    { type: 'text', text: 'queued prompt' },
  ]));

  const initial = [];
  assert.strictEqual(reduceHistoryLiveProjection(initial, input), initial);
  assert.deepEqual(
    reduceHistoryLiveProjection(initial, input, { includeUserText: true }),
    [{
      uuid: 'user-1',
      role: 'user',
      timestamp: '2026-07-24T11:00:00.000Z',
      content: 'queued prompt',
      sessionId: 'session-a',
    }],
  );
});

test('assistant text, thinking, and tool calls project to one FullHistory-like entry', () => {
  const next = reduceHistoryLiveProjection([], envelope(canonical(
    'assistant-1',
    'assistant',
    [
      { type: 'thinking', thinking: 'Inspecting state' },
      { type: 'text', text: 'I found the owner.' },
      {
        type: 'tool_use',
        id: 'tool-1',
        name: 'Read',
        input: { file_path: '/tmp/state.json' },
      },
    ],
  )));

  assert.deepEqual(next, [{
    uuid: 'assistant-1',
    role: 'assistant',
    timestamp: '2026-07-24T11:00:00.000Z',
    content: 'I found the owner.',
    thinking: 'Inspecting state',
    actions: [{
      tool: '__raw__',
      rawTool: {
        toolUseId: 'tool-1',
        toolName: 'Read',
        args: { file_path: '/tmp/state.json' },
      },
    }],
    sessionId: 'session-a',
  }]);
});

test('replayed UUID is a stable no-op and a changed UUID payload upserts in place', () => {
  const firstEnvelope = envelope(canonical('assistant-1', 'assistant', [
    { type: 'text', text: 'First' },
  ]));
  const first = reduceHistoryLiveProjection([], firstEnvelope);
  const replayed = reduceHistoryLiveProjection(first, firstEnvelope);
  assert.strictEqual(replayed, first);
  assert.equal(replayed.length, 1);

  const updated = reduceHistoryLiveProjection(first, envelope(canonical(
    'assistant-1',
    'assistant',
    [{ type: 'text', text: 'First, completed' }],
  )));
  assert.equal(updated.length, 1);
  assert.equal(updated[0].content, 'First, completed');
  assert.equal(updated[0].uuid, 'assistant-1');
});

test('canonical source identity deduplicates a replay with a new transient UUID', () => {
  const first = reduceHistoryLiveProjection([], envelope(canonical(
    'live-1',
    'assistant',
    [{ type: 'text', text: 'First' }],
    { sourceIdentity: 'codex-assistant-source-session-a-4096' },
  )));
  const replayed = reduceHistoryLiveProjection(first, envelope(canonical(
    'live-2',
    'assistant',
    [{ type: 'text', text: 'First, completed' }],
    { sourceIdentity: 'codex-assistant-source-session-a-4096' },
  )));

  assert.equal(replayed.length, 1);
  assert.equal(replayed[0].uuid, 'live-1');
  assert.equal(replayed[0].content, 'First, completed');
  assert.equal(replayed[0].sourceIdentity, 'codex-assistant-source-session-a-4096');
});

test('temporary reasoning is folded into the next durable-shaped assistant row', () => {
  const thinking = reduceHistoryLiveProjection([], envelope(canonical(
    'thinking-1',
    'assistant',
    [{ type: 'thinking', thinking: 'Inspecting state' }],
    {
      sourceIdentity: 'codex-thinking-source-session-a-4000',
      livePendingThinking: true,
    },
  )));
  const completed = reduceHistoryLiveProjection(thinking, envelope(canonical(
    'assistant-1',
    'assistant',
    [{ type: 'text', text: 'Done' }],
    { sourceIdentity: 'codex-assistant-source-session-a-4096' },
  )));

  assert.deepEqual(completed, [{
    uuid: 'assistant-1',
    sourceIdentity: 'codex-assistant-source-session-a-4096',
    role: 'assistant',
    timestamp: '2026-07-24T11:00:00.000Z',
    content: 'Done',
    thinking: 'Inspecting state',
    sessionId: 'session-a',
  }]);
});

test('turn abort clears pending reasoning before the next prompt and answer', () => {
  const thinking = reduceHistoryLiveProjection([], envelope(canonical(
    'thinking-aborted',
    'assistant',
    [{ type: 'thinking', thinking: 'Reasoning from the aborted turn' }],
    {
      sourceIdentity: 'codex-thinking-source-session-a-5000',
      livePendingThinking: true,
    },
  )));
  const aborted = reduceHistoryLiveProjection(thinking, {
    type: 'turn_boundary',
    boundary: 'turn_aborted',
    sessionId: 'session-a',
  });
  const afterPrompt = reduceHistoryLiveProjection(aborted, envelope(canonical(
    'user-next',
    'user',
    [{ type: 'text', text: 'Try again' }],
  )));
  const answered = reduceHistoryLiveProjection(afterPrompt, envelope(canonical(
    'assistant-next',
    'assistant',
    [{ type: 'text', text: 'Fresh answer' }],
    { sourceIdentity: 'codex-assistant-source-session-a-6000' },
  )));

  assert.deepEqual(aborted, []);
  assert.deepEqual(afterPrompt, []);
  assert.equal(answered.length, 1);
  assert.equal(answered[0].content, 'Fresh answer');
  assert.equal(answered[0].thinking, undefined);
});

test('a new ordinary user prompt clears pending reasoning even without a lifecycle edge', () => {
  const thinking = reduceHistoryLiveProjection([], envelope(canonical(
    'thinking-before-prompt',
    'assistant',
    [{ type: 'thinking', thinking: 'Stale reasoning' }],
    { livePendingThinking: true },
  )));
  const afterPrompt = reduceHistoryLiveProjection(thinking, envelope(canonical(
    'user-next',
    'user',
    [{ type: 'text', text: 'Start a new turn' }],
  )));

  assert.deepEqual(afterPrompt, []);
});

test('tool result enriches its existing action and never creates a user row', () => {
  const call = reduceHistoryLiveProjection([], envelope(canonical(
    'assistant-tool',
    'assistant',
    [{ type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'pwd' } }],
  )));
  const resultEnvelope = envelope(canonical(
    'tool-result-message',
    'user',
    [{
      type: 'tool_result',
      tool_use_id: 'tool-1',
      content: [{ type: 'text', text: '/Users/fedor' }],
      is_error: false,
    }],
  ));

  const completed = reduceHistoryLiveProjection(call, resultEnvelope);
  assert.equal(completed.length, 1);
  assert.deepEqual(completed[0].actions[0].rawTool, {
    toolUseId: 'tool-1',
    toolName: 'Bash',
    args: { command: 'pwd' },
    result: '/Users/fedor',
    isError: false,
  });

  assert.strictEqual(
    reduceHistoryLiveProjection(completed, resultEnvelope),
    completed,
  );
  assert.strictEqual(
    reduceHistoryLiveProjection(completed, envelope(canonical(
      'unknown-result',
      'user',
      [{ type: 'tool_result', tool_use_id: 'missing', content: 'ignored' }],
    ))),
    completed,
  );
});

test('tool result can overlay an already durable action without cloning full history', () => {
  const durableEntry = {
    uuid: 'durable-tool-call',
    role: 'assistant',
    timestamp: '2026-07-24T11:00:00.000Z',
    content: '',
    sessionId: 'session-a',
    actions: [{
      tool: '__raw__',
      rawTool: {
        toolUseId: 'tool-1',
        toolName: 'Bash',
        args: { command: 'pwd' },
      },
    }],
  };
  const resultEnvelope = envelope(canonical(
    'tool-result-message',
    'user',
    [{
      type: 'tool_result',
      tool_use_id: 'tool-1',
      content: '/Users/fedor',
      is_error: false,
    }],
  ));
  const results = extractHistoryLiveToolResults(resultEnvelope);
  const patched = applyHistoryLiveToolResultsToEntry(durableEntry, results);

  assert.deepEqual(results, [{
    toolUseId: 'tool-1',
    result: '/Users/fedor',
    isError: false,
  }]);
  assert.notStrictEqual(patched, durableEntry);
  assert.equal(patched.actions[0].rawTool.result, '/Users/fedor');
  assert.equal(patched.actions[0].rawTool.isError, false);
  assert.equal(
    applyHistoryLiveToolResultsToEntry(patched, results),
    patched,
  );
});

test('replayed tool call preserves a result already attached to the action', () => {
  const callEnvelope = envelope(canonical(
    'assistant-tool',
    'assistant',
    [{ type: 'tool_use', id: 'tool-1', name: 'Read', input: { path: 'a.md' } }],
  ));
  const call = reduceHistoryLiveProjection([], callEnvelope);
  const completed = reduceHistoryLiveProjection(call, envelope(canonical(
    'tool-result',
    'user',
    [{
      type: 'tool_result',
      tool_use_id: 'tool-1',
      content: 'done',
      is_error: false,
    }],
  )));

  const replayed = reduceHistoryLiveProjection(completed, callEnvelope);
  assert.strictEqual(replayed, completed);
  assert.equal(replayed[0].actions[0].rawTool.result, 'done');
});

test('malformed envelopes are ignored without changing the entries reference', () => {
  const entries = [{ uuid: 'existing' }];
  assert.strictEqual(reduceHistoryLiveProjection(entries, null), entries);
  assert.strictEqual(reduceHistoryLiveProjection(entries, { type: 'message' }), entries);
  assert.strictEqual(
    reduceHistoryLiveProjection(entries, envelope({
      type: 'assistant',
      uuid: 'empty',
      message: { role: 'assistant', content: [] },
    })),
    entries,
  );
});
