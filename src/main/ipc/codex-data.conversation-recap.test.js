'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { _api } = require('./codex-data');

function record(line, type, payload, timestamp = `2026-08-30T13:16:${String(line).padStart(2, '0')}.000Z`) {
  return {
    __line: line,
    __byteOffset: line * 100,
    type,
    payload,
    timestamp,
  };
}

test('standalone Codex recap command shape stays one canonical compact marker', () => {
  const sessionId = 'codex-recap-command';
  const records = [
    record(1, 'event_msg', { type: 'task_started', turn_id: 'turn-recap' }),
    record(2, 'compacted', {
      message: '',
      replacement_history: [],
      window_number: 1,
      window_id: 'window-recap',
    }),
    record(3, 'event_msg', { type: 'token_count', info: {} }),
    record(4, 'event_msg', { type: 'context_compacted' }),
    record(5, 'event_msg', {
      type: 'task_complete',
      turn_id: 'turn-recap',
      last_agent_message: '',
    }),
  ];

  const history = _api.buildCodexFullHistory(records, sessionId);
  const timeline = _api.buildCodexTimeline(records, sessionId);

  assert.deepEqual(history.map((entry) => entry.role), ['compact']);
  assert.equal(history.at(-1)?.content, 'Conversation compacted');
  assert.equal(history.at(-1)?.compactEncrypted, true);
  assert.equal(history.some((entry) => entry.role === 'recap' || entry.isConversationRecap), false);
  assert.equal(timeline.filter((entry) => entry.type === 'compact').length, 1);
});

test('turn_context summary mode is not Conversation recap content', () => {
  const history = _api.buildCodexFullHistory([
    record(1, 'turn_context', {
      turn_id: 'turn-a',
      summary: 'auto',
    }),
  ], 'codex-summary-setting');

  assert.deepEqual(history, []);
});

test('same-turn assistant continuation after auto compact remains ordinary History content', () => {
  const sessionId = 'codex-mid-turn-compact';
  const turnId = 'turn-main';
  const records = [
    record(1, 'event_msg', { type: 'task_started', turn_id: turnId }),
    record(2, 'event_msg', { type: 'user_message', message: 'continue the implementation' }),
    record(3, 'compacted', { message: '', replacement_history: [] }),
    record(4, 'turn_context', { turn_id: turnId, summary: 'auto' }),
    record(5, 'event_msg', { type: 'context_compacted' }),
    record(6, 'response_item', {
      type: 'reasoning',
      summary: [{ type: 'summary_text', text: 'Resume the same implementation.' }],
      internal_chat_message_metadata_passthrough: { turn_id: turnId },
    }),
    record(7, 'response_item', {
      type: 'message',
      role: 'assistant',
      phase: 'commentary',
      content: [{ type: 'output_text', text: 'Continuing the same task after compaction.' }],
      internal_chat_message_metadata_passthrough: { turn_id: turnId },
    }),
    record(8, 'event_msg', { type: 'task_complete', turn_id: turnId }),
  ];

  const history = _api.buildCodexFullHistory(records, sessionId);
  const assistant = history.find((entry) => entry.role === 'assistant');

  assert.deepEqual(history.map((entry) => entry.role), ['user', 'compact', 'assistant']);
  assert.equal(assistant?.thinking, 'Resume the same implementation.');
  assert.equal(assistant?.content, 'Continuing the same task after compaction.');
  assert.equal(assistant?.textPhase, 'commentary');
  assert.equal(history.some((entry) => entry.role === 'recap' || entry.isConversationRecap), false);
});
