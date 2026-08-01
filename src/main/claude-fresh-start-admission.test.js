'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluateClaudeFreshStartAdmission } = require('./claude-fresh-start-admission');

test('plain start is rejected when the tab owns a materialized Claude conversation', () => {
  const result = evaluateClaudeFreshStartAdmission({
    command: 'claude',
    boundSessionId: 'session-a',
    materialization: { success: true, materialized: true, timelineCount: 14 },
  });
  assert.equal(result.allowed, false);
  assert.equal(result.error, 'tab_has_resumable_session');
  assert.equal(result.sessionId, 'session-a');
  assert.equal(result.canResume, true);
});

test('an empty metadata-only session does not block a plain start', () => {
  const result = evaluateClaudeFreshStartAdmission({
    command: 'claude',
    boundSessionId: 'session-empty',
    materialization: { success: true, materialized: false, reason: 'timeline-empty' },
  });
  assert.equal(result.allowed, true);
});

test('unknown materialization fails closed without pretending a session is empty', () => {
  const result = evaluateClaudeFreshStartAdmission({
    command: 'claude',
    boundSessionId: 'session-a',
    materialization: { success: false, reason: 'materialization-check-failed' },
  });
  assert.equal(result.allowed, false);
  assert.equal(result.error, 'claude_session_materialization_unknown');
});

test('resume and explicitly confirmed replacement are outside the plain-start guard', () => {
  assert.equal(evaluateClaudeFreshStartAdmission({
    command: 'claude-c',
    boundSessionId: 'session-a',
    materialization: { success: true, materialized: true },
  }).allowed, true);
  assert.equal(evaluateClaudeFreshStartAdmission({
    command: 'claude',
    allowNewOverExisting: true,
    boundSessionId: 'session-a',
    materialization: { success: true, materialized: true },
  }).allowed, true);
});
