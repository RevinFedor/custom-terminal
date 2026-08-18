import test from 'node:test';
import assert from 'node:assert/strict';
import {
  claudeHistoryQueuePresentationIdentity,
  extractClaudeHistoryPromptCarrierText,
  hasClaudeHistoryLiveQueuePrompt,
  isClaudeHistoryPromptLocallyOwned,
  isHistoryPromptLocallyOwned,
  reduceClaudeHistoryPromptCarrier,
} from './historyClaudePromptCarriers.mjs';

const sessionId = 'session-a';
const prompt = 'SECOND PROMPT';
const timestamp = '2026-07-28T12:00:00.000Z';
const wrap = (message) => ({ sessionId, timestamp: message.timestamp || timestamp, message });
const enqueue = (text = prompt) => wrap({
  type: 'queue-operation',
  operation: 'enqueue',
  content: text,
  timestamp,
  sessionId,
});

test('queue carrier is opt-in so History-owned local prompts keep ownership', () => {
  const result = reduceClaudeHistoryPromptCarrier([], enqueue());
  assert.equal(result.handled, true);
  assert.deepEqual(result.entries, []);
});

test('enqueue creates one exact live queue identity and replay upserts it', () => {
  const first = reduceClaudeHistoryPromptCarrier([], enqueue(), { includeUserText: true });
  const replay = reduceClaudeHistoryPromptCarrier(first.entries, enqueue(), { includeUserText: true });
  assert.equal(first.entries.length, 1);
  assert.equal(replay.entries.length, 1);
  assert.equal(first.entries[0].queueStatus, 'queued');
  assert.equal(first.entries[0].sourceIdentity, claudeHistoryQueuePresentationIdentity(first.entries[0]));
  assert.equal(hasClaudeHistoryLiveQueuePrompt(first.entries), true);
  assert.equal(extractClaudeHistoryPromptCarrierText(enqueue()), prompt);
});

test('dequeue and remove consume one prompt while popAll returns and removes every queued prompt', () => {
  const first = reduceClaudeHistoryPromptCarrier([], enqueue('A'), { includeUserText: true });
  const second = reduceClaudeHistoryPromptCarrier(first.entries, wrap({
    type: 'queue-operation', operation: 'enqueue', content: 'B', timestamp: '2026-07-28T12:00:01.000Z', sessionId,
  }), { includeUserText: true });
  const removedB = reduceClaudeHistoryPromptCarrier(second.entries, wrap({
    type: 'queue-operation', operation: 'remove', content: 'B', timestamp: '2026-07-28T12:00:02.000Z', sessionId,
  }), { includeUserText: true });
  assert.deepEqual(removedB.entries.map((entry) => entry.queueStatus), ['queued', 'sent']);
  const dequeuedA = reduceClaudeHistoryPromptCarrier(removedB.entries, wrap({
    type: 'queue-operation', operation: 'dequeue', timestamp: '2026-07-28T12:00:03.000Z', sessionId,
  }), { includeUserText: true });
  assert.deepEqual(dequeuedA.entries.map((entry) => entry.queueStatus), ['sent', 'sent']);

  const allQueued = second.entries.map((entry) => ({ ...entry, queueStatus: 'queued' }));
  const popped = reduceClaudeHistoryPromptCarrier(allQueued, wrap({
    type: 'queue-operation', operation: 'popAll', timestamp: '2026-07-28T12:00:04.000Z', sessionId,
  }), { includeUserText: true });
  assert.deepEqual(popped.entries, []);
  assert.equal(hasClaudeHistoryLiveQueuePrompt(popped.entries), false);
});

test('replayed dequeue settles exactly one queued prompt and a new dequeue settles the next', () => {
  const first = reduceClaudeHistoryPromptCarrier([], enqueue('A'), { includeUserText: true });
  const second = reduceClaudeHistoryPromptCarrier(first.entries, wrap({
    type: 'queue-operation', operation: 'enqueue', content: 'B', timestamp: '2026-07-28T12:00:01.000Z', sessionId,
  }), { includeUserText: true });
  const dequeueA = {
    ...wrap({
      type: 'queue-operation', operation: 'dequeue', timestamp: '2026-07-28T12:00:02.000Z', sessionId,
    }),
    recordByteOffset: 120,
  };
  const once = reduceClaudeHistoryPromptCarrier(second.entries, dequeueA, { includeUserText: true });
  const replay = reduceClaudeHistoryPromptCarrier(once.entries, dequeueA, { includeUserText: true });
  assert.deepEqual(once.entries.map((entry) => entry.queueStatus), ['sent', 'queued']);
  assert.deepEqual(replay.entries.map((entry) => entry.queueStatus), ['sent', 'queued']);

  const next = reduceClaudeHistoryPromptCarrier(replay.entries, {
    ...wrap({
      type: 'queue-operation', operation: 'dequeue', timestamp: '2026-07-28T12:00:03.000Z', sessionId,
    }),
    recordByteOffset: 180,
  }, { includeUserText: true });
  assert.deepEqual(next.entries.map((entry) => entry.queueStatus), ['sent', 'sent']);
});

test('queued_command replaces one matching interim row with its canonical UUID', () => {
  const queued = reduceClaudeHistoryPromptCarrier([], enqueue(), { includeUserText: true });
  const canonical = reduceClaudeHistoryPromptCarrier(queued.entries, wrap({
    type: 'attachment',
    uuid: 'queued-uuid',
    timestamp,
    sessionId,
    attachment: { type: 'queued_command', prompt, timestamp },
  }), { includeUserText: true });
  assert.equal(canonical.entries.length, 1);
  assert.deepEqual(canonical.entries[0], {
    uuid: 'queued-uuid',
    role: 'user',
    timestamp,
    content: prompt,
    queueStatus: 'sent',
    sessionId,
    sourceIdentity: 'claude-queue:session-a:2026-07-28T12:00:00.000Z:4c2a7abd',
  });
});

test('queued_command uses its exact enqueue timestamp when identical prompts are pending', () => {
  const first = reduceClaudeHistoryPromptCarrier([], enqueue(), { includeUserText: true });
  const secondTimestamp = '2026-07-28T12:00:01.000Z';
  const second = reduceClaudeHistoryPromptCarrier(first.entries, wrap({
    type: 'queue-operation',
    operation: 'enqueue',
    content: prompt,
    timestamp: secondTimestamp,
    sessionId,
  }), { includeUserText: true });
  const canonical = reduceClaudeHistoryPromptCarrier(second.entries, wrap({
    type: 'attachment',
    uuid: 'second-queued-uuid',
    timestamp: secondTimestamp,
    sessionId,
    attachment: { type: 'queued_command', prompt, timestamp: secondTimestamp },
  }), { includeUserText: true });

  assert.equal(canonical.entries.length, 2);
  assert.equal(canonical.entries[0].role, 'queued');
  assert.equal(canonical.entries[0].timestamp, timestamp);
  assert.equal(canonical.entries[1].uuid, 'second-queued-uuid');
  assert.equal(canonical.entries[1].role, 'user');
});

test('canonical carrier replay cannot consume a second identical queued prompt', () => {
  const first = reduceClaudeHistoryPromptCarrier([], enqueue(), { includeUserText: true });
  const secondTimestamp = '2026-07-28T12:00:01.000Z';
  const second = reduceClaudeHistoryPromptCarrier(first.entries, wrap({
    type: 'queue-operation', operation: 'enqueue', content: prompt, timestamp: secondTimestamp, sessionId,
  }), { includeUserText: true });
  const canonicalEnvelope = wrap({
    type: 'attachment',
    uuid: 'first-queued-uuid',
    timestamp,
    sessionId,
    attachment: { type: 'queued_command', prompt, timestamp },
  });
  const once = reduceClaudeHistoryPromptCarrier(second.entries, canonicalEnvelope, { includeUserText: true });
  const replay = reduceClaudeHistoryPromptCarrier(once.entries, canonicalEnvelope, { includeUserText: true });
  assert.equal(replay.entries.length, 2);
  assert.equal(replay.entries.filter((entry) => entry.role === 'queued').length, 1);
  assert.equal(replay.entries.find((entry) => entry.role === 'queued')?.timestamp, secondTimestamp);
});

test('ordinary user carrier replaces one matching interim row', () => {
  const queued = reduceClaudeHistoryPromptCarrier([], enqueue(), { includeUserText: true });
  const canonical = reduceClaudeHistoryPromptCarrier(queued.entries, wrap({
    type: 'user',
    uuid: 'user-uuid',
    timestamp: '2026-07-28T12:00:02.000Z',
    sessionId,
    message: { role: 'user', content: prompt },
  }), { includeUserText: true });
  assert.equal(canonical.entries.length, 1);
  assert.equal(canonical.entries[0].uuid, 'user-uuid');
  assert.equal(canonical.entries[0].role, 'user');
});

test('a consumed queue row is replaced by the one canonical user turn that appends text', () => {
  const queueEnvelope = wrap({
    type: 'queue-operation',
    operation: 'enqueue',
    uuid: 'provider-queue-uuid',
    content: prompt,
    timestamp,
    sessionId,
  });
  const queued = reduceClaudeHistoryPromptCarrier([], queueEnvelope, { includeUserText: true });
  assert.equal(queued.entries[0].sourceIdentity, 'claude-queue:uuid:provider-queue-uuid');
  const consumed = reduceClaudeHistoryPromptCarrier(queued.entries, wrap({
    type: 'queue-operation',
    operation: 'dequeue',
    timestamp: '2026-07-28T12:00:01.000Z',
    sessionId,
  }), { includeUserText: true });
  const merged = reduceClaudeHistoryPromptCarrier(consumed.entries, wrap({
    type: 'user',
    uuid: 'merged-user-uuid',
    timestamp: '2026-07-28T12:00:02.000Z',
    sessionId,
    message: { role: 'user', content: prompt + '\nadditional user text' },
  }), { includeUserText: true });
  assert.equal(merged.entries.length, 1);
  assert.equal(merged.entries[0].uuid, 'merged-user-uuid');
  assert.equal(merged.entries[0].content, prompt + '\nadditional user text');
  assert.equal(merged.entries[0].sourceIdentity, 'claude-queue:uuid:provider-queue-uuid');
});

test('a later manual user turn after popAll cannot inherit returned queue identity', () => {
  const first = reduceClaudeHistoryPromptCarrier([], enqueue(), { includeUserText: true });
  const second = reduceClaudeHistoryPromptCarrier(first.entries, wrap({
    type: 'queue-operation',
    operation: 'enqueue',
    content: prompt,
    timestamp: '2026-07-28T12:00:01.000Z',
    sessionId,
  }), { includeUserText: true });
  const consumed = reduceClaudeHistoryPromptCarrier(second.entries, wrap({
    type: 'queue-operation', operation: 'popAll', timestamp: '2026-07-28T12:00:02.000Z', sessionId,
  }), { includeUserText: true });
  const ambiguous = reduceClaudeHistoryPromptCarrier(consumed.entries, wrap({
    type: 'user',
    uuid: 'ambiguous-merged-user',
    timestamp: '2026-07-28T12:00:03.000Z',
    sessionId,
    message: { role: 'user', content: prompt + '\nextra' },
  }), { includeUserText: true });
  assert.equal(ambiguous.entries.length, 1);
  assert.equal(ambiguous.entries[0].uuid, 'ambiguous-merged-user');
  assert.equal(ambiguous.entries[0].sourceIdentity, undefined);
});

test('tool results and unrelated provider records remain delegated to the live reducer', () => {
  const toolResult = reduceClaudeHistoryPromptCarrier([], wrap({
    type: 'user',
    uuid: 'tool-result',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'ok' }] },
  }), { includeUserText: true });
  assert.equal(toolResult.handled, false);
  assert.equal(reduceClaudeHistoryPromptCarrier([], wrap({ type: 'assistant' })).handled, false);
});

test('Claude prompt carriers preserve their exact JSONL byte position', () => {
  const queued = reduceClaudeHistoryPromptCarrier([], {
    ...enqueue('queued with position'),
    recordByteOffset: 321,
  }, { includeUserText: true });
  assert.equal(queued.entries[0].recordByteOffset, 321);

  const canonical = reduceClaudeHistoryPromptCarrier([], {
    ...wrap({
      type: 'user',
      uuid: 'positioned-user',
      message: { role: 'user', content: 'canonical with position' },
    }),
    recordByteOffset: 654,
  }, { includeUserText: true });
  assert.equal(canonical.entries[0].recordByteOffset, 654);
});

test('internal task notifications are never projected as user prompts', () => {
  const result = reduceClaudeHistoryPromptCarrier([], enqueue('<task-notification>hidden</task-notification>'), {
    includeUserText: true,
  });
  assert.deepEqual(result.entries, []);
});

test('identical History and native xterm text are not conflated without exact ownership proof', () => {
  const native = enqueue('SAME TEXT');
  assert.equal(isClaudeHistoryPromptLocallyOwned(native, [{
    handoffId: 'history-handoff',
    text: 'SAME TEXT',
  }]), false);
});

test('exact handoff id or audited transcript UUID proves History ownership', () => {
  const handoffs = [{
    handoffId: 'history-handoff',
    auditEntryUuid: 'history-user-uuid',
  }];
  assert.equal(isClaudeHistoryPromptLocallyOwned({
    ...enqueue('SAME TEXT'),
    promptOwner: { handoffId: 'history-handoff' },
  }, handoffs), true);
  assert.equal(isClaudeHistoryPromptLocallyOwned(wrap({
    type: 'user',
    uuid: 'history-user-uuid',
    message: { role: 'user', content: 'SAME TEXT' },
  }), handoffs), true);
  assert.equal(isHistoryPromptLocallyOwned({
    ...enqueue('SAME TEXT'),
    promptOwner: { handoffId: 'history-handoff' },
  }, handoffs), true);
});

test('exact audited source identity proves ownership when the live envelope misses promptOwner', () => {
  const sourceIdentity = 'codex-user-source-session-a-4096';
  assert.equal(isHistoryPromptLocallyOwned(wrap({
    type: 'user',
    uuid: 'codex-live-user',
    sourceIdentity,
    message: { role: 'user', content: 'SAME TEXT' },
  }), [{
    handoffId: 'history-handoff',
    sourceIdentity,
  }]), true);
  assert.equal(isHistoryPromptLocallyOwned(wrap({
    type: 'user',
    uuid: 'manual-user',
    sourceIdentity: 'codex-user-source-session-a-8192',
    message: { role: 'user', content: 'SAME TEXT' },
  }), [{
    handoffId: 'history-handoff',
    sourceIdentity,
  }]), false);
});
