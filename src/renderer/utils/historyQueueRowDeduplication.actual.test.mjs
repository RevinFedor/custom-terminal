// One prompt appeared in History TWICE, both rows `queued`, both carrying the
// SAME Message ID — so it was one JSONL record drawn as two rows, not two
// sends. Production 01.11.2026, tab 6d6fd1718b66, session 30ea154d, enqueue at
// byte offset 41443353; the user copied both rows and their details blocks
// were identical down to the id.
//
// A live queue row identifies itself by the physical byte offset of its
// record. When the SAME record is delivered again without that offset — a
// reconnect, a refresh, any envelope that carries no position — the identity
// falls back to session+timestamp+text, a different string for the same
// record. The upsert compared only the primary string, missed, and appended.
//
// The repair keeps both forms on the row and matches against either. Where
// both sides have a byte offset, only the offset decides: two identical
// prompts sent twice share the weaker fallback string and must stay separate.
//
// These tests drive the REAL live reducer.
import assert from 'node:assert/strict';
import test from 'node:test';
import { reduceClaudeHistoryPromptCarrier } from './historyClaudePromptCarriers.mjs';

const SESSION = '30ea154d-9aa4-46dc-88ea-3adb9f8ed0df';
const TEXT = 'В КОНЦЕ ВКЛОАДКУ ios…';

// A live envelope for one `enqueue` record. `offset: null` is the delivery
// that carries no physical position.
const enqueue = ({ offset = null, text = TEXT, timestamp = '2026-11-01T12:09:12.489Z' } = {}) => ({
  toolType: 'claude', sessionId: SESSION, timestamp,
  ...(offset === null ? {} : { recordByteOffset: offset }),
  message: {
    type: 'queue-operation', operation: 'enqueue',
    content: text, sessionId: SESSION, timestamp,
  },
});

const project = (...envelopes) => envelopes.reduce(
  (entries, envelope) => reduceClaudeHistoryPromptCarrier(
    entries, envelope, { includeUserText: true },
  ).entries,
  [],
);

test('the same record delivered with and without its offset stays one row', () => {
  // Pre-fix this produced two rows — exactly what the user saw.
  const afterOffsetFirst = project(enqueue({ offset: 41443353 }), enqueue());
  assert.equal(afterOffsetFirst.length, 1);
  assert.equal(afterOffsetFirst[0].sourceIdentity,
    'claude-queue:offset:' + SESSION + ':41443353',
    'the already presented identity is kept, not replaced mid-flight');

  // The reverse order happens when the first delivery had no position yet.
  assert.equal(project(enqueue(), enqueue({ offset: 41443353 })).length, 1);

  // And the ordinary repeat is still one row.
  assert.equal(project(enqueue({ offset: 41443353 }), enqueue({ offset: 41443353 })).length, 1);
});

test('the row remembers every form it was seen under', () => {
  const [row] = project(enqueue({ offset: 41443353 }));
  assert.ok(Array.isArray(row.sourceIdentityAliases) && row.sourceIdentityAliases.length === 1,
    'the offset-free form is carried from the start');
  assert.ok(row.sourceIdentityAliases[0].startsWith('claude-queue:' + SESSION + ':'));
  assert.notEqual(row.sourceIdentityAliases[0], row.sourceIdentity);
});

test('two different records with identical text stay two rows', () => {
  // Same prompt sent twice: equal text, equal timestamp, DIFFERENT offsets.
  // Their fallback identities are equal, so only the offsets separate them.
  assert.equal(project(enqueue({ offset: 41443353 }), enqueue({ offset: 41462260 })).length, 2);
});

test('records that differ only by time stay two rows', () => {
  assert.equal(project(
    enqueue({ offset: 100, timestamp: '2026-11-01T12:09:12.489Z' }),
    enqueue({ offset: 200, timestamp: '2026-11-01T12:09:29.000Z' }),
  ).length, 2);
  // Without any offset the timestamp is what separates them.
  assert.equal(project(
    enqueue({ timestamp: '2026-11-01T12:09:12.489Z' }),
    enqueue({ timestamp: '2026-11-01T12:09:29.000Z' }),
  ).length, 2);
});

test('different prompts are never merged', () => {
  assert.equal(project(
    enqueue({ offset: 100, text: 'первый' }),
    enqueue({ offset: 200, text: 'второй' }),
  ).length, 2);
});

test('the settled row keeps one identity through its whole lifecycle', () => {
  // enqueue → remove → the carrier Claude finally writes: still one row.
  const settled = reduceClaudeHistoryPromptCarrier(
    reduceClaudeHistoryPromptCarrier(
      project(enqueue({ offset: 41443353 })),
      { ...enqueue({ offset: 41447745 }),
        message: { type: 'queue-operation', operation: 'remove',
          content: TEXT, sessionId: SESSION, timestamp: '2026-11-01T12:09:12.586Z' } },
      { includeUserText: true },
    ).entries,
    { toolType: 'claude', sessionId: SESSION, timestamp: '2026-11-01T12:09:11.809Z',
      recordByteOffset: 41455819,
      message: { type: 'attachment', uuid: '23a37c63-c578-47b4-a70d-398f11d448d4',
        sessionId: SESSION, timestamp: '2026-11-01T12:09:11.809Z',
        attachment: { type: 'queued_command', prompt: TEXT } } },
    { includeUserText: true },
  ).entries;
  assert.equal(settled.length, 1);
  assert.equal(settled[0].role, 'user', 'the carrier replaces the queue row in place');
});
