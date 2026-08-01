'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  isExactQueuedCompact,
  promoteAllPendingCompactEntries,
  promotePendingCompactEntry,
  promoteQueuedCompactEntry,
} = require('./claude-compact-queue-projection');

const queued = (content, sessionId = 'session-a') => ({
  uuid: 'queue-' + content,
  role: 'queued',
  content,
  queueStatus: 'sent',
  sessionId,
});

test('quoted or explanatory compact text remains an ordinary queued prompt', () => {
  assert.equal(isExactQueuedCompact('/compact'), true);
  assert.equal(isExactQueuedCompact('say /compact please'), false);
  assert.equal(isExactQueuedCompact('"/compact"'), false);
  const pending = [queued('say /compact please')];
  assert.equal(promotePendingCompactEntry(pending, { reason: 'compact_boundary' }), null);
  assert.equal(pending[0].queueStatus, 'sent');
});

test('accepted exact compact becomes ordinary slash history instead of eternal SENT', () => {
  const entry = queued('/compact');
  const pending = [entry];
  const promoted = promotePendingCompactEntry(pending, { reason: 'dequeue' });
  assert.equal(promoted, entry);
  assert.equal(entry.role, 'slash');
  assert.equal(entry.content, '/compact');
  assert.equal(entry.queueStatus, undefined);
  assert.equal(entry.compactDeliverySettled, true);
  assert.equal(entry.compactDeliveryReason, 'dequeue');
  assert.deepEqual(pending, []);
});

test('a dequeue promotes only the queue item that was actually consumed', () => {
  const ordinary = queued('ordinary prompt');
  const compact = queued('/compact');
  const pending = [ordinary, compact];
  assert.equal(promoteQueuedCompactEntry(pending, ordinary, { reason: 'dequeue' }), null);
  assert.deepEqual(pending, [ordinary, compact]);
  assert.equal(promoteQueuedCompactEntry(pending, compact, { reason: 'dequeue' }), compact);
  assert.deepEqual(pending, [ordinary]);
});

test('compact boundary settles the newest exact compact owned by that session', () => {
  const old = queued('/compact', 'session-a');
  const ordinary = queued('ordinary', 'session-a');
  const current = queued('/compact', 'session-b');
  const pending = [old, ordinary, current];
  const promoted = promotePendingCompactEntry(pending, {
    direction: 'last',
    sessionId: 'session-b',
    reason: 'compact_boundary',
  });
  assert.equal(promoted, current);
  assert.equal(old.queueStatus, 'sent');
  assert.equal(ordinary.queueStatus, 'sent');
});

test('popAll settles every exact compact but leaves ordinary prompts pending', () => {
  const one = queued('/compact');
  const ordinary = queued('normal prompt');
  const two = queued('  /compact\r\n');
  const pending = [one, ordinary, two];
  assert.deepEqual(
    promoteAllPendingCompactEntries(pending, { reason: 'popAll' }),
    [one, two],
  );
  assert.deepEqual(pending, [ordinary]);
  assert.equal(one.role, 'slash');
  assert.equal(two.role, 'slash');
});
