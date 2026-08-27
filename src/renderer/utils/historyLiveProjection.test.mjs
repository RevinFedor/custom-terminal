import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyHistoryLiveToolResultsToEntry,
  buildHistoryLivePresentation,
  extractHistoryLiveToolResults,
  historyLivePresentationIdentities,
  historyLivePresentationKey,
  reconcileCommittedHistoryLiveProjection,
  retireHistoryLivePromptByExactProof,
  reconcileHistoryLiveToolResults,
  reduceHistoryLiveProjection,
  shouldIncludeHistoryLiveUserText,
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

test('durable Task identity retires spawn acceptance without comparing it to the child final result', () => {
  const live = new Map([[
    'spawn-1:canonical:0',
    { toolUseId: 'spawn-1:canonical:0', result: '{"agent_id":"child-1"}', isError: false },
  ]]);
  const remaining = reconcileHistoryLiveToolResults([{
    uuid: 'task-row',
    actions: [{
      tool: 'Task',
      // Durable parser keeps the provider call id; the live projection stamps
      // its single decoded card with the canonical :0 suffix.
      toolUseId: 'spawn-1',
      subagentStatus: 'completed',
      result: 'CHILD-FINAL',
    }],
  }], live);
  assert.equal(remaining.size, 0);
});

test('raw live tool result remains until exact durable result coverage exists', () => {
  const live = new Map([[
    'call-raw',
    { toolUseId: 'call-raw', result: 'expected output', isError: false },
  ]]);
  const pending = reconcileHistoryLiveToolResults([{
    actions: [{
      tool: '__raw__',
      rawTool: { toolUseId: 'call-raw', result: 'older output', isError: false },
    }],
  }], live);
  assert.strictEqual(pending, live);

  const settled = reconcileHistoryLiveToolResults([{
    actions: [{
      tool: '__raw__',
      rawTool: { toolUseId: 'call-raw', result: 'expected output', isError: false },
    }],
  }], live);
  assert.equal(settled.size, 0);
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

test('Claude live assistant hands off to durable history by its exact JSONL uuid', () => {
  const rawClaude = canonical(
    'claude-assistant-uuid',
    'assistant',
    [{ type: 'text', text: 'Streaming Claude answer' }],
  );
  const live = reduceHistoryLiveProjection([], {
    tabId: 'tab-claude',
    toolType: 'claude',
    sessionId: 'session-a',
    message: rawClaude,
  });
  assert.equal(live.length, 1);
  assert.equal(live[0].uuid, 'claude-assistant-uuid');
  assert.equal(live[0].content, 'Streaming Claude answer');

  const durable = [{
    uuid: 'claude-assistant-uuid',
    role: 'assistant',
    content: 'Final Claude answer',
  }];
  assert.strictEqual(buildHistoryLivePresentation(durable, live), durable);
  assert.deepEqual(
    reconcileCommittedHistoryLiveProjection(live, durable).entries,
    [],
  );
  assert.equal(
    historyLivePresentationKey(live[0]),
    historyLivePresentationKey(durable[0]),
  );
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

test('live Codex project instructions retain their service identity for the History chip', () => {
  const live = reduceHistoryLiveProjection([], envelope(canonical(
    'agents-live',
    'user',
    [{
      type: 'text',
      text: '# AGENTS.md instructions for /repo\n\n<INSTRUCTIONS>safe</INSTRUCTIONS>',
    }],
    { serviceCarrier: 'project-instructions' },
  )), { includeUserText: true });

  assert.equal(live.length, 1);
  assert.equal(live[0].serviceCarrier, 'project-instructions');
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

test('confirmed Codex prompt follows preceding live compact by exact rollout order', () => {
  const currentPrompt = {
    uuid: 'durable-current-prompt',
    role: 'user',
    sourceIdentity: 'codex-user-source-session-a-100',
    sessionId: 'session-a',
  };
  const sentPrompt = {
    uuid: 'local-prompt-next',
    role: 'queued',
    queueStatus: 'sent',
    statusAtSend: 'busy',
    sourceIdentity: 'codex-user-source-session-a-400',
    sessionId: 'session-a',
    content: 'Next question',
  };
  const queuedAfter = {
    uuid: 'local-prompt-after',
    role: 'queued',
    queueStatus: 'queued',
    statusAtSend: 'busy',
    sessionId: 'session-a',
    content: 'Later question',
  };
  const previousAnswer = {
    uuid: 'live-previous-answer',
    role: 'assistant',
    sourceIdentity: 'codex-assistant-source-session-a-200',
    sessionId: 'session-a',
  };
  const compact = {
    uuid: 'live-compact',
    role: 'compact',
    sourceIdentity: 'codex-compact-source-session-a-300',
    sessionId: 'session-a',
    content: 'Conversation compacted',
  };
  const nextAnswer = {
    uuid: 'live-next-answer',
    role: 'assistant',
    sourceIdentity: 'codex-assistant-source-session-a-500',
    sessionId: 'session-a',
  };

  assert.deepEqual(
    buildHistoryLivePresentation(
      [currentPrompt, sentPrompt, queuedAfter],
      [previousAnswer, compact, nextAnswer],
    ).map((entry) => entry.uuid),
    [
      'durable-current-prompt',
      'live-previous-answer',
      'live-compact',
      'local-prompt-next',
      'live-next-answer',
      'local-prompt-after',
    ],
  );
});

test('physical offsets order durable, local, and live rows even when the optimistic anchor was appended late', () => {
  const durableWithLateLocal = [
    { uuid: 'prompt', role: 'user', sessionId: 'session-a', recordByteOffset: 100 },
    { uuid: 'answer-newer', role: 'assistant', sessionId: 'session-a', recordByteOffset: 500 },
    { uuid: 'local-confirmed', role: 'queued', sessionId: 'session-a', recordByteOffset: 400 },
  ];
  const live = [
    { uuid: 'compact', role: 'compact', sessionId: 'session-a', recordByteOffset: 300 },
    { uuid: 'answer-older', role: 'assistant', sessionId: 'session-a', recordByteOffset: 200 },
  ];

  assert.deepEqual(
    buildHistoryLivePresentation(durableWithLateLocal, live).map((entry) => entry.uuid),
    ['prompt', 'answer-older', 'compact', 'local-confirmed', 'answer-newer'],
  );
});

test('cold Claude live projection uses exact JSONL offsets instead of event arrival order', () => {
  const later = reduceHistoryLiveProjection([], {
    ...envelope(canonical('claude-later', 'assistant', [{ type: 'text', text: 'Later' }])),
    recordByteOffset: 240,
  });
  const outOfOrder = reduceHistoryLiveProjection(later, {
    ...envelope(canonical('claude-earlier', 'assistant', [{ type: 'text', text: 'Earlier' }])),
    recordByteOffset: 120,
  });

  assert.equal(outOfOrder[0].recordByteOffset, 240, 'the reducer preserves event arrival order');
  assert.deepEqual(
    buildHistoryLivePresentation([], outOfOrder).map((entry) => entry.uuid),
    ['claude-earlier', 'claude-later'],
  );
});

test('unknown-position rows stay at their causal barrier', () => {
  const unknown = { uuid: 'unknown-local', role: 'queued', sessionId: 'session-a' };
  const live = [
    { uuid: 'positioned-later', role: 'assistant', sessionId: 'session-a', recordByteOffset: 200 },
    unknown,
    { uuid: 'positioned-earlier', role: 'assistant', sessionId: 'session-a', recordByteOffset: 100 },
  ];

  assert.deepEqual(
    buildHistoryLivePresentation([], live).map((entry) => entry.uuid),
    ['positioned-later', 'unknown-local', 'positioned-earlier'],
  );
});

test('an unknown durable row is a barrier for positional normalization', () => {
  const durable = [
    { uuid: 'positioned-later', role: 'assistant', sessionId: 'session-a', recordByteOffset: 200 },
    { uuid: 'unknown-barrier', role: 'system', sessionId: 'session-a' },
    { uuid: 'positioned-earlier', role: 'assistant', sessionId: 'session-a', recordByteOffset: 100 },
  ];
  const live = [{ uuid: 'unknown-live', role: 'queued', sessionId: 'session-a' }];

  assert.deepEqual(
    buildHistoryLivePresentation(durable, live).map((entry) => entry.uuid),
    ['positioned-later', 'unknown-barrier', 'positioned-earlier', 'unknown-live'],
  );
});

test('lightweight live compact hands off to the durable compact by exact source', () => {
  const sourceIdentity = 'codex-compact-source-session-a-300';
  const detail = {
    type: 'history_entry',
    toolType: 'codex',
    sessionId: 'session-a',
    timestamp: '2026-08-14T14:28:19.270Z',
    entry: {
      uuid: 'codex-live-compact',
      role: 'compact',
      sourceIdentity,
      content: 'Conversation compacted',
    },
  };
  const live = reduceHistoryLiveProjection([], detail);
  assert.deepEqual(live, [{
    uuid: 'codex-live-compact',
    role: 'compact',
    sourceIdentity,
    content: 'Conversation compacted',
    timestamp: '2026-08-14T14:28:19.270Z',
    sessionId: 'session-a',
  }]);

  const durable = [{
    uuid: 'codex-compact-session-a-42',
    role: 'compact',
    sourceIdentity,
    content: 'Conversation compacted',
    compactSummary: 'large durable summary',
    timestamp: '2026-08-14T14:28:19.270Z',
    sessionId: 'session-a',
  }];
  assert.strictEqual(buildHistoryLivePresentation(durable, live), durable);
  assert.deepEqual(reconcileCommittedHistoryLiveProjection(live, durable).entries, []);
  assert.equal(
    historyLivePresentationKey(live[0]),
    historyLivePresentationKey(durable[0]),
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

test('manual Codex xterm user row is included while an exact History handoff keeps local ownership', () => {
  const liveUser = {
    tabId: 'tab-codex',
    toolType: 'codex',
    sessionId: 'session-a',
    timestamp: '2026-08-07T16:00:00.000Z',
    message: canonical('codex-live-user', 'user', [
      { type: 'text', text: 'SAME TEXT' },
    ], {
      sourceIdentity: 'codex-user-source-session-a-2048',
    }),
  };
  const localHandoffs = [{
    handoffId: 'history-handoff',
    text: 'SAME TEXT',
  }];

  assert.equal(shouldIncludeHistoryLiveUserText({
    toolType: 'codex',
    envelope: liveUser,
    localHandoffs,
  }), true, 'equal text is not an ownership proof');
  assert.equal(shouldIncludeHistoryLiveUserText({
    toolType: 'codex',
    envelope: {
      ...liveUser,
      promptOwner: { handoffId: 'history-handoff' },
    },
    localHandoffs,
  }), false, 'exact handoff keeps the optimistic History row');
});

test('manual Codex live user hands off to its durable row by exact rollout identity', () => {
  const sourceIdentity = 'codex-user-source-session-a-2048';
  const live = reduceHistoryLiveProjection([], {
    tabId: 'tab-codex',
    toolType: 'codex',
    sessionId: 'session-a',
    timestamp: '2026-08-07T16:00:00.000Z',
    message: canonical('codex-live-user', 'user', [
      { type: 'text', text: 'Manual terminal prompt' },
    ], { sourceIdentity }),
  }, { includeUserText: true });
  assert.deepEqual(live, [{
    uuid: 'codex-live-user',
    sourceIdentity,
    role: 'user',
    timestamp: '2026-08-07T16:00:00.000Z',
    content: 'Manual terminal prompt',
    sessionId: 'session-a',
  }]);

  const durable = [{
    uuid: 'codex-user-session-a-17',
    sourceIdentity,
    role: 'user',
    timestamp: '2026-08-07T16:00:00.000Z',
    content: 'Manual terminal prompt',
    sessionId: 'session-a',
  }];
  assert.strictEqual(buildHistoryLivePresentation(durable, live), durable);
  assert.deepEqual(reconcileCommittedHistoryLiveProjection(live, durable).entries, []);
});

test('canonical Codex event row retires its response carrier through an exact source alias', () => {
  const responseIdentity = 'codex-user-source-session-a-2048';
  const eventIdentity = 'codex-user-source-session-a-2304';
  const live = [{
    uuid: 'local-prompt-1',
    sourceIdentity: responseIdentity,
    role: 'queued',
    queueStatus: 'sent',
    sessionId: 'session-a',
    content: 'Paired prompt',
  }];
  const durable = [{
    uuid: 'codex-user-session-a-18',
    sourceIdentity: eventIdentity,
    sourceIdentityAliases: [responseIdentity],
    role: 'user',
    sessionId: 'session-a',
    content: 'Paired prompt',
  }];

  assert.deepEqual(
    historyLivePresentationIdentities(durable[0]).slice(0, 2),
    [eventIdentity, responseIdentity],
  );
  assert.strictEqual(buildHistoryLivePresentation(durable, live), durable);
  assert.deepEqual(reconcileCommittedHistoryLiveProjection(live, durable).entries, []);
});

test('late audit proof retires an already painted optimistic duplicate by exact source identity', () => {
  const sourceIdentity = 'codex-user-source-session-a-4096';
  const live = [{
    uuid: 'codex-live-user',
    sourceIdentity,
    role: 'user',
    sessionId: 'session-a',
    content: '[Image #1] prompt',
  }];
  assert.deepEqual(retireHistoryLivePromptByExactProof(live, { sourceIdentity }), []);
  assert.strictEqual(retireHistoryLivePromptByExactProof(live, {
    sourceIdentity: 'codex-user-source-session-a-8192',
  }), live, 'identical text is irrelevant without exact identity');
});

test('live response carrier upgrades in place when canonical event carries its alias', () => {
  const responseIdentity = 'codex-user-source-session-a-2048';
  const response = envelope(canonical(
    'codex-response-user-session-a-17',
    'user',
    [{ type: 'text', text: 'Paired prompt' }],
    { sourceIdentity: responseIdentity },
  ));
  const canonicalEvent = envelope(canonical(
    'codex-user-session-a-18',
    'user',
    [{ type: 'text', text: 'Paired prompt' }],
    {
      sourceIdentity: 'codex-user-source-session-a-2304',
      sourceIdentityAliases: [responseIdentity],
    },
  ));

  const afterResponse = reduceHistoryLiveProjection([], response, { includeUserText: true });
  const afterEvent = reduceHistoryLiveProjection(afterResponse, canonicalEvent, { includeUserText: true });
  assert.equal(afterEvent.length, 1);
  assert.equal(afterEvent[0].sourceIdentity, 'codex-user-source-session-a-2304');
  assert.deepEqual(afterEvent[0].sourceIdentityAliases, [responseIdentity]);
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
        // Grouping identity stamped for live rows (same as durable parser).
        family: 'read',
        bashWord: undefined,
        mcpServer: undefined,
        mcpMethod: undefined,
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

test('Claude thinking-only live row is released at the authoritative settled boundary', () => {
  const thinking = reduceHistoryLiveProjection([], envelope(canonical(
    'claude-thinking-only',
    'assistant',
    [{ type: 'thinking', thinking: 'Temporary Claude reasoning' }],
    { livePendingThinking: true },
  )));
  assert.equal(thinking.length, 1);
  assert.equal(thinking[0].thinking, 'Temporary Claude reasoning');

  const settled = reduceHistoryLiveProjection(thinking, {
    type: 'turn_boundary',
    boundary: 'turn_settled',
    sessionId: 'session-a',
  });
  assert.deepEqual(settled, []);
  assert.equal(buildHistoryLivePresentation([], settled).length, 0);
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
    family: 'run',
    bashWord: 'pwd',
    mcpServer: undefined,
    mcpMethod: undefined,
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
