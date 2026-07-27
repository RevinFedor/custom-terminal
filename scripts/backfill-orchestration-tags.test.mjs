import test from 'node:test';
import assert from 'node:assert/strict';
import {
  candidateFromClaudeRecord,
  candidateFromCodexRecord,
  parseOrchestrationMessage,
} from './backfill-orchestration-tags.mjs';

test('migration classifier accepts only a structured orchestration completion with runId', () => {
  assert.deepEqual(parseOrchestrationMessage('[Оркестрация] Запрос завершён.\nrunId: run-12345678'), {
    runId: 'run-12345678',
    phase: 'completion',
  });
  assert.equal(parseOrchestrationMessage('ordinary user text\nrunId: run-12345678'), null);
  assert.equal(parseOrchestrationMessage('[Оркестрация] Запрос завершён.'), null);
});

test('Claude candidate preserves exact durable UUID and failure phase', () => {
  const candidate = candidateFromClaudeRecord({
    type: 'user',
    uuid: 'entry-1',
    sessionId: 'session-1',
    timestamp: '2026-07-27T01:02:03.000Z',
    message: { content: '[Оркестрация] Запрос завершён с ошибкой.\nrunId: run-abcdefgh' },
  }, '/tmp/session-1.jsonl');
  assert.equal(candidate.entryUuid, 'entry-1');
  assert.equal(candidate.tag.phase, 'failure');
  assert.equal(candidate.tag.runId, 'run-abcdefgh');
});

test('Codex candidate uses the parser-compatible physical line identity', () => {
  const candidate = candidateFromCodexRecord({
    type: 'event_msg',
    timestamp: '2026-07-27T01:02:03.000Z',
    payload: { type: 'user_message', message: '[Оркестрация] Запрос завершён.\nrunId: run-abcdefgh' },
  }, '/tmp/rollout-session-2.jsonl', 17, 'session-2');
  assert.equal(candidate.entryUuid, 'codex-user-session-2-17');
  assert.equal(candidate.tag.phase, 'completion');
});
