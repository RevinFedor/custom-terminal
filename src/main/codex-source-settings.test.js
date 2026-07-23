'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  resolveCodexSourceSettingsProof,
} = require('./codex-source-settings');

const SESSION_ID = '019f8a92-9093-76d1-9865-3dc131fdc209';

function sessionMeta(sessionId = SESSION_ID) {
  return {
    type: 'session_meta',
    payload: { id: sessionId },
  };
}

test('rejects settings when session metadata does not match the expected source', () => {
  const result = resolveCodexSourceSettingsProof([
    sessionMeta('019f8aa7-f7de-7b33-9555-087737667395'),
    {
      type: 'turn_context',
      payload: { model: 'gpt-5.6-sol', effort: 'ultra' },
    },
  ], SESSION_ID);

  assert.deepEqual(result, {
    status: 'invalid',
    sourceKind: 'session_meta',
    reason: 'session-meta-mismatch',
    actualSessionIds: ['019f8aa7-f7de-7b33-9555-087737667395'],
  });
});

test('uses the latest complete turn_context pair instead of an older Ultra pair', () => {
  const result = resolveCodexSourceSettingsProof([
    sessionMeta(),
    {
      type: 'turn_context',
      payload: { model: 'gpt-5.6-sol', effort: 'ultra' },
    },
    {
      type: 'turn_context',
      payload: { model: 'gpt-5.6-luna', effort: 'max' },
    },
  ], SESSION_ID);

  assert.deepEqual(result, {
    status: 'found',
    sourceKind: 'turn_context',
    model: 'gpt-5.6-luna',
    effort: 'max',
    recordIndex: 2,
  });
});

test('accepts a source rollout with copied ancestor session metadata', () => {
  const ancestorSessionId = '019f8aa7-f7de-7b33-9555-087737667395';
  const result = resolveCodexSourceSettingsProof([
    sessionMeta(),
    {
      type: 'session_meta',
      payload: { id: ancestorSessionId },
    },
    {
      type: 'turn_context',
      payload: { model: 'gpt-5.6-sol', effort: 'ultra' },
    },
  ], SESSION_ID);

  assert.deepEqual(result, {
    status: 'found',
    sourceKind: 'turn_context',
    model: 'gpt-5.6-sol',
    effort: 'ultra',
    recordIndex: 2,
  });
});

test('a newer thread_settings_applied pair wins over turn_context', () => {
  const result = resolveCodexSourceSettingsProof([
    sessionMeta(),
    {
      type: 'turn_context',
      payload: { model: 'gpt-5.6-sol', effort: 'max' },
    },
    {
      type: 'event_msg',
      payload: {
        type: 'thread_settings_applied',
        thread_settings: {
          model: 'gpt-5.6-luna',
          reasoning_effort: 'medium',
        },
      },
    },
  ], SESSION_ID);

  assert.deepEqual(result, {
    status: 'found',
    sourceKind: 'thread_settings_applied',
    model: 'gpt-5.6-luna',
    effort: 'medium',
    recordIndex: 2,
  });
});

test('rejects an incomplete settings record instead of combining fields across records', () => {
  const result = resolveCodexSourceSettingsProof([
    sessionMeta(),
    {
      type: 'turn_context',
      payload: { model: 'gpt-5.6-sol' },
    },
    {
      type: 'event_msg',
      payload: {
        type: 'thread_settings_applied',
        thread_settings: { reasoning_effort: 'ultra' },
      },
    },
  ], SESSION_ID);

  assert.deepEqual(result, {
    status: 'invalid',
    sourceKind: 'thread_settings_applied',
    reason: 'settings-pair-incomplete',
    recordIndex: 2,
  });
});

test('fails closed when a newer settings event is incomplete', () => {
  const result = resolveCodexSourceSettingsProof([
    sessionMeta(),
    {
      type: 'turn_context',
      payload: { model: 'gpt-5.6-sol', effort: 'ultra' },
    },
    {
      type: 'event_msg',
      payload: {
        type: 'thread_settings_applied',
        thread_settings: { model: 'gpt-5.6-luna' },
      },
    },
  ], SESSION_ID);

  assert.deepEqual(result, {
    status: 'invalid',
    sourceKind: 'thread_settings_applied',
    reason: 'settings-pair-incomplete',
    recordIndex: 2,
  });
});

test('accepts an exact Ultra pair for the expected source session', () => {
  const result = resolveCodexSourceSettingsProof([
    {
      type: 'session_meta',
      payload: { session_id: SESSION_ID },
    },
    {
      type: 'event_msg',
      payload: {
        type: 'thread_settings_applied',
        thread_settings: {
          model: 'gpt-5.6-sol',
          reasoning_effort: ' Ultra ',
        },
      },
    },
  ], SESSION_ID);

  assert.deepEqual(result, {
    status: 'found',
    sourceKind: 'thread_settings_applied',
    model: 'gpt-5.6-sol',
    effort: 'ultra',
    recordIndex: 1,
  });
});

test('returns absent when exact session metadata exists but no structured settings do', () => {
  const result = resolveCodexSourceSettingsProof([
    sessionMeta(),
    {
      type: 'event_msg',
      payload: {
        type: 'user_message',
        message: 'model gpt-5.6-sol effort ultra',
      },
    },
  ], SESSION_ID);

  assert.deepEqual(result, {
    status: 'absent',
    sourceKind: null,
    reason: 'settings-pair-absent',
  });
});
