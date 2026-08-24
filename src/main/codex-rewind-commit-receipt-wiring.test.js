const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const mainSource = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
const databaseSource = fs.readFileSync(path.join(__dirname, 'database.js'), 'utf8');
const manualRewindSource = fs.readFileSync(
  path.join(__dirname, 'codex-manual-rewind.js'),
  'utf8',
);

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

test('a second Rewind retains the settled writer only as a non-selectable incumbent', () => {
  const contextBuilder = block(
    mainSource,
    'function buildCodexSettledRewindProofContext(',
    '\nasync function buildCodexDelayedStableSourceProofContext(',
  );
  assert.match(contextBuilder, /includeIncumbentAfterBoundary = false/);
  assert.match(contextBuilder, /incumbentOnly:\s*!settledSelectionAllowed/);
  assert.match(contextBuilder, /String\(proof\.sessionId \|\| ''\) !== String\(intent\.sourceSessionId\)/);

  const inspection = block(
    mainSource,
    'async function inspectCodexWriterProcessProofInner(',
    '\nasync function inspectCodexWriterProcessProof(',
  );
  assert.match(inspection, /includeIncumbentAfterBoundary:\s*true/);
  assert.match(inspection, /proof\.status === 'incumbent-overlap-pending'/);
  assert.match(inspection, /preserveWriterProof:\s*true/);
});

test('the first Rewind freezes an exact read-only source before invalidating observations', () => {
  const boundary = block(
    mainSource,
    'function markCodexWriterHandoffActionBoundary(',
    '\nfunction markCodexWriterHandoffRollbackApplied(',
  );
  const freezeAt = boundary.indexOf('observer.handoffSourceIncumbent = Object.freeze({');
  const invalidateAt = boundary.indexOf("invalidateCodexWriterObservations(tabId, 'native-rewind-action-boundary')");
  assert.ok(freezeAt >= 0 && invalidateAt > freezeAt);
  for (const field of [
    'sourceFilePath',
    'expectedBindingSessionId',
    'terminalToken',
    'sourceLifecycleGeneration',
    'runSeq',
    'actionAuthorityId',
    'operationId',
    'requestId',
  ]) {
    assert.match(boundary, new RegExp('\\b' + field + '\\b'));
  }

  const inspection = block(
    mainSource,
    'async function inspectCodexWriterProcessProofInner(',
    '\nasync function inspectCodexWriterProcessProof(',
  );
  assert.match(inspection, /buildCodexNativeRewindSourceIncumbentContext\(/);
  assert.match(inspection, /sourceIncumbent,/);
});

test('generic writer adoption keeps exact live PTY scope without relabelling an existing proof', () => {
  const reconcile = block(
    mainSource,
    'async function reconcileCodexWriterFromProcessInner(',
    '\nasync function reconcileCodexWriterFromProcess(',
  );
  assert.match(reconcile, /preserveGenericProofGeneration/);
  assert.match(reconcile, /previousProof\.actionGeneration/);
  assert.match(reconcile, /terminalToken:\s*terminalAtAdoption/);
  assert.match(reconcile, /lifecycleGeneration:\s*lifecycleGenerationAtAdoption/);
  assert.match(reconcile, /runSeq:\s*runSeqAtAdoption/);

  const publish = block(
    mainSource,
    'function setCodexKnownSession(',
    '\nfunction getCodexWriterProofSnapshot(',
  );
  assert.match(publish, /runSeq:\s*normalizeCodexPositiveRunSeq\(proof\?\.runSeq\)/);
  assert.match(publish, /lifecycleGeneration:\s*proof\?\.lifecycleGeneration \|\| null/);
});

test('manual native Rewind proves the restored current composer before settling a lazy writer', () => {
  const handler = block(
    mainSource,
    'async function handleManualCodexRewindConfirmationEnter(',
    '\nfunction markCodexWriterHandoffActionBoundary(',
  );
  const waitAt = handler.indexOf('createManualCodexRewindRestoredComposerWait(');
  const enterAt = handler.indexOf('term.write(data)', waitAt);
  const reconcileAt = handler.indexOf('reconcileManualCodexRewindAfterEnter(', enterAt);
  assert.ok(waitAt >= 0 && enterAt > waitAt && reconcileAt > enterAt);
  assert.match(handler, /expectedTextHash:\s*boundary\.targetTextHash/);
  assert.match(handler, /actionWriteSeq:\s*Number\(snapshot\.writeSeq\)/);
  assert.match(handler, /mirrorGeneration:\s*snapshot\.mirrorGeneration/);
  assert.doesNotMatch(handler, /'manual-native-rewind-enter',[\s\S]{0,80}waitForBranchMs/,
    'manual Enter must not immediately classify an unmaterialized zero-prefix child as missing');

  const postFrame = block(
    mainSource,
    'async function reconcileManualCodexRewindAfterEnter(',
    '\nasync function handleManualCodexRewindConfirmationEnter(',
  );
  const rejectionAt = postFrame.indexOf('classifyManualCodexRewindProviderRejection(');
  const branchDraftAt = postFrame.indexOf('classifyManualCodexRewindProviderBranchDraft(');
  const branchPersistAt = postFrame.indexOf('markCodexWriterHandoffBranchDraftRestored(');
  const firstSettlementAt = postFrame.indexOf('settleCodexWriterHandoffObservation(');
  const stableOutcomeAt = postFrame.indexOf('inspectManualCodexStableSourceRollbackOutcome(');
  const appliedAt = postFrame.indexOf('markCodexWriterHandoffRollbackApplied(');
  const secondSettlementAt = postFrame.indexOf(
    'settleCodexWriterHandoffObservation(',
    firstSettlementAt + 1,
  );
  assert.ok(rejectionAt >= 0 && firstSettlementAt > rejectionAt);
  assert.ok(branchDraftAt > rejectionAt && branchPersistAt > branchDraftAt
    && firstSettlementAt > branchPersistAt);
  assert.ok(stableOutcomeAt > firstSettlementAt && appliedAt > stableOutcomeAt);
  assert.ok(secondSettlementAt > appliedAt,
    'stable source may settle only after a durable thread_rolled_back proof');
  assert.match(postFrame, /restoredTextHash:\s*restored\.restoredTextHash/);
  assert.match(postFrame, /manual-rewind-provider-branch-rejected/);
  assert.match(postFrame, /captureManualCodexRewindRestoredCopy\(/);
  assert.match(postFrame, /inspectCodexNativeRewindCommitReceipt\(/);
  assert.match(postFrame, /finalizeCodexNativeRewindCommitReceipt\(/);

  const exactCopy = block(
    mainSource,
    'async function captureManualCodexRewindRestoredCopy(',
    '\nasync function reconcileManualCodexRewindAfterEnter(',
  );
  assert.match(exactCopy, /getTerminalInputRevision\(tabId\)[\s\S]{0,80}expectedInputRevision/);
  assert.match(
    exactCopy,
    /captureAgentInputAtWriteBoundary\([\s\S]{0,100}'copy'[\s\S]{0,100}'codex'/,
  );
  assert.doesNotMatch(exactCopy, /'grab'/, 'manual verification must not clear the restored draft');
});

test('headless Rewind proof preserves the same-frame rows immediately above viewport', () => {
  const snapshot = block(
    mainSource,
    'function getHeadlessVisibleBufferSnapshot(',
    '\nfunction commitHeadlessVisibleBufferSnapshot(',
  );
  assert.match(snapshot, /const preViewportLines = \[\];[\s\S]{0,160}startLine - 2/);
  assert.match(snapshot, /preViewportLines,[\s\S]{0,120}lines,/);
  assert.match(
    manualRewindSource,
    /snapshot\?\.preViewportLines[\s\S]{0,180}snapshot\?\.lines/,
  );
  assert.match(snapshot, /const cursorRow = buf\.baseY \+ buf\.cursorY/);
  assert.match(snapshot, /extractCodexDraftFromLine\(cursorLogical\)/);
  assert.match(snapshot, /codexCursorComposer,/);
  assert.match(snapshot, /readManualCodexRewindSelectedText\([\s\S]{0,120}codexActivePrompt\.row/);
  assert.match(manualRewindSource, /snapshot\?\.codexCursorComposer/);
  assert.doesNotMatch(
    block(
      manualRewindSource,
      'function readManualCodexComposerText(',
      '\n/**',
    ),
    /hasInverse/,
  );
});

test('every nullable Rewind action boundary uses one explicit predicate', () => {
  assert.match(mainSource, /hasCodexWriterHandoffActionBoundary,/);
  for (const snippet of [
    'hasCodexWriterHandoffActionBoundary(intent?.handoffActionStartedAtMs)',
    'hasCodexWriterHandoffActionBoundary(intentOverride?.handoffActionStartedAtMs)',
    'hasCodexWriterHandoffActionBoundary(observer.handoffActionStartedAtMs)',
    'hasCodexWriterHandoffActionBoundary(\n            observerState.handoffActionStartedAtMs',
  ]) {
    assert.ok(mainSource.includes(snippet), 'missing shared boundary predicate at: ' + snippet);
  }
  assert.doesNotMatch(
    mainSource,
    /Number\.isFinite\(Number\([^\n]*handoffActionStartedAtMs/,
    'null must never coerce to a post-Enter boundary',
  );
});

test('the next physical Enter durably arms the existing delayed-writer audit before PTY write', () => {
  const prepare = block(
    mainSource,
    'function prepareManualCodexStableSourceSubmit(',
    '\nfunction markManualCodexStableSourceSubmitWritten(',
  );
  assert.match(prepare, /isCodexRewindDraftSubmitPhase\(journal\.phase\)/);
  assert.match(mainSource, /journal\.phase === 'branch-draft-restored'/);
  assert.match(mainSource, /branchDraftRestoredAtMs/);
  assert.match(prepare, /composerState\.hasDraft !== true/);
  assert.ok(prepare.indexOf('enqueueCodexPasteAudit(')
    < prepare.indexOf('armPendingCodexNativeRewindStableSourceSubmit('));
  assert.match(prepare, /armCodexDelayedWriterObserver\(tabId, armed\)/);

  const terminalInput = block(
    mainSource,
    'if (isManualCodexSubmit) {',
    '\n  // Last-line defense for direct renderer/manual resume paths.',
  );
  const normalPrepareAt = terminalInput.lastIndexOf('prepareManualCodexStableSourceSubmit(');
  const normalWrittenAt = terminalInput.lastIndexOf('markManualCodexStableSourceSubmitWritten(');
  const normalEnterAt = terminalInput.indexOf('term.write(data)', normalWrittenAt);
  assert.ok(normalPrepareAt >= 0 && normalWrittenAt > normalPrepareAt && normalEnterAt > normalWrittenAt);
  assert.match(terminalInput, /physical Enter continues without attribution proof/,
    'an attribution failure must not swallow the user physical key');
});

test('a provisional delayed child gets an exact event-driven file watcher and immediate race-closing scan', () => {
  const close = block(
    mainSource,
    'function closeCodexDelayedWriterObserver(',
    '\nfunction syncCodexDelayedWriterCandidateWatchers(',
  );
  assert.match(close, /state\.candidateWatchers\?\.values/);
  assert.match(close, /candidateWatcher\.watcher\?\.close/);

  const sync = block(
    mainSource,
    'function syncCodexDelayedWriterCandidateWatchers(',
    '\nfunction armCodexDelayedWriterObserver(',
  );
  assert.match(sync, /selectCodexDelayedWriterWatchTargets\(/);
  assert.match(sync, /fs\.watch\(target\.filePath/);
  assert.match(sync, /state\.observe\('candidate-write:/);
  assert.match(sync, /if \(added > 0\) state\.observe\('candidate-watch-attached'\)/);
  assert.doesNotMatch(sync, /setInterval|setTimeout|watchFile/);

  const observer = block(
    mainSource,
    'function armCodexDelayedWriterObserver(',
    '\nfunction codexOutcomeTimestampMs(',
  );
  assert.match(observer, /candidateWatchers:\s*new Map\(\)/);
  assert.match(observer, /state\.observe = observe/);
  assert.match(observer, /syncCodexDelayedWriterCandidateWatchers\(tabId, result\)/);

  const reconcile = block(
    mainSource,
    'async function reconcileCodexWriterFromProcessInner(',
    '\nasync function reconcileCodexWriterFromProcess(',
  );
  assert.match(
    reconcile,
    /if \(owned\.status !== 'owned'\) \{\s*syncCodexDelayedWriterCandidateWatchers\(tabId, owned\)/,
  );
});
