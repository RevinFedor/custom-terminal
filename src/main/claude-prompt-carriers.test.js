'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  extractClaudePromptCarrier,
  findMatchingClaudePromptTurn,
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
