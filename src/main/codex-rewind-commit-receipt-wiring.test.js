const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const mainSource = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
const databaseSource = fs.readFileSync(path.join(__dirname, 'database.js'), 'utf8');

function block(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(start, -1, 'missing start marker: ' + startMarker);
  assert.notEqual(end, -1, 'missing end marker: ' + endMarker);
  return source.slice(start, end);
}

test('writer CAS, exact commit receipt, and transient journal cleanup share one transaction', () => {
  const commit = block(
    databaseSource,
    'commitPendingCodexWriterHandoff({',
    '\n  recordPendingCodexRewindReplacementCandidate({',
  );
  const bindingCasAt = commit.indexOf("UPDATE tabs SET codex_session_id = ?");
  const receiptAt = commit.indexOf("kind: 'codex-native-rewind-commit'");
  const journalCleanupAt = commit.indexOf("DELETE FROM app_state WHERE key = ?");
  assert.ok(bindingCasAt >= 0 && receiptAt > bindingCasAt && journalCleanupAt > receiptAt);
  assert.match(commit, /receiptId:\s*crypto\.randomUUID\(\)/);
  for (const field of [
    'operationId',
    'requestId',
    'originProjectId',
    'actionGeneration',
    'sourceSessionId',
    'childSessionId',
    'sourceLifecycleGeneration',
    'sourceRunSeq',
    'targetUuid',
    'targetTextHash',
    'rollbackTurns',
  ]) {
    assert.match(commit, new RegExp('\\b' + field + '\\b'));
  }
});

test('post-grab completion consumes the durable receipt before stable-source fallback', () => {
  const handler = block(
    mainSource,
    "ipcMain.handle('codex:open-history-menu'",
    "\nipcMain.on('claude:prompt-boundary-ack'",
  );
  const receiptInspectionAt = handler.indexOf('inspectCodexNativeRewindCommitReceipt(');
  const transientReplayAt = handler.indexOf('isCommittedCodexNativeRewindReplay({');
  const stableSourceAt = handler.indexOf('markCodexWriterHandoffRollbackApplied(');
  assert.ok(receiptInspectionAt >= 0);
  assert.ok(transientReplayAt > receiptInspectionAt);
  assert.ok(stableSourceAt > receiptInspectionAt);
  assert.match(handler, /proofMode:\s*'durable-commit-receipt'/);
  assert.match(handler, /finalizeCodexNativeRewindCommitReceipt\(/);
  assert.match(handler, /commitReceiptFinalized = finalizedReceipt\?\.success === true/);
});

test('the action boundary binds renderer operation and internal request identities durably', () => {
  const handler = block(
    mainSource,
    "ipcMain.handle('codex:open-history-menu'",
    "\nipcMain.on('claude:prompt-boundary-ack'",
  );
  assert.match(handler, /operationId:\s*String\(opId \|\| rewindRequestId\)/);
  assert.match(handler, /requestId:\s*rewindRequestId/);
  assert.match(handler, /rewindCommitExpectation = \{[\s\S]{0,900}sourceLifecycleGeneration/);
});
