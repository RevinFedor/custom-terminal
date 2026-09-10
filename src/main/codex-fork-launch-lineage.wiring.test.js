'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');

test('codex-f reads the composite source and atomically commits a proven child with Fork intent', () => {
  const runStart = source.indexOf('async function runCodexCommandFromPayloadInner');
  const runEnd = source.indexOf("ipcMain.on('codex:run-command'", runStart);
  const runBlock = source.slice(runStart, runEnd);
  assert.match(runBlock, /normalizedCommand === 'codex-f'/);
  assert.match(runBlock, /normalizedCommand === 'codex-f'[\s\S]*ensureCodexProviderForkLineage\(\{/);
  const forkPreparation = runBlock.slice(runBlock.indexOf("if (loaded?.success && normalizedCommand === 'codex-f')"));
  assert.doesNotMatch(forkPreparation.slice(0, forkPreparation.indexOf('} catch (error)')), /loadCodexOperationSource\(/,
    'native Fork must not build and discard a full History projection before snapshot capture');
  assert.match(runBlock, /captureCodexForkSourceSnapshot\(\{/);
  assert.match(runBlock, /sessionId,[\s\S]*cwd: termCwd,[\s\S]*loaded,/);
  assert.match(runBlock, /forkSourceHistorySnapshot,/);
  assert.match(runBlock, /rebaseCodexLaunchObservationAtWrite\(tabId, launchId, startedAt\);[\s\S]*writeAgentLaunchCommandToIdleShell/);

  const reconcileStart = source.indexOf('async function reconcileCodexWriterFromProcessInner');
  const reconcileEnd = source.indexOf('async function reconcileCodexWriterFromProcess(', reconcileStart);
  const reconcileBlock = source.slice(reconcileStart, reconcileEnd);
  const prepareAt = reconcileBlock.indexOf('prepareCodexNativeForkLineageFromSnapshot({');
  const bindingAt = reconcileBlock.indexOf('const durableBinding =', prepareAt);
  assert.notEqual(prepareAt, -1);
  assert.notEqual(bindingAt, -1);
  assert.ok(prepareAt < bindingAt, 'the child history must be readable before its writer is published');
  assert.match(reconcileBlock, /lineageEvent: explicitForkLineageEvent/);
  assert.doesNotMatch(reconcileBlock, /projectManager\.db\.saveSessionForkEvent\(forkEvent\)/);
  assert.match(reconcileBlock, /transcriptService\.notifyCodexLineageCommitted\(forkLineageCommittedSessionId\)/);
});

test('native Rewind prefers its durable pre-Enter snapshot and preserves provider recovery for legacy journals', () => {
  const reconcileStart = source.indexOf('async function reconcileCodexWriterFromProcessInner');
  const reconcileEnd = source.indexOf('async function reconcileCodexWriterFromProcess(', reconcileStart);
  const reconcileBlock = source.slice(reconcileStart, reconcileEnd);
  const snapshotPrepareAt = reconcileBlock.indexOf('prepareCodexRewindLineageFromSnapshot({');
  const legacyPrepareAt = reconcileBlock.indexOf('prepareCodexProviderForkLineage({');
  const prepareAt = Math.min(snapshotPrepareAt, legacyPrepareAt);
  const commitAt = reconcileBlock.indexOf('commitPendingCodexNativeRewindHandoff(tabId, {', prepareAt);
  assert.notEqual(snapshotPrepareAt, -1);
  assert.notEqual(legacyPrepareAt, -1);
  assert.ok(snapshotPrepareAt < legacyPrepareAt, 'new journals use their frozen source before provider metadata fallback');
  assert.notEqual(commitAt, -1);
  assert.ok(prepareAt < commitAt, 'lineage proof must exist before the writer binding transaction');
  assert.match(reconcileBlock, /status: 'lineage-pending'/);
  assert.match(reconcileBlock, /lineageEvent: nativeRewindLineageEvent/);

  const commitStart = source.indexOf('function commitPendingCodexNativeRewindHandoff');
  const commitEnd = source.indexOf('function inspectCodexNativeRewindCommitReceipt', commitStart);
  const commitBlock = source.slice(commitStart, commitEnd);
  assert.match(commitBlock, /lineageEvent = null/);
  assert.match(commitBlock, /projectManager\.db\.commitPendingCodexWriterHandoff\([\s\S]*lineageEvent/);

  const recoveryStart = source.indexOf('async function recoverPendingCodexNativeRewindHandoffs');
  const recoveryEnd = source.indexOf('\nfunction codexSessionsDir', recoveryStart);
  const recovery = source.slice(recoveryStart, recoveryEnd);
  assert.match(recovery, /lineageEvent: targetProof\.lineageEvent \|\| null/);
  assert.match(recovery, /notifyCodexLineageCommitted\(descendant\.sessionId\)/);
});

test('both native Rewind callers freeze exact source identity before their durable journal and Enter', () => {
  const programmaticStart = source.indexOf("ipcMain.handle('codex:open-history-menu'");
  const programmaticEnd = source.indexOf("ipcMain.handle('codex:cancel-rewind'", programmaticStart);
  const programmatic = source.slice(programmaticStart, programmaticEnd);
  const programmaticSnapshotAt = programmatic.indexOf('captureCodexRewindSourceSnapshot({');
  const programmaticJournalAt = programmatic.indexOf('markCodexWriterHandoffActionBoundary(', programmaticSnapshotAt);
  const programmaticEnterAt = programmatic.indexOf("sendCodexKeyAndCapture(\n        term,\n        '\\r'", programmaticJournalAt);
  assert.notEqual(programmaticSnapshotAt, -1);
  assert.notEqual(programmaticJournalAt, -1);
  assert.notEqual(programmaticEnterAt, -1);
  assert.ok(programmaticSnapshotAt < programmaticJournalAt && programmaticJournalAt < programmaticEnterAt);
  assert.match(programmatic, /viewSessionId: handoffObserver\.sourceSessionId/);
  assert.match(programmatic, /physicalSessionId: targetPayloadContext\.sessionId/);
  assert.match(programmatic, /targetPhysicalSessionId: targetPayloadContext\.sessionId/);
  assert.match(programmatic, /rewindSourceSnapshot,/);

  const manualStart = source.indexOf('async function handleManualCodexRewindConfirmationEnter');
  const manualEnd = source.indexOf('\nfunction markCodexWriterHandoffActionBoundary', manualStart);
  const manual = source.slice(manualStart, manualEnd);
  const manualSnapshotAt = manual.indexOf('captureCodexRewindSourceSnapshot({');
  const manualJournalAt = manual.indexOf('markCodexWriterHandoffActionBoundary(', manualSnapshotAt);
  const manualEnterAt = manual.indexOf('term.write(data)', manualJournalAt);
  assert.notEqual(manualSnapshotAt, -1);
  assert.notEqual(manualJournalAt, -1);
  assert.notEqual(manualEnterAt, -1);
  assert.ok(manualSnapshotAt < manualJournalAt && manualJournalAt < manualEnterAt);
  assert.match(manual, /physicalSessionId: boundary\.targetPhysicalSessionId/);
  assert.match(manual, /manual_rewind_target_changed_during_snapshot/);

  const projectionStart = source.indexOf('function prepareManualCodexRewindObserver');
  const projectionEnd = source.indexOf('\nfunction armCodexWriterHandoffObservation', projectionStart);
  const projection = source.slice(projectionStart, projectionEnd);
  assert.match(projection, /transcriptService\.loadCodexOperationSource\(\{/);
  assert.doesNotMatch(projection, /codexDataModule\._api\.loadSessionRecords/);

  const messageProjectionStart = source.indexOf('function projectCodexVisibleUserMessagesForRewindProof');
  const messageProjectionEnd = source.indexOf('\nfunction projectCodexSourceTranscriptForRewindRecovery', messageProjectionStart);
  const messageProjection = source.slice(messageProjectionStart, messageProjectionEnd);
  assert.match(messageProjection, /recordsByPhysicalSession/);
  assert.match(messageProjection, /branchabilityByPhysicalSession/);
  assert.match(messageProjection, /uuid: 'codex-user-' \+ \(physicalSessionId/);
  assert.match(messageProjection, /physicalSessionId,/);
});

test('read-only runtime projection does not replace destructive fresh proof', () => {
  const snapshotStart = source.indexOf('async function getCodexRuntimeSessionSnapshot');
  const snapshotEnd = source.indexOf('\nfunction getCodexSessionOwner', snapshotStart);
  const snapshotBlock = source.slice(snapshotStart, snapshotEnd);
  assert.match(snapshotBlock, /forceWriterReconcile = false/);
  assert.match(snapshotBlock, /projectCodexWriterInspectionFromProof\(/);
  assert.match(snapshotBlock, /resolveCodexWriterInspection\([\s\S]*reconcileCodexWriterFromProcess/);
  assert.match(source, /reason: 'archive-close',[\s\S]{0,180}forceWriterReconcile: true/);
  assert.match(source, /reason: 'codex-binding-point-write:' \+ reason,[\s\S]{0,180}forceWriterReconcile: true/);
});
