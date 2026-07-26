'use strict';

const CURSOR_VERSION = 1;

function normalizeLimit(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 25;
  return Math.max(1, Math.min(100, Math.floor(parsed)));
}

function encodeProgressCursor({ sessionId, lastOperationId }) {
  if (!sessionId || !lastOperationId) return null;
  return Buffer.from(JSON.stringify({
    v: CURSOR_VERSION,
    sessionId,
    lastOperationId,
  }), 'utf8').toString('base64url');
}

function decodeProgressCursor(cursor, sessionId) {
  if (!cursor) return null;
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(String(cursor), 'base64url').toString('utf8'));
  } catch {
    const error = new Error('Invalid session progress cursor');
    error.status = 400;
    error.statusCode = 400;
    error.code = 'invalid_progress_cursor';
    throw error;
  }
  if (
    parsed?.v !== CURSOR_VERSION
    || typeof parsed?.sessionId !== 'string'
    || typeof parsed?.lastOperationId !== 'string'
  ) {
    const error = new Error('Unsupported session progress cursor');
    error.status = 400;
    error.statusCode = 400;
    error.code = 'invalid_progress_cursor';
    throw error;
  }
  if (parsed.sessionId !== sessionId) {
    const error = new Error('Session progress cursor belongs to another session');
    error.status = 400;
    error.statusCode = 400;
    error.code = 'progress_cursor_session_mismatch';
    throw error;
  }
  return parsed;
}

function flattenSessionOperations(turns) {
  const operations = [];
  for (let turnIndex = 0; turnIndex < (turns || []).length; turnIndex++) {
    const turn = turns[turnIndex];
    for (const toolUse of turn?.toolUses || []) {
      const operationId = typeof toolUse?.operationId === 'string'
        ? toolUse.operationId
        : `${turn?.userUuid || 'turn-' + turnIndex}:tool:${toolUse?.idx ?? operations.length}`;
      operations.push({
        operationId,
        turnIndex,
        toolIndex: Number.isInteger(toolUse?.idx) ? toolUse.idx : 0,
        name: toolUse?.name || 'tool',
        detail: toolUse?.detail || null,
        timestamp: toolUse?.timestamp || turn?.userTimestamp || null,
        assistantUuid: toolUse?.assistantUuid || null,
      });
    }
  }
  return operations;
}

function buildSessionProgress({ sessionId, turns, cursor, limit }) {
  if (!sessionId) throw new Error('sessionId required');
  const operations = flattenSessionOperations(turns);
  const parsedCursor = decodeProgressCursor(cursor, sessionId);
  const pageLimit = normalizeLimit(limit);
  let startIndex = Math.max(0, operations.length - pageLimit);
  let cursorReset = false;
  let resetReason = null;

  if (parsedCursor) {
    const cursorIndex = operations.findIndex(
      (operation) => operation.operationId === parsedCursor.lastOperationId,
    );
    if (cursorIndex >= 0) {
      startIndex = cursorIndex + 1;
    } else {
      cursorReset = true;
      resetReason = 'cursor-operation-not-on-active-branch';
    }
  }

  const page = operations.slice(startIndex, startIndex + pageLimit);
  const observedOperation = page.length
    ? page[page.length - 1]
    : parsedCursor && !cursorReset
      ? { operationId: parsedCursor.lastOperationId }
      : operations[operations.length - 1];
  const nextCursor = observedOperation
    ? encodeProgressCursor({
      sessionId,
      lastOperationId: observedOperation.operationId,
    })
    : null;

  return {
    operations: page,
    operationCount: operations.length,
    returned: page.length,
    hasMore: startIndex + page.length < operations.length,
    omittedBefore: startIndex,
    initialSnapshot: !parsedCursor,
    cursorReset,
    resetReason,
    nextCursor,
  };
}

module.exports = {
  buildSessionProgress,
  decodeProgressCursor,
  encodeProgressCursor,
  flattenSessionOperations,
};
