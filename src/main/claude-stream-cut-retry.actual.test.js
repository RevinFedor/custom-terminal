'use strict';
// Anthropic cut the response stream mid-answer and the turn just ended with a
// partial reply; nothing continued it. Production 02.11.2026, session
// be82a19d, record 15ce6c4b at 10:16:28 UTC — the exact record is replayed
// below, field for field, from the transcript.
//
// Decision 02.11 (Fedor): continue automatically, like Codex model capacity.
// This suite pins WHAT counts as such a cut, because the cost of a wrong
// positive is an unsolicited prompt sent into the user's conversation.
const assert = require('node:assert/strict');
const test = require('node:test');
const { claudeStreamCutFromRecord } = require('../shared/claude-stream-cut-retry.cjs');

// Verbatim from the user's transcript at byte offset 48691710.
const PRODUCTION_RECORD = Object.freeze({
  parentUuid: 'f09f7744-19de-4de3-aa5c-86678ee576e2',
  isSidechain: false,
  type: 'assistant',
  uuid: '15ce6c4b-362e-4fda-941e-d40dc4bad53e',
  timestamp: '2026-11-02T10:16:28.744Z',
  error: 'server_error',
  truncatedAfterOutput: true,
  isApiErrorMessage: true,
  streamCutCause: 'server_error',
  sessionId: 'be82a19d-4a26-4263-b32a-e91477e1cd17',
  version: '2.1.316',
  message: {
    model: '<synthetic>', role: 'assistant', type: 'message',
    stop_reason: 'stop_sequence',
    content: [{ type: 'text',
      text: 'API Error: Server error mid-response. The response above may be incomplete.' }],
  },
});

test('the real production record is recognised as a retryable stream cut', () => {
  const cut = claudeStreamCutFromRecord(PRODUCTION_RECORD);
  assert.ok(cut, 'this exact record must arm the retry');
  assert.equal(cut.errorId, '15ce6c4b-362e-4fda-941e-d40dc4bad53e',
    'the record uuid is the identity used to deduplicate repeated deliveries');
  assert.equal(cut.cause, 'server_error');
  assert.equal(cut.truncatedAfterOutput, true, 'part of the answer had already arrived');
  assert.match(cut.message, /Server error mid-response/);
  assert.equal(cut.sessionId, 'be82a19d-4a26-4263-b32a-e91477e1cd17');
});

test('an overloaded upstream is the same lane', () => {
  const cut = claudeStreamCutFromRecord({ ...PRODUCTION_RECORD,
    error: 'overloaded_error', streamCutCause: 'overloaded_error' });
  assert.ok(cut);
  assert.equal(cut.cause, 'overloaded_error');
});

test('a rate limit is NOT continued automatically', () => {
  // Continuing straight into a limit would only hit it again; that lane has
  // its own usage-limit presentation and waiting rules.
  assert.equal(claudeStreamCutFromRecord({ ...PRODUCTION_RECORD, apiErrorStatus: 429 }), null);
  assert.equal(claudeStreamCutFromRecord({ ...PRODUCTION_RECORD,
    error: 'rate_limit_error', streamCutCause: 'api_error' }), null);
});

test('an ordinary answer that merely mentions the error is not a cut', () => {
  // The single most dangerous false positive: a model quoting the phrase.
  assert.equal(claudeStreamCutFromRecord({
    type: 'assistant', uuid: 'u1', sessionId: 's',
    message: { role: 'assistant', content: [{ type: 'text',
      text: 'Я видел в логе "API Error: Server error mid-response" — разбираю.' }] },
  }), null);
});

test('other records never arm a retry', () => {
  const cases = [
    ['no error flag', { ...PRODUCTION_RECORD, isApiErrorMessage: false }],
    ['no stream cut cause', { ...PRODUCTION_RECORD, streamCutCause: undefined }],
    ['unknown cause', { ...PRODUCTION_RECORD, streamCutCause: 'user_cancelled' }],
    ['a subagent record', { ...PRODUCTION_RECORD, isSidechain: true }],
    ['a user record', { ...PRODUCTION_RECORD, type: 'user' }],
    ['a system record', { ...PRODUCTION_RECORD, type: 'system' }],
    ['no uuid to deduplicate by', { ...PRODUCTION_RECORD, uuid: '' }],
    ['nothing at all', null],
  ];
  for (const [label, record] of cases) {
    assert.equal(claudeStreamCutFromRecord(record), null, label + ' must not arm a retry');
  }
});

test('a cut with no text still reports a usable message', () => {
  const cut = claudeStreamCutFromRecord({ ...PRODUCTION_RECORD,
    message: { role: 'assistant', content: [] } });
  assert.ok(cut);
  assert.match(cut.message, /Server error mid-response/);
});

test('the same record always yields the same identity', () => {
  // Two deliveries of one record must collapse onto one retry, never two.
  assert.equal(
    claudeStreamCutFromRecord(PRODUCTION_RECORD).errorId,
    claudeStreamCutFromRecord({ ...PRODUCTION_RECORD }).errorId,
  );
});
