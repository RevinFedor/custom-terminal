'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  extractClaudePromptCarrier,
  findMatchingClaudePromptTurn,
  isClaudeTaskNotificationCarrier,
  promptFingerprint,
  selectClaudeQueuedPromptIndex,
} = require('./claude-prompt-carriers');

test('extracts a normal Claude user prompt', () => {
  assert.deepEqual(extractClaudePromptCarrier({
    type: 'user',
    uuid: 'u1',
    timestamp: '2026-07-28T02:21:17.000Z',
    message: { content: [{ type: 'text', text: 'hello' }] },
  }), {
    kind: 'user',
    text: 'hello',
    uuid: 'u1',
    timestamp: '2026-07-28T02:21:17.000Z',
  });
});

test('extracts exact text from a Claude queued_command attachment', () => {
  assert.deepEqual(extractClaudePromptCarrier({
    type: 'attachment',
    uuid: 'q1',
    timestamp: '2026-07-28T02:21:17.000Z',
    attachment: {
      type: 'queued_command',
      prompt: [{ type: 'text', text: '[Оркестрация] runId: exact-run' }],
    },
  }), {
    kind: 'queued_command',
    text: '[Оркестрация] runId: exact-run',
    uuid: 'q1',
    timestamp: '2026-07-28T02:21:17.000Z',
  });
});

test('does not split an orchestration turn on Claude task-notification queued_command', () => {
  const record = {
    type: 'attachment',
    uuid: 'task-notification',
    attachment: {
      type: 'queued_command',
      commandMode: 'task-notification',
      prompt: [
        '<task-notification>',
        '<task-id>agent-1</task-id>',
        '<tool-use-id>toolu_agent_1</tool-use-id>',
        '<status>completed</status>',
        '</task-notification>',
      ].join('\n'),
    },
  };

  assert.equal(isClaudeTaskNotificationCarrier(record), true);
  assert.equal(extractClaudePromptCarrier(record), null);
});

test('recognizes historical task-notification carriers even without commandMode', () => {
  const queued = {
    type: 'attachment',
    attachment: {
      type: 'queued_command',
      prompt: '  <task-notification>\n<tool-use-id>toolu_old</tool-use-id>\n</task-notification>',
    },
  };
  const standalone = {
    type: 'user',
    message: {
      content: '<task-notification>\n<tool-use-id>toolu_old</tool-use-id>\n</task-notification>',
    },
  };

  assert.equal(isClaudeTaskNotificationCarrier(queued), true);
  assert.equal(isClaudeTaskNotificationCarrier(standalone), true);
  assert.equal(extractClaudePromptCarrier(queued), null);
  assert.equal(extractClaudePromptCarrier(standalone), null);
});

test('does not treat tool results as prompt carriers', () => {
  assert.equal(extractClaudePromptCarrier({
    type: 'user',
    message: { content: [{ type: 'tool_result', content: 'x' }] },
  }), null);
});

test('does not split a Claude turn on an internal image/meta record', () => {
  assert.equal(extractClaudePromptCarrier({
    type: 'user',
    uuid: 'screenshot-meta',
    parentUuid: 'assistant-tool-call',
    timestamp: '2026-07-28T10:08:22.990Z',
    isMeta: true,
    message: {
      role: 'user',
      content: '[Image: original 2156x1548, displayed at 2000x1436.]',
    },
  }), null);
});

test('restart proof matches an exact queued_command carrier by prompt hash', () => {
  const text = '[Оркестрация] Запрос завершён. runId: exact-run';
  const attachment = {
    type: 'attachment',
    uuid: 'queued-uuid',
    timestamp: '2026-07-28T02:21:17.000Z',
    attachment: { type: 'queued_command', prompt: [{ type: 'text', text }] },
  };
  const turn = {
    kind: 'queued_command',
    promptCarrierKind: 'queued_command',
    userUuid: attachment.uuid,
    userTimestamp: attachment.timestamp,
    assistantUuids: ['assistant-uuid'],
  };
  const match = findMatchingClaudePromptTurn({
    turns: [turn],
    recordMap: new Map([[attachment.uuid, attachment]]),
    promptHash: promptFingerprint(text),
    requestedAt: Date.parse('2026-07-28T02:20:00.000Z'),
  });
  assert.equal(match?.turnIndex, 0);
  assert.equal(match?.turn?.promptCarrierKind, 'queued_command');
});

test('queued_command proof does not match another run with similar text', () => {
  const attachment = {
    type: 'attachment',
    uuid: 'queued-uuid',
    timestamp: '2026-07-28T02:21:17.000Z',
    attachment: { type: 'queued_command', prompt: 'runId: A' },
  };
  const match = findMatchingClaudePromptTurn({
    turns: [{
      kind: 'queued_command',
      userUuid: attachment.uuid,
      userTimestamp: attachment.timestamp,
      assistantUuids: ['assistant-uuid'],
    }],
    recordMap: new Map([[attachment.uuid, attachment]]),
    promptHash: promptFingerprint('runId: B'),
    requestedAt: Date.parse('2026-07-28T02:20:00.000Z'),
  });
  assert.equal(match, null);
});

test('durable queued carrier replaces the exact timestamp among identical prompts', () => {
  const pendingEntries = [
    { content: 'same', timestamp: 't1', sessionId: 's1' },
    { content: 'same', timestamp: 't2', sessionId: 's1' },
  ];
  assert.equal(selectClaudeQueuedPromptIndex(pendingEntries, {
    text: 'same',
    timestamp: 't2',
    sessionId: 's1',
  }), 1);
});

test('ordinary later user carrier falls back to FIFO and never crosses session ownership', () => {
  const pendingEntries = [
    { content: 'same', timestamp: 't1', sessionId: 's1' },
    { content: 'same', timestamp: 't2', sessionId: 's1' },
    { content: 'same', timestamp: 't0', sessionId: 's2' },
  ];
  assert.equal(selectClaudeQueuedPromptIndex(pendingEntries, {
    text: 'same',
    timestamp: 'later',
    sessionId: 's1',
  }), 0);
  assert.equal(selectClaudeQueuedPromptIndex(pendingEntries, {
    text: 'same',
    timestamp: 'later',
    sessionId: 'missing-session',
  }), -1);
});

test('F3: exact prompt UUID wins when two Claude runs use identical text', () => {
  const text = 'same orchestration prompt';
  const first = {
    type: 'user',
    uuid: 'user-run-1',
    timestamp: '2026-07-30T10:00:00.000Z',
    message: { role: 'user', content: text },
  };
  const second = {
    type: 'user',
    uuid: 'user-run-2',
    timestamp: '2026-07-30T10:05:00.000Z',
    message: { role: 'user', content: text },
  };
  const turns = [first, second].map((record) => ({
    kind: 'user',
    userUuid: record.uuid,
    userTimestamp: record.timestamp,
    assistantUuids: ['assistant-' + record.uuid],
  }));
  const match = findMatchingClaudePromptTurn({
    turns,
    recordMap: new Map([[first.uuid, first], [second.uuid, second]]),
    promptHash: promptFingerprint(text),
    promptUserUuid: first.uuid,
    requestedAt: Date.parse('2026-07-30T09:59:00.000Z'),
    resultBeforeAt: Date.parse('2026-07-30T10:02:00.000Z'),
  });
  assert.equal(match?.turn?.userUuid, first.uuid);
});

test('F3: hash fallback cannot cross the completed run upper time boundary', () => {
  const text = 'legacy identical orchestration prompt';
  const records = [
    {
      type: 'user',
      uuid: 'legacy-run-1',
      timestamp: '2026-07-30T10:00:00.000Z',
      message: { role: 'user', content: text },
    },
    {
      type: 'user',
      uuid: 'legacy-run-2',
      timestamp: '2026-07-30T10:05:00.000Z',
      message: { role: 'user', content: text },
    },
  ];
  const match = findMatchingClaudePromptTurn({
    turns: records.map((record) => ({
      kind: 'user',
      userUuid: record.uuid,
      userTimestamp: record.timestamp,
      assistantUuids: ['assistant-' + record.uuid],
    })),
    recordMap: new Map(records.map((record) => [record.uuid, record])),
    promptHash: promptFingerprint(text),
    requestedAt: Date.parse('2026-07-30T09:59:00.000Z'),
    resultBeforeAt: Date.parse('2026-07-30T10:02:00.000Z'),
  });
  assert.equal(match?.turn?.userUuid, 'legacy-run-1');
});

test('F3: legacy hash fallback fails closed when identical prompts remain ambiguous', () => {
  const text = 'ambiguous legacy prompt';
  const records = ['legacy-a', 'legacy-b'].map((uuid, index) => ({
    type: 'user',
    uuid,
    timestamp: `2026-07-30T10:0${index}:00.000Z`,
    message: { role: 'user', content: text },
  }));
  const match = findMatchingClaudePromptTurn({
    turns: records.map((record) => ({
      kind: 'user',
      userUuid: record.uuid,
      userTimestamp: record.timestamp,
      assistantUuids: ['assistant-' + record.uuid],
    })),
    recordMap: new Map(records.map((record) => [record.uuid, record])),
    promptHash: promptFingerprint(text),
    requestedAt: Date.parse('2026-07-30T09:59:00.000Z'),
    resultBeforeAt: Date.parse('2026-07-30T10:02:00.000Z'),
  });
  assert.equal(match, null);
});
