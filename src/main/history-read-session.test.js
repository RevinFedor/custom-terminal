'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { historyReadSession } = require('./history-read-session');

test('a readable resumed session can load history before its writer is confirmed', () => {
  const live = { toolType: 'codex', sessionId: null, readSessionId: 'source',
    writerSessionId: null, writerConfirmed: false, writerUsableForMutation: false };
  const read = historyReadSession(live);
  assert.equal(read.sessionId, 'source');
  assert.equal(read.writerSessionId, null);
  assert.equal(read.writerConfirmed, false);
  assert.equal(read.writerUsableForMutation, false);
  assert.equal(live.sessionId, null, 'the live snapshot is not mutated');
});

test('read identity wins over a different active writer without rewriting that writer', () => {
  const read = historyReadSession({ toolType: 'codex', sessionId: 'writer',
    codexSessionId: 'writer', writerSessionId: 'writer', codexReadSessionId: 'history', writerConfirmed: true });
  assert.equal(read.sessionId, 'history');
  assert.equal(read.codexSessionId, 'writer');
  assert.equal(read.writerSessionId, 'writer');
});

test('a missing explicit read identity is not guessed from persisted metadata', () => {
  assert.equal(historyReadSession({ toolType: 'codex', sessionId: null, savedSessionId: 'stale' }).sessionId, null);
  const claude = { toolType: 'claude', sessionId: 'claude-history' };
  assert.equal(historyReadSession(claude), claude);
  assert.equal(historyReadSession(null), null);
});
