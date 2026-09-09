'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { _api } = require('./codex-data');

const event = (__line, type, extra = {}) => ({
  __line,
  __byteOffset: __line * 100,
  timestamp: `2026-09-09T02:43:0${__line}.000Z`,
  type: 'event_msg',
  payload: { type, ...extra },
});

test('typed usage-limit completion becomes one raspberry History service row', () => {
  const history = _api.buildCodexFullHistory([
    event(1, 'task_started', { turn_id: 'turn-limited' }),
    event(2, 'user_message', { message: 'do the work' }),
    event(3, 'task_complete', {
      turn_id: 'turn-limited',
      last_agent_message: null,
      error: {
        message: "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits, or try again later.",
        codex_error_info: 'usage_limit_exceeded',
      },
    }),
  ], 'usage-limit-session');

  const notices = history.filter((entry) => entry.role === 'usage-limit');
  assert.equal(notices.length, 1);
  assert.deepEqual({
    content: notices[0].content,
    serviceCarrier: notices[0].serviceCarrier,
    timestamp: notices[0].timestamp,
  }, {
    content: 'Usage limit reached',
    serviceCarrier: 'usage-limit',
    timestamp: '2026-09-09T02:43:03.000Z',
  });
  assert.match(notices[0].uuid, /^codex-usage-limit-/);
  assert.match(notices[0].sourceIdentity, /^codex-usage-limit-source-/);
});

test('generic provider errors and user prose cannot impersonate a usage-limit event', () => {
  const history = _api.buildCodexFullHistory([
    event(1, 'task_started', { turn_id: 'turn-generic' }),
    event(2, 'user_message', { message: "Explain the words You've hit your usage limit" }),
    event(3, 'task_complete', {
      turn_id: 'turn-generic',
      error: {
        message: "You've hit your usage limit (quoted by an unrelated gateway)",
        codex_error_info: 'other',
      },
    }),
  ], 'generic-error-session');

  assert.equal(history.some((entry) => entry.role === 'usage-limit'), false);
  assert.equal(history.find((entry) => entry.role === 'user')?.content,
    "Explain the words You've hit your usage limit");
});

test('success after a limited turn does not inherit the previous service row', () => {
  const history = _api.buildCodexFullHistory([
    event(1, 'user_message', { message: 'limited prompt' }),
    event(2, 'task_complete', {
      turn_id: 'turn-limited',
      error: { message: 'limit', codex_error_info: 'usage_limit_exceeded' },
    }),
    event(3, 'user_message', { message: 'later prompt' }),
    {
      __line: 4,
      __byteOffset: 400,
      timestamp: '2026-09-09T02:43:04.000Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        phase: 'final_answer',
        content: [{ type: 'output_text', text: 'later answer' }],
      },
    },
    event(5, 'task_complete', { turn_id: 'turn-success', last_agent_message: 'later answer' }),
  ], 'limited-then-success-session');

  assert.equal(history.filter((entry) => entry.role === 'usage-limit').length, 1);
  const limitedIndex = history.findIndex((entry) => entry.role === 'usage-limit');
  const laterUserIndex = history.findIndex((entry) => entry.role === 'user' && entry.content === 'later prompt');
  const answerIndex = history.findIndex((entry) => entry.content === 'later answer');
  assert.ok(limitedIndex >= 0 && laterUserIndex > limitedIndex && answerIndex > laterUserIndex);
});
