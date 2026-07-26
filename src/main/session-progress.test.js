const assert = require('node:assert/strict');
const test = require('node:test');
const {
  buildSessionProgress,
  decodeProgressCursor,
} = require('./session-progress');

const makeTurn = (userUuid, names) => ({
  kind: 'user',
  userUuid,
  userTimestamp: '2026-07-26T00:00:00.000Z',
  toolUses: names.map((name, idx) => ({
    idx,
    name,
    operationId: `${userUuid}:tool:${idx}`,
    assistantUuid: `${userUuid}:assistant`,
  })),
});

test('first progress read returns a bounded tail and an opaque cursor', () => {
  const result = buildSessionProgress({
    sessionId: 'session-1',
    turns: [makeTurn('turn-1', ['Read', 'Edit', 'Bash'])],
    limit: 2,
  });

  assert.deepEqual(result.operations.map((operation) => operation.name), ['Edit', 'Bash']);
  assert.equal(result.initialSnapshot, true);
  assert.equal(result.operationCount, 3);
  assert.equal(result.hasMore, false);
  assert.equal(result.omittedBefore, 1);
  assert.equal(decodeProgressCursor(result.nextCursor, 'session-1').lastOperationId, 'turn-1:tool:2');
});

test('next progress read returns only operations after the cursor', () => {
  const first = buildSessionProgress({
    sessionId: 'session-1',
    turns: [makeTurn('turn-1', ['Read'])],
  });
  const second = buildSessionProgress({
    sessionId: 'session-1',
    turns: [
      makeTurn('turn-1', ['Read']),
      makeTurn('turn-2', ['Edit', 'Bash']),
    ],
    cursor: first.nextCursor,
  });

  assert.deepEqual(second.operations.map((operation) => operation.name), ['Edit', 'Bash']);
  assert.equal(second.initialSnapshot, false);
  assert.equal(second.cursorReset, false);
});

test('branch replacement resets a cursor instead of silently missing progress', () => {
  const first = buildSessionProgress({
    sessionId: 'session-1',
    turns: [makeTurn('old-turn', ['Read'])],
  });
  const second = buildSessionProgress({
    sessionId: 'session-1',
    turns: [makeTurn('new-turn', ['Edit'])],
    cursor: first.nextCursor,
  });

  assert.equal(second.cursorReset, true);
  assert.equal(second.resetReason, 'cursor-operation-not-on-active-branch');
  assert.deepEqual(second.operations.map((operation) => operation.name), ['Edit']);
});

test('cursor cannot be reused for another session', () => {
  const first = buildSessionProgress({
    sessionId: 'session-1',
    turns: [makeTurn('turn-1', ['Read'])],
  });

  assert.throws(
    () => buildSessionProgress({
      sessionId: 'session-2',
      turns: [makeTurn('turn-2', ['Read'])],
      cursor: first.nextCursor,
    }),
    (error) => /another session/.test(error?.message) && error?.statusCode === 400,
  );
});
