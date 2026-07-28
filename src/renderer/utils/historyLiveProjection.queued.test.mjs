import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildHistoryLivePresentation,
  reconcileCommittedHistoryLiveProjection,
  reduceHistoryLiveProjection,
} from './historyLiveProjection.mjs';

const sessionId = 'claude-session-q';
const prompt = 'SECOND-PROMPT-WHILE-STREAMING';
const queuedAt = '2026-07-28T10:00:00.000Z';

const envelope = (message) => ({
  tabId: 'tab-q',
  toolType: 'claude',
  sessionId,
  timestamp: message.timestamp || queuedAt,
  message,
});

const enqueue = () => envelope({
  type: 'queue-operation',
  operation: 'enqueue',
  content: prompt,
  timestamp: queuedAt,
  sessionId,
});

test('app-owned History prompt remains excluded unless caller transfers live user ownership', () => {
  assert.deepEqual(reduceHistoryLiveProjection([], enqueue()), []);
});

test('native queue enqueue is projected immediately and dequeue settles the same row', () => {
  const queued = reduceHistoryLiveProjection([], enqueue(), { includeUserText: true });
  assert.equal(queued.length, 1);
  assert.equal(queued[0].role, 'queued');
  assert.equal(queued[0].content, prompt);
  assert.equal(queued[0].queueStatus, 'queued');
  assert.match(queued[0].sourceIdentity, /^claude-queue:/);

  const settled = reduceHistoryLiveProjection(queued, envelope({
    type: 'queue-operation',
    operation: 'dequeue',
    timestamp: '2026-07-28T10:00:02.000Z',
    sessionId,
  }), { includeUserText: true });
  assert.equal(settled.length, 1);
  assert.equal(settled[0].uuid, queued[0].uuid);
  assert.equal(settled[0].queueStatus, 'sent');
});

test('queued_command replaces its matching synthetic queue row with one canonical user row', () => {
  const queued = reduceHistoryLiveProjection([], enqueue(), { includeUserText: true });
  const canonical = reduceHistoryLiveProjection(queued, envelope({
    parentUuid: 'assistant-before',
    type: 'attachment',
    uuid: 'queued-command-uuid',
    timestamp: queuedAt,
    sessionId,
    attachment: {
      type: 'queued_command',
      prompt,
      timestamp: queuedAt,
    },
  }), { includeUserText: true });
  assert.equal(canonical.length, 1);
  assert.equal(canonical[0].uuid, 'queued-command-uuid');
  assert.equal(canonical[0].role, 'user');
  assert.equal(canonical[0].content, prompt);
  assert.equal(canonical[0].queueStatus, 'sent');
});

test('ordinary queued user row also replaces the matching synthetic queue row', () => {
  const queued = reduceHistoryLiveProjection([], enqueue(), { includeUserText: true });
  const canonical = reduceHistoryLiveProjection(queued, envelope({
    parentUuid: 'assistant-before',
    type: 'user',
    uuid: 'ordinary-user-uuid',
    timestamp: '2026-07-28T10:00:02.100Z',
    sessionId,
    message: { role: 'user', content: prompt },
  }), { includeUserText: true });
  assert.equal(canonical.length, 1);
  assert.equal(canonical[0].uuid, 'ordinary-user-uuid');
  assert.equal(canonical[0].role, 'user');
  assert.equal(canonical[0].content, prompt);
});

test('canonical live user hands off to its durable row without a duplicate or blank frame', () => {
  const live = reduceHistoryLiveProjection([], envelope({
    parentUuid: 'assistant-before',
    type: 'user',
    uuid: 'ordinary-user-uuid',
    timestamp: '2026-07-28T10:00:02.100Z',
    sessionId,
    message: { role: 'user', content: prompt },
  }), { includeUserText: true });
  assert.equal(live.length, 1);
  const durable = [{
    uuid: 'ordinary-user-uuid',
    role: 'user',
    timestamp: '2026-07-28T10:00:02.100Z',
    content: prompt,
    sessionId,
  }];
  assert.deepEqual(buildHistoryLivePresentation(durable, live), durable);
  assert.deepEqual(reconcileCommittedHistoryLiveProjection(live, durable).entries, []);
});

test('durable queue-operation row replaces the same live interim row by exact queue identity', () => {
  const live = reduceHistoryLiveProjection([], enqueue(), { includeUserText: true });
  assert.equal(live.length, 1);
  const durable = [{
    uuid: 'queue-from-durable-parser',
    role: 'queued',
    timestamp: queuedAt,
    content: prompt,
    queueStatus: 'queued',
    sessionId,
  }];
  assert.deepEqual(buildHistoryLivePresentation(durable, live), durable);
  assert.deepEqual(reconcileCommittedHistoryLiveProjection(live, durable).entries, []);
});

test('current response stays before a queued next prompt, then the next response stays after that prompt', () => {
  const assistant = (uuid, text, timestamp) => envelope({
    type: 'assistant',
    uuid,
    timestamp,
    sessionId,
    message: { role: 'assistant', content: [{ type: 'text', text }] },
  });
  let projected = reduceHistoryLiveProjection([], assistant(
    'assistant-a-1',
    'A response part 1',
    '2026-07-28T09:59:59.000Z',
  ));
  projected = reduceHistoryLiveProjection(projected, enqueue(), { includeUserText: true });
  projected = reduceHistoryLiveProjection(projected, assistant(
    'assistant-a-2',
    'A response part 2',
    '2026-07-28T10:00:01.000Z',
  ));
  assert.deepEqual(projected.map((entry) => entry.content), [
    'A response part 1',
    'A response part 2',
    prompt,
  ]);

  projected = reduceHistoryLiveProjection(projected, envelope({
    type: 'attachment',
    uuid: 'queued-command-uuid',
    timestamp: queuedAt,
    sessionId,
    attachment: { type: 'queued_command', prompt, timestamp: queuedAt },
  }), { includeUserText: true });
  projected = reduceHistoryLiveProjection(projected, assistant(
    'assistant-b-1',
    'B response',
    '2026-07-28T10:00:03.000Z',
  ));
  assert.deepEqual(projected.map((entry) => entry.content), [
    'A response part 1',
    'A response part 2',
    prompt,
    'B response',
  ]);
});
