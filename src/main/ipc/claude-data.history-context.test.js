'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { _api } = require('./claude-data');
const {
  CLAUDE_HISTORY_CONTEXT_ACK_MODEL,
  CLAUDE_HISTORY_CONTEXT_ACK_TEXT,
} = require('../agent-history-context-injection');

test('Claude user projection preserves every text/image segment in provider order', () => {
  const text = _api.claudeUserRecordText({
    type: 'user',
    message: {
      role: 'user',
      content: [
        { type: 'text', text: 'before ' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA==' } },
        { type: 'text', text: ' middle ' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA==' } },
        { type: 'text', text: ' after' },
      ],
    },
  });
  assert.equal(text, 'before [Image #1] middle [Image #2] after');
});

test('only the exact app-owned no-response boundary is hidden from History', () => {
  const exact = {
    type: 'assistant',
    message: {
      role: 'assistant',
      model: CLAUDE_HISTORY_CONTEXT_ACK_MODEL,
      content: [{ type: 'text', text: CLAUDE_HISTORY_CONTEXT_ACK_TEXT }],
      stop_reason: 'end_turn',
    },
  };
  assert.equal(_api.isClaudeHistoryContextAck(exact), true);
  assert.equal(_api.isClaudeHistoryContextAck({
    ...exact,
    message: { ...exact.message, model: 'claude-opus-5' },
  }), false);
  assert.equal(_api.isClaudeHistoryContextAck({
    ...exact,
    message: { ...exact.message, content: [{ type: 'text', text: 'ordinary answer' }] },
  }), false);
});
